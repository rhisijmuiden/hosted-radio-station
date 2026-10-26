import { and, asc, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import { schema } from '../db/index.js';
import { NODE_ROLES, type NodeRole, type NodeStatus } from '../db/schema.js';
import { requireSuperadmin, requireTenantRole, requireUser } from '../lib/auth.js';
import type { AppContext } from '../lib/context.js';
import { randomToken } from '../lib/crypto.js';
import { badRequest, conflict, forbidden, HttpError, notFound } from '../lib/errors.js';
import { okOut } from '../lib/schemas.js';
import { nodeEvent } from '../services/nodes/hub.js';
import { hashCode, installCommand, newPairingCode, PAIRING_HOURS } from '../services/nodes/pairing.js';
import { carried, nodeConfigSchema, nodeSettings, relayBaseUrl, relaysByStation, storedConfig, type Node } from '../services/nodes/plan.js';
import { authenticateNode, reportSchema, storeReport } from '../services/nodes/report.js';
import { forgetRelays, pickRelay } from '../services/nodes/routing.js';
import { getSetting, nodesSchema, putSetting } from '../services/settings.js';
import { applyStreams } from '../services/streaming/state.js';
import { getVersionInfo } from '../services/system.js';

const nodeParams = z.object({ id: z.uuid() });
const roleSchema = z.enum(NODE_ROLES);

const statusOut = z
  .object({
    online: z.boolean(),
    version: z.string().optional(),
    commit: z.string().nullish(),
    hostname: z.string().optional(),
    caddy: z.boolean().optional(),
    addresses: z.array(z.string()).optional(),
    ip: z.string().nullish(),
    country: z.string().nullish(),
    city: z.string().nullish(),
    latitude: z.number().nullish(),
    longitude: z.number().nullish(),
    cpu: z.number().optional(),
    memory: z.number().optional(),
    load: z.number().optional(),
    cores: z.number().optional(),
    uptime: z.number().optional(),
    rxBps: z.number().optional(),
    txBps: z.number().optional(),
    rttMs: z.number().nullish(),
    loss: z.number().optional(),
    timeouts24h: z.number().optional(),
    icmp: z.object({ rttMs: z.number().nullable(), loss: z.number() }).nullish(),
    listeners: z.number().optional(),
    relays: z
      .array(z.object({ key: z.string(), state: z.enum(['connecting', 'connected', 'error', 'idle']), message: z.string().optional(), bitrateKbps: z.number().nullish(), listeners: z.number().optional() }))
      .optional(),
    encoders: z.number().optional(),
    problems: z.array(z.string()).optional(),
    update: z.object({ state: z.enum(['idle', 'running', 'succeeded', 'failed']), message: z.string().optional(), at: z.string().optional() }).nullish(),
    updatedAt: z.string().optional(),
  });

const nodeOut = z.object({
  id: z.uuid(),
  tenantId: z.uuid().nullable(),
  tenantName: z.string().nullable(),
  name: z.string(),
  location: z.string(),
  roles: z.array(roleSchema),
  config: nodeConfigSchema,
  paired: z.boolean(),
  pairedAt: z.date().nullable(),
  pairingExpiresAt: z.date().nullable(),
  lastSeenAt: z.date().nullable(),
  status: statusOut,
  /** Where listeners of this node connect, e.g. https://relay.example.com. */
  listenBase: z.string().nullable(),
  /** The node runs another version than this server. */
  updateAvailable: z.boolean(),
  /** Encoder names (src.<domain>) routed to this node. */
  ingestHosts: z.array(z.string()),
  createdAt: z.date(),
});
type NodeOut = z.infer<typeof nodeOut>;

const pairingOut = z.object({ code: z.string(), expiresAt: z.date(), command: z.string() });

const createBody = z.object({
  name: z.string().trim().min(1).max(80),
  location: z.string().trim().max(80).default(''),
  tenantId: z.uuid().nullish(),
  roles: z.array(roleSchema).max(3).default([]),
});
const updateBody = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  location: z.string().trim().max(80).optional(),
  roles: z.array(roleSchema).max(3).optional(),
  config: nodeConfigSchema.partial().optional(),
});

const eventOut = z.object({ id: z.number(), at: z.date(), level: z.string(), kind: z.string(), details: z.record(z.string(), z.union([z.string(), z.number(), z.null()])) });
const metricOut = z.object({
  at: z.date(),
  rttAvg: z.number().nullable(),
  rttMax: z.number().nullable(),
  pings: z.number(),
  lost: z.number(),
  cpu: z.number().nullable(),
  memory: z.number().nullable(),
  rxBps: z.number().nullable(),
  txBps: z.number().nullable(),
  listeners: z.number().nullable(),
});
const probeOut = z.object({
  target: z.string(),
  stationId: z.uuid(),
  stationName: z.string(),
  url: z.string(),
  /** main, or the id of the relay node that was checked. */
  where: z.string(),
  whereName: z.string(),
  ok: z.boolean(),
  httpStatus: z.number().nullable(),
  ttfbMs: z.number().nullable(),
  message: z.string().nullable(),
  checkedAt: z.date(),
  lastOkAt: z.date().nullable(),
  /** Share of successful checks over the last 24 hours, 0..1, null without checks. */
  uptime24h: z.number().nullable(),
});

/** Who may see or change a node: administrators all of them, customers their own (owners change, managers look). */
async function nodeAccess(ctx: AppContext, req: FastifyRequest, id: string, minRole: 'manager' | 'owner') {
  const [node] = await ctx.db.select().from(schema.nodes).where(eq(schema.nodes.id, id));
  if (!node) throw notFound('Node');
  if (node.tenantId) await requireTenantRole(ctx, req, node.tenantId, minRole);
  else requireSuperadmin(req);
  return node;
}

/** Tenants whose nodes the caller may see, or null for all (administrators). */
async function visibleTenants(ctx: AppContext, req: FastifyRequest): Promise<string[] | null> {
  const auth = requireUser(req);
  if (auth.user.isSuperadmin && !auth.keyTenantId) return null;
  const rows = await ctx.db.select().from(schema.memberships).where(eq(schema.memberships.userId, auth.user.id));
  const ids = rows.filter((m) => m.role !== 'dj').map((m) => m.tenantId);
  return auth.keyTenantId ? ids.filter((t) => t === auth.keyTenantId) : ids;
}

const uptimeOf = (buckets: [number, number, number][]) => {
  const hour = Math.floor(Date.now() / 3600_000);
  const recent = buckets.filter((b) => b[0] > hour - 24);
  const checks = recent.reduce((n, b) => n + b[1], 0);
  return checks ? (checks - recent.reduce((n, b) => n + b[2], 0)) / checks : null;
};

export const nodeRoutes: FastifyPluginAsyncZod = async (app) => {
  const { ctx } = app;
  const hub = app.nodes;

  async function toOut(nodes: Node[]): Promise<NodeOut[]> {
    if (!nodes.length) return [];
    const ids = nodes.map((n) => n.id);
    const tenantIds = [...new Set(nodes.map((n) => n.tenantId).filter((t): t is string => !!t))];
    const [tenants, domains, v] = await Promise.all([
      tenantIds.length ? ctx.db.select({ id: schema.tenants.id, name: schema.tenants.name }).from(schema.tenants).where(inArray(schema.tenants.id, tenantIds)) : [],
      ctx.db.select({ nodeId: schema.tenantDomains.ingestNodeId, host: schema.tenantDomains.ingestHost }).from(schema.tenantDomains).where(inArray(schema.tenantDomains.ingestNodeId, ids)),
      getVersionInfo(ctx),
    ]);
    const tenantName = new Map(tenants.map((t) => [t.id, t.name]));
    return nodes.map((n) => {
      const status: NodeStatus = hub.liveStatus(n.id) ?? { ...n.status, online: false };
      return {
        id: n.id,
        tenantId: n.tenantId,
        tenantName: n.tenantId ? (tenantName.get(n.tenantId) ?? null) : null,
        name: n.name,
        location: n.location,
        roles: n.roles,
        config: nodeSettings(n),
        paired: !!n.pairedAt,
        pairedAt: n.pairedAt,
        pairingExpiresAt: n.pairingCodeHash && n.pairingExpiresAt && n.pairingExpiresAt > new Date() ? n.pairingExpiresAt : null,
        lastSeenAt: n.lastSeenAt,
        status,
        listenBase: n.roles.includes('relay') ? relayBaseUrl({ ...n, status }) : null,
        updateAvailable: !!n.pairedAt && !!status.commit && !!v.commit && status.commit !== v.commit,
        ingestHosts: domains.filter((d) => d.nodeId === n.id).map((d) => d.host),
        createdAt: n.createdAt,
      };
    });
  }

  async function newPairing(node: Pick<Node, 'id'>) {
    const code = newPairingCode();
    const expiresAt = new Date(Date.now() + PAIRING_HOURS * 3600_000);
    await ctx.db.update(schema.nodes).set({ pairingCodeHash: hashCode(code), pairingExpiresAt: expiresAt, updatedAt: new Date() }).where(eq(schema.nodes.id, node.id));
    return { code, expiresAt, command: await installCommand(ctx, code) };
  }

  /** After a change of roles or carried stations: listen routes here, routing, and the plans of all nodes. */
  async function replan(nodeId: string, by?: string, streams = false) {
    forgetRelays();
    if (streams) await applyStreams(ctx, { by });
    await hub.refresh(nodeId);
    void hub.refreshAll();
  }

  // Settings of the network (administrators).

  app.get('/settings', { schema: { tags: ['Nodes'], summary: 'Settings of the distribution network', response: { 200: nodesSchema } } }, async (req) => {
    requireSuperadmin(req);
    return getSetting(ctx, 'nodes');
  });

  app.put(
    '/settings',
    { config: { audit: 'settings.nodes' }, schema: { tags: ['Nodes'], summary: 'Change the settings of the distribution network', body: nodesSchema, response: { 200: nodesSchema } } },
    async (req) => {
      requireSuperadmin(req);
      await putSetting(ctx, 'nodes', req.body);
      forgetRelays();
      void hub.refreshAll();
      req.auditInfo.details = req.body;
      return getSetting(ctx, 'nodes');
    },
  );

  // Nodes

  app.get(
    '/',
    {
      schema: {
        tags: ['Nodes'],
        summary: 'Nodes you can see: all for administrators, otherwise those of your customers',
        querystring: z.object({ tenantId: z.uuid().optional() }),
        response: { 200: z.array(nodeOut) },
      },
    },
    async (req) => {
      const tenants = await visibleTenants(ctx, req);
      if (tenants && !tenants.length) return [];
      const filter = req.query.tenantId;
      if (filter && tenants && !tenants.includes(filter)) throw forbidden();
      const rows = await ctx.db
        .select()
        .from(schema.nodes)
        .where(filter ? eq(schema.nodes.tenantId, filter) : tenants ? inArray(schema.nodes.tenantId, tenants) : undefined)
        .orderBy(asc(schema.nodes.name));
      return toOut(rows);
    },
  );

  app.post(
    '/',
    {
      config: { audit: 'node.create', rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: {
        tags: ['Nodes'],
        summary: 'Add a node. You get a one-time pairing code and the command that installs the node agent.',
        body: createBody,
        response: { 201: z.object({ node: nodeOut, pairing: pairingOut }) },
      },
    },
    async (req, reply) => {
      const { tenantId } = req.body;
      if (tenantId) {
        const access = await requireTenantRole(ctx, req, tenantId, 'owner');
        if (access.role !== 'superadmin') {
          const [tenant] = await ctx.db.select({ limits: schema.tenants.limits }).from(schema.tenants).where(eq(schema.tenants.id, tenantId));
          const [{ n } = { n: 0 }] = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(schema.nodes).where(eq(schema.nodes.tenantId, tenantId));
          const allowed = tenant?.limits.maxNodes ?? 0;
          if (n >= allowed) throw conflict(allowed ? `Your plan allows ${allowed} own node(s)` : 'Your plan does not include own nodes; ask your provider');
        }
      } else requireSuperadmin(req);
      if (req.body.roles.includes('station') && new Set(req.body.roles).size > 1) throw badRequest('A station node has no other roles; its streams go to relay nodes');
      const [node] = await ctx.db
        .insert(schema.nodes)
        .values({ name: req.body.name, location: req.body.location, tenantId: tenantId ?? null, roles: [...new Set(req.body.roles)], config: storedConfig({}) })
        .returning();
      const pairing = await newPairing(node!);
      await nodeEvent(ctx, node!.id, 'created', 'info', { by: req.auth?.user.email ?? null });
      Object.assign(req.auditInfo, { tenantId: tenantId ?? null, targetId: node!.id, details: { name: node!.name } });
      reply.status(201);
      const [fresh] = await ctx.db.select().from(schema.nodes).where(eq(schema.nodes.id, node!.id));
      return { node: (await toOut([fresh!]))[0]!, pairing };
    },
  );

  app.get('/:id', { schema: { tags: ['Nodes'], summary: 'A node with its live status', params: nodeParams, response: { 200: nodeOut } } }, async (req) => {
    const node = await nodeAccess(ctx, req, req.params.id, 'manager');
    return (await toOut([node]))[0]!;
  });

  app.patch(
    '/:id',
    {
      config: { audit: 'node.update' },
      schema: { tags: ['Nodes'], summary: 'Rename a node, give it roles or change its settings; the agent rolls it out', params: nodeParams, body: updateBody, response: { 200: nodeOut } },
    },
    async (req) => {
      const node = await nodeAccess(ctx, req, req.params.id, 'owner');
      const b = req.body;
      const config = b.config ? storedConfig(b.config, node.config) : node.config;
      if (b.config?.relayStations && b.config.relayStations !== 'all' && node.tenantId) {
        const own = await ctx.db.select({ id: schema.stations.id }).from(schema.stations).where(eq(schema.stations.tenantId, node.tenantId));
        const ids = new Set(own.map((s) => s.id));
        if (b.config.relayStations.some((id) => !ids.has(id))) throw badRequest('A node of a customer can only carry that customer\'s stations');
      }
      const roles = b.roles ? ([...new Set(b.roles)] as NodeRole[]) : node.roles;
      if (roles.includes('station') && roles.length > 1) throw badRequest('A station node has no other roles; its streams go to relay nodes');
      if (node.roles.includes('station') && !roles.includes('station')) {
        const [running] = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(schema.stations).where(eq(schema.stations.nodeId, node.id));
        if (running && running.n > 0) throw conflict('Stations still run on this node; move them back to this server first');
      }
      const c = nodeSettings({ config });
      if (roles.includes('source') && c.sourcePlainPort && c.sourcePlainPort === c.sourceTlsPort) throw badRequest('Use two different ports for encoders');
      const [updated] = await ctx.db
        .update(schema.nodes)
        .set({ name: b.name ?? node.name, location: b.location ?? node.location, roles, config, updatedAt: new Date() })
        .where(eq(schema.nodes.id, node.id))
        .returning();
      if (b.roles && b.roles.join() !== node.roles.join()) await nodeEvent(ctx, node.id, 'roles', 'info', { roles: roles.join(', ') || null });
      Object.assign(req.auditInfo, { tenantId: node.tenantId, targetId: node.id, details: { name: updated!.name, roles, config: b.config ?? null } });
      const carriageChanged = b.roles !== undefined || b.config?.relayStations !== undefined || b.config?.publicHost !== undefined || b.config?.listenPort !== undefined;
      await replan(node.id, req.auth?.user.email, carriageChanged);
      return (await toOut([updated!]))[0]!;
    },
  );

  app.post(
    '/:id/pairing',
    {
      config: { audit: 'node.pairing', rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: {
        tags: ['Nodes'],
        summary: `A new one-time pairing code (valid ${PAIRING_HOURS} hours), to pair the node for the first time or again on a new machine`,
        params: nodeParams,
        response: { 200: pairingOut },
      },
    },
    async (req) => {
      const node = await nodeAccess(ctx, req, req.params.id, 'owner');
      Object.assign(req.auditInfo, { tenantId: node.tenantId, targetId: node.id, details: { name: node.name } });
      return newPairing(node);
    },
  );

  app.post(
    '/:id/unpair',
    { config: { audit: 'node.unpair' }, schema: { tags: ['Nodes'], summary: 'Unpair a node: it is disconnected and stops working until it is paired again', params: nodeParams, response: { 200: nodeOut } } },
    async (req) => {
      const node = await nodeAccess(ctx, req, req.params.id, 'owner');
      hub.disconnect(node.id);
      const [updated] = await ctx.db
        .update(schema.nodes)
        .set({ secret: null, pairedAt: null, status: { online: false }, clients: [], updatedAt: new Date() })
        .where(eq(schema.nodes.id, node.id))
        .returning();
      await nodeEvent(ctx, node.id, 'unpaired', 'warning', { by: req.auth?.user.email ?? null });
      Object.assign(req.auditInfo, { tenantId: node.tenantId, targetId: node.id, details: { name: node.name } });
      await replan(node.id, req.auth?.user.email, node.roles.includes('relay'));
      return (await toOut([updated!]))[0]!;
    },
  );

  app.post(
    '/:id/update',
    { config: { audit: 'node.update_request' }, schema: { tags: ['Nodes'], summary: 'Update the node to the version of this server now', params: nodeParams, response: { 200: okOut } } },
    async (req) => {
      const node = await nodeAccess(ctx, req, req.params.id, 'owner');
      const v = await getVersionInfo(ctx);
      if (!hub.requestUpdate(node.id, v.branch, v.commit)) throw conflict('The node is offline');
      await nodeEvent(ctx, node.id, 'update_requested', 'info', { commit: v.commit?.slice(0, 7) ?? null, by: req.auth?.user.email ?? null });
      Object.assign(req.auditInfo, { tenantId: node.tenantId, targetId: node.id, details: { name: node.name, commit: v.commit } });
      return { ok: true as const };
    },
  );

  app.delete('/:id', { config: { audit: 'node.delete' }, schema: { tags: ['Nodes'], summary: 'Remove a node', params: nodeParams, response: { 200: okOut } } }, async (req) => {
    const node = await nodeAccess(ctx, req, req.params.id, 'owner');
    const [running] = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(schema.stations).where(eq(schema.stations.nodeId, node.id));
    if (running && running.n > 0) throw conflict('Stations still run on this node; move them back to this server first');
    hub.disconnect(node.id);
    await ctx.db.delete(schema.nodes).where(eq(schema.nodes.id, node.id));
    Object.assign(req.auditInfo, { tenantId: node.tenantId, targetId: node.id, details: { name: node.name } });
    forgetRelays();
    if (node.roles.includes('relay')) await applyStreams(ctx, { by: req.auth?.user.email });
    void hub.refreshAll();
    return { ok: true as const };
  });

  app.get(
    '/:id/events',
    {
      schema: { tags: ['Nodes'], summary: 'What happened to a node, newest first', params: nodeParams, querystring: z.object({ limit: z.coerce.number().int().min(1).max(500).default(50) }), response: { 200: z.array(eventOut) } },
    },
    async (req) => {
      const node = await nodeAccess(ctx, req, req.params.id, 'manager');
      return ctx.db.select().from(schema.nodeEvents).where(eq(schema.nodeEvents.nodeId, node.id)).orderBy(desc(schema.nodeEvents.at), desc(schema.nodeEvents.id)).limit(req.query.limit);
    },
  );

  app.get(
    '/:id/metrics',
    {
      schema: {
        tags: ['Nodes'],
        summary: 'Health of a node over time: latency, lost pings, load, traffic and listeners',
        params: nodeParams,
        querystring: z.object({ hours: z.coerce.number().int().min(1).max(24 * 30).default(24) }),
        response: { 200: z.array(metricOut) },
      },
    },
    async (req) => {
      const node = await nodeAccess(ctx, req, req.params.id, 'manager');
      const hours = req.query.hours;
      // About 120–300 points whatever the period.
      const bucket = hours <= 2 ? 1 : hours <= 12 ? 5 : hours <= 48 ? 10 : hours <= 24 * 7 ? 60 : 240;
      const m = schema.nodeMetrics;
      // Inline (bucket is one of a few fixed numbers): as a parameter, GROUP BY would not match the selected column.
      const at = sql<Date>`date_bin(${sql.raw(`'${bucket} minutes'`)}::interval, ${m.at}, 'epoch'::timestamptz)`;
      const rows = await ctx.db
        .select({
          at,
          rttAvg: sql<number | null>`avg(${m.rttAvg})`,
          rttMax: sql<number | null>`max(${m.rttMax})`,
          pings: sql<number>`sum(${m.pings})::int`,
          lost: sql<number>`sum(${m.lost})::int`,
          cpu: sql<number | null>`avg(${m.cpu})`,
          memory: sql<number | null>`avg(${m.memory})`,
          rxBps: sql<number | null>`avg(${m.rxBps})`,
          txBps: sql<number | null>`avg(${m.txBps})`,
          listeners: sql<number | null>`max(${m.listeners})`,
        })
        .from(m)
        .where(and(eq(m.nodeId, node.id), gt(m.at, new Date(Date.now() - hours * 3600_000))))
        .groupBy(at)
        .orderBy(at);
      return rows.map((r) => ({ ...r, at: new Date(r.at), rttAvg: r.rttAvg === null ? null : Number(r.rttAvg), cpu: r.cpu === null ? null : Number(r.cpu), memory: r.memory === null ? null : Number(r.memory), rxBps: r.rxBps === null ? null : Number(r.rxBps), txBps: r.txBps === null ? null : Number(r.txBps), rttMax: r.rttMax === null ? null : Number(r.rttMax) }));
    },
  );

  async function probesOut(where: ReturnType<typeof eq>) {
    const rows = await ctx.db
      .select({ p: schema.nodeProbes, stationName: schema.stations.name })
      .from(schema.nodeProbes)
      .innerJoin(schema.stations, eq(schema.stations.id, schema.nodeProbes.stationId))
      .where(where)
      .orderBy(asc(schema.stations.name), asc(schema.nodeProbes.target));
    const relayIds = [...new Set(rows.map((r) => r.p.target.split('@')[1]!).filter((w) => w !== 'main'))];
    const names = relayIds.length ? await ctx.db.select({ id: schema.nodes.id, name: schema.nodes.name }).from(schema.nodes).where(inArray(schema.nodes.id, relayIds)) : [];
    const nameOf = new Map(names.map((n) => [n.id, n.name]));
    return rows.map(({ p, stationName }) => {
      const where = p.target.split('@')[1] ?? 'main';
      return {
        target: p.target,
        stationId: p.stationId,
        stationName,
        url: p.url,
        where,
        whereName: where === 'main' ? 'main' : (nameOf.get(where) ?? where),
        ok: p.ok,
        httpStatus: p.httpStatus,
        ttfbMs: p.ttfbMs,
        message: p.message,
        checkedAt: p.checkedAt,
        lastOkAt: p.lastOkAt,
        uptime24h: uptimeOf(p.buckets),
      };
    });
  }

  app.get('/:id/probes', { schema: { tags: ['Nodes'], summary: 'Stream checks from this node (remote probes)', params: nodeParams, response: { 200: z.array(probeOut) } } }, async (req) => {
    const node = await nodeAccess(ctx, req, req.params.id, 'manager');
    return probesOut(eq(schema.nodeProbes.nodeId, node.id));
  });

  app.get(
    '/topology',
    {
      schema: {
        tags: ['Nodes'],
        summary: 'The network as a graph for the topology view: this server, nodes, studios and how streams flow',
        querystring: z.object({ tenantId: z.uuid().optional() }),
        response: { 200: topologyOut },
      },
    },
    async (req) => buildTopology(req, req.query.tenantId),
  );

  async function buildTopology(req: FastifyRequest, tenantFilter?: string): Promise<z.infer<typeof topologyOut>> {
    const tenants = await visibleTenants(ctx, req);
    if (tenantFilter && tenants && !tenants.includes(tenantFilter)) throw forbidden();
    const scope = tenantFilter ? [tenantFilter] : tenants;
    const admin = tenants === null;
    const [settings, v, stations, allNodes] = await Promise.all([
      getSetting(ctx, 'nodes'),
      getVersionInfo(ctx),
      ctx.db
        .select({ id: schema.stations.id, name: schema.stations.name, slug: schema.stations.slug, tenantId: schema.stations.tenantId, nodeId: schema.stations.nodeId })
        .from(schema.stations)
        .innerJoin(schema.tenants, eq(schema.tenants.id, schema.stations.tenantId))
        .where(and(eq(schema.stations.enabled, true), eq(schema.tenants.active, true), scope ? inArray(schema.stations.tenantId, scope.length ? scope : ['00000000-0000-0000-0000-000000000000']) : undefined)),
      ctx.db.select().from(schema.nodes).orderBy(asc(schema.nodes.name)),
    ]);
    const stationIds = stations.map((s) => s.id);
    const scopeSet = scope ? new Set(scope) : null;
    // A customer sees its own nodes and the relays that carry its stations.
    const nodes = allNodes.filter((n) => {
      if (!scopeSet) return true;
      if (n.tenantId && scopeSet.has(n.tenantId)) return true;
      // A shared station node that runs one of the customer's stations belongs in its picture too.
      if (!n.tenantId && n.pairedAt && stations.some((s) => s.nodeId === n.id)) return true;
      return !n.tenantId && n.pairedAt && carried(n, stations).size > 0;
    });
    const [live, samples] = await Promise.all([
      stationIds.length
        ? ctx.db
            .select({ id: schema.liveSessions.id, stationId: schema.liveSessions.stationId, accountName: schema.liveSessions.accountName, via: schema.liveSessions.via, nodeId: schema.liveSessions.nodeId, startedAt: schema.liveSessions.startedAt, mountPath: schema.liveSessions.mountPath })
            .from(schema.liveSessions)
            .where(and(inArray(schema.liveSessions.stationId, stationIds), isNull(schema.liveSessions.endedAt)))
        : [],
      stationIds.length
        ? ctx.db
            .select({ stationId: schema.listenerSamples.stationId, target: schema.listenerSamples.target, avg: schema.listenerSamples.avg, at: schema.listenerSamples.at })
            .from(schema.listenerSamples)
            .where(and(inArray(schema.listenerSamples.stationId, stationIds), gt(schema.listenerSamples.at, new Date(Date.now() - 3 * 60_000))))
        : [],
    ]);
    // Listeners on this server: the mounts of the latest minute of each station.
    const latest = new Map<string, number>();
    for (const s of samples) latest.set(s.stationId, Math.max(latest.get(s.stationId) ?? 0, s.at.getTime()));
    const mainListeners = Math.round(samples.filter((s) => s.target.startsWith('mount:') && s.at.getTime() === latest.get(s.stationId)).reduce((n, s) => n + s.avg, 0));

    const nodeOutList = nodes.map((n) => {
      const status = hub.liveStatus(n.id) ?? { ...n.status, online: false };
      const carriedIds = [...carried(n, stations)];
      const degraded = status.online && ((status.rttMs ?? 0) > settings.latencyWarnMs || (status.loss ?? 0) > 0.05 || (status.problems?.length ?? 0) > 0 || !!status.relays?.some((r) => r.state === 'error'));
      const own = !!n.tenantId && !!scopeSet?.has(n.tenantId);
      return {
        id: n.id,
        name: admin || own ? n.name : n.location ? `Relay · ${n.location}` : 'Relay',
        location: n.location,
        roles: n.roles,
        own,
        tenantId: admin ? n.tenantId : own ? n.tenantId : null,
        paired: !!n.pairedAt,
        online: status.online,
        degraded,
        version: status.version ?? null,
        rttMs: status.rttMs ?? null,
        loss: status.loss ?? null,
        timeouts24h: status.timeouts24h ?? null,
        cpu: status.cpu ?? null,
        txBps: status.txBps ?? null,
        listeners: status.listeners ?? 0,
        encoders: status.encoders ?? 0,
        country: status.country ?? null,
        city: status.city ?? null,
        stations: n.roles.includes('station') ? stations.filter((s) => s.nodeId === n.id).length : carriedIds.length,
        updateAvailable: !!status.commit && !!v.commit && status.commit !== v.commit,
        relaysUp: status.relays?.filter((r) => r.state === 'connected').length ?? 0,
        relaysTotal: status.relays?.length ?? 0,
      };
    });

    const links: z.infer<typeof topologyOut>['links'] = [];
    for (const n of nodeOutList) {
      if (!n.paired) continue;
      const fresh = nodes.find((x) => x.id === n.id)!;
      const status = hub.liveStatus(n.id) ?? fresh.status;
      links.push({ from: n.id, to: 'main', kind: 'control', active: n.online, degraded: n.degraded, rttMs: n.rttMs, loss: n.loss });
      if (n.roles.includes('relay') && n.relaysUp > 0) links.push({ from: 'main', to: n.id, kind: 'stream', active: n.online, degraded: n.degraded, rttMs: n.rttMs, loss: n.loss });
      if (n.roles.includes('source') && (status.encoders ?? 0) > 0) links.push({ from: n.id, to: 'main', kind: 'stream', active: n.online, degraded: n.degraded, rttMs: n.rttMs, loss: n.loss });
    }
    // A station node pushes the streams of its stations straight to the relays that carry them.
    const relayMap = await relaysByStation(ctx);
    for (const n of nodeOutList) {
      if (!n.paired || !n.roles.includes('station')) continue;
      const mine = stations.filter((s) => s.nodeId === n.id);
      const runtime = mine.length ? await ctx.db.select({ runtime: schema.stations.nodeRuntime }).from(schema.stations).where(inArray(schema.stations.id, mine.map((s) => s.id))) : [];
      const states = new Map<string, string>();
      for (const r of runtime) for (const [relayId, st] of Object.entries(r.runtime?.relays ?? {})) if (st.state === 'connected' || !states.has(relayId)) states.set(relayId, st.state);
      for (const relayId of new Set(mine.flatMap((s) => (relayMap.get(s.id) ?? []).map((r: Node) => r.id)))) {
        if (!nodeOutList.some((x) => x.id === relayId)) continue;
        const state = states.get(relayId);
        links.push({ from: n.id, to: relayId, kind: 'stream', active: n.online && state === 'connected', degraded: state === 'error', rttMs: null, loss: null });
      }
    }
    const studios = live.map((l) => {
      const station = stations.find((s) => s.id === l.stationId)!;
      const viaNode = l.nodeId && nodes.some((n) => n.id === l.nodeId) ? l.nodeId : null;
      links.push({ from: `studio:${l.id}`, to: viaNode ?? 'main', kind: 'stream', active: true, degraded: false, rttMs: null, loss: null });
      return { id: `studio:${l.id}`, station: station.name, stationId: station.id, account: l.accountName, mount: l.mountPath, via: l.via, nodeId: viaNode, since: l.startedAt };
    });

    const online = nodeOutList.filter((n) => n.online);
    const relayListeners = nodeOutList.reduce((sum, n) => sum + (n.listeners ?? 0), 0);
    return {
      view: admin && !tenantFilter ? 'admin' : 'customer',
      main: { id: 'main', name: 'Main server', version: v.version, commit: v.commit, branch: v.branch, listeners: mainListeners, stations: stations.length },
      nodes: nodeOutList,
      studios,
      links,
      kpis: {
        nodesOnline: online.length,
        nodesTotal: nodeOutList.filter((n) => n.paired).length,
        degraded: online.filter((n) => n.degraded).length,
        listeners: mainListeners + relayListeners,
        relayListeners,
        avgRttMs: online.length && online.some((n) => n.rttMs != null) ? online.reduce((s, n) => s + (n.rttMs ?? 0), 0) / online.filter((n) => n.rttMs != null).length : null,
        worst: online.filter((n) => n.rttMs != null).sort((a, b) => (b.rttMs ?? 0) - (a.rttMs ?? 0))[0]?.name ?? null,
        worstRttMs: online.filter((n) => n.rttMs != null).sort((a, b) => (b.rttMs ?? 0) - (a.rttMs ?? 0))[0]?.rttMs ?? null,
        txBps: online.reduce((s, n) => s + (n.txBps ?? 0), 0),
        timeouts24h: nodeOutList.reduce((s, n) => s + (n.timeouts24h ?? 0), 0),
      },
    };
  }
};

const topologyOut = z.object({
  view: z.enum(['admin', 'customer']),
  main: z.object({ id: z.literal('main'), name: z.string(), version: z.string(), commit: z.string().nullable(), branch: z.string().nullable(), listeners: z.number(), stations: z.number() }),
  nodes: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      location: z.string(),
      roles: z.array(roleSchema),
      own: z.boolean(),
      tenantId: z.string().nullable(),
      paired: z.boolean(),
      online: z.boolean(),
      degraded: z.boolean(),
      version: z.string().nullable(),
      rttMs: z.number().nullable(),
      loss: z.number().nullable(),
      timeouts24h: z.number().nullable(),
      cpu: z.number().nullable(),
      txBps: z.number().nullable(),
      listeners: z.number(),
      encoders: z.number(),
      country: z.string().nullable(),
      city: z.string().nullable(),
      stations: z.number(),
      updateAvailable: z.boolean(),
      relaysUp: z.number(),
      relaysTotal: z.number(),
    }),
  ),
  studios: z.array(z.object({ id: z.string(), station: z.string(), stationId: z.string(), account: z.string(), mount: z.string(), via: z.string(), nodeId: z.string().nullable(), since: z.date() })),
  links: z.array(z.object({ from: z.string(), to: z.string(), kind: z.enum(['control', 'stream']), active: z.boolean(), degraded: z.boolean(), rttMs: z.number().nullable(), loss: z.number().nullable() })),
  kpis: z.object({
    nodesOnline: z.number(),
    nodesTotal: z.number(),
    degraded: z.number(),
    listeners: z.number(),
    relayListeners: z.number(),
    avgRttMs: z.number().nullable(),
    worst: z.string().nullable(),
    worstRttMs: z.number().nullable(),
    txBps: z.number(),
    timeouts24h: z.number(),
  }),
});

/** What the node agent talks to: pairing, the control channel and the bulk report. Mounted under /api/nodes. */
export const nodeAgentRoutes: FastifyPluginAsyncZod = async (app) => {
  const { ctx } = app;
  const hub = app.nodes;

  app.post(
    '/pair',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        tags: ['Node agent'],
        summary: 'Pair a node with its one-time code. Returns the node id and the secret the agent signs in with.',
        security: [],
        body: z.object({ code: z.string().trim().min(6).max(40), hostname: z.string().max(200).default(''), version: z.string().max(40).default('') }),
        response: { 200: z.object({ nodeId: z.uuid(), name: z.string(), secret: z.string() }) },
      },
    },
    async (req) => {
      const [node] = await ctx.db.select().from(schema.nodes).where(and(eq(schema.nodes.pairingCodeHash, hashCode(req.body.code)), gt(schema.nodes.pairingExpiresAt, new Date())));
      if (!node) throw new HttpError(400, 'invalid_code', 'This pairing code is unknown or has expired; make a new one in the panel');
      // A node that pairs again (new machine) replaces the old one.
      hub.disconnect(node.id);
      const secret = randomToken(32);
      await ctx.db
        .update(schema.nodes)
        .set({ secret: ctx.box.encrypt(secret), pairedAt: new Date(), pairingCodeHash: null, pairingExpiresAt: null, status: { online: false, hostname: req.body.hostname.slice(0, 100) }, updatedAt: new Date() })
        .where(eq(schema.nodes.id, node.id));
      await nodeEvent(ctx, node.id, 'paired', 'info', { hostname: req.body.hostname.slice(0, 100) || null, ip: req.ip });
      req.log.info({ node: node.name, ip: req.ip }, 'node paired');
      return { nodeId: node.id, name: node.name, secret };
    },
  );

  app.get('/connect', { websocket: true, schema: { hide: true } }, (socket: WebSocket, req) => {
    hub.attach(socket, req.ip ?? null);
  });

  app.post(
    '/agent/report',
    { bodyLimit: 16 * 1024 * 1024, schema: { hide: true, body: reportSchema } },
    async (req) => {
      const node = await authenticateNode(ctx, req.headers.authorization);
      return storeReport(ctx, hub, node, req.body);
    },
  );
};

/** Sends a listener to the best relay node of a station, or to this server. Mounted under /api/public. */
export const listenRedirectRoutes: FastifyPluginAsyncZod = async (app) => {
  const { ctx } = app;
  app.get(
    '/stations/:slug/listen/*',
    {
      schema: {
        tags: ['Public'],
        summary: 'Listen to a mount through the nearest healthy relay node (302 redirect); falls back to this server',
        security: [],
        params: z.object({ slug: z.string().max(48), '*': z.string().max(64) }),
      },
    },
    async (req, reply) => {
      const slug = req.params.slug.toLowerCase();
      const path = `/${req.params['*']}`;
      const [row] = await ctx.db
        .select({ id: schema.stations.id, tenantId: schema.stations.tenantId, enabled: schema.stations.enabled, nodeId: schema.stations.nodeId })
        .from(schema.stations)
        .where(eq(schema.stations.slug, slug));
      const [mount] = row ? await ctx.db.select().from(schema.stationMounts).where(and(eq(schema.stationMounts.stationId, row.id), eq(schema.stationMounts.path, path), eq(schema.stationMounts.isPublic, true))) : [];
      if (!row || !row.enabled || !mount) return reply.status(404).send({ error: { code: 'not_found', message: 'Stream not found' } });
      const settings = await getSetting(ctx, 'nodes');
      let target: string | null = null;
      // A station on a station node (phase 12) only exists on its relays, whatever the setting says.
      if (settings.routeListeners || row.nodeId) {
        await app.nodes.geo.refresh().catch(() => undefined);
        target = await pickRelay(ctx, row.id, slug, path, app.nodes.geo.lookup(req.ip));
      }
      if (!target && row.nodeId) return reply.status(503).header('cache-control', 'no-store').send({ error: { code: 'no_relay', message: 'This stream has no relay available right now' } });
      const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
      return reply
        .header('cache-control', 'no-store')
        .redirect(`${target ?? `/listen/${slug}${path}`}${qs}`, 302);
    },
  );
};
