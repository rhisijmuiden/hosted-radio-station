import { eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { schema } from '../db/index.js';
import { createSession, destroySession, hashPassword, requireUser, verifyPassword } from '../lib/auth.js';
import { badRequest, HttpError } from '../lib/errors.js';
import { emailSchema, LOCALES, okOut, passwordSchema, planSchema, roleSchema, toUserOut, userOut } from '../lib/schemas.js';

const meOut = z.object({
  user: userOut,
  via: z.enum(['session', 'api_key']),
  memberships: z.array(
    z.object({ tenantId: z.uuid(), tenantName: z.string(), tenantSlug: z.string(), plan: planSchema, role: roleSchema }),
  ),
});

// A fixed hash so unknown e-mail addresses take as long as wrong passwords.
let dummyHash: Promise<string> | null = null;

export const authRoutes: FastifyPluginAsyncZod = async (app) => {
  const { ctx } = app;

  async function me(userId: string) {
    return ctx.db
      .select({
        tenantId: schema.tenants.id,
        tenantName: schema.tenants.name,
        tenantSlug: schema.tenants.slug,
        plan: schema.tenants.plan,
        role: schema.memberships.role,
      })
      .from(schema.memberships)
      .innerJoin(schema.tenants, eq(schema.tenants.id, schema.memberships.tenantId))
      .where(eq(schema.memberships.userId, userId))
      .orderBy(schema.tenants.name);
  }

  app.post(
    '/login',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        tags: ['Auth'],
        summary: 'Sign in with e-mail and password (sets a session cookie)',
        security: [],
        body: z.object({ email: emailSchema, password: z.string().min(1).max(200) }),
        response: { 200: meOut },
      },
    },
    async (req, reply) => {
      const [user] = await ctx.db.select().from(schema.users).where(eq(schema.users.email, req.body.email));
      if (!user?.passwordHash || !user.active) {
        dummyHash ??= hashPassword('dummy-password-for-timing');
        await verifyPassword(await dummyHash, req.body.password);
        throw new HttpError(401, 'invalid_credentials', 'E-mail address or password is incorrect');
      }
      if (!(await verifyPassword(user.passwordHash, req.body.password))) {
        throw new HttpError(401, 'invalid_credentials', 'E-mail address or password is incorrect');
      }
      await createSession(ctx, req, reply, user.id);
      return { user: toUserOut(user), via: 'session' as const, memberships: await me(user.id) };
    },
  );

  app.post(
    '/logout',
    { schema: { tags: ['Auth'], summary: 'Sign out and end the session', response: { 200: okOut } } },
    async (req, reply) => {
      await destroySession(ctx, req, reply);
      return { ok: true as const };
    },
  );

  app.get(
    '/me',
    { schema: { tags: ['Auth'], summary: 'The signed-in user and their customers', response: { 200: meOut } } },
    async (req) => {
      const auth = requireUser(req);
      return { user: toUserOut(auth.user), via: auth.via, memberships: await me(auth.user.id) };
    },
  );

  app.patch(
    '/me',
    {
      schema: {
        tags: ['Auth'],
        summary: 'Update your own name and language',
        body: z.object({ name: z.string().trim().min(1).max(120).optional(), locale: z.enum(LOCALES).optional() }),
        response: { 200: userOut },
      },
    },
    async (req) => {
      const auth = requireUser(req);
      const [user] = await ctx.db.update(schema.users).set(req.body).where(eq(schema.users.id, auth.user.id)).returning();
      return toUserOut(user!);
    },
  );

  app.post(
    '/password',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        tags: ['Auth'],
        summary: 'Change your own password. Other sessions are signed out.',
        body: z.object({ currentPassword: z.string().max(200), newPassword: passwordSchema }),
        response: { 200: okOut },
      },
    },
    async (req, reply) => {
      const auth = requireUser(req);
      if (auth.user.passwordHash && !(await verifyPassword(auth.user.passwordHash, req.body.currentPassword))) {
        throw badRequest('Current password is incorrect');
      }
      await ctx.db
        .update(schema.users)
        .set({ passwordHash: await hashPassword(req.body.newPassword) })
        .where(eq(schema.users.id, auth.user.id));
      await ctx.db.delete(schema.sessions).where(eq(schema.sessions.userId, auth.user.id));
      if (auth.via === 'session') await createSession(ctx, req, reply, auth.user.id);
      return { ok: true as const };
    },
  );
};
