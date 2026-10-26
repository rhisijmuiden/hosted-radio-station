import { and, asc, eq, gt, inArray, sql, type SQL } from 'drizzle-orm';
import { schema } from '../../db/index.js';
import type { AppContext } from '../../lib/context.js';
import { columnName, NODE_TABLES, rowKey, toWire, type NodeTable, type WireRow } from './tables.js';

/**
 * On a station node, every insert, update and delete in the tables it owns is noted in hrs_node_changes by a trigger,
 * so the node can send just what changed to the main server. The table and triggers only exist on station nodes;
 * they are made when the node starts, not by a migration.
 */
export async function installChangeTracking(ctx: AppContext) {
  await ctx.db.execute(sql`create table if not exists hrs_node_changes (seq bigserial primary key, tbl text not null, key text not null)`);
  await ctx.db.execute(
    sql.raw(`create or replace function hrs_node_track() returns trigger language plpgsql as $$
declare r jsonb;
begin
  if tg_op = 'DELETE' then r := to_jsonb(old); else r := to_jsonb(new); end if;
  if tg_nargs = 2 then
    insert into hrs_node_changes (tbl, key) values (tg_table_name, (r->>tg_argv[0]) || '|' || (r->>tg_argv[1]));
  else
    insert into hrs_node_changes (tbl, key) values (tg_table_name, r->>tg_argv[0]);
  end if;
  return null;
end $$`),
  );
  for (const t of NODE_TABLES) {
    const args = t.pk.map((k) => `'${columnName(t, k)}'`).join(', ');
    await ctx.db.execute(sql.raw(`drop trigger if exists hrs_node_track on "${t.name}"`));
    await ctx.db.execute(sql.raw(`create trigger hrs_node_track after insert or update or delete on "${t.name}" for each row execute function hrs_node_track(${args})`));
  }
}

const col = (t: NodeTable, k: string) => (t.table as never as Record<string, never>)[k];

/** Rows of a table that belong to the given stations. */
export function ofStations(t: NodeTable, stationIds: string[]): SQL {
  if (!stationIds.length) return sql`false`;
  if (t.station) return inArray(col(t, t.station), stationIds);
  return inArray(schema.playlistItems.playlistId, sql`(select id from playlists where station_id in (${sql.join(stationIds.map((id) => sql`${id}::uuid`), sql`, `)}))`);
}

function byKeys(t: NodeTable, keys: string[]): SQL {
  if (t.pk.length === 1) return inArray(col(t, t.pk[0]!), keys);
  const pairs = keys.map((k) => k.split('|')).filter((p) => p.length === 2);
  if (!pairs.length) return sql`false`;
  return sql`(${schema.playlistItems.playlistId}, ${schema.playlistItems.mediaId}) in (${sql.join(
    pairs.map((p) => sql`(${p[0]}::uuid, ${p[1]}::uuid)`),
    sql`, `,
  )})`;
}

export interface Changes {
  upserts: Record<string, WireRow[]>;
  deletes: Record<string, string[]>;
  /** The last change these cover; acknowledged with forget() once the main server has them. */
  lastSeq: number;
  count: number;
}

/**
 * The rows that changed since the last report, for the given (running) stations: rows that exist are sent whole,
 * rows that are gone as their key. Rows of stations that are not running here (still moving) are left out.
 */
export async function pendingChanges(ctx: AppContext, stationIds: string[], limit = 5000): Promise<Changes> {
  const rows = (await ctx.db.execute(sql`select seq, tbl, key from hrs_node_changes order by seq limit ${limit}`)) as unknown as { seq: string; tbl: string; key: string }[];
  const out: Changes = { upserts: {}, deletes: {}, lastSeq: rows.length ? Number(rows.at(-1)!.seq) : 0, count: 0 };
  if (!rows.length) return out;
  const byTable = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!byTable.has(r.tbl)) byTable.set(r.tbl, new Set());
    byTable.get(r.tbl)!.add(r.key);
  }
  for (const t of NODE_TABLES) {
    const keys = [...(byTable.get(t.name) ?? [])];
    if (!keys.length) continue;
    for (let i = 0; i < keys.length; i += 2000) {
      const chunk = keys.slice(i, i + 2000);
      const found = (await ctx.db.select().from(t.table).where(byKeys(t, chunk))) as WireRow[];
      const running = new Set(stationIds);
      const mine = t.station
        ? new Set(found.filter((r) => running.has(String(r[t.station!]))).map((r) => rowKey(t, r)))
        : new Set(((await ctx.db.select().from(t.table).where(and(byKeys(t, chunk), ofStations(t, stationIds)))) as WireRow[]).map((r) => rowKey(t, r)));
      const present = new Set(found.map((r) => rowKey(t, r)));
      const ups = found.filter((r) => mine.has(rowKey(t, r))).map((r) => toWire(t, r, ctx.box));
      const dels = chunk.filter((k) => !present.has(k));
      if (ups.length) (out.upserts[t.name] ??= []).push(...ups);
      if (dels.length) (out.deletes[t.name] ??= []).push(...dels);
      out.count += ups.length + dels.length;
    }
  }
  return out;
}

/** Drops the noted changes up to and including seq (the main server has them). */
export async function forgetChanges(ctx: AppContext, seq: number) {
  if (seq > 0) await ctx.db.execute(sql`delete from hrs_node_changes where seq <= ${seq}`);
}

export async function lastChange(ctx: AppContext) {
  const [r] = (await ctx.db.execute(sql`select coalesce(max(seq), 0) as seq from hrs_node_changes`)) as unknown as { seq: string }[];
  return Number(r?.seq ?? 0);
}

/** Every row of a table for the given stations, a page at a time in key order (for a full sync). */
export async function* allRows(ctx: AppContext, t: NodeTable, stationIds: string[], page = 2000): AsyncGenerator<WireRow[]> {
  let after: WireRow | null = null;
  for (;;) {
    let cond: SQL | undefined;
    if (after) {
      cond =
        t.pk.length === 1
          ? gt(col(t, t.pk[0]!), after[t.pk[0]!] as never)
          : sql`(${schema.playlistItems.playlistId}, ${schema.playlistItems.mediaId}) > (${after.playlistId as string}::uuid, ${after.mediaId as string}::uuid)`;
    }
    const rows = (await ctx.db
      .select()
      .from(t.table)
      .where(and(ofStations(t, stationIds), cond))
      .orderBy(...t.pk.map((k) => asc(col(t, k))))
      .limit(page)) as WireRow[];
    if (!rows.length) return;
    yield rows.map((r) => toWire(t, r, ctx.box));
    if (rows.length < page) return;
    after = rows.at(-1)!;
  }
}

/** Removes the rows of the node's own tables for one station (before it is seeded again). */
export async function clearStationTables(db: AppContext['db'], stationId: string) {
  for (const t of [...NODE_TABLES].reverse()) await db.delete(t.table).where(t.station ? eq(col(t, t.station), stationId) : ofStations(t, [stationId]));
}
