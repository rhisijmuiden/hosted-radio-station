import type { AppContext } from '../../lib/context.js';
import type { GeoInfo } from '../stats/geoip.js';
import { nodeSettings, relayBaseUrl, relaysByStation, type Node } from './plan.js';

let cache: { at: number; value: Map<string, Node[]> } | null = null;

/** Paired relay nodes per station, cached for a few seconds (asked for on every listener redirect). */
export async function cachedRelays(ctx: AppContext) {
  if (!cache || Date.now() - cache.at > 5000) cache = { at: Date.now(), value: await relaysByStation(ctx) };
  return cache.value;
}
export const forgetRelays = () => (cache = null);

/** Great-circle distance in km. */
function distance(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }) {
  const rad = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * rad;
  const dLon = (b.longitude - a.longitude) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dLon / 2) ** 2;
  return 12_742 * Math.asin(Math.sqrt(h));
}

/** Relay nodes that can take a listener of this mount now: online, the stream is up, and there is room. */
export function usableRelays(relays: Node[], key: string) {
  return relays.filter((n) => {
    if (!n.status.online || !relayBaseUrl(n)) return false;
    if (!n.status.relays?.some((r) => r.key === key && r.state === 'connected')) return false;
    const max = nodeSettings(n).maxListeners;
    return !max || (n.status.listeners ?? 0) < max;
  });
}

/**
 * The best relay for a listener: in the listener's country first, then the nearest one, then the least busy.
 * Returns the listen URL on that node, or null to stay on this server.
 */
export async function pickRelay(ctx: AppContext, stationId: string, slug: string, mountPath: string, geo: GeoInfo | null): Promise<string | null> {
  const key = `${slug}${mountPath}`;
  const candidates = usableRelays((await cachedRelays(ctx)).get(stationId) ?? [], key);
  if (!candidates.length) return null;
  const score = (n: Node) => {
    const s = n.status;
    let v = (s.listeners ?? 0) / 1000 + (s.cpu ?? 0);
    if (geo?.latitude != null && geo.longitude != null && s.latitude != null && s.longitude != null) {
      v += distance({ latitude: geo.latitude, longitude: geo.longitude }, { latitude: s.latitude, longitude: s.longitude }) / 500;
    }
    if (geo?.country && s.country === geo.country) v -= 10;
    return v;
  };
  const best = [...candidates].sort((a, b) => score(a) - score(b))[0]!;
  return `${relayBaseUrl(best)}/listen/${slug}${mountPath}`;
}
