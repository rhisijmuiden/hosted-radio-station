import { count, eq, sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { schema } from '../db/index.js';
import { auditNow } from '../lib/audit.js';
import { createSession, destroySession, hashPassword, requireUser, verifyPassword } from '../lib/auth.js';
import { badRequest, HttpError } from '../lib/errors.js';
import { consumePasswordToken, findPasswordToken, sendPasswordReset } from '../services/accounts.js';
import { mailConfigured } from '../services/mail.js';
import { ssoRequiredFor } from './sso.js';
import { emailSchema, LOCALES, okOut, passwordSchema, planSchema, roleSchema, toUserOut, userOut } from '../lib/schemas.js';

const meOut = z.object({
  user: userOut,
  via: z.enum(['session', 'api_key', 'tunnel']),
  memberships: z.array(
    z.object({
      tenantId: z.uuid(),
      tenantName: z.string(),
      tenantSlug: z.string(),
      plan: planSchema,
      role: roleSchema,
      /** The customer has a subscription of the hosted service (phase 10). */
      billed: z.boolean(),
    }),
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
        billed: sql<boolean>`${schema.subscriptions.id} is not null`,
      })
      .from(schema.memberships)
      .innerJoin(schema.tenants, eq(schema.tenants.id, schema.memberships.tenantId))
      .leftJoin(schema.subscriptions, eq(schema.subscriptions.tenantId, schema.tenants.id))
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
      const failed = async (reason: string) => {
        await auditNow(ctx, req, 'auth.login', {
          actor: { id: user?.id ?? null, email: req.body.email },
          via: 'session',
          success: false,
          targetType: 'user',
          targetId: user?.id ?? null,
          details: { reason },
        });
        return new HttpError(401, 'invalid_credentials', 'E-mail address or password is incorrect');
      };
      if (!user?.passwordHash || !user.active) {
        dummyHash ??= hashPassword('dummy-password-for-timing');
        await verifyPassword(await dummyHash, req.body.password);
        throw await failed(!user ? 'unknown_user' : !user.active ? 'disabled' : 'no_password');
      }
      if (!(await verifyPassword(user.passwordHash, req.body.password))) throw await failed('wrong_password');
      const sso = await ssoRequiredFor(ctx, user);
      if (sso) {
        await auditNow(ctx, req, 'auth.login', {
          actor: { id: user.id, email: user.email },
          via: 'session',
          success: false,
          tenantId: sso.tenant.id,
          details: { reason: 'sso_required' },
        });
        throw new HttpError(403, 'sso_required', `${sso.tenant.name} requires single sign-on`);
      }
      await createSession(ctx, req, reply, user.id);
      await auditNow(ctx, req, 'auth.login', { actor: { id: user.id, email: user.email }, via: 'session', targetType: 'user', targetId: user.id });
      return { user: toUserOut(user), via: 'session' as const, memberships: await me(user.id) };
    },
  );

  app.get(
    '/options',
    {
      schema: {
        tags: ['Auth'],
        summary: 'What the sign-in page can offer: password reset by e-mail and single sign-on',
        security: [],
        response: { 200: z.object({ passwordReset: z.boolean(), sso: z.boolean() }) },
      },
    },
    async () => {
      const [row] = await ctx.db.select({ n: count() }).from(schema.ssoProviders).where(eq(schema.ssoProviders.enabled, true));
      return { passwordReset: await mailConfigured(ctx), sso: (row?.n ?? 0) > 0 };
    },
  );

  app.post(
    '/forgot',
    {
      config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
      schema: {
        tags: ['Auth'],
        summary: 'Send a password reset link. Always answers ok, so it does not reveal which addresses exist.',
        security: [],
        body: z.object({ email: emailSchema }),
        response: { 200: okOut },
      },
    },
    async (req) => {
      const [user] = await ctx.db.select().from(schema.users).where(eq(schema.users.email, req.body.email));
      if (user?.active && (await mailConfigured(ctx))) {
        try {
          await sendPasswordReset(ctx, user);
          await auditNow(ctx, req, 'auth.reset_requested', { actor: { id: user.id, email: user.email }, via: 'anonymous', targetType: 'user', targetId: user.id });
        } catch (err) {
          req.log.error({ err }, 'sending the password reset e-mail failed');
        }
      }
      return { ok: true as const };
    },
  );

  app.get(
    '/reset/:token',
    {
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: {
        tags: ['Auth'],
        summary: 'Check a password reset or invitation link',
        security: [],
        params: z.object({ token: z.string().min(10).max(200) }),
        response: { 200: z.object({ email: z.string(), name: z.string(), purpose: z.enum(['reset', 'invite']) }) },
      },
    },
    async (req) => {
      const found = await findPasswordToken(ctx, req.params.token);
      if (!found) throw new HttpError(404, 'invalid_token', 'This link is invalid or has expired');
      return { email: found.user.email, name: found.user.name, purpose: found.token.purpose === 'invite' ? ('invite' as const) : ('reset' as const) };
    },
  );

  app.post(
    '/reset',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        tags: ['Auth'],
        summary: 'Choose a new password with a reset or invitation link, and sign in',
        security: [],
        body: z.object({ token: z.string().min(10).max(200), password: passwordSchema }),
        response: { 200: meOut },
      },
    },
    async (req, reply) => {
      const found = await findPasswordToken(ctx, req.body.token);
      if (!found) throw new HttpError(404, 'invalid_token', 'This link is invalid or has expired');
      const { user } = found;
      await ctx.db.update(schema.users).set({ passwordHash: await hashPassword(req.body.password) }).where(eq(schema.users.id, user.id));
      await consumePasswordToken(ctx, req.body.token);
      await ctx.db.delete(schema.sessions).where(eq(schema.sessions.userId, user.id));
      await auditNow(ctx, req, found.token.purpose === 'invite' ? 'auth.invite_accepted' : 'auth.password_reset', {
        actor: { id: user.id, email: user.email },
        via: 'session',
        targetType: 'user',
        targetId: user.id,
      });
      await createSession(ctx, req, reply, user.id);
      return { user: toUserOut(user), via: 'session' as const, memberships: await me(user.id) };
    },
  );

  app.post(
    '/logout',
    { schema: { tags: ['Auth'], summary: 'Sign out and end the session', response: { 200: okOut } } },
    async (req, reply) => {
      if (req.auth) await auditNow(ctx, req, 'auth.logout', { targetType: 'user', targetId: req.auth.user.id });
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
      config: { audit: 'profile.update' },
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
      config: { audit: 'profile.password', rateLimit: { max: 10, timeWindow: '1 minute' } },
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
