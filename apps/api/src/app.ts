import fastifyCookie from '@fastify/cookie';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import fastifyWebsocket from '@fastify/websocket';
import Fastify from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { Redis } from 'ioredis';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { registerAudit } from './lib/audit.js';
import { registerAuth, API_KEY_PREFIX, SESSION_COOKIE } from './lib/auth.js';
import type { AppContext } from './lib/context.js';
import { HttpError } from './lib/errors.js';
import { apiKeyRoutes } from './routes/api-keys.js';
import { auditRoutes } from './routes/audit.js';
import { authRoutes } from './routes/auth.js';
import { backupRoutes } from './routes/backups.js';
import { billingRoutes, tenantBillingRoutes } from './routes/billing.js';
import { billingPublicRoutes } from './routes/billing-public.js';
import { provisioningRoutes } from './routes/provisioning.js';
import { tenantStreamingRoutes } from './routes/domains.js';
import { healthRoutes } from './routes/health.js';
import { internalRoutes } from './routes/internal.js';
import { publicRoutes, renderPublicShell } from './routes/public.js';
import { autodjRoutes } from './routes/autodj.js';
import { schedulerRoutes } from './routes/scheduler.js';
import { stationPublicRoutes } from './routes/station-public.js';
import { settingsRoutes } from './routes/settings.js';
import { ssoAdminRoutes, ssoAuthRoutes } from './routes/sso.js';
import { stationRoutingRoutes } from './routes/station-routing.js';
import { stationRoutes } from './routes/stations.js';
import { statsRoutes } from './routes/stats.js';
import { jingleRoutes } from './routes/jingles.js';
import { studioRoutes } from './routes/studio.js';
import { systemRoutes } from './routes/system.js';
import { tenantRoutes } from './routes/tenants.js';
import { userRoutes } from './routes/users.js';
import { NowPlayingHub } from './services/public/hub.js';
import { NodeHub } from './services/nodes/hub.js';
import { NodeUpdater } from './services/nodes/updates.js';
import { forgetMissingStations } from './services/nodes/routing.js';
import { listenRedirectRoutes, nodeAgentRoutes, nodeRoutes } from './routes/nodes.js';
import { orchestratorRoutes, stationConnectionRoutes } from './routes/orchestrator.js';
import { stationNodeAgentRoutes, stationPlacementRoutes, tenantStationNodeRoutes } from './routes/station-nodes.js';
import { stationNodeInternalRoutes } from './routes/station-node-internal.js';
import { StationTunnels } from './services/stationnode/hub.js';
import { StationNodeLink } from './services/stationnode/link.js';
import { registerStationProxy } from './services/stationnode/proxy.js';
import { runningVersion } from './services/system.js';

declare module 'fastify' {
  interface FastifyInstance {
    nowPlaying: NowPlayingHub;
    nodes: NodeHub;
    nodeUpdates: NodeUpdater;
    stationTunnels: StationTunnels;
    /** On a station node: the link with the main server (started by server.ts). */
    stationNode: StationNodeLink | null;
  }
}

export async function buildApp(ctx: AppContext) {
  const { config } = ctx;
  const app = Fastify({
    logger: config.NODE_ENV === 'test' ? false : { level: config.LOG_LEVEL },
    // Only trusted proxies may set X-Forwarded-For, so listener IPs (and later GeoIP) stay correct.
    trustProxy: config.TRUSTED_PROXIES.split(',').map((s) => s.trim()).filter(Boolean),
    bodyLimit: 1024 * 1024,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  // A proxy (Cloudflare) can pass an empty POST on as a chunked request without a content type, which Fastify
  // answers with 415. Such a request has no body: accept it. Anything with a body or an unknown type stays 415.
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (req, body, done) => {
    if (!req.headers['content-type'] && (body as Buffer).length === 0) return done(null, undefined);
    const err = new Error('Unsupported Media Type') as Error & { statusCode: number };
    err.statusCode = 415;
    done(err, undefined);
  });
  app.decorate('ctx', ctx);
  const hub = new NowPlayingHub(ctx, app.log);
  app.decorate('nowPlaying', hub);
  hub.start();
  app.addHook('onClose', async () => hub.stop());
  // Nodes still pointing at a station that is gone get their lists cleaned before their plans go out.
  await forgetMissingStations(ctx).catch((err) => app.log.warn({ err }, 'cleaning up node station lists failed'));
  const nodeHub = new NodeHub(ctx, app.log);
  app.decorate('nodes', nodeHub);
  await nodeHub.start();
  // Before @fastify/websocket closes the sockets (its own preClose comes later, it is registered later).
  app.addHook('preClose', async () => nodeHub.announceRestart());
  app.addHook('onClose', async () => nodeHub.stop());
  const nodeUpdates = new NodeUpdater(ctx, nodeHub, app.log);
  app.decorate('nodeUpdates', nodeUpdates);
  await nodeUpdates.start();
  app.addHook('onClose', async () => nodeUpdates.stop());
  const tunnels = new StationTunnels(app.log);
  app.decorate('stationTunnels', tunnels);
  // Before the server waits for its connections to end: tunnels stay open otherwise.
  app.addHook('preClose', async () => tunnels.stop());
  const link = config.STATION_NODE ? new StationNodeLink(ctx, app.log) : null;
  app.decorate('stationNode', link);
  app.addHook('onClose', async () => link?.stop());

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } });
    }
    if (hasZodFastifySchemaValidationErrors(err)) {
      const first = err.validation[0];
      const field = first?.instancePath?.replace(/^\//, '').replaceAll('/', '.') || undefined;
      return reply.status(400).send({
        error: { code: 'validation', message: first?.message ?? 'Invalid request', field },
      });
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) req.log.error(err);
    return reply.status(status).send({
      error: { code: status === 429 ? 'rate_limited' : 'error', message: status >= 500 ? 'Internal server error' : (err as Error).message },
    });
  });

  await app.register(fastifyCookie);
  await app.register(fastifyWebsocket, {
    // Node agents send their health with problems and FM status in one message; station node tunnels carry body data
    // in frames of up to 128 KiB (phase 12).
    options: { maxPayload: 256 * 1024 },
    // A client that breaks the protocol (e.g. "Invalid WebSocket frame: invalid status code 1006" from a browser that
    // went away) is the client's problem, not an error of this server.
    errorHandler: (err, socket, req) => {
      const code = (err as { code?: string }).code;
      if (code?.startsWith('WS_ERR_')) req.log.warn({ err: err.message, code }, 'websocket client error');
      else req.log.error(err);
      socket.terminate();
    },
  });
  await app.register(fastifyRateLimit, {
    global: false,
    redis: config.REDIS_URL ? new Redis(config.REDIS_URL, { lazyConnect: false, maxRetriesPerRequest: 1 }) : undefined,
    nameSpace: 'hrs-rl-',
  });

  // Read once now: the version this process runs (see runningVersion).
  const { version } = await runningVersion(ctx);
  await app.register(fastifySwagger, {
    openapi: {
      info: {
        title: 'Hosted Radio Station API',
        version,
        description:
          'Everything the admin panel does is available here. Authenticate with an API key: `Authorization: Bearer hrs_...`.',
      },
      components: {
        securitySchemes: {
          apiKey: { type: 'http', scheme: 'bearer', description: `API key starting with "${API_KEY_PREFIX}"` },
          session: { type: 'apiKey', in: 'cookie', name: SESSION_COOKIE },
        },
      },
      security: [{ apiKey: [] }, { session: [] }],
    },
    transform: jsonSchemaTransform,
  });
  await app.register(fastifySwaggerUi, { routePrefix: '/api/docs' });
  app.get('/api/openapi.json', { schema: { hide: true } }, async () => app.swagger());

  registerAuth(app);
  registerAudit(app);
  // Requests for stations that run on a station node go to that node (phase 12).
  if (!config.STATION_NODE) registerStationProxy(app, tunnels);
  await app.register(healthRoutes, { prefix: '/api' });
  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(ssoAuthRoutes, { prefix: '/api/auth/sso' });
  await app.register(tenantRoutes, { prefix: '/api/tenants' });
  await app.register(ssoAdminRoutes, { prefix: '/api/tenants' });
  await app.register(userRoutes, { prefix: '/api/users' });
  await app.register(apiKeyRoutes, { prefix: '/api/api-keys' });
  await app.register(settingsRoutes, { prefix: '/api/settings' });
  await app.register(systemRoutes, { prefix: '/api/system' });
  await app.register(backupRoutes, { prefix: '/api/backups' });
  await app.register(auditRoutes, { prefix: '/api/audit' });
  await app.register(stationRoutes, { prefix: '/api/stations' });
  await app.register(stationPublicRoutes, { prefix: '/api/stations' });
  await app.register(autodjRoutes, { prefix: '/api/stations' });
  await app.register(schedulerRoutes, { prefix: '/api/stations' });
  await app.register(tenantStreamingRoutes, { prefix: '/api/tenants' });
  await app.register(statsRoutes, { prefix: '/api/stats' });
  await app.register(studioRoutes, { prefix: '/api/studio' });
  await app.register(jingleRoutes, { prefix: '/api/studio' });
  await app.register(publicRoutes, { prefix: '/api/public' });
  await app.register(listenRedirectRoutes, { prefix: '/api/public' });
  await app.register(billingPublicRoutes, { prefix: '/api/public' });
  await app.register(billingRoutes, { prefix: '/api/billing' });
  await app.register(tenantBillingRoutes, { prefix: '/api/tenants' });
  await app.register(provisioningRoutes, { prefix: '/api/provisioning' });
  await app.register(nodeAgentRoutes, { prefix: '/api/nodes' });
  await app.register(orchestratorRoutes, { prefix: '/api/nodes' });
  await app.register(nodeRoutes, { prefix: '/api/nodes' });
  await app.register(stationNodeAgentRoutes, { prefix: '/api/nodes/agent/station' });
  await app.register(stationPlacementRoutes, { prefix: '/api/stations' });
  await app.register(stationRoutingRoutes, { prefix: '/api/stations' });
  await app.register(stationConnectionRoutes, { prefix: '/api/stations' });
  await app.register(tenantStationNodeRoutes, { prefix: '/api/tenants' });
  await app.register(internalRoutes, { prefix: '/api/internal' });
  if (link) await app.register(stationNodeInternalRoutes, { prefix: '/api/internal/station-node', link });

  // In production the API also serves the built admin panel (single-page app).
  const webDist = config.WEB_DIST ? resolve(config.WEB_DIST) : null;
  if (webDist && existsSync(webDist)) {
    await app.register(fastifyStatic, {
      root: webDist,
      // Hashed build assets never change; index.html must always be fresh.
      setHeaders: (res, path) => res.header('cache-control', path.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache'),
    });
    // Public station pages and widgets have their own, much smaller app (public.html).
    const publicShell = resolve(webDist, 'public.html');
    app.setNotFoundHandler(async (req, reply) => {
      const pub = req.url.match(/^\/public\/([^/?#]+)(\/embed\/)?/);
      if ((req.method === 'GET' || req.method === 'HEAD') && pub && existsSync(publicShell)) {
        const html = await renderPublicShell(ctx, await readFile(publicShell, 'utf8'), pub[1]!.toLowerCase(), !!pub[2]);
        return reply.header('cache-control', 'no-cache').type('text/html; charset=utf-8').send(html);
      }
      if ((req.method === 'GET' || req.method === 'HEAD') && !req.url.startsWith('/api/') && !req.url.startsWith('/assets/')) return reply.sendFile('index.html');
      return reply.status(404).send({ error: { code: 'not_found', message: 'Not found' } });
    });
  } else {
    app.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: { code: 'not_found', message: 'Not found' } }));
  }

  return app;
}

export type App = Awaited<ReturnType<typeof buildApp>>;
