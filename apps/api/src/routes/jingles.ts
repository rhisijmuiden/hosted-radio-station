import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import fastifyMultipart from '@fastify/multipart';
import { and, asc, eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { schema } from '../db/index.js';
import type { AppContext } from '../lib/context.js';
import { badRequest, notFound } from '../lib/errors.js';
import { okOut } from '../lib/schemas.js';
import { MEDIA_EXTENSIONS } from '../services/autodj/library.js';
import { AUDIO_TYPES } from '../services/public/ondemand.js';
import { stationDir } from '../services/streaming/icecast.js';
import { sendFile } from './public.js';
import { stationAccess } from './stations.js';

/** Six buttons on a page, at most eight pages. */
export const JINGLE_BUTTONS = 48;
const MAX_BYTES = 25 * 1024 * 1024;
const COLOR = z.string().regex(/^#[0-9a-fA-F]{6}$/);

const jingleOut = z.object({ id: z.uuid(), position: z.number().int(), label: z.string(), color: z.string(), looped: z.boolean(), ext: z.string(), size: z.number().int() });
const params = z.object({ id: z.uuid() });
const jingleParams = params.extend({ jingleId: z.uuid() });

type Jingle = typeof schema.studioJingles.$inferSelect;
const toOut = (j: Jingle) => ({ id: j.id, position: j.position, label: j.label, color: j.color, looped: j.looped, ext: j.ext, size: j.size });
/** Jingles live with the station (removed with it), apart from its media folder: not in the library, not on SFTP. */
const jingleFile = (ctx: AppContext, j: Pick<Jingle, 'stationId' | 'userId' | 'id' | 'ext'>) => join(stationDir(ctx, j.stationId), 'jingles', j.userId, `${j.id}.${j.ext}`);

/**
 * The jingle buttons of RHIS Studio (phase 17): every DJ keeps their own jingles per station on the server, so the
 * buttons are the same on every studio PC. The client downloads them and plays them itself, mixed into its broadcast.
 * These routes stay on this server, also for a station on a station node.
 */
export const jingleRoutes: FastifyPluginAsyncZod = async (app) => {
  const { ctx } = app;
  await app.register(fastifyMultipart, { limits: { fileSize: MAX_BYTES, files: 1, fields: 5 } });

  const mine = async (stationId: string, userId: string) =>
    ctx.db
      .select()
      .from(schema.studioJingles)
      .where(and(eq(schema.studioJingles.stationId, stationId), eq(schema.studioJingles.userId, userId)))
      .orderBy(asc(schema.studioJingles.position));

  async function one(req: Parameters<typeof stationAccess>[1], stationId: string, jingleId: string) {
    const { station, access } = await stationAccess(ctx, req, stationId, 'dj');
    const [j] = await ctx.db
      .select()
      .from(schema.studioJingles)
      .where(and(eq(schema.studioJingles.id, jingleId), eq(schema.studioJingles.stationId, station.id), eq(schema.studioJingles.userId, access.user.id)));
    if (!j) throw notFound('Jingle');
    return j;
  }

  app.get(
    '/stations/:id/jingles',
    { schema: { tags: ['Studio client'], summary: 'Your jingle buttons for this station', params, response: { 200: z.array(jingleOut) } } },
    async (req) => {
      const { station, access } = await stationAccess(ctx, req, req.params.id, 'dj');
      return (await mine(station.id, access.user.id)).map(toOut);
    },
  );

  app.post(
    '/stations/:id/jingles',
    {
      config: { audit: 'studio.jingle.upload' },
      schema: {
        tags: ['Studio client'],
        summary: `Put an audio file (multipart, field "files", at most ${MAX_BYTES / 1024 / 1024} MB) on one of your jingle buttons; a jingle already there is replaced`,
        params,
        querystring: z.object({ position: z.coerce.number().int().min(0).max(JINGLE_BUTTONS - 1), color: COLOR.optional() }),
        response: { 200: jingleOut },
      },
    },
    async (req) => {
      const { station, access } = await stationAccess(ctx, req, req.params.id, 'dj');
      const part = await req.file();
      if (!part) throw badRequest('No file');
      const name = part.filename.split(/[\\/]/).pop()!.replace(/[\0\r\n]/g, '').trim();
      const ext = extname(name).toLowerCase();
      if (!MEDIA_EXTENSIONS.has(ext)) {
        part.file.resume();
        throw badRequest('Not an audio file');
      }
      const id = crypto.randomUUID();
      const row = { id, stationId: station.id, userId: access.user.id, ext: ext.slice(1) };
      const target = jingleFile(ctx, row);
      await mkdir(join(target, '..'), { recursive: true, mode: 0o750 });
      const tmp = `${target}.upload`;
      await pipeline(part.file, createWriteStream(tmp, { mode: 0o640 }));
      if (part.file.truncated) {
        await rm(tmp, { force: true });
        throw badRequest(`A jingle can be at most ${MAX_BYTES / 1024 / 1024} MB`);
      }
      await rename(tmp, target);
      const size = (await stat(target)).size;
      const old = (await mine(station.id, access.user.id)).find((j) => j.position === req.query.position);
      const label = name.slice(0, -ext.length).slice(0, 40) || 'Jingle';
      const saved = await ctx.db.transaction(async (tx) => {
        if (old) await tx.delete(schema.studioJingles).where(eq(schema.studioJingles.id, old.id));
        const [j] = await tx
          .insert(schema.studioJingles)
          .values({ ...row, position: req.query.position, label, color: req.query.color ?? old?.color ?? '#FF6B57', looped: false, size })
          .returning();
        return j!;
      });
      if (old) await rm(jingleFile(ctx, old), { force: true });
      Object.assign(req.auditInfo, { targetType: 'studio_jingle', targetId: saved.id, details: { station: station.slug, position: saved.position, label } });
      return toOut(saved);
    },
  );

  app.patch(
    '/stations/:id/jingles/:jingleId',
    {
      schema: {
        tags: ['Studio client'],
        summary: 'Rename, recolour or loop a jingle, or move it to another button (a jingle there swaps places)',
        params: jingleParams,
        body: z.object({
          label: z.string().trim().min(1).max(40).optional(),
          color: COLOR.optional(),
          looped: z.boolean().optional(),
          position: z.number().int().min(0).max(JINGLE_BUTTONS - 1).optional(),
        }),
        response: { 200: z.array(jingleOut) },
      },
    },
    async (req) => {
      const j = await one(req, req.params.id, req.params.jingleId);
      const { position, ...rest } = req.body;
      await ctx.db.transaction(async (tx) => {
        if (position !== undefined && position !== j.position) {
          const where = (p: number) => and(eq(schema.studioJingles.stationId, j.stationId), eq(schema.studioJingles.userId, j.userId), eq(schema.studioJingles.position, p));
          // Park this one outside the buttons, so the unique index allows the swap.
          await tx.update(schema.studioJingles).set({ position: -1 }).where(eq(schema.studioJingles.id, j.id));
          await tx.update(schema.studioJingles).set({ position: j.position }).where(where(position));
          await tx.update(schema.studioJingles).set({ position }).where(eq(schema.studioJingles.id, j.id));
        }
        if (Object.keys(rest).length) await tx.update(schema.studioJingles).set(rest).where(eq(schema.studioJingles.id, j.id));
      });
      return (await mine(j.stationId, j.userId)).map(toOut);
    },
  );

  app.delete(
    '/stations/:id/jingles/:jingleId',
    { config: { audit: 'studio.jingle.delete' }, schema: { tags: ['Studio client'], summary: 'Empty a jingle button', params: jingleParams, response: { 200: okOut } } },
    async (req) => {
      const j = await one(req, req.params.id, req.params.jingleId);
      await ctx.db.delete(schema.studioJingles).where(eq(schema.studioJingles.id, j.id));
      await rm(jingleFile(ctx, j), { force: true });
      Object.assign(req.auditInfo, { targetType: 'studio_jingle', targetId: j.id, details: { label: j.label } });
      return { ok: true as const };
    },
  );

  app.get(
    '/stations/:id/jingles/:jingleId/audio',
    { schema: { tags: ['Studio client'], summary: 'The audio file of a jingle (the client keeps a copy)', params: jingleParams } },
    async (req, reply) => {
      const j = await one(req, req.params.id, req.params.jingleId);
      return sendFile(reply, jingleFile(ctx, j), AUDIO_TYPES[`.${j.ext}`] ?? 'application/octet-stream', req.headers.range, 'private, max-age=31536000, immutable');
    },
  );
};
