import type { NodeConfig, NodeStatus } from '../../db/schema.js';
import type { AppContext } from '../../lib/context.js';
import { isPublicAddress } from '../dns/records.js';
import { nodeHost, nodeSettings, type Node } from './plan.js';
import { inboundPorts } from './ports.js';
import type { NodePlan } from './protocol.js';

/** The stored settings of a new node: its firewall is decided at its first connection (see firewallDefault). */
export const NEW_NODE_FIREWALL = { firewall: { auto: true } } as const;

/**
 * The firewall default (security hardening for external nodes, step 4), once per node (new nodes, and nodes from before it whose firewall was not switched on by hand): on for a node with a
 * public address on its own interface (a server in a data centre), off for a node behind a router. Returns the new
 * stored settings, or null when there is nothing to decide (yet): the node's software has no firewall, or it was
 * decided before.
 */
export function firewallDefault(config: NodeConfig, status: Pick<NodeStatus, 'addresses' | 'features'>): { config: NodeConfig; enabled: boolean } | null {
  if (!config.firewall?.auto || !status.features?.includes('firewall')) return null;
  const enabled = (status.addresses ?? []).some((a) => isPublicAddress(a));
  return { config: { ...config, firewall: { ...config.firewall, enabled, auto: false } }, enabled };
}

const range = (port: number, to?: number | null) => (to && to > port ? `${port}-${to}` : String(port));

/**
 * The firewall a node sets for itself (security hardening for external nodes): the incoming ports of its roles from
 * the port plan (the same list the outside port check tries), port 80 for certificates behind its own web server, and
 * the extra ports set for the node. SSH is added on the node itself, from the port sshd listens on. Connections the
 * node opens itself (to this server, relays and ingests) need nothing: their replies are let in.
 */
export async function firewallPlan(ctx: AppContext, node: Node): Promise<NonNullable<NodePlan['firewall']>> {
  const c = nodeSettings(node).firewall;
  if (!c.enabled) return { enabled: false, takeOver: false, tcp: [], udp: [], sshFrom: [], sshLimit: true };
  return { enabled: true, takeOver: c.takeOver, ...(await allowedPorts(ctx, node)), sshFrom: c.sshFrom, sshLimit: c.sshLimit };
}

/** The ports the node's firewall lets in besides SSH, whether or not it is on: "8200" or "8210-8299". */
export async function allowedPorts(ctx: AppContext, node: Node) {
  const c = nodeSettings(node).firewall;
  const tcp = new Set<string>();
  const udp = new Set<string>();
  for (const p of await inboundPorts(ctx, node)) tcp.add(range(p.port, p.to));
  // Let's Encrypt checks a name over port 80 (HTTP-01), and plain HTTP is sent on to HTTPS there.
  if (node.status.caddy && nodeHost(node)) tcp.add('80');
  for (const p of c.extraPorts) (p.proto === 'udp' ? udp : tcp).add(range(p.port, p.to));
  const order = (a: string, b: string) => parseInt(a, 10) - parseInt(b, 10);
  return { tcp: [...tcp].sort(order), udp: [...udp].sort(order) };
}

/** Whether a port lies in one of the ranges ("8200" or "8210-8299"). */
export function inRanges(port: number, ranges: string[]) {
  return ranges.some((r) => {
    const [a, b] = r.split('-').map(Number);
    return port >= a! && port <= (b ?? a!);
  });
}
