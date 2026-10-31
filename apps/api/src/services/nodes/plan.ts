import { createHash, createHmac } from 'node:crypto';
import net from 'node:net';
import { and, asc, count, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '../../db/index.js';
import { NODE_ROLES, type NodeConfig, type NodeRole } from '../../db/schema.js';
import type { AppContext } from '../../lib/context.js';
import { dnsConfig } from '../dns/config.js';
import { getSetting, UPDATE_POLICIES, updateWindowSchema } from '../settings.js';
import { platformHost } from '../streaming/state.js';
import { runningVersion } from '../system.js';
import { DEDICATIONS, scopeOf, serves } from './dedication.js';
import { buildFmPlan, fmConfigSchema } from './fm.js';
import { recordedStations, recorderPlan, type OpenSession } from '../recorder/plan.js';
import { firewallPlan } from './firewall-plan.js';
import { ingestTarget, plannedIngests, recorderToken } from './delivery.js';
import { OLD_PORTS, PORTS } from './portplan.js';
import { ingestsOf, pushedRouting, stationRouting } from './routing-rules.js';
import type { IngestStation, NodePlan, ProbeTarget, RelayMount } from './protocol.js';

export type Node = typeof schema.nodes.$inferSelect;

export const hostRe = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** An extra incoming port or range for the node's firewall, on top of the ports of its roles. */
export const firewallPortSchema = z
  .object({ port: z.number().int().min(1).max(65535), to: z.number().int().min(1).max(65535).nullable().default(null), proto: z.enum(['tcp', 'udp']).default('tcp') })
  .refine((p) => p.to === null || p.to >= p.port, 'The end of the range comes after its start');

/**
 * The node's own firewall (security hardening for external nodes): an nftables table that lets in only SSH and the
 * ports of the node's roles. takeOver = replace firewall rules of something else found on the server.
 */
/** An address or network SSH is let in from: 203.0.113.5, 198.51.100.0/24 or 2001:db8::/32. */
export const sshSourceSchema = z
  .string()
  .trim()
  .max(50)
  .refine((v) => {
    const [ip, bits, ...rest] = v.split('/');
    const family = net.isIP(ip ?? '');
    if (!family || rest.length) return false;
    if (bits === undefined) return true;
    const n = Number(bits);
    return /^\d{1,3}$/.test(bits) && n >= 0 && n <= (family === 4 ? 32 : 128);
  }, 'Use an IP address or a network such as 198.51.100.0/24');

export const firewallConfigSchema = z.object({
  enabled: z.boolean().default(false),
  takeOver: z.boolean().default(false),
  extraPorts: z.array(firewallPortSchema).max(50).default([]),
  /** SSH only from these addresses or networks; empty = from anywhere. */
  sshFrom: z.array(sshSourceSchema).max(50).default([]),
  /** Limits new SSH connections per address (against password guessing). */
  sshLimit: z.boolean().default(true),
  /**
   * Not decided yet (new nodes, and nodes from before step 4 whose firewall was not switched on by hand): at its next
   * connection with software that has a firewall, a node with a public address on its own interface gets the firewall
   * switched on, any other node keeps it off.
   */
  auto: z.boolean().default(false),
});

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
  sourcePlainPort: z.number().int().min(1024).max(65535).nullable().default(PORTS.ingest.plain),
  sourceTlsPort: z.number().int().min(1024).max(65535).nullable().default(PORTS.ingest.tls),
  probe: z.boolean().default(true),
  pushPort: z.number().int().min(1024).max(65535).nullable().default(PORTS.relay.push),
  /**
   * Old ports (port plan, 1.3): the node keeps the ports from before the port plan open next to the new ones (8010 and
   * 8443 for encoders, 8001 for pushes, 2022 for SFTP on a station node), and pushes to it keep using 8001. On for nodes
   * paired before 1.3 that kept the default ports, until the administrator switches it off.
   */
  oldPorts: z.boolean().default(false),
  lanAddress: z
    .string()
    .trim()
    .max(253)
    .regex(/^$|^[A-Za-z0-9.:-]+$/, 'Use an IP address or host name')
    .default(''),
  fm: fmConfigSchema.default(fmConfigSchema.parse({})),
  firewall: firewallConfigSchema.default(firewallConfigSchema.parse({})),
  /** How this node gets new versions; inherit = from its update group, or the network's default. */
  updatePolicy: z.enum(['inherit', ...UPDATE_POLICIES]).default('inherit'),
  /** Id of an update group in the network settings, null = no group. */
  updateGroup: z.string().regex(/^[a-z0-9-]{1,40}$/).nullable().default(null),
  /** Own maintenance window for policy "window"; null = the group's or the network's. */
  updateWindow: updateWindowSchema.nullable().default(null),
  /** Cloudflare DNS (phase 15): the first part of the node's platform name, e.g. relay1. Empty = from the node's name. */
  dnsName: z
    .string()
    .trim()
    .toLowerCase()
    .max(63)
    .regex(/^$|^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/, 'Use a-z, 0-9 and dashes')
    .default(''),
  /** Give this node a platform name (record) when Cloudflare DNS is on. */
  dnsRecord: z.boolean().default(true),
  /** Public address for the node's record, when the address it connects from is not the one the outside world uses. */
  publicAddress: z
    .string()
    .trim()
    .max(45)
    .refine((v) => v === '' || net.isIP(v) !== 0, 'Use an IPv4 or IPv6 address')
    .default(''),
  /**
   * Certificates for the node's names under the platform domain through Cloudflare DNS (DNS-01) instead of HTTP, so a
   * node whose port 80 cannot be reached still gets HTTPS. The main server sets the TXT records; the token stays there.
   */
  certDns: z.boolean().default(false),
  /**
   * Shared or dedicated (1.1.1): auto = a customer's own node and a station node are dedicated, relay and ingest nodes
   * of the platform are shared. See dedication.ts.
   */
  dedication: z.enum(DEDICATIONS).default('auto'),
  /** Dedicated to this customer (a platform node with dedication "customer"). */
  dedicatedTenantId: z.uuid().nullable().default(null),
  /** Dedicated to this station (dedication "station"). */
  dedicatedStationId: z.uuid().nullable().default(null),
  /** Recorder (phase 21): the stations it records, "all" = every station it serves. None until they are chosen. */
  recordStations: z.union([z.literal('all'), z.array(z.uuid()).max(500)]).default([]),
  /** Set by the DNS manager, not by hand: the node's platform name while its record exists. */
  dnsHost: z.string().default(''),
  /** Set by the DNS manager: the check of the node's own host name (publicHost) when it is not a platform name. */
  publicHostCheck: z
    .object({ ok: z.boolean(), found: z.array(z.string()), error: z.string().optional(), at: z.string() })
    .nullable()
    .default(null),
});
export type NodeSettings = z.infer<typeof nodeConfigSchema>;

/** The same object with every field optional and without defaults: a change sends only what it changes. */
function patchOf<T extends z.ZodRawShape>(shape: T) {
  return z.object(Object.fromEntries(Object.entries(shape).map(([k, v]) => [k, ((v instanceof z.ZodDefault ? v.unwrap() : v) as z.ZodType).optional()])) as unknown as { [K in keyof T]: z.ZodOptional<T[K] extends z.ZodDefault<infer I> ? I : T[K]> });
}

/** Body of a settings change from the panel or the API. */
export const nodeConfigPatch = patchOf(nodeConfigSchema.shape)
  .omit({ dnsHost: true, publicHostCheck: true })
  .extend({ fm: patchOf(fmConfigSchema.shape).optional(), firewall: patchOf(firewallConfigSchema.shape).optional() });
export type NodeConfigPatch = z.infer<typeof nodeConfigPatch>;

export const nodeSettings = (node: Pick<Node, 'config'>): NodeSettings => nodeConfigSchema.parse(node.config ?? {});

/**
 * The host name the outside world uses for a node: its own name (publicHost), else its platform name from Cloudflare
 * DNS (phase 15). An own name that does not check out (no CNAME to the platform name, no A record to the node) gives
 * way to the platform name while there is one, so studios and encoders keep a name that works.
 */
export function nodeHost(node: Pick<Node, 'config'>): string {
  const c = node.config ?? {};
  const own = (c.publicHost ?? '').trim();
  const platform = c.dnsHost ?? '';
  if (own && platform && own !== platform && c.publicHostCheck && !c.publicHostCheck.ok) return platform;
  return own || platform;
}

/** The push port ingests and station nodes deliver to on a relay: the old one while the relay keeps its old ports. */
export const pushPortOf = (c: Pick<NodeSettings, 'pushPort' | 'oldPorts'>) => (c.pushPort && c.oldPorts ? OLD_PORTS.push : c.pushPort);

/** A port and, while the node keeps its old ports, the old one next to it (no duplicates, no empty ports). */
export const withOld = (port: number | null, old: number, on: boolean) => [...new Set([port, port && on ? old : null])].filter((p): p is number => !!p);

/** Default port listeners use: 80 behind the node's own web server, else Icecast's 8000. */
export const defaultListenPort = (node: Pick<Node, 'status'>) => (node.status.caddy ? 80 : 8000);

/**
 * The base URL listeners of a relay node use, e.g. https://relay-ams.example.com or http://203.0.113.5:8000.
 * Null when the node has neither a host name nor a known address.
 */
export function relayBaseUrl(node: Pick<Node, 'config' | 'status'>): string | null {
  const c = nodeSettings(node);
  const port = c.listenPort ?? defaultListenPort(node);
  const name = nodeHost(node);
  const host = name || node.status.ip;
  if (!host) return null;
  if (name && node.status.caddy) return `https://${name}`;
  const h = host.includes(':') ? `[${host}]` : host;
  return port === 80 ? `http://${h}` : `http://${h}:${port}`;
}

type StationRow = { id: string; slug: string; tenantId: string; name: string; nodeId: string | null; edition: string; routing: Record<string, unknown>; recording: Record<string, unknown> };

const stationColumns = {
  id: schema.stations.id,
  slug: schema.stations.slug,
  tenantId: schema.stations.tenantId,
  name: schema.stations.name,
  nodeId: schema.stations.nodeId,
  edition: schema.stations.edition,
  routing: schema.stations.routing,
  recording: schema.stations.recording,
};

/** Active stations a node may serve: all of them, or only its customer's. */
export async function servableStations(ctx: AppContext, tenantId: string | null): Promise<StationRow[]> {
  return ctx.db
    .select(stationColumns)
    .from(schema.stations)
    .innerJoin(schema.tenants, eq(schema.tenants.id, schema.stations.tenantId))
    .where(and(eq(schema.stations.enabled, true), eq(schema.tenants.active, true), tenantId ? eq(schema.stations.tenantId, tenantId) : undefined))
    .orderBy(asc(schema.stations.slug));
}

type RelayNode = Pick<Node, 'id' | 'roles' | 'config' | 'tenantId' | 'status'>;
type RoutedStation = { id: string; tenantId: string; routing?: Record<string, unknown> | null };

/** A relay may carry a station: it serves it (shared, or dedicated to its customer or to the station itself). */
const mayCarry = (n: RelayNode, s: RoutedStation) => n.roles.includes('relay') && serves(n, s);

/** The relays that carry a station by their own settings ("all stations" or a chosen list). */
const byOwnSettings = (n: RelayNode, s: RoutedStation) => {
  const c = nodeSettings(n).relayStations;
  return mayCarry(n, s) && (c === 'all' || c.includes(s.id));
};

/**
 * The relays of one station (phase 13): the station's chosen relays, or every relay that carries it by its own
 * settings. When none of the chosen relays is online and spare relays are allowed, the others step in.
 */
export function relaysOf(s: RoutedStation, relays: RelayNode[]): RelayNode[] {
  const r = stationRouting(s);
  if (r.relays === 'auto') return relays.filter((n) => byOwnSettings(n, s));
  const chosen = relays.filter((n) => r.relays.includes(n.id) && mayCarry(n, s));
  if (!r.spareRelays || chosen.some((n) => n.status.online)) return chosen;
  return [...chosen, ...relays.filter((n) => !r.relays.includes(n.id) && n.status.online && byOwnSettings(n, s))];
}

/** Station ids a relay node carries, given all relay nodes (for spares). */
export function carried(node: RelayNode, stations: RoutedStation[], relays: RelayNode[]): Set<string> {
  if (!node.roles.includes('relay')) return new Set();
  const all = relays.some((n) => n.id === node.id) ? relays : [...relays, node];
  return new Set(stations.filter((s) => relaysOf(s, all).some((n) => n.id === node.id)).map((s) => s.id));
}

/** Paired relay nodes. */
export async function pairedRelays(ctx: AppContext): Promise<Node[]> {
  // In a fixed order: rows move around as their status is updated, and a plan or package must not change with them.
  const nodes = await ctx.db.select().from(schema.nodes).where(isNotNull(schema.nodes.pairedAt)).orderBy(asc(schema.nodes.id));
  return nodes.filter((n) => n.roles.includes('relay'));
}

/** Paired relay nodes per station id (for listen routes on this server, routing and the topology). */
export async function relaysByStation(ctx: AppContext): Promise<Map<string, Node[]>> {
  const relays = await pairedRelays(ctx);
  const out = new Map<string, Node[]>();
  if (!relays.length) return out;
  for (const s of await servableStations(ctx, null)) {
    const list = relaysOf(s, relays) as Node[];
    if (list.length) out.set(s.id, list);
  }
  return out;
}

/** Where an ingest pushes a station's streams to on a relay node: its push port, by name or address. */
export function pushTarget(relay: Pick<Node, 'id' | 'name' | 'config' | 'status'>, fromNodeId: string | null) {
  const c = nodeSettings(relay);
  // An ingest node that is also the relay delivers to itself.
  const host = relay.id === fromNodeId ? '127.0.0.1' : c.publicHost || relay.status.ip;
  const port = pushPortOf(c);
  if (!host || !port) return null;
  return { nodeId: relay.id, name: relay.name, host, port, insecureTls: host === '127.0.0.1' || !c.publicHost };
}

/** How long a monitoring node listens to each stream (phase 20). */
export const MONITOR_LISTEN_SECONDS = 8;

/**
 * A shared monitoring node is online (phase 20): it checks every stream from outside, so the other nodes stop their
 * own stream checks. A monitoring node of (or dedicated to) a customer only watches that customer and switches nothing off.
 */
export async function sharedMonitorOnline(ctx: AppContext) {
  const rows = await ctx.db
    .select({ id: schema.nodes.id, tenantId: schema.nodes.tenantId, roles: schema.nodes.roles, config: schema.nodes.config })
    .from(schema.nodes)
    .where(and(isNotNull(schema.nodes.pairedAt), isNull(schema.nodes.tenantId), sql`'monitor' = any(${schema.nodes.roles})`, sql`(${schema.nodes.status}->>'online')::boolean`));
  return rows.some((n) => scopeOf(n).kind === 'shared');
}

/**
 * What a monitoring node checks: the default stream of every station through every relay that carries it (and through
 * this server when it serves the station itself), and each other public stream once, as a listener would hear it.
 */
export function monitorTargets(stations: StationRow[], mounts: (typeof schema.stationMounts.$inferSelect)[], relays: Node[], base: string): ProbeTarget[] {
  const targets: ProbeTarget[] = [];
  const deep = { seconds: MONITOR_LISTEN_SECONDS };
  for (const s of stations) {
    const own = mounts.filter((m) => m.stationId === s.id);
    const def = own.find((m) => m.isDefault) ?? own[0];
    if (!def) continue;
    const places: { where: string; base: string }[] = [];
    if (!s.nodeId && !pushedRouting(stationRouting(s))) places.push({ where: 'main', base });
    for (const r of relaysOf(s, relays)) {
      const rb = r.status.online ? relayBaseUrl(r) : null;
      if (rb) places.push({ where: r.id, base: rb });
    }
    for (const [i, p] of places.entries()) {
      for (const m of i === 0 ? own : [def]) targets.push({ target: `${s.slug}${m.path}@${p.where}`, stationId: s.id, url: `${p.base}/listen/${s.slug}${m.path}`, deep });
    }
  }
  return targets.slice(0, 1000);
}

const baseUrl = (ctx: AppContext) => ctx.config.PUBLIC_URL.replace(/\/$/, '');

/** Live broadcasts on air now on these stations (phase 21: a recorder records them). */
/**
 * Where a recorder reads a station straight from its ingest node while no relay carries it (small fixes): the
 * station's main ingest first, online ones only, at the address the recorder can reach (as a station node would:
 * on the same site plain, from elsewhere only over checked TLS). Null for a station without an ingest node.
 */
async function ingestFallbacks(ctx: AppContext, recorder: Node, stations: StationRow[]): Promise<(stationId: string, path: string) => string | null> {
  if (!stations.some((s) => s.nodeId || pushedRouting(stationRouting(s)))) return () => null;
  const paired = await ctx.db.select().from(schema.nodes).where(isNotNull(schema.nodes.pairedAt)).orderBy(asc(schema.nodes.id));
  return (stationId, path) => {
    const s = stations.find((x) => x.id === stationId);
    if (!s) return null;
    const refs = s.nodeId ? (plannedIngests(s, paired) ?? []).map((i) => i.node.id) : ingestsOf(stationRouting(s)).map((i) => i.ref);
    for (const id of refs) {
      const n = paired.find((x) => x.id === id && x.roles.includes('source') && x.status.online);
      const at = n && ingestTarget(n, recorder);
      if (!n || !at) continue;
      const key = `${s.slug}${path}`;
      return `${at.tls ? 'https' : 'http'}://${at.host}:${at.port}/ingest/${key}?token=${recorderToken(ctx, n, key)}`;
    }
    return null;
  };
}

async function openSessions(ctx: AppContext, stationIds: string[]): Promise<OpenSession[]> {
  if (!stationIds.length) return [];
  const ls = schema.liveSessions;
  return ctx.db
    .select({ id: ls.id, stationId: ls.stationId, mountPath: ls.mountPath, accountName: ls.accountName, startedAt: ls.startedAt, record: ls.record })
    .from(ls)
    .where(and(inArray(ls.stationId, stationIds), isNull(ls.endedAt)))
    .orderBy(asc(ls.startedAt));
}

/** What a node must do now. */
export async function buildPlan(ctx: AppContext, node: Node): Promise<NodePlan> {
  const c = nodeSettings(node);
  const roles = node.roles.filter((r): r is NodeRole => NODE_ROLES.includes(r));
  const [settings, v, stations] = await Promise.all([getSetting(ctx, 'nodes'), runningVersion(ctx), servableStations(ctx, node.tenantId).then((l) => l.filter((s) => serves(node, s)))]);
  const ids = stations.map((s) => s.id);
  const [allMounts, relays] = await Promise.all([
    ids.length
      ? ctx.db
          .select()
          .from(schema.stationMounts)
          .where(inArray(schema.stationMounts.stationId, ids))
          .orderBy(asc(schema.stationMounts.sortOrder), asc(schema.stationMounts.createdAt))
      : [],
    pairedRelays(ctx),
  ]);
  const mounts = allMounts.filter((m) => m.isPublic);
  const base = baseUrl(ctx);

  let relay: NodePlan['relay'] = null;
  if (roles.includes('relay')) {
    const mine = carried(node, stations, relays);
    const list: RelayMount[] = [];
    for (const s of stations) {
      if (!mine.has(s.id)) continue;
      for (const m of mounts.filter((x) => x.stationId === s.id)) {
        const key = `${s.slug}${m.path}`;
        // A station on a station node, or with an ingest node, pushes its streams here; the others are pulled from
        // this server.
        const push = s.nodeId || pushedRouting(stationRouting(s)) ? { token: pushToken(ctx, node, key) } : null;
        list.push({ key, stationId: s.id, slug: s.slug, path: m.path, name: m.name ? `${s.name} – ${m.name}` : s.name, format: m.format, url: push ? null : `${base}/listen/${key}`, push });
      }
    }
    // pushPort is what agents before 1.3 listen on: the old port while the node keeps it, so nothing moves until the
    // agent is updated and listens on every port in pushPorts.
    relay = { maxListeners: c.maxListeners, mounts: list, pushPort: pushPortOf(c), pushPorts: withOld(c.pushPort, OLD_PORTS.push, c.oldPorts) };
  }

  let source: NodePlan['source'] = null;
  let ingest: NodePlan['ingest'] = null;
  if (roles.includes('source')) {
    const [proxy, streaming, host, domains] = await Promise.all([
      getSetting(ctx, 'proxy'),
      getSetting(ctx, 'streaming'),
      platformHost(ctx),
      ctx.db
        .select({ host: schema.tenantDomains.ingestHost, tenantId: schema.tenantDomains.tenantId, nodeId: schema.tenantDomains.ingestNodeId })
        .from(schema.tenantDomains)
        .where(eq(schema.tenantDomains.status, 'verified')),
    ]);
    // Encoders are passed on over TLS when this server has a certificate for its own name.
    const tls = proxy.mode === 'builtin' && !!proxy.domain;
    const port = tls ? streaming.ingestTlsPort : streaming.ingestPlainPort;
    source = {
      // As with the push port: agents before 1.3 keep the old ports, newer ones listen on every port in `ports`.
      plainPort: c.oldPorts && c.sourcePlainPort ? OLD_PORTS.plain : c.sourcePlainPort,
      tlsPort: c.oldPorts && c.sourceTlsPort ? OLD_PORTS.tls : c.sourceTlsPort,
      ports: { plain: withOld(c.sourcePlainPort, OLD_PORTS.plain, c.oldPorts), tls: withOld(c.sourceTlsPort, OLD_PORTS.tls, c.oldPorts) },
      // A direct address (Nodes → settings) skips a public name that only carries web traffic, such as a CDN.
      upstream: settings.ingestAddress
        ? streaming.ingestPlainPort
          ? { host: settings.ingestAddress, port: streaming.ingestPlainPort, tls: false }
          : { host: settings.ingestAddress, port: streaming.ingestTlsPort, tls: true }
        : { host: tls ? proxy.domain : host, port: port ?? streaming.ingestTlsPort, tls },
      hosts: domains.filter((d) => d.nodeId === node.id).map((d) => d.host).sort(),
    };
    ingest = await ingestPlan(ctx, node, stations, allMounts, relays, domains);
  }

  let probes: NodePlan['probes'] = null;
  const monitor = roles.includes('monitor');
  if (monitor) {
    probes = { intervalSeconds: settings.probeIntervalSeconds, targets: monitorTargets(stations, mounts, relays, base) };
  } else if (c.probe && !(await sharedMonitorOnline(ctx))) {
    const targets: ProbeTarget[] = [];
    for (const s of stations) {
      const own = mounts.filter((m) => m.stationId === s.id);
      const def = own.find((m) => m.isDefault) ?? own[0];
      if (!def) continue;
      // A station on a station node or an ingest node is not served here, only by its relays.
      if (!s.nodeId && !pushedRouting(stationRouting(s))) targets.push({ target: `${s.slug}${def.path}@main`, stationId: s.id, url: `${base}/listen/${s.slug}${def.path}` });
      for (const r of relaysOf(s, relays)) {
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
  const fmStation = roles.includes('fm') ? stations.find((s) => s.id === c.fm.stationId) : undefined;
  // The audio of a station with an ingest node (or on a station node) does not pass this server: the FM node then
  // listens on one of the station's relays.
  const fmBase =
    fmStation && (fmStation.nodeId || pushedRouting(stationRouting(fmStation)))
      ? (relaysOf(fmStation, relays)
          .filter((r) => r.status.online)
          .map((r) => relayBaseUrl(r))
          .find(Boolean) ?? base)
      : base;
  const fm = fmStation ? await buildFmPlan(ctx, c.fm, fmBase, stations, await stereoToolBinary(ctx)) : null;
  const firewall = await firewallPlan(ctx, node);
  const recorder = roles.includes('recorder')
    ? recorderPlan(c, stations, allMounts, base, await openSessions(ctx, recordedStations(c, stations).map((s) => s.id)), Date.now(), await ingestFallbacks(ctx, node, recordedStations(c, stations)))
    : null;

  const plan: Omit<NodePlan, 'revision'> = {
    nodeId: node.id,
    name: node.name,
    roles,
    web: { publicHost: nodeHost(node) || null, listenPort: c.listenPort, dnsCerts: await dnsCertsOf(ctx, node, source?.hosts ?? []) },
    relay,
    source,
    ingest,
    probes,
    station,
    fm,
    firewall,
    recorder,
    // Never true: agents up to this version update themselves as soon as it is, all at the same time. The update
    // planner (updates.ts) sends each node an update message when its turn comes.
    update: { branch: v.branch, commit: v.commit, auto: false },
  };
  return { ...plan, revision: createHash('sha256').update(JSON.stringify(plan)).digest('hex').slice(0, 16) };
}

/** The uploaded Stereo Tool program as FM nodes see it: only what tells them whether they have the right file. */
async function stereoToolBinary(ctx: AppContext) {
  const b = (await getSetting(ctx, 'stereoTool')).binary;
  return b ? { sha256: b.sha256, size: b.size } : null;
}

/**
 * The names a node fetches its certificates for through Cloudflare DNS (DNS-01): those of its certificate names that
 * lie under the platform domain, while Cloudflare DNS is on and the node asks for it. Null = HTTP as usual.
 */
export async function dnsCertsOf(ctx: AppContext, node: Node, sourceHosts: string[]): Promise<NodePlan['web']['dnsCerts']> {
  if (!nodeSettings(node).certDns) return null;
  const { base, active } = await dnsConfig(ctx);
  if (!active) return null;
  const hosts = [...new Set([nodeHost(node), ...sourceHosts])].filter((h) => !!h && (h === base || h.endsWith(`.${base}`))).sort();
  if (!hosts.length) return null;
  const proxy = await getSetting(ctx, 'proxy');
  return { hosts, email: proxy.acmeEmail || `hostmaster@${base}` };
}

type MountRow = typeof schema.stationMounts.$inferSelect;

/**
 * The stations an ingest node takes encoders for (phase 13), as main or backup ingest, with their mounts, the relays
 * to push every public mount to, and the external Icecast servers to feed.
 */
async function ingestPlan(
  ctx: AppContext,
  node: Node,
  stations: StationRow[],
  mounts: MountRow[],
  relays: Node[],
  domains: { host: string; tenantId: string }[],
): Promise<NonNullable<NodePlan['ingest']>> {
  // A station on a station node sends its source streams here when it is routed through this ingest (1.3).
  const paired = stations.some((s) => s.nodeId) ? await ctx.db.select().from(schema.nodes).where(isNotNull(schema.nodes.pairedAt)).orderBy(asc(schema.nodes.id)) : [];
  const mine = stations
    .map((s) => ({
      s,
      me: s.nodeId
        ? (plannedIngests(s, paired) ?? []).filter((i) => i.node.id === node.id).map((i) => ({ ref: node.id, priority: i.priority }))[0]
        : ingestsOf(stationRouting(s)).find((i) => i.ref === node.id),
    }))
    .filter((x): x is { s: StationRow; me: { ref: string; priority: number } } => !!x.me);
  const ids = mine.map((x) => x.s.id);
  const outputs = ids.length
    ? await ctx.db
        .select()
        .from(schema.stationOutputs)
        .where(and(inArray(schema.stationOutputs.stationId, ids), eq(schema.stationOutputs.type, 'icecast'), eq(schema.stationOutputs.enabled, true)))
    : [];
  const open = (sealed: string | undefined) => {
    try {
      return sealed ? ctx.box.decrypt(sealed) : '';
    } catch {
      return '';
    }
  };
  const list: IngestStation[] = mine.map(({ s, me }) => {
    const own = mounts.filter((m) => m.stationId === s.id);
    const path = (id: string | null) => (id ? (own.find((m) => m.id === id)?.path ?? null) : null);
    const targets = relaysOf(s, relays)
      .map((r) => {
        const t = pushTarget(r as Node, node.id);
        if (!t) return null;
        const tokens: Record<string, string> = {};
        for (const m of own.filter((x) => x.isPublic)) tokens[`${s.slug}${m.path}`] = pushToken(ctx, r as Node, `${s.slug}${m.path}`);
        return { ...t, tokens };
      })
      .filter((t): t is NonNullable<typeof t> => !!t);
    return {
      stationId: s.id,
      slug: s.slug,
      name: s.name,
      tenantId: s.tenantId,
      priority: me.priority,
      mounts: own.map((m) => ({
        path: m.path,
        name: m.name,
        kind: m.kind,
        format: m.format,
        bitrateKbps: m.bitrateKbps,
        sourcePath: path(m.sourceMountId),
        fallbackPath: path(m.fallbackMountId),
        isPublic: m.isPublic,
      })),
      targets,
      // The station node feeds the external servers of its stations itself.
      outputs: outputs
        .filter((o) => o.stationId === s.id && !s.nodeId && o.config.push !== false && o.mountId && o.config.host && o.config.port)
        .map((o) => ({
          id: o.id,
          mountPath: path(o.mountId) ?? '',
          host: o.config.host!,
          port: o.config.port!,
          tls: !!o.config.tls,
          mount: o.config.mount || '/stream',
          username: o.config.username || 'source',
          password: open(o.config.password),
        }))
        .filter((o) => o.mountPath),
    };
  });
  const tenants = new Set(list.map((x) => x.tenantId));
  return { stations: list, hosts: Object.fromEntries(domains.filter((d) => tenants.has(d.tenantId)).map((d) => [d.host, d.tenantId])) };
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
export function storedConfig(input: NodeConfigPatch, current: NodeConfig = {}): NodeConfig {
  const fm = input.fm ? { ...(current.fm ?? {}), ...input.fm } : current.fm;
  // Switching the firewall on or off by hand is the decision: a new node's default no longer applies then.
  const firewall = input.firewall ? { ...(current.firewall ?? {}), ...input.firewall, ...(input.firewall.enabled !== undefined ? { auto: false } : {}) } : current.firewall;
  return nodeConfigSchema.parse({ ...current, ...input, fm, firewall });
}
