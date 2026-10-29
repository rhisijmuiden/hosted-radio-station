import net from 'node:net';
import { createHmac } from 'node:crypto';
import type { AppContext } from '../../lib/context.js';
import { serves } from './dedication.js';
import { nodeHost, nodeSettings, type Node } from './plan.js';
import { OLD_PORTS } from './portplan.js';
import { internalAddress } from './ports.js';
import { stationRouting } from './routing-rules.js';

type IngestNode = Pick<Node, 'id' | 'name' | 'roles' | 'tenantId' | 'config' | 'status' | 'pairedAt'>;
type RoutedStation = { id: string; tenantId: string; nodeId: string | null; routing?: Record<string, unknown> | null; nodeRuntime?: { relays?: Record<string, { state: string; message?: string }> } | null };

/** Feature a node agent reports (hello) when its station software can send through an ingest (1.3). */
export const STUDIO_INGEST = 'studio-ingest';

/** How long a station node keeps feeding the relays itself after its pushes to the ingest failed, before it tries again. */
const FAILED_HOLD_MS = 10 * 60_000;
const failed = new Map<string, { until: number; message: string | null }>();

export interface StudioDelivery {
  /** The ingests the station node sends to, best first (priority 0 = main, 1 = backup). Empty = straight to the relays. */
  ingests: { node: IngestNode; priority: number }[];
  /**
   * Why the node feeds the relays itself: chosen so, its software cannot send through an ingest yet (update the node),
   * no ingest node can take the station, none is online, none can be reached safely from the node's site (no
   * certificate), or its pushes to the ingest failed (it tries again later).
   */
  direct: 'chosen' | 'update' | 'none' | 'offline' | 'nocert' | 'failing' | null;
  /** With "failing": what the node reported for its last push to the ingest. */
  error?: string | null;
}

/** The node feeds the relays itself although the station is routed through an ingest. */
export const directFallback = (d: StudioDelivery['direct']) => !!d && d !== 'chosen';

/**
 * The ingests a station on a station node is routed through, whether or not the node sends there right now: these
 * nodes take the station in their plan and accept its node, so they are ready the moment it starts sending (the node
 * fetches its package every few seconds, plans only follow on changes). Null when it goes straight to the relays.
 */
export function plannedIngests(s: RoutedStation, nodes: IngestNode[]): { node: IngestNode; priority: number }[] | null {
  const r = stationRouting(s);
  if (r.delivery === 'direct') return null;
  const usable = nodes.filter((n) => n.pairedAt && n.roles.includes('source') && n.id !== s.nodeId && serves(n, s));
  const picked =
    r.ingest === 'local'
      ? // Automatic: the customer's own ingest nodes first, then the platform's; online ones first, in a fixed order.
        [...usable].sort((a, b) => +!!b.status.online - +!!a.status.online || +(b.tenantId === s.tenantId) - +(a.tenantId === s.tenantId) || a.id.localeCompare(b.id)).slice(0, 1)
      : usable.filter((n) => n.id === r.ingest);
  if (r.backupIngest && r.backupIngest !== 'local') {
    const backup = usable.find((n) => n.id === r.backupIngest && !picked.some((p) => p.id === n.id));
    if (backup) picked.push(backup);
  }
  return picked.map((node, priority) => ({ node, priority }));
}

/**
 * How a station on a station node reaches its relays (1.3). By default through ingest nodes: the node uploads its
 * source streams once (to the main and the backup ingest), and the ingests make the other mounts and feed every relay.
 * The chosen ingests, or with "local" (automatic) one ingest node that may carry the station, online ones first; a
 * backup ingest only when one is chosen, since the node then uploads its streams twice. When none of them is online
 * the node feeds the relays itself until one is back, and the same while the node runs software from before 1.3 or its
 * pushes to the ingests fail.
 */
export function studioDelivery(s: RoutedStation, nodes: IngestNode[]): StudioDelivery {
  const planned = plannedIngests(s, nodes);
  if (!planned) return { ingests: [], direct: 'chosen' };
  // A node from before 1.3 does not send through an ingest: the relays would wait for an ingest that never gets audio.
  const studio = nodes.find((n) => n.id === s.nodeId);
  if (!studio?.status.features?.includes(STUDIO_INGEST)) return { ingests: [], direct: 'update' };
  if (!planned.length) return { ingests: [], direct: 'none' };
  if (!planned.some((i) => i.node.status.online)) return { ingests: [], direct: 'offline' };
  // Only ingests the node can reach safely: on its own site, or over TLS with a certificate the node can check.
  const reachable = planned.filter((i) => ingestTarget(i.node, studio));
  if (!reachable.length) return { ingests: [], direct: 'nocert' };
  // The node reports its pushes per ingest. When every one of them fails (wrong address, firewall), it feeds the relays
  // itself for a while instead of leaving them without audio, then tries the ingest again.
  const now = Date.now();
  const reports = planned.map((i) => s.nodeRuntime?.relays?.[i.node.id]);
  if (reports.every((x) => x?.state === 'error')) failed.set(s.id, { until: now + FAILED_HOLD_MS, message: reports.find((x) => x?.message)?.message ?? null });
  const hold = failed.get(s.id);
  if (hold && hold.until > now) return { ingests: [], direct: 'failing', error: hold.message };
  failed.delete(s.id);
  return { ingests: reachable, direct: null };
}

/** User name a station node signs in with on an ingest node (1.3); DJ accounts never use it. */
export const STUDIO_USER = 'hrs-studio';

/**
 * The password a station node sends its streams to an ingest node with: an HMAC of the station under the station
 * node's own secret. The ingest asks the orchestrator, which checks it like a DJ log-in.
 */
export function studioToken(ctx: AppContext, stationNode: Pick<Node, 'secret'>, stationId: string): string {
  const secret = stationNode.secret ? ctx.box.decrypt(stationNode.secret) : '';
  return createHmac('sha256', secret).update(`ingest:${stationId}`).digest('base64url');
}

/** Same rule as publicName() of the connection details: only such a name can carry a certificate encoders trust. */
const INTERNAL_TLDS = new Set(['loc', 'local', 'lan', 'home', 'internal', 'intranet', 'corp', 'localdomain', 'test', 'invalid', 'localhost', 'arpa']);
const certName = (h: string) => !!h && !net.isIP(h) && h.includes('.') && !INTERNAL_TLDS.has(h.slice(h.lastIndexOf('.') + 1).toLowerCase());

/** Private IPv4 address (RFC 1918). */
const privateV4 = (a: string) => net.isIPv4(a) && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a);
const net24 = (a: string) => a.split('.').slice(0, 3).join('.');

/**
 * The ingest's address on the local network when the station node sits on the same site: its private address in the
 * same /24 as one of the station node's, or (behind the same public address) its studio network address or first IPv4
 * address. Null from another site.
 */
function siteAddress(from: Pick<Node, 'status'>, n: Pick<Node, 'config' | 'status'>): string | null {
  const mine = new Set((from.status.addresses ?? []).filter(privateV4).map(net24));
  const near = (n.status.addresses ?? []).find((x) => privateV4(x) && mine.has(net24(x)));
  if (near) return nodeSettings(n).lanAddress || near;
  return from.status.ip && from.status.ip === n.status.ip ? internalAddress(n) : null;
}

/** Whether a node holds a valid certificate from an authority for this name, as it reports (1.3); also a wildcard. */
function hasCertificate(n: Pick<Node, 'status'>, name: string): boolean {
  const certs = n.status.certs;
  // Agents before 1.3 do not report their certificates: as before, a name that can carry one on a node with Caddy.
  if (!certs) return !!n.status.caddy && certName(name);
  const host = name.toLowerCase();
  return certs.some((c) => c === host || (c.startsWith('*.') && host.endsWith(c.slice(1)) && !host.slice(0, -c.length + 1).includes('.')));
}

/**
 * Where a station node sends its streams on an ingest node: its encoder port. From the same site the ingest's address on
 * that network, plain: routers seldom loop a connection to their own public address back inside. From elsewhere only
 * over checked TLS, to a name the ingest has a certificate for (Certificates through Cloudflare DNS, or its web server);
 * without one there is no safe route and the node keeps feeding the relays itself. While the ingest keeps its old
 * ports (port plan) the old port is used, which agents of every version listen on.
 */
export function ingestTarget(n: Pick<Node, 'config' | 'status'>, from?: Pick<Node, 'status'>): { host: string; port: number; tls: boolean } | null {
  const c = nodeSettings(n);
  const lan = from ? siteAddress(from, n) : null;
  if (lan && c.sourcePlainPort) return { host: lan, port: c.oldPorts ? OLD_PORTS.plain : c.sourcePlainPort, tls: false };
  const name = nodeHost(n);
  if (c.sourceTlsPort && name && hasCertificate(n, name)) return { host: name, port: c.oldPorts ? OLD_PORTS.tls : c.sourceTlsPort, tls: true };
  return null;
}
