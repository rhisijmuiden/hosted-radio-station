import { createHash, createHmac } from 'node:crypto';
import { and, asc, count, eq, inArray, isNotNull } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '../../db/index.js';
import { NODE_ROLES, type NodeConfig, type NodeRole } from '../../db/schema.js';
import type { AppContext } from '../../lib/context.js';
import { getSetting } from '../settings.js';
import { platformHost } from '../streaming/state.js';
import { getVersionInfo, type VersionInfo } from '../system.js';
import type { NodePlan, ProbeTarget, RelayMount } from './protocol.js';

export type Node = typeof schema.nodes.$inferSelect;

export const hostRe = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export const nodeConfigSchema = z.object({
  publicHost: z
    .string()
    .trim()
    .toLowerCase()
    .max(253)
    .refine((v) => v === '' || hostRe.test(v), 'Invalid host name')
    .default(''),
  listenPort: z.number().int().min(1).max(65535).nullable().default(null),
  relayStations: z.union([z.literal('all'), z.array(z.uuid()).max(500)]).default('all'),
  maxListeners: z.number().int().min(0).max(1_000_000).default(0),
  sourcePlainPort: z.number().int().min(1024).max(65535).nullable().default(8010),
  sourceTlsPort: z.number().int().min(1024).max(65535).nullable().default(8443),
  probe: z.boolean().default(true),
  pushPort: z.number().int().min(1024).max(65535).nullable().default(8001),
  lanAddress: z
    .string()
    .trim()
    .max(253)
    .regex(/^$|^[A-Za-z0-9.:-]+$/, 'Use an IP address or host name')
    .default(''),
});
export type NodeSettings = z.infer<typeof nodeConfigSchema>;

export const nodeSettings = (node: Pick<Node, 'config'>): NodeSettings => nodeConfigSchema.parse(node.config ?? {});

/** Default port listeners use: 80 behind the node's own web server, else Icecast's 8000. */
export const defaultListenPort = (node: Pick<Node, 'status'>) => (node.status.caddy ? 80 : 8000);

/**
 * The base URL listeners of a relay node use, e.g. https://relay-ams.example.com or http://203.0.113.5:8000.
 * Null when the node has neither a host name nor a known address.
 */
export function relayBaseUrl(node: Pick<Node, 'config' | 'status'>): string | null {
  const c = nodeSettings(node);
  const port = c.listenPort ?? defaultListenPort(node);
  const host = c.publicHost || node.status.ip;
  if (!host) return null;
  if (c.publicHost && node.status.caddy) return `https://${c.publicHost}`;
  const h = host.includes(':') ? `[${host}]` : host;
  return port === 80 ? `http://${h}` : `http://${h}:${port}`;
}

let versionCache: { at: number; value: VersionInfo } | null = null;
async function version(ctx: AppContext) {
  if (!versionCache || Date.now() - versionCache.at > 60_000) versionCache = { at: Date.now(), value: await getVersionInfo(ctx) };
  return versionCache.value;
}
export const forgetVersion = () => (versionCache = null);

type StationRow = { id: string; slug: string; tenantId: string; name: string; nodeId: string | null };

/** Active stations a node may serve: all of them, or only its customer's. */
export async function servableStations(ctx: AppContext, tenantId: string | null): Promise<StationRow[]> {
  return ctx.db
    .select({ id: schema.stations.id, slug: schema.stations.slug, tenantId: schema.stations.tenantId, name: schema.stations.name, nodeId: schema.stations.nodeId })
    .from(schema.stations)
    .innerJoin(schema.tenants, eq(schema.tenants.id, schema.stations.tenantId))
    .where(and(eq(schema.stations.enabled, true), eq(schema.tenants.active, true), tenantId ? eq(schema.stations.tenantId, tenantId) : undefined))
    .orderBy(asc(schema.stations.slug));
}

/** Station ids a relay node carries. */
export function carried(node: Pick<Node, 'roles' | 'config' | 'tenantId'>, stations: { id: string; tenantId: string }[]): Set<string> {
  if (!node.roles.includes('relay')) return new Set();
  const c = nodeSettings(node);
  const allowed = stations.filter((s) => !node.tenantId || s.tenantId === node.tenantId);
  return new Set(allowed.filter((s) => c.relayStations === 'all' || c.relayStations.includes(s.id)).map((s) => s.id));
}

/** Paired relay nodes per station id (for listen routes on this server, routing and the topology). */
export async function relaysByStation(ctx: AppContext): Promise<Map<string, Node[]>> {
  const nodes = await ctx.db.select().from(schema.nodes).where(isNotNull(schema.nodes.pairedAt));
  const relays = nodes.filter((n) => n.roles.includes('relay'));
  const out = new Map<string, Node[]>();
  if (!relays.length) return out;
  const stations = await servableStations(ctx, null);
  for (const n of relays) {
    for (const id of carried(n, stations)) {
      const list = out.get(id) ?? [];
      list.push(n);
      out.set(id, list);
    }
  }
  return out;
}

const baseUrl = (ctx: AppContext) => ctx.config.PUBLIC_URL.replace(/\/$/, '');

/** What a node must do now. */
export async function buildPlan(ctx: AppContext, node: Node): Promise<NodePlan> {
  const c = nodeSettings(node);
  const roles = node.roles.filter((r): r is NodeRole => NODE_ROLES.includes(r));
  const [settings, v, stations] = await Promise.all([getSetting(ctx, 'nodes'), version(ctx), servableStations(ctx, node.tenantId)]);
  const ids = stations.map((s) => s.id);
  const mounts = ids.length
    ? await ctx.db
        .select()
        .from(schema.stationMounts)
        .where(and(inArray(schema.stationMounts.stationId, ids), eq(schema.stationMounts.isPublic, true)))
        .orderBy(asc(schema.stationMounts.sortOrder), asc(schema.stationMounts.createdAt))
    : [];
  const base = baseUrl(ctx);

  let relay: NodePlan['relay'] = null;
  if (roles.includes('relay')) {
    const mine = carried(node, stations);
    const list: RelayMount[] = [];
    for (const s of stations) {
      if (!mine.has(s.id)) continue;
      for (const m of mounts.filter((x) => x.stationId === s.id)) {
        const key = `${s.slug}${m.path}`;
        // A station on a station node pushes its streams here; the others are pulled from this server.
        const push = s.nodeId ? { token: pushToken(ctx, node, key) } : null;
        list.push({ key, stationId: s.id, slug: s.slug, path: m.path, name: m.name ? `${s.name} – ${m.name}` : s.name, format: m.format, url: push ? null : `${base}/listen/${key}`, push });
      }
    }
    relay = { maxListeners: c.maxListeners, mounts: list, pushPort: c.pushPort };
  }

  let source: NodePlan['source'] = null;
  if (roles.includes('source')) {
    const [proxy, streaming, host, domains] = await Promise.all([
      getSetting(ctx, 'proxy'),
      getSetting(ctx, 'streaming'),
      platformHost(ctx),
      ctx.db.select({ host: schema.tenantDomains.ingestHost }).from(schema.tenantDomains).where(eq(schema.tenantDomains.ingestNodeId, node.id)),
    ]);
    // Encoders are passed on over TLS when this server has a certificate for its own name.
    const tls = proxy.mode === 'builtin' && !!proxy.domain;
    const port = tls ? streaming.ingestTlsPort : streaming.ingestPlainPort;
    source = {
      plainPort: c.sourcePlainPort,
      tlsPort: c.sourceTlsPort,
      upstream: { host: tls ? proxy.domain : host, port: port ?? streaming.ingestTlsPort, tls },
      hosts: domains.map((d) => d.host).sort(),
    };
  }

  let probes: NodePlan['probes'] = null;
  if (c.probe) {
    const targets: ProbeTarget[] = [];
    const relays = await relaysByStation(ctx);
    for (const s of stations) {
      const own = mounts.filter((m) => m.stationId === s.id);
      const def = own.find((m) => m.isDefault) ?? own[0];
      if (!def) continue;
      // A station on a station node is not served here, only by its relays.
      if (!s.nodeId) targets.push({ target: `${s.slug}${def.path}@main`, stationId: s.id, url: `${base}/listen/${s.slug}${def.path}` });
      for (const r of relays.get(s.id) ?? []) {
        const rb = r.id !== node.id && r.status.online ? relayBaseUrl(r) : null;
        if (rb) targets.push({ target: `${s.slug}${def.path}@${r.id}`, stationId: s.id, url: `${rb}/listen/${s.slug}${def.path}` });
      }
    }
    probes = { intervalSeconds: settings.probeIntervalSeconds, targets: targets.slice(0, 50) };
  }

  let station: NodePlan['station'] = null;
  if (roles.includes('station')) {
    const [{ n }] = await ctx.db.select({ n: count() }).from(schema.stations).where(eq(schema.stations.nodeId, node.id));
    station = { stations: n };
  }

  const plan: Omit<NodePlan, 'revision'> = {
    nodeId: node.id,
    name: node.name,
    roles,
    web: { publicHost: c.publicHost || null, listenPort: c.listenPort },
    relay,
    source,
    probes,
    station,
    update: { branch: v.branch, commit: v.commit, auto: settings.autoUpdate },
  };
  return { ...plan, revision: createHash('sha256').update(JSON.stringify(plan)).digest('hex').slice(0, 16) };
}

/**
 * The password a station node pushes one stream to a relay node with: an HMAC of the stream key under the relay's own
 * secret, so the relay can check it without asking this server and every relay has its own.
 */
export function pushToken(ctx: AppContext, relay: Pick<Node, 'secret'>, key: string): string {
  const secret = relay.secret ? ctx.box.decrypt(relay.secret) : '';
  return createHmac('sha256', secret).update(`push:${key}`).digest('base64url');
}

/** Validates settings from the panel and returns the stored form. */
export function storedConfig(input: Partial<NodeSettings>, current: NodeConfig = {}): NodeConfig {
  return nodeConfigSchema.parse({ ...current, ...input });
}
