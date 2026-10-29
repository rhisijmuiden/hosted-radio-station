import { extname } from 'node:path';
import { and, eq } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { schema } from '../db/index.js';
import { badRequest } from '../lib/errors.js';
import { fetchNews, isFresh, maskNews, newsSchema, newsSettings, newsSlots, readNewsStatus, sealNews } from '../services/autodj/news.js';
import { applyStreams, type Station } from '../services/streaming/state.js';
import { stationAccess } from './stations.js';

const stationParams = z.object({ id: z.uuid() });

const statusOut = z.object({
  mediaId: z.uuid().nullable(),
  durationSeconds: z.number().nullable(),
  fetchedAt: z.string().nullable(),
  sourceAt: z.string().nullable(),
  slot: z.string().nullable(),
  lastAttemptAt: z.string().nullable(),
  error: z.string().nullable(),
  /** The file type of the bulletin (".mp3"), for RHIS Studio to cache it. */
  ext: z.string().nullable(),
});
const newsOut = z.object({
  settings: newsSchema,
  status: statusOut,
  /** The coming news times from the hour clocks, with whether the bulletin on disk may play then. */
  slots: z.array(z.object({ at: z.date(), fresh: z.boolean() })),
  fallback: z.object({ id: z.uuid(), title: z.string(), artist: z.string(), durationSeconds: z.number().nullable(), ext: z.string() }).nullable(),
});

/** The news bulletin of Radio stations: its source (managers) and its state (DJs too, for RHIS Studio). */
export const newsRoutes: FastifyPluginAsyncZod = async (app) => {
  const { ctx } = app;

  async function radio(req: FastifyRequest, stationId: string, minRole: 'dj' | 'manager') {
    const r = await stationAccess(ctx, req, stationId, minRole);
    if (r.station.edition !== 'station') throw badRequest('This needs the Radio station edition; upgrade the station first');
    return r;
  }

  async function view(station: Station): Promise<z.infer<typeof newsOut>> {
    const settings = newsSettings(station);
    const [status, slots] = await Promise.all([readNewsStatus(ctx, station.id), newsSlots(ctx, station)]);
    const [fallback] = settings.fallbackMediaId
      ? await ctx.db
          .select({ id: schema.mediaFiles.id, title: schema.mediaFiles.title, artist: schema.mediaFiles.artist, durationSeconds: schema.mediaFiles.durationSeconds, path: schema.mediaFiles.path })
          .from(schema.mediaFiles)
          .where(and(eq(schema.mediaFiles.id, settings.fallbackMediaId), eq(schema.mediaFiles.stationId, station.id)))
      : [];
    return {
      settings: maskNews(settings),
      status: { ...status, ext: status.path ? extname(status.path).toLowerCase() || null : null },
      slots: slots.map((t) => ({ at: new Date(t), fresh: isFresh(status, settings, t) })),
      fallback: fallback ? { id: fallback.id, title: fallback.title, artist: fallback.artist, durationSeconds: fallback.durationSeconds, ext: extname(fallback.path).toLowerCase() } : null,
    };
  }

  app.get(
    '/:id/news',
    { schema: { tags: ['News'], summary: 'News bulletin: where it comes from, the last fetch and the coming news times', params: stationParams, response: { 200: newsOut } } },
    async (req) => {
      const { station } = await radio(req, req.params.id, 'dj');
      return view(station);
    },
  );

  app.put(
    '/:id/news',
    {
      config: { audit: 'news.update' },
      schema: {
        tags: ['News'],
        summary: 'Set where the news bulletin comes from and the spare jingle (managers). Place the news with a News item in the hour clocks.',
        params: stationParams,
        body: newsSchema,
        response: { 200: newsOut },
      },
    },
    async (req) => {
      const { station } = await radio(req, req.params.id, 'manager');
      const body = req.body;
      if (body.fallbackMediaId) {
        const [m] = await ctx.db
          .select({ id: schema.mediaFiles.id })
          .from(schema.mediaFiles)
          .where(and(eq(schema.mediaFiles.id, body.fallbackMediaId), eq(schema.mediaFiles.stationId, station.id)));
        if (!m) throw badRequest('The spare jingle must be a track of this station');
      }
      if (body.enabled && body.source === 'url' && !body.url) throw badRequest('Enter the address of the bulletin');
      if (body.enabled && body.source !== 'url' && (!body.host || !body.username || !body.path)) throw badRequest('Enter the server, the user name and the file');
      const news = sealNews(ctx.box, body, station.news);
      const [row] = await ctx.db.update(schema.stations).set({ news, updatedAt: new Date() }).where(eq(schema.stations.id, station.id)).returning();
      req.auditInfo.details = { enabled: body.enabled, source: body.source };
      // A station on a station node gets its new settings with its package.
      await applyStreams(ctx, { stationIds: [station.id], by: req.auth?.user.email }).catch((err) => req.log.error({ err }, 'applying stream configuration failed'));
      return view(row!);
    },
  );

  app.post(
    '/:id/news/fetch',
    {
      config: { audit: 'news.fetch' },
      schema: { tags: ['News'], summary: 'Fetch the bulletin now, to try the source (managers)', params: stationParams, response: { 200: newsOut } },
    },
    async (req) => {
      const { station } = await radio(req, req.params.id, 'manager');
      const [next] = await newsSlots(ctx, station);
      await fetchNews(ctx, station, next ?? Date.now());
      return view(station);
    },
  );
};
