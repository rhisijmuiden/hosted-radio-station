import { Resolver } from 'node:dns/promises';
import { and, eq, isNull, lt, or } from 'drizzle-orm';
import { schema } from '../../db/index.js';
import type { DomainCheck } from '../../db/schema.js';
import type { AppContext } from '../../lib/context.js';
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

/** A name is fine when it is a CNAME to the platform host, or resolves to one of this server's addresses. */
export async function checkHost(host: string, target: { cname: string; ips: string[] }, r = resolver()): Promise<DomainCheck> {
  const cnames = await r.resolveCname(host).catch(() => [] as string[]);
  const want = target.cname.replace(/\.$/, '');
  if (cnames.length) {
    const found = cnames.map((c) => c.replace(/\.$/, '').toLowerCase());
    if (want && found.includes(want)) return { host, ok: true, found };
    // A CNAME chain via another name of ours is fine too, as long as it ends at our addresses.
  }
  const addrs = await addressesOf(r, host);
  const ours = new Set([...target.ips, ...(want ? await addressesOf(r, want) : [])]);
  const found = cnames.length ? cnames.map((c) => c.replace(/\.$/, '').toLowerCase()) : addrs;
  if (!addrs.length && !cnames.length) return { host, ok: false, found: [], error: 'not_found' };
  if (addrs.length && addrs.every((a) => ours.has(a))) return { host, ok: true, found };
  return { host, ok: false, found, error: ours.size ? 'wrong_target' : 'no_target' };
}

/** Where the encoder name must point when it is routed to a source node: the node's host name or addresses. */
async function nodeTarget(ctx: AppContext, nodeId: string) {
  const [node] = await ctx.db.select({ config: schema.nodes.config, status: schema.nodes.status }).from(schema.nodes).where(eq(schema.nodes.id, nodeId));
  if (!node) return null;
  const ips = [node.status.ip, ...(node.status.addresses ?? [])].filter((a): a is string => !!a);
  return { cname: node.config.publicHost ?? '', ips };
}

/** Checks both names of a domain and stores the result. */
export async function verifyDomain(ctx: AppContext, row: DomainRow) {
  const target = await dnsTarget(ctx);
  const ingestTarget = (row.ingestNodeId && (await nodeTarget(ctx, row.ingestNodeId))) || target;
  const checks = await Promise.all([checkHost(row.panelHost, target), checkHost(row.ingestHost, ingestTarget)]);
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
