import { and, asc, eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { schema } from '../db/index.js';
import { requireSuperadmin, requireTenantRole } from '../lib/auth.js';
import { badRequest, conflict, isUniqueViolation, notFound } from '../lib/errors.js';
import { idParam, okOut } from '../lib/schemas.js';
import { dnsConfig, targetsOf } from '../services/dns/config.js';
import { dnsTarget, hostRe, verifyDomain } from '../services/streaming/domains.js';
import { applyStreams, stationStats } from '../services/streaming/state.js';
import { scopeOf } from '../services/nodes/dedication.js';

const domainParams = z.object({ id: z.uuid(), domainId: z.uuid() });
const hostSchema = z
  .string()
  .trim()
  .toLowerCase()
  .transform((v) => v.replace(/\.$/, ''))
  .refine((v) => hostRe.test(v), 'Invalid domain name');

const domainOut = z.object({
  id: z.uuid(),
  domain: z.string(),
  panelHost: z.string(),
  ingestHost: z.string(),
  status: z.enum(['pending', 'verified', 'failed']),
  verifiedManually: z.boolean(),
  checks: z.array(z.object({ host: z.string(), ok: z.boolean(), found: z.array(z.string()), error: z.string().optional(), warning: z.string().optional(), expected: z.string().optional() })),
  checkedAt: z.date().nullable(),
  verifiedAt: z.date().nullable(),
  /** Source node that takes the encoders of the ingest name; null = this server. */
  ingestNodeId: z.uuid().nullable(),
  /** Cloudflare DNS (phase 15): the CNAME targets of this domain on the platform domain; null = the shared target. */
  targets: z.object({ panel: z.string(), ingest: z.string() }).nullable(),
  createdAt: z.date(),
});
type DomainRow = typeof schema.tenantDomains.$inferSelect;

/** Customer domains (stream./src.) and the use of a customer's limits. Mounted under /api/tenants. */
export const tenantStreamingRoutes: FastifyPluginAsyncZod = async (app) => {
  const { ctx } = app;
  const toDomainOut = async ({ tenantId: _t, targetLabel, ...d }: DomainRow) => ({ ...d, targets: await targetsOf(ctx, targetLabel) });
  /** Cloudflare DNS makes (or removes) the domain's targets; a domain waits for its label before it is checked. */
  const dnsFollow = async () => {
    if (app.dns && (await dnsConfig(ctx)).active) await app.dns.run().catch(() => undefined);
  };

  app.get(
    '/:id/domains',
    {
      schema: {
        tags: ['Domains'],
        summary: "A customer's own domains, and what their DNS records must point to",
        params: idParam,
        response: { 200: z.object({ items: z.array(domainOut), target: z.object({ cname: z.string(), ips: z.array(z.string()) }) }) },
      },
    },
    async (req) => {
      await requireTenantRole(ctx, req, req.params.id, 'manager');
      const items = await ctx.db.select().from(schema.tenantDomains).where(eq(schema.tenantDomains.tenantId, req.params.id)).orderBy(asc(schema.tenantDomains.createdAt));
      return { items: await Promise.all(items.map(toDomainOut)), target: await dnsTarget(ctx) };
    },
  );

  app.post(
    '/:id/domains',
    {
      config: { audit: 'domain.create', rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: {
        tags: ['Domains'],
        summary: 'Add a domain. By default stream.<domain> serves the panel, public pages and streams, src.<domain> takes encoders.',
        params: idParam,
        body: z.object({ domain: hostSchema, panelHost: hostSchema.optional(), ingestHost: hostSchema.optional() }),
        response: { 201: domainOut },
      },
    },
    async (req, reply) => {
      await requireTenantRole(ctx, req, req.params.id, 'owner');
      const { domain } = req.body;
      const panelHost = req.body.panelHost ?? `stream.${domain}`;
      const ingestHost = req.body.ingestHost ?? `src.${domain}`;
      if (panelHost === ingestHost) throw badRequest('Use two different names for the panel and for encoders');
      for (const h of [panelHost, ingestHost]) if (h !== domain && !h.endsWith(`.${domain}`)) throw badRequest(`${h} is not part of ${domain}`);
      let row;
      try {
        [row] = await ctx.db.insert(schema.tenantDomains).values({ tenantId: req.params.id, domain, panelHost, ingestHost }).returning();
      } catch (err) {
        if (isUniqueViolation(err)) throw conflict('One of these names is already in use');
        throw err;
      }
      await dnsFollow();
      const [labelled] = await ctx.db.select().from(schema.tenantDomains).where(eq(schema.tenantDomains.id, row!.id));
      const { domain: checked } = await verifyDomain(ctx, labelled ?? row!);
      if (checked.status === 'verified') await applyStreams(ctx, { by: req.auth?.user.email });
      req.auditInfo.targetId = checked.id;
      req.auditInfo.details = { domain, panelHost, ingestHost, status: checked.status };
      reply.status(201);
      return await toDomainOut(checked);
    },
  );

  app.post(
    '/:id/domains/:domainId/verify',
    {
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: { tags: ['Domains'], summary: 'Check the DNS records of a domain now', params: domainParams, response: { 200: domainOut } },
    },
    async (req) => {
      await requireTenantRole(ctx, req, req.params.id, 'manager');
      const [row] = await ctx.db.select().from(schema.tenantDomains).where(and(eq(schema.tenantDomains.id, req.params.domainId), eq(schema.tenantDomains.tenantId, req.params.id)));
      if (!row) throw notFound('Domain');
      const { domain, changed } = await verifyDomain(ctx, row);
      if (changed) await applyStreams(ctx, { by: req.auth?.user.email });
      return await toDomainOut(domain);
    },
  );

  app.patch(
    '/:id/domains/:domainId',
    {
      config: { audit: 'domain.update' },
      schema: {
        tags: ['Domains'],
        summary: 'Mark a domain as verified without a DNS check, for split DNS or a LAN (administrators)',
        params: domainParams,
        body: z.object({ verifiedManually: z.boolean() }),
        response: { 200: domainOut },
      },
    },
    async (req) => {
      requireSuperadmin(req);
      const [row] = await ctx.db
        .update(schema.tenantDomains)
        .set({ verifiedManually: req.body.verifiedManually })
        .where(and(eq(schema.tenantDomains.id, req.params.domainId), eq(schema.tenantDomains.tenantId, req.params.id)))
        .returning();
      if (!row) throw notFound('Domain');
      const { domain } = await verifyDomain(ctx, row);
      await applyStreams(ctx, { by: req.auth?.user.email });
      req.auditInfo.targetId = row.id;
      req.auditInfo.details = { domain: row.domain, verifiedManually: row.verifiedManually };
      return await toDomainOut(domain);
    },
  );

  app.put(
    '/:id/domains/:domainId/ingest-node',
    {
      config: { audit: 'domain.ingest_node' },
      schema: {
        tags: ['Domains'],
        summary: 'Let a source node take the encoders of the ingest name (src.<domain>), or this server again (null)',
        params: domainParams,
        body: z.object({ nodeId: z.uuid().nullable() }),
        response: { 200: domainOut },
      },
    },
    async (req) => {
      const access = await requireTenantRole(ctx, req, req.params.id, 'owner');
      const [row] = await ctx.db.select().from(schema.tenantDomains).where(and(eq(schema.tenantDomains.id, req.params.domainId), eq(schema.tenantDomains.tenantId, req.params.id)));
      if (!row) throw notFound('Domain');
      const { nodeId } = req.body;
      if (nodeId) {
        const [node] = await ctx.db.select().from(schema.nodes).where(eq(schema.nodes.id, nodeId));
        if (!node || !node.roles.includes('source')) throw badRequest('Choose a node with the source role');
        // Customers use their own nodes; administrators may also use the platform's nodes.
        if (node.tenantId !== req.params.id && !(node.tenantId === null && access.role === 'superadmin')) throw badRequest('This node cannot take encoders of this customer');
        // A dedicated node (1.1.1) only takes encoders of its own customer; one dedicated to a single station takes no
        // encoder name of the whole customer.
        const sc = scopeOf(node);
        if (sc.kind === 'station' || (sc.kind === 'customer' && sc.tenantId !== req.params.id)) throw badRequest('This node is dedicated to another customer or station');
      }
      const [updated] = await ctx.db.update(schema.tenantDomains).set({ ingestNodeId: nodeId }).where(eq(schema.tenantDomains.id, row.id)).returning();
      await dnsFollow();
      const { domain } = await verifyDomain(ctx, updated!);
      await applyStreams(ctx, { by: req.auth?.user.email });
      req.auditInfo.targetId = row.id;
      req.auditInfo.details = { domain: row.domain, ingestNodeId: nodeId };
      return await toDomainOut(domain);
    },
  );

  app.delete(
    '/:id/domains/:domainId',
    { config: { audit: 'domain.delete' }, schema: { tags: ['Domains'], summary: 'Remove a domain', params: domainParams, response: { 200: okOut } } },
    async (req) => {
      await requireTenantRole(ctx, req, req.params.id, 'owner');
      const deleted = await ctx.db
        .delete(schema.tenantDomains)
        .where(and(eq(schema.tenantDomains.id, req.params.domainId), eq(schema.tenantDomains.tenantId, req.params.id)))
        .returning();
      if (!deleted.length) throw notFound('Domain');
      req.auditInfo.targetId = deleted[0]!.id;
      req.auditInfo.details = { domain: deleted[0]!.domain };
      await applyStreams(ctx, { by: req.auth?.user.email });
      app.dns?.nudge();
      return { ok: true as const };
    },
  );

  // Usage against the customer's limits

  app.get(
    '/:id/usage',
    {
      schema: {
        tags: ['Customers'],
        summary: "A customer's use of its limits: stations, listeners given out, listeners now and storage",
        params: idParam,
        response: {
          200: z.object({
            stations: z.object({ used: z.number(), limit: z.number() }),
            listeners: z.object({ allocated: z.number(), now: z.number(), limit: z.number() }),
            bitrate: z.object({ limit: z.number() }),
            storage: z.object({ usedBytes: z.number(), limitBytes: z.number() }),
          }),
        },
      },
    },
    async (req) => {
      await requireTenantRole(ctx, req, req.params.id, 'dj');
      const [tenant] = await ctx.db.select().from(schema.tenants).where(eq(schema.tenants.id, req.params.id));
      if (!tenant) throw notFound('Customer');
      const stations = await ctx.db.select().from(schema.stations).where(eq(schema.stations.tenantId, tenant.id));
      const stats = await Promise.all(stations.map((s) => (s.enabled ? stationStats(ctx, s) : Promise.resolve(null))));
      return {
        stations: { used: stations.length, limit: tenant.limits.maxStations },
        listeners: {
          allocated: stations.reduce((n, s) => n + s.maxListeners, 0),
          now: stats.reduce((n, s) => n + (s ?? []).reduce((a, m) => a + m.listeners, 0), 0),
          limit: tenant.limits.maxListeners,
        },
        bitrate: { limit: tenant.limits.maxBitrateKbps },
        storage: { usedBytes: stations.reduce((n, s) => n + s.storageBytes, 0), limitBytes: tenant.limits.storageQuotaMb * 1024 * 1024 },
      };
    },
  );
};
