import { and, asc, count, eq, ne } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { schema } from '../db/index.js';
import { hashPassword, requireSuperadmin } from '../lib/auth.js';
import { badRequest, conflict, isUniqueViolation, notFound } from '../lib/errors.js';
import { sendInvite } from '../services/accounts.js';
import { mailConfigured } from '../services/mail.js';
import { emailSchema, idParam, LOCALES, okOut, passwordSchema, roleSchema, toUserOut, userOut } from '../lib/schemas.js';

const userDetail = userOut.extend({
  memberships: z.array(z.object({ tenantId: z.uuid(), tenantName: z.string(), role: roleSchema })),
});

/** Instance-wide user management, for administrators. Customer owners manage their people via /tenants/:id/members. */
export const userRoutes: FastifyPluginAsyncZod = async (app) => {
  const { ctx } = app;

  async function withMemberships(user: typeof schema.users.$inferSelect) {
    const memberships = await ctx.db
      .select({ tenantId: schema.tenants.id, tenantName: schema.tenants.name, role: schema.memberships.role })
      .from(schema.memberships)
      .innerJoin(schema.tenants, eq(schema.tenants.id, schema.memberships.tenantId))
      .where(eq(schema.memberships.userId, user.id))
      .orderBy(asc(schema.tenants.name));
    return { ...toUserOut(user), memberships };
  }

  async function assertNotLastAdmin(userId: string) {
    const [row] = await ctx.db
      .select({ n: count() })
      .from(schema.users)
      .where(and(eq(schema.users.isSuperadmin, true), eq(schema.users.active, true), ne(schema.users.id, userId)));
    if ((row?.n ?? 0) === 0) throw badRequest('There must be at least one active administrator');
  }

  app.get(
    '/',
    { schema: { tags: ['Users'], summary: 'List all users', response: { 200: z.array(userDetail) } } },
    async (req) => {
      requireSuperadmin(req);
      const users = await ctx.db.select().from(schema.users).orderBy(asc(schema.users.name));
      return Promise.all(users.map(withMemberships));
    },
  );

  app.post(
    '/',
    {
      config: { audit: 'user.create' },
      schema: {
        tags: ['Users'],
        summary: 'Create a user',
        body: z.object({
          email: emailSchema,
          name: z.string().trim().min(1).max(120),
          password: passwordSchema.optional(),
          isSuperadmin: z.boolean().default(false),
          locale: z.enum(LOCALES).default('en'),
          /** E-mail a link to choose a password (needs the mail server). */
          sendInvite: z.boolean().default(false),
        }),
        response: { 201: userDetail },
      },
    },
    async (req, reply) => {
      const auth = requireSuperadmin(req);
      const { password, sendInvite: invite, ...data } = req.body;
      if (invite && !(await mailConfigured(ctx))) throw badRequest('Set up the mail server first to send invitations');
      try {
        const [user] = await ctx.db
          .insert(schema.users)
          .values({ ...data, passwordHash: password ? await hashPassword(password) : null })
          .returning();
        req.auditInfo = { targetId: user!.id, details: { email: user!.email, isSuperadmin: user!.isSuperadmin, invited: invite } };
        if (invite) await sendInvite(ctx, user!, auth.user.name, 'Hosted Radio Station').catch((err) => req.log.error({ err }, 'invitation failed'));
        reply.status(201);
        return withMemberships(user!);
      } catch (err) {
        if (isUniqueViolation(err)) throw conflict('A user with this e-mail address already exists');
        throw err;
      }
    },
  );

  app.get(
    '/:id',
    { schema: { tags: ['Users'], summary: 'Get one user', params: idParam, response: { 200: userDetail } } },
    async (req) => {
      requireSuperadmin(req);
      const [user] = await ctx.db.select().from(schema.users).where(eq(schema.users.id, req.params.id));
      if (!user) throw notFound('User');
      return withMemberships(user);
    },
  );

  app.patch(
    '/:id',
    {
      config: { audit: 'user.update' },
      schema: {
        tags: ['Users'],
        summary: 'Update a user. Setting a password signs the user out everywhere.',
        params: idParam,
        body: z.object({
          email: emailSchema.optional(),
          name: z.string().trim().min(1).max(120).optional(),
          password: passwordSchema.optional(),
          isSuperadmin: z.boolean().optional(),
          active: z.boolean().optional(),
          locale: z.enum(LOCALES).optional(),
        }),
        response: { 200: userDetail },
      },
    },
    async (req) => {
      requireSuperadmin(req);
      const { password, ...data } = req.body;
      if (data.isSuperadmin === false || data.active === false) await assertNotLastAdmin(req.params.id);
      try {
        const [user] = await ctx.db
          .update(schema.users)
          .set({ ...data, ...(password ? { passwordHash: await hashPassword(password) } : {}) })
          .where(eq(schema.users.id, req.params.id))
          .returning();
        if (!user) throw notFound('User');
        if (password || data.active === false) await ctx.db.delete(schema.sessions).where(eq(schema.sessions.userId, user.id));
        req.auditInfo.details = { email: user.email, changed: Object.keys(req.body).filter((k) => req.body[k as keyof typeof req.body] !== undefined) };
        return withMemberships(user);
      } catch (err) {
        if (isUniqueViolation(err)) throw conflict('A user with this e-mail address already exists');
        throw err;
      }
    },
  );

  app.post(
    '/:id/invite',
    {
      config: { audit: 'user.invite', rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: {
        tags: ['Users'],
        summary: 'E-mail the user a link to choose a (new) password',
        params: idParam,
        response: { 200: okOut },
      },
    },
    async (req) => {
      const auth = requireSuperadmin(req);
      if (!(await mailConfigured(ctx))) throw badRequest('Set up the mail server first to send invitations');
      const [user] = await ctx.db.select().from(schema.users).where(eq(schema.users.id, req.params.id));
      if (!user) throw notFound('User');
      try {
        await sendInvite(ctx, user, auth.user.name, 'Hosted Radio Station');
      } catch (err) {
        throw badRequest(`Sending failed: ${(err as Error).message}`);
      }
      return { ok: true as const };
    },
  );

  app.delete(
    '/:id',
    { config: { audit: 'user.delete' }, schema: { tags: ['Users'], summary: 'Delete a user', params: idParam, response: { 200: okOut } } },
    async (req) => {
      const auth = requireSuperadmin(req);
      if (auth.user.id === req.params.id) throw badRequest('You cannot delete your own account');
      await assertNotLastAdmin(req.params.id);
      const deleted = await ctx.db.delete(schema.users).where(eq(schema.users.id, req.params.id)).returning();
      if (!deleted.length) throw notFound('User');
      req.auditInfo.details = { email: deleted[0]!.email };
      return { ok: true as const };
    },
  );
};
