import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm';
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
import { clientIp } from '../lib/cloudflare-ips.js';
import { nodeEvent } from '../services/nodes/hub.js';
import { hashCode, installCommand, newPairingCode, PAIRING_HOURS } from '../services/nodes/pairing.js';
import { carried, nodeConfigPatch, nodeConfigSchema, type NodeConfigPatch, nodeSettings, relayBaseUrl, relaysByStation, relaysOf, storedConfig, type Node } from '../services/nodes/plan.js';
import { scopeOf, serves } from '../services/nodes/dedication.js';
import { ingestNodes, ingestsOf, localIngest, pushedRouting, stationRouting } from '../services/nodes/routing-rules.js';
import { readStreamsStatus } from '../services/streaming/status.js';
import { authenticateNode, reportSchema, storeReport } from '../services/nodes/report.js';
import { forgetRelays, pickRelay } from '../services/nodes/routing.js';
import { nodeUpdateInfo, type UpdateOverview } from '../services/nodes/updates.js';
import { getSetting, nodesSchema, putSetting, serverNameSchema, UPDATE_POLICIES, updateWindowSchema } from '../services/settings.js';
import { assertFreeName, serverNames } from '../services/nodes/names.js';
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
    ffmpeg: z.boolean().optional(),
    soundcards: z.array(z.object({ device: z.string(), name: z.string() })).optional(),
    fm: z
      .object({
        input: z.enum(['idle', 'connecting', 'connected', 'error']),
        inputMessage: z.string().optional(),
        title: z.string().nullable(),
        output: z.enum(['off', 'starting', 'running', 'error']),
        outputMessage: z.string().optional(),
        uecp: z.enum(['off', 'connecting', 'connected', 'error']),
        uecpMessage: z.string().optional(),
        meters: z
          .object({ peak: z.number(), left: z.number(), right: z.number(), buffered: z.number(), ppm: z.number(), underruns: z.number(), overruns: z.number(), playing: z.boolean() })
          .nullable(),
        ps: z.string(),
        psFrames: z.array(z.string()),
        rt: z.string(),
        tags: z.array(z.object({ type: z.number(), start: z.number(), length: z.number() })),
        groups: z.record(z.string(), z.number()),
      })
      .nullish(),
    updatedAt: z.string().optional(),
  });

const refOut = z.object({ commit: z.string().nullable(), branch: z.string().nullable() });
const UPDATE_STATES = ['upToDate', 'waiting', 'scheduled', 'manual', 'paused', 'disabled', 'failed', 'queued', 'draining', 'updating', 'checking', 'rollingBack'] as const;
const updateInfoOut = z.object({
  policy: z.enum(UPDATE_POLICIES),
  source: z.enum(['node', 'group', 'role', 'network']),
  group: z.object({ id: z.string(), name: z.string() }).nullable(),
  window: updateWindowSchema,
  state: z.enum(UPDATE_STATES),
  target: refOut,
  nextWindowAt: z.string().nullable(),
  phaseAt: z.string().nullable(),
  phaseEndsAt: z.string().nullable(),
  message: z.string().nullable(),
  queuePosition: z.number().nullable(),
  last: z
    .object({ state: z.enum(['succeeded', 'failed', 'rolledBack']), target: refOut, from: refOut, message: z.string().nullable(), at: z.string(), rollbackTo: z.string().nullable() })
    .nullable(),
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
  /** How and when the node gets the version of this server, and how far its update is. */
  update: updateInfoOut,
  /** Encoder names (src.<domain>) routed to this node. */
  ingestHosts: z.array(z.string()),
  /** Shared or dedicated (1.1.1): who the node serves, from its settings and roles. "placed" = the stations on it. */
  scope: z.object({ kind: z.enum(['shared', 'customer', 'station', 'placed', 'none']), tenantId: z.uuid().nullable(), stationId: z.uuid().nullable() }),
  createdAt: z.date(),
});
type NodeOut = z.infer<typeof nodeOut>;

const pairingOut = z.object({ code: z.string(), expiresAt: z.date(), command: z.string() });

const createBody = z.object({
  name: serverNameSchema,
  location: z.string().trim().max(80).default(''),
  tenantId: z.uuid().nullish(),
  roles: z.array(roleSchema).max(NODE_ROLES.length).default([]),
});
const updateBody = z.object({
  name: serverNameSchema.optional(),
  location: z.string().trim().max(80).optional(),
  roles: z.array(roleSchema).max(NODE_ROLES.length).optional(),
  config: nodeConfigPatch.optional(),
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
export async function nodeAccess(ctx: AppContext, req: FastifyRequest, id: string, minRole: 'manager' | 'owner') {
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

  const scopeOut = (n: Node): NodeOut['scope'] => {
    const sc = scopeOf(n);
    return { kind: sc.kind, tenantId: sc.kind === 'customer' ? sc.tenantId : null, stationId: sc.kind === 'station' ? sc.stationId : null };
  };

  async function toOut(nodes: Node[]): Promise<NodeOut[]> {
    if (!nodes.length) return [];
    const ids = nodes.map((n) => n.id);
    const tenantIds = [...new Set(nodes.map((n) => n.tenantId).filter((t): t is string => !!t))];
    const [tenants, domains, v, ov] = await Promise.all([
      tenantIds.length ? ctx.db.select({ id: schema.tenants.id, name: schema.tenants.name }).from(schema.tenants).where(inArray(schema.tenants.id, tenantIds)) : [],
      ctx.db.select({ nodeId: schema.tenantDomains.ingestNodeId, host: schema.tenantDomains.ingestHost }).from(schema.tenantDomains).where(inArray(schema.tenantDomains.ingestNodeId, ids)),
      getVersionInfo(ctx),
      app.nodeUpdates.overview(),
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
        update: nodeUpdateInfo(n, status, ov),
        ingestHosts: domains.filter((d) => d.nodeId === n.id).map((d) => d.host),
        scope: scopeOut(n),
        createdAt: n.createdAt,
      };
    });
  }

  /**
   * Shared or dedicated (1.1.1): the customer or station a node is dedicated to must exist, and the stations it carries,
   * puts on air or takes encoders for must all be ones it serves. Stations that still use the node otherwise refuse
   * the change, so nothing silently loses its relay or ingest.
   */
  async function checkDedication(node: Node, roles: NodeRole[], config: Node['config'], patch: NodeConfigPatch) {
    const c = nodeSettings({ config });
    if (patch.dedicatedTenantId) {
      const [t] = await ctx.db.select({ id: schema.tenants.id }).from(schema.tenants).where(eq(schema.tenants.id, patch.dedicatedTenantId));
      if (!t) throw badRequest('Unknown customer');
    }
    if (c.dedication === 'customer' && !node.tenantId && !c.dedicatedTenantId) throw badRequest('Choose the customer this node is dedicated to');
    if (c.dedication === 'station' && !c.dedicatedStationId) throw badRequest('Choose the station this node is dedicated to');
    const all = await ctx.db.select({ id: schema.stations.id, name: schema.stations.name, tenantId: schema.stations.tenantId, nodeId: schema.stations.nodeId, routing: schema.stations.routing }).from(schema.stations);
    if (c.dedication === 'station') {
      const st = all.find((x) => x.id === c.dedicatedStationId);
      if (!st) throw badRequest('Unknown station');
      if (node.tenantId && st.tenantId !== node.tenantId) throw badRequest('A node of a customer can only be dedicated to one of that customer\'s stations');
    }
    const next = { id: node.id, tenantId: node.tenantId, roles, config };
    const byId = new Map(all.map((x) => [x.id, x]));
    // Stations removed since keep their place in a stored list; a new list may only name stations the node serves.
    const named = patch.relayStations && patch.relayStations !== 'all' ? new Set(patch.relayStations) : new Set<string>();
    if (c.relayStations !== 'all' && c.relayStations.some((id) => (byId.has(id) ? !serves(next, byId.get(id)!) : named.has(id))))
      throw badRequest(node.tenantId ? 'A node of a customer can only carry that customer\'s stations' : 'This node is dedicated: it can only carry the stations it is dedicated to');
    if (c.fm.stationId) {
      const st = byId.get(c.fm.stationId);
      if (!st) throw badRequest('Unknown station');
      if (!serves(next, st)) throw badRequest(node.tenantId ? 'A node of a customer can only put that customer\'s stations on air' : 'This node is dedicated: it can only put the stations it is dedicated to on air');
    }
    const users = all.filter((x) => {
      if (serves(next, x)) return false;
      if (x.nodeId === node.id) return true;
      const r = stationRouting(x);
      return ingestsOf(r).some((i) => i.ref === node.id) || (r.relays !== 'auto' && r.relays.includes(node.id));
    });
    if (users.length) throw conflict(`These stations still use this node: ${users.map((x) => x.name).sort().join(', ')}. Move them to another node first, or dedicate the node to them.`);
  }

  async function newPairing(node: Pick<Node, 'id' | 'roles'>) {
    const code = newPairingCode();
    const expiresAt = new Date(Date.now() + PAIRING_HOURS * 3600_000);
    await ctx.db.update(schema.nodes).set({ pairingCodeHash: hashCode(code), pairingExpiresAt: expiresAt, updatedAt: new Date() }).where(eq(schema.nodes.id, node.id));
    return { code, expiresAt, command: await installCommand(ctx, code, node.roles.includes('fm')) };
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
      const ids = req.body.updates.groups.map((g) => g.id);
      if (new Set(ids).size !== ids.length) throw badRequest('Two update groups have the same id');
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
      await assertFreeName(ctx, req.body.name);
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
      if (b.name !== undefined && b.name !== node.name) await assertFreeName(ctx, b.name, node.id);
      if (b.config?.updateGroup !== undefined && b.config.updateGroup !== (nodeSettings(node).updateGroup ?? null)) {
        requireSuperadmin(req);
        if (b.config.updateGroup && !(await getSetting(ctx, 'nodes')).updates.groups.some((g) => g.id === b.config!.updateGroup)) throw badRequest('Unknown update group');
      }
      const config = b.config ? storedConfig(b.config, node.config) : node.config;
      // A customer or station is only kept while the node is dedicated to it (1.1.1).
      if (config.dedication !== 'customer') config.dedicatedTenantId = null;
      if (config.dedication !== 'station') config.dedicatedStationId = null;
      const roles = b.roles ? ([...new Set(b.roles)] as NodeRole[]) : node.roles;
      await checkDedication(node, roles, config, b.config ?? {});
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
      const carriageChanged = b.roles !== undefined || b.config?.relayStations !== undefined || b.config?.dedication !== undefined || b.config?.dedicatedTenantId !== undefined || b.config?.dedicatedStationId !== undefined || b.config?.publicHost !== undefined || b.config?.listenPort !== undefined;
      await replan(node.id, req.auth?.user.email, carriageChanged);
      // Cloudflare DNS (phase 15): the node's record follows its name and address; an own host name is checked again.
      const c0 = b.config ?? {};
      if (b.name !== undefined || c0.dnsName !== undefined || c0.dnsRecord !== undefined || c0.publicAddress !== undefined || c0.publicHost !== undefined) {
        app.dns?.nudge();
        if (c0.publicHost !== undefined) void app.dns?.checkOwnNames(node.id).catch(() => undefined);
      }
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
      await app.nodeUpdates.forget(node.id);
      Object.assign(req.auditInfo, { tenantId: node.tenantId, targetId: node.id, details: { name: node.name } });
      await replan(node.id, req.auth?.user.email, node.roles.includes('relay'));
      return (await toOut([updated!]))[0]!;
    },
  );

  app.post(
    '/:id/update',
    {
      config: { audit: 'node.update_request' },
      schema: {
        tags: ['Nodes'],
        summary: 'Update the node to the version of this server, whatever its policy. It waits for any other node update to finish, and is checked and rolled back like any other.',
        params: nodeParams,
        response: { 200: okOut.extend({ position: z.number() }) },
      },
    },
    async (req) => {
      const node = await nodeAccess(ctx, req, req.params.id, 'owner');
      if (!node.pairedAt) throw conflict('The node is not paired');
      const position = await app.nodeUpdates.enqueue(node.id, null, req.auth?.user.email ?? null);
      Object.assign(req.auditInfo, { tenantId: node.tenantId, targetId: node.id, details: { name: node.name } });
      return { ok: true as const, position };
    },
  );

  app.post(
    '/:id/rollback',
    {
      config: { audit: 'node.rollback' },
      schema: { tags: ['Nodes'], summary: 'Put the node back on the version it had before its last update', params: nodeParams, response: { 200: okOut.extend({ position: z.number() }) } },
    },
    async (req) => {
      const node = await nodeAccess(ctx, req, req.params.id, 'owner');
      const last = (await getSetting(ctx, 'nodeRollout')).results[node.id];
      if (!last || last.state !== 'succeeded' || !last.from.commit) throw conflict('There is no previous version to go back to');
      const position = await app.nodeUpdates.enqueue(node.id, { commit: last.from.commit, branch: last.from.branch }, req.auth?.user.email ?? null);
      Object.assign(req.auditInfo, { tenantId: node.tenantId, targetId: node.id, details: { name: node.name, commit: last.from.commit } });
      return { ok: true as const, position };
    },
  );

  app.post(
    '/:id/update/cancel',
    { config: { audit: 'node.update_cancel' }, schema: { tags: ['Nodes'], summary: 'Stop an update that has not started yet', params: nodeParams, response: { 200: okOut } } },
    async (req) => {
      const node = await nodeAccess(ctx, req, req.params.id, 'owner');
      await app.nodeUpdates.cancel(node.id, req.auth?.user.email ?? null);
      Object.assign(req.auditInfo, { tenantId: node.tenantId, targetId: node.id, details: { name: node.name } });
      return { ok: true as const };
    },
  );

  // The rollout over all nodes (administrators).

  const rolloutOut = z.object({
    target: refOut.extend({ version: z.string() }),
    enabled: z.boolean(),
    paused: z.object({ reason: z.string(), nodeId: z.string().nullable(), nodeName: z.string().nullable(), at: z.string() }).nullable(),
    current: z
      .object({ nodeId: z.string(), nodeName: z.string(), phase: z.enum(['draining', 'updating', 'checking', 'rollingBack']), target: refOut, manual: z.boolean(), by: z.string().nullable(), startedAt: z.string(), message: z.string().nullable() })
      .nullable(),
    queue: z.array(z.object({ nodeId: z.string(), nodeName: z.string(), by: z.string().nullable() })),
    /** Paired nodes on the version of this server, and all paired nodes. */
    upToDate: z.number(),
    paired: z.number(),
  });

  async function rollout(ov?: UpdateOverview) {
    const o = ov ?? (await app.nodeUpdates.overview());
    const nodes = await ctx.db.select({ id: schema.nodes.id, name: schema.nodes.name, pairedAt: schema.nodes.pairedAt, status: schema.nodes.status }).from(schema.nodes);
    const name = (id: string | null) => (id ? (nodes.find((n) => n.id === id)?.name ?? null) : null);
    const paired = nodes.filter((n) => n.pairedAt);
    const r = o.rollout;
    return {
      target: o.target,
      enabled: o.settings.autoUpdate && o.settings.updates.enabled,
      paused: r.paused ? { ...r.paused, nodeName: name(r.paused.nodeId) } : null,
      current: r.current ? { nodeId: r.current.nodeId, nodeName: name(r.current.nodeId) ?? '?', phase: r.current.phase, target: r.current.target, manual: r.current.manual, by: r.current.by, startedAt: r.current.startedAt, message: r.current.message } : null,
      queue: r.queue.map((q) => ({ nodeId: q.nodeId, nodeName: name(q.nodeId) ?? '?', by: q.by })),
      upToDate: paired.filter((n) => (hub.liveStatus(n.id) ?? n.status).commit === o.target.commit).length,
      paired: paired.length,
    };
  }

  app.get('/updates', { schema: { tags: ['Nodes'], summary: 'Where the node updates stand: the version nodes get, the node being updated now, the line', response: { 200: rolloutOut } } }, async (req) => {
    requireSuperadmin(req);
    return rollout();
  });

  app.post(
    '/updates/pause',
    { config: { audit: 'nodes.updates_pause' }, schema: { tags: ['Nodes'], summary: 'Stop automatic node updates (a running one finishes)', response: { 200: rolloutOut } } },
    async (req) => {
      requireSuperadmin(req);
      await app.nodeUpdates.setPaused(true, req.auth?.user.email ?? null);
      return rollout();
    },
  );

  app.post(
    '/updates/resume',
    { config: { audit: 'nodes.updates_resume' }, schema: { tags: ['Nodes'], summary: 'Resume automatic node updates after a pause or a failed update', response: { 200: rolloutOut } } },
    async (req) => {
      requireSuperadmin(req);
      await app.nodeUpdates.setPaused(false, req.auth?.user.email ?? null);
      return rollout();
    },
  );

  app.delete('/:id', { config: { audit: 'node.delete' }, schema: { tags: ['Nodes'], summary: 'Remove a node', params: nodeParams, response: { 200: okOut } } }, async (req) => {
    const node = await nodeAccess(ctx, req, req.params.id, 'owner');
    const [running] = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(schema.stations).where(eq(schema.stations.nodeId, node.id));
    if (running && running.n > 0) throw conflict('Stations still run on this node; move them back to this server first');
    hub.disconnect(node.id);
    await ctx.db.delete(schema.nodes).where(eq(schema.nodes.id, node.id));
    await app.nodeUpdates.forget(node.id);
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

  async function probesOut(where: ReturnType<typeof eq>, node?: Node) {
    const all = await ctx.db
      .select({ p: schema.nodeProbes, stationName: schema.stations.name, tenantId: schema.stations.tenantId, nodeId: schema.stations.nodeId })
      .from(schema.nodeProbes)
      .innerJoin(schema.stations, eq(schema.stations.id, schema.nodeProbes.stationId))
      .where(where)
      .orderBy(asc(schema.stations.name), asc(schema.nodeProbes.target));
    // Only stations the node serves (1.1.1): older checks of a node that became dedicated are not shown.
    const rows = node ? all.filter((r) => serves(node, { id: r.p.stationId, tenantId: r.tenantId, nodeId: r.nodeId })) : all;
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
    return probesOut(eq(schema.nodeProbes.nodeId, node.id), node);
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
    const [settings, v, stations, allNodes, worker, names, orchestrator] = await Promise.all([
      getSetting(ctx, 'nodes'),
      getVersionInfo(ctx),
      ctx.db
        .select({ id: schema.stations.id, name: schema.stations.name, slug: schema.stations.slug, tenantId: schema.stations.tenantId, routing: schema.stations.routing, nodeId: schema.stations.nodeId, edition: schema.stations.edition, autodj: schema.stations.autodj })
        .from(schema.stations)
        .innerJoin(schema.tenants, eq(schema.tenants.id, schema.stations.tenantId))
        .where(and(eq(schema.stations.enabled, true), eq(schema.tenants.active, true), scope ? inArray(schema.stations.tenantId, scope.length ? scope : ['00000000-0000-0000-0000-000000000000']) : undefined)),
      ctx.db.select().from(schema.nodes).orderBy(asc(schema.nodes.name)),
      readStreamsStatus(ctx).then((s) => s.worker),
      serverNames(ctx),
      getSetting(ctx, 'orchestrator'),
    ]);
    const tenantRows = await ctx.db.select({ id: schema.tenants.id, stationNodeId: schema.tenants.stationNodeId }).from(schema.tenants).where(isNotNull(schema.tenants.stationNodeId));
    const stationIds = stations.map((s) => s.id);
    const scopeSet = scope ? new Set(scope) : null;
    const pairedRelayNodes = allNodes.filter((n) => n.pairedAt && n.roles.includes('relay')).map((n) => ({ ...n, status: hub.liveStatus(n.id) ?? { ...n.status, online: false } }));
    // A customer sees its own nodes, the relays that carry its stations and the ingest nodes they use.
    const usedIngest = new Set(stations.flatMap((s) => ingestNodes(stationRouting(s)).map((i) => i.ref)));
    const nodes = allNodes.filter((n) => {
      if (!scopeSet) return true;
      if (n.tenantId && scopeSet.has(n.tenantId)) return true;
      // A shared station node that runs one of the customer's stations belongs in its picture too.
      if (!n.tenantId && n.pairedAt && stations.some((s) => s.nodeId === n.id)) return true;
      return !n.tenantId && !!n.pairedAt && (carried(n, stations, pairedRelayNodes).size > 0 || usedIngest.has(n.id));
    });
    const [live, samples, open] = await Promise.all([
      stationIds.length
        ? ctx.db
            .select({ id: schema.liveSessions.id, stationId: schema.liveSessions.stationId, accountName: schema.liveSessions.accountName, via: schema.liveSessions.via, nodeId: schema.liveSessions.nodeId, onNode: schema.liveSessions.onNode, startedAt: schema.liveSessions.startedAt, mountPath: schema.liveSessions.mountPath })
            .from(schema.liveSessions)
            .where(and(inArray(schema.liveSessions.stationId, stationIds), isNull(schema.liveSessions.endedAt)))
        : [],
      stationIds.length
        ? ctx.db
            .select({ stationId: schema.listenerSamples.stationId, target: schema.listenerSamples.target, avg: schema.listenerSamples.avg, at: schema.listenerSamples.at })
            .from(schema.listenerSamples)
            .where(and(inArray(schema.listenerSamples.stationId, stationIds), gt(schema.listenerSamples.at, new Date(Date.now() - 3 * 60_000))))
        : [],
      // Listeners connected now, per station, relay (none = this server) and country.
      stationIds.length
        ? ctx.db
            .select({ stationId: schema.listenerSessions.stationId, nodeId: schema.listenerSessions.nodeId, country: schema.listenerSessions.country, n: sql<number>`count(*)::int` })
            .from(schema.listenerSessions)
            .where(and(inArray(schema.listenerSessions.stationId, stationIds), isNull(schema.listenerSessions.endedAt), ne(schema.listenerSessions.via, 'external')))
            .groupBy(schema.listenerSessions.stationId, schema.listenerSessions.nodeId, schema.listenerSessions.country)
        : [],
    ]);
    // Listeners on this server: the mounts of the latest minute of each station.
    const latest = new Map<string, number>();
    for (const s of samples) latest.set(s.stationId, Math.max(latest.get(s.stationId) ?? 0, s.at.getTime()));
    const mainListeners = Math.round(samples.filter((s) => s.target.startsWith('mount:') && s.at.getTime() === latest.get(s.stationId)).reduce((n, s) => n + s.avg, 0));

    const slugs = new Set(stations.map((s) => s.slug));
    // The studio an FM/MPX node stands in: the station node of its station, else the station node of its customer
    // (linked, or the only one it has), so it is drawn beside it even before a station is chosen.
    const stationNodes = nodes.filter((x) => x.pairedAt && x.roles.includes('station'));
    const tenantNode = new Map(tenantRows.map((x) => [x.id, x.stationNodeId]));
    const fmHome = (n: Node): string | null => {
      const id = stations.find((s) => s.id === nodeSettings(n).fm.stationId)?.nodeId;
      if (id && stationNodes.some((x) => x.id === id)) return id;
      if (!n.tenantId) return null;
      const linked = tenantNode.get(n.tenantId);
      if (linked && stationNodes.some((x) => x.id === linked)) return linked;
      const own = stationNodes.filter((x) => x.tenantId === n.tenantId);
      return own.length === 1 ? own[0]!.id : null;
    };
    const statusOf = (id: string) => hub.liveStatus(id) ?? { ...(allNodes.find((n) => n.id === id)?.status ?? {}), online: false };
    const nodeOutList: z.infer<typeof topologyOut>['nodes'] = nodes.map((n) => {
      const status = statusOf(n.id);
      const carriedIds = [...carried(n, stations, pairedRelayNodes)];
      const fmError = !!status.fm && (status.fm.input === 'error' || status.fm.output === 'error' || status.fm.uecp === 'error');
      const degraded = status.online && ((status.rttMs ?? 0) > settings.latencyWarnMs || (status.loss ?? 0) > 0.05 || (status.problems?.length ?? 0) > 0 || !!status.relays?.some((r) => r.state === 'error') || fmError);
      const own = !!n.tenantId && !!scopeSet?.has(n.tenantId);
      // A customer only sees its own streams on a shared node (1.1.1): not the other customers' streams, listeners or encoders.
      const full = admin || own;
      const relaysSeen = full ? status.relays : status.relays?.filter((r) => slugs.has(r.key.split('/')[0]!));
      return {
        id: n.id,
        // One name per server, the same for everyone (phase 18); host name and address only for who manages the node.
        name: n.name,
        hostname: admin || own ? (status.hostname ?? null) : null,
        ip: admin || own ? (status.ip ?? null) : null,
        location: n.location,
        roles: n.roles,
        own,
        local: false,
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
        listeners: full ? (status.listeners ?? 0) : open.filter((o) => o.nodeId === n.id).reduce((x, o) => x + o.n, 0),
        encoders: full ? (status.encoders ?? 0) : live.filter((l) => l.nodeId === n.id && l.onNode).length,
        country: status.country ?? null,
        city: status.city ?? null,
        stations: n.roles.includes('station') ? stations.filter((s) => s.nodeId === n.id).length : carriedIds.length,
        ingestStations: stations.filter((s) => ingestsOf(stationRouting(s)).some((i) => i.ref === n.id)).length,
        updateAvailable: !!status.commit && !!v.commit && status.commit !== v.commit,
        relaysUp: relaysSeen?.filter((r) => r.state === 'connected').length ?? 0,
        relaysTotal: relaysSeen?.length ?? 0,
        fmOnAir: !!status.online && !!status.fm && (status.fm.meters?.playing === true || (status.fm.output === 'off' && status.fm.uecp === 'connected')),
        home: n.roles.includes('fm') ? fmHome(n) : null,
      };
    });

    // This server's own roles (phase 13): its ingest takes encoders and runs the AutoDJ, its relay serves listeners
    // directly. Shown apart from the orchestrator, which carries no audio.
    const onAirHere = new Set(Object.keys(worker?.onAir ?? {}).filter((id) => worker!.onAir[id]!.length));
    const localStations = stations.filter((s) => !s.nodeId && localIngest(stationRouting(s)));
    const pulled = stations.filter((s) => !s.nodeId && !pushedRouting(stationRouting(s)));
    const local = (id: 'local:ingest' | 'local:relay', roles: NodeRole[], extra: Partial<z.infer<typeof topologyOut>['nodes'][number]>) => ({
      id,
      name: id === 'local:ingest' ? names.ingest : names.relay,
      hostname: admin ? names.host : null,
      ip: null,
      location: '',
      roles,
      own: false,
      local: true,
      tenantId: null,
      paired: true,
      online: !!worker?.alive,
      degraded: false,
      version: v.version,
      rttMs: null,
      loss: null,
      timeouts24h: null,
      cpu: null,
      txBps: null,
      listeners: 0,
      encoders: 0,
      country: null,
      city: null,
      stations: 0,
      ingestStations: 0,
      updateAvailable: false,
      relaysUp: 0,
      relaysTotal: 0,
      fmOnAir: false,
      home: null,
      ...extra,
    });
    if (localStations.length)
      nodeOutList.unshift(local('local:ingest', ['source'], { encoders: live.filter((l) => !l.onNode).length, ingestStations: localStations.length, stations: localStations.length }));
    if (pulled.length || mainListeners > 0) nodeOutList.push(local('local:relay', ['relay'], { listeners: mainListeners, stations: pulled.length, relaysUp: pulled.filter((s) => onAirHere.has(s.id)).length, relaysTotal: pulled.length }));
    const shown = new Set(nodeOutList.map((n) => n.id));

    const links: z.infer<typeof topologyOut>['links'] = [];
    const seen = new Map<string, z.infer<typeof topologyOut>['links'][number]>();
    type LinkOut = z.infer<typeof topologyOut>['links'][number];
    const link = (l: Omit<LinkOut, 'streams' | 'kbps' | 'standby'> & Partial<Pick<LinkOut, 'streams' | 'kbps' | 'standby'>>) => {
      const key = `${l.from}>${l.to}>${l.kind}${l.standby ? '~' : ''}`;
      const ok = (id: string) => id === 'main' || id.startsWith('studio:') || shown.has(id);
      if (!ok(l.from) || !ok(l.to)) return;
      const full: LinkOut = { streams: l.kind === 'stream' ? 1 : 0, kbps: null, standby: false, ...l };
      const had = seen.get(key);
      // The same two servers carry several stations: one line, thicker.
      if (had) {
        had.streams += full.streams;
        had.kbps = had.kbps == null && full.kbps == null ? null : (had.kbps ?? 0) + (full.kbps ?? 0);
        had.active ||= full.active;
        return;
      }
      seen.set(key, full);
      links.push(full);
    };
    /** Mounts of a station a relay has on air now, with their bitrate. */
    const carriedOn = (relayId: string, slug: string) => {
      const list = (statusOf(relayId).relays ?? []).filter((x) => x.key.startsWith(`${slug}/`));
      const up = list.filter((x) => x.state === 'connected');
      return { list, up, streams: up.length, kbps: up.some((x) => x.bitrateKbps) ? up.reduce((n, x) => n + (x.bitrateKbps ?? 0), 0) : null };
    };
    // Control: the orchestrator steers every node; this is the only line to it.
    for (const n of nodeOutList) if (n.paired) link({ from: n.id, to: 'main', kind: 'control', active: n.online, degraded: n.degraded, rttMs: n.rttMs, loss: n.loss });

    // Audio per station: from the ingest that is on air (best priority first) to each relay that has the stream. Each
    // station also gets its path (main and backup ingest, the relays and the state of each server for it), for the per
    // station view and the matrix.
    const byId = new Map(nodeOutList.map((n) => [n.id, n]));
    type StationOut = z.infer<typeof topologyOut>['stations'][number];
    type Cell = StationOut['cells'][string];
    const stationsOut: StationOut[] = [];
    const listenersOf = (stationId: string) => open.filter((o) => o.stationId === stationId).reduce((n, o) => n + o.n, 0);
    const relayCell = (relayId: string, slug: string): Cell => {
      if (!byId.get(relayId)?.online) return 'down';
      const c = carriedOn(relayId, slug);
      if (c.up.length) return c.list.some((x) => x.state === 'error') ? 'degraded' : 'onAir';
      return c.list.some((x) => x.state === 'error') ? 'down' : 'idle';
    };
    for (const s of stations) {
      if (s.nodeId) continue;
      const r = stationRouting(s);
      const onAir = (ref: string) => (ref === 'local' ? onAirHere.has(s.id) : !!statusOf(ref).online && !!statusOf(ref).ingest?.some((m) => m.stationId === s.id));
      const topoId = (ref: string) => (ref === 'local' ? 'local:ingest' : ref);
      const ingests = ingestsOf(r);
      const active = ingests.find((i) => onAir(i.ref)) ?? null;
      const from = active ? topoId(active.ref) : null;
      const relayIds = [...(!pushedRouting(r) ? ['local:relay'] : []), ...relaysOf(s, pairedRelayNodes).map((x) => x.id)].filter((id) => shown.has(id));
      const cells: Record<string, Cell> = {};
      for (const i of ingests) {
        const id = topoId(i.ref);
        if (!shown.has(id)) continue;
        cells[id] = id === from ? 'onAir' : !byId.get(id)?.online ? 'down' : 'standby';
      }
      for (const id of relayIds) cells[id] = id === 'local:relay' ? (onAirHere.has(s.id) ? 'onAir' : 'idle') : relayCell(id, s.slug);
      if (from) {
        const fromNode = byId.get(from);
        const st = { active: !!fromNode?.online, degraded: !!fromNode?.degraded, rttMs: null, loss: null };
        if (!pushedRouting(r)) link({ from, to: 'local:relay', kind: 'stream', ...st });
        for (const relay of relaysOf(s, pairedRelayNodes)) {
          const c = carriedOn(relay.id, s.slug);
          if (c.streams) link({ from, to: relay.id, kind: 'stream', ...st, active: st.active && !!byId.get(relay.id)?.online, streams: c.streams, kbps: c.kbps });
        }
      }
      // A backup ingest that is up keeps feeding the relays on standby, so they switch without dropping listeners.
      for (const i of ingests) {
        if (i.ref === 'local' || topoId(i.ref) === from || !statusOf(i.ref).online) continue;
        const pushing = new Set((statusOf(i.ref).ingest ?? []).filter((m) => m.stationId === s.id).flatMap((m) => m.pushing));
        for (const relayId of pushing) link({ from: i.ref, to: relayId, kind: 'stream', active: true, degraded: false, rttMs: null, loss: null, standby: true });
      }
      stationsOut.push({
        id: s.id,
        name: s.name,
        tenantId: admin ? s.tenantId : null,
        edition: s.edition,
        stationNode: null,
        ingest: shown.has(topoId(r.ingest)) ? topoId(r.ingest) : null,
        backup: r.backupIngest && r.backupIngest !== r.ingest && shown.has(topoId(r.backupIngest)) ? topoId(r.backupIngest) : null,
        active: from,
        relays: relayIds,
        listeners: listenersOf(s.id),
        cells,
      });
    }
    // An FM node puts its station on air from one of the station's relays, or from this server's relay role.
    for (const n of nodeOutList) {
      if (!n.paired || !n.roles.includes('fm')) continue;
      const s = stations.find((x) => x.id === nodeSettings(nodes.find((y) => y.id === n.id)!).fm.stationId);
      if (!s) continue;
      const inputUp = statusOf(n.id).fm?.input === 'connected';
      const out = stationsOut.find((x) => x.id === s.id);
      if (out) out.cells[n.id] = !n.online ? 'down' : n.fmOnAir ? 'onAir' : inputUp ? 'degraded' : 'idle';
      if (!inputUp) continue;
      const from = s.nodeId || pushedRouting(stationRouting(s)) ? relaysOf(s, pairedRelayNodes).find((r) => byId.get(r.id)?.online)?.id : 'local:relay';
      if (from) link({ from, to: n.id, kind: 'stream', active: n.online, degraded: n.degraded, rttMs: null, loss: null });
    }
    // A station node pushes the streams of its stations straight to the relays that carry them.
    const relayMap = await relaysByStation(ctx);
    for (const n of nodeOutList) {
      if (!n.paired || !n.roles.includes('station')) continue;
      const mine = stations.filter((s) => s.nodeId === n.id);
      const runtime = mine.length ? await ctx.db.select({ id: schema.stations.id, runtime: schema.stations.nodeRuntime }).from(schema.stations).where(inArray(schema.stations.id, mine.map((s) => s.id))) : [];
      for (const s of mine) {
        const rt = runtime.find((x) => x.id === s.id)?.runtime ?? null;
        const relayIds = (relayMap.get(s.id) ?? []).map((r: Node) => r.id).filter((id) => byId.has(id));
        const cells: Record<string, Cell> = { [n.id]: !n.online ? 'down' : rt?.mounts.length ? 'onAir' : 'idle' };
        for (const relayId of relayIds) {
          const state = rt?.relays[relayId]?.state;
          const c = carriedOn(relayId, s.slug);
          cells[relayId] = !byId.get(relayId)?.online ? 'down' : state === 'error' ? 'degraded' : c.streams ? 'onAir' : 'idle';
          link({ from: n.id, to: relayId, kind: 'stream', active: n.online && state === 'connected', degraded: state === 'error', rttMs: null, loss: null, streams: Math.max(1, c.streams), kbps: c.kbps });
        }
        stationsOut.push({
          id: s.id,
          name: s.name,
          tenantId: admin ? s.tenantId : null,
          edition: s.edition,
          stationNode: n.id,
          ingest: n.id,
          backup: null,
          active: n.online && rt?.mounts.length ? n.id : null,
          relays: relayIds,
          listeners: listenersOf(s.id),
          cells,
        });
      }
    }
    stationsOut.sort((a, b) => a.name.localeCompare(b.name));
    const studios = live.map((l) => {
      const station = stations.find((s) => s.id === l.stationId)!;
      const viaNode = l.nodeId && shown.has(l.nodeId) ? l.nodeId : null;
      const to = viaNode ?? (shown.has('local:ingest') ? 'local:ingest' : 'main');
      link({ from: `studio:${l.id}`, to, kind: 'stream', active: true, degraded: false, rttMs: null, loss: null });
      // An encoder through a source node that only passes it on still ends up in this server's ingest.
      if (viaNode && !l.onNode && shown.has('local:ingest')) link({ from: viaNode, to: 'local:ingest', kind: 'stream', active: true, degraded: false, rttMs: null, loss: null });
      return { id: `studio:${l.id}`, station: station.name, stationId: station.id, account: l.accountName, mount: l.mountPath, via: l.via, nodeId: viaNode, since: l.startedAt };
    });
    // Listeners now per relay, station and country (this server's own listeners under its relay role).
    const audience = open
      .map((o) => ({ nodeId: o.nodeId ?? 'local:relay', stationId: o.stationId, country: o.country, listeners: o.n }))
      .filter((a) => shown.has(a.nodeId));

    const remote = nodeOutList.filter((n) => !n.local);
    const online = remote.filter((n) => n.online);
    const relayListeners = remote.reduce((sum, n) => sum + (n.listeners ?? 0), 0);
    return {
      view: admin && !tenantFilter ? 'admin' : 'customer',
      main: { id: 'main', name: names.orchestrator, host: admin ? names.host : null, orchestratorOnly: orchestrator.only, version: v.version, commit: v.commit, branch: v.branch, listeners: mainListeners, stations: stations.length },
      nodes: nodeOutList,
      studios,
      links,
      stations: stationsOut,
      audience,
      kpis: {
        nodesOnline: online.length,
        nodesTotal: remote.filter((n) => n.paired).length,
        degraded: online.filter((n) => n.degraded).length,
        listeners: mainListeners + relayListeners,
        relayListeners,
        avgRttMs: online.length && online.some((n) => n.rttMs != null) ? online.reduce((s, n) => s + (n.rttMs ?? 0), 0) / online.filter((n) => n.rttMs != null).length : null,
        worst: online.filter((n) => n.rttMs != null).sort((a, b) => (b.rttMs ?? 0) - (a.rttMs ?? 0))[0]?.name ?? null,
        worstRttMs: online.filter((n) => n.rttMs != null).sort((a, b) => (b.rttMs ?? 0) - (a.rttMs ?? 0))[0]?.rttMs ?? null,
        txBps: online.reduce((s, n) => s + (n.txBps ?? 0), 0),
        timeouts24h: remote.reduce((s, n) => s + (n.timeouts24h ?? 0), 0),
      },
    };
  }
};

const topologyOut = z.object({
  view: z.enum(['admin', 'customer']),
  main: z.object({
    id: z.literal('main'),
    name: z.string(),
    host: z.string().nullable(),
    /** This server carries no audio at all (phase 18). */
    orchestratorOnly: z.boolean(),
    version: z.string(),
    commit: z.string().nullable(),
    branch: z.string().nullable(),
    listeners: z.number(),
    stations: z.number(),
  }),
  nodes: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      hostname: z.string().nullable(),
      ip: z.string().nullable(),
      location: z.string(),
      roles: z.array(roleSchema),
      own: z.boolean(),
      /** One of this server's own roles (local:ingest, local:relay), not a node. */
      local: z.boolean(),
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
      ingestStations: z.number(),
      updateAvailable: z.boolean(),
      relaysUp: z.number(),
      relaysTotal: z.number(),
      fmOnAir: z.boolean(),
      /** FM/MPX node: the station node of its studio, drawn beside it. */
      home: z.string().nullable(),
    }),
  ),
  studios: z.array(z.object({ id: z.string(), station: z.string(), stationId: z.string(), account: z.string(), mount: z.string(), via: z.string(), nodeId: z.string().nullable(), since: z.date() })),
  links: z.array(
    z.object({
      from: z.string(),
      to: z.string(),
      kind: z.enum(['control', 'stream']),
      active: z.boolean(),
      degraded: z.boolean(),
      rttMs: z.number().nullable(),
      loss: z.number().nullable(),
      /** Streams (mounts) on the line and their bitrate together, for its thickness. */
      streams: z.number(),
      kbps: z.number().nullable(),
      /** A backup ingest that feeds the relay on standby. */
      standby: z.boolean(),
    }),
  ),
  /** Per station: its path through the network and the state of each server for it (per station view, matrix). */
  stations: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      tenantId: z.string().nullable(),
      edition: z.enum(['distribution', 'station']),
      /** The station node that runs the station, or null. */
      stationNode: z.string().nullable(),
      ingest: z.string().nullable(),
      backup: z.string().nullable(),
      /** The ingest the relays hear now. */
      active: z.string().nullable(),
      relays: z.array(z.string()),
      listeners: z.number(),
      /** Server id → onAir, standby (backup feed), degraded, down, idle (carries it, nothing on air). */
      cells: z.record(z.string(), z.enum(['onAir', 'standby', 'degraded', 'down', 'idle'])),
    }),
  ),
  /** Listeners now per relay (local:relay = this server), station and country. */
  audience: z.array(z.object({ nodeId: z.string(), stationId: z.string(), country: z.string().nullable(), listeners: z.number() })),
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
    hub.attach(socket, clientIp(req));
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
        .select({ id: schema.stations.id, tenantId: schema.stations.tenantId, enabled: schema.stations.enabled, routing: schema.stations.routing, nodeId: schema.stations.nodeId })
        .from(schema.stations)
        .where(eq(schema.stations.slug, slug));
      const [mount] = row ? await ctx.db.select().from(schema.stationMounts).where(and(eq(schema.stationMounts.stationId, row.id), eq(schema.stationMounts.path, path), eq(schema.stationMounts.isPublic, true))) : [];
      if (!row || !row.enabled || !mount) return reply.status(404).send({ error: { code: 'not_found', message: 'Stream not found' } });
      const settings = await getSetting(ctx, 'nodes');
      let target: string | null = null;
      // Without audio here (ingest node or station node) a relay is the only place to listen.
      const elsewhere = !!row.nodeId || pushedRouting(stationRouting(row)) || (await getSetting(ctx, 'orchestrator')).only;
      if (settings.routeListeners || elsewhere) {
        await app.nodes.geo.refresh().catch(() => undefined);
        target = await pickRelay(ctx, row.id, slug, path, app.nodes.geo.lookup(req.ip));
      }
      if (!target && elsewhere) return reply.status(503).header('retry-after', '10').header('cache-control', 'no-store').send({ error: { code: 'no_relay', message: 'No relay has this stream right now' } });
      const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
      return reply
        .header('cache-control', 'no-store')
        .redirect(`${target ?? `/listen/${slug}${path}`}${qs}`, 302);
    },
  );
};
