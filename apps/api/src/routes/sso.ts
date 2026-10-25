import fastifyFormbody from '@fastify/formbody';
import { and, eq, ne, sql } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { schema } from '../db/index.js';
import { auditNow } from '../lib/audit.js';
import { createSession, requireTenantRole } from '../lib/auth.js';
import type { AppContext } from '../lib/context.js';
import { badRequest, conflict, forbidden, HttpError, notFound } from '../lib/errors.js';
import { emailSchema, idParam, okOut } from '../lib/schemas.js';
import {
  decodeProvider,
  encodeConfig,
  findProviderByDomain,
  findProviderBySlug,
  maskProvider,
  oidcCallback,
  oidcConfiguration,
  oidcStart,
  safeNext,
  samlFor,
  samlIdentity,
  SsoError,
  ssoEndpoints,
  ssoInputSchema,
  ssoOutSchema,
  type SsoIdentity,
  type SsoInput,
  type SsoState,
} from '../services/sso.js';

const SSO_COOKIE = 'hrs_sso';
const COOKIE_PATH = '/api/auth/sso';

const endpointsOut = z.object({
  oidcRedirectUri: z.string(),
  samlEntityId: z.string(),
  samlAcsUrl: z.string(),
  samlMetadataUrl: z.string(),
  loginUrl: z.string(),
});
const ssoConfigOut = z.object({ provider: ssoOutSchema.nullable(), endpoints: endpointsOut });

/** Single sign-on settings per customer: /api/tenants/:id/sso */
export const ssoAdminRoutes: FastifyPluginAsyncZod = async (app) => {
  const { ctx } = app;

  async function load(tenantId: string) {
    const [tenant] = await ctx.db.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId));
    if (!tenant) throw notFound('Customer');
    const [row] = await ctx.db.select().from(schema.ssoProviders).where(eq(schema.ssoProviders.tenantId, tenantId));
    return { tenant, provider: row ? decodeProvider(ctx, row) : null };
  }

  app.get(
    '/:id/sso',
    {
      schema: {
        tags: ['Single sign-on'],
        summary: 'Single sign-on settings of a customer, with the addresses to enter at the identity provider',
        params: idParam,
        response: { 200: ssoConfigOut },
      },
    },
    async (req) => {
      await requireTenantRole(ctx, req, req.params.id, 'owner');
      const { tenant, provider } = await load(req.params.id);
      return { provider: provider ? maskProvider(provider) : null, endpoints: ssoEndpoints(ctx, tenant) };
    },
  );

  app.put(
    '/:id/sso',
    {
      config: { audit: 'sso.update' },
      schema: {
        tags: ['Single sign-on'],
        summary: 'Save single sign-on (OIDC or SAML). Allowed e-mail domains can only be changed by administrators.',
        params: idParam,
        body: ssoInputSchema,
        response: { 200: ssoConfigOut },
      },
    },
    async (req) => {
      const access = await requireTenantRole(ctx, req, req.params.id, 'owner');
      const { tenant, provider: current } = await load(req.params.id);
      const input = req.body;
      const domains = [...new Set(input.emailDomains)];
      const currentDomains = current?.emailDomains ?? [];
      if (access.role !== 'superadmin' && [...domains].sort().join() !== [...currentDomains].sort().join()) {
        throw forbidden('Only administrators can change the allowed e-mail domains');
      }
      if (input.type === 'oidc' && !input.oidc) throw badRequest('OIDC settings are missing');
      if (input.type === 'saml' && !input.saml) throw badRequest('SAML settings are missing');
      if (input.enabled && domains.length === 0) throw badRequest('Add at least one allowed e-mail domain before switching single sign-on on');
      if (domains.length) {
        const [taken] = await ctx.db
          .select({ name: schema.tenants.name })
          .from(schema.ssoProviders)
          .innerJoin(schema.tenants, eq(schema.tenants.id, schema.ssoProviders.tenantId))
          .where(and(ne(schema.ssoProviders.tenantId, tenant.id), sql`${schema.ssoProviders.emailDomains} && ARRAY[${sql.join(domains.map((d) => sql`${d}`), sql`, `)}]::text[]`));
        if (taken) throw conflict(`One of these domains is already used by ${taken.name}`);
      }
      const values = {
        type: input.type,
        enabled: input.enabled,
        displayName: input.displayName,
        emailDomains: domains,
        allowPasswordLogin: input.allowPasswordLogin,
        autoCreateUsers: input.autoCreateUsers,
        defaultRole: input.defaultRole,
        config: encodeConfig(ctx, input, current),
        updatedAt: new Date(),
      };
      await ctx.db
        .insert(schema.ssoProviders)
        .values({ tenantId: tenant.id, ...values })
        .onConflictDoUpdate({ target: schema.ssoProviders.tenantId, set: values });
      req.auditInfo = { details: { type: input.type, enabled: input.enabled, domains, allowPasswordLogin: input.allowPasswordLogin } };
      const saved = await load(tenant.id);
      return { provider: maskProvider(saved.provider!), endpoints: ssoEndpoints(ctx, tenant) };
    },
  );

  app.delete(
    '/:id/sso',
    {
      config: { audit: 'sso.delete' },
      schema: { tags: ['Single sign-on'], summary: 'Remove single sign-on from a customer', params: idParam, response: { 200: okOut } },
    },
    async (req) => {
      await requireTenantRole(ctx, req, req.params.id, 'owner');
      await ctx.db.delete(schema.ssoProviders).where(eq(schema.ssoProviders.tenantId, req.params.id));
      return { ok: true as const };
    },
  );

  app.post(
    '/:id/sso/test',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: {
        tags: ['Single sign-on'],
        summary: 'Check the saved identity provider settings (OIDC discovery or the SAML certificate)',
        params: idParam,
        response: { 200: z.object({ ok: z.literal(true), message: z.string() }) },
      },
    },
    async (req) => {
      await requireTenantRole(ctx, req, req.params.id, 'owner');
      const { tenant, provider } = await load(req.params.id);
      if (!provider) throw badRequest('Save the single sign-on settings first');
      try {
        if (provider.type === 'oidc') {
          const config = await oidcConfiguration(provider.oidc!);
          const meta = config.serverMetadata();
          return { ok: true as const, message: `Connected to ${meta.issuer}` };
        }
        samlFor(ctx, tenant, provider);
        const { X509Certificate } = await import('node:crypto');
        const cert = new X509Certificate(Buffer.from(provider.saml!.idpCert, 'base64'));
        return { ok: true as const, message: `Certificate of ${cert.subject.replace(/\n/g, ', ')}, valid until ${new Date(cert.validTo).toISOString().slice(0, 10)}` };
      } catch (err) {
        throw badRequest(`Check failed: ${(err as Error).message}`);
      }
    },
  );
};

/** Sign-in through a customer's identity provider: /api/auth/sso */
export const ssoAuthRoutes: FastifyPluginAsyncZod = async (app) => {
  const { ctx } = app;
  await app.register(fastifyFormbody);

  const fail = (req: FastifyRequest, reply: FastifyReply, code: string, tenantId: string | null, detail?: string) => {
    void auditNow(ctx, req, 'auth.sso_login', { tenantId, success: false, via: 'sso', details: { reason: code, ...(detail ? { detail } : {}) } });
    return reply.redirect(`/login?sso_error=${encodeURIComponent(code)}`);
  };

  async function finish(req: FastifyRequest, reply: FastifyReply, tenant: typeof schema.tenants.$inferSelect, provider: SsoInput, id: SsoIdentity, next: string) {
    const user = await provision(ctx, tenant, provider, id);
    await createSession(ctx, req, reply, user.id);
    await auditNow(ctx, req, 'auth.sso_login', {
      actor: { id: user.id, email: user.email },
      via: 'sso',
      tenantId: tenant.id,
      targetType: 'user',
      targetId: user.id,
      details: { type: provider.type },
    });
    return reply.redirect(safeNext(next));
  }

  app.post(
    '/discover',
    {
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: {
        tags: ['Auth'],
        summary: 'Find the single sign-on of an e-mail address. Returns the URL to start signing in.',
        security: [],
        body: z.object({ email: emailSchema, next: z.string().max(500).optional() }),
        response: { 200: z.object({ url: z.string(), displayName: z.string(), tenantName: z.string() }) },
      },
    },
    async (req) => {
      const found = await findProviderByDomain(ctx, req.body.email);
      if (!found) throw new HttpError(404, 'sso_not_found', 'There is no single sign-on for this e-mail address');
      const next = safeNext(req.body.next);
      return {
        url: `/api/auth/sso/start?tenant=${found.tenant.slug}${next !== '/' ? `&next=${encodeURIComponent(next)}` : ''}`,
        displayName: found.provider.displayName || found.tenant.name,
        tenantName: found.tenant.name,
      };
    },
  );

  app.get(
    '/start',
    {
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: {
        tags: ['Auth'],
        summary: "Start signing in at a customer's identity provider (browser redirect)",
        security: [],
        querystring: z.object({ tenant: z.string().max(60), next: z.string().max(500).optional() }),
      },
    },
    async (req, reply) => {
      const found = await findProviderBySlug(ctx, req.query.tenant);
      if (!found || !found.provider.enabled || !found.tenant.active) return fail(req, reply, 'not_available', found?.tenant.id ?? null);
      const provider = decodeProvider(ctx, found.provider);
      const next = safeNext(req.query.next);
      try {
        if (provider.type === 'oidc') {
          const { url, cookie } = await oidcStart(ctx, found.tenant, provider.oidc!, next);
          reply.setCookie(SSO_COOKIE, cookie, { path: COOKIE_PATH, httpOnly: true, sameSite: 'lax', secure: req.protocol === 'https', maxAge: 600 });
          return reply.redirect(url);
        }
        const url = await samlFor(ctx, found.tenant, provider).getAuthorizeUrlAsync(next, undefined, {});
        return reply.redirect(url);
      } catch (err) {
        req.log.warn({ err }, 'sso start failed');
        return fail(req, reply, 'provider_unreachable', found.tenant.id, (err as Error).message);
      }
    },
  );

  app.get(
    '/oidc/callback',
    { schema: { tags: ['Auth'], summary: 'Return address for OIDC identity providers', security: [], hide: true } },
    async (req, reply) => {
      const raw = req.cookies[SSO_COOKIE];
      reply.clearCookie(SSO_COOKIE, { path: COOKIE_PATH });
      let state: SsoState;
      try {
        state = JSON.parse(ctx.box.decrypt(raw ?? '')) as SsoState;
        if (state.exp < Date.now()) throw new Error('expired');
      } catch {
        return fail(req, reply, 'expired', null);
      }
      const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
      const params = new URLSearchParams(query);
      if (params.get('error')) return fail(req, reply, 'denied', state.tenantId, params.get('error_description') ?? params.get('error')!);
      const [row] = await ctx.db
        .select({ provider: schema.ssoProviders, tenant: schema.tenants })
        .from(schema.ssoProviders)
        .innerJoin(schema.tenants, eq(schema.tenants.id, schema.ssoProviders.tenantId))
        .where(eq(schema.ssoProviders.tenantId, state.tenantId));
      if (!row || !row.provider.enabled || row.provider.type !== 'oidc') return fail(req, reply, 'not_available', state.tenantId);
      const provider = decodeProvider(ctx, row.provider);
      try {
        const id = await oidcCallback(ctx, row.tenant, provider.oidc!, state, query);
        return await finish(req, reply, row.tenant, provider, id, state.next);
      } catch (err) {
        if (err instanceof SsoError) return fail(req, reply, err.code, row.tenant.id);
        req.log.warn({ err }, 'oidc callback failed');
        return fail(req, reply, 'invalid_response', row.tenant.id, (err as Error).message);
      }
    },
  );

  app.get(
    '/saml/:slug/metadata',
    {
      schema: { tags: ['Auth'], summary: 'SAML service provider metadata of a customer', security: [], params: z.object({ slug: z.string().max(60) }) },
    },
    async (req, reply) => {
      const found = await findProviderBySlug(ctx, req.params.slug);
      if (!found || found.provider.type !== 'saml') throw notFound('SAML configuration');
      const xml = samlFor(ctx, found.tenant, decodeProvider(ctx, found.provider)).generateServiceProviderMetadata(null, null);
      return reply.type('application/samlmetadata+xml').send(xml);
    },
  );

  app.post(
    '/saml/:slug/acs',
    {
      schema: {
        tags: ['Auth'],
        summary: 'Assertion consumer service for SAML identity providers',
        security: [],
        hide: true,
        params: z.object({ slug: z.string().max(60) }),
        body: z.object({ SAMLResponse: z.string().max(500_000), RelayState: z.string().max(1000).optional() }),
      },
    },
    async (req, reply) => {
      const found = await findProviderBySlug(ctx, req.params.slug);
      if (!found || !found.provider.enabled || found.provider.type !== 'saml' || !found.tenant.active) {
        return fail(req, reply, 'not_available', found?.tenant.id ?? null);
      }
      const provider = decodeProvider(ctx, found.provider);
      try {
        const { profile } = await samlFor(ctx, found.tenant, provider).validatePostResponseAsync({
          SAMLResponse: req.body.SAMLResponse,
          ...(req.body.RelayState ? { RelayState: req.body.RelayState } : {}),
        });
        if (!profile) throw new SsoError('invalid_response');
        const id = samlIdentity(provider, profile as unknown as Record<string, unknown>);
        return await finish(req, reply, found.tenant, provider, id, req.body.RelayState ?? '/');
      } catch (err) {
        if (err instanceof SsoError) return fail(req, reply, err.code, found.tenant.id);
        req.log.warn({ err }, 'saml response rejected');
        return fail(req, reply, 'invalid_response', found.tenant.id, (err as Error).message);
      }
    },
  );
};

/**
 * Finds or creates the user behind an SSO identity. Only addresses in the customer's allowed domains get in,
 * administrators always sign in with their password, and new members are only created when the customer allows it.
 */
export async function provision(ctx: AppContext, tenant: typeof schema.tenants.$inferSelect, provider: SsoInput, id: SsoIdentity) {
  const domain = id.email.split('@')[1]!;
  if (!provider.emailDomains.includes(domain)) throw new SsoError('domain_not_allowed');

  return ctx.db.transaction(async (tx) => {
    const [linked] = await tx
      .select({ user: schema.users })
      .from(schema.userIdentities)
      .innerJoin(schema.users, eq(schema.users.id, schema.userIdentities.userId))
      .where(and(eq(schema.userIdentities.tenantId, tenant.id), eq(schema.userIdentities.subject, id.subject)));
    let user = linked?.user;
    if (!user) [user] = await tx.select().from(schema.users).where(eq(schema.users.email, id.email));
    if (user?.isSuperadmin) throw new SsoError('admin_password_only');
    if (user && !user.active) throw new SsoError('account_disabled');

    if (!user) {
      if (!provider.autoCreateUsers) throw new SsoError('not_a_member');
      [user] = await tx.insert(schema.users).values({ email: id.email, name: id.name || id.email.split('@')[0]! }).returning();
    }
    const [membership] = await tx
      .select()
      .from(schema.memberships)
      .where(and(eq(schema.memberships.userId, user!.id), eq(schema.memberships.tenantId, tenant.id)));
    if (!membership) {
      if (!provider.autoCreateUsers) throw new SsoError('not_a_member');
      await tx.insert(schema.memberships).values({ userId: user!.id, tenantId: tenant.id, role: provider.defaultRole });
    }
    await tx
      .insert(schema.userIdentities)
      .values({ tenantId: tenant.id, subject: id.subject, userId: user!.id, lastLoginAt: new Date() })
      .onConflictDoUpdate({
        target: [schema.userIdentities.tenantId, schema.userIdentities.subject],
        set: { userId: user!.id, lastLoginAt: new Date() },
      });
    return user!;
  });
}

/** Password sign-in is refused for addresses whose customer requires single sign-on (administrators excepted). */
export async function ssoRequiredFor(ctx: AppContext, user: typeof schema.users.$inferSelect) {
  if (user.isSuperadmin) return null;
  const found = await findProviderByDomain(ctx, user.email);
  return found && !found.provider.allowPasswordLogin ? found : null;
}
