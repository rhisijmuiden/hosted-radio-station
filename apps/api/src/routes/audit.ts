import { and, desc, eq, gte, ilike, like, lt, lte, or, type SQL } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { schema } from '../db/index.js';
import { requireTenantRole, requireUser } from '../lib/auth.js';
import { forbidden } from '../lib/errors.js';

const entryOut = z.object({
  id: z.number(),
  at: z.date(),
  actorUserId: z.string().nullable(),
  actorEmail: z.string().nullable(),
  actorName: z.string().nullable(),
  via: z.string(),
  tenantId: z.string().nullable(),
  tenantName: z.string().nullable(),
  action: z.string(),
  targetType: z.string().nullable(),
  targetId: z.string().nullable(),
  success: z.boolean(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  details: z.record(z.string(), z.unknown()).nullable(),
});

const filters = z.object({
  tenantId: z.uuid().optional(),
  /** Exact action ("tenant.create") or a group ("tenant"). */
  action: z.string().max(60).optional(),
  /** Searches the e-mail address of the actor, the IP address and the target id. */
  q: z.string().trim().max(200).optional(),
  success: z.enum(['true', 'false']).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  // Neutralise spreadsheet formulas and quote everything.
  return `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replaceAll('"', '""')}"`;
};

/** Audit log: administrators see everything, customer owners and managers see their own customer. */
export const auditRoutes: FastifyPluginAsyncZod = async (app) => {
  const { ctx } = app;

  async function scope(req: Parameters<typeof requireUser>[0], query: z.infer<typeof filters>) {
    const auth = requireUser(req);
    const where: SQL[] = [];
    if (auth.user.isSuperadmin && !auth.keyTenantId) {
      if (query.tenantId) where.push(eq(schema.auditLog.tenantId, query.tenantId));
    } else {
      if (!query.tenantId) throw forbidden('Choose a customer');
      await requireTenantRole(ctx, req, query.tenantId, 'manager');
      where.push(eq(schema.auditLog.tenantId, query.tenantId));
    }
    if (query.action) {
      where.push(query.action.includes('.') ? eq(schema.auditLog.action, query.action) : like(schema.auditLog.action, `${query.action}.%`));
    }
    if (query.q) {
      const q = `%${query.q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
      where.push(or(ilike(schema.auditLog.actorEmail, q), ilike(schema.auditLog.ip, q), ilike(schema.auditLog.targetId, q))!);
    }
    if (query.success) where.push(eq(schema.auditLog.success, query.success === 'true'));
    if (query.from) where.push(gte(schema.auditLog.at, query.from));
    if (query.to) where.push(lte(schema.auditLog.at, query.to));
    return where;
  }

  function select() {
    return ctx.db
      .select({
        id: schema.auditLog.id,
        at: schema.auditLog.at,
        actorUserId: schema.auditLog.actorUserId,
        actorEmail: schema.auditLog.actorEmail,
        actorName: schema.users.name,
        via: schema.auditLog.via,
        tenantId: schema.auditLog.tenantId,
        tenantName: schema.tenants.name,
        action: schema.auditLog.action,
        targetType: schema.auditLog.targetType,
        targetId: schema.auditLog.targetId,
        success: schema.auditLog.success,
        ip: schema.auditLog.ip,
        userAgent: schema.auditLog.userAgent,
        details: schema.auditLog.details,
      })
      .from(schema.auditLog)
      .leftJoin(schema.users, eq(schema.users.id, schema.auditLog.actorUserId))
      .leftJoin(schema.tenants, eq(schema.tenants.id, schema.auditLog.tenantId));
  }

  app.get(
    '/',
    {
      schema: {
        tags: ['Audit log'],
        summary: 'Audit log, newest first. Page with `before` (the id of the last entry you have).',
        querystring: filters.extend({
          before: z.coerce.number().int().positive().optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        }),
        response: { 200: z.object({ items: z.array(entryOut), nextBefore: z.number().nullable() }) },
      },
    },
    async (req) => {
      const where = await scope(req, req.query);
      if (req.query.before) where.push(lt(schema.auditLog.id, req.query.before));
      const rows = await select()
        .where(and(...where))
        .orderBy(desc(schema.auditLog.id))
        .limit(req.query.limit + 1);
      const more = rows.length > req.query.limit;
      const items = rows.slice(0, req.query.limit);
      return { items, nextBefore: more ? items.at(-1)!.id : null };
    },
  );

  app.get(
    '/export.csv',
    {
      config: { audit: 'audit.export', rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: { tags: ['Audit log'], summary: 'Download the filtered audit log as CSV (at most 50,000 rows)', querystring: filters },
    },
    async (req, reply) => {
      const where = await scope(req, req.query);
      req.auditInfo = { tenantId: req.query.tenantId ?? null };
      const rows = await select().where(and(...where)).orderBy(desc(schema.auditLog.id)).limit(50_000);
      const head = ['time', 'action', 'success', 'actor', 'via', 'customer', 'target_type', 'target_id', 'ip', 'details'];
      const lines = rows.map((r) =>
        [r.at.toISOString(), r.action, r.success, r.actorEmail, r.via, r.tenantName, r.targetType, r.targetId, r.ip, r.details].map(csvCell).join(','),
      );
      return reply
        .type('text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="audit-log-${new Date().toISOString().slice(0, 10)}.csv"`)
        .send(`﻿${[head.join(','), ...lines].join('\r\n')}\r\n`);
    },
  );

  app.get(
    '/actions',
    {
      schema: {
        tags: ['Audit log'],
        summary: 'The action names that occur in the log, for filters',
        querystring: z.object({ tenantId: z.uuid().optional() }),
        response: { 200: z.array(z.string()) },
      },
    },
    async (req) => {
      const where = await scope(req, req.query);
      const rows = await ctx.db
        .selectDistinct({ action: schema.auditLog.action })
        .from(schema.auditLog)
        .where(and(...where))
        .orderBy(schema.auditLog.action);
      return rows.map((r) => r.action);
    },
  );
};
