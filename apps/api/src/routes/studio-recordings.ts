import { and, desc, eq, gte, inArray, isNull } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { schema } from '../db/index.js';
import { forbidden, notFound } from '../lib/errors.js';
import { idParam } from '../lib/schemas.js';
import { recordsShow } from '../services/recorder/plan.js';
import { stationRecording } from '../services/recorder/settings.js';
import { recordersOf, recordingLink } from './recordings.js';
import { stationAccess } from './stations.js';

const liveOut = z.object({
  sessionId: z.uuid(),
  accountName: z.string(),
  startedAt: z.date(),
  /** The show is to be recorded (the DJ's choice, else the station's setting). */
  record: z.boolean(),
  /** The DJ chose; false = the station's setting applies. */
  chosen: z.boolean(),
  /** A recorder reports it records this broadcast right now. */
  recording: z.boolean(),
});
const showOut = z.object({
  id: z.uuid(),
  dj: z.string().nullable(),
  startedAt: z.date(),
  durationSeconds: z.number(),
  sizeBytes: z.number(),
  open: z.boolean(),
  available: z.boolean(),
  onDemand: z.boolean(),
});

/**
 * Recordings in RHIS Studio (phase 21 step 4): whether a recorder records the station, start or stop the recording of
 * the running broadcast, and the shows of the last month to play or download. DJs see and control their own
 * broadcasts; managers all of the station. Mounted under /api/studio.
 */
export const studioRecordingRoutes: FastifyPluginAsyncZod = async (app) => {
  const { ctx } = app;
  const hub = app.nodes;
  const ls = schema.liveSessions;

  /** The DJ accounts whose broadcasts the caller may see: their own for a DJ, null (all) for a manager. */
  async function ownAccounts(stationId: string, access: { role: string; user: { id: string } }) {
    if (access.role !== 'dj') return null;
    const rows = await ctx.db
      .select({ id: schema.stationAccounts.id })
      .from(schema.stationAccounts)
      .where(and(eq(schema.stationAccounts.stationId, stationId), eq(schema.stationAccounts.userId, access.user.id)));
    return rows.map((r) => r.id);
  }

  app.get(
    '/stations/:id/recording',
    {
      schema: {
        tags: ['Studio client'],
        summary: 'Recording of live shows: does a recorder record the station, and the running broadcasts you may start or stop the recording of',
        params: idParam,
        response: { 200: z.object({ recorder: z.boolean(), showsByDefault: z.boolean(), live: z.array(liveOut) }) },
      },
    },
    async (req) => {
      const { station, access } = await stationAccess(ctx, req, req.params.id, 'dj');
      const recorders = await recordersOf(ctx, station);
      const settings = stationRecording(station);
      const own = await ownAccounts(station.id, access);
      const open = await ctx.db
        .select()
        .from(ls)
        .where(and(eq(ls.stationId, station.id), isNull(ls.endedAt), own ? inArray(ls.accountId, own.length ? own : ['00000000-0000-0000-0000-000000000000']) : undefined))
        .orderBy(desc(ls.startedAt));
      const now = new Set<string>();
      for (const n of recorders) for (const s of hub.liveStatus(n.id)?.recorder?.stations ?? []) if (s.kind === 'show' && s.state === 'recording' && s.sessionId) now.add(s.sessionId);
      return {
        recorder: recorders.length > 0,
        showsByDefault: settings.shows,
        live: open.map((x) => ({ sessionId: x.id, accountName: x.accountName, startedAt: x.startedAt, record: recordsShow(x, settings.shows), chosen: x.record !== null, recording: now.has(x.id) })),
      };
    },
  );

  app.put(
    '/stations/:id/live/:sessionId/recording',
    {
      config: { audit: 'studio.live_recording' },
      schema: {
        tags: ['Studio client'],
        summary: 'Start or stop recording the running broadcast (the recorder starts a new part when it starts again)',
        params: idParam.extend({ sessionId: z.uuid() }),
        body: z.object({ record: z.boolean() }),
        response: { 200: liveOut.omit({ recording: true }) },
      },
    },
    async (req) => {
      const { station, access } = await stationAccess(ctx, req, req.params.id, 'dj');
      const [session] = await ctx.db.select().from(ls).where(and(eq(ls.id, req.params.sessionId), eq(ls.stationId, station.id), isNull(ls.endedAt)));
      if (!session) throw notFound('Live broadcast');
      const own = await ownAccounts(station.id, access);
      if (own && (!session.accountId || !own.includes(session.accountId))) throw forbidden('You can only change the recording of your own broadcast');
      const [row] = await ctx.db.update(ls).set({ record: req.body.record }).where(eq(ls.id, session.id)).returning();
      hub.recorderNotify(station.id);
      req.auditInfo.details = { record: req.body.record, dj: session.accountName };
      return { sessionId: row!.id, accountName: row!.accountName, startedAt: row!.startedAt, record: req.body.record, chosen: true };
    },
  );

  app.get(
    '/stations/:id/recordings',
    {
      schema: {
        tags: ['Studio client'],
        summary: 'Recorded live shows of the last 31 days, newest first (a DJ sees their own)',
        params: idParam,
        response: { 200: z.array(showOut) },
      },
    },
    async (req) => {
      const { station, access } = await stationAccess(ctx, req, req.params.id, 'dj');
      const own = await ownAccounts(station.id, access);
      if (own && !own.length) return [];
      const r = schema.recordings;
      const rows = await ctx.db
        .select({ rec: r, dj: ls.accountName })
        .from(r)
        .innerJoin(ls, eq(ls.id, r.sessionId))
        .where(and(eq(r.stationId, station.id), eq(r.kind, 'show'), gte(r.startedAt, new Date(Date.now() - 31 * 86400_000)), own ? inArray(ls.accountId, own) : undefined))
        .orderBy(desc(r.startedAt))
        .limit(500);
      return rows.map(({ rec, dj }) => ({
        id: rec.id,
        dj,
        startedAt: rec.startedAt,
        durationSeconds: rec.durationSeconds,
        sizeBytes: rec.sizeBytes,
        open: rec.open,
        available: hub.isOnline(rec.nodeId),
        onDemand: !!rec.ondemandAt,
      }));
    },
  );

  app.post(
    '/stations/:id/recordings/:rid/link',
    {
      schema: {
        tags: ['Studio client'],
        summary: 'A link to play or download a show, valid for six hours (add &download=1, or &from=…&to=… in seconds for a part)',
        params: idParam.extend({ rid: z.uuid() }),
        response: { 200: z.object({ url: z.string(), expiresAt: z.date() }) },
      },
    },
    async (req) => {
      const { station, access } = await stationAccess(ctx, req, req.params.id, 'dj');
      const [row] = await ctx.db
        .select({ rec: schema.recordings, accountId: ls.accountId })
        .from(schema.recordings)
        .leftJoin(ls, eq(ls.id, schema.recordings.sessionId))
        .where(and(eq(schema.recordings.id, req.params.rid), eq(schema.recordings.stationId, station.id)));
      if (!row) throw notFound('Recording');
      const own = await ownAccounts(station.id, access);
      if (own && (row.rec.kind !== 'show' || !row.accountId || !own.includes(row.accountId))) throw forbidden('You can only listen back to your own shows');
      const link = recordingLink(ctx.config.APP_SECRET, row.rec.id);
      return { url: link.path, expiresAt: link.expiresAt };
    },
  );
};
