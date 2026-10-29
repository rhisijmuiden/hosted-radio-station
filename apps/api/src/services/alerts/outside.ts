import { promises as dns } from 'node:dns';
import { isNotNull } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { schema } from '../../db/index.js';
import type { AppContext } from '../../lib/context.js';
import { isCloudflareAddress } from '../../lib/cloudflare-ips.js';
import { checkFirewall, portMonitor } from '../nodes/firewall.js';
import type { NodeHub } from '../nodes/hub.js';
import { externalAddress, inboundPorts } from '../nodes/ports.js';
import { getSetting, type DnsState } from '../settings.js';

/** How often the monitoring node tries the ports of every node, and how often the public DNS is looked at. */
const FIREWALL_MS = 10 * 60_000;
const DNS_MS = 5 * 60_000;
/** A port result older than this says nothing any more (the monitoring node went away). */
const FIREWALL_STALE_MS = 35 * 60_000;
/** A name only counts as wrong once it has been wrong this long: DNS takes a while to follow a change (TTL). */
const DNS_WRONG_MS = 15 * 60_000;
const MAX_NAMES = 300;

export interface DnsResolver {
  resolve4(name: string): Promise<string[]>;
  resolve6(name: string): Promise<string[]>;
  resolveCname(name: string): Promise<string[]>;
}

/** Public resolvers, so what this server's own resolver remembers does not count: what the world sees does. */
function publicResolver(): DnsResolver {
  const r = new dns.Resolver({ timeout: 3000, tries: 2 });
  r.setServers(['1.1.1.1', '8.8.8.8']);
  return r;
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

/**
 * What a name in public DNS should resolve to, from the records the platform wants and that are in the zone. Returns
 * null when it does, else what is wrong.
 */
export async function checkName(r: DnsResolver, name: string, records: DnsState['records']): Promise<string | null> {
  const lookup = async (f: () => Promise<string[]>) => {
    try {
      return await f();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENODATA' || code === 'ENOTFOUND') return [];
      throw err;
    }
  };
  const cname = records.find((x) => x.type === 'CNAME');
  if (cname && !cname.proxied) {
    const got = (await lookup(() => r.resolveCname(name))).map((x) => x.toLowerCase().replace(/\.$/, ''));
    return got.includes(cname.content.toLowerCase()) ? null : got.length ? `points to ${got[0]} instead of ${cname.content}` : 'not found in public DNS';
  }
  for (const type of ['A', 'AAAA'] as const) {
    const want = records.filter((x) => x.type === type || (cname && type === 'A'));
    if (!want.length) continue;
    const got = await lookup(() => (type === 'A' ? r.resolve4(name) : r.resolve6(name)));
    if (!got.length) return 'not found in public DNS';
    // Through the Cloudflare proxy (orange cloud) the name shows Cloudflare's addresses, not the server's.
    if (want.some((x) => x.proxied)) {
      if (!got.every(isCloudflareAddress)) return `resolves to ${got.join(', ')}, not through the Cloudflare proxy`;
      continue;
    }
    const expected = [...new Set(want.map((x) => x.content))];
    if (!sameSet([...new Set(got)], expected)) return `resolves to ${got.join(', ')} instead of ${expected.join(', ')}`;
  }
  return null;
}

/**
 * The checks from outside for the alerts (phase 20, step 3), slower than the alert rounds: a monitoring node tries the
 * ports of every node every 10 minutes, and the names the Cloudflare sync made are looked up in public DNS every 5.
 */
export class OutsideChecks {
  private busy = false;
  private firewallAt = 0;
  private dnsAt = 0;
  private ports = new Map<string, { closed: string[]; oldOpen: number[]; at: number }>();
  private names = new Map<string, { wrongSince: number; message: string }>();

  constructor(
    private readonly ctx: AppContext,
    private readonly hub: NodeHub,
    private readonly log: FastifyBaseLogger,
    private readonly resolver: DnsResolver = publicResolver(),
  ) {}

  /** Starts what is due, in the background; a round never waits for it. */
  due(now = Date.now()) {
    if (this.busy) return;
    const firewall = now - this.firewallAt >= FIREWALL_MS;
    const names = now - this.dnsAt >= DNS_MS;
    if (!firewall && !names) return;
    this.busy = true;
    void (async () => {
      if (firewall) {
        this.firewallAt = now;
        await this.firewall(now).catch((err) => this.log.warn({ err }, 'port checks from outside failed'));
      }
      if (names) {
        this.dnsAt = now;
        await this.dns(now).catch((err) => this.log.warn({ err }, 'public DNS check failed'));
      }
    })().finally(() => {
      this.busy = false;
    });
  }

  /** Runs both checks now and waits for them (tests). */
  async runNow(now = Date.now()) {
    await this.firewall(now);
    await this.dns(now);
  }

  async firewall(now = Date.now()) {
    if (!(await portMonitor(this.ctx, this.hub))) return;
    const [nodes, rollout] = await Promise.all([this.ctx.db.select().from(schema.nodes).where(isNotNull(schema.nodes.pairedAt)), getSetting(this.ctx, 'nodeRollout')]);
    for (const row of nodes) {
      if (!this.hub.isOnline(row.id) || row.roles.every((r) => r === 'monitor')) continue;
      // A node being updated restarts its services and opens and closes ports for a moment: what is seen then says
      // nothing. Its last result before the update stays until the next round after it.
      if (rollout.current?.nodeId === row.id) continue;
      const node = { ...row, status: this.hub.liveStatus(row.id) ?? row.status };
      if (!externalAddress(node) || !(await inboundPorts(this.ctx, node)).length) continue;
      const check = await checkFirewall(this.ctx, this.hub, node, { monitorOnly: true });
      if (check) this.ports.set(row.id, { closed: check.closed, oldOpen: check.oldOpen, at: now });
    }
  }

  async dns(now = Date.now()) {
    const state = await getSetting(this.ctx, 'dnsState');
    if (state.mode !== 'on') {
      this.names.clear();
      return;
    }
    const byName = new Map<string, DnsState['records']>();
    for (const r of state.records) byName.set(r.name, [...(byName.get(r.name) ?? []), r]);
    const seen = new Set<string>();
    for (const [name, records] of [...byName].slice(0, MAX_NAMES)) {
      // Not in the zone yet: the sync itself reports that.
      if (records.some((r) => r.state !== 'ok')) continue;
      seen.add(name);
      let message: string | null;
      try {
        message = await checkName(this.resolver, name, records);
      } catch {
        // The resolvers themselves did not answer: no verdict this time.
        continue;
      }
      if (!message) this.names.delete(name);
      else this.names.set(name, { wrongSince: this.names.get(name)?.wrongSince ?? now, message });
    }
    for (const name of [...this.names.keys()]) if (!seen.has(name)) this.names.delete(name);
  }

  /** For the rules: the last port results per node that are still fresh. */
  firewallResults(now = Date.now()) {
    return [...this.ports].filter(([, p]) => now - p.at < FIREWALL_STALE_MS).map(([nodeId, p]) => ({ nodeId, closed: p.closed, oldOpen: p.oldOpen }));
  }

  /** For the rules: names that have been wrong in public DNS long enough. */
  dnsResults(now = Date.now()) {
    return [...this.names].filter(([, n]) => now - n.wrongSince >= DNS_WRONG_MS).map(([name, n]) => ({ name, message: n.message }));
  }
}
