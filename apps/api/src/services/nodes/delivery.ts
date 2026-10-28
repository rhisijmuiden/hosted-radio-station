import net from 'node:net';
import { createHmac } from 'node:crypto';
import type { AppContext } from '../../lib/context.js';
import { serves } from './dedication.js';
import { nodeHost, nodeSettings, type Node } from './plan.js';
import { OLD_PORTS } from './portplan.js';
import { stationRouting } from './routing-rules.js';

type IngestNode = Pick<Node, 'id' | 'name' | 'roles' | 'tenantId' | 'config' | 'status' | 'pairedAt'>;
type RoutedStation = { id: string; tenantId: string; nodeId: string | null; routing?: Record<string, unknown> | null };

export interface StudioDelivery {
  /** The ingests the station node sends to, best first (priority 0 = main, 1 = backup). Empty = straight to the relays. */
  ingests: { node: IngestNode; priority: number }[];
  /** Why the node feeds the relays itself: chosen so, no ingest node can take the station, or none is online. */
  direct: 'chosen' | 'none' | 'offline' | null;
}

/**
 * How a station on a station node reaches its relays (1.3). By default through ingest nodes: the node uploads its
 * source streams once (to the main and the backup ingest), and the ingests make the other mounts and feed every relay.
 * The chosen ingests, or with "local" (automatic) one ingest node that may carry the station, online ones first; a
 * backup ingest only when one is chosen, since the node then uploads its streams twice. When none of them is online
 * the node feeds the relays itself until one is back.
 */
export function studioDelivery(s: RoutedStation, nodes: IngestNode[]): StudioDelivery {
  const r = stationRouting(s);
  if (r.delivery === 'direct') return { ingests: [], direct: 'chosen' };
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
  if (!picked.length) return { ingests: [], direct: 'none' };
  if (!picked.some((n) => n.status.online)) return { ingests: [], direct: 'offline' };
  return { ingests: picked.map((node, priority) => ({ node, priority })), direct: null };
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

/**
 * Where a station node sends its streams on an ingest node: its encoder port, with TLS when the ingest has a name with
 * a certificate. While the ingest keeps its old ports (port plan) the old port is used, which agents of every version
 * listen on.
 */
export function ingestTarget(n: Pick<Node, 'config' | 'status'>): { host: string; port: number; tls: boolean } | null {
  const c = nodeSettings(n);
  const name = nodeHost(n);
  const host = name || n.status.ip;
  if (!host) return null;
  if (c.sourceTlsPort && n.status.caddy && certName(name)) return { host: name, port: c.oldPorts ? OLD_PORTS.tls : c.sourceTlsPort, tls: true };
  if (c.sourcePlainPort) return { host, port: c.oldPorts ? OLD_PORTS.plain : c.sourcePlainPort, tls: false };
  return null;
}
