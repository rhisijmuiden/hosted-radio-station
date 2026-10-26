import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { AppContext } from '../lib/context.js';
import { HttpError } from '../lib/errors.js';
import { hostAllowed } from '../services/streaming/domains.js';
import { deniedLogin, sftpgoLogin, stationIdsForLogins } from '../services/streaming/sftpgo.js';
import { scanStationStorage } from '../services/streaming/storage.js';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * Hooks for local services (Caddy, SFTPGo). Only direct connections from this machine are accepted: the web server
 * blocks /api/internal/ and always adds X-Forwarded-For, so proxied requests never pass.
 */
function requireInternal(req: FastifyRequest) {
  if (!LOOPBACK.has(req.socket.remoteAddress ?? '') || req.headers['x-forwarded-for']) {
    throw new HttpError(404, 'not_found', 'Not found');
  }
}

/** Rescans a station's media folder shortly after uploads stop, so a burst of files triggers one scan. */
function storageRescanner(ctx: AppContext) {
  const timers = new Map<string, NodeJS.Timeout>();
  return (stationId: string) => {
    clearTimeout(timers.get(stationId));
    timers.set(
      stationId,
      setTimeout(() => {
        timers.delete(stationId);
        void scanStationStorage(ctx, stationId).catch(() => undefined);
      }, 10_000).unref(),
    );
  };
}

export const internalRoutes: FastifyPluginAsyncZod = async (app) => {
  const { ctx } = app;
  const rescan = storageRescanner(ctx);

  app.get(
    '/tls-ask',
    { schema: { hide: true, querystring: z.object({ domain: z.string().max(253) }) } },
    async (req, reply) => {
      requireInternal(req);
      const ok = await hostAllowed(ctx, req.query.domain);
      return reply.status(ok ? 200 : 404).send(ok ? 'ok' : 'unknown');
    },
  );

  app.post(
    '/sftpgo/auth',
    {
      schema: {
        hide: true,
        body: z
          .object({ username: z.string().max(200), password: z.string().max(500).default(''), ip: z.string().optional(), protocol: z.string().optional(), user: z.object({ used_quota_size: z.number().optional() }).passthrough().nullish() })
          .passthrough(),
      },
    },
    async (req) => {
      requireInternal(req);
      const user = await sftpgoLogin(ctx, req.body.username, req.body.password, req.body.user?.used_quota_size ?? 0).catch((err) => {
        req.log.error({ err }, 'upload log-in check failed');
        return null;
      });
      return user ?? deniedLogin;
    },
  );

  app.post(
    '/sftpgo/event',
    { schema: { hide: true, body: z.object({ action: z.string().optional(), username: z.string().optional() }).passthrough() } },
    async (req) => {
      requireInternal(req);
      if (req.body.username) for (const id of await stationIdsForLogins(ctx, [req.body.username])) rescan(id);
      return { ok: true };
    },
  );
};
