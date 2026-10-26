import { rm } from 'node:fs/promises';
import { and, asc, count, desc, eq, inArray, isNull, lt, ne, sum } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { schema } from '../db/index.js';
import type { OutputConfig } from '../db/schema.js';
import { hashPassword, requireTenantRole, requireUser, type Role } from '../lib/auth.js';
import type { AppContext } from '../lib/context.js';
import { badRequest, conflict, forbidden, isUniqueViolation, notFound } from '../lib/errors.js';
import { okOut, slugSchema } from '../lib/schemas.js';
import { getSetting, SECRET_MASK } from '../services/settings.js';
import { killSource, stationDir } from '../services/streaming/icecast.js';
import { connectionInfo } from '../services/streaming/info.js';
import { allocatePort, applyStreams, loadStation, newInternalPassword, stationStats, type Mount, type Output, type Station } from '../services/streaming/state.js';

const stationParams = z.object({ id: z.uuid() });
const mountParams = z.object({ id: z.uuid(), mountId: z.uuid() });
const outputParams = z.object({ id: z.uuid(), outputId: z.uuid() });
const accountParams = z.object({ id: z.uuid(), accountId: z.uuid() });

const editionSchema = z.enum(['distribution', 'station']);
const formatSchema = z.enum(['mp3', 'aac', 'opus', 'vorbis']);
const mountPathSchema = z
  .string()
  .trim()
  .regex(/^\/[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/, 'Use a slash followed by letters, digits, dots, dashes or underscores, e.g. /live');
const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9_-]{1,32}$/, 'Use lowercase letters, digits, dashes and underscores');
const hostSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$|^\d{1,3}(\.\d{1,3}){3}$/, 'Invalid host name');
const urlOrEmpty = z.string().trim().max(300).refine((v) => v === '' || /^https?:\/\/\S+$/.test(v), 'Use a full address starting with http:// or https://');

const stationOut = z.object({
  id: z.uuid(),
  tenantId: z.uuid(),
  tenantName: z.string(),
  name: z.string(),
  slug: z.string(),
  edition: editionSchema,
  description: z.string(),
  genre: z.string(),
  website: z.string(),
  enabled: z.boolean(),
  maxListeners: z.number().int(),
  legacyPort: z.number().int().nullable(),
  legacyMountId: z.uuid().nullable(),
  storageBytes: z.number(),
  createdAt: z.date(),
});
const liveOut = z.object({
  id: z.uuid(),
  mountId: z.uuid().nullable(),
  mountPath: z.string(),
  accountId: z.uuid().nullable(),
  accountName: z.string(),
  via: z.string(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  bitrateKbps: z.number().int().nullable(),
  startedAt: z.date(),
  endedAt: z.date().nullable(),
  bytesIn: z.number(),
  endReason: z.string().nullable(),
});
const stationListOut = stationOut.extend({
  onAir: z.boolean(),
  listeners: z.number().int().nullable(),
  mountCount: z.number().int(),
});
const mountOut = z.object({
  id: z.uuid(),
  path: z.string(),
  name: z.string(),
  kind: z.enum(['source', 'transcode']),
  sourceMountId: z.uuid().nullable(),
  format: formatSchema,
  bitrateKbps: z.number().int(),
  isPublic: z.boolean(),
  isDefault: z.boolean(),
  fallbackMountId: z.uuid().nullable(),
  maxListeners: z.number().int().nullable(),
  sortOrder: z.number().int(),
});
const outputConfigSchema = z.object({
  host: hostSchema.optional(),
  port: z.number().int().min(1).max(65535).optional(),
  tls: z.boolean().optional(),
  mount: mountPathSchema.optional(),
  username: z.string().trim().max(100).optional(),
  password: z.string().max(200).optional(),
  streamId: z.number().int().min(1).max(999).optional(),
  adminPassword: z.string().max(200).optional(),
  push: z.boolean().optional(),
  publicUrl: urlOrEmpty.optional(),
});
const outputOut = z.object({
  id: z.uuid(),
  type: z.enum(['local', 'icecast', 'shoutcast1', 'shoutcast2']),
  name: z.string(),
  enabled: z.boolean(),
  mountId: z.uuid().nullable(),
  config: outputConfigSchema,
  status: z
    .object({
      state: z.enum(['idle', 'connecting', 'connected', 'error']),
      message: z.string().optional(),
      listeners: z.number().nullable().optional(),
      since: z.string().optional(),
      checkedAt: z.string().optional(),
    })
    .nullable(),
});
const accountOut = z.object({
  id: z.uuid(),
  username: z.string(),
  displayName: z.string(),
  userId: z.uuid().nullable(),
  userName: z.string().nullable(),
  canBroadcast: z.boolean(),
  canUpload: z.boolean(),
  mountIds: z.array(z.uuid()),
  enabled: z.boolean(),
  lastUsedAt: z.date().nullable(),
  createdAt: z.date(),
  /** "<station>.<username>", the log-in for SFTP and FTP. */
  uploadLogin: z.string(),
});
const connectionOut = z.object({
  ingestHost: z.string(),
  tls: z.object({ port: z.number(), available: z.boolean() }),
  plain: z.object({ port: z.number() }).nullable(),
  legacy: z.object({ port: z.number(), sourcePort: z.number(), mount: z.string().nullable() }).nullable(),
  listenBase: z.string(),
  mounts: z.array(z.object({ id: z.uuid(), path: z.string(), encoderMount: z.string(), listenUrl: z.string().nullable() })),
  upload: z.object({
    host: z.string(),
    sftpPort: z.number().nullable(),
    ftpPort: z.number().nullable(),
    ftpRequireTls: z.boolean(),
  }),
});
const stationDetailOut = stationOut.extend({
  tenantPlan: z.enum(['distribution', 'station']),
  mounts: z.array(mountOut),
  outputs: z.array(outputOut),
  connection: connectionOut,
  /** Your role for this station's customer. */
  role: z.enum(['superadmin', 'owner', 'manager', 'dj']),
});
const statusOut = z.object({
  running: z.boolean(),
  mounts: z.array(
    z.object({
      id: z.uuid().nullable(),
      path: z.string(),
      live: z.boolean(),
      listeners: z.number().int(),
      title: z.string().nullable(),
      bitrateKbps: z.number().int().nullable(),
      contentType: z.string().nullable(),
      streamStart: z.string().nullable(),
    }),
  ),
  listeners: z.number().int(),
  live: z.array(liveOut),
  outputs: z.array(outputOut.pick({ id: true, name: true, type: true, enabled: true, status: true })),
});

const toStationOut = (s: Station, tenantName: string): z.infer<typeof stationOut> => ({
  id: s.id,
  tenantId: s.tenantId,
  tenantName,
  name: s.name,
  slug: s.slug,
  edition: s.edition,
  description: s.description,
  genre: s.genre,
  website: s.website,
  enabled: s.enabled,
  maxListeners: s.maxListeners,
  legacyPort: s.legacyPort,
  legacyMountId: s.legacyMountId,
  storageBytes: s.storageBytes,
  createdAt: s.createdAt,
});
const toMountOut = (m: Mount): z.infer<typeof mountOut> => ({
  id: m.id,
  path: m.path,
  name: m.name,
  kind: m.kind,
  sourceMountId: m.sourceMountId,
  format: m.format,
  bitrateKbps: m.bitrateKbps,
  isPublic: m.isPublic,
  isDefault: m.isDefault,
  fallbackMountId: m.fallbackMountId,
  maxListeners: m.maxListeners,
  sortOrder: m.sortOrder,
});
function toOutputOut(o: Output): z.infer<typeof outputOut> {
  const config = { ...o.config };
  if (config.password) config.password = SECRET_MASK;
  if (config.adminPassword) config.adminPassword = SECRET_MASK;
  return { id: o.id, type: o.type, name: o.name, enabled: o.enabled, mountId: o.mountId, config, status: o.status ?? null };
}

/** Loads the station and checks the caller's role in its customer. */
export async function stationAccess(ctx: AppContext, req: FastifyRequest, stationId: string, minRole: Role) {
  const [row] = await ctx.db
    .select({ station: schema.stations, tenant: schema.tenants })
    .from(schema.stations)
    .innerJoin(schema.tenants, eq(schema.tenants.id, schema.stations.tenantId))
    .where(eq(schema.stations.id, stationId));
  if (!row) throw notFound('Station');
  const access = await requireTenantRole(ctx, req, row.tenant.id, minRole);
  req.auditInfo.tenantId = row.tenant.id;
  return { ...row, access };
}

/** Customers share their listener limit over their stations. */
async function checkListenerBudget(ctx: AppContext, tenant: typeof schema.tenants.$inferSelect, wanted: number, exceptStationId?: string) {
  const [row] = await ctx.db
    .select({ n: sum(schema.stations.maxListeners) })
    .from(schema.stations)
    .where(and(eq(schema.stations.tenantId, tenant.id), exceptStationId ? ne(schema.stations.id, exceptStationId) : undefined));
  const used = Number(row?.n ?? 0);
  if (used + wanted > tenant.limits.maxListeners) {
    throw badRequest(
      `The customer may have ${tenant.limits.maxListeners} listeners in total; ${used} are already given to other stations, so at most ${Math.max(0, tenant.limits.maxListeners - used)} are left`,
    );
  }
}

function checkBitrate(tenant: typeof schema.tenants.$inferSelect, kbps: number) {
  if (kbps > tenant.limits.maxBitrateKbps) throw badRequest(`The highest bitrate for this customer is ${tenant.limits.maxBitrateKbps} kbps`);
}

export const stationRoutes: FastifyPluginAsyncZod = async (app) => {
  const { ctx } = app;
  const apply = (req: FastifyRequest, stationId?: string) =>
    applyStreams(ctx, { stationIds: stationId ? [stationId] : [], by: req.auth?.user.email }).catch((err) => req.log.error({ err }, 'applying stream configuration failed'));

  async function detail(stationId: string, role: z.infer<typeof stationDetailOut>['role']) {
    const loaded = (await loadStation(ctx, stationId))!;
    const [tenant] = await ctx.db.select().from(schema.tenants).where(eq(schema.tenants.id, loaded.station.tenantId));
    const streaming = await getSetting(ctx, 'streaming');
    const local = loaded.outputs.some((o) => o.type === 'local' && o.enabled);
    const conn = await connectionInfo(ctx, loaded.station, loaded.mounts, local);
    return {
      ...toStationOut(loaded.station, tenant!.name),
      tenantPlan: tenant!.plan,
      mounts: loaded.mounts.map(toMountOut),
      outputs: loaded.outputs.map(toOutputOut),
      connection: {
        ...conn,
        upload: {
          host: conn.ingestHost,
          sftpPort: streaming.sftp.enabled ? streaming.sftp.port : null,
          ftpPort: streaming.ftp.enabled ? streaming.ftp.port : null,
          ftpRequireTls: streaming.ftp.requireTls,
        },
      },
      role,
    };
  }

  // Stations

  app.get(
    '/',
    {
      schema: {
        tags: ['Stations'],
        summary: 'List stations, optionally of one customer. Administrators see all; others see the stations of their customers.',
        querystring: z.object({ tenantId: z.uuid().optional() }),
        response: { 200: z.array(stationListOut) },
      },
    },
    async (req) => {
      const auth = requireUser(req);
      let tenantIds: string[] | null = null;
      if (!auth.user.isSuperadmin || auth.keyTenantId) {
        const own = await ctx.db.select({ id: schema.memberships.tenantId }).from(schema.memberships).where(eq(schema.memberships.userId, auth.user.id));
        tenantIds = own.map((r) => r.id).filter((id) => !auth.keyTenantId || id === auth.keyTenantId);
        if (!tenantIds.length) return [];
      }
      if (req.query.tenantId) {
        if (tenantIds && !tenantIds.includes(req.query.tenantId)) throw forbidden();
        tenantIds = [req.query.tenantId];
      }
      const rows = await ctx.db
        .select({ station: schema.stations, tenantName: schema.tenants.name })
        .from(schema.stations)
        .innerJoin(schema.tenants, eq(schema.tenants.id, schema.stations.tenantId))
        .where(tenantIds ? inArray(schema.stations.tenantId, tenantIds) : undefined)
        .orderBy(asc(schema.tenants.name), asc(schema.stations.name));
      const ids = rows.map((r) => r.station.id);
      const [mountCounts, onAir] = ids.length
        ? await Promise.all([
            ctx.db.select({ id: schema.stationMounts.stationId, n: count() }).from(schema.stationMounts).where(inArray(schema.stationMounts.stationId, ids)).groupBy(schema.stationMounts.stationId),
            ctx.db
              .select({ id: schema.liveSessions.stationId })
              .from(schema.liveSessions)
              .where(and(inArray(schema.liveSessions.stationId, ids), isNull(schema.liveSessions.endedAt))),
          ])
        : [[], []];
      const mc = new Map(mountCounts.map((r) => [r.id, r.n]));
      const live = new Set(onAir.map((r) => r.id));
      const stats = await Promise.all(rows.map((r) => (r.station.enabled ? stationStats(ctx, r.station) : Promise.resolve(null))));
      return rows.map((r, i) => ({
        ...toStationOut(r.station, r.tenantName),
        onAir: live.has(r.station.id) || !!stats[i]?.length,
        listeners: stats[i] ? stats[i]!.reduce((n, m) => n + m.listeners, 0) : null,
        mountCount: mc.get(r.station.id) ?? 0,
      }));
    },
  );

  app.post(
    '/',
    {
      config: { audit: 'station.create' },
      schema: {
        tags: ['Stations'],
        summary: 'Create a station with a /live mount and listening on this server. Owners and administrators.',
        body: z.object({
          tenantId: z.uuid(),
          name: z.string().trim().min(1).max(120),
          slug: slugSchema,
          edition: editionSchema.default('distribution'),
          maxListeners: z.number().int().min(1).max(1_000_000).optional(),
          description: z.string().trim().max(1000).default(''),
          genre: z.string().trim().max(100).default(''),
          website: urlOrEmpty.default(''),
          bitrateKbps: z.number().int().min(16).max(512).optional(),
        }),
        response: { 201: stationDetailOut },
      },
    },
    async (req, reply) => {
      const access = await requireTenantRole(ctx, req, req.body.tenantId, 'owner');
      const [tenant] = await ctx.db.select().from(schema.tenants).where(eq(schema.tenants.id, req.body.tenantId));
      if (!tenant) throw notFound('Customer');
      if (req.body.edition === 'station' && tenant.plan !== 'station') throw badRequest('The customer has the Distribution plan; upgrade the customer first');
      const [{ n }] = (await ctx.db.select({ n: count() }).from(schema.stations).where(eq(schema.stations.tenantId, tenant.id))) as [{ n: number }];
      if (n >= tenant.limits.maxStations) throw badRequest(`This customer may have ${tenant.limits.maxStations} station(s)`);
      const [{ used }] = (await ctx.db.select({ used: sum(schema.stations.maxListeners) }).from(schema.stations).where(eq(schema.stations.tenantId, tenant.id))) as [{ used: string | null }];
      const maxListeners = req.body.maxListeners ?? Math.max(1, tenant.limits.maxListeners - Number(used ?? 0));
      await checkListenerBudget(ctx, tenant, maxListeners);
      const bitrate = Math.min(req.body.bitrateKbps ?? 192, tenant.limits.maxBitrateKbps);
      checkBitrate(tenant, bitrate);
      const streaming = await getSetting(ctx, 'streaming');
      let station: Station;
      try {
        station = await ctx.db.transaction(async (tx) => {
          const port = await allocatePort(ctx, 'icecastPort', streaming.icecastPortFrom, streaming.icecastPortTo);
          const [s] = await tx
            .insert(schema.stations)
            .values({
              tenantId: tenant.id,
              name: req.body.name,
              slug: req.body.slug,
              edition: req.body.edition,
              description: req.body.description,
              genre: req.body.genre,
              website: req.body.website,
              maxListeners,
              icecastPort: port,
              icecastAdminPassword: ctx.box.encrypt(newInternalPassword()),
              icecastSourcePassword: ctx.box.encrypt(newInternalPassword()),
            })
            .returning();
          const [mount] = await tx
            .insert(schema.stationMounts)
            .values({ stationId: s!.id, path: '/live', name: 'Live', kind: 'source', format: 'mp3', bitrateKbps: bitrate, isDefault: true })
            .returning();
          await tx.insert(schema.stationOutputs).values({ stationId: s!.id, type: 'local', name: 'This server' });
          const [updated] = await tx.update(schema.stations).set({ legacyMountId: mount!.id }).where(eq(schema.stations.id, s!.id)).returning();
          return updated!;
        });
      } catch (err) {
        if (isUniqueViolation(err)) throw conflict('A station with this short name already exists');
        throw err;
      }
      Object.assign(req.auditInfo, { tenantId: tenant.id, targetId: station.id, details: { name: station.name, slug: station.slug } });
      await apply(req, station.id);
      reply.status(201);
      return detail(station.id, access.role);
    },
  );

  app.get(
    '/:id',
    { schema: { tags: ['Stations'], summary: 'Get a station with its mounts, outputs and connection details', params: stationParams, response: { 200: stationDetailOut } } },
    async (req) => {
      const { access } = await stationAccess(ctx, req, req.params.id, 'dj');
      return detail(req.params.id, access.role);
    },
  );

  app.patch(
    '/:id',
    {
      config: { audit: 'station.update' },
      schema: {
        tags: ['Stations'],
        summary: 'Update a station. Managers change the details; owners also the short name, edition and legacy port.',
        params: stationParams,
        body: z.object({
          name: z.string().trim().min(1).max(120).optional(),
          slug: slugSchema.optional(),
          edition: editionSchema.optional(),
          description: z.string().trim().max(1000).optional(),
          genre: z.string().trim().max(100).optional(),
          website: urlOrEmpty.optional(),
          enabled: z.boolean().optional(),
          maxListeners: z.number().int().min(1).max(1_000_000).optional(),
          /** Turn the port for legacy Shoutcast v1 encoders on or off. */
          legacy: z.object({ enabled: z.boolean(), mountId: z.uuid().nullish() }).optional(),
        }),
        response: { 200: stationDetailOut },
      },
    },
    async (req) => {
      const { station, tenant, access } = await stationAccess(ctx, req, req.params.id, 'manager');
      const { legacy, ...body } = req.body;
      const ownerOnly = body.slug !== undefined || body.edition !== undefined || legacy !== undefined;
      if (ownerOnly && access.role === 'manager') throw forbidden('Only the customer owner can change these fields');
      if (body.edition === 'station' && station.edition !== 'station' && tenant.plan !== 'station') {
        throw badRequest('The Radio station edition needs the Radio station plan for this customer');
      }
      if (body.maxListeners !== undefined) await checkListenerBudget(ctx, tenant, body.maxListeners, station.id);
      const set: Partial<typeof schema.stations.$inferInsert> = { ...body, updatedAt: new Date() };
      if (legacy) {
        if (legacy.enabled && !station.legacyPort) {
          const s = await getSetting(ctx, 'streaming');
          set.legacyPort = await allocatePort(ctx, 'legacyPort', s.legacyPortFrom, s.legacyPortTo, 2);
        } else if (!legacy.enabled) set.legacyPort = null;
        if (legacy.mountId) {
          const [m] = await ctx.db.select().from(schema.stationMounts).where(and(eq(schema.stationMounts.id, legacy.mountId), eq(schema.stationMounts.stationId, station.id)));
          if (!m || m.kind !== 'source') throw badRequest('Choose a source mount of this station');
          set.legacyMountId = m.id;
        }
      }
      try {
        await ctx.db.update(schema.stations).set(set).where(eq(schema.stations.id, station.id));
      } catch (err) {
        if (isUniqueViolation(err)) throw conflict('A station with this short name already exists');
        throw err;
      }
      req.auditInfo.details = { changed: Object.keys(req.body).filter((k) => req.body[k as keyof typeof req.body] !== undefined) };
      if (body.edition && body.edition !== station.edition) req.auditInfo.details.edition = { from: station.edition, to: body.edition };
      await apply(req, station.id);
      return detail(station.id, access.role);
    },
  );

  app.delete(
    '/:id',
    { config: { audit: 'station.delete' }, schema: { tags: ['Stations'], summary: 'Delete a station and its media files (owners)', params: stationParams, response: { 200: okOut } } },
    async (req) => {
      const { station } = await stationAccess(ctx, req, req.params.id, 'owner');
      await ctx.db.delete(schema.stations).where(eq(schema.stations.id, station.id));
      req.auditInfo.details = { name: station.name, slug: station.slug };
      await apply(req);
      // The system helper stops the Icecast server; its files can go right away.
      await rm(stationDir(ctx, station.id), { recursive: true, force: true }).catch((err) => req.log.warn({ err }, 'removing station files failed'));
      return { ok: true as const };
    },
  );

  app.get(
    '/:id/status',
    { schema: { tags: ['Stations'], summary: 'Live status: mounts on air, listeners, now playing, encoders and outputs', params: stationParams, response: { 200: statusOut } } },
    async (req) => {
      const { station } = await stationAccess(ctx, req, req.params.id, 'dj');
      const [mounts, outputs, live, stats] = await Promise.all([
        ctx.db.select().from(schema.stationMounts).where(eq(schema.stationMounts.stationId, station.id)).orderBy(asc(schema.stationMounts.sortOrder), asc(schema.stationMounts.createdAt)),
        ctx.db.select().from(schema.stationOutputs).where(eq(schema.stationOutputs.stationId, station.id)).orderBy(asc(schema.stationOutputs.createdAt)),
        ctx.db.select().from(schema.liveSessions).where(and(eq(schema.liveSessions.stationId, station.id), isNull(schema.liveSessions.endedAt))).orderBy(desc(schema.liveSessions.startedAt)),
        stationStats(ctx, station),
      ]);
      const byPath = new Map((stats ?? []).map((s) => [s.mount, s]));
      // Mounts Icecast knows but that are not configured (e.g. an old relay) are listed too.
      const known = new Set(mounts.map((m) => m.path));
      const rows = [
        ...mounts.map((m) => ({ id: m.id, path: m.path, s: byPath.get(m.path) })),
        ...(stats ?? []).filter((s) => !known.has(s.mount)).map((s) => ({ id: null, path: s.mount, s })),
      ];
      return {
        running: stats !== null,
        mounts: rows.map((r) => ({
          id: r.id,
          path: r.path,
          live: !!r.s,
          listeners: r.s?.listeners ?? 0,
          title: r.s?.title ?? null,
          bitrateKbps: r.s?.bitrateKbps ?? null,
          contentType: r.s?.contentType ?? null,
          streamStart: r.s?.streamStart ?? null,
        })),
        listeners: (stats ?? []).reduce((n, s) => n + s.listeners, 0),
        live,
        outputs: outputs.map((o) => ({ id: o.id, name: o.name, type: o.type, enabled: o.enabled, status: o.status ?? null })),
      };
    },
  );

  app.get(
    '/:id/live',
    {
      schema: {
        tags: ['Stations'],
        summary: 'Live broadcasts: who was on air, when and for how long (newest first)',
        params: stationParams,
        querystring: z.object({ before: z.coerce.date().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }),
        response: { 200: z.object({ items: z.array(liveOut), nextBefore: z.date().nullable() }) },
      },
    },
    async (req) => {
      const { station } = await stationAccess(ctx, req, req.params.id, 'dj');
      const items = await ctx.db
        .select()
        .from(schema.liveSessions)
        .where(and(eq(schema.liveSessions.stationId, station.id), req.query.before ? lt(schema.liveSessions.startedAt, req.query.before) : undefined))
        .orderBy(desc(schema.liveSessions.startedAt))
        .limit(req.query.limit);
      return { items, nextBefore: items.length === req.query.limit ? items.at(-1)!.startedAt : null };
    },
  );

  app.post(
    '/:id/mounts/:mountId/disconnect',
    {
      config: { audit: 'station.disconnect' },
      schema: { tags: ['Stations'], summary: 'Disconnect the encoder that is live on a mount', params: mountParams, response: { 200: okOut } },
    },
    async (req) => {
      const { station } = await stationAccess(ctx, req, req.params.id, 'manager');
      const [mount] = await ctx.db.select().from(schema.stationMounts).where(and(eq(schema.stationMounts.id, req.params.mountId), eq(schema.stationMounts.stationId, station.id)));
      if (!mount) throw notFound('Mount');
      await ctx.db
        .update(schema.liveSessions)
        .set({ endReason: 'kicked' })
        .where(and(eq(schema.liveSessions.stationId, station.id), eq(schema.liveSessions.mountPath, mount.path), isNull(schema.liveSessions.endedAt)));
      try {
        await killSource({ port: station.icecastPort, adminPassword: ctx.box.decrypt(station.icecastAdminPassword) }, mount.path);
      } catch (err) {
        throw badRequest(`Nothing to disconnect: ${(err as Error).message}`);
      }
      Object.assign(req.auditInfo, { targetType: 'mount', targetId: mount.id, details: { mount: mount.path } });
      return { ok: true as const };
    },
  );

  // Mount points

  const mountBody = z.object({
    path: mountPathSchema,
    name: z.string().trim().max(80).default(''),
    kind: z.enum(['source', 'transcode']).default('source'),
    sourceMountId: z.uuid().nullish(),
    format: formatSchema.default('mp3'),
    bitrateKbps: z.number().int().min(16).max(512).default(128),
    isPublic: z.boolean().default(true),
    isDefault: z.boolean().default(false),
    fallbackMountId: z.uuid().nullish(),
    maxListeners: z.number().int().min(1).max(1_000_000).nullish(),
    sortOrder: z.number().int().min(0).max(1000).default(0),
  });

  async function validateMount(station: Station, tenant: typeof schema.tenants.$inferSelect, m: z.infer<typeof mountBody>, selfId?: string) {
    const mounts = await ctx.db.select().from(schema.stationMounts).where(eq(schema.stationMounts.stationId, station.id));
    const byId = new Map(mounts.map((x) => [x.id, x]));
    checkBitrate(tenant, m.bitrateKbps);
    if (m.kind === 'transcode') {
      const src = m.sourceMountId ? byId.get(m.sourceMountId) : undefined;
      if (!src || src.id === selfId || src.kind !== 'source') throw badRequest('A converted mount needs a source mount of this station');
    }
    if (m.kind === 'source' && selfId && mounts.some((x) => x.sourceMountId === selfId && x.kind === 'transcode') && byId.get(selfId)?.kind !== m.kind) {
      throw badRequest('Other mounts are converted from this mount');
    }
    if (m.fallbackMountId) {
      // Follow the chain to make sure it does not loop back.
      let cur = byId.get(m.fallbackMountId);
      if (!cur) throw badRequest('The fallback mount must belong to this station');
      for (let i = 0; cur && i < 20; i++) {
        if (cur.id === selfId) throw badRequest('These fallback mounts would form a loop');
        cur = cur.fallbackMountId ? byId.get(cur.fallbackMountId) : undefined;
      }
    }
    if (m.maxListeners && m.maxListeners > station.maxListeners) throw badRequest(`The station may have ${station.maxListeners} listeners`);
  }

  async function saveDefault(stationId: string, mountId: string, isDefault: boolean) {
    if (isDefault) {
      await ctx.db.update(schema.stationMounts).set({ isDefault: false }).where(and(eq(schema.stationMounts.stationId, stationId), ne(schema.stationMounts.id, mountId)));
    }
  }

  app.post(
    '/:id/mounts',
    {
      config: { audit: 'mount.create' },
      schema: { tags: ['Stations'], summary: 'Add a mount point (source or converted)', params: stationParams, body: mountBody, response: { 201: mountOut } },
    },
    async (req, reply) => {
      const { station, tenant } = await stationAccess(ctx, req, req.params.id, 'manager');
      await validateMount(station, tenant, req.body);
      try {
        const [m] = await ctx.db
          .insert(schema.stationMounts)
          .values({ ...req.body, stationId: station.id, sourceMountId: req.body.kind === 'transcode' ? req.body.sourceMountId : null, fallbackMountId: req.body.fallbackMountId ?? null, maxListeners: req.body.maxListeners ?? null })
          .returning();
        await saveDefault(station.id, m!.id, m!.isDefault);
        Object.assign(req.auditInfo, { targetType: 'mount', targetId: m!.id, details: { mount: m!.path, kind: m!.kind } });
        await apply(req, station.id);
        reply.status(201);
        return toMountOut(m!);
      } catch (err) {
        if (isUniqueViolation(err)) throw conflict('This station already has a mount with this path');
        throw err;
      }
    },
  );

  app.put(
    '/:id/mounts/:mountId',
    {
      config: { audit: 'mount.update' },
      schema: { tags: ['Stations'], summary: 'Change a mount point', params: mountParams, body: mountBody, response: { 200: mountOut } },
    },
    async (req) => {
      const { station, tenant } = await stationAccess(ctx, req, req.params.id, 'manager');
      const [current] = await ctx.db.select().from(schema.stationMounts).where(and(eq(schema.stationMounts.id, req.params.mountId), eq(schema.stationMounts.stationId, station.id)));
      if (!current) throw notFound('Mount');
      await validateMount(station, tenant, req.body, current.id);
      try {
        const [m] = await ctx.db
          .update(schema.stationMounts)
          .set({ ...req.body, sourceMountId: req.body.kind === 'transcode' ? req.body.sourceMountId : null, fallbackMountId: req.body.fallbackMountId ?? null, maxListeners: req.body.maxListeners ?? null })
          .where(eq(schema.stationMounts.id, current.id))
          .returning();
        await saveDefault(station.id, m!.id, m!.isDefault);
        Object.assign(req.auditInfo, { targetType: 'mount', details: { mount: m!.path } });
        await apply(req, station.id);
        return toMountOut(m!);
      } catch (err) {
        if (isUniqueViolation(err)) throw conflict('This station already has a mount with this path');
        throw err;
      }
    },
  );

  app.delete(
    '/:id/mounts/:mountId',
    { config: { audit: 'mount.delete' }, schema: { tags: ['Stations'], summary: 'Remove a mount point', params: mountParams, response: { 200: okOut } } },
    async (req) => {
      const { station } = await stationAccess(ctx, req, req.params.id, 'manager');
      const mounts = await ctx.db.select().from(schema.stationMounts).where(eq(schema.stationMounts.stationId, station.id));
      const mount = mounts.find((m) => m.id === req.params.mountId);
      if (!mount) throw notFound('Mount');
      if (mounts.some((m) => m.sourceMountId === mount.id)) throw conflict('Other mounts are converted from this mount; remove those first');
      const outputs = await ctx.db.select().from(schema.stationOutputs).where(eq(schema.stationOutputs.mountId, mount.id));
      if (outputs.length) throw conflict(`The output "${outputs[0]!.name}" sends this mount; change it first`);
      await ctx.db.update(schema.stationMounts).set({ fallbackMountId: null }).where(eq(schema.stationMounts.fallbackMountId, mount.id));
      await ctx.db.delete(schema.stationMounts).where(eq(schema.stationMounts.id, mount.id));
      if (station.legacyMountId === mount.id) await ctx.db.update(schema.stations).set({ legacyMountId: null }).where(eq(schema.stations.id, station.id));
      Object.assign(req.auditInfo, { targetType: 'mount', details: { mount: mount.path } });
      await apply(req, station.id);
      return { ok: true as const };
    },
  );

  // Outputs

  const outputBody = z.object({
    type: z.enum(['local', 'icecast', 'shoutcast1', 'shoutcast2']),
    name: z.string().trim().min(1).max(80),
    enabled: z.boolean().default(true),
    mountId: z.uuid().nullish(),
    config: outputConfigSchema.default({}),
  });

  async function outputValues(station: Station, body: z.infer<typeof outputBody>, current?: Output) {
    if (body.type === 'local') return { config: {}, mountId: null };
    const c = body.config;
    const push = c.push !== false;
    if (!c.host || !c.port) throw badRequest('Enter the host name and port of the external server');
    if (body.type === 'icecast' && push && !c.mount) throw badRequest('Enter the mount on the external server, e.g. /live');
    if (push) {
      if (!body.mountId) throw badRequest('Choose the mount that is sent to the external server');
      const [m] = await ctx.db.select().from(schema.stationMounts).where(and(eq(schema.stationMounts.id, body.mountId), eq(schema.stationMounts.stationId, station.id)));
      if (!m) throw badRequest('The mount must belong to this station');
    }
    const keep = (value: string | undefined, stored: string | undefined) =>
      value === SECRET_MASK ? stored : value ? ctx.box.encrypt(value) : undefined;
    const config: OutputConfig = {
      host: c.host,
      port: c.port,
      tls: !!c.tls,
      mount: body.type === 'icecast' ? c.mount : undefined,
      username: body.type === 'icecast' ? c.username || 'source' : undefined,
      password: keep(c.password, current?.config.password),
      streamId: body.type === 'shoutcast2' ? (c.streamId ?? 1) : undefined,
      adminPassword: keep(c.adminPassword, current?.config.adminPassword),
      push,
      publicUrl: c.publicUrl || undefined,
    };
    if (push && !config.password) throw badRequest('Enter the source password of the external server');
    return { config, mountId: push ? body.mountId! : null };
  }

  app.post(
    '/:id/outputs',
    {
      config: { audit: 'output.create' },
      schema: {
        tags: ['Stations'],
        summary: `Add an output: listening on this server (local) or an external Icecast/Shoutcast server. Secrets are masked as "${SECRET_MASK}".`,
        params: stationParams,
        body: outputBody,
        response: { 201: outputOut },
      },
    },
    async (req, reply) => {
      const { station } = await stationAccess(ctx, req, req.params.id, 'manager');
      if (req.body.type === 'local') {
        const [existing] = await ctx.db.select().from(schema.stationOutputs).where(and(eq(schema.stationOutputs.stationId, station.id), eq(schema.stationOutputs.type, 'local')));
        if (existing) throw conflict('This station already listens on this server');
      }
      const values = await outputValues(station, req.body);
      const [o] = await ctx.db.insert(schema.stationOutputs).values({ stationId: station.id, type: req.body.type, name: req.body.name, enabled: req.body.enabled, ...values }).returning();
      Object.assign(req.auditInfo, { targetType: 'output', targetId: o!.id, details: { name: o!.name, type: o!.type, host: o!.config.host } });
      await apply(req, station.id);
      reply.status(201);
      return toOutputOut(o!);
    },
  );

  app.put(
    '/:id/outputs/:outputId',
    {
      config: { audit: 'output.update' },
      schema: { tags: ['Stations'], summary: 'Change an output', params: outputParams, body: outputBody, response: { 200: outputOut } },
    },
    async (req) => {
      const { station } = await stationAccess(ctx, req, req.params.id, 'manager');
      const [current] = await ctx.db.select().from(schema.stationOutputs).where(and(eq(schema.stationOutputs.id, req.params.outputId), eq(schema.stationOutputs.stationId, station.id)));
      if (!current) throw notFound('Output');
      if (current.type !== req.body.type && (current.type === 'local' || req.body.type === 'local')) throw badRequest('The type of this output cannot change');
      const values = await outputValues(station, req.body, current);
      const [o] = await ctx.db
        .update(schema.stationOutputs)
        .set({ type: req.body.type, name: req.body.name, enabled: req.body.enabled, ...values, status: null })
        .where(eq(schema.stationOutputs.id, current.id))
        .returning();
      Object.assign(req.auditInfo, { targetType: 'output', details: { name: o!.name, enabled: o!.enabled } });
      await apply(req, station.id);
      return toOutputOut(o!);
    },
  );

  app.delete(
    '/:id/outputs/:outputId',
    { config: { audit: 'output.delete' }, schema: { tags: ['Stations'], summary: 'Remove an output', params: outputParams, response: { 200: okOut } } },
    async (req) => {
      const { station } = await stationAccess(ctx, req, req.params.id, 'manager');
      const deleted = await ctx.db.delete(schema.stationOutputs).where(and(eq(schema.stationOutputs.id, req.params.outputId), eq(schema.stationOutputs.stationId, station.id))).returning();
      if (!deleted.length) throw notFound('Output');
      Object.assign(req.auditInfo, { targetType: 'output', details: { name: deleted[0]!.name } });
      await apply(req, station.id);
      return { ok: true as const };
    },
  );

  // DJ and upload accounts

  async function accountsOut(stationId: string, slug: string, onlyUserId?: string) {
    const rows = await ctx.db
      .select({ a: schema.stationAccounts, userName: schema.users.name })
      .from(schema.stationAccounts)
      .leftJoin(schema.users, eq(schema.users.id, schema.stationAccounts.userId))
      .where(and(eq(schema.stationAccounts.stationId, stationId), onlyUserId ? eq(schema.stationAccounts.userId, onlyUserId) : undefined))
      .orderBy(asc(schema.stationAccounts.username));
    return rows.map(({ a, userName }) => ({
      id: a.id,
      username: a.username,
      displayName: a.displayName,
      userId: a.userId,
      userName,
      canBroadcast: a.canBroadcast,
      canUpload: a.canUpload,
      mountIds: a.mountIds,
      enabled: a.enabled,
      lastUsedAt: a.lastUsedAt,
      createdAt: a.createdAt,
      uploadLogin: `${slug}.${a.username}`,
    }));
  }

  async function checkAccountRefs(station: Station, userId: string | null | undefined, mountIds: string[] | undefined) {
    if (userId) {
      const [m] = await ctx.db.select().from(schema.memberships).where(and(eq(schema.memberships.userId, userId), eq(schema.memberships.tenantId, station.tenantId)));
      if (!m) throw badRequest('The linked user must belong to this customer');
    }
    if (mountIds?.length) {
      const rows = await ctx.db.select({ id: schema.stationMounts.id }).from(schema.stationMounts).where(and(eq(schema.stationMounts.stationId, station.id), inArray(schema.stationMounts.id, mountIds)));
      if (rows.length !== new Set(mountIds).size) throw badRequest('Choose mounts of this station');
    }
  }

  const generatedPassword = () => newInternalPassword().slice(0, 16);

  app.get(
    '/:id/accounts',
    { schema: { tags: ['Stations'], summary: 'DJ and upload accounts. DJs only see their own.', params: stationParams, response: { 200: z.array(accountOut) } } },
    async (req) => {
      const { station, access } = await stationAccess(ctx, req, req.params.id, 'dj');
      return accountsOut(station.id, station.slug, access.role === 'dj' ? access.user.id : undefined);
    },
  );

  app.post(
    '/:id/accounts',
    {
      config: { audit: 'station_account.create' },
      schema: {
        tags: ['Stations'],
        summary: 'Add a DJ or upload account. Without a password one is generated and returned once.',
        params: stationParams,
        body: z.object({
          username: usernameSchema,
          displayName: z.string().trim().max(80).default(''),
          password: z.string().min(8, 'Use at least 8 characters').max(200).optional(),
          userId: z.uuid().nullish(),
          canBroadcast: z.boolean().default(true),
          canUpload: z.boolean().default(false),
          mountIds: z.array(z.uuid()).max(50).default([]),
          enabled: z.boolean().default(true),
        }),
        response: { 201: accountOut.extend({ password: z.string().optional() }) },
      },
    },
    async (req, reply) => {
      const { station } = await stationAccess(ctx, req, req.params.id, 'manager');
      if (req.body.username === 'source' || req.body.username === 'admin') throw badRequest('This user name is reserved');
      await checkAccountRefs(station, req.body.userId, req.body.mountIds);
      const password = req.body.password ?? generatedPassword();
      try {
        const [a] = await ctx.db
          .insert(schema.stationAccounts)
          .values({ ...req.body, stationId: station.id, userId: req.body.userId ?? null, passwordHash: await hashPassword(password) })
          .returning();
        Object.assign(req.auditInfo, { targetType: 'station_account', targetId: a!.id, details: { username: a!.username } });
        reply.status(201);
        const out = (await accountsOut(station.id, station.slug)).find((x) => x.id === a!.id)!;
        return req.body.password ? out : { ...out, password };
      } catch (err) {
        if (isUniqueViolation(err)) throw conflict('This station already has an account with this user name');
        throw err;
      }
    },
  );

  app.patch(
    '/:id/accounts/:accountId',
    {
      config: { audit: 'station_account.update' },
      schema: {
        tags: ['Stations'],
        summary: 'Change an account. DJs may only set a new password for their own account. `resetPassword` generates one.',
        params: accountParams,
        body: z.object({
          displayName: z.string().trim().max(80).optional(),
          password: z.string().min(8, 'Use at least 8 characters').max(200).optional(),
          resetPassword: z.boolean().optional(),
          userId: z.uuid().nullish(),
          canBroadcast: z.boolean().optional(),
          canUpload: z.boolean().optional(),
          mountIds: z.array(z.uuid()).max(50).optional(),
          enabled: z.boolean().optional(),
        }),
        response: { 200: accountOut.extend({ password: z.string().optional() }) },
      },
    },
    async (req) => {
      const { station, access } = await stationAccess(ctx, req, req.params.id, 'dj');
      const [current] = await ctx.db.select().from(schema.stationAccounts).where(and(eq(schema.stationAccounts.id, req.params.accountId), eq(schema.stationAccounts.stationId, station.id)));
      if (!current) throw notFound('Account');
      const { password, resetPassword, ...rest } = req.body;
      if (access.role === 'dj') {
        if (current.userId !== access.user.id) throw forbidden();
        if (Object.values(rest).some((v) => v !== undefined)) throw forbidden('DJs can only change the password of their own account');
      }
      await checkAccountRefs(station, rest.userId, rest.mountIds);
      const newPassword = resetPassword ? generatedPassword() : password;
      await ctx.db
        .update(schema.stationAccounts)
        .set({ ...rest, ...(newPassword ? { passwordHash: await hashPassword(newPassword) } : {}) })
        .where(eq(schema.stationAccounts.id, current.id));
      Object.assign(req.auditInfo, { targetType: 'station_account', details: { username: current.username, password: !!newPassword } });
      const out = (await accountsOut(station.id, station.slug)).find((x) => x.id === current.id)!;
      return resetPassword ? { ...out, password: newPassword } : out;
    },
  );

  app.delete(
    '/:id/accounts/:accountId',
    { config: { audit: 'station_account.delete' }, schema: { tags: ['Stations'], summary: 'Remove an account', params: accountParams, response: { 200: okOut } } },
    async (req) => {
      const { station } = await stationAccess(ctx, req, req.params.id, 'manager');
      const deleted = await ctx.db.delete(schema.stationAccounts).where(and(eq(schema.stationAccounts.id, req.params.accountId), eq(schema.stationAccounts.stationId, station.id))).returning();
      if (!deleted.length) throw notFound('Account');
      Object.assign(req.auditInfo, { targetType: 'station_account', details: { username: deleted[0]!.username } });
      return { ok: true as const };
    },
  );
};
