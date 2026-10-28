import { asc, eq, isNotNull } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { schema } from '../db/index.js';
import { requireUser } from '../lib/auth.js';
import { badRequest, forbidden } from '../lib/errors.js';
import { relaysOf } from '../services/nodes/plan.js';
import { ingestsOf, routingSchema, stationRouting, type StationRouting } from '../services/nodes/routing-rules.js';
import { forgetRelays } from '../services/nodes/routing.js';
import { applyStreams } from '../services/streaming/state.js';
import { readStreamsStatus } from '../services/streaming/status.js';
import { stationAccess } from './stations.js';
import { getSetting } from '../services/settings.js';
import { serves } from '../services/nodes/dedication.js';
import { studioDelivery } from '../services/nodes/delivery.js';

const params = z.object({ id: z.uuid() });
const ref = z.union([z.literal('local'), z.uuid()]);

const choiceOut = z.object({ id: z.uuid(), name: z.string(), location: z.string(), online: z.boolean(), own: z.boolean() });
const routingOut = z.object({
  routing: z.object({ ingest: ref, backupIngest: ref.nullable(), relays: z.union([z.literal('auto'), z.array(z.uuid())]), spareRelays: z.boolean(), delivery: z.enum(['ingest', 'direct']) }),
  /**
   * A station on a station node (1.3): where the node sends its streams now. Through the ingests (it uploads once per
   * ingest), or straight to every relay: chosen so, no ingest node can carry the station, or none is online.
   */
  studio: z
    .object({
      ingests: z.array(z.object({ id: z.uuid(), name: z.string(), online: z.boolean(), priority: z.number() })),
      direct: z.enum(['chosen', 'update', 'none', 'offline', 'nocert', 'failing']).nullable(),
      error: z.string().nullable(),
    })
    .nullable(),
  /** Why the routing cannot be changed here: the station runs on a station node, or its AutoDJ runs on this server. */
  locked: z.enum(['station_node']).nullable(),
  /** This server carries no audio (phase 18): it cannot be the ingest. */
  orchestratorOnly: z.boolean(),
  /** The Radio station edition: the AutoDJ runs on this server, so this server stays its main ingest. */
  autodjHere: z.boolean(),
  canEdit: z.boolean(),
  options: z.object({ ingests: z.array(choiceOut), relays: z.array(choiceOut) }),
  /** Chosen relays that can no longer carry the station (gone, lost the relay role, or dedicated elsewhere); dropped on the next save. */
  stale: z.array(z.object({ id: z.uuid(), name: z.string() })),
  status: z.object({
    /** The ingest the relays hear now: "local", a node id, or null when nothing is on air. */
    active: ref.nullable(),
    ingests: z.array(z.object({ ref, priority: z.number(), name: z.string(), online: z.boolean(), onAir: z.boolean() })),
    relays: z.array(z.object({ id: z.uuid(), name: z.string(), online: z.boolean(), connected: z.number(), total: z.number(), spare: z.boolean() })),
  }),
});

/**
 * Routing per station (phase 13): which ingest takes the encoders, which one stands by, and which relays the ingest
 * feeds directly. The orchestrator hands this out to the nodes; it carries no audio itself. Mounted under
 * /api/stations.
 */
export const stationRoutingRoutes: FastifyPluginAsyncZod = async (app) => {
  const { ctx } = app;
  const hub = app.nodes;

  async function view(stationId: string, canEdit: boolean, tenantId: string, superadmin: boolean): Promise<z.infer<typeof routingOut>> {
    const [station] = await ctx.db.select().from(schema.stations).where(eq(schema.stations.id, stationId));
    if (!station) throw badRequest('Unknown station');
    const rows = await ctx.db.select().from(schema.nodes).where(isNotNull(schema.nodes.pairedAt)).orderBy(asc(schema.nodes.name));
    const nodes = rows.map((n) => ({ ...n, status: hub.liveStatus(n.id) ?? { ...n.status, online: false } }));
    const r = stationRouting(station);
    // Customers choose among their own nodes; platform nodes are the administrator's to hand out.
    // A dedicated node (1.1.1) is only offered to the customer or station it is dedicated to.
    const allowed = (n: (typeof nodes)[number]) => serves(n, station) && (n.tenantId ? n.tenantId === tenantId : superadmin);
    const choice = (n: (typeof nodes)[number]) => ({ id: n.id, name: n.name, location: n.location, online: n.status.online, own: n.tenantId === tenantId });
    const relays = nodes.filter((n) => n.roles.includes('relay') && serves(n, station));
    const worker = await readStreamsStatus(ctx).then((s) => s.worker);
    const only = (await getSetting(ctx, 'orchestrator')).only;
    const onAir = (x: string) => (x === 'local' ? !!worker?.onAir[station.id]?.length : !!nodes.find((n) => n.id === x)?.status.ingest?.some((m) => m.stationId === station.id));
    const name = (x: string) => (x === 'local' ? 'local' : (nodes.find((n) => n.id === x)?.name ?? '?'));
    const ingests = ingestsOf(r).map((i) => ({ ref: i.ref, priority: i.priority, name: name(i.ref), online: i.ref === 'local' ? !!worker?.alive : !!nodes.find((n) => n.id === i.ref)?.status.online, onAir: onAir(i.ref) }));
    const active = ingests.find((i) => i.onAir)?.ref ?? null;
    const carrying = relaysOf(station, relays);
    const chosen = r.relays === 'auto' ? null : new Set(r.relays);
    // The stored status, as the station node's package is built from it: the view shows the route the node gets.
    const studio = station.nodeId ? studioDelivery(station, rows) : null;
    return {
      routing: r,
      studio: studio && { ingests: studio.ingests.map((i) => ({ id: i.node.id, name: i.node.name, online: !!i.node.status.online, priority: i.priority })), direct: studio.direct, error: studio.error ?? null },
      locked: station.nodeId ? 'station_node' : null,
      orchestratorOnly: only,
      autodjHere: station.edition === 'station',
      // On a station node the ingest is the node itself, but its relays are still chosen here (phase 19).
      canEdit,
      options: {
        ingests: nodes.filter((n) => n.roles.includes('source') && (allowed(n) || ingestsOf(r).some((i) => i.ref === n.id))).map(choice),
        relays: relays.filter((n) => allowed(n) || chosen?.has(n.id)).map(choice),
      },
      stale: [...(chosen ?? [])].filter((id) => !relays.some((n) => n.id === id && serves(n, station))).map((id) => ({ id, name: nodes.find((n) => n.id === id)?.name ?? '?' })),
      status: {
        active,
        ingests,
        relays: carrying.map((n) => {
          const states = (n.status.relays ?? []).filter((x) => x.key.startsWith(`${station.slug}/`));
          return { id: n.id, name: (n as (typeof nodes)[number]).name, online: n.status.online, connected: states.filter((x) => x.state === 'connected').length, total: states.length, spare: !!chosen && !chosen.has(n.id) };
        }),
      },
    };
  }

  app.get(
    '/:id/routing',
    { schema: { tags: ['Stations'], summary: 'How the station travels: ingest, backup ingest and the relays it feeds directly', params, response: { 200: routingOut } } },
    async (req) => {
      const { tenant, access } = await stationAccess(ctx, req, req.params.id, 'manager');
      const auth = requireUser(req);
      const superadmin = auth.user.isSuperadmin && !auth.keyTenantId;
      return view(req.params.id, superadmin || access.role === 'owner', tenant.id, superadmin);
    },
  );

  app.put(
    '/:id/routing',
    {
      config: { audit: 'station.routing' },
      schema: { tags: ['Stations'], summary: 'Choose the ingest, backup ingest and relays of a station (owners and administrators)', params, body: routingSchema, response: { 200: routingOut } },
    },
    async (req) => {
      const { station, tenant, access } = await stationAccess(ctx, req, req.params.id, 'owner');
      const auth = requireUser(req);
      const superadmin = auth.user.isSuperadmin && !auth.keyTenantId;
      const current = stationRouting(station);
      // A station node takes its own encoders: its streams go through the chosen ingests ("local" = pick one) or
      // straight to the relays (1.3).
      const body: StationRouting = { ...req.body };
      if (!station.nodeId) body.delivery = current.delivery;
      if (body.backupIngest === body.ingest) body.backupIngest = null;
      // Orchestrator only (phase 18): this server takes no encoders, also not as a backup.
      if (!station.nodeId && (body.ingest === 'local' || body.backupIngest === 'local') && (await getSetting(ctx, 'orchestrator')).only) throw badRequest('This server is set to orchestrator only and takes no encoders; choose an ingest node');
      // The AutoDJ of a Radio station plays on this server, so encoders and AutoDJ meet here.
      if (!station.nodeId && station.edition === 'station' && body.ingest !== 'local') throw badRequest('The AutoDJ of a Radio station runs on this server, so this server stays its main ingest. Choose an ingest node as backup, or move the station to a station node.');
      const nodes = await ctx.db.select().from(schema.nodes).where(isNotNull(schema.nodes.pairedAt));
      const kept = (id: string) => ingestsOf(current).some((i) => i.ref === id) || (current.relays !== 'auto' && current.relays.includes(id));
      const check = (id: string, role: 'source' | 'relay') => {
        const n = nodes.find((x) => x.id === id);
        if (!n) throw badRequest('Unknown or unpaired node');
        if (!n.roles.includes(role)) throw badRequest(`${n.name} does not have the ${role === 'source' ? 'ingest' : 'relay'} role`);
        if (n.tenantId && n.tenantId !== tenant.id) throw forbidden('This node belongs to another customer');
        if (!serves(n, station)) throw forbidden(`${n.name} is dedicated to another customer or station`);
        if (!n.tenantId && !superadmin && !kept(n.id)) throw forbidden('Only an administrator can assign the platform nodes');
      };
      for (const i of [body.ingest, body.backupIngest]) if (i && i !== 'local') check(i, 'source');
      if (station.nodeId && body.backupIngest === 'local') body.backupIngest = null;
      if (body.relays !== 'auto') {
        body.relays = [...new Set(body.relays)];
        for (const id of body.relays) check(id, 'relay');
      }
      await ctx.db.update(schema.stations).set({ routing: body, updatedAt: new Date() }).where(eq(schema.stations.id, station.id));
      req.auditInfo.details = { routing: body };
      forgetRelays();
      await applyStreams(ctx, { stationIds: [station.id], by: req.auth?.user.email }).catch((err) => req.log.error({ err }, 'applying stream configuration failed'));
      void hub.refreshAll();
      return view(station.id, superadmin || access.role === 'owner', tenant.id, superadmin);
    },
  );
};

