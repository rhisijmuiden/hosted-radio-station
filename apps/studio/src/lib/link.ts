import { useQuery } from '@tanstack/react-query';
import type { StationDetail } from './api';
import { call } from './native';
import { useSettings } from './settings';

/**
 * How Go Live reaches the station (phase 17 step 7). A station on a station node has two addresses: the node's own
 * address on the studio network and its public address. `auto` takes the studio network when the node answers there,
 * so a studio keeps broadcasting when its internet connection drops, and the public address otherwise.
 */
export type LinkMode = 'auto' | 'internal' | 'external' | 'manual';
export interface ManualLink {
  host: string;
  port: number;
  tls: boolean;
}
export interface Ingest {
  host: string;
  port: number;
  tls: boolean;
  /** The same server's old port (from before the port plan), for when a firewall does not let the new one in yet. */
  oldPort?: number;
}
/** internal/external: the station node's addresses; main: the server's ingest when the station is not on a node. */
export interface Links {
  node: { name: string; online: boolean } | null;
  internal: Ingest | null;
  external: Ingest | null;
  main: Ingest | null;
}
export type Via = 'internal' | 'external' | 'main' | 'manual';

// The same rule as the server's publicName(): only a dotted name outside the internal suffixes can have a public
// certificate; an IP address or a .lan/.loc name has a self-signed one at most.
const INTERNAL_TLDS = new Set(['loc', 'local', 'lan', 'home', 'internal', 'intranet', 'corp', 'localdomain', 'test', 'invalid', 'localhost', 'arpa']);
const publicName = (host: string) => {
  const h = host.trim().toLowerCase().replace(/\.$/, '');
  if (!h || h.includes(':') || /^\d+(\.\d+){3}$/.test(h) || !h.includes('.')) return false;
  return !INTERNAL_TLDS.has(h.slice(h.lastIndexOf('.') + 1));
};

/**
 * The addresses of a station. TLS only on a public name with a certificate: a LAN address or a bare IP has none, so
 * those take the plain port. `plainHosts` are addresses where the DJ chose to skip TLS after a certificate error.
 */
export function linksOf(detail: StationDetail, plainHosts: string[] = []): Links {
  const c = detail.connection;
  const node = c.endpoints?.find((e) => e.role === 'stationNode');
  if (node) {
    const plain = node.ports.find((p) => p.service === 'encoderPlain' && !p.old)?.port ?? c.plain?.port ?? null;
    const tls = node.ports.find((p) => p.service === 'encoderTls' && !p.old)?.port ?? null;
    const oldPlain = node.ports.find((p) => p.service === 'encoderPlain' && p.old)?.port;
    const oldTls = node.ports.find((p) => p.service === 'encoderTls' && p.old)?.port;
    const ext = node.external;
    return {
      node: { name: node.name, online: node.online },
      internal: node.internal && plain ? { host: node.internal, port: plain, tls: false, oldPort: oldPlain } : null,
      external: !ext ? null : tls && publicName(ext) && !plainHosts.includes(ext) ? { host: ext, port: tls, tls: true, oldPort: oldTls } : plain ? { host: ext, port: plain, tls: false, oldPort: oldPlain } : null,
      main: null,
    };
  }
  const usePlain = plainHosts.includes(c.ingestHost) && !!c.plain;
  const ingest = c.endpoints?.find((e) => e.role === 'ingest');
  const oldOf = (service: 'encoderTls' | 'encoderPlain') => ingest?.ports.find((p) => p.service === service && p.old)?.port;
  const main = c.tls.available && !usePlain ? { host: c.ingestHost, port: c.tls.port, tls: true, oldPort: oldOf('encoderTls') } : c.plain ? { host: c.ingestHost, port: c.plain.port, tls: false, oldPort: oldOf('encoderPlain') } : null;
  return { node: null, internal: null, external: null, main };
}

/** Whether the node answers on its studio network address; only asked when there is a choice to make. */
export const probe = (to: Ingest) => call<boolean>('probe_tcp', { host: to.host, port: to.port, timeoutMs: 1500 }).catch(() => false);

/** The address Go Live uses. `reachable` = whether the internal address answers (undefined = not known yet). */
export function choose(links: Links, mode: LinkMode, manual: ManualLink, reachable: boolean | undefined): { to: Ingest; via: Via } | null {
  if (mode === 'manual') return manual.host.trim() && manual.port ? { to: { host: manual.host.trim(), port: manual.port, tls: manual.tls }, via: 'manual' } : null;
  if (links.main) return { to: links.main, via: 'main' };
  const internal = links.internal && { to: links.internal, via: 'internal' as const };
  const external = links.external && { to: links.external, via: 'external' as const };
  if (mode === 'internal') return internal ?? external;
  if (mode === 'external') return external ?? internal;
  return (reachable !== false ? internal : null) ?? external ?? internal;
}

/** The current link of a station, with the reachability of the node on the studio network (checked every 20 s). */
export function useLink(detail: StationDetail | undefined) {
  const { live } = useSettings();
  const links = detail ? linksOf(detail, live.plainHosts ?? []) : null;
  const internal = links?.internal ?? null;
  const reach = useQuery({
    queryKey: ['reach', internal?.host, internal?.port],
    queryFn: () => probe(internal!),
    enabled: !!internal,
    refetchInterval: 20_000,
    staleTime: 10_000,
  });
  const picked = links ? choose(links, live.link ?? 'auto', live.manual, reach.data) : null;
  return { links, reachable: reach.data, picked, mode: live.link ?? 'auto' };
}

/**
 * The same choice at the moment of Go Live, with a fresh check of the studio network. A server that still keeps its
 * old port (port plan, 1.3) is reached on that one when a firewall does not let the new port in yet.
 */
export async function chooseNow(links: Links, mode: LinkMode, manual: ManualLink) {
  const reachable = mode === 'auto' && links.internal && links.external ? await probe(links.internal) : undefined;
  const picked = choose(links, mode, manual, reachable);
  if (!picked?.to.oldPort || (await probe(picked.to))) return picked;
  const old = { ...picked.to, port: picked.to.oldPort };
  return (await probe(old)) ? { ...picked, to: old } : picked;
}

/** "Studio network (automatic)" and the like, for the address Go Live uses. */
export const viaLabel = (t: (k: string) => string, via: Via, mode: LinkMode) => `${t(`link.via.${via}`)}${mode === 'auto' && via !== 'main' ? ` (${t('link.automatic')})` : ''}`;
