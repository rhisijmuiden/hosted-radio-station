import { asc, eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { schema } from '../db/index.js';
import { requireSuperadmin, requireTenantRole, requireUser } from '../lib/auth.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { endpointLines, fill, portLines, renderTemplate, emailWords, emailLocale } from '../services/email-templates.js';
import { mailConfigured, sendMail } from '../services/mail.js';
import { nameKey, namesFrom, serverNames } from '../services/nodes/names.js';
import { stationsUsingThisServer } from '../services/nodes/orchestrator.js';
import { checkTarget, externalAddress, inboundPorts, internalAddress, probePort, type InboundPort } from '../services/nodes/ports.js';
import { buildPlan, nodeSettings } from '../services/nodes/plan.js';
import { isPublicAddress, nodeAddresses } from '../services/dns/records.js';
import { forgetRelays } from '../services/nodes/routing.js';
import { getSetting, putSetting, serverNameSchema } from '../services/settings.js';
import { connectionInfo } from '../services/streaming/info.js';
import { applyAllStreams, loadStation, platformHost } from '../services/streaming/state.js';
import { endpointOut, stationAccess } from './stations.js';

const nameOrDefault = serverNameSchema.or(z.literal(''));
const namesOut = z.object({
  /** This server and its own roles: the name set ('' = default), the default and what is shown. */
  orchestrator: z.object({ name: z.string(), default: z.string(), shown: z.string(), host: z.string() }),
  ingest: z.object({ name: z.string(), default: z.string(), shown: z.string() }),
  relay: z.object({ name: z.string(), default: z.string(), shown: z.string() }),
  nodes: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      roles: z.array(z.string()),
      location: z.string(),
      hostname: z.string().nullable(),
      ip: z.string().nullable(),
      tenantName: z.string().nullable(),
      online: z.boolean(),
    }),
  ),
});

const usesOut = z.array(z.object({ id: z.uuid(), name: z.string(), slug: z.string(), tenantId: z.uuid(), tenantName: z.string(), uses: z.array(z.enum(['ingest', 'backupIngest', 'listeners', 'autodj', 'moving'])) }));
const orchestratorOut = z.object({
  only: z.boolean(),
  /** Stations that still use this server for audio; they block switching on. */
  stations: usesOut,
  /** Paired ingest and station nodes, the places stations can go instead. */
  ingestNodes: z.number(),
  stationNodes: z.number(),
  relayNodes: z.number(),
});

const portOut = z.object({
  service: z.enum(['encoderTls', 'encoderPlain', 'legacy', 'sftp', 'ftp', 'ftpPassive', 'listeners', 'listenersTls', 'push']),
  port: z.number(),
  to: z.number().optional(),
  for: z.array(z.enum(['studio', 'encoders', 'uploads', 'listeners', 'ingests'])),
  station: z.string().optional(),
});
const firewallOut = z.object({
  /** A node of a customer, in the customer's own network. */
  selfHosted: z.boolean(),
  external: z.string().nullable(),
  internal: z.string().nullable(),
  /** The node has a public address on its own interface (a server in a data centre): nothing to forward. */
  publicInterface: z.boolean(),
  /** How the node's name resolved at the last check: ok, only in public DNS (this server still remembers it missing), or not at all. */
  dns: z.object({ host: z.string(), state: z.enum(['ok', 'stale', 'missing']), checkedOn: z.string() }).nullable(),
  ports: z.array(portOut),
  /** The last check from outside, per port ("port" or "port-to"). */
  checks: z.record(z.string(), z.object({ ok: z.boolean(), message: z.string().nullable(), ms: z.number().nullable(), at: z.string() })),
});

/** The last outside check per node, kept in memory (it is quick to run again). */
const lastChecks = new Map<string, z.infer<typeof firewallOut>['checks']>();
const lastDns = new Map<string, z.infer<typeof firewallOut>['dns']>();
const portKey = (p: Pick<InboundPort, 'port' | 'to'>) => (p.to ? `${p.port}-${p.to}` : String(p.port));

/**
 * Phase 18: server names, the "orchestrator only" switch, the firewall checklist of a node and the connection details
 * of a station. Mounted under /api/nodes (names, orchestrator, firewall) and /api/stations (connection).
 */
export const orchestratorRoutes: FastifyPluginAsyncZod = async (app) => {
  const { ctx } = app;
  const hub = app.nodes;

  async function namesView(): Promise<z.infer<typeof namesOut>> {
    const [o, host, rows] = await Promise.all([
      getSetting(ctx, 'orchestrator'),
      platformHost(ctx),
      ctx.db.select({ n: schema.nodes, tenantName: schema.tenants.name }).from(schema.nodes).leftJoin(schema.tenants, eq(schema.tenants.id, schema.nodes.tenantId)).orderBy(asc(schema.nodes.name)),
    ]);
    const names = namesFrom(o, host);
    return {
      orchestrator: { name: o.name, default: names.defaults.orchestrator, shown: names.orchestrator, host },
      ingest: { name: o.ingestName, default: names.defaults.ingest, shown: names.ingest },
      relay: { name: o.relayName, default: names.defaults.relay, shown: names.relay },
      nodes: rows.map(({ n, tenantName }) => {
        const status = hub.liveStatus(n.id) ?? { ...n.status, online: false };
        return { id: n.id, name: n.name, roles: n.roles, location: n.location, hostname: status.hostname ?? null, ip: status.ip ?? null, tenantName, online: status.online };
      }),
    };
  }

  app.get('/names', { schema: { tags: ['Nodes'], summary: 'Names of this server, its own roles and every node (phase 18)', response: { 200: namesOut } } }, async (req) => {
    requireSuperadmin(req);
    return namesView();
  });

  app.put(
    '/names',
    {
      config: { audit: 'nodes.names' },
      schema: {
        tags: ['Nodes'],
        summary: 'Rename this server, its own roles and nodes in one go. Every name is unique; an empty name for this server or its roles means the default.',
        body: z.object({
          orchestrator: nameOrDefault,
          ingest: nameOrDefault,
          relay: nameOrDefault,
          nodes: z.array(z.object({ id: z.uuid(), name: serverNameSchema })).max(1000).default([]),
        }),
        response: { 200: namesOut },
      },
    },
    async (req) => {
      requireSuperadmin(req);
      const b = req.body;
      const current = await getSetting(ctx, 'orchestrator');
      const names = namesFrom({ ...current, name: b.orchestrator, ingestName: b.ingest, relayName: b.relay }, await platformHost(ctx));
      const rows = await ctx.db.select({ id: schema.nodes.id, name: schema.nodes.name }).from(schema.nodes);
      const final = new Map(rows.map((r) => [r.id, r.name]));
      for (const n of b.nodes) {
        if (!final.has(n.id)) throw badRequest('Unknown node');
        final.set(n.id, n.name);
      }
      const all = [names.orchestrator, names.ingest, names.relay, ...final.values()];
      const keys = all.map(nameKey);
      const dup = all.find((_, i) => keys.indexOf(keys[i]!) !== i);
      if (dup) throw conflict(`The name "${dup}" is used twice; every server needs its own name`);
      const changed = b.nodes.filter((n) => rows.find((r) => r.id === n.id)!.name !== n.name);
      await ctx.db.transaction(async (tx) => {
        for (const n of changed) await tx.update(schema.nodes).set({ name: n.name, updatedAt: new Date() }).where(eq(schema.nodes.id, n.id));
      });
      await putSetting(ctx, 'orchestrator', { ...current, name: b.orchestrator, ingestName: b.ingest, relayName: b.relay });
      Object.assign(req.auditInfo, { details: { orchestrator: names.orchestrator, ingest: names.ingest, relay: names.relay, nodes: changed.map((n) => n.name) } });
      if (changed.length) {
        void hub.refreshAll();
        app.dns?.nudge();
      }
      return namesView();
    },
  );

  async function orchestratorView(): Promise<z.infer<typeof orchestratorOut>> {
    const [o, stations, nodes] = await Promise.all([getSetting(ctx, 'orchestrator'), stationsUsingThisServer(ctx), ctx.db.select({ roles: schema.nodes.roles, pairedAt: schema.nodes.pairedAt }).from(schema.nodes)]);
    const paired = nodes.filter((n) => n.pairedAt);
    return {
      only: o.only,
      stations,
      ingestNodes: paired.filter((n) => n.roles.includes('source')).length,
      stationNodes: paired.filter((n) => n.roles.includes('station')).length,
      relayNodes: paired.filter((n) => n.roles.includes('relay')).length,
    };
  }

  app.get('/orchestrator', { schema: { tags: ['Nodes'], summary: 'Whether this server is orchestrator only, and which stations still use it for audio', response: { 200: orchestratorOut } } }, async (req) => {
    requireSuperadmin(req);
    return orchestratorView();
  });

  app.put(
    '/orchestrator',
    {
      config: { audit: 'nodes.orchestratorOnly' },
      schema: {
        tags: ['Nodes'],
        summary: 'Switch "orchestrator only" on or off. On: this server carries no audio (no encoder ports, Icecast or uploads). Refused while stations still use it.',
        body: z.object({ only: z.boolean() }),
        response: { 200: orchestratorOut },
      },
    },
    async (req) => {
      requireSuperadmin(req);
      const current = await getSetting(ctx, 'orchestrator');
      if (req.body.only && !current.only) {
        const using = await stationsUsingThisServer(ctx);
        if (using.length) throw conflict(`These stations still use this server for audio: ${using.map((s) => s.name).join(', ')}. Move them to an ingest node or a station node first.`);
      }
      await putSetting(ctx, 'orchestrator', { ...current, only: req.body.only });
      req.auditInfo.details = { only: req.body.only };
      if (req.body.only !== current.only) {
        forgetRelays();
        // Icecast servers, the AutoDJ, the encoder ports, uploads and listen routes follow the switch.
        await applyAllStreams(ctx, req.auth?.user.email).catch((err) => req.log.error({ err }, 'applying stream configuration failed'));
        void hub.refreshAll();
      }
      return orchestratorView();
    },
  );

  // Firewall checklist of a node (customers: their own nodes).

  async function nodeFor(req: Parameters<typeof requireUser>[0], id: string) {
    const [node] = await ctx.db.select().from(schema.nodes).where(eq(schema.nodes.id, id));
    if (!node) throw notFound('Node');
    if (node.tenantId) await requireTenantRole(ctx, req, node.tenantId, 'manager');
    else requireSuperadmin(req);
    return { ...node, status: hub.liveStatus(node.id) ?? { ...node.status, online: false } };
  }

  async function firewallView(node: Awaited<ReturnType<typeof nodeFor>>): Promise<z.infer<typeof firewallOut>> {
    const internal = internalAddress(node);
    const publicInterface = !!internal && isPublicAddress(internal);
    return {
      selfHosted: !!node.tenantId,
      external: externalAddress(node),
      internal: publicInterface ? null : internal,
      publicInterface,
      dns: lastDns.get(node.id) ?? null,
      ports: await inboundPorts(ctx, node),
      checks: lastChecks.get(node.id) ?? {},
    };
  }

  const nodeParams = z.object({ id: z.uuid() });
  app.get('/:id/firewall', { schema: { tags: ['Nodes'], summary: 'Ports to open or forward to this node, with the last check from outside', params: nodeParams, response: { 200: firewallOut } } }, async (req) => {
    return firewallView(await nodeFor(req, req.params.id));
  });

  app.post(
    '/:id/firewall/check',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: { tags: ['Nodes'], summary: 'Check from outside (this server) whether each port of the node can be reached', params: nodeParams, response: { 200: firewallOut } },
    },
    async (req) => {
      const node = await nodeFor(req, req.params.id);
      const host = externalAddress(node);
      if (!host) throw badRequest('The node has no known address yet; pair it or set its host name');
      const ports = await inboundPorts(ctx, node);
      const at = new Date().toISOString();
      const target = await checkTarget(host, nodeAddresses({ publicAddress: nodeSettings(node).publicAddress, ip: node.status.ip ?? null, addresses: node.status.addresses ?? [] }));
      lastDns.set(node.id, target.dns ? { host, state: target.dns, checkedOn: target.address } : null);
      // A relay only listens on its push port while an ingest or station node pushes a stream to it.
      const pushing = ports.some((p) => p.service === 'push') && !!(await buildPlan(ctx, node)).relay?.mounts.some((m) => m.push);
      const results = await Promise.all(
        ports.map(async (p) => {
          const res = await probePort(target.address, p.port);
          return [portKey(p), { ...res, message: p.service === 'push' && !res.ok && res.message === 'refused' && !pushing ? 'idle' : res.message, at }] as const;
        }),
      );
      lastChecks.set(node.id, Object.fromEntries(results));
      return firewallView(node);
    },
  );

  app.post(
    '/:id/firewall/email',
    {
      config: { audit: 'node.firewallEmail', rateLimit: { max: 5, timeWindow: '1 minute' } },
      schema: { tags: ['Nodes'], summary: 'E-mail the firewall checklist of the node to yourself', params: nodeParams, response: { 200: z.object({ to: z.string() }) } },
    },
    async (req) => {
      const node = await nodeFor(req, req.params.id);
      if (!(await mailConfigured(ctx))) throw badRequest('Outgoing mail is not configured');
      const user = requireUser(req).user;
      const fw = await firewallView(node);
      const w = emailWords[emailLocale(user.locale)]!;
      const msg = renderTemplate('firewall', user.locale, { name: user.name, node: node.name, external: fw.external ?? w.unknown!, internal: fw.internal ?? w.unknown! }, `${ctx.config.PUBLIC_URL.replace(/\/$/, '')}/nodes/${node.id}?tab=firewall`);
      await sendMail(ctx, { to: user.email, ...msg, paragraphs: [...msg.paragraphs, ...portLines(fw.ports, user.locale)] });
      Object.assign(req.auditInfo, { tenantId: node.tenantId, targetId: node.id });
      return { to: user.email };
    },
  );
};

/** Connection details of a station from the orchestrator (phase 18). Mounted under /api/stations. */
export const stationConnectionRoutes: FastifyPluginAsyncZod = async (app) => {
  const { ctx } = app;
  const connOut = z.object({ endpoints: z.array(endpointOut), panelUrl: z.string(), orchestrator: z.string(), orchestratorOnly: z.boolean() });

  async function view(stationId: string) {
    const loaded = (await loadStation(ctx, stationId))!;
    const local = loaded.outputs.some((o) => o.type === 'local' && o.enabled);
    const [conn, names, o] = await Promise.all([connectionInfo(ctx, loaded.station, loaded.mounts, local), serverNames(ctx), getSetting(ctx, 'orchestrator')]);
    return { loaded, conn, out: { endpoints: conn.endpoints, panelUrl: conn.panelUrl, orchestrator: names.orchestrator, orchestratorOnly: o.only } };
  }

  app.get(
    '/:id/connection',
    {
      schema: {
        tags: ['Stations'],
        summary: 'Where the studio, encoders and uploads of the station connect: station node or ingest node(s), external and internal addresses and ports',
        params: z.object({ id: z.uuid() }),
        response: { 200: connOut },
      },
    },
    async (req) => {
      await stationAccess(ctx, req, req.params.id, 'dj');
      return (await view(req.params.id)).out;
    },
  );

  app.post(
    '/:id/connection/email',
    {
      config: { audit: 'station.connectionEmail', rateLimit: { max: 5, timeWindow: '1 minute' } },
      schema: { tags: ['Stations'], summary: 'E-mail the connection details of the station to yourself', params: z.object({ id: z.uuid() }), response: { 200: z.object({ to: z.string() }) } },
    },
    async (req) => {
      const { station } = await stationAccess(ctx, req, req.params.id, 'dj');
      if (!(await mailConfigured(ctx))) throw badRequest('Outgoing mail is not configured');
      const user = requireUser(req).user;
      const { conn } = await view(station.id);
      const msg = renderTemplate('connectionDetails', user.locale, { name: user.name, station: station.name, intro: '' }, `${conn.panelUrl}/stations/${station.id}?tab=connection`);
      await sendMail(ctx, { to: user.email, ...msg, paragraphs: [...msg.paragraphs, ...endpointLines(conn.endpoints, conn.panelUrl, user.locale)] });
      req.auditInfo.targetId = station.id;
      return { to: user.email };
    },
  );
};

/** The connection lines of a new customer's first station, for the welcome e-mail. */
export async function welcomeConnectionLines(ctx: Parameters<typeof loadStation>[0], stationId: string, locale: string) {
  const loaded = await loadStation(ctx, stationId);
  if (!loaded) return [];
  const conn = await connectionInfo(ctx, loaded.station, loaded.mounts, loaded.outputs.some((o) => o.type === 'local' && o.enabled));
  return [fill(emailWords[emailLocale(locale)]!.connectionIntro!, {}), ...endpointLines(conn.endpoints, conn.panelUrl, locale)];
}
