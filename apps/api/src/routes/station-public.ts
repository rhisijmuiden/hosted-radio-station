import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { and, count, desc, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { schema } from '../db/index.js';
import { badRequest, notFound } from '../lib/errors.js';
import { okOut } from '../lib/schemas.js';
import { itemPath, scanOnDemand } from '../services/public/ondemand.js';
import { publicPageSchema, publicSettings } from '../services/public/settings.js';
import { connectionInfo } from '../services/streaming/info.js';
import { STREAMS_CHANNEL } from '../services/streaming/state.js';
import { publicDir, sendFile } from './public.js';
import { stationAccess } from './stations.js';

const stationParams = z.object({ id: z.uuid() });

const publicOut = z.object({
  settings: publicPageSchema,
  logoUrl: z.string().nullable(),
  /** Public page of the station. */
  pageUrl: z.string(),
  /** Base for the embed codes, e.g. https://stream.example.com/public/<slug>/embed */
  embedBase: z.string(),
  apiBase: z.string(),
});
const requestOut = z.object({
  id: z.uuid(),
  artist: z.string(),
  title: z.string(),
  message: z.string(),
  requesterName: z.string(),
  status: z.enum(['pending', 'accepted', 'played', 'rejected']),
  handledBy: z.string().nullable(),
  handledAt: z.date().nullable(),
  createdAt: z.date(),
});
const itemOut = z.object({
  id: z.uuid(),
  source: z.string(),
  file: z.string(),
  title: z.string(),
  description: z.string(),
  host: z.string(),
  contentType: z.string(),
  sizeBytes: z.number(),
  durationSeconds: z.number().int().nullable(),
  recordedAt: z.date().nullable(),
  publishedAt: z.date().nullable(),
  plays: z.number().int(),
  createdAt: z.date(),
  /** Still being recorded. */
  recording: z.boolean(),
  /** Listen in the panel (also for drafts). */
  previewUrl: z.string(),
});

const IMAGE_MAGIC: { ext: string; test: (b: Buffer) => boolean }[] = [
  { ext: 'png', test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { ext: 'jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: 'webp', test: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
];

/** Public page settings, logo, song requests and on-demand items of a station, for the panel. */
export const stationPublicRoutes: FastifyPluginAsyncZod = async (app) => {
  const { ctx } = app;
  const hub = app.nowPlaying;

  /** Tells the live feeds and the streams service (recordings) about the change. */
  const changed = async (stationId: string) => {
    hub.notify(stationId);
    await ctx.db.execute(sql`select pg_notify(${STREAMS_CHANNEL}, ${JSON.stringify({ stationIds: [stationId] })})`).catch(() => undefined);
  };

  async function describe(station: typeof schema.stations.$inferSelect) {
    const base = (await connectionInfo(ctx, station, [], false)).listenBase;
    return {
      settings: publicSettings(station),
      logoUrl: station.logoFile ? `${base}/api/public/stations/${station.slug}/logo?v=${encodeURIComponent(station.logoFile)}` : null,
      pageUrl: `${base}/public/${station.slug}`,
      embedBase: `${base}/public/${station.slug}/embed`,
      apiBase: `${base}/api/public/stations/${station.slug}`,
    };
  }

  app.get(
    '/:id/public',
    { schema: { tags: ['Public pages'], summary: 'Public page settings of a station, with its page and embed addresses', params: stationParams, response: { 200: publicOut } } },
    async (req) => {
      const { station } = await stationAccess(ctx, req, req.params.id, 'dj');
      return describe(station);
    },
  );

  app.put(
    '/:id/public',
    {
      config: { audit: 'station.public_update' },
      schema: { tags: ['Public pages'], summary: 'Change the public page, requests, on-demand and recordings (managers)', params: stationParams, body: publicPageSchema, response: { 200: publicOut } },
    },
    async (req) => {
      const { station } = await stationAccess(ctx, req, req.params.id, 'manager');
      const [row] = await ctx.db.update(schema.stations).set({ publicPage: req.body, updatedAt: new Date() }).where(eq(schema.stations.id, station.id)).returning();
      await changed(station.id);
      return describe(row!);
    },
  );

  app.put(
    '/:id/public/logo',
    {
      config: { audit: 'station.logo_update' },
      bodyLimit: 3 * 1024 * 1024,
      schema: {
        tags: ['Public pages'],
        summary: 'Upload the station logo: a PNG, JPEG or WebP image as a data URL, at most 2 MB (square, 512×512 or more, works best)',
        params: stationParams,
        body: z.object({ image: z.string().max(3_000_000) }),
        response: { 200: publicOut },
      },
    },
    async (req) => {
      const { station } = await stationAccess(ctx, req, req.params.id, 'manager');
      const m = req.body.image.match(/^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/);
      if (!m) throw badRequest('Send a PNG, JPEG or WebP image');
      const data = Buffer.from(m[1]!, 'base64');
      if (data.length > 2 * 1024 * 1024) throw badRequest('The image may be at most 2 MB');
      const kind = IMAGE_MAGIC.find((k) => k.test(data));
      if (!kind) throw badRequest('Send a PNG, JPEG or WebP image');
      const dir = publicDir(ctx, station.id);
      await mkdir(dir, { recursive: true });
      const file = `logo-${Date.now().toString(36)}.${kind.ext}`;
      await writeFile(join(dir, `${file}.tmp`), data);
      await rename(join(dir, `${file}.tmp`), join(dir, file));
      if (station.logoFile) await rm(join(dir, station.logoFile), { force: true });
      const [row] = await ctx.db.update(schema.stations).set({ logoFile: file, updatedAt: new Date() }).where(eq(schema.stations.id, station.id)).returning();
      await changed(station.id);
      return describe(row!);
    },
  );

  app.delete(
    '/:id/public/logo',
    { config: { audit: 'station.logo_delete' }, schema: { tags: ['Public pages'], summary: 'Remove the station logo', params: stationParams, response: { 200: publicOut } } },
    async (req) => {
      const { station } = await stationAccess(ctx, req, req.params.id, 'manager');
      if (station.logoFile) await rm(join(publicDir(ctx, station.id), station.logoFile), { force: true });
      const [row] = await ctx.db.update(schema.stations).set({ logoFile: null, updatedAt: new Date() }).where(eq(schema.stations.id, station.id)).returning();
      await changed(station.id);
      return describe(row!);
    },
  );

  // Song requests

  app.get(
    '/:id/requests',
    {
      schema: {
        tags: ['Public pages'],
        summary: 'Song requests from listeners, newest first. DJs see them too.',
        params: stationParams,
        querystring: z.object({ status: z.enum(['open', 'handled', 'all']).default('open'), limit: z.coerce.number().int().min(1).max(500).default(100) }),
        response: { 200: z.object({ items: z.array(requestOut), pending: z.number().int() }) },
      },
    },
    async (req) => {
      const { station } = await stationAccess(ctx, req, req.params.id, 'dj');
      const s = req.query.status;
      const statuses = s === 'open' ? (['pending', 'accepted'] as const) : s === 'handled' ? (['played', 'rejected'] as const) : null;
      const [items, [pending]] = await Promise.all([
        ctx.db
          .select()
          .from(schema.songRequests)
          .where(and(eq(schema.songRequests.stationId, station.id), statuses ? inArray(schema.songRequests.status, [...statuses]) : undefined))
          .orderBy(desc(schema.songRequests.createdAt))
          .limit(req.query.limit),
        ctx.db.select({ n: count() }).from(schema.songRequests).where(and(eq(schema.songRequests.stationId, station.id), eq(schema.songRequests.status, 'pending'))),
      ]);
      return { items, pending: pending?.n ?? 0 };
    },
  );

  app.patch(
    '/:id/requests/:requestId',
    {
      schema: {
        tags: ['Public pages'],
        summary: 'Mark a request as accepted, played or rejected',
        params: stationParams.extend({ requestId: z.uuid() }),
        body: z.object({ status: z.enum(['pending', 'accepted', 'played', 'rejected']) }),
        response: { 200: requestOut },
      },
    },
    async (req) => {
      const { station, access } = await stationAccess(ctx, req, req.params.id, 'dj');
      const [row] = await ctx.db
        .update(schema.songRequests)
        .set({ status: req.body.status, handledBy: req.body.status === 'pending' ? null : access.user.name, handledAt: req.body.status === 'pending' ? null : new Date() })
        .where(and(eq(schema.songRequests.id, req.params.requestId), eq(schema.songRequests.stationId, station.id)))
        .returning();
      if (!row) throw notFound('Request');
      return row;
    },
  );

  app.delete(
    '/:id/requests',
    {
      config: { audit: 'station.requests_clear' },
      schema: { tags: ['Public pages'], summary: 'Remove handled requests (played and rejected)', params: stationParams, response: { 200: z.object({ removed: z.number().int() }) } },
    },
    async (req) => {
      const { station } = await stationAccess(ctx, req, req.params.id, 'dj');
      const rows = await ctx.db
        .delete(schema.songRequests)
        .where(and(eq(schema.songRequests.stationId, station.id), inArray(schema.songRequests.status, ['played', 'rejected'])))
        .returning({ id: schema.songRequests.id });
      return { removed: rows.length };
    },
  );

  // On demand

  const toItem = (stationId: string, i: typeof schema.onDemandItems.$inferSelect): z.infer<typeof itemOut> => ({
    ...i,
    recording: i.source === 'recording' && !i.recordedAt,
    previewUrl: `/api/stations/${stationId}/ondemand/${i.id}/audio`,
  });

  app.get(
    '/:id/ondemand',
    {
      schema: {
        tags: ['Public pages'],
        summary: 'On-demand items of a station: recordings of live broadcasts and files in the "ondemand" upload folder',
        params: stationParams,
        response: { 200: z.object({ items: z.array(itemOut) }) },
      },
    },
    async (req) => {
      const { station } = await stationAccess(ctx, req, req.params.id, 'dj');
      const items = await ctx.db
        .select()
        .from(schema.onDemandItems)
        .where(eq(schema.onDemandItems.stationId, station.id))
        .orderBy(desc(sql`coalesce(${schema.onDemandItems.recordedAt}, ${schema.onDemandItems.createdAt})`));
      return { items: items.map((i) => toItem(station.id, i)) };
    },
  );

  app.post(
    '/:id/ondemand/scan',
    { schema: { tags: ['Public pages'], summary: 'Look for new files in the "ondemand" upload folder now', params: stationParams, response: { 200: okOut } } },
    async (req) => {
      const { station } = await stationAccess(ctx, req, req.params.id, 'manager');
      await scanOnDemand(ctx, station.id);
      return { ok: true as const };
    },
  );

  app.patch(
    '/:id/ondemand/:itemId',
    {
      config: { audit: 'station.ondemand_update' },
      schema: {
        tags: ['Public pages'],
        summary: 'Change the title or description of an on-demand item, or publish it',
        params: stationParams.extend({ itemId: z.uuid() }),
        body: z.object({
          title: z.string().trim().min(1).max(200).optional(),
          description: z.string().trim().max(2000).optional(),
          host: z.string().trim().max(100).optional(),
          published: z.boolean().optional(),
        }),
        response: { 200: itemOut },
      },
    },
    async (req) => {
      const { station } = await stationAccess(ctx, req, req.params.id, 'manager');
      const { published, ...rest } = req.body;
      const [current] = await ctx.db.select().from(schema.onDemandItems).where(and(eq(schema.onDemandItems.id, req.params.itemId), eq(schema.onDemandItems.stationId, station.id)));
      if (!current) throw notFound('Item');
      if (published && current.source === 'recording' && !current.recordedAt) throw badRequest('This broadcast is still being recorded');
      const [row] = await ctx.db
        .update(schema.onDemandItems)
        .set({ ...rest, ...(published !== undefined ? { publishedAt: published ? (current.publishedAt ?? new Date()) : null } : {}) })
        .where(eq(schema.onDemandItems.id, current.id))
        .returning();
      return toItem(station.id, row!);
    },
  );

  app.delete(
    '/:id/ondemand/:itemId',
    {
      config: { audit: 'station.ondemand_delete' },
      schema: { tags: ['Public pages'], summary: 'Delete an on-demand item and its file', params: stationParams.extend({ itemId: z.uuid() }), response: { 200: okOut } },
    },
    async (req) => {
      const { station } = await stationAccess(ctx, req, req.params.id, 'manager');
      const [row] = await ctx.db.select().from(schema.onDemandItems).where(and(eq(schema.onDemandItems.id, req.params.itemId), eq(schema.onDemandItems.stationId, station.id)));
      if (!row) throw notFound('Item');
      if (row.source === 'recording' && !row.recordedAt) throw badRequest('This broadcast is still being recorded');
      await ctx.db.delete(schema.onDemandItems).where(eq(schema.onDemandItems.id, row.id));
      await rm(itemPath(ctx, station.id, row.file), { force: true });
      req.auditInfo.details = { title: row.title, file: row.file };
      return { ok: true as const };
    },
  );

  app.get(
    '/:id/ondemand/:itemId/audio',
    { schema: { tags: ['Public pages'], summary: 'Listen to an on-demand item in the panel (also drafts)', params: stationParams.extend({ itemId: z.uuid() }) } },
    async (req, reply) => {
      const { station } = await stationAccess(ctx, req, req.params.id, 'dj');
      const [item] = await ctx.db.select().from(schema.onDemandItems).where(and(eq(schema.onDemandItems.id, req.params.itemId), eq(schema.onDemandItems.stationId, station.id)));
      if (!item) throw notFound('Item');
      return sendFile(reply, itemPath(ctx, station.id, item.file), item.contentType, req.headers.range, 'private, no-store');
    },
  );
};
