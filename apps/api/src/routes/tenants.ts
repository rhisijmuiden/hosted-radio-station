import { and, asc, count, eq, inArray } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { schema } from '../db/index.js';
import { canGrant, hashPassword, requireSuperadmin, requireTenantRole, requireUser } from '../lib/auth.js';
import { badRequest, conflict, forbidden, isUniqueViolation, notFound } from '../lib/errors.js';
import {
  emailSchema,
  idParam,
  okOut,
  passwordSchema,
  planSchema,
  roleSchema,
  slugSchema,
  tenantLimitsSchema,
  tenantOut,
  userOut,
  toUserOut,
} from '../lib/schemas.js';

const tenantWithCount = tenantOut.extend({ memberCount: z.number().int() });
const memberOut = z.object({ user: userOut, role: roleSchema, createdAt: z.date() });
const memberParams = z.object({ id: z.uuid(), userId: z.uuid() });


export const tenantRoutes: FastifyPluginAsyncZod = async (app) => {
  const { ctx } = app;

  async function memberCounts(ids: string[]) {
    if (!ids.length) return new Map<string, number>();
    const rows = await ctx.db
      .select({ tenantId: schema.memberships.tenantId, n: count() })
      .from(schema.memberships)
      .where(inArray(schema.memberships.tenantId, ids))
      .groupBy(schema.memberships.tenantId);
    return new Map(rows.map((r) => [r.tenantId, r.n]));
  }

  app.get(
    '/',
    {
      schema: {
        tags: ['Customers'],
        summary: 'List customers. Administrators see all, others see the customers they belong to.',
        response: { 200: z.array(tenantWithCount) },
      },
    },
    async (req) => {
      const auth = requireUser(req);
      let rows;
      if (auth.user.isSuperadmin && !auth.keyTenantId) {
        rows = await ctx.db.select().from(schema.tenants).orderBy(asc(schema.tenants.name));
      } else {
        const own = await ctx.db
          .select({ t: schema.tenants })
          .from(schema.memberships)
          .innerJoin(schema.tenants, eq(schema.tenants.id, schema.memberships.tenantId))
          .where(eq(schema.memberships.userId, auth.user.id))
          .orderBy(asc(schema.tenants.name));
        rows = own.map((r) => r.t);
        if (auth.keyTenantId) rows = rows.filter((t) => t.id === auth.keyTenantId);
      }
      const counts = await memberCounts(rows.map((r) => r.id));
      return rows.map((t) => ({ ...t, memberCount: counts.get(t.id) ?? 0 }));
    },
  );

  app.post(
    '/',
    {
      schema: {
        tags: ['Customers'],
        summary: 'Create a customer (administrators only). Optionally creates the owner account in one call.',
        body: z.object({
          name: z.string().trim().min(1).max(120),
          slug: slugSchema,
          plan: planSchema.default('distribution'),
          limits: tenantLimitsSchema.default(tenantLimitsSchema.parse({})),
          externalRef: z.string().trim().max(200).nullish(),
          owner: z
            .object({ email: emailSchema, name: z.string().trim().min(1).max(120), password: passwordSchema.optional() })
            .optional(),
        }),
        response: { 201: tenantWithCount },
      },
    },
    async (req, reply) => {
      requireSuperadmin(req);
      const { owner, ...data } = req.body;
      try {
        const tenant = await ctx.db.transaction(async (tx) => {
          const [t] = await tx.insert(schema.tenants).values({ ...data, externalRef: data.externalRef ?? null }).returning();
          if (owner) {
            let [user] = await tx.select().from(schema.users).where(eq(schema.users.email, owner.email));
            if (!user) {
              [user] = await tx
                .insert(schema.users)
                .values({
                  email: owner.email,
                  name: owner.name,
                  passwordHash: owner.password ? await hashPassword(owner.password) : null,
                })
                .returning();
            }
            await tx.insert(schema.memberships).values({ userId: user!.id, tenantId: t!.id, role: 'owner' });
          }
          return t!;
        });
        reply.status(201);
        return { ...tenant, memberCount: owner ? 1 : 0 };
      } catch (err) {
        if (isUniqueViolation(err)) throw conflict('A customer with this short name already exists');
        throw err;
      }
    },
  );

  app.get(
    '/:id',
    { schema: { tags: ['Customers'], summary: 'Get one customer', params: idParam, response: { 200: tenantWithCount } } },
    async (req) => {
      await requireTenantRole(ctx, req, req.params.id, 'dj');
      const [t] = await ctx.db.select().from(schema.tenants).where(eq(schema.tenants.id, req.params.id));
      if (!t) throw notFound('Customer');
      return { ...t, memberCount: (await memberCounts([t.id])).get(t.id) ?? 0 };
    },
  );

  app.patch(
    '/:id',
    {
      schema: {
        tags: ['Customers'],
        summary: 'Update a customer. Owners may rename; plan, limits and status are for administrators.',
        params: idParam,
        body: z.object({
          name: z.string().trim().min(1).max(120).optional(),
          slug: slugSchema.optional(),
          plan: planSchema.optional(),
          limits: tenantLimitsSchema.optional(),
          active: z.boolean().optional(),
          externalRef: z.string().trim().max(200).nullish(),
        }),
        response: { 200: tenantWithCount },
      },
    },
    async (req) => {
      const access = await requireTenantRole(ctx, req, req.params.id, 'owner');
      const { name, ...adminOnly } = req.body;
      const touchesAdminFields = Object.values(adminOnly).some((v) => v !== undefined);
      if (touchesAdminFields && access.role !== 'superadmin') throw forbidden('Only administrators can change these fields');
      try {
        const [t] = await ctx.db
          .update(schema.tenants)
          .set({ name, ...adminOnly })
          .where(eq(schema.tenants.id, req.params.id))
          .returning();
        if (!t) throw notFound('Customer');
        return { ...t, memberCount: (await memberCounts([t.id])).get(t.id) ?? 0 };
      } catch (err) {
        if (isUniqueViolation(err)) throw conflict('A customer with this short name already exists');
        throw err;
      }
    },
  );

  app.delete(
    '/:id',
    { schema: { tags: ['Customers'], summary: 'Delete a customer (administrators only)', params: idParam, response: { 200: okOut } } },
    async (req) => {
      requireSuperadmin(req);
      const deleted = await ctx.db.delete(schema.tenants).where(eq(schema.tenants.id, req.params.id)).returning();
      if (!deleted.length) throw notFound('Customer');
      return { ok: true as const };
    },
  );

  // Members

  app.get(
    '/:id/members',
    {
      schema: { tags: ['Customers'], summary: 'List the users of a customer', params: idParam, response: { 200: z.array(memberOut) } },
    },
    async (req) => {
      await requireTenantRole(ctx, req, req.params.id, 'manager');
      const rows = await ctx.db
        .select({ user: schema.users, role: schema.memberships.role, createdAt: schema.memberships.createdAt })
        .from(schema.memberships)
        .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
        .where(eq(schema.memberships.tenantId, req.params.id))
        .orderBy(asc(schema.users.name));
      return rows.map((r) => ({ ...r, user: toUserOut(r.user) }));
    },
  );

  app.post(
    '/:id/members',
    {
      schema: {
        tags: ['Customers'],
        summary: 'Add a user to a customer. Creates the account when the e-mail address is new.',
        params: idParam,
        body: z.object({
          email: emailSchema,
          name: z.string().trim().min(1).max(120).optional(),
          password: passwordSchema.optional(),
          role: roleSchema,
        }),
        response: { 201: memberOut },
      },
    },
    async (req, reply) => {
      const access = await requireTenantRole(ctx, req, req.params.id, 'manager');
      if (!canGrant(access.role, req.body.role)) throw forbidden('You cannot grant a role higher than your own');
      let [user] = await ctx.db.select().from(schema.users).where(eq(schema.users.email, req.body.email));
      if (!user) {
        if (!req.body.name) throw badRequest('A name is required for a new user');
        [user] = await ctx.db
          .insert(schema.users)
          .values({
            email: req.body.email,
            name: req.body.name,
            passwordHash: req.body.password ? await hashPassword(req.body.password) : null,
          })
          .returning();
      }
      try {
        const [m] = await ctx.db
          .insert(schema.memberships)
          .values({ userId: user!.id, tenantId: req.params.id, role: req.body.role })
          .returning();
        reply.status(201);
        return { user: toUserOut(user!), role: m!.role, createdAt: m!.createdAt };
      } catch (err) {
        if (isUniqueViolation(err)) throw conflict('This user already belongs to the customer');
        throw err;
      }
    },
  );

  app.put(
    '/:id/members/:userId',
    {
      schema: {
        tags: ['Customers'],
        summary: "Change a member's role",
        params: memberParams,
        body: z.object({ role: roleSchema }),
        response: { 200: memberOut },
      },
    },
    async (req) => {
      const access = await requireTenantRole(ctx, req, req.params.id, 'manager');
      const where = and(eq(schema.memberships.tenantId, req.params.id), eq(schema.memberships.userId, req.params.userId));
      const [current] = await ctx.db.select().from(schema.memberships).where(where);
      if (!current) throw notFound('Member');
      if (!canGrant(access.role, current.role) || !canGrant(access.role, req.body.role)) {
        throw forbidden('You cannot change a role higher than your own');
      }
      await ctx.db.update(schema.memberships).set({ role: req.body.role }).where(where);
      const [user] = await ctx.db.select().from(schema.users).where(eq(schema.users.id, req.params.userId));
      return { user: toUserOut(user!), role: req.body.role, createdAt: current.createdAt };
    },
  );

  app.delete(
    '/:id/members/:userId',
    {
      schema: { tags: ['Customers'], summary: 'Remove a user from a customer', params: memberParams, response: { 200: okOut } },
    },
    async (req) => {
      const access = await requireTenantRole(ctx, req, req.params.id, 'manager');
      const where = and(eq(schema.memberships.tenantId, req.params.id), eq(schema.memberships.userId, req.params.userId));
      const [current] = await ctx.db.select().from(schema.memberships).where(where);
      if (!current) throw notFound('Member');
      if (!canGrant(access.role, current.role)) throw forbidden('You cannot remove someone with a higher role');
      await ctx.db.delete(schema.memberships).where(where);
      return { ok: true as const };
    },
  );
};
