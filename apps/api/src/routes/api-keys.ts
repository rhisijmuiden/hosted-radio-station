import { and, desc, eq, sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { schema } from '../db/index.js';
import { generateApiKey, requireTenantRole, requireUser } from '../lib/auth.js';
import { forbidden, notFound } from '../lib/errors.js';
import { idParam, okOut } from '../lib/schemas.js';

const keyOut = z.object({
  id: z.uuid(),
  name: z.string(),
  prefix: z.string(),
  tenantId: z.uuid().nullable(),
  tenantName: z.string().nullable(),
  readOnly: z.boolean(),
  scope: z.enum(['full', 'provisioning']),
  lastUsedAt: z.date().nullable(),
  expiresAt: z.date().nullable(),
  createdAt: z.date(),
});

/** Personal API keys. A key acts as its owner, optionally limited to one customer and/or read-only. */
export const apiKeyRoutes: FastifyPluginAsyncZod = async (app) => {
  const { ctx } = app;

  const select = () =>
    ctx.db
      .select({
        id: schema.apiKeys.id,
        name: schema.apiKeys.name,
        prefix: schema.apiKeys.prefix,
        tenantId: schema.apiKeys.tenantId,
        tenantName: schema.tenants.name,
        readOnly: schema.apiKeys.readOnly,
        scope: sql<'full' | 'provisioning'>`${schema.apiKeys.scope}`,
        lastUsedAt: schema.apiKeys.lastUsedAt,
        expiresAt: schema.apiKeys.expiresAt,
        createdAt: schema.apiKeys.createdAt,
      })
      .from(schema.apiKeys)
      .leftJoin(schema.tenants, eq(schema.tenants.id, schema.apiKeys.tenantId));

  app.get(
    '/',
    { schema: { tags: ['API keys'], summary: 'List your API keys', response: { 200: z.array(keyOut) } } },
    async (req) => {
      const auth = requireUser(req);
      return select().where(eq(schema.apiKeys.userId, auth.user.id)).orderBy(desc(schema.apiKeys.createdAt));
    },
  );

  app.post(
    '/',
    {
      config: { audit: 'api_key.create' },
      schema: {
        tags: ['API keys'],
        summary: 'Create an API key. The secret is only returned once.',
        body: z.object({
          name: z.string().trim().min(1).max(80),
          tenantId: z.uuid().nullish(),
          readOnly: z.boolean().default(false),
          /** provisioning = only the sign-up API, for the website that sells the service (administrators only). */
          scope: z.enum(['full', 'provisioning']).default('full'),
          expiresInDays: z.number().int().min(1).max(3650).nullish(),
        }),
        response: { 201: keyOut.extend({ secret: z.string() }) },
      },
    },
    async (req, reply) => {
      const auth = requireUser(req);
      if (auth.via === 'api_key') throw forbidden('API keys can only be created from the admin panel');
      if (req.body.tenantId) await requireTenantRole(ctx, req, req.body.tenantId, 'dj');
      if (req.body.scope === 'provisioning' && (!auth.user.isSuperadmin || req.body.tenantId)) {
        throw forbidden('Provisioning keys are for administrators and not limited to a customer');
      }
      const { secret, prefix, hash } = generateApiKey();
      const [row] = await ctx.db
        .insert(schema.apiKeys)
        .values({
          userId: auth.user.id,
          tenantId: req.body.tenantId ?? null,
          name: req.body.name,
          prefix,
          hash,
          readOnly: req.body.readOnly,
          scope: req.body.scope,
          expiresAt: req.body.expiresInDays ? new Date(Date.now() + req.body.expiresInDays * 86400_000) : null,
        })
        .returning({ id: schema.apiKeys.id });
      const [key] = await select().where(eq(schema.apiKeys.id, row!.id));
      req.auditInfo = { tenantId: key!.tenantId, targetId: key!.id, details: { name: key!.name, readOnly: key!.readOnly, scope: key!.scope } };
      reply.status(201);
      return { ...key!, secret };
    },
  );

  app.delete(
    '/:id',
    { config: { audit: 'api_key.revoke' }, schema: { tags: ['API keys'], summary: 'Revoke one of your API keys', params: idParam, response: { 200: okOut } } },
    async (req) => {
      const auth = requireUser(req);
      const deleted = await ctx.db
        .delete(schema.apiKeys)
        .where(and(eq(schema.apiKeys.id, req.params.id), eq(schema.apiKeys.userId, auth.user.id)))
        .returning();
      if (!deleted.length) throw notFound('API key');
      return { ok: true as const };
    },
  );
};
