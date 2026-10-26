import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '../../db/index.js';
import type { StationNodeRuntime } from '../../db/schema.js';
import type { AppContext } from '../../lib/context.js';
import { NOWPLAYING_CHANNEL } from '../public/hub.js';
import type { Node } from '../nodes/plan.js';
import { columnName, fromWire, NODE_TABLES, rowKey, upsertRows, withoutMainOnly, type NodeTable, type WireRow } from './tables.js';

const mountSchema = z.object({
  mount: z.string().max(100),
  title: z.string().max(500).nullable(),
  listeners: z.number().int().min(0),
  bitrateKbps: z.number().int().min(0).max(10_000).nullable(),
  contentType: z.string().max(100).nullable(),
  listenerPeak: z.number().int().min(0).optional(),
  streamStart: z.string().max(40).nullable().optional(),
});

export const runtimeSchema = z.object({
  mounts: z.array(mountSchema).max(50),
  autodj: z.object({ connected: z.boolean(), paused: z.boolean(), seenAt: z.string().max(40).nullable() }).nullable(),
  encoders: z.number().int().min(0),
  relays: z.record(z.string().max(40), z.object({ state: z.enum(['idle', 'connecting', 'connected', 'error']), message: z.string().max(300).optional() })),
  revision: z.string().max(40).nullable(),
  /** Bytes the station's media folder takes on the node, when it was measured. */
  storageBytes: z.number().int().min(0).nullable().default(null),
});

const tableNames = NODE_TABLES.map((t) => t.name) as [string, ...string[]];

/**
 * What a station node sends: changed and deleted rows of the tables it owns, per table. A full sync sends every row
 * in batches; its last batch (`done`) lists every key, and rows of those stations that are not listed are removed.
 */
export const mirrorSchema = z.object({
  stationIds: z.array(z.uuid()).max(500),
  upserts: z.partialRecord(z.enum(tableNames), z.array(z.record(z.string(), z.unknown())).max(5000)).default({}),
  deletes: z.partialRecord(z.enum(tableNames), z.array(z.string().max(80)).max(50_000)).default({}),
  full: z
    .object({ keys: z.partialRecord(z.enum(tableNames), z.array(z.string().max(80)).max(500_000)) })
    .nullable()
    .default(null),
  runtime: z.record(z.uuid(), runtimeSchema).default({}),
});
export type MirrorBatch = z.infer<typeof mirrorSchema>;

/** Rows of a table that belong to the given stations. */
function ofStations(t: NodeTable, stationIds: string[]): SQL {
  if (t.station) return inArray((t.table as never as Record<string, never>)[t.station], stationIds);
  // playlist_items: through its playlist.
  return sql`${schema.playlistItems.playlistId} in (select id from playlists where station_id in ${stationIds.length ? sql`(${sql.join(stationIds.map((id) => sql`${id}::uuid`), sql`, `)})` : sql`(null)`})`;
}

function keyCondition(t: NodeTable, keys: string[]): SQL {
  if (t.pk.length === 1) return inArray((t.table as never as Record<string, never>)[t.pk[0]!], keys);
  const pairs = keys.map((k) => k.split('|')).filter((p) => p.length === 2);
  if (!pairs.length) return sql`false`;
  const cols = t.pk.map((k) => sql.identifier(columnName(t, k)));
  return sql`(${sql.join(cols, sql`, `)}) in (${sql.join(
    pairs.map((p) => sql`(${p[0]}::uuid, ${p[1]}::uuid)`),
    sql`, `,
  )})`;
}

/**
 * Applies what a station node reported to the copy on this server. A node can only write rows of stations that it
 * runs: other rows are dropped, and an existing row of another station with the same id is never overwritten.
 */
export async function applyMirror(ctx: AppContext, node: Node, batch: MirrorBatch) {
  const mine = await ctx.db.select({ id: schema.stations.id }).from(schema.stations).where(eq(schema.stations.nodeId, node.id));
  const allowed = new Set(mine.map((s) => s.id));
  const stationIds = batch.stationIds.filter((id) => allowed.has(id));
  let written = 0;
  let removed = 0;
  if (stationIds.length) {
    await ctx.db.transaction(async (tx) => {
      for (const t of NODE_TABLES) {
        const raw = (batch.upserts[t.name] ?? []) as WireRow[];
        if (!raw.length) continue;
        let rows = raw.map((r) => withoutMainOnly(t, fromWire(t, r, ctx.box)));
        if (t.station) {
          rows = rows.filter((r) => stationIds.includes(String(r[t.station!])));
          const col = (t.table as never as Record<string, never>)[t.station];
          await upsertRows(tx as never, t, rows, sql`${col} = excluded.${sql.identifier(columnName(t, t.station))}`, (t as NodeTable).mainOnly);
        } else {
          // playlist_items: both ends must belong to these stations.
          const playlistIds = [...new Set(rows.map((r) => String(r.playlistId)))];
          const mediaIds = [...new Set(rows.map((r) => String(r.mediaId)))];
          const [pl, md] = await Promise.all([
            tx.select({ id: schema.playlists.id }).from(schema.playlists).where(and(inArray(schema.playlists.id, playlistIds), inArray(schema.playlists.stationId, stationIds))),
            tx.select({ id: schema.mediaFiles.id }).from(schema.mediaFiles).where(and(inArray(schema.mediaFiles.id, mediaIds), inArray(schema.mediaFiles.stationId, stationIds))),
          ]);
          const okP = new Set(pl.map((r) => r.id));
          const okM = new Set(md.map((r) => r.id));
          rows = rows.filter((r) => okP.has(String(r.playlistId)) && okM.has(String(r.mediaId)));
          await upsertRows(tx as never, t, rows);
        }
        written += rows.length;
      }
      for (const t of [...NODE_TABLES].reverse()) {
        const keys = batch.deletes[t.name] ?? [];
        if (keys.length) {
          const res = await tx.delete(t.table).where(and(keyCondition(t, keys), ofStations(t, stationIds)));
          removed += res.count ?? 0;
        }
        const all = batch.full?.keys[t.name];
        if (all) {
          // The end of a full sync: whatever the node did not list is gone there.
          const existing = (await tx.select().from(t.table).where(ofStations(t, stationIds))) as WireRow[];
          const keep = new Set(all);
          const gone = existing.map((r) => rowKey(t, r)).filter((k) => !keep.has(k));
          for (let i = 0; i < gone.length; i += 5000) {
            const res = await tx.delete(t.table).where(and(keyCondition(t, gone.slice(i, i + 5000)), ofStations(t, stationIds)));
            removed += res.count ?? 0;
          }
        }
      }
    });
  }

  const now = new Date().toISOString();
  for (const [stationId, r] of Object.entries(batch.runtime)) {
    if (!allowed.has(stationId)) continue;
    const { storageBytes, ...rest } = r;
    const runtime: StationNodeRuntime = { ...rest, updatedAt: now, syncedAt: batch.full ? now : null };
    await ctx.db
      .update(schema.stations)
      .set({
        ...(storageBytes !== null ? { storageBytes, storageScannedAt: new Date() } : {}),
        nodeRuntime: batch.full
          ? runtime
          : sql`${JSON.stringify(runtime)}::jsonb || jsonb_build_object('syncedAt', coalesce(${schema.stations.nodeRuntime}->'syncedAt', 'null'::jsonb))`,
      })
      .where(eq(schema.stations.id, stationId));
  }
  // Live sessions came or went: public pages show who is on air.
  if (written && batch.upserts.live_sessions?.length) {
    for (const id of stationIds) await ctx.db.execute(sql`select pg_notify(${NOWPLAYING_CHANNEL}, ${id})`).catch(() => undefined);
  }
  return { written, removed, stations: stationIds.length };
}
