import { and, asc, eq, inArray } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { schema } from '../db/index.js';
import type { ClockItem } from '../db/schema.js';
import { badRequest, notFound } from '../lib/errors.js';
import { okOut } from '../lib/schemas.js';
import { anchorOf } from '../services/scheduler/clock.js';
import { loadSchedule } from '../services/scheduler/runtime.js';
import { schedulerSchema, schedulerSettings } from '../services/scheduler/settings.js';
import { wallTime } from '../services/scheduler/time.js';
import { stationAccess } from './stations.js';

const stationParams = z.object({ id: z.uuid() });
const color = z
  .string()
  .trim()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Use a colour like #FF6B57');

const clockItemSchema = z.object({
  id: z.string().trim().min(1).max(40),
  kind: z.enum(['rotation', 'playlist', 'track']),
  label: z.string().trim().max(60).default(''),
  playlistId: z.uuid().nullable().default(null),
  mediaId: z.uuid().nullable().default(null),
  count: z.number().int().min(0).max(20).default(1),
  at: z.number().int().min(0).max(59).nullable().default(null),
  hard: z.boolean().default(false),
});
const clockBody = z.object({
  name: z.string().trim().min(1).max(60),
  color: color.default('#FF6B57'),
  items: z.array(clockItemSchema).max(60).default([]),
});
const clockOut = clockBody.extend({ id: z.uuid(), createdAt: z.date(), updatedAt: z.date() });

const entryBody = z
  .object({
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(500).default(''),
    clockId: z.uuid().nullable().default(null),
    live: z.boolean().default(false),
    accountIds: z.array(z.uuid()).max(20).default([]),
    days: z.array(z.number().int().min(1).max(7)).max(7).default([]),
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-12-31')
      .nullable()
      .default(null),
    startMinute: z.number().int().min(0).max(1439),
    durationMinutes: z.number().int().min(5).max(1440),
    isPublic: z.boolean().default(true),
    enabled: z.boolean().default(true),
  })
  .refine((e) => e.date || e.days.length, { message: 'Choose the days or a date', path: ['days'] });
const entryOut = z.object({
  id: z.uuid(),
  name: z.string(),
  description: z.string(),
  clockId: z.uuid().nullable(),
  live: z.boolean(),
  accountIds: z.array(z.uuid()),
  days: z.array(z.number().int()),
  date: z.string().nullable(),
  startMinute: z.number().int(),
  durationMinutes: z.number().int(),
  isPublic: z.boolean(),
  enabled: z.boolean(),
  createdAt: z.date(),
});

const schedulerOut = z.object({
  settings: schedulerSchema,
  clocks: z.array(clockOut),
  entries: z.array(entryOut),
  /** DJ accounts that can host live shows. */
  accounts: z.array(z.object({ id: z.uuid(), username: z.string(), displayName: z.string() })),
  /** The station's wall clock now, in its time zone. */
  now: z.object({ date: z.string(), weekday: z.number().int(), minuteOfDay: z.number().int(), second: z.number().int() }),
  onAir: z.object({ entryId: z.uuid().nullable(), clockId: z.uuid().nullable() }),
  /** The library tracks the clocks play. */
  tracks: z.array(z.object({ id: z.uuid(), title: z.string(), artist: z.string(), durationSeconds: z.number().nullable() })),
});

/** Hour clocks and the weekly schedule of Radio stations (phase 7). */
export const schedulerRoutes: FastifyPluginAsyncZod = async (app) => {
  const { ctx } = app;

  async function radio(req: Parameters<typeof stationAccess>[1], stationId: string, minRole: 'dj' | 'manager') {
    const r = await stationAccess(ctx, req, stationId, minRole);
    if (r.station.edition !== 'station') throw badRequest('This needs the Radio station edition; upgrade the station first');
    return r;
  }

  async function describe(station: typeof schema.stations.$inferSelect): Promise<z.infer<typeof schedulerOut>> {
    const plan = await loadSchedule(ctx.db, station);
    const [entries, accounts] = await Promise.all([
      ctx.db.select().from(schema.scheduleEntries).where(eq(schema.scheduleEntries.stationId, station.id)).orderBy(asc(schema.scheduleEntries.startMinute)),
      ctx.db
        .select({ id: schema.stationAccounts.id, username: schema.stationAccounts.username, displayName: schema.stationAccounts.displayName })
        .from(schema.stationAccounts)
        .where(and(eq(schema.stationAccounts.stationId, station.id), eq(schema.stationAccounts.canBroadcast, true)))
        .orderBy(asc(schema.stationAccounts.username)),
    ]);
    const now = Date.now();
    const w = wallTime(now, plan.settings.timezone);
    const mediaIds = [...new Set([...plan.clocks.values()].flatMap((c) => c.items.map((i) => i.mediaId)).filter((v): v is string => !!v))];
    const tracks = mediaIds.length
      ? await ctx.db
          .select({ id: schema.mediaFiles.id, title: schema.mediaFiles.title, artist: schema.mediaFiles.artist, durationSeconds: schema.mediaFiles.durationSeconds })
          .from(schema.mediaFiles)
          .where(and(eq(schema.mediaFiles.stationId, station.id), inArray(schema.mediaFiles.id, mediaIds)))
      : [];
    return {
      settings: plan.settings,
      clocks: [...plan.clocks.values()].sort((a, b) => a.name.localeCompare(b.name)),
      entries,
      accounts,
      now: { date: w.date, weekday: w.weekday, minuteOfDay: w.minuteOfDay, second: w.second },
      onAir: { entryId: plan.entryAt(now)?.id ?? null, clockId: plan.clockAt(now)?.id ?? null },
      tracks,
    };
  }

  /** Checks a clock: playlists and tracks of this station, timed items in order of their minute. */
  async function checkItems(stationId: string, items: ClockItem[]) {
    const ids = new Set<string>();
    let last = -1;
    items.forEach((item, i) => {
      if (ids.has(item.id)) throw badRequest('Every item of a clock needs its own id');
      ids.add(item.id);
      if (item.kind === 'playlist' && !item.playlistId) throw badRequest(`Item ${i + 1}: choose a playlist`);
      if (item.kind === 'track' && !item.mediaId) throw badRequest(`Item ${i + 1}: choose a track`);
      const a = anchorOf(items, i);
      if (a !== null) {
        if (a <= last) throw badRequest(`Item ${i + 1}: timed items must follow each other in time (minute ${a} comes after minute ${last})`);
        last = a;
      }
    });
    const playlistIds = [...new Set(items.map((i) => (i.kind === 'playlist' ? i.playlistId : null)).filter((v): v is string => !!v))];
    const mediaIds = [...new Set(items.map((i) => (i.kind === 'track' ? i.mediaId : null)).filter((v): v is string => !!v))];
    if (playlistIds.length) {
      const found = await ctx.db.select({ id: schema.playlists.id }).from(schema.playlists).where(and(eq(schema.playlists.stationId, stationId), inArray(schema.playlists.id, playlistIds)));
      if (found.length !== playlistIds.length) throw badRequest('A playlist of this clock does not exist');
    }
    if (mediaIds.length) {
      const found = await ctx.db.select({ id: schema.mediaFiles.id }).from(schema.mediaFiles).where(and(eq(schema.mediaFiles.stationId, stationId), inArray(schema.mediaFiles.id, mediaIds)));
      if (found.length !== mediaIds.length) throw badRequest('A track of this clock is not in the library');
    }
    return items.map((i) => ({
      ...i,
      playlistId: i.kind === 'playlist' ? i.playlistId : null,
      mediaId: i.kind === 'track' ? i.mediaId : null,
      count: i.kind === 'playlist' ? i.count : 1,
      hard: anchorOf(items, items.indexOf(i)) !== null && i.hard,
    }));
  }

  async function checkEntry(stationId: string, body: z.infer<typeof entryBody>) {
    if (body.clockId) {
      const [c] = await ctx.db.select({ id: schema.clocks.id }).from(schema.clocks).where(and(eq(schema.clocks.id, body.clockId), eq(schema.clocks.stationId, stationId)));
      if (!c) throw badRequest('Unknown clock');
    }
    const accountIds = body.live ? [...new Set(body.accountIds)] : [];
    if (accountIds.length) {
      const found = await ctx.db
        .select({ id: schema.stationAccounts.id })
        .from(schema.stationAccounts)
        .where(and(eq(schema.stationAccounts.stationId, stationId), inArray(schema.stationAccounts.id, accountIds)));
      if (found.length !== accountIds.length) throw badRequest('A DJ of this show is not an account of this station');
    }
    return { ...body, accountIds, days: body.date ? [] : [...new Set(body.days)].sort() };
  }

  app.get(
    '/:id/scheduler',
    { schema: { tags: ['Scheduler'], summary: 'Hour clocks, the weekly schedule, its settings and what runs now', params: stationParams, response: { 200: schedulerOut } } },
    async (req) => {
      const { station } = await radio(req, req.params.id, 'dj');
      return describe(station);
    },
  );

  app.put(
    '/:id/scheduler',
    {
      config: { audit: 'scheduler.update' },
      schema: { tags: ['Scheduler'], summary: 'Change the scheduler settings (managers)', params: stationParams, body: schedulerSchema, response: { 200: schedulerOut } },
    },
    async (req) => {
      const { station } = await radio(req, req.params.id, 'manager');
      if (req.body.defaultClockId) {
        const [c] = await ctx.db.select({ id: schema.clocks.id }).from(schema.clocks).where(and(eq(schema.clocks.id, req.body.defaultClockId), eq(schema.clocks.stationId, station.id)));
        if (!c) throw badRequest('Unknown clock');
      }
      const [row] = await ctx.db.update(schema.stations).set({ scheduler: req.body, updatedAt: new Date() }).where(eq(schema.stations.id, station.id)).returning();
      req.auditInfo.details = { enabled: req.body.enabled, timezone: req.body.timezone };
      return describe(row!);
    },
  );

  // Clocks

  app.post(
    '/:id/clocks',
    { config: { audit: 'clock.create' }, schema: { tags: ['Scheduler'], summary: 'Add an hour clock (managers)', params: stationParams, body: clockBody, response: { 201: clockOut } } },
    async (req, reply) => {
      const { station } = await radio(req, req.params.id, 'manager');
      const items = await checkItems(station.id, req.body.items);
      const [c] = await ctx.db.insert(schema.clocks).values({ ...req.body, items, stationId: station.id }).returning();
      Object.assign(req.auditInfo, { targetType: 'clock', targetId: c!.id, details: { name: c!.name } });
      reply.status(201);
      return c!;
    },
  );

  app.put(
    '/:id/clocks/:clockId',
    {
      config: { audit: 'clock.update' },
      schema: { tags: ['Scheduler'], summary: 'Change an hour clock', params: stationParams.extend({ clockId: z.uuid() }), body: clockBody, response: { 200: clockOut } },
    },
    async (req) => {
      const { station } = await radio(req, req.params.id, 'manager');
      const items = await checkItems(station.id, req.body.items);
      const [c] = await ctx.db
        .update(schema.clocks)
        .set({ ...req.body, items, updatedAt: new Date() })
        .where(and(eq(schema.clocks.id, req.params.clockId), eq(schema.clocks.stationId, station.id)))
        .returning();
      if (!c) throw notFound('Clock');
      Object.assign(req.auditInfo, { targetType: 'clock', targetId: c.id, details: { name: c.name } });
      return c;
    },
  );

  app.delete(
    '/:id/clocks/:clockId',
    {
      config: { audit: 'clock.delete' },
      schema: { tags: ['Scheduler'], summary: 'Remove an hour clock; blocks that ran it play the queues', params: stationParams.extend({ clockId: z.uuid() }), response: { 200: okOut } },
    },
    async (req) => {
      const { station } = await radio(req, req.params.id, 'manager');
      const deleted = await ctx.db.delete(schema.clocks).where(and(eq(schema.clocks.id, req.params.clockId), eq(schema.clocks.stationId, station.id))).returning();
      if (!deleted.length) throw notFound('Clock');
      const s = schedulerSettings(station);
      if (s.defaultClockId === deleted[0]!.id) await ctx.db.update(schema.stations).set({ scheduler: { ...s, defaultClockId: null } }).where(eq(schema.stations.id, station.id));
      Object.assign(req.auditInfo, { targetType: 'clock', details: { name: deleted[0]!.name } });
      return { ok: true as const };
    },
  );

  // Schedule

  app.post(
    '/:id/schedule',
    {
      config: { audit: 'schedule.create' },
      schema: { tags: ['Scheduler'], summary: 'Add a block or show to the schedule (managers)', params: stationParams, body: entryBody, response: { 201: entryOut } },
    },
    async (req, reply) => {
      const { station } = await radio(req, req.params.id, 'manager');
      const values = await checkEntry(station.id, req.body);
      const [e] = await ctx.db.insert(schema.scheduleEntries).values({ ...values, stationId: station.id }).returning();
      Object.assign(req.auditInfo, { targetType: 'schedule_entry', targetId: e!.id, details: { name: e!.name } });
      reply.status(201);
      return e!;
    },
  );

  app.put(
    '/:id/schedule/:entryId',
    {
      config: { audit: 'schedule.update' },
      schema: { tags: ['Scheduler'], summary: 'Change a block or show', params: stationParams.extend({ entryId: z.uuid() }), body: entryBody, response: { 200: entryOut } },
    },
    async (req) => {
      const { station } = await radio(req, req.params.id, 'manager');
      const values = await checkEntry(station.id, req.body);
      const [e] = await ctx.db
        .update(schema.scheduleEntries)
        .set(values)
        .where(and(eq(schema.scheduleEntries.id, req.params.entryId), eq(schema.scheduleEntries.stationId, station.id)))
        .returning();
      if (!e) throw notFound('Schedule block');
      Object.assign(req.auditInfo, { targetType: 'schedule_entry', targetId: e.id, details: { name: e.name } });
      return e;
    },
  );

  app.delete(
    '/:id/schedule/:entryId',
    {
      config: { audit: 'schedule.delete' },
      schema: { tags: ['Scheduler'], summary: 'Remove a block or show from the schedule', params: stationParams.extend({ entryId: z.uuid() }), response: { 200: okOut } },
    },
    async (req) => {
      const { station } = await radio(req, req.params.id, 'manager');
      const deleted = await ctx.db
        .delete(schema.scheduleEntries)
        .where(and(eq(schema.scheduleEntries.id, req.params.entryId), eq(schema.scheduleEntries.stationId, station.id)))
        .returning();
      if (!deleted.length) throw notFound('Schedule block');
      Object.assign(req.auditInfo, { targetType: 'schedule_entry', details: { name: deleted[0]!.name } });
      return { ok: true as const };
    },
  );
};
