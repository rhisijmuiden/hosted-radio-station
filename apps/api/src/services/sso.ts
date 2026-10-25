import { SAML, ValidateInResponseTo } from '@node-saml/node-saml';
import { and, eq, sql } from 'drizzle-orm';
import * as oidc from 'openid-client';
import { z } from 'zod';
import { schema } from '../db/index.js';
import type { AppContext } from '../lib/context.js';
import { roleSchema } from '../lib/schemas.js';
import { SECRET_MASK } from './settings.js';

type Provider = typeof schema.ssoProviders.$inferSelect;
type Tenant = typeof schema.tenants.$inferSelect;

const domainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, 'Invalid domain name');

export const oidcConfigSchema = z.object({
  /** Issuer or discovery URL, e.g. https://login.microsoftonline.com/<tenant>/v2.0 */
  issuer: z.string().trim().url(),
  clientId: z.string().trim().min(1).max(300),
  clientSecret: z.string().max(2000).default(''),
  scopes: z.string().trim().max(300).default('openid email profile'),
});

export const samlConfigSchema = z.object({
  /** IdP single sign-on URL (HTTP-Redirect binding). */
  entryPoint: z.string().trim().url(),
  /** IdP signing certificate, PEM or bare base64. */
  idpCert: z.string().trim().min(20).max(20_000),
  /** Expected issuer (entity ID) of the IdP. Empty = not checked. */
  idpIssuer: z.string().trim().max(500).default(''),
  /** Attribute that holds the e-mail address. Empty = NameID or the usual claim names. */
  emailAttribute: z.string().trim().max(300).default(''),
  nameAttribute: z.string().trim().max(300).default(''),
});

export const ssoInputSchema = z.object({
  type: z.enum(['oidc', 'saml']),
  enabled: z.boolean().default(false),
  displayName: z.string().trim().max(60).default(''),
  emailDomains: z.array(domainSchema).max(20).default([]),
  allowPasswordLogin: z.boolean().default(true),
  autoCreateUsers: z.boolean().default(false),
  defaultRole: roleSchema.exclude(['owner']).default('dj'),
  oidc: oidcConfigSchema.optional(),
  saml: samlConfigSchema.optional(),
});
export type SsoInput = z.infer<typeof ssoInputSchema>;

export const ssoOutSchema = ssoInputSchema.extend({ updatedAt: z.date() });

export interface SsoEndpoints {
  oidcRedirectUri: string;
  samlEntityId: string;
  samlAcsUrl: string;
  samlMetadataUrl: string;
  loginUrl: string;
}

const base = (ctx: AppContext) => ctx.config.PUBLIC_URL.replace(/\/$/, '');

export function ssoEndpoints(ctx: AppContext, tenant: Pick<Tenant, 'slug'>): SsoEndpoints {
  const b = base(ctx);
  return {
    oidcRedirectUri: `${b}/api/auth/sso/oidc/callback`,
    samlEntityId: `${b}/api/auth/sso/saml/${tenant.slug}`,
    samlAcsUrl: `${b}/api/auth/sso/saml/${tenant.slug}/acs`,
    samlMetadataUrl: `${b}/api/auth/sso/saml/${tenant.slug}/metadata`,
    loginUrl: `${b}/api/auth/sso/start?tenant=${tenant.slug}`,
  };
}

/** Provider as stored, with the client secret decrypted. */
export function decodeProvider(ctx: AppContext, row: Provider): SsoInput & { updatedAt: Date } {
  const cfg = row.config as { oidc?: z.infer<typeof oidcConfigSchema>; saml?: z.infer<typeof samlConfigSchema> };
  const oidcCfg = cfg.oidc ? { ...cfg.oidc, clientSecret: cfg.oidc.clientSecret ? ctx.box.decrypt(cfg.oidc.clientSecret) : '' } : undefined;
  return {
    type: row.type,
    enabled: row.enabled,
    displayName: row.displayName,
    emailDomains: row.emailDomains,
    allowPasswordLogin: row.allowPasswordLogin,
    autoCreateUsers: row.autoCreateUsers,
    defaultRole: row.defaultRole === 'owner' ? 'manager' : row.defaultRole,
    oidc: oidcCfg,
    saml: cfg.saml,
    updatedAt: row.updatedAt,
  };
}

export function maskProvider(p: SsoInput & { updatedAt: Date }) {
  return { ...p, oidc: p.oidc ? { ...p.oidc, clientSecret: p.oidc.clientSecret ? SECRET_MASK : '' } : undefined };
}

/** Builds the stored config; a masked secret keeps the stored one. */
export function encodeConfig(ctx: AppContext, input: SsoInput, current: SsoInput | null) {
  const out: Record<string, unknown> = {};
  if (input.oidc) {
    let secret = input.oidc.clientSecret;
    if (secret === SECRET_MASK) secret = current?.oidc?.clientSecret ?? '';
    out.oidc = { ...input.oidc, clientSecret: secret ? ctx.box.encrypt(secret) : '' };
  }
  if (input.saml) out.saml = { ...input.saml, idpCert: normalizeCert(input.saml.idpCert) };
  return out;
}

/** Accepts a PEM block or bare base64 and returns bare base64, the form node-saml expects. */
export function normalizeCert(cert: string) {
  return cert
    .replace(/-----BEGIN CERTIFICATE-----/g, '')
    .replace(/-----END CERTIFICATE-----/g, '')
    .replace(/\s+/g, '');
}

export async function findProviderByDomain(ctx: AppContext, email: string) {
  const domain = email.split('@')[1]?.toLowerCase();
  if (!domain) return null;
  const [row] = await ctx.db
    .select({ provider: schema.ssoProviders, tenant: schema.tenants })
    .from(schema.ssoProviders)
    .innerJoin(schema.tenants, eq(schema.tenants.id, schema.ssoProviders.tenantId))
    .where(and(eq(schema.ssoProviders.enabled, true), eq(schema.tenants.active, true), sql`${domain} = any(${schema.ssoProviders.emailDomains})`));
  return row ?? null;
}

export async function findProviderBySlug(ctx: AppContext, slug: string) {
  const [row] = await ctx.db
    .select({ provider: schema.ssoProviders, tenant: schema.tenants })
    .from(schema.ssoProviders)
    .innerJoin(schema.tenants, eq(schema.tenants.id, schema.ssoProviders.tenantId))
    .where(eq(schema.tenants.slug, slug));
  return row ?? null;
}

// OIDC

const discoveryCache = new Map<string, { at: number; config: oidc.Configuration }>();

export async function oidcConfiguration(cfg: z.infer<typeof oidcConfigSchema>) {
  const key = `${cfg.issuer}|${cfg.clientId}|${cfg.clientSecret}`;
  const hit = discoveryCache.get(key);
  if (hit && Date.now() - hit.at < 3600_000) return hit.config;
  const url = new URL(cfg.issuer);
  // Plain HTTP is only accepted for identity providers inside your own network, e.g. a Keycloak test server.
  const options = url.protocol === 'http:' ? { execute: [oidc.allowInsecureRequests], timeout: 15 } : { timeout: 15 };
  const config = await oidc.discovery(url, cfg.clientId, cfg.clientSecret || undefined, undefined, options);
  discoveryCache.set(key, { at: Date.now(), config });
  return config;
}

export interface SsoState {
  tenantId: string;
  state: string;
  nonce: string;
  verifier: string;
  next: string;
  exp: number;
}

export async function oidcStart(ctx: AppContext, tenant: Tenant, cfg: z.infer<typeof oidcConfigSchema>, next: string) {
  const config = await oidcConfiguration(cfg);
  const verifier = oidc.randomPKCECodeVerifier();
  const state: SsoState = {
    tenantId: tenant.id,
    state: oidc.randomState(),
    nonce: oidc.randomNonce(),
    verifier,
    next,
    exp: Date.now() + 10 * 60_000,
  };
  const url = oidc.buildAuthorizationUrl(config, {
    redirect_uri: ssoEndpoints(ctx, tenant).oidcRedirectUri,
    scope: cfg.scopes,
    code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
    code_challenge_method: 'S256',
    state: state.state,
    nonce: state.nonce,
  });
  return { url: url.href, cookie: ctx.box.encrypt(JSON.stringify(state)) };
}

export interface SsoIdentity {
  subject: string;
  email: string;
  name: string | null;
}

const looksLikeEmail = (v: unknown): v is string => typeof v === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v);

export async function oidcCallback(ctx: AppContext, tenant: Tenant, cfg: z.infer<typeof oidcConfigSchema>, state: SsoState, query: string) {
  const config = await oidcConfiguration(cfg);
  const current = new URL(ssoEndpoints(ctx, tenant).oidcRedirectUri);
  current.search = query;
  const tokens = await oidc.authorizationCodeGrant(config, current, {
    pkceCodeVerifier: state.verifier,
    expectedState: state.state,
    expectedNonce: state.nonce,
    idTokenExpected: true,
  });
  const claims = tokens.claims()!;
  let email = claims.email;
  let name = claims.name;
  if (!looksLikeEmail(email)) {
    const info = await oidc.fetchUserInfo(config, tokens.access_token, claims.sub).catch(() => null);
    email = info?.email ?? (looksLikeEmail(claims.preferred_username) ? claims.preferred_username : claims.upn);
    name ??= info?.name;
  }
  if (claims.email_verified === false) throw new SsoError('email_not_verified');
  if (!looksLikeEmail(email)) throw new SsoError('no_email');
  return { subject: claims.sub, email: email.toLowerCase(), name: typeof name === 'string' ? name : null } satisfies SsoIdentity;
}

// SAML

const samlCache = new Map<string, { version: number; saml: SAML }>();

/** One SAML instance per customer, kept so the request ids it issues can be checked against the response. */
export function samlFor(ctx: AppContext, tenant: Tenant, provider: SsoInput & { updatedAt: Date }) {
  const version = provider.updatedAt.getTime();
  const hit = samlCache.get(tenant.id);
  if (hit && hit.version === version) return hit.saml;
  const cfg = provider.saml!;
  const ep = ssoEndpoints(ctx, tenant);
  const saml = new SAML({
    callbackUrl: ep.samlAcsUrl,
    entryPoint: cfg.entryPoint,
    issuer: ep.samlEntityId,
    audience: ep.samlEntityId,
    idpCert: cfg.idpCert,
    idpIssuer: cfg.idpIssuer || undefined,
    identifierFormat: null,
    wantAssertionsSigned: true,
    wantAuthnResponseSigned: false,
    disableRequestedAuthnContext: true,
    acceptedClockSkewMs: 120_000,
    validateInResponseTo: ValidateInResponseTo.ifPresent,
  });
  samlCache.set(tenant.id, { version, saml });
  return saml;
}

const EMAIL_ATTRS = [
  'email',
  'mail',
  'emailaddress',
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
  'urn:oid:0.9.2342.19200300.100.1.3',
];
const NAME_ATTRS = ['displayName', 'name', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name', 'http://schemas.microsoft.com/identity/claims/displayname', 'urn:oid:2.16.840.1.113730.3.1.241'];

export function samlIdentity(provider: SsoInput, profile: Record<string, unknown>): SsoIdentity {
  const cfg = provider.saml!;
  const pick = (names: string[]) => {
    for (const n of names) {
      const v = profile[n];
      const s = Array.isArray(v) ? v[0] : v;
      if (typeof s === 'string' && s) return s;
    }
    return null;
  };
  const email = pick(cfg.emailAttribute ? [cfg.emailAttribute] : [...EMAIL_ATTRS, 'nameID']);
  const name = pick(cfg.nameAttribute ? [cfg.nameAttribute] : NAME_ATTRS);
  const subject = typeof profile.nameID === 'string' && profile.nameID ? profile.nameID : email;
  if (!looksLikeEmail(email)) throw new SsoError('no_email');
  return { subject: subject!, email: email.toLowerCase(), name };
}

export class SsoError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/** Safe redirect target after sign-in: a path on this site only. */
export function safeNext(next: unknown) {
  return typeof next === 'string' && /^\/(?![/\\])[^\s]*$/.test(next) && !next.startsWith('/api/') ? next : '/';
}
