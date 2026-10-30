import { PassThrough } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { and, asc, eq, gte, inArray, isNotNull, isNull, lt, or, gt, sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { schema } from '../db/index.js';
import { requireUser } from '../lib/auth.js';
import { badRequest, notFound } from '../lib/errors.js';
import { serves } from '../services/nodes/dedication.js';
import type { RecordingPart } from '../services/nodes/hub.js';
import { nodeSettings } from '../services/nodes/plan.js';
import { authenticateNode } from '../services/nodes/report.js';
import { publicSettings } from '../services/public/settings.js';
import { recordedStations } from '../services/recorder/plan.js';
import { LOGGING_BITRATES, recordingPatch, recordingSchema, stationRecording } from '../services/recorder/settings.js';
import { stationAccess } from './stations.js';

/** The most one request asks of a recorder: a player seeks in parts this size, a download is fetched part by part. */
export const RECORDING_PART = 8 * 1024 * 1024;

const params = z.object({ id: z.uuid() });
const recParams = z.object({ id: z.uuid(), rid: z.uuid() });

const recorderOut = z.object({
  id: z.uuid(),
  name: z.string(),
  location: z.string(),
  online: z.boolean(),
  /** The customer's own node. */
  own: z.boolean(),
  /** What it does with this station now; null = it does not report it (offline, or logging is off). */
  state: z.enum(['starting', 'recording', 'waiting', 'error']).nullable(),
  message: z.string().nullable(),
  /** It records a live show of this station right now. */
  recordingShow: z.boolean(),
  disk: z.object({ totalBytes: z.number(), freeBytes: z.number(), usedBytes: z.number() }).nullable(),
});
const recordingOut = z.object({
  settings: recordingSchema,
  /** Recorder nodes that record this station. Without one nothing is logged. */
  recorders: z.array(recorderOut),
  bitrates: z.array(z.number()),
  canEdit: z.boolean(),
  /** Public page settings that matter here: on-demand is on, and live broadcasts are also recorded on the server (phase 5). */
  onDemandPage: z.boolean(),
  serverRecordsLive: z.boolean(),
});
const fileOut = z.object({
  id: z.uuid(),
  nodeId: z.uuid(),
  nodeName: z.string(),
  kind: z.enum(['log', 'show']),
  /** A show: who was live (the DJ account or the studio). */
  dj: z.string().nullable(),
  startedAt: z.date(),
  durationSeconds: z.number(),
  sizeBytes: z.number(),
  open: z.boolean(),
  /** The recorder is online, so the file can be played or downloaded now. */
  available: z.boolean(),
  /** Uploads to the station's destinations (step 3): done, failing (tried again later) and the newest error. */
  uploads: z.object({ done: z.number(), failed: z.number(), error: z.string().nullable() }),
  /** A show that became an on-demand item. */
  onDemand: z.boolean(),
});
const songOut = z.object({
  /** song = a title in the stream; live = a DJ went live here (also when the encoder sends no titles). */
  kind: z.enum(['song', 'live']),
  title: z.string(),
  startedAt: z.date(),
  endedAt: z.date().nullable(),
  /** Seconds from the start of the recording. */
  offsetSeconds: z.number(),
  /** A DJ was live (an encoder on air) when the song started; otherwise the AutoDJ played it. */
  live: z.boolean(),
  dj: z.string().nullable(),
});

/** "bytes=0-" or "bytes=100-199" → the first range, or null when there is none or it is not one we understand. */
export function parseRange(header: string | undefined): { start: number; end: number | null } | null {
  const m = header?.match(/^bytes=(\d*)-(\d*)$/);
  if (!m || (!m[1] && !m[2])) return null;
  if (!m[1]) return null;
  const start = Number(m[1]);
  const end = m[2] ? Number(m[2]) + 1 : null;
  return end !== null && end <= start ? null : { start, end };
}

/**
 * Recordings of a station (phase 21): what recorder nodes record of it, the files they have, and listening back or
 * downloading them. The audio stays on the recorder; it is fetched from there when asked for. Mounted under
 * /api/stations.
 */
export const stationRecordingRoutes: FastifyPluginAsyncZod = async (app) => {
  const { ctx } = app;
  const hub = app.nodes;

  async function recordersOf(station: typeof schema.stations.$inferSelect) {
    const rows = await ctx.db.select().from(schema.nodes).where(and(isNotNull(schema.nodes.pairedAt), sql`'recorder' = any(${schema.nodes.roles})`)).orderBy(asc(schema.nodes.name));
    return rows.filter((n) => serves(n, station) && recordedStations(nodeSettings(n), [station]).length > 0);
  }

  app.get(
    '/:id/recording',
    { schema: { tags: ['Recordings'], summary: 'What recorder nodes record of the station, and its logging settings', params, response: { 200: recordingOut } } },
    async (req) => {
      const { station, tenant, access } = await stationAccess(ctx, req, req.params.id, 'manager');
      const auth = requireUser(req);
      const superadmin = auth.user.isSuperadmin && !auth.keyTenantId;
      const recorders = (await recordersOf(station)).map((n) => {
        const status = hub.liveStatus(n.id);
        const mine = status?.recorder?.stations.filter((s) => s.stationId === station.id) ?? [];
        const log = mine.find((s) => s.kind === 'log');
        return {
          id: n.id,
          name: n.name,
          location: n.location,
          online: !!status,
          own: n.tenantId === tenant.id,
          state: log?.state ?? null,
          message: log?.message ?? null,
          recordingShow: mine.some((s) => s.kind === 'show' && s.state === 'recording'),
          disk: status?.recorder?.disk ?? null,
        };
      });
      const pub = publicSettings(station);
      return {
        settings: stationRecording(station),
        recorders,
        bitrates: [...LOGGING_BITRATES],
        canEdit: superadmin || access.role === 'owner' || access.role === 'manager',
        onDemandPage: pub.onDemand.enabled,
        serverRecordsLive: pub.recording.enabled,
      };
    },
  );

  app.put(
    '/:id/recording',
    {
      config: { audit: 'station.recording' },
      schema: { tags: ['Recordings'], summary: 'Change the logging settings of the station: on or off, bitrate and how many days to keep', params, body: recordingPatch, response: { 200: recordingSchema } },
    },
    async (req) => {
      const { station } = await stationAccess(ctx, req, req.params.id, 'manager');
      const next = recordingSchema.parse({ ...stationRecording(station), ...req.body });
      await ctx.db.update(schema.stations).set({ recording: next, updatedAt: new Date() }).where(eq(schema.stations.id, station.id));
      // The recorders of the station get a new plan.
      void hub.refreshAll();
      return next;
    },
  );

  app.get(
    '/:id/recordings',
    {
      schema: {
        tags: ['Recordings'],
        summary: 'Files on the recorder nodes of the station between two moments (default: the last 24 hours)',
        params,
        querystring: z.object({ from: z.iso.datetime().optional(), to: z.iso.datetime().optional(), kind: z.enum(['log', 'show']).default('log') }),
        response: { 200: z.array(fileOut) },
      },
    },
    async (req) => {
      const { station } = await stationAccess(ctx, req, req.params.id, 'manager');
      const to = req.query.to ? new Date(req.query.to) : new Date();
      const from = req.query.from ? new Date(req.query.from) : new Date(to.getTime() - 86400_000);
      if (to.getTime() - from.getTime() > 32 * 86400_000) throw badRequest('Ask for at most 32 days at a time');
      const r = schema.recordings;
      const rows = await ctx.db
        .select({ rec: r, nodeName: schema.nodes.name, dj: schema.liveSessions.accountName })
        .from(r)
        .innerJoin(schema.nodes, eq(schema.nodes.id, r.nodeId))
        .leftJoin(schema.liveSessions, eq(schema.liveSessions.id, r.sessionId))
        // Files that overlap the period: started before its end, and ended (start + length) after its start.
        .where(and(eq(r.stationId, station.id), eq(r.kind, req.query.kind), lt(r.startedAt, to), sql`${r.startedAt} + make_interval(secs => ${r.durationSeconds}) > ${from.toISOString()}::timestamptz`))
        .orderBy(asc(r.startedAt))
        .limit(2000);
      const d = schema.recordingDeliveries;
      const ids = rows.map((x) => x.rec.id);
      const deliveries = ids.length
        ? await ctx.db.select({ id: d.recordingId, state: d.state, error: d.error }).from(d).where(inArray(d.recordingId, ids))
        : [];
      const uploads = new Map<string, { done: number; failed: number; error: string | null }>();
      for (const x of deliveries) {
        const u = uploads.get(x.id) ?? { done: 0, failed: 0, error: null };
        if (x.state === 'done') u.done++;
        else {
          u.failed++;
          u.error ??= x.error;
        }
        uploads.set(x.id, u);
      }
      return rows.map(({ rec, nodeName, dj }) => ({
        id: rec.id,
        nodeId: rec.nodeId,
        nodeName,
        kind: rec.kind === 'show' ? ('show' as const) : ('log' as const),
        dj: rec.kind === 'show' ? (dj ?? null) : null,
        startedAt: rec.startedAt,
        durationSeconds: rec.durationSeconds,
        sizeBytes: rec.sizeBytes,
        open: rec.open,
        available: hub.isOnline(rec.nodeId),
        uploads: uploads.get(rec.id) ?? { done: 0, failed: 0, error: null },
        onDemand: !!rec.ondemandAt,
      }));
    },
  );

  async function recordingOf(stationId: string, rid: string) {
    const [rec] = await ctx.db.select().from(schema.recordings).where(and(eq(schema.recordings.id, rid), eq(schema.recordings.stationId, stationId)));
    if (!rec) throw notFound('Recording');
    return rec;
  }

  app.get(
    '/:id/recordings/:rid/songs',
    { schema: { tags: ['Recordings'], summary: 'The play log of a recording: every song in it, live or AutoDJ', params: recParams, response: { 200: z.array(songOut) } } },
    async (req) => {
      const { station } = await stationAccess(ctx, req, req.params.id, 'manager');
      const rec = await recordingOf(station.id, req.params.rid);
      const from = rec.startedAt;
      const to = new Date(rec.startedAt.getTime() + Math.max(rec.durationSeconds, rec.open ? 3600 : 0) * 1000);
      const sp = schema.songPlays;
      const plays = await ctx.db
        .select()
        .from(sp)
        .where(and(eq(sp.stationId, station.id), lt(sp.startedAt, to), or(isNull(sp.endedAt), gt(sp.endedAt, from))))
        .orderBy(asc(sp.startedAt))
        .limit(1000);
      const ls = schema.liveSessions;
      const lives = await ctx.db
        .select({ startedAt: ls.startedAt, endedAt: ls.endedAt, accountName: ls.accountName })
        .from(ls)
        .where(and(eq(ls.stationId, station.id), lt(ls.startedAt, to), or(isNull(ls.endedAt), gte(ls.endedAt, from))));
      // One title can be logged on several mounts of the station: keep the first of each start.
      const seen = new Set<string>();
      const offset = (d: Date) => Math.round((d.getTime() - from.getTime()) / 1000);
      const songs = plays
        .filter((p) => {
          const key = `${Math.round(p.startedAt.getTime() / 5000)}|${p.title}`;
          if (seen.has(key)) return false;
          seen.add(key);
          // A show starts when the DJ goes live: the AutoDJ title that was on before is not part of it.
          return rec.kind !== 'show' || p.startedAt.getTime() >= from.getTime() - 2000;
        })
        .map((p) => {
          const live = lives.find((l) => l.startedAt <= p.startedAt && (!l.endedAt || l.endedAt > p.startedAt));
          return { kind: 'song' as const, title: p.title, startedAt: p.startedAt, endedAt: p.endedAt, offsetSeconds: offset(p.startedAt), live: !!live, dj: live?.accountName ?? null };
        });
      // Every live broadcast in the recording gets its own line, so the log shows who was live even when the encoder
      // sends no titles (and the AutoDJ title of before would otherwise seem to play on).
      const marks = lives
        .filter((l) => l.startedAt.getTime() >= from.getTime() - 5000)
        .map((l) => ({ kind: 'live' as const, title: l.accountName, startedAt: l.startedAt, endedAt: l.endedAt, offsetSeconds: Math.max(0, offset(l.startedAt)), live: true, dj: l.accountName }));
      return [...songs, ...marks].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime() || (a.kind === 'live' ? -1 : 1));
    },
  );

  app.get(
    '/:id/recordings/:rid/audio',
    {
      schema: {
        tags: ['Recordings'],
        summary: 'Listen to or download a recording (fetched from the recorder node; supports Range for seeking)',
        params: recParams,
        querystring: z.object({ download: z.coerce.boolean().default(false) }),
      },
    },
    async (req, reply) => {
      const { station } = await stationAccess(ctx, req, req.params.id, 'manager');
      const rec = await recordingOf(station.id, req.params.rid);
      if (!hub.isOnline(rec.nodeId)) return reply.status(503).header('retry-after', '30').send({ error: { code: 'recorder_offline', message: 'The recorder that has this recording is offline' } });
      const range = parseRange(req.headers.range);
      const fetchPart = (start: number, end: number | null) => hub.fetchRecording(rec.nodeId, rec.file, start, end);
      const ext = rec.file.slice(rec.file.lastIndexOf('.') + 1);
      const name = `${station.slug}_${rec.kind === 'show' ? 'show_' : ''}${rec.startedAt.toISOString().slice(0, 16).replace('T', '_').replace(':', '-')}Z.${ext}`;
      reply.header('accept-ranges', 'bytes').header('cache-control', 'private, no-store').header('content-type', rec.contentType);
      if (req.query.download) reply.header('content-disposition', `attachment; filename="${name}"`);
      let first: RecordingPart;
      try {
        // A player asks for "bytes=0-" and seeks with later starts: it gets one part at a time.
        first = await fetchPart(range?.start ?? 0, range ? Math.min(range.end ?? Infinity, range.start + RECORDING_PART) : RECORDING_PART);
      } catch (err) {
        const message = (err as Error).message;
        if (/Outside the recording/.test(message)) return reply.status(416).header('content-range', `bytes */${rec.sizeBytes}`).send();
        return reply.status(502).send({ error: { code: 'recorder_error', message } });
      }
      if (range) {
        reply.status(206).header('content-range', `bytes ${first.start}-${first.start + first.length - 1}/${first.size}`).header('content-length', first.length);
        return reply.send(first.body);
      }
      // The whole file: the first part, then the next ones, one after the other.
      const out = new PassThrough();
      reply.header('content-length', first.size);
      void (async () => {
        let part: RecordingPart | null = first;
        let at = 0;
        try {
          while (part) {
            await pipeline(part.body, out, { end: false });
            at = part.start + part.length;
            part = at < first.size ? await fetchPart(at, Math.min(first.size, at + RECORDING_PART)) : null;
          }
          out.end();
        } catch (err) {
          part?.body.destroy();
          out.destroy(err as Error);
        }
      })();
      return reply.send(out);
    },
  );
};

/** Where recorder nodes post the files they were asked for (phase 21). Mounted under /api/nodes. */
export const recordingAgentRoutes: FastifyPluginAsyncZod = async (app) => {
  const { ctx } = app;
  const hub = app.nodes;
  // The body is passed on as it comes in, never held in memory.
  app.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload));

  app.post('/agent/recordings/:id', { bodyLimit: RECORDING_PART + 1024 * 1024, schema: { hide: true, params: z.object({ id: z.uuid() }) } }, async (req, reply) => {
    const node = await authenticateNode(ctx, req.headers.authorization);
    const body = req.body as NodeJS.ReadableStream & import('node:stream').Readable;
    const size = Number(req.headers['x-hrs-size']);
    const start = Number(req.headers['x-hrs-start']);
    const length = Number(req.headers['content-length']);
    if (![size, start, length].every((n) => Number.isSafeInteger(n) && n >= 0) || length > RECORDING_PART) {
      body.resume();
      return reply.status(400).send({ error: { code: 'bad_request', message: 'Size, start and length are needed' } });
    }
    const done = new Promise<void>((resolve) => {
      body.once('end', resolve);
      body.once('close', resolve);
      body.once('error', () => resolve());
    });
    if (!hub.recordingArrived(node.id, req.params.id, { body, start, length, size })) {
      body.resume();
      return reply.status(410).send({ error: { code: 'gone', message: 'Nobody waits for this file any more' } });
    }
    await done;
    return reply.send({ ok: true });
  });
};
