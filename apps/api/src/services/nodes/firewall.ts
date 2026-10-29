import net from 'node:net';
import { and, isNotNull, isNull } from 'drizzle-orm';
import { schema } from '../../db/index.js';
import type { AppContext } from '../../lib/context.js';
import { nodeAddresses } from '../dns/records.js';
import type { NodeHub } from './hub.js';
import { scopeOf } from './dedication.js';
import { buildPlan, nodeSettings, type Node } from './plan.js';
import { allowedPorts, inRanges } from './firewall-plan.js';
import { checkTarget, externalAddress, inboundPorts, probePort, type InboundPort } from './ports.js';

/**
 * Ports that often belong to something that should not be reachable from the internet (mail, databases, admin pages,
 * file shares, development servers). The outside check tries them too: one that answers while the node does not need
 * it is reported as unexpectedly open (security hardening for external nodes).
 */
export const UNEXPECTED_PORTS = [21, 23, 25, 53, 110, 111, 135, 139, 143, 445, 1433, 2049, 3000, 3306, 3389, 5000, 5432, 5900, 6379, 8000, 8006, 8080, 8443, 8888, 9000, 9090, 9200, 11211, 27017];

export interface PortCheck {
  ok: boolean;
  message: string | null;
  ms: number | null;
  at: string;
}

/** The last check from outside of a node's ports (phase 19, from a monitoring node since phase 20). */
export interface FirewallCheck {
  at: string;
  /** Who tried the ports: a monitoring node (really outside) or this server. */
  from: { kind: 'monitor'; nodeId: string; name: string } | { kind: 'server' };
  /** How the node's name resolved: ok, only in public DNS (this server still remembers it missing), or not at all. */
  dns: { host: string; state: 'ok' | 'stale' | 'missing'; checkedOn: string } | null;
  /** Per port ("port" or "port-to"). */
  checks: Record<string, PortCheck>;
  /** Ports from before the port plan that still answer while the node has its old ports switched off. */
  oldOpen: number[];
  /** Ports the node needs that cannot be reached ("port" or "port-to"; an idle push port is fine). */
  closed: string[];
  /** SSH, per port: let in by the node's own firewall (the port sshd listens on, else 22). */
  ssh: Record<string, PortCheck>;
  /** Well-known ports the node does not need that still answer (UNEXPECTED_PORTS): close them. */
  unexpected: number[];
}

export const portKey = (p: Pick<InboundPort, 'port' | 'to'>) => (p.to ? `${p.port}-${p.to}` : String(p.port));

/** Kept in memory: a check is quick to run again, and the monitoring node repeats it every few minutes. */
const last = new Map<string, FirewallCheck>();

export const lastFirewallCheck = (nodeId: string) => last.get(nodeId) ?? null;

/** The shared monitoring node that can try ports now, other than the node itself. */
export async function portMonitor(ctx: AppContext, hub: NodeHub | null, except?: string) {
  if (!hub) return null;
  const rows = await ctx.db
    .select({ id: schema.nodes.id, name: schema.nodes.name, roles: schema.nodes.roles, config: schema.nodes.config })
    .from(schema.nodes)
    .where(and(isNotNull(schema.nodes.pairedAt), isNull(schema.nodes.tenantId)));
  return rows.find((n) => n.id !== except && n.roles.includes('monitor') && scopeOf({ ...n, tenantId: null }).kind === 'shared' && hub.isOnline(n.id) && hub.canCheckPorts(n.id)) ?? null;
}

/**
 * Tries every port the node needs open from outside: through a monitoring node when one is online (it sits outside the
 * node's network, like a listener or encoder), else from this server. The old ports are tried too while they are
 * switched off for the node: one that still answers should be closed in the firewall.
 */
export async function checkFirewall(ctx: AppContext, hub: NodeHub | null, node: Node, opts: { monitorOnly?: boolean } = {}): Promise<FirewallCheck | null> {
  const host = externalAddress(node);
  if (!host) return null;
  const ports = await inboundPorts(ctx, node);
  const old = nodeSettings(node).oldPorts ? [] : (await inboundPorts(ctx, { ...node, config: { ...node.config, oldPorts: true } as Node['config'] })).filter((p) => p.old).map((p) => p.port);
  const at = new Date().toISOString();
  // A relay only listens on its push port while an ingest or station node pushes a stream to it.
  const pushing = ports.some((p) => p.service === 'push') && !!(await buildPlan(ctx, node)).relay?.mounts.some((m) => m.push);
  const ssh = (node.status.firewall?.ports?.ssh ?? ['22']).map(Number).filter((p) => Number.isInteger(p) && p > 0 && p < 65536).slice(0, 5);
  const allowed = await allowedPorts(ctx, node);
  const extra = UNEXPECTED_PORTS.filter((port) => !ssh.includes(port) && !old.includes(port) && !inRanges(port, allowed.tcp) && !ports.some((p) => port >= p.port && port <= (p.to ?? p.port)));
  const wanted = [...new Set([...ports.map((p) => p.port), ...old, ...ssh, ...extra])];

  let from: FirewallCheck['from'] = { kind: 'server' };
  let dns: FirewallCheck['dns'];
  let results = new Map<number, Omit<PortCheck, 'at'>>();
  const monitor = await portMonitor(ctx, hub, node.id);
  const remote = monitor ? await hub!.portCheck(monitor.id, host, wanted) : null;
  if (monitor && remote) {
    from = { kind: 'monitor', nodeId: monitor.id, name: monitor.name };
    dns = net.isIP(host) ? null : { host, state: remote.address ? 'ok' : 'missing', checkedOn: remote.address ?? host };
    results = new Map(remote.results.map((r) => [r.port, r]));
  } else if (opts.monitorOnly) {
    return null;
  } else {
    const target = await checkTarget(host, nodeAddresses({ publicAddress: nodeSettings(node).publicAddress, ip: node.status.ip ?? null, addresses: node.status.addresses ?? [] }));
    dns = target.dns ? { host, state: target.dns, checkedOn: target.address } : null;
    results = new Map(await Promise.all(wanted.map(async (port) => [port, await probePort(target.address, port)] as const)));
  }
  const checks: Record<string, PortCheck> = {};
  for (const p of ports) {
    const r = results.get(p.port) ?? { ok: false, message: 'timeout', ms: null };
    // FTP passive ports only listen during a transfer, so a closed one is no fault; only a filtered one (timeout) is.
    const idle = !r.ok && r.message === 'refused' && ((p.service === 'push' && !pushing) || p.service === 'ftpPassive');
    checks[portKey(p)] = { ok: r.ok, message: idle ? 'idle' : r.message, ms: r.ms, at };
  }
  // The FTP passive ports only matter when FTP itself can be reached from outside: otherwise nobody uses FTP there.
  const ftpReachable = ports.some((p) => p.service === 'ftp' && checks[portKey(p)]?.ok);
  const closed = ports
    .filter((p) => {
      const c = checks[portKey(p)]!;
      return !c.ok && c.message !== 'idle' && (p.service !== 'ftpPassive' || ftpReachable);
    })
    .map(portKey);
  const sshChecks: Record<string, PortCheck> = {};
  for (const port of ssh) {
    const r = results.get(port) ?? { ok: false, message: 'timeout', ms: null };
    sshChecks[String(port)] = { ok: r.ok, message: r.message, ms: r.ms, at };
  }
  const unexpected = extra.filter((port) => results.get(port)?.ok);
  const check: FirewallCheck = { at, from, dns, checks, oldOpen: old.filter((port) => results.get(port)?.ok), closed, ssh: sshChecks, unexpected };
  last.set(node.id, check);
  return check;
}
