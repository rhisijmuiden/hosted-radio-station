import type { NodeConfig } from '../../db/schema.js';

/**
 * Shared or dedicated (1.1.1). A shared node carries the stations of every customer; a dedicated node only those of
 * one customer or of one station. It only receives, shows and serves their streams, and routing (auto relays, spare
 * relays, ingests) never puts other stations on it.
 *
 * - "auto" (the default): a customer's own node is dedicated to that customer; a station node of the platform to the
 *   stations that run on it (one customer, see placementConflict); relay and ingest nodes of the platform are shared.
 * - "shared": every customer (a customer's own node stays that customer's).
 * - "customer": one customer, dedicatedTenantId (a customer's own node: always its owner).
 * - "station": one station, dedicatedStationId.
 */
export const DEDICATIONS = ['auto', 'shared', 'customer', 'station'] as const;
export type Dedication = (typeof DEDICATIONS)[number];

export type NodeScope = { kind: 'shared' } | { kind: 'customer'; tenantId: string } | { kind: 'station'; stationId: string } | { kind: 'placed' } | { kind: 'none' };

type ScopedNode = { id: string; tenantId: string | null; roles: string[]; config?: Partial<NodeConfig> | null };
type ServedStation = { id: string; tenantId: string; nodeId?: string | null };

/** Who a node is for, from its settings. */
export function scopeOf(node: ScopedNode): NodeScope {
  const c = node.config ?? {};
  const mode = (c.dedication ?? 'auto') as Dedication;
  if (mode === 'station') return c.dedicatedStationId ? { kind: 'station', stationId: c.dedicatedStationId } : { kind: 'none' };
  if (node.tenantId) return { kind: 'customer', tenantId: node.tenantId };
  if (mode === 'customer') return c.dedicatedTenantId ? { kind: 'customer', tenantId: c.dedicatedTenantId } : { kind: 'none' };
  if (mode === 'auto' && node.roles.includes('station')) return { kind: 'placed' };
  return { kind: 'shared' };
}

/** The node may receive, show and serve this station's streams. */
export function serves(node: ScopedNode, s: ServedStation): boolean {
  const scope = scopeOf(node);
  switch (scope.kind) {
    case 'shared':
      return true;
    case 'customer':
      return scope.tenantId === s.tenantId;
    case 'station':
      return scope.stationId === s.id;
    case 'placed':
      return s.nodeId === node.id;
    default:
      return false;
  }
}

/** The node is dedicated (to a customer or a station) instead of shared. */
export const isDedicated = (node: ScopedNode) => scopeOf(node).kind !== 'shared';

/**
 * Whether a station may be placed on (or a customer linked to) a station node. A station node in "auto" is
 * dedicated to the customer whose stations already run on it, so a second customer is refused.
 */
export function mayPlace(node: ScopedNode, s: ServedStation, others: ServedStation[]): boolean {
  const scope = scopeOf(node);
  if (scope.kind === 'placed') return others.every((o) => o.nodeId !== node.id || o.tenantId === s.tenantId);
  return serves(node, s);
}
