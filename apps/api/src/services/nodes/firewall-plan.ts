import type { AppContext } from '../../lib/context.js';
import { nodeHost, nodeSettings, type Node } from './plan.js';
import { inboundPorts } from './ports.js';
import type { NodePlan } from './protocol.js';

const range = (port: number, to?: number | null) => (to && to > port ? `${port}-${to}` : String(port));

/**
 * The firewall a node sets for itself (security hardening for external nodes): the incoming ports of its roles from
 * the port plan (the same list the outside port check tries), port 80 for certificates behind its own web server, and
 * the extra ports set for the node. SSH is added on the node itself, from the port sshd listens on. Connections the
 * node opens itself (to this server, relays and ingests) need nothing: their replies are let in.
 */
export async function firewallPlan(ctx: AppContext, node: Node): Promise<NonNullable<NodePlan['firewall']>> {
  const c = nodeSettings(node).firewall;
  if (!c.enabled) return { enabled: false, takeOver: false, tcp: [], udp: [] };
  const tcp = new Set<string>();
  const udp = new Set<string>();
  for (const p of await inboundPorts(ctx, node)) tcp.add(range(p.port, p.to));
  // Let's Encrypt checks a name over port 80 (HTTP-01), and plain HTTP is sent on to HTTPS there.
  if (node.status.caddy && nodeHost(node)) tcp.add('80');
  for (const p of c.extraPorts) (p.proto === 'udp' ? udp : tcp).add(range(p.port, p.to));
  const order = (a: string, b: string) => parseInt(a, 10) - parseInt(b, 10);
  return { enabled: true, takeOver: c.takeOver, tcp: [...tcp].sort(order), udp: [...udp].sort(order) };
}
