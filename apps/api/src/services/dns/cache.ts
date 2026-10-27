import type { CfRule } from './cloudflare.js';

/** A cache rule the platform wants, before it is written. */
export interface DesiredCacheRule {
  key: 'public' | 'assets';
  description: string;
  expression: string;
  action: 'set_cache_settings';
  action_parameters: Record<string, unknown>;
  enabled: true;
}

const quote = (v: string) => `"${v.replace(/["\\]/g, '')}"`;

/**
 * The cache rules for the panel host when it goes through the Cloudflare proxy: the public API (station info, now
 * playing, schedules, artwork, logos, on-demand audio) and the built panel assets may be cached at the edge, for as
 * long as the server's own Cache-Control allows (a few seconds for now playing, a month for artwork). Live updates
 * (events, WebSocket) and listen links are left alone. Everything else follows Cloudflare's defaults.
 */
export function desiredCacheRules(install: string, host: string): DesiredCacheRule[] {
  const h = `http.host eq ${quote(host)}`;
  const path = 'http.request.uri.path';
  const respectOrigin = { cache: true, edge_ttl: { mode: 'respect_origin' }, browser_ttl: { mode: 'respect_origin' } };
  return [
    {
      key: 'public',
      description: `hrs:${install}:public · public pages and widgets (Hosted Radio Station)`,
      expression: `(${h} and starts_with(${path}, "/api/public/") and not ends_with(${path}, "/events") and ${path} ne "/api/public/ws" and not ${path} contains "/listen/")`,
      action: 'set_cache_settings',
      action_parameters: respectOrigin,
      enabled: true,
    },
    {
      key: 'assets',
      description: `hrs:${install}:assets · panel files (Hosted Radio Station)`,
      expression: `(${h} and starts_with(${path}, "/assets/"))`,
      action: 'set_cache_settings',
      action_parameters: respectOrigin,
      enabled: true,
    },
  ];
}

export interface CachePlan {
  /** The full list to write, or null when the zone already has exactly what is wanted. */
  rules: CfRule[] | null;
  /** This installation's rules in the zone now. */
  current: number;
  /** The rules of others in the zone, which are kept as they are. */
  foreign: number;
}

const ownPrefix = (install: string) => `hrs:${install}:`;
const same = (a: CfRule, b: DesiredCacheRule) =>
  a.expression === b.expression && a.action === b.action && (a.enabled ?? true) === b.enabled && a.description === b.description && JSON.stringify(a.action_parameters ?? {}) === JSON.stringify(b.action_parameters);

/**
 * Compares the zone's cache rules with the wanted ones. Rules of this installation (description hrs:<install>:…) go
 * first, so rules an administrator adds after them win; rules of anyone else are kept untouched and in their order.
 */
export function planCacheRules(install: string, zone: CfRule[], desired: DesiredCacheRule[]): CachePlan {
  const prefix = ownPrefix(install);
  const own = zone.filter((r) => r.description?.startsWith(prefix));
  const foreign = zone.filter((r) => !r.description?.startsWith(prefix));
  const inPlace = own.length === desired.length && desired.every((d, i) => zone[i] && zone[i]!.description?.startsWith(prefix) && same(zone[i]!, d));
  if (inPlace) return { rules: null, current: own.length, foreign: foreign.length };
  const mine: CfRule[] = desired.map(({ key: _key, ...r }) => r);
  return { rules: [...mine, ...foreign], current: own.length, foreign: foreign.length };
}
