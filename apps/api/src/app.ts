import fastifyCookie from '@fastify/cookie';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
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
import { resolve } from 'node:path';
import { registerAudit } from './lib/audit.js';
import { registerAuth, API_KEY_PREFIX, SESSION_COOKIE } from './lib/auth.js';
import type { AppContext } from './lib/context.js';
import { HttpError } from './lib/errors.js';
import { apiKeyRoutes } from './routes/api-keys.js';
import { auditRoutes } from './routes/audit.js';
import { authRoutes } from './routes/auth.js';
import { backupRoutes } from './routes/backups.js';
import { tenantStreamingRoutes } from './routes/domains.js';
import { healthRoutes } from './routes/health.js';
import { internalRoutes } from './routes/internal.js';
import { publicRoutes } from './routes/public.js';
import { settingsRoutes } from './routes/settings.js';
import { ssoAdminRoutes, ssoAuthRoutes } from './routes/sso.js';
import { stationRoutes } from './routes/stations.js';
import { statsRoutes } from './routes/stats.js';
import { systemRoutes } from './routes/system.js';
import { tenantRoutes } from './routes/tenants.js';
import { userRoutes } from './routes/users.js';
import { getVersionInfo } from './services/system.js';

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
  app.decorate('ctx', ctx);

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
  await app.register(fastifyRateLimit, {
    global: false,
    redis: config.REDIS_URL ? new Redis(config.REDIS_URL, { lazyConnect: false, maxRetriesPerRequest: 1 }) : undefined,
    nameSpace: 'hrs-rl-',
  });

  const { version } = await getVersionInfo(ctx);
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
  await app.register(tenantStreamingRoutes, { prefix: '/api/tenants' });
  await app.register(statsRoutes, { prefix: '/api/stats' });
  await app.register(publicRoutes, { prefix: '/api/public' });
  await app.register(internalRoutes, { prefix: '/api/internal' });

  // In production the API also serves the built admin panel (single-page app).
  const webDist = config.WEB_DIST ? resolve(config.WEB_DIST) : null;
  if (webDist && existsSync(webDist)) {
    await app.register(fastifyStatic, {
      root: webDist,
      // Hashed build assets never change; index.html must always be fresh.
      setHeaders: (res, path) => res.header('cache-control', path.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache'),
    });
    app.setNotFoundHandler((req, reply) => {
      if ((req.method === 'GET' || req.method === 'HEAD') && !req.url.startsWith('/api/') && !req.url.startsWith('/assets/')) return reply.sendFile('index.html');
      return reply.status(404).send({ error: { code: 'not_found', message: 'Not found' } });
    });
  } else {
    app.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: { code: 'not_found', message: 'Not found' } }));
  }

  return app;
}

export type App = Awaited<ReturnType<typeof buildApp>>;
