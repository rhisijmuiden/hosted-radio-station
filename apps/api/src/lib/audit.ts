import type { FastifyInstance, FastifyRequest } from 'fastify';
import { schema } from '../db/index.js';
import type { AppContext } from './context.js';

export interface AuditInfo {
  tenantId?: string | null;
  targetType?: string;
  targetId?: string | null;
  details?: Record<string, unknown>;
  /** For requests without a signed-in user yet, such as a sign-in. */
  actor?: { id: string | null; email: string | null };
  via?: string;
  success?: boolean;
  /** Set by a handler when nothing happened that is worth logging. */
  skip?: boolean;
}

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Action name written to the audit log when the request succeeds, e.g. "tenant.create". */
    audit?: string;
  }
  interface FastifyRequest {
    auditInfo: AuditInfo;
  }
}

export interface AuditEntry {
  action: string;
  actorUserId?: string | null;
  actorEmail?: string | null;
  via: string;
  tenantId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  success?: boolean;
  ip?: string | null;
  userAgent?: string | null;
  details?: Record<string, unknown> | null;
}

export async function writeAudit(ctx: AppContext, entry: AuditEntry) {
  await ctx.db.insert(schema.auditLog).values({
    action: entry.action,
    actorUserId: entry.actorUserId ?? null,
    actorEmail: entry.actorEmail ?? null,
    via: entry.via,
    tenantId: entry.tenantId ?? null,
    targetType: entry.targetType ?? entry.action.split('.')[0] ?? null,
    targetId: entry.targetId ?? null,
    success: entry.success ?? true,
    ip: entry.ip ?? null,
    userAgent: entry.userAgent?.slice(0, 300) ?? null,
    details: entry.details && Object.keys(entry.details).length ? entry.details : null,
  });
}

/** Writes an audit entry for the current request right away (sign-ins, failures, background events). */
export function auditNow(ctx: AppContext, req: FastifyRequest, action: string, info: AuditInfo = {}) {
  return writeAudit(ctx, {
    action,
    actorUserId: info.actor?.id ?? req.auth?.user.id ?? null,
    actorEmail: info.actor?.email ?? req.auth?.user.email ?? null,
    via: info.via ?? req.auth?.via ?? 'anonymous',
    tenantId: info.tenantId ?? null,
    targetType: info.targetType,
    targetId: info.targetId ?? null,
    success: info.success,
    ip: req.ip,
    userAgent: req.headers['user-agent'] ?? null,
    details: info.details,
  }).catch((err) => req.log.error({ err }, 'audit log write failed'));
}

/**
 * Routes opt in with `config: { audit: 'thing.verb' }`. After a successful response the entry is written with the
 * caller, IP address and the `:id` of the URL. Handlers add the customer or details through `req.auditInfo`.
 */
export function registerAudit(app: FastifyInstance) {
  app.decorateRequest('auditInfo', null as unknown as AuditInfo);
  app.addHook('onRequest', async (req) => {
    req.auditInfo = {};
  });
  app.addHook('onResponse', async (req, reply) => {
    const action = req.routeOptions.config?.audit;
    const info = req.auditInfo;
    if (!action || info?.skip || reply.statusCode >= 400) return;
    const params = (req.params ?? {}) as Record<string, string>;
    const tenantId = info.tenantId !== undefined ? info.tenantId : req.routeOptions.url?.startsWith('/api/tenants/:id') ? params.id : null;
    await auditNow(app.ctx, req, action, {
      ...info,
      tenantId,
      targetId: info.targetId !== undefined ? info.targetId : (params.userId ?? params.id ?? null),
    });
  });
}
