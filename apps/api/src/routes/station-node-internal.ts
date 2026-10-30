import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { TUNNEL_CALL_TOKEN } from '../lib/auth.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { importShow, showImportSchema } from '../services/recorder/ondemand.js';
import { mediaDir } from '../services/streaming/icecast.js';
import { insideRoot, listFiles } from '../services/stationnode/files.js';
import type { StationNodeLink } from '../services/stationnode/link.js';

const params = z.object({ id: z.uuid() });

/**
 * Requests of the main server itself to this station node, through the tunnel only: the library of a station that
 * moves back, a last full report of its tables, and shows of a recorder node that become on-demand items here.
 * Mounted under /api/internal/station-node on station nodes.
 */
export const stationNodeInternalRoutes: FastifyPluginAsyncZod<{ link: StationNodeLink }> = async (app, opts) => {
  app.addHook('onRequest', async (req) => {
    if (req.headers['x-hrs-tunnel'] !== TUNNEL_CALL_TOKEN || req.headers['x-hrs-tunnel-system'] !== '1') throw forbidden();
  });

  app.get('/files/:id', { schema: { hide: true, params } }, async (req) => ({ files: await listFiles(mediaDir(app.ctx, req.params.id)) }));

  app.get('/files/:id/file', { schema: { hide: true, params, querystring: z.object({ path: z.string().min(1).max(1000) }) } }, async (req, reply) => {
    let full: string;
    try {
      full = insideRoot(mediaDir(app.ctx, req.params.id), req.query.path);
    } catch {
      throw badRequest('Invalid path');
    }
    const st = await stat(full).catch(() => null);
    if (!st?.isFile()) throw notFound('File');
    return reply.header('content-length', st.size).type('application/octet-stream').send(createReadStream(full));
  });

  // A show of a recorder node (phase 21 step 3): the body is the audio, passed on as it comes in.
  app.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload));
  app.put('/ondemand/:id', { bodyLimit: 4 * 1024 ** 3, schema: { hide: true, params, querystring: showImportSchema } }, async (req) => {
    try {
      return { result: await importShow(app.ctx, req.params.id, req.query, req.body as Readable) };
    } catch (err) {
      throw badRequest((err as Error).message);
    }
  });

  app.post('/flush/:id', { schema: { hide: true, params } }, async () => {
    await opts.link.mirror(true);
    return { ok: true as const };
  });
};
