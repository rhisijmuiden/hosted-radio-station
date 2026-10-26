import { createHmac } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { and, asc, count, desc, eq, gt, isNotNull, sql } from 'drizzle-orm';
import type { FastifyReply } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { WebSocket } from '@fastify/websocket';
import { z } from 'zod';
import { schema } from '../db/index.js';
import type { AppContext } from '../lib/context.js';
import { badRequest, HttpError, notFound } from '../lib/errors.js';
import { artworkDir } from '../services/public/artwork.js';
import { findPublicStation, recentlyPlayed, titleMount, type NowPlaying, type PublicStation } from '../services/public/nowplaying.js';
import { itemPath } from '../services/public/ondemand.js';
import { connectionInfo } from '../services/streaming/info.js';
import { stationStats } from '../services/streaming/state.js';

export const publicDir = (ctx: AppContext, stationId: string) => join(ctx.config.DATA_DIR, 'public', stationId);

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

const songOut = z.object({ text: z.string(), artist: z.string().nullable(), title: z.string(), artworkUrl: z.string().nullable() });
export const nowPlayingOut = z.object({
  station: z.object({
    name: z.string(),
    slug: z.string(),
    description: z.string(),
    genre: z.string(),
    website: z.string(),
    logoUrl: z.string().nullable(),
    pageUrl: z.string(),
    accentColor: z.string(),
    theme: z.enum(['auto', 'light', 'dark']),
    links: z.record(z.string(), z.string()),
  }),
  onAir: z.boolean(),
  live: z.object({ dj: z.string(), since: z.string() }).nullable(),
  song: songOut.extend({ startedAt: z.string().nullable() }).nullable(),
  listeners: z.number().int().nullable(),
  mounts: z.array(
    z.object({
      path: z.string(),
      name: z.string(),
      format: z.string(),
      contentType: z.string(),
      bitrateKbps: z.number().int(),
      isDefault: z.boolean(),
      live: z.boolean(),
      listenUrl: z.string().nullable(),
    }),
  ),
  history: z.array(songOut.extend({ playedAt: z.string() })),
  requests: z.object({ enabled: z.boolean(), open: z.boolean(), message: z.string() }),
  onDemand: z.object({ enabled: z.boolean() }),
  updatedAt: z.string(),
});
const onDemandOut = z.object({
  id: z.uuid(),
  title: z.string(),
  description: z.string(),
  host: z.string(),
  source: z.string(),
  contentType: z.string(),
  sizeBytes: z.number(),
  durationSeconds: z.number().int().nullable(),
  recordedAt: z.date().nullable(),
  publishedAt: z.date().nullable(),
  audioUrl: z.string(),
});

const slugParams = z.object({ slug: z.string().max(48) });
const LOGO_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };

/** Keyed hash of a listener's address, to limit their requests without keeping the address. */
export const requesterHash = (secret: string, ip: string) => createHmac('sha256', `${secret}:requests`).update(ip).digest('base64url').slice(0, 22);

/** Sends a file with support for byte ranges (seeking in on-demand players). */
export async function sendFile(reply: FastifyReply, path: string, type: string, range: string | undefined, cache: string) {
  const st = await stat(path).catch(() => null);
  if (!st?.isFile()) throw notFound('File');
  reply.header('accept-ranges', 'bytes').header('content-type', type).header('cache-control', cache);
  const m = range?.match(/^bytes=(\d*)-(\d*)$/);
  if (m && (m[1] || m[2])) {
    let start = m[1] ? Number(m[1]) : Math.max(0, st.size - Number(m[2]));
    let end = m[1] && m[2] ? Math.min(Number(m[2]), st.size - 1) : st.size - 1;
    if (start >= st.size || start > end) {
      return reply.status(416).header('content-range', `bytes */${st.size}`).send();
    }
    start = Math.max(0, start);
    end = Math.max(start, end);
    reply.status(206).header('content-range', `bytes ${start}-${end}/${st.size}`).header('content-length', end - start + 1);
    return reply.send(createReadStream(path, { start, end }));
  }
  reply.header('content-length', st.size);
  return reply.send(createReadStream(path));
}

/**
 * No sign-in needed: what players, public pages, widgets and other websites use. Everything here can be called from
 * any website (CORS), and is cached for a few seconds where it can be.
 */
export const publicRoutes: FastifyPluginAsyncZod = async (app) => {
  const { ctx } = app;
  const hub = app.nowPlaying;
  const cache = new Map<string, { at: number; value: z.infer<typeof publicStationOut> }>();

  app.addHook('onRequest', async (req, reply) => {
    reply.header('access-control-allow-origin', '*');
    if (req.method === 'OPTIONS') {
      return reply
        .status(204)
        .header('access-control-allow-methods', 'GET, POST, OPTIONS')
        .header('access-control-allow-headers', 'content-type')
        .header('access-control-max-age', '86400')
        .send();
    }
  });
  app.options('/*', { schema: { hide: true } }, async (_req, reply) => reply.status(204).send());

  async function station(slug: string): Promise<PublicStation> {
    const s = await findPublicStation(ctx, slug);
    if (!s || !s.settings.enabled) throw notFound('Station');
    return s;
  }

  app.get(
    '/stations/:slug',
    {
      config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
      schema: {
        tags: ['Public'],
        summary: 'Public status of a station: mounts with listen URLs, listeners and now playing',
        security: [],
        params: slugParams,
        response: { 200: publicStationOut },
      },
    },
    async (req, reply) => {
      reply.header('cache-control', 'public, max-age=5');
      const slug = req.params.slug.toLowerCase();
      const hit = cache.get(slug);
      if (hit && Date.now() - hit.at < 5000) return hit.value;
      const station = await findPublicStation(ctx, slug);
      if (!station) throw notFound('Station');
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
      // Converted mounts carry no title of their own: now playing comes from their source.
      const src = titleMount(mounts);
      const playing = (src && byPath.get(src.path)) ?? (def && byPath.get(def.path)) ?? visible.map((m) => byPath.get(m.path)).find(Boolean);
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

  app.get(
    '/stations/:slug/nowplaying',
    {
      config: { rateLimit: { max: 240, timeWindow: '1 minute' } },
      schema: {
        tags: ['Public'],
        summary: 'Now playing: the song with album art, the DJ on air, listeners, listen URLs and recently played. For live updates use /events or /ws.',
        security: [],
        params: slugParams,
        response: { 200: nowPlayingOut },
      },
    },
    async (req, reply) => {
      const np = await hub.current(req.params.slug.toLowerCase());
      if (!np) throw notFound('Station');
      reply.header('cache-control', 'public, max-age=3');
      return np;
    },
  );

  app.get(
    '/stations/:slug/history',
    {
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
      schema: {
        tags: ['Public'],
        summary: 'Recently played titles, newest first',
        security: [],
        params: slugParams,
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(50).optional() }),
        response: { 200: z.object({ items: z.array(songOut.extend({ playedAt: z.string() })) }) },
      },
    },
    async (req, reply) => {
      const s = await station(req.params.slug);
      if (!s.settings.showHistory) return { items: [] };
      const mounts = await ctx.db.select().from(schema.stationMounts).where(eq(schema.stationMounts.stationId, s.id));
      const base = (await connectionInfo(ctx, s, [], false)).listenBase;
      reply.header('cache-control', 'public, max-age=10');
      const limit = Math.min(req.query.limit ?? s.settings.historyCount, s.settings.historyCount);
      return { items: await recentlyPlayed(ctx, hub.artwork, s, base, limit, titleMount(mounts)?.path ?? null) };
    },
  );

  // Live feeds

  app.get(
    '/stations/:slug/events',
    {
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: {
        tags: ['Public'],
        summary: 'Server-Sent Events: a `nowplaying` event with the same data as /nowplaying, now and on every change',
        security: [],
        params: slugParams,
      },
    },
    async (req, reply) => {
      const slug = req.params.slug.toLowerCase();
      if (!(await hub.current(slug))) throw notFound('Station');
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
        'access-control-allow-origin': '*',
      });
      res.write('retry: 5000\n\n');
      const send = (np: NowPlaying | null) => {
        if (np) res.write(`event: nowplaying\ndata: ${JSON.stringify(np)}\n\n`);
        else res.write('event: gone\ndata: {}\n\n');
      };
      const unsubscribe = await hub.subscribe(slug, send);
      const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
      req.raw.on('close', () => {
        clearInterval(ping);
        unsubscribe();
      });
    },
  );

  app.get(
    '/ws',
    {
      websocket: true,
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: {
        tags: ['Public'],
        summary:
          'WebSocket with now playing. Pass ?station=a,b or send {"subscribe":"slug"} / {"unsubscribe":"slug"}; you get {"type":"nowplaying","station":"slug","data":{…}} now and on every change.',
        security: [],
        querystring: z.object({ station: z.string().max(500).optional() }),
      },
    },
    (socket: WebSocket, req) => {
      const subs = new Map<string, Promise<() => void>>();
      const send = (msg: unknown) => socket.readyState === socket.OPEN && socket.send(JSON.stringify(msg));
      const subscribe = (raw: string) => {
        const slug = raw.trim().toLowerCase();
        if (!/^[a-z0-9-]{1,48}$/.test(slug) || subs.has(slug) || subs.size >= 20) return;
        subs.set(slug, hub.subscribe(slug, (np) => send(np ? { type: 'nowplaying', station: slug, data: np } : { type: 'gone', station: slug })));
      };
      const unsubscribe = (slug: string) => {
        void subs.get(slug)?.then((off) => off());
        subs.delete(slug);
      };
      for (const slug of ((req.query as { station?: string }).station ?? '').split(',').filter(Boolean)) subscribe(slug);
      const ping = setInterval(() => socket.readyState === socket.OPEN && socket.ping(), 30_000);
      socket.on('message', (data: Buffer) => {
        try {
          const msg = JSON.parse(String(data)) as { subscribe?: string; unsubscribe?: string };
          if (typeof msg.subscribe === 'string') subscribe(msg.subscribe);
          if (typeof msg.unsubscribe === 'string') unsubscribe(msg.unsubscribe.toLowerCase());
        } catch {
          send({ type: 'error', message: 'Send JSON like {"subscribe":"my-station"}' });
        }
      });
      socket.on('close', () => {
        clearInterval(ping);
        for (const slug of [...subs.keys()]) unsubscribe(slug);
      });
    },
  );

  // Images

  app.get(
    '/stations/:slug/logo',
    { schema: { tags: ['Public'], summary: 'Station logo', security: [], params: slugParams, querystring: z.object({ v: z.string().optional() }) } },
    async (req, reply) => {
      const s = await findPublicStation(ctx, req.params.slug);
      if (!s?.logoFile) throw notFound('Logo');
      const ext = s.logoFile.split('.').pop()!;
      return sendFile(reply, join(publicDir(ctx, s.id), s.logoFile), LOGO_TYPES[ext] ?? 'application/octet-stream', undefined, req.query.v ? 'public, max-age=31536000, immutable' : 'public, max-age=300');
    },
  );

  app.get(
    '/artwork/:file',
    { schema: { tags: ['Public'], summary: 'Cached album art', security: [], params: z.object({ file: z.string().regex(/^[0-9a-f]{32}\.jpg$/) }) } },
    async (req, reply) => sendFile(reply, join(artworkDir(ctx), req.params.file), 'image/jpeg', undefined, 'public, max-age=2592000, immutable'),
  );

  // On demand

  const audioUrl = (base: string, slug: string, id: string) => `${base}/api/public/stations/${slug}/ondemand/${id}/audio`;

  app.get(
    '/stations/:slug/ondemand',
    {
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
      schema: {
        tags: ['Public'],
        summary: 'Published on-demand items (recorded shows and uploaded files), newest first',
        security: [],
        params: slugParams,
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), offset: z.coerce.number().int().min(0).default(0) }),
        response: { 200: z.object({ items: z.array(onDemandOut), total: z.number().int() }) },
      },
    },
    async (req, reply) => {
      const s = await station(req.params.slug);
      if (!s.settings.onDemand.enabled) return { items: [], total: 0 };
      const where = and(eq(schema.onDemandItems.stationId, s.id), isNotNull(schema.onDemandItems.publishedAt));
      const [rows, [total]] = await Promise.all([
        ctx.db
          .select()
          .from(schema.onDemandItems)
          .where(where)
          .orderBy(desc(sql`coalesce(${schema.onDemandItems.recordedAt}, ${schema.onDemandItems.publishedAt})`))
          .limit(req.query.limit)
          .offset(req.query.offset),
        ctx.db.select({ n: count() }).from(schema.onDemandItems).where(where),
      ]);
      const base = (await connectionInfo(ctx, s, [], false)).listenBase;
      reply.header('cache-control', 'public, max-age=30');
      return { items: rows.map((r) => ({ ...r, audioUrl: audioUrl(base, s.slug, r.id) })), total: total?.n ?? 0 };
    },
  );

  app.get(
    '/stations/:slug/ondemand/:id/audio',
    { schema: { tags: ['Public'], summary: 'The audio of an on-demand item (supports byte ranges)', security: [], params: slugParams.extend({ id: z.uuid() }) } },
    async (req, reply) => {
      const s = await station(req.params.slug);
      const [item] = await ctx.db
        .select()
        .from(schema.onDemandItems)
        .where(and(eq(schema.onDemandItems.id, req.params.id), eq(schema.onDemandItems.stationId, s.id), isNotNull(schema.onDemandItems.publishedAt)));
      if (!item || !s.settings.onDemand.enabled) throw notFound('Item');
      const range = req.headers.range;
      // Count a play once, on the first request of the file (not on every seek).
      if (!range || /^bytes=0-/.test(range)) {
        void ctx.db.update(schema.onDemandItems).set({ plays: sql`${schema.onDemandItems.plays} + 1` }).where(eq(schema.onDemandItems.id, item.id)).catch(() => undefined);
      }
      return sendFile(reply, itemPath(ctx, s.id, item.file), item.contentType, range, 'public, max-age=3600');
    },
  );

  // Song requests

  app.post(
    '/stations/:slug/requests',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 hour' } },
      schema: {
        tags: ['Public'],
        summary: 'Request a song. Only when the station takes requests (and, if it says so, while a DJ is live).',
        security: [],
        params: slugParams,
        body: z.object({
          artist: z.string().trim().min(1).max(120),
          title: z.string().trim().min(1).max(160),
          message: z.string().trim().max(300).default(''),
          name: z.string().trim().max(60).default(''),
          /** Left empty by people; bots fill it in. */
          website: z.string().max(200).optional(),
        }),
        response: { 200: z.object({ ok: z.literal(true), id: z.uuid().nullable() }) },
      },
    },
    async (req) => {
      const s = await station(req.params.slug);
      const r = s.settings.requests;
      if (!r.enabled) throw new HttpError(403, 'requests_off', 'This station does not take requests');
      const np = await hub.current(s.slug);
      if (r.onlyWhenLive && !np?.live) throw new HttpError(403, 'requests_closed', 'Requests are open while a DJ is on air');
      // Pretend success to bots, so they do not try something else.
      if (req.body.website) return { ok: true as const, id: null };
      const hash = requesterHash(ctx.config.APP_SECRET, req.ip);
      const [recent] = await ctx.db
        .select({ n: count() })
        .from(schema.songRequests)
        .where(and(eq(schema.songRequests.stationId, s.id), eq(schema.songRequests.requesterHash, hash), gt(schema.songRequests.createdAt, new Date(Date.now() - 3600_000))));
      if ((recent?.n ?? 0) >= r.perHour) throw new HttpError(429, 'too_many_requests', `You can send ${r.perHour} requests per hour`);
      const strip = (v: string) => v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
      if (!strip(req.body.artist) || !strip(req.body.title)) throw badRequest('Fill in the artist and the title');
      const [row] = await ctx.db
        .insert(schema.songRequests)
        .values({
          stationId: s.id,
          artist: strip(req.body.artist),
          title: strip(req.body.title),
          message: strip(req.body.message),
          requesterName: strip(req.body.name),
          requesterHash: hash,
        })
        .returning({ id: schema.songRequests.id });
      return { ok: true as const, id: row!.id };
    },
  );
};

const esc = (v: string) => v.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * The public page shell with the station's name, description and image filled in, so links shared on social media
 * and in chat apps get a proper preview. Unknown stations get the plain shell (the page shows "not found" itself).
 */
export async function renderPublicShell(ctx: AppContext, html: string, slug: string, embed: boolean): Promise<string> {
  const s = /^[a-z0-9-]{1,48}$/.test(slug) ? await findPublicStation(ctx, slug).catch(() => null) : null;
  if (!s || !s.settings.enabled) return html;
  const base = (await connectionInfo(ctx, s, [], false)).listenBase;
  const description = s.description || [s.genre, 'Live radio'].filter(Boolean).join(' · ');
  const image = s.logoFile ? `${base}/api/public/stations/${s.slug}/logo?v=${encodeURIComponent(s.logoFile)}` : `${base}/brand/rhis-icon.svg`;
  const meta = [
    `<meta name="description" content="${esc(description)}" />`,
    `<meta property="og:type" content="music.radio_station" />`,
    `<meta property="og:title" content="${esc(s.name)}" />`,
    `<meta property="og:description" content="${esc(description)}" />`,
    `<meta property="og:url" content="${esc(`${base}/public/${s.slug}`)}" />`,
    `<meta property="og:image" content="${esc(image)}" />`,
    `<meta name="twitter:card" content="summary" />`,
    `<meta name="theme-color" content="${esc(s.settings.accentColor)}" />`,
    `<link rel="alternate" type="application/json" href="${esc(`${base}/api/public/stations/${s.slug}/nowplaying`)}" />`,
    embed ? '<meta name="robots" content="noindex" />' : '',
  ].join('\n    ');
  return html.replace(/<title>[^<]*<\/title>/, `<title>${esc(s.name)}</title>\n    ${meta}`);
}
