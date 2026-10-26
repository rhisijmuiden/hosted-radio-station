import { and, asc, eq, inArray } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { schema } from '../db/index.js';
import { requireSuperadmin, requireTenantRole, requireUser } from '../lib/auth.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { getMaskedSetting, getSetting, putSetting, statisticsSchema } from '../services/settings.js';
import { readGeoipMeta, updateGeoip } from '../services/stats/geoip.js';
import * as reports from '../services/stats/reports.js';
import { stationStats } from '../services/streaming/state.js';

const validTz = (tz: string) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

const scopeQuery = z.object({
  stationId: z.uuid().optional(),
  tenantId: z.uuid().optional(),
});
const periodQuery = scopeQuery.extend({
  from: z.coerce.date(),
  to: z.coerce.date(),
  /** IANA time zone for days and hours, e.g. Europe/Amsterdam. */
  tz: z.string().max(64).refine(validTz, 'Unknown time zone').default('UTC'),
  /** A mount path (/live) or "output:<id>" for an external server. */
  mount: z.string().max(100).optional(),
});

const kpisOut = z.object({
  listeningHours: z.number(),
  avgListeners: z.number(),
  peakListeners: z.number(),
  peakAt: z.string().nullable(),
  sessions: z.number(),
  uniqueListeners: z.number(),
  avgSessionSeconds: z.number(),
  countries: z.number(),
});
const breakdownOut = z.array(z.object({ key: z.string(), sessions: z.number(), listeners: z.number(), hours: z.number() }));
const placeOut = z.object({ country: z.string().nullable(), city: z.string().nullable(), lat: z.number(), lon: z.number(), sessions: z.number(), listeners: z.number(), hours: z.number() });
const reportOut = z.object({
  from: z.string(),
  to: z.string(),
  kpis: kpisOut,
  previous: kpisOut,
  timeseries: z.object({ bucket: z.string(), points: z.array(z.object({ t: z.string(), avg: z.number(), peak: z.number() })) }),
  countries: breakdownOut,
  regions: breakdownOut,
  cities: breakdownOut,
  devices: breakdownOut,
  players: breakdownOut,
  os: breakdownOut,
  mounts: breakdownOut,
  referrers: breakdownOut,
  networks: breakdownOut,
  durations: z.array(z.object({ fromSeconds: z.number(), toSeconds: z.number().nullable(), sessions: z.number() })),
  heatmap: z.array(z.object({ weekday: z.number(), hour: z.number(), avg: z.number() })),
  places: z.array(placeOut),
});
const sessionOut = z.object({
  id: z.string(),
  stationId: z.string(),
  stationName: z.string(),
  mount: z.string(),
  via: z.string(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  durationSeconds: z.number(),
  ip: z.string().nullable(),
  country: z.string().nullable(),
  region: z.string().nullable(),
  city: z.string().nullable(),
  network: z.string().nullable(),
  device: z.string().nullable(),
  player: z.string().nullable(),
  os: z.string().nullable(),
  referrer: z.string().nullable(),
  userAgent: z.string().nullable(),
});
const geoipOut = z.object({
  provider: z.enum(['dbip', 'maxmind']),
  release: z.string(),
  downloadedAt: z.string(),
  cityBuiltAt: z.string().nullable(),
  hasAsn: z.boolean(),
});

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v);
  return `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replaceAll('"', '""')}"`;
};

/** Listener statistics. Administrators see every station; customer owners and managers see their own stations. */
export const statsRoutes: FastifyPluginAsyncZod = async (app) => {
  const { ctx } = app;

  /** The stations a request may report on, narrowed to one station or customer when asked. */
  async function resolveStations(req: FastifyRequest, q: z.infer<typeof scopeQuery>) {
    const auth = requireUser(req);
    if (q.stationId) {
      const [st] = await ctx.db.select({ id: schema.stations.id, tenantId: schema.stations.tenantId }).from(schema.stations).where(eq(schema.stations.id, q.stationId));
      if (!st) throw notFound('Station');
      await requireTenantRole(ctx, req, st.tenantId, 'manager');
      return [st.id];
    }
    if (q.tenantId) {
      await requireTenantRole(ctx, req, q.tenantId, 'manager');
      return (await ctx.db.select({ id: schema.stations.id }).from(schema.stations).where(eq(schema.stations.tenantId, q.tenantId))).map((r) => r.id);
    }
    if (auth.user.isSuperadmin && !auth.keyTenantId) return (await ctx.db.select({ id: schema.stations.id }).from(schema.stations)).map((r) => r.id);
    const own = await ctx.db
      .select({ tenantId: schema.memberships.tenantId })
      .from(schema.memberships)
      .where(and(eq(schema.memberships.userId, auth.user.id), inArray(schema.memberships.role, ['owner', 'manager'])));
    const tenantIds = own.map((r) => r.tenantId).filter((id) => !auth.keyTenantId || id === auth.keyTenantId);
    if (!tenantIds.length) throw forbidden();
    return (await ctx.db.select({ id: schema.stations.id }).from(schema.stations).where(inArray(schema.stations.tenantId, tenantIds))).map((r) => r.id);
  }

  async function period(req: FastifyRequest, q: z.infer<typeof periodQuery>): Promise<reports.Scope> {
    if (q.to <= q.from) throw badRequest('The end of the period must be after its start');
    if (q.to.getTime() - q.from.getTime() > 3 * 366 * 86400_000) throw badRequest('Choose a period of at most three years');
    return { stationIds: await resolveStations(req, q), from: q.from, to: q.to, tz: q.tz, mount: q.mount || undefined };
  }

  app.get(
    '/stations',
    {
      schema: {
        tags: ['Statistics'],
        summary: 'Stations you can see statistics for, with their mounts and external servers',
        response: {
          200: z.array(
            z.object({
              id: z.string(),
              name: z.string(),
              tenantId: z.string(),
              tenantName: z.string(),
              mounts: z.array(z.string()),
              outputs: z.array(z.object({ id: z.string(), name: z.string() })),
            }),
          ),
        },
      },
    },
    async (req) => {
      let ids: string[];
      try {
        ids = await resolveStations(req, {});
      } catch (err) {
        if ((err as { statusCode?: number }).statusCode === 403) return [];
        throw err;
      }
      if (!ids.length) return [];
      const [rows, mounts, outputs] = await Promise.all([
        ctx.db
          .select({ id: schema.stations.id, name: schema.stations.name, tenantId: schema.tenants.id, tenantName: schema.tenants.name })
          .from(schema.stations)
          .innerJoin(schema.tenants, eq(schema.tenants.id, schema.stations.tenantId))
          .where(inArray(schema.stations.id, ids))
          .orderBy(asc(schema.tenants.name), asc(schema.stations.name)),
        ctx.db.select({ stationId: schema.stationMounts.stationId, path: schema.stationMounts.path }).from(schema.stationMounts).where(inArray(schema.stationMounts.stationId, ids)).orderBy(asc(schema.stationMounts.sortOrder), asc(schema.stationMounts.path)),
        ctx.db.select({ stationId: schema.stationOutputs.stationId, id: schema.stationOutputs.id, name: schema.stationOutputs.name, type: schema.stationOutputs.type }).from(schema.stationOutputs).where(inArray(schema.stationOutputs.stationId, ids)),
      ]);
      return rows.map((r) => ({
        ...r,
        mounts: mounts.filter((m) => m.stationId === r.id).map((m) => m.path),
        outputs: outputs.filter((o) => o.stationId === r.id && o.type !== 'local').map((o) => ({ id: o.id, name: o.name })),
      }));
    },
  );

  app.get(
    '/live',
    {
      schema: {
        tags: ['Statistics'],
        summary: 'Listeners right now: per station, countries, devices, the map and the last hour',
        querystring: scopeQuery,
        response: {
          200: z.object({
            total: z.number(),
            stations: z.array(z.object({ id: z.string(), name: z.string(), listeners: z.number(), onAir: z.boolean() })),
            countries: z.array(z.object({ key: z.string(), listeners: z.number() })),
            devices: z.array(z.object({ key: z.string(), listeners: z.number() })),
            trend: z.array(z.object({ t: z.string(), listeners: z.number() })),
            places: z.array(placeOut),
            recent: z.array(sessionOut),
          }),
        },
      },
    },
    async (req) => {
      const ids = await resolveStations(req, req.query);
      const stations = ids.length ? await ctx.db.select().from(schema.stations).where(inArray(schema.stations.id, ids)).orderBy(asc(schema.stations.name)) : [];
      const outputs = ids.length ? await ctx.db.select().from(schema.stationOutputs).where(inArray(schema.stationOutputs.stationId, ids)) : [];
      const counts = await Promise.all(
        stations.map(async (s) => {
          const stats = s.enabled ? await stationStats(ctx, s) : null;
          const local = (stats ?? []).reduce((n, m) => n + m.listeners, 0);
          const external = outputs.filter((o) => o.stationId === s.id && o.type !== 'local' && o.enabled).reduce((n, o) => n + (o.status?.listeners ?? 0), 0);
          return { id: s.id, name: s.name, listeners: local + external, onAir: !!stats?.length };
        }),
      );
      const now = new Date();
      const scope: reports.Scope = { stationIds: ids, from: new Date(now.getTime() - 1000), to: now, tz: 'UTC' };
      const [audience, places, recent] = await Promise.all([
        reports.liveAudience(ctx, ids),
        reports.places(ctx, scope, { openOnly: true }),
        reports.sessions(ctx, scope, { limit: 15, openOnly: true }),
      ]);
      return { total: counts.reduce((n, c) => n + c.listeners, 0), stations: counts, ...audience, places, recent };
    },
  );

  app.get(
    '/report',
    { schema: { tags: ['Statistics'], summary: 'Report for a period: totals, listeners over time, locations, players, listening time', querystring: periodQuery, response: { 200: reportOut } } },
    async (req) => {
      const s = await period(req, req.query);
      const span = s.to.getTime() - s.from.getTime();
      const prev: reports.Scope = { ...s, from: new Date(s.from.getTime() - span), to: s.from };
      const [kpis, previous, timeseries, countries, regions, cities, devices, players, os, mounts, referrers, networks, durations, heatmap, places] = await Promise.all([
        reports.kpis(ctx, s),
        reports.kpis(ctx, prev),
        reports.timeseries(ctx, s),
        reports.breakdown(ctx, s, 'country'),
        reports.breakdown(ctx, s, 'region'),
        reports.breakdown(ctx, s, 'city'),
        reports.breakdown(ctx, s, 'device'),
        reports.breakdown(ctx, s, 'player'),
        reports.breakdown(ctx, s, 'os'),
        reports.breakdown(ctx, s, 'mount'),
        reports.breakdown(ctx, s, 'referrer'),
        reports.breakdown(ctx, s, 'network'),
        reports.durations(ctx, s),
        reports.heatmap(ctx, s),
        reports.places(ctx, s),
      ]);
      return { from: s.from.toISOString(), to: s.to.toISOString(), kpis, previous, timeseries, countries, regions, cities, devices, players, os, mounts, referrers, networks, durations, heatmap, places };
    },
  );

  app.get(
    '/programme',
    {
      schema: {
        tags: ['Statistics'],
        summary: 'Songs and live broadcasts in a period, with the listeners while they were on air',
        querystring: periodQuery,
        response: {
          200: z.object({
            songs: z.array(z.object({ title: z.string(), plays: z.number(), avgListeners: z.number(), avgPeak: z.number(), avgChange: z.number(), lastPlayed: z.string() })),
            plays: z.array(
              z.object({
                id: z.number(),
                stationId: z.string(),
                stationName: z.string(),
                mount: z.string(),
                title: z.string(),
                startedAt: z.string(),
                endedAt: z.string().nullable(),
                listenersStart: z.number(),
                listenersPeak: z.number(),
                listenersEnd: z.number().nullable(),
              }),
            ),
            broadcasts: z.array(
              z.object({
                id: z.string(),
                stationId: z.string(),
                stationName: z.string(),
                accountName: z.string(),
                mount: z.string(),
                startedAt: z.string(),
                endedAt: z.string().nullable(),
                avgListeners: z.number(),
                peakListeners: z.number(),
              }),
            ),
          }),
        },
      },
    },
    async (req) => {
      const s = await period(req, req.query);
      const [songs, plays, broadcasts] = await Promise.all([reports.topSongs(ctx, s), reports.recentPlays(ctx, s), reports.broadcasts(ctx, s)]);
      return { songs, plays, broadcasts };
    },
  );

  app.get(
    '/sessions',
    {
      schema: {
        tags: ['Statistics'],
        summary: 'Listener sessions in a period, newest first',
        querystring: periodQuery.extend({
          limit: z.coerce.number().int().min(1).max(500).default(100),
          before: z.coerce.date().optional(),
          open: z.enum(['true', 'false']).optional(),
          country: z.string().length(2).toUpperCase().optional(),
        }),
        response: { 200: z.array(sessionOut) },
      },
    },
    async (req) => {
      const s = await period(req, req.query);
      return reports.sessions(ctx, s, { limit: req.query.limit, before: req.query.before, openOnly: req.query.open === 'true', country: req.query.country });
    },
  );

  const exportKinds = z.enum(['sessions', 'timeseries', 'countries', 'regions', 'cities', 'devices', 'players', 'os', 'mounts', 'referrers', 'networks', 'songs', 'broadcasts']);
  app.get(
    '/export.csv',
    { schema: { tags: ['Statistics'], summary: 'Download a part of the report as CSV (sessions: at most 100,000 rows)', querystring: periodQuery.extend({ kind: exportKinds }) } },
    async (req, reply) => {
      const s = await period(req, req.query);
      const kind = req.query.kind;
      let lines: unknown[][];
      if (kind === 'sessions') {
        const list = await reports.sessions(ctx, s, { limit: 100_000 });
        lines = [
          ['started', 'ended', 'seconds', 'station', 'mount', 'via', 'ip', 'country', 'region', 'city', 'network', 'device', 'player', 'os', 'referrer', 'user_agent'],
          ...list.map((r) => [r.startedAt, r.endedAt, r.durationSeconds, r.stationName, r.mount, r.via, r.ip, r.country, r.region, r.city, r.network, r.device, r.player, r.os, r.referrer, r.userAgent]),
        ];
      } else if (kind === 'timeseries') {
        const ts = await reports.timeseries(ctx, s);
        lines = [['time', 'avg_listeners', 'peak_listeners'], ...ts.points.map((p) => [p.t, p.avg, p.peak])];
      } else if (kind === 'songs') {
        lines = [['title', 'plays', 'avg_listeners', 'avg_peak', 'avg_change', 'last_played'], ...(await reports.topSongs(ctx, s, 5000)).map((r) => [r.title, r.plays, r.avgListeners, r.avgPeak, r.avgChange, r.lastPlayed])];
      } else if (kind === 'broadcasts') {
        lines = [
          ['started', 'ended', 'station', 'dj', 'mount', 'avg_listeners', 'peak_listeners'],
          ...(await reports.broadcasts(ctx, s, 5000)).map((r) => [r.startedAt, r.endedAt, r.stationName, r.accountName, r.mount, r.avgListeners, r.peakListeners]),
        ];
      } else {
        const dim = ({ countries: 'country', regions: 'region', cities: 'city', devices: 'device', players: 'player', os: 'os', mounts: 'mount', referrers: 'referrer', networks: 'network' } as const)[kind];
        lines = [[dim, 'sessions', 'unique_listeners', 'listening_hours'], ...(await reports.breakdown(ctx, s, dim, 5000)).map((r) => [r.key, r.sessions, r.listeners, r.hours])];
      }
      const name = `listeners-${kind}-${s.from.toISOString().slice(0, 10)}-${s.to.toISOString().slice(0, 10)}.csv`;
      return reply
        .type('text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="${name}"`)
        .send(`﻿${lines.map((l) => l.map(csvCell).join(',')).join('\r\n')}\r\n`);
    },
  );

  // Settings (administrators)

  app.get('/settings', { schema: { tags: ['Statistics'], summary: 'Privacy, retention and GeoIP settings', response: { 200: statisticsSchema } } }, async (req) => {
    requireSuperadmin(req);
    return getMaskedSetting(ctx, 'statistics');
  });

  app.put(
    '/settings',
    { config: { audit: 'settings.statistics' }, schema: { tags: ['Statistics'], summary: 'Save the statistics settings', body: statisticsSchema, response: { 200: statisticsSchema } } },
    async (req) => {
      requireSuperadmin(req);
      const before = await getSetting(ctx, 'statistics');
      await putSetting(ctx, 'statistics', req.body);
      // Another provider: fetch its database right away.
      if (before.geoip.provider !== req.body.geoip.provider) void updateGeoip(ctx).catch((err) => req.log.warn({ err }, 'GeoIP download failed'));
      return getMaskedSetting(ctx, 'statistics');
    },
  );

  app.get('/geoip', { schema: { tags: ['Statistics'], summary: 'The installed GeoIP database', response: { 200: z.object({ database: geoipOut.nullable() }) } } }, async (req) => {
    requireSuperadmin(req);
    return { database: await readGeoipMeta(ctx) };
  });

  app.post(
    '/geoip/update',
    { config: { audit: 'statistics.geoip_update' }, schema: { tags: ['Statistics'], summary: 'Download the GeoIP database now', response: { 200: z.object({ database: geoipOut }) } } },
    async (req) => {
      requireSuperadmin(req);
      try {
        return { database: await updateGeoip(ctx) };
      } catch (err) {
        throw badRequest(`Downloading the GeoIP database failed: ${(err as Error).message}`);
      }
    },
  );
};
