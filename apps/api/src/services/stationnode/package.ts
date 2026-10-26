import { createHash } from 'node:crypto';
import { and, asc, eq, inArray, isNotNull, or, sql } from 'drizzle-orm';
import { schema } from '../../db/index.js';
import type { OutputConfig } from '../../db/schema.js';
import type { AppContext } from '../../lib/context.js';
import { nodeSettings, pushToken, relaysByStation, type Node } from '../nodes/plan.js';
import type { WireRow } from './tables.js';

/** A station in the package of a station node. */
export interface PackageStation {
  /** active = the node runs it; moving = the node prepares it (copies the library) but this server still runs it. */
  state: 'active' | 'moving';
  station: WireRow;
  mounts: WireRow[];
  outputs: WireRow[];
  accounts: WireRow[];
  liveTokens: WireRow[];
}

/**
 * Everything a station node needs from this server to run its stations: the customers and users who may manage them
 * (no passwords), API key hashes (for RHIS Studio on the studio network), and per station its settings, mounts,
 * outputs, DJ accounts and Studio live tokens. These rows belong to this server; the node replaces its copy with them.
 * Secrets travel in plain text over the node's TLS connection and are sealed with the node's own key there.
 */
export interface StationPackage {
  revision: string;
  node: { id: string; name: string };
  tenants: WireRow[];
  users: WireRow[];
  memberships: WireRow[];
  apiKeys: WireRow[];
  stations: PackageStation[];
}

const wire = (row: Record<string, unknown>): WireRow => {
  const out: WireRow = {};
  for (const [k, v] of Object.entries(row)) out[k] = v instanceof Date ? v.toISOString() : v;
  return out;
};

/** A stable uuid made from text, for rows this server makes up (the relay outputs of a station node). */
export function derivedUuid(text: string) {
  const h = createHash('sha256').update(text).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Stations a station node runs or is preparing. A move that failed is left alone until it is retried or cancelled. */
export async function nodeStations(ctx: AppContext, nodeId: string) {
  return ctx.db
    .select()
    .from(schema.stations)
    .where(
      or(
        eq(schema.stations.nodeId, nodeId),
        and(isNotNull(schema.stations.nodeMove), sql`${schema.stations.nodeMove}->>'nodeId' = ${nodeId} and ${schema.stations.nodeMove}->>'state' is distinct from 'failed'`),
      ),
    )
    .orderBy(asc(schema.stations.slug));
}

export async function buildPackage(ctx: AppContext, node: Node): Promise<StationPackage> {
  const stations = node.roles.includes('station') ? await nodeStations(ctx, node.id) : [];
  const ids = stations.map((s) => s.id);
  const tenantIds = [...new Set(stations.map((s) => s.tenantId))];
  const [tenants, mounts, outputs, accounts, memberships, relays] = await Promise.all([
    tenantIds.length ? ctx.db.select().from(schema.tenants).where(inArray(schema.tenants.id, tenantIds)).orderBy(asc(schema.tenants.id)) : [],
    ids.length ? ctx.db.select().from(schema.stationMounts).where(inArray(schema.stationMounts.stationId, ids)).orderBy(asc(schema.stationMounts.id)) : [],
    ids.length ? ctx.db.select().from(schema.stationOutputs).where(inArray(schema.stationOutputs.stationId, ids)).orderBy(asc(schema.stationOutputs.id)) : [],
    ids.length ? ctx.db.select().from(schema.stationAccounts).where(inArray(schema.stationAccounts.stationId, ids)).orderBy(asc(schema.stationAccounts.id)) : [],
    tenantIds.length ? ctx.db.select().from(schema.memberships).where(inArray(schema.memberships.tenantId, tenantIds)).orderBy(asc(schema.memberships.tenantId), asc(schema.memberships.userId)) : [],
    ids.length ? relaysByStation(ctx) : new Map<string, Node[]>(),
  ]);
  const accountIds = accounts.map((a) => a.id);
  const liveTokens = accountIds.length
    ? await ctx.db
        .select()
        .from(schema.studioLiveTokens)
        .where(and(inArray(schema.studioLiveTokens.accountId, accountIds), sql`${schema.studioLiveTokens.expiresAt} > now()`))
        .orderBy(asc(schema.studioLiveTokens.id))
    : [];
  // Users who may manage these stations: the customers' members, the administrators and the DJs of the accounts.
  const userIds = new Set([...memberships.map((m) => m.userId), ...accounts.map((a) => a.userId).filter((u): u is string => !!u), ...liveTokens.map((t) => t.userId)]);
  const users = await ctx.db
    .select()
    .from(schema.users)
    .where(userIds.size ? or(eq(schema.users.isSuperadmin, true), inArray(schema.users.id, [...userIds])) : eq(schema.users.isSuperadmin, true))
    .orderBy(asc(schema.users.id));
  const keys = users.length
    ? await ctx.db
        .select()
        .from(schema.apiKeys)
        .where(and(inArray(schema.apiKeys.userId, users.map((u) => u.id)), eq(schema.apiKeys.scope, 'full')))
        .orderBy(asc(schema.apiKeys.id))
    : [];

  const open = (sealed: string | undefined) => {
    if (!sealed) return undefined;
    try {
      return ctx.box.decrypt(sealed);
    } catch {
      return undefined;
    }
  };

  const out: PackageStation[] = stations.map((s) => {
    const own = mounts.filter((m) => m.stationId === s.id);
    const outs: WireRow[] = outputs
      .filter((o) => o.stationId === s.id)
      .map((o) => wire({ ...o, status: null, config: { ...o.config, password: open(o.config.password), adminPassword: open(o.config.adminPassword) } }));
    // The node delivers each public stream to every relay node that carries the station.
    for (const relay of relays.get(s.id) ?? []) {
      const c = nodeSettings(relay);
      const host = c.publicHost || relay.status.ip;
      if (!host || !c.pushPort) continue;
      for (const m of own.filter((x) => x.isPublic)) {
        const key = `${s.slug}${m.path}`;
        const config: OutputConfig = {
          host,
          port: c.pushPort,
          tls: true,
          insecureTls: !c.publicHost,
          mount: `/listen/${key}`,
          username: 'source',
          password: pushToken(ctx, relay, key),
          push: true,
          relayNodeId: relay.id,
        };
        outs.push(wire({ id: derivedUuid(`relay-push:${relay.id}:${m.id}`), stationId: s.id, type: 'icecast', name: `Relay ${relay.name}`, enabled: true, mountId: m.id, config, status: null, createdAt: s.createdAt }));
      }
    }
    return {
      state: s.nodeId === node.id ? 'active' : 'moving',
      station: wire({
        ...s,
        // On the node the station runs locally.
        nodeId: null,
        nodeRuntime: null,
        nodeMove: null,
        icecastAdminPassword: open(s.icecastAdminPassword),
        icecastSourcePassword: open(s.icecastSourcePassword),
        storageBytes: 0,
        storageScannedAt: null,
      }),
      mounts: own.map(wire),
      outputs: outs,
      accounts: accounts.filter((a) => a.stationId === s.id).map((a) => wire({ ...a, lastUsedAt: null })),
      liveTokens: liveTokens.filter((t) => accounts.some((a) => a.id === t.accountId && a.stationId === s.id)).map(wire),
    };
  });

  const body: Omit<StationPackage, 'revision'> = {
    node: { id: node.id, name: node.name },
    tenants: tenants.map((t) => wire({ ...t, stationNodeId: null })),
    users: users.map((u) => wire({ ...u, passwordHash: null, lastLoginAt: null })),
    memberships: memberships.map(wire),
    apiKeys: keys.map((k) => wire({ ...k, lastUsedAt: null })),
    stations: out,
  };
  return { ...body, revision: createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 20) };
}
