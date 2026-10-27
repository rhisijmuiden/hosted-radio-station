import { eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { schema } from '../db/index.js';
import { requireSuperadmin } from '../lib/auth.js';
import { badRequest, notFound } from '../lib/errors.js';
import { idParam } from '../lib/schemas.js';
import { Cloudflare, CloudflareError } from '../services/dns/cloudflare.js';
import { dnsConfig, installId } from '../services/dns/config.js';
import { nodeAddresses, nodeFqdn } from '../services/dns/records.js';
import { nodeHost, nodeSettings } from '../services/nodes/plan.js';
import { cloudflareSchema, dnsStateSchema, getMaskedSetting, getSetting, putSetting, SECRET_MASK } from '../services/settings.js';
import { nodeAccess } from './nodes.js';

const settingsOut = cloudflareSchema.extend({
  /** The domain records go under: the one set here, else the domain under Web server. */
  platformDomain: z.string(),
  /** Part of every record comment (hrs:<install>:…), so installations sharing a zone keep apart. */
  install: z.string(),
});

const stateOut = dnsStateSchema;

/**
 * Cloudflare DNS of the platform domain (phase 15): settings, the connection test, the record overview (what exists
 * and what the platform would change), a run now and removing every record the platform made. Administrators only.
 */
export const dnsRoutes: FastifyPluginAsyncZod = async (app) => {
  const { ctx } = app;
  const manager = () => {
    if (!app.dns) throw badRequest('Cloudflare DNS runs on the main server');
    return app.dns;
  };
  const settingsView = async () => {
    const [s, { base }] = await Promise.all([getMaskedSetting(ctx, 'cloudflare'), dnsConfig(ctx)]);
    return { ...s, platformDomain: base, install: installId(ctx) };
  };

  app.get('/settings', { schema: { tags: ['DNS'], summary: 'Cloudflare DNS settings (token masked)', response: { 200: settingsOut } } }, async (req) => {
    requireSuperadmin(req);
    return settingsView();
  });

  app.put(
    '/settings',
    {
      config: { audit: 'settings.cloudflare' },
      schema: {
        tags: ['DNS'],
        summary: `Save the Cloudflare DNS settings. Send "${SECRET_MASK}" to keep the stored token. A run follows at once.`,
        body: cloudflareSchema,
        response: { 200: settingsOut },
      },
    },
    async (req) => {
      requireSuperadmin(req);
      const before = await getSetting(ctx, 'cloudflare');
      const next = { ...req.body };
      // Another token or domain may mean another zone: find it again.
      if ((next.apiToken !== SECRET_MASK && next.apiToken !== before.apiToken) || next.domain !== before.domain) {
        if (next.zoneId === before.zoneId) Object.assign(next, { zoneId: '', zoneName: '' });
      }
      await putSetting(ctx, 'cloudflare', next);
      manager().forgetZone();
      req.auditInfo.details = { mode: next.mode, domain: next.domain || null, nodeRecords: next.nodeRecords, customerTargets: next.customerTargets, panelRecord: next.panelRecord };
      void manager().run({ by: req.auth?.user.email ?? null }).catch(() => undefined);
      return settingsView();
    },
  );

  app.post(
    '/test',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        tags: ['DNS'],
        summary: 'Check the token and find the zone of the platform domain. Without a token in the body the stored one is used.',
        body: z.object({ apiToken: z.string().trim().max(200).optional(), domain: z.string().trim().toLowerCase().max(253).optional() }).optional(),
        response: { 200: z.object({ ok: z.boolean(), zoneId: z.string().nullable(), zoneName: z.string().nullable(), records: z.number().nullable(), message: z.string().nullable() }) },
      },
    },
    async (req) => {
      requireSuperadmin(req);
      const stored = await getSetting(ctx, 'cloudflare');
      const token = req.body?.apiToken && req.body.apiToken !== SECRET_MASK ? req.body.apiToken : stored.apiToken;
      const domain = req.body?.domain || (await dnsConfig(ctx)).base;
      if (!token) throw badRequest('Enter an API token first');
      if (!domain) throw badRequest('Set the platform domain first');
      const cf = new Cloudflare(token, ctx.config.CLOUDFLARE_API_URL);
      try {
        await cf.verifyToken();
        const zone = await cf.findZone(domain);
        if (!zone) return { ok: false, zoneId: null, zoneName: null, records: null, message: `No zone for ${domain} that this token can see` };
        const records = await cf.listRecords(zone.id);
        // Remember the zone when the token tested is the stored one.
        if (token === stored.apiToken) {
          await putSetting(ctx, 'cloudflare', { ...stored, apiToken: SECRET_MASK, zoneId: zone.id, zoneName: zone.name });
          manager().forgetZone();
        }
        return { ok: true, zoneId: zone.id, zoneName: zone.name, records: records.length, message: null };
      } catch (err) {
        if (err instanceof CloudflareError) return { ok: false, zoneId: null, zoneName: null, records: null, message: err.message };
        throw err;
      }
    },
  );

  app.get('/state', { schema: { tags: ['DNS'], summary: 'The last run: wanted records and their state in the zone, problems and the last changes', response: { 200: stateOut } } }, async (req) => {
    requireSuperadmin(req);
    return getSetting(ctx, 'dnsState');
  });

  app.post(
    '/sync',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: { tags: ['DNS'], summary: 'Compare the zone now (and write the changes in mode "on"); every change goes into the audit log', response: { 200: stateOut } },
    },
    async (req) => {
      requireSuperadmin(req);
      return manager().run({ by: req.auth?.user.email ?? null });
    },
  );

  app.post(
    '/purge',
    {
      config: { audit: 'dns.purge', rateLimit: { max: 3, timeWindow: '1 minute' } },
      schema: {
        tags: ['DNS'],
        summary: 'Remove every record this installation made in the zone (other records are never touched). Switch DNS off first, or the next run makes them again.',
        body: z.object({ confirm: z.literal(true) }),
        response: { 200: stateOut },
      },
    },
    async (req) => {
      requireSuperadmin(req);
      if ((await getSetting(ctx, 'cloudflare')).mode === 'on') throw badRequest('Switch Cloudflare DNS off (or to dry run) first');
      return manager().run({ by: req.auth?.user.email ?? null, purge: true });
    },
  );
};

const nodeDnsOut = z.object({
  /** Cloudflare DNS is on. */
  active: z.boolean(),
  /** The node's platform name, as it is or as it would be. */
  platformName: z.string().nullable(),
  /** The record exists: the name works. */
  live: z.boolean(),
  /** The public addresses the record gets. */
  addresses: z.array(z.string()),
  /** Why the node has no record: no public address, or the name is taken. */
  problem: z.enum(['noAddress', 'nameTaken', 'off']).nullable(),
  /** The name used for the node now (its own name, else the platform name). */
  host: z.string().nullable(),
  /** The node's own name and its check (CNAME to the platform name, or an A record to the node). */
  ownHost: z.string().nullable(),
  check: z.object({ ok: z.boolean(), found: z.array(z.string()), error: z.string().optional(), at: z.string() }).nullable(),
});

/** A node's platform name and the check of its own name (phase 15). Mounted under /api/nodes. */
export const nodeDnsRoutes: FastifyPluginAsyncZod = async (app) => {
  const { ctx } = app;

  async function view(nodeId: string): Promise<z.infer<typeof nodeDnsOut>> {
    const [node] = await ctx.db.select().from(schema.nodes).where(eq(schema.nodes.id, nodeId));
    if (!node) throw notFound('Node');
    const { s, base, active } = await dnsConfig(ctx);
    const c = nodeSettings(node);
    const status = app.nodes.liveStatus(node.id) ?? node.status;
    const [tenant] = node.tenantId ? await ctx.db.select({ slug: schema.tenants.slug }).from(schema.tenants).where(eq(schema.tenants.id, node.tenantId)) : [];
    const name = base && s.mode !== 'off' && s.nodeRecords && c.dnsRecord ? nodeFqdn({ dnsName: c.dnsName, name: node.name, tenantSlug: tenant?.slug ?? null }, base, s) : null;
    const addresses = nodeAddresses({ publicAddress: c.publicAddress, ip: status.ip ?? null, addresses: status.addresses ?? [] });
    const state = await getSetting(ctx, 'dnsState');
    const problem = state.problems.find((p) => p.ref === node.id && (p.kind === 'noAddress' || p.kind === 'nameTaken'));
    const own = c.publicHost && c.publicHost !== c.dnsHost && !(base && c.publicHost.endsWith(`.${base}`)) ? c.publicHost : null;
    return {
      active,
      platformName: c.dnsHost || name,
      live: !!c.dnsHost,
      addresses,
      problem: !name ? 'off' : ((problem?.kind as 'noAddress' | 'nameTaken' | undefined) ?? (addresses.length ? null : 'noAddress')),
      host: nodeHost(node) || null,
      ownHost: own,
      check: own ? c.publicHostCheck : null,
    };
  }

  app.get('/:id/dns', { schema: { tags: ['Nodes'], summary: "A node's platform name (Cloudflare DNS) and the check of its own host name", params: idParam, response: { 200: nodeDnsOut } } }, async (req) => {
    const node = await nodeAccess(ctx, req, req.params.id, 'manager');
    return view(node.id);
  });

  app.post(
    '/:id/dns/verify',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: { tags: ['Nodes'], summary: "Check the node's own host name now (a CNAME to its platform name, or an A record to its address)", params: idParam, response: { 200: nodeDnsOut } },
    },
    async (req) => {
      const node = await nodeAccess(ctx, req, req.params.id, 'manager');
      await app.dns?.checkOwnNames(node.id);
      return view(node.id);
    },
  );
};
