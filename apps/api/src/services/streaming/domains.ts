import { Resolver } from 'node:dns/promises';
import { and, eq, isNull, lt, or } from 'drizzle-orm';
import { schema } from '../../db/index.js';
import type { DomainCheck } from '../../db/schema.js';
import type { AppContext } from '../../lib/context.js';
import { targetsOf } from '../dns/config.js';
import { nodeHost } from '../nodes/plan.js';
import { getSetting } from '../settings.js';

type DomainRow = typeof schema.tenantDomains.$inferSelect;

export const hostRe = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** What customers point their names at: a CNAME target, and the addresses that count as "this server". */
export async function dnsTarget(ctx: AppContext) {
  const [proxy, streaming] = await Promise.all([getSetting(ctx, 'proxy'), getSetting(ctx, 'streaming')]);
  const cname = streaming.cnameTarget || proxy.domain || '';
  return { cname, ips: streaming.publicIps };
}

function resolver() {
  const r = new Resolver({ timeout: 4000, tries: 2 });
  return r;
}

async function addressesOf(r: Resolver, host: string) {
  const [v4, v6] = await Promise.all([r.resolve4(host).catch(() => [] as string[]), r.resolve6(host).catch(() => [] as string[])]);
  return [...v4, ...v6];
}

/** Cloudflare's proxy ranges (IPv4): a name that resolves here has the orange cloud on, which hides the real target. */
const CLOUDFLARE_V4 = ['173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22'];
const v4num = (ip: string) => ip.split('.').reduce((n, p) => n * 256 + Number(p), 0);
export function isCloudflareAddress(ip: string) {
  if (ip.includes(':')) return /^(2400:cb00|2606:4700|2803:f800|2405:b500|2405:8100|2a06:98c0|2a06:98c1|2c0f:f248):/i.test(ip);
  const n = v4num(ip);
  return CLOUDFLARE_V4.some((c) => {
    const [net, bits] = c.split('/') as [string, string];
    const size = 2 ** (32 - Number(bits));
    const start = v4num(net);
    return n >= start && n < start + size;
  });
}

export interface HostTarget {
  /** The CNAME target the record should have. */
  cname: string;
  /** Addresses that count as ours, for an A/AAAA record (or a CNAME chain that ends here). */
  ips: string[];
  /** Older targets that still work, e.g. the shared target from before Cloudflare DNS (phase 15). */
  accept?: string[];
  /** A CNAME is wanted: an A record works, but gets a warning because it does not follow changes. */
  preferCname?: boolean;
}

const bare = (h: string) => h.replace(/\.$/, '').toLowerCase();

/**
 * A name is fine when it is a CNAME to the platform host, or resolves to one of this server's addresses. With a
 * per-customer target (Cloudflare DNS) an older target or an A record still works, with a warning.
 */
export async function checkHost(host: string, target: HostTarget, r = resolver()): Promise<DomainCheck> {
  const cnames = (await r.resolveCname(host).catch(() => [] as string[])).map(bare);
  const want = bare(target.cname);
  const expected = want || undefined;
  if (cnames.length) {
    if (want && cnames.includes(want)) return { host, ok: true, found: cnames, expected };
    if (target.accept?.some((a) => a && cnames.includes(bare(a)))) return { host, ok: true, found: cnames, expected, warning: target.preferCname ? 'old_target' : undefined };
    // A CNAME chain via another name of ours is fine too, as long as it ends at our addresses.
  }
  const addrs = await addressesOf(r, host);
  const ours = new Set([...target.ips, ...(want ? await addressesOf(r, want) : []), ...(await Promise.all((target.accept ?? []).filter(Boolean).map((a) => addressesOf(r, a)))).flat()]);
  const found = cnames.length ? cnames : addrs;
  if (!addrs.length && !cnames.length) return { host, ok: false, found: [], error: 'not_found', expected };
  if (addrs.length && addrs.every((a) => ours.has(a))) return { host, ok: true, found, expected, warning: target.preferCname && !cnames.length ? 'a_record' : undefined };
  if (addrs.length && addrs.every(isCloudflareAddress)) return { host, ok: false, found, error: 'proxied', expected };
  return { host, ok: false, found, error: ours.size ? 'wrong_target' : 'no_target', expected };
}

/** Where the encoder name must point when it is routed to a source node: the node's host name or addresses. */
async function nodeTarget(ctx: AppContext, nodeId: string) {
  const [node] = await ctx.db.select({ config: schema.nodes.config, status: schema.nodes.status }).from(schema.nodes).where(eq(schema.nodes.id, nodeId));
  if (!node) return null;
  const ips = [node.config.publicAddress, node.status.ip, ...(node.status.addresses ?? [])].filter((a): a is string => !!a);
  return { cname: nodeHost(node), ips };
}

/** Checks both names of a domain and stores the result. */
export async function verifyDomain(ctx: AppContext, row: DomainRow) {
  const target = await dnsTarget(ctx);
  const nodeT = row.ingestNodeId ? await nodeTarget(ctx, row.ingestNodeId) : null;
  const ingestTarget: HostTarget = nodeT || target;
  let panel: HostTarget = target;
  let ingest = ingestTarget;
  // Cloudflare DNS (phase 15): the customer's own targets; the shared target and A records keep working.
  const targets = await targetsOf(ctx, row.targetLabel);
  if (targets) {
    const origin = (await getSetting(ctx, 'dnsState')).origin.addresses;
    panel = { cname: targets.panel, ips: [...target.ips, ...origin], accept: [target.cname], preferCname: true };
    ingest = { cname: targets.ingest, ips: [...ingestTarget.ips, ...(nodeT ? [] : origin)], accept: [ingestTarget.cname], preferCname: true };
  }
  const checks = await Promise.all([checkHost(row.panelHost, panel), checkHost(row.ingestHost, ingest)]);
  const ok = checks.every((c) => c.ok);
  let status: DomainRow['status'];
  if (row.verifiedManually || ok) status = 'verified';
  else if (!row.verifiedAt && checks.some((c) => c.error === 'not_found')) status = 'pending';
  else status = 'failed';
  const [updated] = await ctx.db
    .update(schema.tenantDomains)
    .set({ checks, checkedAt: new Date(), status, verifiedAt: status === 'verified' ? (row.verifiedAt ?? new Date()) : null })
    .where(eq(schema.tenantDomains.id, row.id))
    .returning();
  return { domain: updated!, changed: updated!.status !== row.status };
}

/**
 * Rechecks names that are not verified yet every five minutes during their first week (then every six hours), and
 * verified ones every six hours. Returns true when a status changed.
 */
export async function recheckDomains(ctx: AppContext) {
  const now = Date.now();
  const rows = await ctx.db
    .select()
    .from(schema.tenantDomains)
    .where(or(isNull(schema.tenantDomains.checkedAt), lt(schema.tenantDomains.checkedAt, new Date(now - 5 * 60_000))));
  let changed = false;
  for (const row of rows) {
    const young = row.createdAt.getTime() > now - 7 * 86400_000;
    const due = !row.checkedAt || row.checkedAt.getTime() < now - (row.status !== 'verified' && young ? 5 * 60_000 : 6 * 3600_000);
    if (due) changed = (await verifyDomain(ctx, row)).changed || changed;
  }
  return changed;
}

/** For Caddy's on-demand TLS: only names of verified domains of active customers (and the platform's own) get a certificate. */
export async function hostAllowed(ctx: AppContext, host: string) {
  host = host.toLowerCase().replace(/\.$/, '');
  if (!hostRe.test(host)) return false;
  const proxy = await getSetting(ctx, 'proxy');
  if (proxy.domain && host === proxy.domain) return true;
  const [row] = await ctx.db
    .select({ id: schema.tenantDomains.id })
    .from(schema.tenantDomains)
    .innerJoin(schema.tenants, eq(schema.tenants.id, schema.tenantDomains.tenantId))
    .where(
      and(
        or(eq(schema.tenantDomains.panelHost, host), eq(schema.tenantDomains.ingestHost, host)),
        eq(schema.tenantDomains.status, 'verified'),
        eq(schema.tenants.active, true),
      ),
    );
  return !!row;
}
