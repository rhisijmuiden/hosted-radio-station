import { getTableColumns, getTableName, sql, type SQL } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { schema, type Db } from '../../db/index.js';
import type { MediaSourceConfig } from '../../db/schema.js';
import type { SecretBox } from '../../lib/crypto.js';

/**
 * The tables of a station that its station node owns (phase 12). The node is the only writer; this server keeps a
 * read-only copy (the mirror), so the panel and the public pages can show them while the node is offline. The order
 * is the order of inserts (parents first); deletes go the other way.
 */
export const NODE_TABLES = [
  { name: 'media_sources', table: schema.mediaSources, pk: ['id'], station: 'stationId' },
  { name: 'media_files', table: schema.mediaFiles, pk: ['id'], station: 'stationId' },
  { name: 'playlists', table: schema.playlists, pk: ['id'], station: 'stationId' },
  { name: 'playlist_items', table: schema.playlistItems, pk: ['playlistId', 'mediaId'], station: null },
  { name: 'clocks', table: schema.clocks, pk: ['id'], station: 'stationId' },
  { name: 'schedule_entries', table: schema.scheduleEntries, pk: ['id'], station: 'stationId' },
  { name: 'live_sessions', table: schema.liveSessions, pk: ['id'], station: 'stationId' },
  { name: 'song_requests', table: schema.songRequests, pk: ['id'], station: 'stationId' },
  { name: 'ondemand_items', table: schema.onDemandItems, pk: ['id'], station: 'stationId' },
  { name: 'queue_items', table: schema.queueItems, pk: ['id'], station: 'stationId' },
  { name: 'autodj_state', table: schema.autodjState, pk: ['stationId'], station: 'stationId' },
] as const satisfies readonly NodeTable[];

export interface NodeTable {
  name: string;
  table: PgTable;
  /** Property names of the primary key. */
  pk: readonly string[];
  /** Property holding the station id; null = rows hang under a playlist (playlist_items). */
  station: string | null;
}

export type NodeTableName = (typeof NODE_TABLES)[number]['name'];
export const nodeTable = (name: string) => NODE_TABLES.find((t) => t.name === name);

export type WireRow = Record<string, unknown>;

/** The key of a row, e.g. "id" or "playlistId|mediaId". */
export const rowKey = (t: NodeTable, row: WireRow) => t.pk.map((k) => String(row[k])).join('|');

/** A row as it travels: dates as ISO strings, secrets in plain text (the channel is TLS; each side seals its own). */
export function toWire(t: NodeTable, row: WireRow, box: SecretBox): WireRow {
  const out: WireRow = {};
  for (const [k, v] of Object.entries(row)) out[k] = v instanceof Date ? v.toISOString() : v;
  if (t.name === 'media_sources') out.config = openSourceConfig(out.config as MediaSourceConfig, box);
  return out;
}

/** The other way: only known columns, dates back to Date objects, secrets sealed with this side's key. */
export function fromWire(t: NodeTable, row: WireRow, box: SecretBox): WireRow {
  const out: WireRow = {};
  for (const [k, col] of Object.entries(getTableColumns(t.table))) {
    if (!(k in row)) continue;
    const v = row[k];
    out[k] = col.dataType === 'date' && typeof v === 'string' ? new Date(v) : v;
  }
  if (t.name === 'media_sources') out.config = sealSourceConfig(out.config as MediaSourceConfig, box);
  return out;
}

function openSourceConfig(c: MediaSourceConfig | undefined, box: SecretBox): MediaSourceConfig {
  if (!c?.password) return c ?? {};
  try {
    return { ...c, password: box.decrypt(c.password) };
  } catch {
    return { ...c, password: undefined };
  }
}

const sealSourceConfig = (c: MediaSourceConfig | undefined, box: SecretBox): MediaSourceConfig => (c?.password ? { ...c, password: box.encrypt(c.password) } : (c ?? {}));

/** The SQL name of a property of a table. */
export function columnName(t: NodeTable, key: string) {
  const col = getTableColumns(t.table)[key];
  if (!col) throw new Error(`${getTableName(t.table)} has no column ${key}`);
  return col.name;
}

/**
 * Inserts or updates rows by their primary key. `where` limits which existing rows may be overwritten (an SQL condition
 * on the existing row, e.g. that it belongs to the same station), so a row of another station is never taken over.
 */
export async function upsertRows(db: Db, t: NodeTable, rows: WireRow[], where?: SQL, keep: readonly string[] = []) {
  if (!rows.length) return;
  const cols = getTableColumns(t.table);
  const pkCols = t.pk.map((k) => cols[k]!);
  const set: Record<string, SQL> = {};
  // `keep`: columns this side looks after itself (e.g. the status of an output), never overwritten.
  for (const [k, col] of Object.entries(cols)) if (!t.pk.includes(k) && !keep.includes(k)) set[k] = sql.raw(`excluded."${col.name}"`);
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const q = db.insert(t.table).values(chunk as never);
    // Tables with only key columns (none here today) have nothing to update.
    await (Object.keys(set).length ? q.onConflictDoUpdate({ target: pkCols as never, set, setWhere: where }) : q.onConflictDoNothing());
  }
}
