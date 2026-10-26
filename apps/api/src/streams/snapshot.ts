import { eq, isNotNull } from 'drizzle-orm';
import { schema } from '../db/index.js';
import type { AppContext } from '../lib/context.js';
import { getSetting, type StreamingSettings } from '../services/settings.js';
import { pairedRelays, pushTarget, pushToken, relaysOf } from '../services/nodes/plan.js';
import { ingestNodes, localIngest, localPriority, pushedRouting, stationRouting } from '../services/nodes/routing-rules.js';
import { autodjMount, type Mount, type Output, type Station } from '../services/streaming/state.js';

export interface StationView {
  station: Station;
  tenantId: string;
  /** Station and customer are both active. */
  active: boolean;
  /** The station runs on a station node: no encoders, jobs or Icecast here, only statistics from what the node reports. */
  onNode: boolean;
  maxBitrateKbps: number;
  storageQuotaMb: number;
  adminPassword: string;
  sourcePassword: string;
  mounts: Mount[];
  outputs: Output[];
  /** The mount the AutoDJ feeds, when it plays. Encoders cannot use it. */
  autodjMount: Mount | null;
  /**
   * Where encoders deliver (phase 13). `local` = this server's own ingest takes them (as main or backup ingest);
   * `nodes` = ingest nodes with their priority. `pushes` = the relays this server feeds when it is one of several
   * ingests (one synthetic output per relay and public mount).
   */
  ingest: { local: boolean; priority: number; nodes: { id: string; priority: number }[]; pushes: Output[] };
}

/** What the streams service works from: every station with its mounts and outputs, and the customer domains. */
export interface Snapshot {
  loadedAt: number;
  streaming: StreamingSettings;
  platformHosts: Set<string>;
  stations: Map<string, StationView>;
  bySlug: Map<string, StationView>;
  /** Ingest or panel host of a verified customer domain → customer id. */
  hostTenant: Map<string, string>;
  /** Paired source nodes that may pass encoders on to this server, with their secret. */
  sourceNodes: Map<string, { id: string; tenantId: string | null; secret: string }>;
}

export async function loadSnapshot(ctx: AppContext): Promise<Snapshot> {
  const [streaming, proxy, rows, mounts, outputs, domains, nodes, relays] = await Promise.all([
    getSetting(ctx, 'streaming'),
    getSetting(ctx, 'proxy'),
    ctx.db
      .select({ s: schema.stations, active: schema.tenants.active, limits: schema.tenants.limits })
      .from(schema.stations)
      .innerJoin(schema.tenants, eq(schema.tenants.id, schema.stations.tenantId)),
    ctx.db.select().from(schema.stationMounts),
    ctx.db.select().from(schema.stationOutputs),
    ctx.db.select().from(schema.tenantDomains).where(eq(schema.tenantDomains.status, 'verified')),
    ctx.db.select({ id: schema.nodes.id, tenantId: schema.nodes.tenantId, roles: schema.nodes.roles, config: schema.nodes.config, secret: schema.nodes.secret }).from(schema.nodes).where(isNotNull(schema.nodes.secret)),
    pairedRelays(ctx),
  ]);
  const sourceNodes: Snapshot['sourceNodes'] = new Map();
  for (const n of nodes) {
    if (!n.roles.includes('source') || !n.secret) continue;
    try {
      sourceNodes.set(n.id, { id: n.id, tenantId: n.tenantId, secret: ctx.box.decrypt(n.secret) });
    } catch {
      /* a secret of another installation (restored backup); the node must pair again */
    }
  }
  const stations = new Map<string, StationView>();
  for (const r of rows) {
    stations.set(r.s.id, {
      station: r.s,
      tenantId: r.s.tenantId,
      active: r.s.enabled && r.active,
      onNode: !!r.s.nodeId,
      maxBitrateKbps: r.limits.maxBitrateKbps,
      storageQuotaMb: r.limits.storageQuotaMb,
      adminPassword: ctx.box.decrypt(r.s.icecastAdminPassword),
      sourcePassword: ctx.box.decrypt(r.s.icecastSourcePassword),
      mounts: [],
      outputs: [],
      autodjMount: null,
      ingest: { local: true, priority: 0, nodes: [], pushes: [] },
    });
  }
  for (const m of mounts) stations.get(m.stationId)?.mounts.push(m);
  for (const o of outputs) stations.get(o.stationId)?.outputs.push(o);
  for (const v of stations.values()) {
    v.autodjMount = v.onNode ? null : autodjMount(v.station, v.mounts);
    const r = stationRouting(v.station);
    v.ingest = { local: !v.onNode && localIngest(r), priority: localPriority(r) ?? 0, nodes: ingestNodes(r).map((i) => ({ id: i.ref, priority: i.priority })), pushes: [] };
    // Next to an ingest node this server pushes to the relays itself; alone it lets them pull.
    if (v.ingest.local && pushedRouting(r)) {
      for (const relay of relaysOf(v.station, relays)) {
        const t = pushTarget(relay as (typeof relays)[number], null);
        if (!t) continue;
        for (const m of v.mounts.filter((x) => x.isPublic)) {
          const key = `${v.station.slug}${m.path}`;
          v.ingest.pushes.push({
            id: `${relay.id}:${m.id}`,
            stationId: v.station.id,
            type: 'icecast',
            name: `Relay ${t.name}`,
            enabled: true,
            mountId: m.id,
            config: { host: t.host, port: t.port, tls: true, insecureTls: t.insecureTls, mount: `/listen/${key}`, username: 'source', token: pushToken(ctx, relay as (typeof relays)[number], key), priority: v.ingest.priority, push: true, relayNodeId: relay.id },
            status: null,
            createdAt: v.station.createdAt,
          } as Output);
        }
      }
    }
  }
  const hostTenant = new Map<string, string>();
  for (const d of domains) {
    hostTenant.set(d.ingestHost, d.tenantId);
    hostTenant.set(d.panelHost, d.tenantId);
  }
  return {
    loadedAt: Date.now(),
    streaming,
    platformHosts: new Set([proxy.domain, streaming.cnameTarget].filter(Boolean)),
    stations,
    bySlug: new Map([...stations.values()].map((v) => [v.station.slug, v])),
    hostTenant,
    sourceNodes,
  };
}

/**
 * Finds the station and source mount an encoder means. "/<station>/<mount>" works everywhere; on a customer's own
 * domain "/<mount>" is enough when only one of its stations has that mount.
 */
export function resolveMount(snap: Snapshot, host: string | null, path: string): { view: StationView; mount: Mount } | null {
  const clean = path.split('?')[0]!.replace(/\/+$/, '');
  const parts = clean.split('/').filter(Boolean);
  const tenantId = host ? snap.hostTenant.get(host.toLowerCase().replace(/:\d+$/, '')) : undefined;
  const ok = (view: StationView | undefined, mountPath: string) => {
    if (!view || !view.active || view.onNode || !view.ingest.local || (tenantId && view.tenantId !== tenantId)) return null;
    const mount = view.mounts.find((m) => m.path === mountPath && m.kind === 'source' && m.id !== view.autodjMount?.id);
    return mount ? { view, mount } : null;
  };
  if (parts.length >= 2) {
    const hit = ok(snap.bySlug.get(parts[0]!), `/${parts.slice(1).join('/')}`);
    if (hit) return hit;
  }
  if (tenantId && parts.length >= 1) {
    const matches = [...snap.stations.values()]
      .filter((v) => v.tenantId === tenantId)
      .map((v) => ok(v, `/${parts.join('/')}`))
      .filter((x): x is NonNullable<typeof x> => !!x);
    if (matches.length === 1) return matches[0]!;
  }
  return null;
}

/**
 * Whether listeners of a mount hear something: its own source is on air, or a mount down its fallback chain is (the
 * AutoDJ behind a live mount). Transcoders and relays of the mount run in both cases.
 */
export function heard(view: StationView, mount: Mount, live: Map<string, unknown>) {
  const byId = new Map(view.mounts.map((m) => [m.id, m]));
  let cur: Mount | undefined = mount;
  for (let i = 0; cur && i < 20; i++) {
    if (live.has(cur.path)) return true;
    cur = cur.fallbackMountId ? byId.get(cur.fallbackMountId) : undefined;
  }
  return false;
}
