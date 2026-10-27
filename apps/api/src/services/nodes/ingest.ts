import { and, eq, isNull, notInArray, sql } from 'drizzle-orm';
import { schema } from '../../db/index.js';
import type { AppContext } from '../../lib/context.js';
import { NOWPLAYING_CHANNEL } from '../public/hub.js';
import { authenticateSource, type OutsideShow } from '../streaming/sources.js';
import { autodjMount } from '../streaming/state.js';
import type { AgentAuth, AgentLive, AuthResult } from './protocol.js';
import { serves } from './dedication.js';
import { ingestsOf, stationRouting } from './routing-rules.js';

const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The station when this node is one of its ingests (main or backup) and both station and customer are active. */
async function routedStation(ctx: AppContext, node: { id: string; tenantId: string | null }, stationId: string) {
  if (!uuidRe.test(stationId)) return null;
  const [row] = await ctx.db
    .select({ s: schema.stations, active: schema.tenants.active, limits: schema.tenants.limits })
    .from(schema.stations)
    .innerJoin(schema.tenants, eq(schema.tenants.id, schema.stations.tenantId))
    .where(eq(schema.stations.id, stationId));
  if (!row || !row.s.enabled || !row.active || row.s.nodeId) return null;
  // A dedicated node (1.1.1) only takes encoders of its customer or station; its settings may have changed since it connected.
  const [own] = await ctx.db.select({ id: schema.nodes.id, tenantId: schema.nodes.tenantId, roles: schema.nodes.roles, config: schema.nodes.config }).from(schema.nodes).where(eq(schema.nodes.id, node.id));
  if (!own || !serves(own, row.s)) return null;
  if (!ingestsOf(stationRouting(row.s)).some((i) => i.ref === node.id)) return null;
  return row;
}

/**
 * Checks an encoder log-in for an ingest node (phase 13). The node never sees passwords of DJ accounts: it asks here,
 * over its control channel, and only gets yes or no with the account name and the bitrate limit.
 */
export async function authorizeIngest(ctx: AppContext, node: { id: string; tenantId: string | null }, m: AgentAuth): Promise<AuthResult> {
  const no = (message: string): AuthResult => ({ t: 'auth_result', id: m.id, ok: false, message });
  const row = await routedStation(ctx, node, String(m.stationId ?? ''));
  if (!row) return no('This node does not take encoders for this station.');
  const mounts = await ctx.db.select().from(schema.stationMounts).where(eq(schema.stationMounts.stationId, row.s.id));
  const auto = autodjMount(row.s, mounts);
  const mount = mounts.find((x) => x.path === m.mount && x.kind === 'source' && x.id !== auto?.id);
  if (!mount) return no(`Unknown mount ${String(m.mount).slice(0, 64)}`);
  let outside: OutsideShow | null = null;
  const account = await authenticateSource(ctx, row.s.id, mount.id, m.user ? String(m.user).slice(0, 100) : null, String(m.pass ?? '').slice(0, 300), (refusal) => {
    outside = refusal;
  });
  if (!account) {
    if (!outside) return no('Invalid user name or password');
    const { opensAt, timezone } = outside as OutsideShow;
    const when = opensAt && new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: timezone }).format(opensAt);
    return no(when ? `You can only broadcast during your show. You can connect from ${when} (${timezone}).` : 'You can only broadcast during your show.');
  }
  return { t: 'auth_result', id: m.id, ok: true, accountId: account.id, accountName: account.displayName || account.username, limitKbps: Math.min(mount.bitrateKbps, row.limits.maxBitrateKbps) };
}

const notify = (ctx: AppContext, stationId: string) => ctx.db.execute(sql`select pg_notify(${NOWPLAYING_CHANNEL}, ${stationId})`).catch(() => undefined);

/** Logs a broadcast on an ingest node in the live sessions, like the ingest gateway of this server does. */
export async function recordLive(ctx: AppContext, node: { id: string; tenantId: string | null }, m: AgentLive) {
  if (!uuidRe.test(String(m.sessionId ?? ''))) return;
  if (m.action === 'end') {
    const done = await ctx.db
      .update(schema.liveSessions)
      .set({ endedAt: new Date(), bytesIn: Math.max(0, Math.round(Number(m.bytesIn) || 0)), endReason: sql`coalesce(${schema.liveSessions.endReason}, ${String(m.reason ?? 'disconnected').slice(0, 20)})` })
      .where(and(eq(schema.liveSessions.id, m.sessionId), eq(schema.liveSessions.nodeId, node.id), eq(schema.liveSessions.onNode, true), isNull(schema.liveSessions.endedAt)))
      .returning({ stationId: schema.liveSessions.stationId });
    for (const d of done) await notify(ctx, d.stationId);
    return;
  }
  const row = await routedStation(ctx, node, String(m.stationId ?? ''));
  if (!row) return;
  const [mount] = await ctx.db.select({ id: schema.stationMounts.id }).from(schema.stationMounts).where(and(eq(schema.stationMounts.stationId, row.s.id), eq(schema.stationMounts.path, String(m.mount))));
  const started = m.startedAt ? new Date(m.startedAt) : new Date();
  await ctx.db
    .insert(schema.liveSessions)
    .values({
      id: m.sessionId,
      stationId: row.s.id,
      mountId: mount?.id ?? null,
      mountPath: String(m.mount).slice(0, 100),
      accountId: m.accountId && uuidRe.test(m.accountId) ? m.accountId : null,
      accountName: String(m.accountName ?? '').slice(0, 100) || 'Encoder',
      via: m.via === 'tls' ? 'tls' : 'plain',
      nodeId: node.id,
      onNode: true,
      ip: m.ip ? String(m.ip).slice(0, 64) : null,
      userAgent: m.userAgent ? String(m.userAgent).slice(0, 200) : null,
      bitrateKbps: typeof m.bitrateKbps === 'number' ? Math.round(m.bitrateKbps) : null,
      startedAt: Number.isNaN(started.getTime()) || started.getTime() > Date.now() ? new Date() : started,
    })
    .onConflictDoNothing();
  if (m.accountId && uuidRe.test(m.accountId)) await ctx.db.update(schema.stationAccounts).set({ lastUsedAt: new Date() }).where(eq(schema.stationAccounts.id, m.accountId));
  await notify(ctx, row.s.id);
}

/** Ends the broadcasts of an ingest node that it no longer has (after a restart of the node). */
export async function syncLive(ctx: AppContext, nodeId: string, sessionIds: string[]) {
  const keep = sessionIds.filter((id) => uuidRe.test(String(id))).slice(0, 500);
  const done = await ctx.db
    .update(schema.liveSessions)
    .set({ endedAt: new Date(), endReason: sql`coalesce(${schema.liveSessions.endReason}, 'restart')` })
    .where(and(eq(schema.liveSessions.nodeId, nodeId), eq(schema.liveSessions.onNode, true), isNull(schema.liveSessions.endedAt), keep.length ? notInArray(schema.liveSessions.id, keep) : undefined))
    .returning({ stationId: schema.liveSessions.stationId });
  for (const id of new Set(done.map((d) => d.stationId))) await notify(ctx, id);
}
