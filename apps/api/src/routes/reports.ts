import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { badRequest } from '../lib/errors.js';
import { idParam } from '../lib/schemas.js';
import { playsCsv, reportPeriod, rightsPlays, rightsTracks, tracksCsv } from '../services/reports/rights.js';
import { stationAccess } from './stations.js';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'A date as YYYY-MM-DD');
const periodQuery = z.object({
  /** First and last day of the period, in the station's time zone. */
  from: day,
  to: day,
  /** Plays shorter than this many seconds (jingles, idents) are left out. */
  minSeconds: z.coerce.number().int().min(0).max(600).default(30),
});
const playOut = z.object({
  startedAt: z.date(),
  endedAt: z.date().nullable(),
  date: z.string(),
  time: z.string(),
  durationSeconds: z.number(),
  artist: z.string(),
  title: z.string(),
  composer: z.string(),
  album: z.string(),
  label: z.string(),
  year: z.number().nullable(),
  isrc: z.string(),
  code: z.string(),
  source: z.enum(['autodj', 'live']),
  dj: z.string().nullable(),
  mount: z.string(),
  avgListeners: z.number(),
  peakListeners: z.number(),
  listenerHours: z.number(),
});
const trackOut = z.object({
  artist: z.string(),
  title: z.string(),
  composer: z.string(),
  album: z.string(),
  label: z.string(),
  isrc: z.string(),
  code: z.string(),
  plays: z.number(),
  totalSeconds: z.number(),
  listenerHours: z.number(),
  firstPlayed: z.date(),
  lastPlayed: z.date(),
});

/**
 * Music reports for the collecting societies (phase 21 step 5): every play (Buma/Stemra) and the plays per recording
 * (SENA), as JSON or as a CSV download. Station managers; mounted under /api/stations.
 */
export const reportRoutes: FastifyPluginAsyncZod = async (app) => {
  const { ctx } = app;

  async function load(req: Parameters<typeof stationAccess>[1], id: string, q: z.infer<typeof periodQuery>) {
    const { station } = await stationAccess(ctx, req, id, 'manager');
    if (q.to < q.from) throw badRequest('The last day comes before the first day');
    const { start, end } = reportPeriod(station, q.from, q.to);
    if (end.getTime() - start.getTime() > 400 * 86400_000) throw badRequest('A report covers at most 400 days');
    return { station, plays: await rightsPlays(ctx, station, q.from, q.to, q.minSeconds) };
  }
  const fileName = (slug: string, kind: string, q: z.infer<typeof periodQuery>) => `${slug}_${kind}_${q.from}_${q.to}.csv`;

  app.get(
    '/:id/reports/plays',
    { schema: { tags: ['Reports'], summary: 'Every music play in a period, with makers, ISRC, live or AutoDJ and listeners (for Buma/Stemra)', params: idParam, querystring: periodQuery, response: { 200: z.object({ items: z.array(playOut) }) } } },
    async (req) => ({ items: (await load(req, req.params.id, req.query)).plays }),
  );

  app.get(
    '/:id/reports/tracks',
    { schema: { tags: ['Reports'], summary: 'The plays of a period per recording: how often, how long and listening hours (for SENA)', params: idParam, querystring: periodQuery, response: { 200: z.object({ items: z.array(trackOut) }) } } },
    async (req) => ({ items: rightsTracks((await load(req, req.params.id, req.query)).plays) }),
  );

  app.get(
    '/:id/reports/plays.csv',
    { schema: { tags: ['Reports'], summary: 'Every music play in a period as CSV', params: idParam, querystring: periodQuery } },
    async (req, reply) => {
      const { station, plays } = await load(req, req.params.id, req.query);
      return reply.type('text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${fileName(station.slug, 'plays', req.query)}"`).send(playsCsv(plays));
    },
  );

  app.get(
    '/:id/reports/tracks.csv',
    { schema: { tags: ['Reports'], summary: 'The plays of a period per recording as CSV', params: idParam, querystring: periodQuery } },
    async (req, reply) => {
      const { station, plays } = await load(req, req.params.id, req.query);
      return reply.type('text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${fileName(station.slug, 'tracks', req.query)}"`).send(tracksCsv(rightsTracks(plays)));
    },
  );
};
