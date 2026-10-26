import { eq } from 'drizzle-orm';
import { schema } from '../../db/index.js';
import type { AppContext } from '../../lib/context.js';
import type { GeoInfo } from '../stats/geoip.js';
import { nodeSettings, relayBaseUrl, relaysByStation, type Node } from './plan.js';
import { drainingNodes } from './updates.js';

let cache: { at: number; value: Map<string, Node[]> } | null = null;

/** Paired relay nodes per station, cached for a few seconds (asked for on every listener redirect). */
export async function cachedRelays(ctx: AppContext) {
  if (!cache || Date.now() - cache.at > 5000) cache = { at: Date.now(), value: await relaysByStation(ctx) };
  return cache.value;
}
export const forgetRelays = () => (cache = null);

/**
 * Takes deleted stations out of the relay nodes that carried them by a chosen list, so no node keeps pointing at a
 * station that is gone. Returns whether any node changed (its plan then needs a refresh).
 */
export async function forgetStations(ctx: AppContext, stationIds: string[]) {
  if (!stationIds.length) return false;
  const gone = new Set(stationIds);
  let changed = false;
  for (const n of await ctx.db.select({ id: schema.nodes.id, config: schema.nodes.config }).from(schema.nodes)) {
    const list = n.config.relayStations;
    if (!Array.isArray(list) || !list.some((id) => gone.has(id))) continue;
    await ctx.db.update(schema.nodes).set({ config: { ...n.config, relayStations: list.filter((id) => !gone.has(id)) } }).where(eq(schema.nodes.id, n.id));
    changed = true;
  }
  if (changed) forgetRelays();
  return changed;
}

/** At start: takes stations that no longer exist out of the relay nodes' lists (deleted before 1.0.1 cleaned up). */
export async function forgetMissingStations(ctx: AppContext) {
  const known = new Set((await ctx.db.select({ id: schema.stations.id }).from(schema.stations)).map((s) => s.id));
  const listed = (await ctx.db.select({ config: schema.nodes.config }).from(schema.nodes)).flatMap((n) => (Array.isArray(n.config.relayStations) ? n.config.relayStations : []));
  return forgetStations(ctx, [...new Set(listed.filter((id) => !known.has(id)))]);
}

/** Scores this close to the best one count as equally good. */
const NEAR = 0.1;

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
  // A node whose update is coming or running gets no new listeners.
  const candidates = usableRelays((await cachedRelays(ctx)).get(stationId) ?? [], key).filter((n) => !drainingNodes.has(n.id));
  if (!candidates.length) return null;
  const score = (n: Node) => {
    const s = n.status;
    // Load: share of the node's listener room (1000 when it has no limit) plus its CPU.
    const max = nodeSettings(n).maxListeners || 1000;
    let v = (s.listeners ?? 0) / max + (s.cpu ?? 0);
    if (geo?.latitude != null && geo.longitude != null && s.latitude != null && s.longitude != null) {
      v += distance({ latitude: geo.latitude, longitude: geo.longitude }, { latitude: s.latitude, longitude: s.longitude }) / 500;
    }
    if (geo?.country && s.country === geo.country) v -= 10;
    return v;
  };
  // Nodes count their listeners every 30 seconds, so a rush of listeners is spread at random over the nodes that are
  // about as good as the best one instead of all landing on that one.
  const scored = candidates.map((n) => ({ n, v: score(n) }));
  const min = Math.min(...scored.map((c) => c.v));
  const close = scored.filter((c) => c.v <= min + NEAR);
  const best = close[Math.floor(Math.random() * close.length)]!.n;
  return `${relayBaseUrl(best)}/listen/${slug}${mountPath}`;
}
