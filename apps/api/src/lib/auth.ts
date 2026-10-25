import argon2 from 'argon2';
import { and, eq, gt, isNull, or } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { schema } from '../db/index.js';
import type { AppContext } from './context.js';
import { randomToken, sha256 } from './crypto.js';
import { forbidden, unauthorized } from './errors.js';

export const SESSION_COOKIE = 'hrs_session';
const SESSION_DAYS = 14;
export const API_KEY_PREFIX = 'hrs_';

export type Role = (typeof schema.memberRole.enumValues)[number];
const roleRank: Record<Role, number> = { dj: 1, manager: 2, owner: 3 };

export interface AuthInfo {
  user: typeof schema.users.$inferSelect;
  via: 'session' | 'api_key';
  /** Set when an API key is limited to one tenant. */
  keyTenantId: string | null;
  readOnly: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthInfo | null;
  }
}

export const hashPassword = (password: string) => argon2.hash(password, { type: argon2.argon2id });
export const verifyPassword = (hash: string, password: string) => argon2.verify(hash, password).catch(() => false);

export async function createSession(ctx: AppContext, req: FastifyRequest, reply: FastifyReply, userId: string) {
  const token = randomToken();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400_000);
  await ctx.db.insert(schema.sessions).values({
    id: sha256(token),
    userId,
    expiresAt,
    ip: req.ip,
    userAgent: req.headers['user-agent']?.slice(0, 300) ?? null,
  });
  await ctx.db.update(schema.users).set({ lastLoginAt: new Date() }).where(eq(schema.users.id, userId));
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    // Behind Caddy or an external proxy, req.protocol comes from X-Forwarded-Proto of a trusted proxy.
    secure: req.protocol === 'https',
    expires: expiresAt,
  });
}

export async function destroySession(ctx: AppContext, req: FastifyRequest, reply: FastifyReply) {
  const token = req.cookies[SESSION_COOKIE];
  if (token) await ctx.db.delete(schema.sessions).where(eq(schema.sessions.id, sha256(token)));
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

export function generateApiKey() {
  const secret = `${API_KEY_PREFIX}${randomToken(24)}`;
  return { secret, prefix: secret.slice(0, 10), hash: sha256(secret) };
}

/** Resolves the caller from the session cookie or an `Authorization: Bearer hrs_...` API key. */
export function registerAuth(app: FastifyInstance) {
  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (req) => {
    const { db } = app.ctx;
    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ')) {
      const [row] = await db
        .select({ key: schema.apiKeys, user: schema.users })
        .from(schema.apiKeys)
        .innerJoin(schema.users, eq(schema.users.id, schema.apiKeys.userId))
        .where(
          and(
            eq(schema.apiKeys.hash, sha256(header.slice(7).trim())),
            or(isNull(schema.apiKeys.expiresAt), gt(schema.apiKeys.expiresAt, new Date())),
          ),
        );
      if (!row || !row.user.active) throw unauthorized();
      req.auth = { user: row.user, via: 'api_key', keyTenantId: row.key.tenantId, readOnly: row.key.readOnly };
      void db.update(schema.apiKeys).set({ lastUsedAt: new Date() }).where(eq(schema.apiKeys.id, row.key.id)).execute();
      return;
    }
    const token = req.cookies[SESSION_COOKIE];
    if (!token) return;
    const [row] = await db
      .select({ user: schema.users })
      .from(schema.sessions)
      .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
      .where(and(eq(schema.sessions.id, sha256(token)), gt(schema.sessions.expiresAt, new Date())));
    if (row?.user.active) req.auth = { user: row.user, via: 'session', keyTenantId: null, readOnly: false };
  });

  // Read-only API keys may only use safe methods.
  app.addHook('preHandler', async (req) => {
    if (req.auth?.readOnly && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      throw forbidden('This API key is read-only');
    }
  });
}

export function requireUser(req: FastifyRequest): AuthInfo {
  if (!req.auth) throw unauthorized();
  return req.auth;
}

export function requireSuperadmin(req: FastifyRequest): AuthInfo {
  const auth = requireUser(req);
  if (!auth.user.isSuperadmin || auth.keyTenantId) throw forbidden('Administrator rights required');
  return auth;
}

/** Ensures the caller has at least `minRole` in the tenant. Superadmins pass every check. */
export async function requireTenantRole(
  ctx: AppContext,
  req: FastifyRequest,
  tenantId: string,
  minRole: Role,
): Promise<AuthInfo & { role: Role | 'superadmin' }> {
  const auth = requireUser(req);
  if (auth.keyTenantId && auth.keyTenantId !== tenantId) throw forbidden('This API key is limited to another customer');
  if (auth.user.isSuperadmin) return { ...auth, role: 'superadmin' };
  const [m] = await ctx.db
    .select()
    .from(schema.memberships)
    .where(and(eq(schema.memberships.userId, auth.user.id), eq(schema.memberships.tenantId, tenantId)));
  if (!m || roleRank[m.role] < roleRank[minRole]) throw forbidden();
  return { ...auth, role: m.role };
}

export function canGrant(granter: Role | 'superadmin', role: Role) {
  return granter === 'superadmin' || roleRank[granter] >= roleRank[role];
}
