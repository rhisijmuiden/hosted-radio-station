import { asc, eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { schema } from '../db/index.js';
import { notFound } from '../lib/errors.js';
import { connectionInfo } from '../services/streaming/info.js';
import { stationStats } from '../services/streaming/state.js';

const publicStationOut = z.object({
  name: z.string(),
  slug: z.string(),
  description: z.string(),
  genre: z.string(),
  website: z.string(),
  live: z.boolean(),
  listeners: z.number().int(),
  nowPlaying: z.object({ title: z.string().nullable(), mount: z.string().nullable() }),
  mounts: z.array(
    z.object({
      path: z.string(),
      name: z.string(),
      format: z.string(),
      bitrateKbps: z.number().int(),
      isDefault: z.boolean(),
      live: z.boolean(),
      listeners: z.number().int(),
      listenUrl: z.string().nullable(),
    }),
  ),
  external: z.array(z.object({ name: z.string(), url: z.string() })),
});

/** No sign-in needed: what players and websites show. Cached for a few seconds. */
export const publicRoutes: FastifyPluginAsyncZod = async (app) => {
  const { ctx } = app;
  const cache = new Map<string, { at: number; value: z.infer<typeof publicStationOut> }>();

  app.get(
    '/stations/:slug',
    {
      config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
      schema: {
        tags: ['Public'],
        summary: 'Public status of a station: mounts with listen URLs, listeners and now playing',
        security: [],
        params: z.object({ slug: z.string().max(48) }),
        response: { 200: publicStationOut },
      },
    },
    async (req, reply) => {
      reply.header('access-control-allow-origin', '*').header('cache-control', 'public, max-age=5');
      const slug = req.params.slug.toLowerCase();
      const hit = cache.get(slug);
      if (hit && Date.now() - hit.at < 5000) return hit.value;
      const [row] = await ctx.db
        .select({ station: schema.stations, tenantActive: schema.tenants.active })
        .from(schema.stations)
        .innerJoin(schema.tenants, eq(schema.tenants.id, schema.stations.tenantId))
        .where(eq(schema.stations.slug, slug));
      if (!row || !row.station.enabled || !row.tenantActive) throw notFound('Station');
      const { station } = row;
      const [mounts, outputs, stats] = await Promise.all([
        ctx.db.select().from(schema.stationMounts).where(eq(schema.stationMounts.stationId, station.id)).orderBy(asc(schema.stationMounts.sortOrder), asc(schema.stationMounts.createdAt)),
        ctx.db.select().from(schema.stationOutputs).where(eq(schema.stationOutputs.stationId, station.id)),
        stationStats(ctx, station),
      ]);
      const local = outputs.some((o) => o.type === 'local' && o.enabled);
      const conn = await connectionInfo(ctx, station, mounts, local);
      const byPath = new Map((stats ?? []).map((s) => [s.mount, s]));
      const visible = mounts.filter((m) => m.isPublic);
      const def = visible.find((m) => m.isDefault) ?? visible[0];
      const playing = (def && byPath.get(def.path)) ?? visible.map((m) => byPath.get(m.path)).find(Boolean);
      const value = {
        name: station.name,
        slug: station.slug,
        description: station.description,
        genre: station.genre,
        website: station.website,
        live: visible.some((m) => byPath.has(m.path)),
        listeners: (stats ?? []).reduce((n, s) => n + s.listeners, 0) + outputs.reduce((n, o) => n + (o.type !== 'local' && o.status?.listeners ? o.status.listeners : 0), 0),
        nowPlaying: { title: playing?.title ?? null, mount: playing?.mount ?? null },
        mounts: visible.map((m) => ({
          path: m.path,
          name: m.name,
          format: m.format,
          bitrateKbps: m.bitrateKbps,
          isDefault: m === def,
          live: byPath.has(m.path),
          listeners: byPath.get(m.path)?.listeners ?? 0,
          listenUrl: conn.mounts.find((c) => c.id === m.id)?.listenUrl ?? null,
        })),
        external: outputs.filter((o) => o.type !== 'local' && o.enabled && o.config.publicUrl).map((o) => ({ name: o.name, url: o.config.publicUrl! })),
      };
      cache.set(slug, { at: Date.now(), value });
      return value;
    },
  );
};
