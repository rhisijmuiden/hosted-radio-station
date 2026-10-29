import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import fastifyMultipart from '@fastify/multipart';
import { and, asc, count, desc, eq, ilike, inArray, isNotNull, ne, or, sql, type SQL } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { schema } from '../db/index.js';
import type { MediaSourceConfig } from '../db/schema.js';
import { badRequest, forbidden, HttpError, notFound } from '../lib/errors.js';
import { okOut } from '../lib/schemas.js';
import { assertRadioStationAllowed, downgradeKeeping, makeRadioStation, radioStationNode, undoDowngrade } from '../services/autodj/edition.js';
import {
  filePath,
  MEDIA_EXTENSIONS,
  MUSIC_FOLDER,
  normaliseIsrc,
  normaliseKey,
  refreshSourceStatus,
  scanLibrary,
  scanProgress,
  STORAGE,
  type MediaSource,
} from '../services/autodj/library.js';
import { clearQueue, dropDisabled, enqueue, fillQueues, inPlaylist, mediaPath, moveItem, playNow, queueRows } from '../services/autodj/planner.js';
import { NEWS, newsSettings, readNewsStatus } from '../services/autodj/news.js';
import { autodjSchema, autodjSettings, queueRuleSchema } from '../services/autodj/settings.js';
import { anchorOf, isFill } from '../services/scheduler/clock.js';
import { hourStart } from '../services/scheduler/time.js';
import { loadSchedule } from '../services/scheduler/runtime.js';
import { AUDIO_TYPES } from '../services/public/ondemand.js';
import { SECRET_MASK } from '../services/settings.js';
import { mediaDir } from '../services/streaming/icecast.js';
import { applyStreams, type Station } from '../services/streaming/state.js';
import { readStreamsStatus } from '../services/streaming/status.js';
import { scanStationStorage, tenantStorageUsage } from '../services/streaming/storage.js';
import { AUTODJ_CHANNEL } from '../streams/autodj.js';
import { sendFile } from './public.js';
import { stationAccess } from './stations.js';
import { cueProblem, playSeconds } from '../services/autodj/cues.js';
import { stationRouting } from '../services/nodes/routing-rules.js';

const stationParams = z.object({ id: z.uuid() });

/** Upload in parts: at most this much per request (under the 100 MB body limit of Cloudflare), and per file. */
const UPLOAD_PART = 16 * 1024 * 1024;
const UPLOAD_MAX = 8 * 1024 * 1024 * 1024;
/** Uploads in parts that were started: id → where the file goes. A restart forgets them; the client starts again and resumes. */
const uploads = new Map<string, { stationId: string; rel: string; size: number }>();
/** After a batch of uploads, one library scan instead of one per file. */
const scanTimers = new Map<string, NodeJS.Timeout>();
const queueSchema = z.enum(['q1', 'q2']);
/** Since 1.3 there is one queue, `q1`; `q2` from older clients means the same queue. */
const queueIn = queueSchema.transform(() => 'q1' as const).default('q1');

/** Cue points in seconds from the start of the file (RHIS Studio cue editor); null = not set. */
const cuesOut = z.object({
  cueIn: z.number().nullable(),
  cueIntro: z.number().nullable(),
  cueSegue: z.number().nullable(),
  cueFadeOut: z.number().nullable(),
  cueOut: z.number().nullable(),
});
const cueSecond = z.number().min(0).max(86_400).nullable();
const mediaOut = z.object({
  id: z.uuid(),
  location: z.string(),
  path: z.string(),
  title: z.string(),
  artist: z.string(),
  album: z.string(),
  genre: z.string(),
  year: z.number().int().nullable(),
  durationSeconds: z.number().nullable(),
  bitrateKbps: z.number().int().nullable(),
  gainDb: z.number().nullable(),
  /** The station's own number for the track, e.g. HF-03007 (null until the server gives it, within a minute). */
  code: z.string().nullable(),
  isrc: z.string(),
  bpm: z.number().nullable(),
  /** "Am", "F#" or empty. */
  musicKey: z.string(),
  ...cuesOut.shape,
  sizeBytes: z.number(),
  enabled: z.boolean(),
  edited: z.boolean(),
  playCount: z.number().int(),
  lastPlayedAt: z.date().nullable(),
  createdAt: z.date(),
  /** Playlists the track is in (by folder or by hand). */
  playlistIds: z.array(z.uuid()),
});
const folderSchema = z.object({ location: z.string().max(64), path: z.string().max(500) });
const playlistBody = z.object({
  name: z.string().trim().min(1).max(80),
  /** Always `q1` since 1.3 (one queue); kept for older clients. */
  queue: queueIn,
  weight: z.number().int().min(1).max(10).default(5),
  order: z.enum(['shuffle', 'random', 'sequential']).default('shuffle'),
  folders: z.array(folderSchema).max(50).default([]),
  enabled: z.boolean().default(true),
  /** Feeds its queue; off = only played where an hour clock asks for it (news, commercials, jingles). */
  rotation: z.boolean().default(true),
});
const playlistOut = playlistBody.extend({ queue: queueSchema, id: z.uuid(), trackCount: z.number().int(), averageSeconds: z.number().nullable(), createdAt: z.date() });
const sourceStatusOut = z.object({ state: z.enum(['pending', 'ok', 'error']), message: z.string().optional(), checkedAt: z.string().optional() }).nullable();
const sourceBody = z.object({
  name: z.string().trim().min(1).max(80),
  type: z.enum(['local', 'smb', 'nfs']),
  enabled: z.boolean().default(true),
  config: z
    .object({
      path: z.string().trim().max(500).optional(),
      host: z
        .string()
        .trim()
        .toLowerCase()
        .regex(/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$|^\d{1,3}(\.\d{1,3}){3}$/, 'Invalid host name')
        .optional(),
      share: z
        .string()
        .trim()
        .regex(/^[A-Za-z0-9._$ -]{1,80}(\/[A-Za-z0-9._ -]{1,80}){0,8}$/, 'Use the share name, optionally followed by /folder')
        .refine((v) => !v.split('/').some((p) => p.trim() === '.' || p.trim() === '..'), 'Use the share name, optionally followed by /folder')
        .optional(),
      export: z
        .string()
        .trim()
        .regex(/^\/[A-Za-z0-9._/-]{0,200}$/, 'Use the exported path, e.g. /export/music')
        .refine((v) => !v.split('/').includes('..'), 'Use the exported path, e.g. /export/music')
        .optional(),
      username: z
        .string()
        .trim()
        .max(100)
        .regex(/^[^\r\n,=]*$/, 'Invalid user name')
        .optional(),
      password: z
        .string()
        .max(200)
        .regex(/^[^\r\n]*$/, 'Invalid password')
        .optional(),
      domain: z
        .string()
        .trim()
        .max(100)
        .regex(/^[A-Za-z0-9._-]*$/, 'Invalid domain')
        .optional(),
      version: z.enum(['', '1.0', '2.0', '2.1', '3.0', '3.1.1', '3', '4', '4.1', '4.2']).optional(),
    })
    .default({}),
});
const sourceOut = z.object({
  id: z.uuid(),
  name: z.string(),
  type: z.enum(['local', 'smb', 'nfs']),
  enabled: z.boolean(),
  config: sourceBody.shape.config,
  status: sourceStatusOut,
  fileCount: z.number().int(),
  scannedAt: z.date().nullable(),
});
const scanOut = z.object({
  running: z.boolean(),
  location: z.string().nullable(),
  found: z.number().int(),
  added: z.number().int(),
  updated: z.number().int(),
  removed: z.number().int(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  errors: z.array(z.string()),
});
const queueRowOut = z.object({
  id: z.uuid(),
  queue: queueSchema,
  state: z.enum(['queued', 'cued', 'loaded', 'playing']),
  origin: z.string(),
  addedBy: z.string().nullable(),
  requestId: z.uuid().nullable(),
  playlistName: z.string().nullable(),
  label: z.string().nullable(),
  /** From a locked clock item: DJs cannot skip it or play something else over it. */
  locked: z.boolean(),
  startedAt: z.date().nullable(),
  media: z.object({ id: z.uuid(), title: z.string(), artist: z.string(), album: z.string(), durationSeconds: z.number().nullable(), location: z.string(), path: z.string() }).extend(cuesOut.shape),
});
const autodjOut = z.object({
  edition: z.enum(['distribution', 'station']),
  settings: autodjSchema,
  mount: z.object({ id: z.uuid(), path: z.string(), format: z.string(), bitrateKbps: z.number().int() }).nullable(),
  /** Mounts whose listeners hear the AutoDJ when no DJ is live. */
  coveredMounts: z.array(z.string()),
  player: z.object({
    /** The AutoDJ should play (Radio station, switched on, station enabled). */
    expected: z.boolean(),
    /** The player asked for a track or reported one in the last few minutes. */
    connected: z.boolean(),
    seenAt: z.string().nullable(),
    paused: z.boolean(),
  }),
  /** Manual playout (RHIS Studio): every track waits for Play. Falls back to Auto when the client stops renewing it. */
  playout: z.object({ manual: z.boolean(), holding: z.boolean(), until: z.date().nullable() }),
  nowPlaying: queueRowOut.nullable(),
  queues: z.object({ q1: z.array(queueRowOut), q2: z.array(queueRowOut) }),
  library: z.object({ tracks: z.number().int(), enabled: z.number().int(), playlists: z.number().int() }),
  /** What the schedule runs now (phase 7). */
  schedule: z.object({
    enabled: z.boolean(),
    clock: z.object({ id: z.uuid(), name: z.string(), color: z.string() }).nullable(),
    entry: z.object({ id: z.uuid(), name: z.string(), live: z.boolean() }).nullable(),
  }),
});

/** Manual playout stays on this long after the client's last renewal; RHIS Studio renews it every 10 seconds. */
export const MANUAL_GRACE_MS = 30_000;

const rundownRowOut = z.object({
  /** Start of the hour (clock) the row belongs to. */
  hour: z.date(),
  /** Planned start: the item's minute, or the start of the timed item before it. */
  startsAt: z.date(),
  /** The item has its own minute (timed); otherwise it follows the item before it. */
  timed: z.boolean(),
  hard: z.boolean(),
  /** DJs cannot skip the item or play something else over it. */
  locked: z.boolean(),
  /** music = from the queues or a playlist until the next timed item; item = tracks the format puts in. */
  kind: z.enum(['music', 'item']),
  source: z.enum(['queues', 'playlist', 'track', 'news']),
  label: z.string(),
  count: z.number().int(),
  /** Expected length of a format item in seconds: its track, or count × the average of its playlist (null = unknown). */
  seconds: z.number().nullable(),
  clock: z.object({ id: z.uuid(), name: z.string(), color: z.string() }).nullable(),
  show: z.object({ id: z.uuid(), name: z.string(), live: z.boolean() }).nullable(),
  /** The item the player is at now. */
  current: z.boolean(),
  past: z.boolean(),
});
const rundownOut = z.object({ timezone: z.string(), enabled: z.boolean(), rows: z.array(rundownRowOut) });

const contentType = (path: string) => AUDIO_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';

/** Media library, shares, playlists and the AutoDJ of Radio stations. */
export const autodjRoutes: FastifyPluginAsyncZod = async (app) => {
  const { ctx } = app;
  await app.register(fastifyMultipart, { limits: { fileSize: 1024 * 1024 * 1024, files: 200, fields: 5 } });
  const apply = (req: FastifyRequest, stationId: string) =>
    applyStreams(ctx, { stationIds: [stationId], by: req.auth?.user.email }).catch((err) => req.log.error({ err }, 'applying stream configuration failed'));

  /** Station access for the Radio station features. */
  async function radio(req: FastifyRequest, stationId: string, minRole: 'dj' | 'manager' | 'owner') {
    const r = await stationAccess(ctx, req, stationId, minRole);
    if (r.station.edition !== 'station') throw badRequest('This needs the Radio station edition; upgrade the station first');
    return r;
  }

  async function sourcesOf(stationId: string) {
    return new Map((await ctx.db.select().from(schema.mediaSources).where(eq(schema.mediaSources.stationId, stationId))).map((s) => [s.id, s] as const));
  }

  function checkLocation(location: string, sources: Map<string, MediaSource>) {
    if (location !== STORAGE && !sources.has(location)) throw badRequest('Unknown library location');
  }

  // Edition

  app.post(
    '/:id/upgrade',
    {
      config: { audit: 'station.upgrade' },
      schema: {
        tags: ['AutoDJ'],
        summary:
          'Upgrade a station to the Radio station edition in one step: AutoDJ mount, fallback of the default mount, a first playlist and the AutoDJ switched on. It runs on the station node `nodeId` (default: the customer\'s station node) or on this server. Owners, within the customer\'s limit of Radio stations.',
        params: stationParams,
        body: z
          .object({
            nodeId: z.uuid().optional(),
            /** No longer used: customers have no edition any more, only a limit of Radio stations. */
            upgradeCustomer: z.boolean().optional(),
          })
          .default({}),
        response: { 200: autodjOut },
      },
    },
    async (req) => {
      const { station, tenant, access } = await stationAccess(ctx, req, req.params.id, 'owner');
      if (station.edition === 'station') return describe(station);
      await assertRadioStationAllowed(ctx, tenant, station.id);
      // Within 24 hours of going back to Distribution only: it returns where it ran, with all its content.
      if (station.downgrade) {
        const back = (await undoDowngrade(ctx, station))!;
        req.auditInfo.details = { from: station.edition, to: 'station', undo: true, nodeId: back.nodeId };
        await apply(req, station.id);
        if (!back.nodeId) await fillQueues(ctx, station.id).catch(() => undefined);
        return describe(back);
      }
      const node = station.nodeId ? null : await radioStationNode(ctx, { tenant, stationId: station.id, nodeId: req.body.nodeId, admin: access.role === 'superadmin' });
      if (!node && !station.nodeId) {
        // The AutoDJ plays on this server, so it becomes the main ingest again (an ingest node can stay as backup).
        const r = stationRouting(station);
        if (r.ingest !== 'local') await ctx.db.update(schema.stations).set({ routing: { ...r, ingest: 'local', backupIngest: r.backupIngest ?? r.ingest } }).where(eq(schema.stations.id, station.id));
      }
      const updated = await makeRadioStation(ctx, station, node);
      req.auditInfo.details = { from: station.edition, to: 'station', nodeId: node?.id ?? station.nodeId };
      await apply(req, station.id);
      if (!updated.nodeId) {
        await fillQueues(ctx, station.id).catch(() => undefined);
        void scanLibrary(ctx, station.id).catch(() => undefined);
      }
      return describe(updated);
    },
  );

  app.post(
    '/:id/downgrade',
    {
      config: { audit: 'station.downgrade' },
      schema: {
        tags: ['AutoDJ'],
        summary:
          'Back to Distribution only, with confirm: true. From then on the station only receives a stream from your own software; the AutoDJ, hour clocks, library and DJ logins stop. Its content is kept for 24 hours (until) so it can switch back with POST /upgrade; then it is deleted. Owners.',
        params: stationParams,
        body: z.object({ confirm: z.boolean().default(false) }).default({ confirm: false }),
        response: { 200: z.object({ ok: z.literal(true), until: z.string() }) },
      },
    },
    async (req) => {
      const { station } = await stationAccess(ctx, req, req.params.id, 'owner');
      if (station.edition !== 'station') throw badRequest('This station has the Distribution edition');
      if (!req.body.confirm) throw badRequest('Confirm that the station goes back to Distribution only: its AutoDJ, hour clocks, library and DJ logins stop, and its content is deleted after 24 hours');
      const updated = await downgradeKeeping(ctx, station, req.auth?.user.email);
      req.auditInfo.details = { from: 'station', to: 'distribution', until: updated.downgrade!.until, nodeId: station.nodeId };
      await apply(req, station.id);
      return { ok: true as const, until: updated.downgrade!.until };
    },
  );

  // AutoDJ

  async function describe(station: Station): Promise<z.infer<typeof autodjOut>> {
    const settings = autodjSettings(station);
    const [mounts, rows, [lib], [pl], status] = await Promise.all([
      ctx.db.select().from(schema.stationMounts).where(eq(schema.stationMounts.stationId, station.id)),
      queueRows(ctx, station.id),
      ctx.db
        .select({ tracks: count(), enabled: sql<number>`count(*) filter (where ${schema.mediaFiles.enabled})::int` })
        .from(schema.mediaFiles)
        .where(and(eq(schema.mediaFiles.stationId, station.id), ne(schema.mediaFiles.location, NEWS))),
      ctx.db.select({ n: count() }).from(schema.playlists).where(eq(schema.playlists.stationId, station.id)),
      readStreamsStatus(ctx),
    ]);
    const mount = mounts.find((m) => m.id === settings.mountId);
    const byId = new Map(mounts.map((m) => [m.id, m]));
    const covered = mount
      ? mounts
          .filter((m) => {
            let cur = m.fallbackMountId ? byId.get(m.fallbackMountId) : undefined;
            for (let i = 0; cur && i < 20; i++) {
              if (cur.id === mount.id) return true;
              cur = cur.fallbackMountId ? byId.get(cur.fallbackMountId) : undefined;
            }
            return false;
          })
          .map((m) => m.path)
      : [];
    const p = status.worker?.alive ? status.worker.autodj[station.id] : undefined;
    const [db] = await ctx.db.select().from(schema.autodjState).where(eq(schema.autodjState.stationId, station.id));
    const seenAt = p?.seenAt ?? db?.seenAt?.toISOString() ?? null;
    const expected = station.edition === 'station' && settings.enabled && !!mount && station.enabled;
    const playing = rows.find((r) => r.state === 'playing') ?? null;
    const plan = await loadSchedule(ctx.db, station);
    const now = Date.now();
    const clock = plan.settings.enabled ? plan.clockAt(now) : null;
    const entry = plan.settings.enabled ? plan.entryAt(now) : null;
    return {
      edition: station.edition,
      settings,
      mount: mount ? { id: mount.id, path: mount.path, format: mount.format, bitrateKbps: mount.bitrateKbps } : null,
      coveredMounts: covered,
      player: {
        expected,
        // The player asks for a track at least once per track; allow for long tracks and a held player.
        connected: expected && !!(p?.reachable || (seenAt && Date.now() - new Date(seenAt).getTime() < 20 * 60_000)),
        seenAt,
        paused: !!p?.paused,
      },
      playout: {
        manual: !!db?.manualUntil && db.manualUntil.getTime() > now,
        holding: !!(db?.manualUntil && db.manualUntil.getTime() > now && p?.holding),
        until: db?.manualUntil && db.manualUntil.getTime() > now ? db.manualUntil : null,
      },
      nowPlaying: playing,
      queues: { q1: rows.filter((r) => r.queue === 'q1' && r.state !== 'playing'), q2: rows.filter((r) => r.queue === 'q2' && r.state !== 'playing') },
      library: { tracks: lib?.tracks ?? 0, enabled: lib?.enabled ?? 0, playlists: pl?.n ?? 0 },
      schedule: {
        enabled: plan.settings.enabled,
        clock: clock && { id: clock.id, name: clock.name, color: clock.color },
        entry: entry && { id: entry.id, name: entry.name, live: entry.live },
      },
    };
  }

  app.get(
    '/:id/autodj',
    { schema: { tags: ['AutoDJ'], summary: 'AutoDJ settings, player state, the track on air and both queues', params: stationParams, response: { 200: autodjOut } } },
    async (req) => {
      const { station } = await stationAccess(ctx, req, req.params.id, 'dj');
      return describe(station);
    },
  );

  app.put(
    '/:id/autodj',
    {
      config: { audit: 'autodj.update' },
      schema: {
        tags: ['AutoDJ'],
        summary: 'Change the AutoDJ settings (managers). Crossfade, loudness and mount changes restart the player.',
        params: stationParams,
        body: autodjSchema,
        response: { 200: autodjOut },
      },
    },
    async (req) => {
      const { station } = await radio(req, req.params.id, 'manager');
      if (req.body.mountId) {
        const [m] = await ctx.db.select().from(schema.stationMounts).where(and(eq(schema.stationMounts.id, req.body.mountId), eq(schema.stationMounts.stationId, station.id)));
        if (!m || m.kind !== 'source') throw badRequest('The AutoDJ needs a source mount of this station');
      }
      if (req.body.enabled && !req.body.mountId) throw badRequest('Choose the mount the AutoDJ feeds');
      const [row] = await ctx.db.update(schema.stations).set({ autodj: req.body, updatedAt: new Date() }).where(eq(schema.stations.id, station.id)).returning();
      req.auditInfo.details = { enabled: req.body.enabled, rule: req.body.rule };
      await apply(req, station.id);
      await fillQueues(ctx, station.id, true).catch(() => undefined);
      return describe(row!);
    },
  );

  /**
   * A locked item of the format is on air: DJs cannot skip it or play something over it; managers and owners only with
   * `force` (the client asks first).
   */
  async function guardLocked(stationId: string, role: string, force: boolean | undefined) {
    const [onAir] = await ctx.db
      .select({ locked: schema.queueItems.locked, label: schema.queueItems.label })
      .from(schema.queueItems)
      .where(and(eq(schema.queueItems.stationId, stationId), eq(schema.queueItems.state, 'playing')));
    if (!onAir?.locked) return;
    const what = onAir.label ? `"${onAir.label}" is a locked part of the format` : 'A locked part of the format is on air';
    if (role === 'dj') throw forbidden(`${what}: it cannot be skipped or interrupted`);
    if (!force) throw new HttpError(409, 'locked', `${what}. Skip it anyway?`);
  }

  app.post(
    '/:id/autodj/skip',
    {
      config: { audit: 'autodj.skip' },
      schema: {
        tags: ['AutoDJ'],
        summary: 'Skip the track on air (DJs too, unless a locked item of the format plays: then managers with force)',
        params: stationParams,
        // Older clients send no body.
        body: z.object({ force: z.boolean().optional() }).nullish(),
        response: { 200: okOut },
      },
    },
    async (req) => {
      const { station, access } = await radio(req, req.params.id, 'dj');
      await guardLocked(station.id, access.role, req.body?.force);
      await ctx.db.execute(sql`select pg_notify(${AUTODJ_CHANNEL}, ${JSON.stringify({ stationId: station.id, command: 'skip' })})`);
      return { ok: true as const };
    },
  );

  app.post(
    '/:id/autodj/play-now',
    {
      config: { audit: 'autodj.playNow' },
      schema: {
        tags: ['AutoDJ'],
        summary: 'Play a waiting track (itemId) or a library track (mediaId) now: the track on air fades out (DJs too)',
        params: stationParams,
        body: z.union([z.object({ itemId: z.uuid(), force: z.boolean().optional() }), z.object({ mediaId: z.uuid(), force: z.boolean().optional() })]),
        response: { 200: autodjOut },
      },
    },
    async (req) => {
      const { station, access } = await radio(req, req.params.id, 'dj');
      await guardLocked(station.id, access.role, req.body.force);
      const { force: _, ...what } = req.body;
      const itemId = await playNow(ctx, station.id, what, access.user.name);
      await ctx.db.execute(sql`select pg_notify(${AUTODJ_CHANNEL}, ${JSON.stringify({ stationId: station.id, command: 'playnow', itemId })})`);
      return describe(station);
    },
  );

  app.post(
    '/:id/autodj/mode',
    {
      schema: {
        tags: ['AutoDJ'],
        summary:
          'Manual or automatic playout (DJs too). Manual: after each track the player waits for Play. The client sends `manual: true` again every 10 seconds; without it the station goes back to Auto after 30 seconds, so it never stays silent.',
        params: stationParams,
        body: z.object({ manual: z.boolean() }),
        response: { 200: autodjOut },
      },
    },
    async (req) => {
      const { station, access } = await radio(req, req.params.id, 'dj');
      const [before] = await ctx.db.select().from(schema.autodjState).where(eq(schema.autodjState.stationId, station.id));
      const was = !!before?.manualUntil && before.manualUntil.getTime() > Date.now();
      const manualUntil = req.body.manual ? new Date(Date.now() + MANUAL_GRACE_MS) : null;
      await ctx.db.insert(schema.autodjState).values({ stationId: station.id, manualUntil }).onConflictDoUpdate({ target: schema.autodjState.stationId, set: { manualUntil } });
      if (was !== req.body.manual) {
        req.log.info({ station: station.slug, manual: req.body.manual, by: access.user.email }, 'playout mode changed');
        await ctx.db.execute(sql`select pg_notify(${AUTODJ_CHANNEL}, ${JSON.stringify({ stationId: station.id, command: 'mode' })})`);
      }
      return describe(station);
    },
  );

  for (const [command, summary] of [
    ['play', 'Manual playout: start the next track (DJs too). While a track plays, the next one starts when it ends.'],
    ['stop', 'Manual playout: stop the track on air; the player waits for Play (DJs too).'],
  ] as const) {
    app.post(
      `/:id/autodj/${command}`,
      { schema: { tags: ['AutoDJ'], summary, params: stationParams, response: { 200: okOut } } },
      async (req) => {
        const { station } = await radio(req, req.params.id, 'dj');
        await ctx.db.execute(sql`select pg_notify(${AUTODJ_CHANNEL}, ${JSON.stringify({ stationId: station.id, command })})`);
        return { ok: true as const };
      },
    );
  }

  app.put(
    '/:id/queue-rule',
    {
      config: { audit: 'autodj.rule' },
      schema: {
        tags: ['AutoDJ'],
        summary: 'Kept for RHIS Studio before 0.13: how Q1 and Q2 took turns. No effect since 1.3, which has one queue.',
        deprecated: true,
        params: stationParams,
        body: queueRuleSchema,
        response: { 200: autodjOut },
      },
    },
    async (req) => {
      const { station } = await radio(req, req.params.id, 'dj');
      const settings = { ...autodjSettings(station), rule: req.body };
      const [row] = await ctx.db.update(schema.stations).set({ autodj: settings, updatedAt: new Date() }).where(eq(schema.stations.id, station.id)).returning();
      req.auditInfo.details = { rule: req.body };
      await apply(req, station.id);
      return describe(row!);
    },
  );

  app.get(
    '/:id/autodj/history',
    {
      schema: {
        tags: ['AutoDJ'],
        summary: 'The tracks the AutoDJ played last, newest first (the track on air is the first one)',
        params: stationParams,
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(50).default(10) }),
        response: {
          200: z.object({
            items: z.array(z.object({ mediaId: z.uuid(), title: z.string(), artist: z.string(), path: z.string(), durationSeconds: z.number().nullable(), playedAt: z.date() })),
          }),
        },
      },
    },
    async (req) => {
      const { station } = await radio(req, req.params.id, 'dj');
      const mf = schema.mediaFiles;
      const rows = await ctx.db
        .select({ mediaId: mf.id, title: mf.title, artist: mf.artist, path: mf.path, durationSeconds: mf.durationSeconds, playedAt: mf.lastPlayedAt })
        .from(mf)
        .where(and(eq(mf.stationId, station.id), isNotNull(mf.lastPlayedAt)))
        .orderBy(desc(mf.lastPlayedAt))
        .limit(req.query.limit);
      return { items: rows.map((r) => ({ ...r, playedAt: r.playedAt! })) };
    },
  );

  app.get(
    '/:id/autodj/rundown',
    {
      schema: {
        tags: ['AutoDJ'],
        summary: 'The format of the coming hours: the items of each hour clock with their planned start, and where the player is now',
        params: stationParams,
        querystring: z.object({ hours: z.coerce.number().int().min(1).max(12).default(3) }),
        response: { 200: rundownOut },
      },
    },
    async (req) => {
      const { station } = await stationAccess(ctx, req, req.params.id, 'dj');
      return rundown(station, req.query.hours);
    },
  );

  async function rundown(station: Station, hours: number): Promise<z.infer<typeof rundownOut>> {
    const plan = await loadSchedule(ctx.db, station);
    const tz = plan.settings.timezone;
    const now = Date.now();
    const HOUR = 3_600_000;
    const [st] = await ctx.db.select().from(schema.autodjState).where(eq(schema.autodjState.stationId, station.id));
    const clocks = [...plan.clocks.values()];
    const playlistIds = new Set(clocks.flatMap((c) => c.items.map((i) => i.playlistId).filter((x): x is string => !!x)));
    const mediaIds = new Set(clocks.flatMap((c) => c.items.map((i) => i.mediaId).filter((x): x is string => !!x)));
    const [lists, tracks] = await Promise.all([
      playlistIds.size
        ? ctx.db.select({ id: schema.playlists.id, name: schema.playlists.name, folders: schema.playlists.folders }).from(schema.playlists).where(inArray(schema.playlists.id, [...playlistIds]))
        : [],
      mediaIds.size
        ? ctx.db
            .select({
              id: schema.mediaFiles.id,
              title: schema.mediaFiles.title,
              artist: schema.mediaFiles.artist,
              path: schema.mediaFiles.path,
              durationSeconds: schema.mediaFiles.durationSeconds,
              cueIn: schema.mediaFiles.cueIn,
              cueSegue: schema.mediaFiles.cueSegue,
              cueOut: schema.mediaFiles.cueOut,
            })
            .from(schema.mediaFiles)
            .where(inArray(schema.mediaFiles.id, [...mediaIds]))
        : [],
    ]);
    const listName = new Map(lists.map((l) => [l.id, l.name]));
    const trackName = new Map(tracks.map((t) => [t.id, t.title ? (t.artist ? `${t.artist} – ${t.title}` : t.title) : t.path]));
    // Until the next item starts: from cue in to the segue or cue out.
    const trackSeconds = new Map(tracks.map((t) => [t.id, playSeconds(t, 0)]));
    // The average track of each playlist the clocks use, for the expected length of its items (backtiming in RHIS Studio).
    const listSeconds = new Map(
      await Promise.all(
        lists.map(async (l) => {
          const [row] = await ctx.db
            .select({
              avg: sql<number | null>`avg(coalesce(${schema.mediaFiles.cueSegue}, ${schema.mediaFiles.cueOut}, ${schema.mediaFiles.durationSeconds}) - coalesce(${schema.mediaFiles.cueIn}, 0))::float`,
            })
            .from(schema.mediaFiles)
            .where(and(eq(schema.mediaFiles.stationId, station.id), eq(schema.mediaFiles.enabled, true), inPlaylist(l)));
          return [l.id, row?.avg ?? null] as const;
        }),
      ),
    );
    const news = newsSettings(station);
    const bulletin = news.enabled ? await readNewsStatus(ctx, station.id) : null;
    const rows: z.infer<typeof rundownRowOut>[] = [];
    const first = hourStart(now, tz);
    for (let h = 0; h < hours; h++) {
      const hour = first + h * HOUR;
      const clock = plan.settings.enabled ? plan.clockAt(hour) : null;
      const entry = plan.settings.enabled ? plan.entryAt(hour) : null;
      const base = {
        hour: new Date(hour),
        clock: clock && { id: clock.id, name: clock.name, color: clock.color },
        show: entry && { id: entry.id, name: entry.name, live: entry.live },
        past: false,
      };
      if (!clock?.items.length) {
        rows.push({ ...base, startsAt: new Date(hour), timed: true, hard: false, locked: false, kind: 'music', source: 'queues', label: '', count: 0, seconds: null, current: false });
        continue;
      }
      let start = hour;
      clock.items.forEach((item, i) => {
        const a = anchorOf(clock.items, i);
        if (a !== null) start = hour + a * 60_000;
        const source = item.kind === 'rotation' ? 'queues' : item.kind;
        const label =
          item.label ||
          (item.kind === 'playlist' ? (listName.get(item.playlistId ?? '') ?? '') : item.kind === 'track' ? (trackName.get(item.mediaId ?? '') ?? '') : item.kind === 'news' ? news.name : '');
        const current = !!st?.clockHour && st.clockHour.getTime() === hour && st.clockId === clock.id && st.clockStep === i;
        const count = item.kind === 'track' || item.kind === 'news' ? 1 : item.count;
        const each =
          item.kind === 'track' ? trackSeconds.get(item.mediaId ?? '') : item.kind === 'playlist' ? listSeconds.get(item.playlistId ?? '') : item.kind === 'news' ? (bulletin?.durationSeconds ?? null) : null;
        const kind = isFill(item) ? 'music' : 'item';
        const seconds = kind === 'item' && each != null ? Math.round(each * count) : null;
        rows.push({ ...base, startsAt: new Date(start), timed: a !== null, hard: item.hard, locked: kind === 'item' && !!item.locked, kind, source, label, count, seconds, current });
      });
    }
    // Rows before the one the player is at are past; without that, the ones a later row has started after.
    const at = rows.findIndex((r) => r.current);
    rows.forEach((r, i) => {
      r.past = at >= 0 ? i < at : rows.slice(i + 1).some((n) => n.timed && n.startsAt.getTime() <= now);
    });
    return { timezone: tz, enabled: plan.settings.enabled, rows };
  }

  app.post(
    '/:id/autodj/queue',
    {
      schema: {
        tags: ['AutoDJ'],
        summary: 'Put a library track in the queue, at the top or the bottom (DJs too)',
        params: stationParams,
        body: z.object({ mediaId: z.uuid(), queue: queueIn, at: z.enum(['top', 'bottom']).default('bottom') }),
        response: { 200: autodjOut },
      },
    },
    async (req) => {
      const { station, access } = await radio(req, req.params.id, 'dj');
      await enqueue(ctx, station.id, req.body.mediaId, req.body.queue, { at: req.body.at, origin: 'manual', addedBy: access.user.name });
      return describe(station);
    },
  );

  app.patch(
    '/:id/autodj/queue/:itemId',
    {
      schema: {
        tags: ['AutoDJ'],
        summary: 'Move a waiting track: to the other queue and/or before another track (null = to the end)',
        params: stationParams.extend({ itemId: z.uuid() }),
        body: z.object({ queue: queueIn, beforeId: z.uuid().nullable().default(null) }),
        response: { 200: autodjOut },
      },
    },
    async (req) => {
      const { station } = await radio(req, req.params.id, 'dj');
      await moveItem(ctx, station.id, req.params.itemId, req.body.queue, req.body.beforeId);
      return describe(station);
    },
  );

  app.delete(
    '/:id/autodj/queue/:itemId',
    {
      schema: { tags: ['AutoDJ'], summary: 'Remove a waiting track from its queue', params: stationParams.extend({ itemId: z.uuid() }), response: { 200: autodjOut } },
    },
    async (req) => {
      const { station } = await radio(req, req.params.id, 'dj');
      const deleted = await ctx.db
        .delete(schema.queueItems)
        .where(and(eq(schema.queueItems.id, req.params.itemId), eq(schema.queueItems.stationId, station.id), eq(schema.queueItems.state, 'queued')))
        .returning();
      if (!deleted.length) throw notFound('Waiting track');
      return describe(station);
    },
  );

  app.post(
    '/:id/autodj/queue/clear',
    {
      schema: {
        tags: ['AutoDJ'],
        summary: 'Empty a queue. `rotationOnly` keeps requests and tracks added by hand; the playlists fill it again.',
        params: stationParams,
        body: z.object({ queue: queueIn, rotationOnly: z.boolean().default(true) }),
        response: { 200: autodjOut },
      },
    },
    async (req) => {
      const { station } = await radio(req, req.params.id, 'dj');
      await clearQueue(ctx, station.id, req.body.queue, req.body.rotationOnly);
      await fillQueues(ctx, station.id);
      return describe(station);
    },
  );

  // Library

  const libraryQuery = z.object({
    q: z.string().trim().max(200).optional(),
    location: z.string().max(64).optional(),
    folder: z.string().max(500).optional(),
    playlistId: z.uuid().optional(),
    enabled: z.enum(['all', 'yes', 'no']).default('all'),
    sort: z.enum(['artist', 'title', 'album', 'added', 'played', 'plays', 'duration', 'path', 'code', 'bpm', 'key']).default('artist'),
    dir: z.enum(['asc', 'desc']).default('asc'),
    offset: z.coerce.number().int().min(0).default(0),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  });

  app.get(
    '/:id/library',
    {
      schema: {
        tags: ['AutoDJ'],
        summary: 'Tracks in the library, searchable and filtered by folder or playlist',
        params: stationParams,
        querystring: libraryQuery,
        response: { 200: z.object({ items: z.array(mediaOut), total: z.number().int() }) },
      },
    },
    async (req) => {
      const { station } = await radio(req, req.params.id, 'dj');
      const q = req.query;
      const mf = schema.mediaFiles;
      // The news bulletin is not part of the library.
      const where: (SQL | undefined)[] = [eq(mf.stationId, station.id), ne(mf.location, NEWS)];
      if (q.q) {
        const like = `%${q.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        where.push(or(ilike(mf.title, like), ilike(mf.artist, like), ilike(mf.album, like), ilike(mf.path, like), ilike(mf.code, like), ilike(mf.isrc, like.replace(/[\s-]/g, ''))));
      }
      if (q.location) where.push(eq(mf.location, q.location));
      if (q.folder) where.push(sql`${mf.path} like ${`${q.folder.replace(/[\\%_]/g, (c) => `\\${c}`)}/%`}`);
      if (q.enabled !== 'all') where.push(eq(mf.enabled, q.enabled === 'yes'));
      const playlists = await ctx.db.select().from(schema.playlists).where(eq(schema.playlists.stationId, station.id));
      if (q.playlistId) {
        const p = playlists.find((x) => x.id === q.playlistId);
        if (!p) throw notFound('Playlist');
        where.push(inPlaylist(p));
      }
      const column = { artist: mf.artist, title: mf.title, album: mf.album, added: mf.createdAt, played: mf.lastPlayedAt, plays: mf.playCount, duration: mf.durationSeconds, path: mf.path, code: mf.code, bpm: mf.bpm, key: mf.musicKey }[q.sort];
      const dir = q.dir === 'asc' ? asc : desc;
      const [items, [total]] = await Promise.all([
        ctx.db
          .select()
          .from(mf)
          .where(and(...where))
          .orderBy(dir(column), asc(mf.title), asc(mf.id))
          .limit(q.limit)
          .offset(q.offset),
        ctx.db.select({ n: count() }).from(mf).where(and(...where)),
      ]);
      const explicit = items.length
        ? await ctx.db
            .select()
            .from(schema.playlistItems)
            .where(inArray(schema.playlistItems.mediaId, items.map((i) => i.id)))
        : [];
      return {
        items: items.map((i) => ({
          ...i,
          playlistIds: playlists
            .filter((p) => explicit.some((e) => e.playlistId === p.id && e.mediaId === i.id) || p.folders.some((f) => f.location === i.location && (!f.path || i.path.startsWith(`${f.path}/`))))
            .map((p) => p.id),
        })),
        total: total?.n ?? 0,
      };
    },
  );

  app.get(
    '/:id/library/folders',
    {
      schema: {
        tags: ['AutoDJ'],
        summary: 'Folders of the library per location, with the number of tracks directly in them',
        params: stationParams,
        response: {
          200: z.object({
            locations: z.array(z.object({ id: z.string(), name: z.string(), type: z.string(), tracks: z.number().int() })),
            folders: z.array(z.object({ location: z.string(), path: z.string(), tracks: z.number().int() })),
          }),
        },
      },
    },
    async (req) => {
      const { station } = await radio(req, req.params.id, 'dj');
      const sources = await sourcesOf(station.id);
      const rows = await ctx.db
        .select({
          location: schema.mediaFiles.location,
          path: sql<string>`case when position('/' in ${schema.mediaFiles.path}) > 0 then regexp_replace(${schema.mediaFiles.path}, '/[^/]*$', '') else '' end`,
          tracks: sql<number>`count(*)::int`,
        })
        .from(schema.mediaFiles)
        .where(eq(schema.mediaFiles.stationId, station.id))
        .groupBy(sql`1`, sql`2`)
        .orderBy(sql`1`, sql`2`);
      const perLocation = new Map<string, number>();
      for (const r of rows) perLocation.set(r.location, (perLocation.get(r.location) ?? 0) + r.tracks);
      return {
        locations: [
          { id: STORAGE, name: 'Station storage', type: 'storage', tracks: perLocation.get(STORAGE) ?? 0 },
          ...[...sources.values()].map((s) => ({ id: s.id, name: s.name, type: s.type, tracks: perLocation.get(s.id) ?? 0 })),
        ],
        folders: rows.filter((r) => r.path !== ''),
      };
    },
  );

  app.get(
    '/:id/library/scan',
    { schema: { tags: ['AutoDJ'], summary: 'Progress of the last library scan', params: stationParams, response: { 200: scanOut } } },
    async (req) => {
      const { station } = await radio(req, req.params.id, 'dj');
      return scanProgress(station.id);
    },
  );

  app.post(
    '/:id/library/scan',
    {
      schema: {
        tags: ['AutoDJ'],
        summary: 'Scan the library now (new, changed and removed files). Runs in the background; poll GET for progress.',
        params: stationParams,
        body: z.object({ location: z.string().max(64).optional() }).default({}),
        response: { 200: scanOut },
      },
    },
    async (req) => {
      const { station } = await radio(req, req.params.id, 'manager');
      void scanLibrary(ctx, station.id, req.body.location).then(() => fillQueues(ctx, station.id)).catch(() => undefined);
      return scanProgress(station.id);
    },
  );

  app.post(
    '/:id/library/upload',
    {
      config: { audit: 'library.upload' },
      schema: {
        tags: ['AutoDJ'],
        summary: `Upload audio files (multipart, field "files") into the station storage, by default the "${MUSIC_FOLDER}" folder. Counts towards the storage limit.`,
        params: stationParams,
        querystring: z.object({ folder: z.string().trim().max(300).optional() }),
        response: { 200: z.object({ saved: z.array(z.string()), skipped: z.array(z.object({ name: z.string(), reason: z.string() })) }) },
      },
    },
    async (req) => {
      const { station, tenant } = await radio(req, req.params.id, 'manager');
      const folder = (req.query.folder ?? MUSIC_FOLDER).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
      if (folder.split('/').some((p) => p === '..' || p.startsWith('.')) || /[\0]/.test(folder)) throw badRequest('Invalid folder');
      if (['ondemand', 'recordings'].includes(folder.split('/')[0]!)) throw badRequest('That folder is not part of the music library');
      const root = mediaDir(ctx, station.id);
      const dir = filePath(root, folder || MUSIC_FOLDER);
      await mkdir(dir, { recursive: true, mode: 0o775 });
      const quota = tenant.limits.storageQuotaMb * 1024 * 1024;
      let used = await tenantStorageUsage(ctx, tenant.id);
      const saved: string[] = [];
      const skipped: { name: string; reason: string }[] = [];
      for await (const part of req.files()) {
        const name = part.filename.split(/[\\/]/).pop()!.replace(/[\0\r\n]/g, '').trim();
        if (!name || name.startsWith('.') || !MEDIA_EXTENSIONS.has(extname(name).toLowerCase())) {
          part.file.resume();
          skipped.push({ name: part.filename, reason: 'not an audio file' });
          continue;
        }
        const target = join(dir, name);
        const tmp = join(dir, `.${name}.upload`);
        await pipeline(part.file, createWriteStream(tmp, { mode: 0o664 }));
        const size = (await stat(tmp)).size;
        if (part.file.truncated) {
          await rm(tmp, { force: true });
          skipped.push({ name, reason: 'larger than 1 GB' });
        } else if (quota > 0 && used + size > quota) {
          await rm(tmp, { force: true });
          skipped.push({ name, reason: 'storage limit reached' });
        } else {
          await rename(tmp, target);
          used += size;
          saved.push(`${folder}/${name}`);
        }
      }
      if (saved.length) void scanStationStorage(ctx, station.id).catch(() => undefined);
      req.auditInfo.details = { files: saved.length, folder };
      if (saved.length) void scanLibrary(ctx, station.id, STORAGE).then(() => fillQueues(ctx, station.id)).catch(() => undefined);
      return { saved, skipped };
    },
  );

  // Uploads in parts (1.4): one file in pieces of at most UPLOAD_PART bytes, so a big file (a DJ set) gets through a
  // proxy with a body limit (Cloudflare: 100 MB), shows its progress and picks up where it stopped after a broken
  // connection. A folder upload sends every file with its path below the chosen folder.
  const uploadOut = z.object({ id: z.string(), offset: z.number(), size: z.number(), done: z.boolean(), path: z.string() });
  const uploadTarget = (folder: string, path: string) => {
    const clean = (s: string) => s.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    const parts = [...clean(folder || MUSIC_FOLDER).split('/'), ...clean(path).split('/')].filter(Boolean);
    if (parts.length < 2 || parts.some((p) => p === '..' || p.startsWith('.') || /[\0\r\n]/.test(p) || p.length > 255)) throw badRequest('Invalid folder or file name');
    if (['ondemand', 'recordings'].includes(parts[0]!)) throw badRequest('That folder is not part of the music library');
    const name = parts.at(-1)!;
    if (!MEDIA_EXTENSIONS.has(extname(name).toLowerCase())) throw badRequest(`${name}: not an audio file`);
    return { rel: parts.join('/'), name };
  };
  const uploadFile = (stationId: string, rel: string, size: number) => {
    const target = filePath(mediaDir(ctx, stationId), rel);
    const id = createHash('sha256').update(`${stationId}:${rel}:${size}`).digest('base64url').slice(0, 24);
    // Hidden next to the target, so the scanner skips it; the same file and size always find the same part file.
    return { id, target, tmp: join(dirname(target), `.${id}.upload`) };
  };
  const partSize = async (f: string) => (await stat(f).catch(() => null))?.size ?? 0;
  const scheduleScan = (stationId: string) => {
    clearTimeout(scanTimers.get(stationId));
    const timer = setTimeout(() => {
      scanTimers.delete(stationId);
      void scanLibrary(ctx, stationId, STORAGE)
        .then(() => fillQueues(ctx, stationId))
        .catch(() => undefined);
    }, 5000);
    timer.unref();
    scanTimers.set(stationId, timer);
  };

  app.post(
    '/:id/library/uploads',
    {
      config: { audit: 'library.upload' },
      schema: {
        tags: ['AutoDJ'],
        summary: `Start or resume an upload in parts: returns how much of the file is already here. Then send the rest with PUT …/uploads/:upload in parts of at most ${UPLOAD_PART / 1024 / 1024} MB.`,
        params: stationParams,
        body: z.object({ folder: z.string().trim().max(300).default(MUSIC_FOLDER), path: z.string().trim().min(1).max(600), size: z.number().int().min(1).max(UPLOAD_MAX) }),
        response: { 200: uploadOut },
      },
    },
    async (req) => {
      const { station, tenant } = await radio(req, req.params.id, 'manager');
      const { rel } = uploadTarget(req.body.folder, req.body.path);
      const f = uploadFile(station.id, rel, req.body.size);
      await mkdir(dirname(f.tmp), { recursive: true, mode: 0o775 });
      // Parts nobody came back for in two days are left-overs.
      for (const e of await readdir(dirname(f.tmp)).catch(() => [] as string[])) {
        if (!e.endsWith('.upload') || !e.startsWith('.')) continue;
        const p = join(dirname(f.tmp), e);
        const s = await stat(p).catch(() => null);
        if (s && Date.now() - s.mtimeMs > 2 * 86_400_000) await rm(p, { force: true });
      }
      const offset = await partSize(f.tmp);
      const quota = tenant.limits.storageQuotaMb * 1024 * 1024;
      if (quota > 0 && (await tenantStorageUsage(ctx, tenant.id)) + req.body.size - offset > quota) throw new HttpError(413, 'storage_full', 'Storage limit reached');
      req.auditInfo.details = { path: rel, size: req.body.size, offset };
      uploads.set(f.id, { stationId: station.id, rel, size: req.body.size });
      return { id: f.id, offset, size: req.body.size, done: false, path: rel };
    },
  );

  app.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload));
  app.put(
    '/:id/library/uploads/:upload',
    {
      bodyLimit: UPLOAD_PART + 1024,
      schema: {
        tags: ['AutoDJ'],
        summary: 'Send the next part of an upload (application/octet-stream) at the offset the server has; the last part puts the file in the library',
        params: stationParams.extend({ upload: z.string().regex(/^[A-Za-z0-9_-]{24}$/) }),
        querystring: z.object({ offset: z.coerce.number().int().min(0) }),
        response: { 200: uploadOut },
      },
    },
    async (req) => {
      const { station } = await radio(req, req.params.id, 'manager');
      const u = uploads.get(req.params.upload);
      if (!u || u.stationId !== station.id) throw notFound('Upload not found: start it again');
      const f = uploadFile(station.id, u.rel, u.size);
      const have = await partSize(f.tmp);
      // A part that arrived twice or got lost: the client goes on from what is here.
      if (req.query.offset !== have) throw new HttpError(409, 'offset_mismatch', `The server has ${have} bytes of this file`);
      // The body arrives as a stream, so Fastify's own limit does not count it.
      if (Number(req.headers['content-length'] ?? 0) > UPLOAD_PART) throw new HttpError(413, 'part_too_large', `Send at most ${UPLOAD_PART / 1024 / 1024} MB per part`);
      const body = req.body as NodeJS.ReadableStream;
      await pipeline(body, createWriteStream(f.tmp, { flags: 'a', mode: 0o664 }));
      const offset = await partSize(f.tmp);
      if (offset > u.size) {
        await rm(f.tmp, { force: true });
        uploads.delete(req.params.upload);
        throw badRequest('More data than the file size');
      }
      if (offset < u.size) return { id: req.params.upload, offset, size: u.size, done: false, path: u.rel };
      await rename(f.tmp, f.target);
      uploads.delete(req.params.upload);
      void scanStationStorage(ctx, station.id).catch(() => undefined);
      scheduleScan(station.id);
      return { id: req.params.upload, offset, size: u.size, done: true, path: u.rel };
    },
  );

  app.patch(
    '/:id/library/:mediaId',
    {
      config: { audit: 'library.update' },
      schema: {
        tags: ['AutoDJ'],
        summary: 'Correct the tags of a track (kept when the file is scanned again) or switch it off for the AutoDJ',
        params: stationParams.extend({ mediaId: z.uuid() }),
        body: z.object({
          title: z.string().trim().min(1).max(300).optional(),
          artist: z.string().trim().max(300).optional(),
          album: z.string().trim().max(300).optional(),
          genre: z.string().trim().max(100).optional(),
          year: z.number().int().min(1000).max(2999).nullable().optional(),
          /** With or without dashes; empty clears it. */
          isrc: z.string().trim().max(20).optional(),
          bpm: z.number().min(40).max(250).nullable().optional(),
          /** "Am", "A minor", "8A" (Camelot) and the like; empty clears it. */
          musicKey: z.string().trim().max(20).optional(),
          enabled: z.boolean().optional(),
          /** All five cue points at once; null clears one. */
          cues: z.object({ cueIn: cueSecond, cueIntro: cueSecond, cueSegue: cueSecond, cueFadeOut: cueSecond, cueOut: cueSecond }).optional(),
        }),
        response: { 200: mediaOut },
      },
    },
    async (req) => {
      const { station } = await radio(req, req.params.id, 'manager');
      const { enabled, cues, isrc, musicKey, bpm, ...rest } = req.body;
      const tags: Partial<typeof schema.mediaFiles.$inferInsert> = { ...rest };
      if (isrc !== undefined) {
        tags.isrc = normaliseIsrc(isrc);
        if (isrc && !tags.isrc) throw badRequest('That is not an ISRC (two letters, three letters or digits, seven digits)');
      }
      if (musicKey !== undefined) {
        tags.musicKey = normaliseKey(musicKey);
        if (musicKey && !tags.musicKey) throw badRequest('Unknown key: use for example Am, F#, Bb minor or 8A');
      }
      if (bpm !== undefined) tags.bpm = bpm === null ? null : Math.round(bpm * 10) / 10;
      const tagged = Object.values(tags).some((v) => v !== undefined);
      if (cues) {
        const [m] = await ctx.db
          .select({ durationSeconds: schema.mediaFiles.durationSeconds })
          .from(schema.mediaFiles)
          .where(and(eq(schema.mediaFiles.id, req.params.mediaId), eq(schema.mediaFiles.stationId, station.id)));
        if (!m) throw notFound('Track');
        const problem = cueProblem(cues, m.durationSeconds);
        if (problem) throw badRequest(problem);
      }
      const [row] = await ctx.db
        .update(schema.mediaFiles)
        .set({ ...tags, ...cues, ...(enabled !== undefined ? { enabled } : {}), ...(tagged ? { edited: true } : {}), updatedAt: new Date() })
        .where(and(eq(schema.mediaFiles.id, req.params.mediaId), eq(schema.mediaFiles.stationId, station.id)))
        .returning();
      if (!row) throw notFound('Track');
      if (enabled === false) await dropDisabled(ctx, station.id, [row.id]);
      return { ...row, playlistIds: [] };
    },
  );

  app.post(
    '/:id/library/bulk',
    {
      config: { audit: 'library.bulk' },
      schema: {
        tags: ['AutoDJ'],
        summary: 'Act on several tracks: switch on or off, add to or remove from a playlist, or delete (files in the station storage only)',
        params: stationParams,
        body: z.object({
          ids: z.array(z.uuid()).min(1).max(1000),
          action: z.enum(['enable', 'disable', 'add', 'remove', 'delete']),
          playlistId: z.uuid().optional(),
        }),
        response: { 200: z.object({ changed: z.number().int(), skipped: z.number().int() }) },
      },
    },
    async (req) => {
      const { station } = await radio(req, req.params.id, 'manager');
      const { ids, action, playlistId } = req.body;
      const rows = await ctx.db.select().from(schema.mediaFiles).where(and(eq(schema.mediaFiles.stationId, station.id), inArray(schema.mediaFiles.id, ids)));
      const found = rows.map((r) => r.id);
      req.auditInfo.details = { action, tracks: found.length, playlistId };
      if (action === 'enable' || action === 'disable') {
        if (found.length) await ctx.db.update(schema.mediaFiles).set({ enabled: action === 'enable', updatedAt: new Date() }).where(inArray(schema.mediaFiles.id, found));
        if (action === 'disable') await dropDisabled(ctx, station.id, found);
        return { changed: found.length, skipped: ids.length - found.length };
      }
      if (action === 'add' || action === 'remove') {
        const [p] = playlistId ? await ctx.db.select().from(schema.playlists).where(and(eq(schema.playlists.id, playlistId), eq(schema.playlists.stationId, station.id))) : [];
        if (!p) throw badRequest('Choose a playlist of this station');
        if (action === 'add' && found.length) {
          await ctx.db.insert(schema.playlistItems).values(found.map((mediaId) => ({ playlistId: p.id, mediaId }))).onConflictDoNothing();
        } else if (found.length) {
          await ctx.db.delete(schema.playlistItems).where(and(eq(schema.playlistItems.playlistId, p.id), inArray(schema.playlistItems.mediaId, found)));
        }
        return { changed: found.length, skipped: ids.length - found.length };
      }
      // Delete: only files this server stores; shares and server folders are read-only.
      const own = rows.filter((r) => r.location === STORAGE);
      const root = mediaDir(ctx, station.id);
      for (const r of own) await rm(filePath(root, r.path), { force: true }).catch(() => undefined);
      if (own.length) await ctx.db.delete(schema.mediaFiles).where(inArray(schema.mediaFiles.id, own.map((r) => r.id)));
      return { changed: own.length, skipped: ids.length - own.length };
    },
  );

  app.get(
    '/:id/library/:mediaId/audio',
    { schema: { tags: ['AutoDJ'], summary: 'Listen to a library track in the panel', params: stationParams.extend({ mediaId: z.uuid() }) } },
    async (req, reply) => {
      const { station } = await radio(req, req.params.id, 'dj');
      const [media] = await ctx.db.select().from(schema.mediaFiles).where(and(eq(schema.mediaFiles.id, req.params.mediaId), eq(schema.mediaFiles.stationId, station.id)));
      if (!media) throw notFound('Track');
      const full = mediaPath(ctx, media, await sourcesOf(station.id));
      if (!full) throw notFound('File');
      return sendFile(reply, full, contentType(media.path), req.headers.range, 'private, no-store');
    },
  );

  // Playlists

  async function playlistsOut(stationId: string) {
    const lists = await ctx.db.select().from(schema.playlists).where(eq(schema.playlists.stationId, stationId)).orderBy(asc(schema.playlists.queue), asc(schema.playlists.name));
    const counts = await Promise.all(
      lists.map((p) =>
        ctx.db
          .select({ n: count(), avg: sql<number | null>`avg(${schema.mediaFiles.durationSeconds})::float8` })
          .from(schema.mediaFiles)
          .where(and(eq(schema.mediaFiles.stationId, stationId), inPlaylist(p)))
          .then((r) => r[0] ?? { n: 0, avg: null }),
      ),
    );
    return lists.map((p, i) => ({
      id: p.id,
      name: p.name,
      queue: p.queue,
      weight: p.weight,
      order: p.order,
      folders: p.folders,
      enabled: p.enabled,
      rotation: p.rotation,
      trackCount: counts[i]!.n,
      averageSeconds: counts[i]!.avg,
      createdAt: p.createdAt,
    }));
  }

  async function checkFolders(stationId: string, folders: { location: string; path: string }[]) {
    const sources = await sourcesOf(stationId);
    return folders.map((f) => {
      checkLocation(f.location, sources);
      const path = f.path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
      if (path.split('/').some((p) => p === '..')) throw badRequest('Invalid folder');
      return { location: f.location, path };
    });
  }

  app.get(
    '/:id/playlists',
    { schema: { tags: ['AutoDJ'], summary: 'Playlists of the AutoDJ with the queue they feed and their number of tracks', params: stationParams, response: { 200: z.array(playlistOut) } } },
    async (req) => {
      const { station } = await radio(req, req.params.id, 'dj');
      return playlistsOut(station.id);
    },
  );

  app.post(
    '/:id/playlists',
    {
      config: { audit: 'playlist.create' },
      schema: { tags: ['AutoDJ'], summary: 'Add a playlist (managers)', params: stationParams, body: playlistBody, response: { 201: playlistOut } },
    },
    async (req, reply) => {
      const { station } = await radio(req, req.params.id, 'manager');
      const folders = await checkFolders(station.id, req.body.folders);
      const [p] = await ctx.db.insert(schema.playlists).values({ ...req.body, folders, stationId: station.id }).returning();
      Object.assign(req.auditInfo, { targetType: 'playlist', targetId: p!.id, details: { name: p!.name } });
      await fillQueues(ctx, station.id, true).catch(() => undefined);
      reply.status(201);
      return (await playlistsOut(station.id)).find((x) => x.id === p!.id)!;
    },
  );

  app.put(
    '/:id/playlists/:playlistId',
    {
      config: { audit: 'playlist.update' },
      schema: { tags: ['AutoDJ'], summary: 'Change a playlist', params: stationParams.extend({ playlistId: z.uuid() }), body: playlistBody, response: { 200: playlistOut } },
    },
    async (req) => {
      const { station } = await radio(req, req.params.id, 'manager');
      const folders = await checkFolders(station.id, req.body.folders);
      const [p] = await ctx.db
        .update(schema.playlists)
        .set({ ...req.body, folders })
        .where(and(eq(schema.playlists.id, req.params.playlistId), eq(schema.playlists.stationId, station.id)))
        .returning();
      if (!p) throw notFound('Playlist');
      Object.assign(req.auditInfo, { targetType: 'playlist', targetId: p.id, details: { name: p.name } });
      await fillQueues(ctx, station.id, true).catch(() => undefined);
      return (await playlistsOut(station.id)).find((x) => x.id === p.id)!;
    },
  );

  app.delete(
    '/:id/playlists/:playlistId',
    {
      config: { audit: 'playlist.delete' },
      schema: { tags: ['AutoDJ'], summary: 'Remove a playlist (its tracks stay in the library)', params: stationParams.extend({ playlistId: z.uuid() }), response: { 200: okOut } },
    },
    async (req) => {
      const { station } = await radio(req, req.params.id, 'manager');
      const deleted = await ctx.db.delete(schema.playlists).where(and(eq(schema.playlists.id, req.params.playlistId), eq(schema.playlists.stationId, station.id))).returning();
      if (!deleted.length) throw notFound('Playlist');
      Object.assign(req.auditInfo, { targetType: 'playlist', details: { name: deleted[0]!.name } });
      await fillQueues(ctx, station.id, true).catch(() => undefined);
      return { ok: true as const };
    },
  );

  // Library sources (shares)

  const toSourceOut = (s: MediaSource): z.infer<typeof sourceOut> => ({
    id: s.id,
    name: s.name,
    type: s.type,
    enabled: s.enabled,
    config: { ...s.config, password: s.config.password ? SECRET_MASK : undefined } as z.infer<typeof sourceOut>['config'],
    status: s.status ?? null,
    fileCount: s.fileCount,
    scannedAt: s.scannedAt,
  });

  async function sourceValues(req: FastifyRequest, body: z.infer<typeof sourceBody>, current?: MediaSource): Promise<MediaSourceConfig> {
    const c = body.config;
    if (body.type === 'local') {
      if (!req.auth?.user.isSuperadmin || req.auth.keyTenantId) throw forbidden('Only administrators can add folders of this server');
      if (!c.path || !c.path.startsWith('/') || c.path.split('/').includes('..')) throw badRequest('Enter the full path of the folder, e.g. /mnt/music');
      const st = await stat(c.path).catch(() => null);
      if (!st?.isDirectory()) throw badRequest(`${c.path} is not a folder on this server`);
      return { path: c.path.replace(/\/+$/, '') || '/' };
    }
    if (!c.host) throw badRequest('Enter the host name or address of the file server');
    if (body.type === 'smb') {
      if (!c.share) throw badRequest('Enter the share name');
      const password = c.password === SECRET_MASK ? current?.config.password : c.password ? ctx.box.encrypt(c.password) : undefined;
      return { host: c.host, share: c.share, username: c.username || undefined, password: c.username ? password : undefined, domain: c.domain || undefined, version: c.version || undefined };
    }
    if (!c.export) throw badRequest('Enter the exported path, e.g. /export/music');
    return { host: c.host, export: c.export, version: c.version || undefined };
  }

  app.get(
    '/:id/sources',
    { schema: { tags: ['AutoDJ'], summary: 'Music collections outside the station storage: server folders and SMB/NFS shares', params: stationParams, response: { 200: z.array(sourceOut) } } },
    async (req) => {
      const { station } = await radio(req, req.params.id, 'dj');
      return (await refreshSourceStatus(ctx, station.id)).map(toSourceOut);
    },
  );

  app.post(
    '/:id/sources',
    {
      config: { audit: 'library_source.create' },
      schema: {
        tags: ['AutoDJ'],
        summary: `Add a share (SMB or NFS, mounted read-only) or a server folder (administrators). Files are indexed in place. Secrets are masked as "${SECRET_MASK}".`,
        params: stationParams,
        body: sourceBody,
        response: { 201: sourceOut },
      },
    },
    async (req, reply) => {
      const { station } = await radio(req, req.params.id, 'manager');
      const config = await sourceValues(req, req.body);
      const [s] = await ctx.db
        .insert(schema.mediaSources)
        .values({ stationId: station.id, name: req.body.name, type: req.body.type, enabled: req.body.enabled, config, status: { state: 'pending' } })
        .returning();
      Object.assign(req.auditInfo, { targetType: 'library_source', targetId: s!.id, details: { name: s!.name, type: s!.type, host: config.host } });
      await apply(req, station.id);
      // Shares are mounted by the system helper in the background; scan once it is likely done.
      setTimeout(() => void scanLibrary(ctx, station.id, s!.id).catch(() => undefined), s!.type === 'local' ? 0 : 8000).unref();
      reply.status(201);
      return toSourceOut(s!);
    },
  );

  app.put(
    '/:id/sources/:sourceId',
    {
      config: { audit: 'library_source.update' },
      schema: { tags: ['AutoDJ'], summary: 'Change a share or server folder', params: stationParams.extend({ sourceId: z.uuid() }), body: sourceBody, response: { 200: sourceOut } },
    },
    async (req) => {
      const { station } = await radio(req, req.params.id, 'manager');
      const [current] = await ctx.db.select().from(schema.mediaSources).where(and(eq(schema.mediaSources.id, req.params.sourceId), eq(schema.mediaSources.stationId, station.id)));
      if (!current) throw notFound('Source');
      if (current.type !== req.body.type) throw badRequest('The type of a source cannot change');
      const config = await sourceValues(req, req.body, current);
      const [s] = await ctx.db
        .update(schema.mediaSources)
        .set({ name: req.body.name, enabled: req.body.enabled, config, status: { state: 'pending' } })
        .where(eq(schema.mediaSources.id, current.id))
        .returning();
      Object.assign(req.auditInfo, { targetType: 'library_source', targetId: s!.id, details: { name: s!.name } });
      await apply(req, station.id);
      setTimeout(() => void scanLibrary(ctx, station.id, s!.id).catch(() => undefined), s!.type === 'local' ? 0 : 8000).unref();
      return toSourceOut(s!);
    },
  );

  app.delete(
    '/:id/sources/:sourceId',
    {
      config: { audit: 'library_source.delete' },
      schema: {
        tags: ['AutoDJ'],
        summary: 'Remove a share or server folder from the library (the files themselves are not touched)',
        params: stationParams.extend({ sourceId: z.uuid() }),
        response: { 200: okOut },
      },
    },
    async (req) => {
      const { station } = await radio(req, req.params.id, 'manager');
      const deleted = await ctx.db.delete(schema.mediaSources).where(and(eq(schema.mediaSources.id, req.params.sourceId), eq(schema.mediaSources.stationId, station.id))).returning();
      if (!deleted.length) throw notFound('Source');
      // Playlist folders in this location point nowhere now.
      const lists = await ctx.db.select().from(schema.playlists).where(eq(schema.playlists.stationId, station.id));
      for (const p of lists) {
        if (p.folders.some((f) => f.location === deleted[0]!.id)) {
          await ctx.db.update(schema.playlists).set({ folders: p.folders.filter((f) => f.location !== deleted[0]!.id) }).where(eq(schema.playlists.id, p.id));
        }
      }
      Object.assign(req.auditInfo, { targetType: 'library_source', details: { name: deleted[0]!.name } });
      await apply(req, station.id);
      return { ok: true as const };
    },
  );
};
