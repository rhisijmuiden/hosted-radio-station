import { and, asc, count, eq, inArray } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { schema } from '../db/index.js';
import { canGrant, hashPassword, requireSuperadmin, requireTenantRole, requireUser } from '../lib/auth.js';
import { badRequest, conflict, forbidden, isUniqueViolation, notFound } from '../lib/errors.js';
import { sendInvite } from '../services/accounts.js';
import { mailConfigured } from '../services/mail.js';
import { stationDir } from '../services/streaming/icecast.js';
import { applyStreams } from '../services/streaming/state.js';
import { rm } from 'node:fs/promises';
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
      config: { audit: 'tenant.create' },
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
            .object({
              email: emailSchema,
              name: z.string().trim().min(1).max(120),
              password: passwordSchema.optional(),
              sendInvite: z.boolean().default(false),
            })
            .optional(),
        }),
        response: { 201: tenantWithCount },
      },
    },
    async (req, reply) => {
      const auth = requireSuperadmin(req);
      const { owner, ...data } = req.body;
      if (owner?.sendInvite && !(await mailConfigured(ctx))) throw badRequest('Set up the mail server first to send invitations');
      let ownerUser: typeof schema.users.$inferSelect | undefined;
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
            ownerUser = user;
          }
          return t!;
        });
        req.auditInfo = { tenantId: tenant.id, targetId: tenant.id, details: { name: tenant.name, slug: tenant.slug, plan: tenant.plan } };
        if (owner?.sendInvite && ownerUser) {
          await sendInvite(ctx, ownerUser, auth.user.name, tenant.name).catch((err) => req.log.error({ err }, 'invitation failed'));
        }
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
      config: { audit: 'tenant.update' },
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
        req.auditInfo.details = { changed: Object.keys(req.body).filter((k) => req.body[k as keyof typeof req.body] !== undefined) };
        // Suspending a customer takes its stations off the air; reactivating brings them back.
        if (adminOnly.active !== undefined) await applyStreams(ctx, { by: access.user.email });
        return { ...t, memberCount: (await memberCounts([t.id])).get(t.id) ?? 0 };
      } catch (err) {
        if (isUniqueViolation(err)) throw conflict('A customer with this short name already exists');
        throw err;
      }
    },
  );

  app.delete(
    '/:id',
    { config: { audit: 'tenant.delete' }, schema: { tags: ['Customers'], summary: 'Delete a customer (administrators only)', params: idParam, response: { 200: okOut } } },
    async (req) => {
      const auth = requireSuperadmin(req);
      const stations = await ctx.db.select({ id: schema.stations.id }).from(schema.stations).where(eq(schema.stations.tenantId, req.params.id));
      const deleted = await ctx.db.delete(schema.tenants).where(eq(schema.tenants.id, req.params.id)).returning();
      if (!deleted.length) throw notFound('Customer');
      // The audit row can't point at a customer that no longer exists.
      req.auditInfo = { tenantId: null, targetId: deleted[0]!.id, details: { name: deleted[0]!.name, slug: deleted[0]!.slug } };
      if (stations.length) {
        await applyStreams(ctx, { by: auth.user.email });
        for (const s of stations) await rm(stationDir(ctx, s.id), { recursive: true, force: true }).catch(() => undefined);
      }
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
      config: { audit: 'member.add' },
      schema: {
        tags: ['Customers'],
        summary: 'Add a user to a customer. Creates the account when the e-mail address is new.',
        params: idParam,
        body: z.object({
          email: emailSchema,
          name: z.string().trim().min(1).max(120).optional(),
          password: passwordSchema.optional(),
          role: roleSchema,
          /** E-mail a link to choose a password (needs the mail server). */
          sendInvite: z.boolean().default(false),
        }),
        response: { 201: memberOut },
      },
    },
    async (req, reply) => {
      const access = await requireTenantRole(ctx, req, req.params.id, 'manager');
      if (!canGrant(access.role, req.body.role)) throw forbidden('You cannot grant a role higher than your own');
      if (req.body.sendInvite && !(await mailConfigured(ctx))) throw badRequest('Set up the mail server first to send invitations');
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
        req.auditInfo = { targetType: 'user', targetId: user!.id, details: { email: user!.email, role: m!.role, invited: req.body.sendInvite } };
        if (req.body.sendInvite) {
          const [tenant] = await ctx.db.select().from(schema.tenants).where(eq(schema.tenants.id, req.params.id));
          await sendInvite(ctx, user!, access.user.name, tenant!.name).catch((err) => req.log.error({ err }, 'invitation failed'));
        }
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
      config: { audit: 'member.role' },
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
      req.auditInfo = { targetType: 'user', details: { from: current.role, to: req.body.role } };
      const [user] = await ctx.db.select().from(schema.users).where(eq(schema.users.id, req.params.userId));
      return { user: toUserOut(user!), role: req.body.role, createdAt: current.createdAt };
    },
  );

  app.post(
    '/:id/members/:userId/invite',
    {
      config: { audit: 'member.invite', rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: {
        tags: ['Customers'],
        summary: 'E-mail a member a link to choose a (new) password',
        params: memberParams,
        response: { 200: okOut },
      },
    },
    async (req) => {
      const access = await requireTenantRole(ctx, req, req.params.id, 'manager');
      if (!(await mailConfigured(ctx))) throw badRequest('Set up the mail server first to send invitations');
      const [row] = await ctx.db
        .select({ user: schema.users, tenant: schema.tenants, role: schema.memberships.role })
        .from(schema.memberships)
        .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
        .innerJoin(schema.tenants, eq(schema.tenants.id, schema.memberships.tenantId))
        .where(and(eq(schema.memberships.tenantId, req.params.id), eq(schema.memberships.userId, req.params.userId)));
      if (!row) throw notFound('Member');
      if (row.user.isSuperadmin || !canGrant(access.role, row.role)) throw forbidden();
      req.auditInfo = { targetType: 'user' };
      try {
        await sendInvite(ctx, row.user, access.user.name, row.tenant.name);
      } catch (err) {
        throw badRequest(`Sending failed: ${(err as Error).message}`);
      }
      return { ok: true as const };
    },
  );

  app.delete(
    '/:id/members/:userId',
    {
      config: { audit: 'member.remove' }, schema: { tags: ['Customers'], summary: 'Remove a user from a customer', params: memberParams, response: { 200: okOut } },
    },
    async (req) => {
      const access = await requireTenantRole(ctx, req, req.params.id, 'manager');
      const where = and(eq(schema.memberships.tenantId, req.params.id), eq(schema.memberships.userId, req.params.userId));
      const [current] = await ctx.db.select().from(schema.memberships).where(where);
      if (!current) throw notFound('Member');
      if (!canGrant(access.role, current.role)) throw forbidden('You cannot remove someone with a higher role');
      await ctx.db.delete(schema.memberships).where(where);
      req.auditInfo = { targetType: 'user', details: { role: current.role } };
      return { ok: true as const };
    },
  );
};
