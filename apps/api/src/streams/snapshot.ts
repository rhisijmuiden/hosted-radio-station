import { eq } from 'drizzle-orm';
import { schema } from '../db/index.js';
import type { AppContext } from '../lib/context.js';
import { getSetting, type StreamingSettings } from '../services/settings.js';
import { autodjMount, type Mount, type Output, type Station } from '../services/streaming/state.js';

export interface StationView {
  station: Station;
  tenantId: string;
  /** Station and customer are both active. */
  active: boolean;
  maxBitrateKbps: number;
  storageQuotaMb: number;
  adminPassword: string;
  sourcePassword: string;
  mounts: Mount[];
  outputs: Output[];
  /** The mount the AutoDJ feeds, when it plays. Encoders cannot use it. */
  autodjMount: Mount | null;
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
}

export async function loadSnapshot(ctx: AppContext): Promise<Snapshot> {
  const [streaming, proxy, rows, mounts, outputs, domains] = await Promise.all([
    getSetting(ctx, 'streaming'),
    getSetting(ctx, 'proxy'),
    ctx.db
      .select({ s: schema.stations, active: schema.tenants.active, limits: schema.tenants.limits })
      .from(schema.stations)
      .innerJoin(schema.tenants, eq(schema.tenants.id, schema.stations.tenantId)),
    ctx.db.select().from(schema.stationMounts),
    ctx.db.select().from(schema.stationOutputs),
    ctx.db.select().from(schema.tenantDomains).where(eq(schema.tenantDomains.status, 'verified')),
  ]);
  const stations = new Map<string, StationView>();
  for (const r of rows) {
    stations.set(r.s.id, {
      station: r.s,
      tenantId: r.s.tenantId,
      active: r.s.enabled && r.active,
      maxBitrateKbps: r.limits.maxBitrateKbps,
      storageQuotaMb: r.limits.storageQuotaMb,
      adminPassword: ctx.box.decrypt(r.s.icecastAdminPassword),
      sourcePassword: ctx.box.decrypt(r.s.icecastSourcePassword),
      mounts: [],
      outputs: [],
      autodjMount: null,
    });
  }
  for (const m of mounts) stations.get(m.stationId)?.mounts.push(m);
  for (const o of outputs) stations.get(o.stationId)?.outputs.push(o);
  for (const v of stations.values()) v.autodjMount = autodjMount(v.station, v.mounts);
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
    if (!view || !view.active || (tenantId && view.tenantId !== tenantId)) return null;
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
