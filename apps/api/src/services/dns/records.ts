import net from 'node:net';
import type { CloudflareSettings, DnsState } from '../settings.js';
import type { CfRecord, CfRecordInput } from './cloudflare.js';

export type Purpose = DnsState['records'][number]['purpose'];

/** A record the platform wants in the zone. `key` goes into the record's comment, so the manager knows it is its own. */
export interface DesiredRecord extends CfRecordInput {
  key: string;
  purpose: Purpose;
  /** The node or customer domain it belongs to. */
  ref: string | null;
}

export interface DnsProblem {
  kind: 'noOriginAddress' | 'noAddress' | 'nameTaken' | 'conflict';
  ref: string | null;
  name: string | null;
}

export interface DnsNode {
  id: string;
  name: string;
  /** Slug of the customer that owns the node; null = a node of the platform. */
  tenantSlug: string | null;
  roles: string[];
  online: boolean;
  /** An update is coming or running: no new listeners. */
  draining: boolean;
  dnsName: string;
  dnsRecord: boolean;
  publicAddress: string;
  /** Address it connects from, and the addresses of its interfaces. */
  ip: string | null;
  addresses: string[];
}

export interface DnsDomain {
  id: string;
  tenantSlug: string;
  targetLabel: string | null;
  ingestNodeId: string | null;
}

export interface DnsInputs {
  /** The platform domain, e.g. onlineradio.rhis.nl. */
  base: string;
  settings: CloudflareSettings;
  /** This server's public addresses. */
  origin: string[];
  nodes: DnsNode[];
  domains: DnsDomain[];
}

/** Private, loopback, link-local, CGNAT and documentation ranges: not reachable from the internet. */
export function isPublicAddress(ip: string) {
  const v = net.isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    if (a === 10 || a === 127 || a === 0 || a >= 224) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 169 && b === 254) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 192 && b === 0 && ip.startsWith('192.0.2.')) return false;
    return true;
  }
  if (v === 6) {
    const x = ip.toLowerCase();
    if (x === '::1' || x === '::' || x.startsWith('fe8') || x.startsWith('fe9') || x.startsWith('fea') || x.startsWith('feb')) return false;
    if (x.startsWith('fc') || x.startsWith('fd') || x.startsWith('2001:db8:')) return false;
    if (x.startsWith('::ffff:')) return isPublicAddress(x.slice(7));
    return true;
  }
  return false;
}

const typeOf = (ip: string) => (net.isIP(ip) === 6 ? 'AAAA' : 'A');

/** "Relay Amsterdam 1" → "relay-amsterdam-1". */
export function labelOf(name: string) {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/, '');
}

/** The public addresses of a node: the one set by hand, else a public address it connects from or has on an interface. */
export function nodeAddresses(n: Pick<DnsNode, 'publicAddress' | 'ip' | 'addresses'>) {
  if (n.publicAddress) return [n.publicAddress];
  const seen = n.ip?.replace(/^::ffff:/, '') ?? null;
  const out: string[] = [];
  if (seen && isPublicAddress(seen)) out.push(seen);
  // An IPv6 address on an interface is usually reachable as it is (no NAT); IPv4 only counts when it is the one we see.
  for (const a of n.addresses) if (net.isIP(a) === 6 && isPublicAddress(a) && !out.includes(a)) out.push(a);
  if (!out.some((a) => net.isIP(a) === 4)) {
    const v4 = n.addresses.find((a) => net.isIP(a) === 4 && isPublicAddress(a));
    if (v4) out.unshift(v4);
  }
  return out;
}

/** The platform name of a node: relay1.<domain>, or <customer>-studio.node.<domain> for a node of a customer. */
export function nodeFqdn(n: Pick<DnsNode, 'dnsName' | 'name' | 'tenantSlug'>, base: string, s: Pick<CloudflareSettings, 'nodeLabel'>) {
  const label = n.dnsName || labelOf(n.name);
  if (!label) return null;
  if (!n.tenantSlug) return `${label}.${base}`;
  const full = labelOf(`${n.tenantSlug}-${label}`);
  return `${full}.${s.nodeLabel}.${base}`;
}

/** The names a customer domain points at: <label>.stream.<domain> and <label>.src.<domain>. */
export function domainTargets(label: string, base: string, s: Pick<CloudflareSettings, 'streamLabel' | 'srcLabel'>) {
  return { panel: `${label}.${s.streamLabel}.${base}`, ingest: `${label}.${s.srcLabel}.${base}` };
}

/** Everything the platform wants in its zone, and what is in the way. Pure: the manager supplies the facts. */
export function desiredRecords(input: DnsInputs): { records: DesiredRecord[]; problems: DnsProblem[] } {
  const { base, settings: s } = input;
  const ttl = s.ttl;
  const records: DesiredRecord[] = [];
  const problems: DnsProblem[] = [];
  const add = (key: string, name: string, type: string, content: string, purpose: Purpose, ref: string | null, proxied = false) =>
    records.push({ key, name, type, content, proxied, ttl: proxied ? 1 : ttl, comment: null, purpose, ref });

  const origin = [...new Set(input.origin)];
  const originName = `${s.originLabel}.${base}`;
  if (!origin.length) problems.push({ kind: 'noOriginAddress', ref: null, name: originName });
  for (const ip of origin) add(`origin:${ip}`, originName, typeOf(ip), ip, 'origin', null);
  if (s.panelRecord.manage) for (const ip of origin) add(`panel:${ip}`, base, typeOf(ip), ip, 'panel', null, s.panelRecord.proxied);

  // Names of the platform itself; a node cannot take one of them.
  const reserved = new Set([originName, `${s.poolLabel}.${base}`, `${s.streamLabel}.${base}`, `${s.srcLabel}.${base}`, `${s.nodeLabel}.${base}`, base]);
  const nodeName = new Map<string, string>();
  if (s.nodeRecords) {
    for (const n of input.nodes) {
      if (!n.dnsRecord) continue;
      const fqdn = nodeFqdn(n, base, s);
      if (!fqdn || reserved.has(fqdn)) {
        problems.push({ kind: 'nameTaken', ref: n.id, name: fqdn });
        continue;
      }
      const addrs = nodeAddresses(n);
      if (!addrs.length) {
        problems.push({ kind: 'noAddress', ref: n.id, name: fqdn });
        continue;
      }
      reserved.add(fqdn);
      nodeName.set(n.id, fqdn);
      for (const ip of addrs) add(`node:${n.id}:${ip}`, fqdn, typeOf(ip), ip, 'node', n.id);
    }
  }

  // The pool: relays of the platform that are online and not being updated. Without any, this server answers (it
  // sends listeners on to a relay as soon as one is back).
  if (s.poolLabel) {
    const healthy = input.nodes.filter((n) => !n.tenantSlug && n.roles.includes('relay') && n.online && !n.draining);
    const ips = [...new Set(healthy.flatMap((n) => nodeAddresses(n)))];
    for (const ip of ips.length ? ips : origin) add(`pool:${ip}`, `${s.poolLabel}.${base}`, typeOf(ip), ip, 'pool', null);
  }

  if (s.customerTargets) {
    for (const d of input.domains) {
      if (!d.targetLabel) continue;
      const t = domainTargets(d.targetLabel, base, s);
      add(`stream:${d.id}`, t.panel, 'CNAME', originName, 'stream', d.id);
      const ingest = (d.ingestNodeId && nodeName.get(d.ingestNodeId)) || originName;
      add(`src:${d.id}`, t.ingest, 'CNAME', ingest, 'src', d.id);
    }
  }
  return { records, problems };
}

export interface RecordPlan {
  creates: DesiredRecord[];
  updates: { record: DesiredRecord; current: CfRecord }[];
  deletes: CfRecord[];
  keeps: { record: DesiredRecord; current: CfRecord }[];
  conflicts: { record: DesiredRecord; current: CfRecord[] }[];
}

/** The comment of a managed record: hrs:<install>:<key>. */
export const commentFor = (install: string, key: string) => `hrs:${install}:${key}`;

const sameName = (a: string, b: string) => a.toLowerCase().replace(/\.$/, '') === b.toLowerCase().replace(/\.$/, '');

/**
 * Compares the wanted records with the zone. Only records with this install's comment are changed or deleted; a record
 * of someone else on a name the platform wants is a conflict and is left alone.
 */
export function planChanges(install: string, base: string, desired: DesiredRecord[], zone: CfRecord[]): RecordPlan {
  const prefix = `hrs:${install}:`;
  const inScope = (name: string) => sameName(name, base) || name.toLowerCase().endsWith(`.${base}`);
  const managed = new Map<string, CfRecord>();
  const dupes: CfRecord[] = [];
  for (const r of zone) {
    if (!r.comment?.startsWith(prefix) || !inScope(r.name)) continue;
    const key = r.comment.slice(prefix.length);
    if (managed.has(key)) dupes.push(r);
    else managed.set(key, r);
  }
  const foreign = zone.filter((r) => !(r.comment?.startsWith(prefix) && inScope(r.name)));
  const plan: RecordPlan = { creates: [], updates: [], deletes: [...dupes], keeps: [], conflicts: [] };
  const wanted = new Set<string>();
  for (const d of desired) {
    const record = { ...d, comment: commentFor(install, d.key) };
    wanted.add(d.key);
    // A CNAME cannot share its name with anything; A and AAAA cannot share theirs with a CNAME or someone else's records.
    const blocking = foreign.filter((r) => sameName(r.name, d.name) && (d.type === 'CNAME' || r.type === 'CNAME' || r.type === d.type));
    if (blocking.length) {
      plan.conflicts.push({ record, current: blocking });
      continue;
    }
    const current = managed.get(d.key);
    if (!current) plan.creates.push(record);
    else if (!sameName(current.name, d.name) || current.type !== d.type || current.content !== d.content || current.proxied !== d.proxied || (!d.proxied && current.ttl !== d.ttl))
      plan.updates.push({ record, current });
    else plan.keeps.push({ record, current });
  }
  for (const [key, r] of managed) if (!wanted.has(key)) plan.deletes.push(r);
  return plan;
}

/** Turns a record into the body Cloudflare wants. */
export const toInput = (r: DesiredRecord): CfRecordInput => ({ name: r.name, type: r.type, content: r.content, proxied: r.proxied, ttl: r.ttl, comment: r.comment });
