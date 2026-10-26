import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '../../db/index.js';
import type { NodeClient, NodeStatus } from '../../db/schema.js';
import type { AppContext } from '../../lib/context.js';
import { unauthorized } from '../../lib/errors.js';
import { secretMatches, type NodeHub } from './hub.js';
import { carried, type Node } from './plan.js';

const short = (n: number) => z.string().max(n);

export const reportSchema = z.object({
  relays: z
    .array(
      z.object({
        key: short(200),
        state: z.enum(['connecting', 'connected', 'error', 'idle']),
        message: short(300).optional(),
        bitrateKbps: z.number().nullish(),
        listeners: z.number().int().min(0).optional(),
      }),
    )
    .max(1000)
    .default([]),
  clients: z
    .array(
      z.object({
        key: short(200),
        id: short(100),
        ip: short(100).nullable(),
        userAgent: short(500).nullable(),
        referer: short(500).nullable(),
        connectedSeconds: z.number().min(0).max(10 * 365 * 86400),
      }),
    )
    .max(50_000)
    .default([]),
  ended: z
    .array(z.object({ key: short(200), id: short(100), endedAt: z.iso.datetime() }))
    .max(10_000)
    .default([]),
  probes: z
    .array(
      z.object({
        target: short(300),
        stationId: z.uuid(),
        url: short(1000),
        ok: z.boolean(),
        httpStatus: z.number().int().nullable(),
        ttfbMs: z.number().int().min(0).nullable(),
        message: short(300).optional(),
        at: z.iso.datetime(),
      }),
    )
    .max(200)
    .default([]),
});
export type Report = z.infer<typeof reportSchema>;

/** Finds the node of an `Authorization: Node <id>.<secret>` header. */
export async function authenticateNode(ctx: AppContext, header: string | undefined): Promise<Node> {
  const m = header?.match(/^Node ([0-9a-f-]{36})\.(\S+)$/);
  if (!m) throw unauthorized();
  const [node] = await ctx.db.select().from(schema.nodes).where(eq(schema.nodes.id, m[1]!));
  if (!node || !secretMatches(ctx, node.secret, m[2]!)) throw unauthorized();
  return node;
}

/**
 * Stores what a node reported: the state of the streams it carries, its listeners (picked up by the statistics of
 * the streams service) and the results of its stream checks. Streams and listeners of stations the node does not
 * carry are ignored, so a node can never add listeners to someone else's station.
 */
export async function storeReport(ctx: AppContext, hub: NodeHub, node: Node, report: Report) {
  const stations = await ctx.db
    .select({ id: schema.stations.id, slug: schema.stations.slug, tenantId: schema.stations.tenantId })
    .from(schema.stations)
    .where(node.tenantId ? eq(schema.stations.tenantId, node.tenantId) : undefined);
  const mine = carried(node, stations);
  const bySlug = new Map(stations.filter((s) => mine.has(s.id)).map((s) => [s.slug, s]));
  const resolve = (key: string) => {
    const i = key.indexOf('/');
    const s = i > 0 ? bySlug.get(key.slice(0, i)) : undefined;
    return s ? { stationId: s.id, mount: key.slice(i) } : null;
  };

  const clients: NodeClient[] = [];
  const perKey = new Map<string, number>();
  for (const c of report.clients) {
    const r = resolve(c.key);
    if (!r) continue;
    clients.push({ ...r, id: c.id, ip: c.ip, userAgent: c.userAgent, referer: c.referer, connectedSeconds: Math.round(c.connectedSeconds) });
    perKey.set(c.key, (perKey.get(c.key) ?? 0) + 1);
  }
  const relays: NonNullable<NodeStatus['relays']> = report.relays
    .filter((r) => resolve(r.key))
    .map((r) => ({ key: r.key, state: r.state, message: r.message, bitrateKbps: r.bitrateKbps ?? null, listeners: perKey.get(r.key) ?? 0 }));
  const live = hub.liveStatus(node.id);
  const reportedAt = new Date().toISOString();
  const status: NodeStatus = { ...(live ?? node.status), relays, listeners: clients.length, reportedAt };
  if (live) Object.assign(live, { relays, listeners: clients.length, reportedAt });
  await ctx.db.update(schema.nodes).set({ clients, status, lastSeenAt: new Date() }).where(eq(schema.nodes.id, node.id));

  // Listeners that left: their session ends when they really left, not when the statistics notice they are gone.
  const now = Date.now();
  for (const e of report.ended) {
    const r = resolve(e.key);
    if (!r) continue;
    const endedAt = new Date(Math.min(new Date(e.endedAt).getTime(), now));
    await ctx.db
      .update(schema.listenerSessions)
      .set({ endedAt, durationSeconds: sql`greatest(0, round(extract(epoch from (${endedAt.toISOString()}::timestamptz - ${schema.listenerSessions.startedAt}))))::int` })
      .where(
        and(
          eq(schema.listenerSessions.stationId, r.stationId),
          eq(schema.listenerSessions.clientKey, `node:${node.id}:${r.mount}:${e.id}`.slice(0, 100)),
          isNull(schema.listenerSessions.endedAt),
        ),
      );
  }

  const allowedStations = new Set(stations.map((s) => s.id));
  const probes = report.probes.filter((p) => allowedStations.has(p.stationId));
  if (probes.length) {
    const existing = await ctx.db
      .select({ target: schema.nodeProbes.target, buckets: schema.nodeProbes.buckets, lastOkAt: schema.nodeProbes.lastOkAt })
      .from(schema.nodeProbes)
      .where(and(eq(schema.nodeProbes.nodeId, node.id), inArray(schema.nodeProbes.target, probes.map((p) => p.target))));
    const prev = new Map(existing.map((e) => [e.target, e]));
    const hourNow = Math.floor(Date.now() / 3600_000);
    for (const p of probes) {
      const at = new Date(p.at);
      const hour = Math.floor(at.getTime() / 3600_000);
      const buckets = (prev.get(p.target)?.buckets ?? []).filter((b) => b[0] > hourNow - 24);
      const b = buckets.find((x) => x[0] === hour);
      if (b) {
        b[1]++;
        if (!p.ok) b[2]++;
      } else buckets.push([hour, 1, p.ok ? 0 : 1]);
      const values = {
        nodeId: node.id,
        target: p.target,
        stationId: p.stationId,
        url: p.url,
        ok: p.ok,
        httpStatus: p.httpStatus,
        ttfbMs: p.ttfbMs,
        message: p.message ?? null,
        checkedAt: at,
        lastOkAt: p.ok ? at : (prev.get(p.target)?.lastOkAt ?? null),
        buckets,
      };
      await ctx.db
        .insert(schema.nodeProbes)
        .values(values)
        .onConflictDoUpdate({ target: [schema.nodeProbes.nodeId, schema.nodeProbes.target], set: { ...values, nodeId: sql`excluded.node_id` } });
    }
  }
  // Checks of streams that are no longer in the node's plan go away after a day.
  await ctx.db.delete(schema.nodeProbes).where(and(eq(schema.nodeProbes.nodeId, node.id), sql`${schema.nodeProbes.checkedAt} < now() - interval '1 day'`));
  return { clients: clients.length, relays: relays.length, probes: probes.length };
}
