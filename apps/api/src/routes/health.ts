import { sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

const healthOut = z.object({ status: z.enum(['ok', 'degraded']), database: z.boolean() });

export const healthRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/health',
    {
      schema: {
        tags: ['System'],
        summary: 'Health check for monitoring and the reverse proxy',
        security: [],
        response: { 200: healthOut, 503: healthOut },
      },
    },
    async (_req, reply) => {
      const database = await app.ctx.db
        .execute(sql`select 1`)
        .then(() => true)
        .catch(() => false);
      if (!database) reply.status(503);
      return { status: database ? ('ok' as const) : ('degraded' as const), database };
    },
  );
};
