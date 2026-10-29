import { stat } from 'node:fs/promises';
import { and, asc, desc, eq, inArray, max, min, ne, sql, type SQL } from 'drizzle-orm';
import { schema } from '../../db/index.js';
import type { Db } from '../../db/index.js';
import type { AppContext } from '../../lib/context.js';
import { badRequest, notFound } from '../../lib/errors.js';
import type { Station } from '../streaming/state.js';
import { anchorOf, decide, skipItem, type ClockState } from '../scheduler/clock.js';
import { loadSchedule } from '../scheduler/runtime.js';
import { hourStart } from '../scheduler/time.js';
import { filePath, locationRoot, type MediaFile, type MediaSource } from './library.js';
import { autodjSettings, type AutodjSettings } from './settings.js';
import { cueAnnotations, playSeconds, type Cues } from './cues.js';
import { newsTrack } from './news.js';

/** What a queue entry needs to know when the next track starts. */
const playTimes = {
  durationSeconds: schema.mediaFiles.durationSeconds,
  cueIn: schema.mediaFiles.cueIn,
  cueSegue: schema.mediaFiles.cueSegue,
  cueOut: schema.mediaFiles.cueOut,
};

/**
 * Since 1.3 a station has one queue. The database and the API still name it `q1` (old clients may send `q2`, which
 * means the same queue).
 */
export type Queue = 'q1' | 'q2';
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Playlist = typeof schema.playlists.$inferSelect;

/** Serialises everything that changes a station's queues (the player, the panel and requests can act at once). */
async function lock(tx: Tx, stationId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`autodj:${stationId}`}))`);
}

/** Picks one of the playlists, the higher the weight the more often. Exported for tests. */
export function weightedPick<T extends { weight: number }>(items: T[], random = Math.random): T | null {
  const total = items.reduce((n, i) => n + Math.max(0, i.weight), 0);
  if (!items.length || total <= 0) return null;
  let r = random() * total;
  for (const i of items) {
    r -= Math.max(0, i.weight);
    if (r < 0) return i;
  }
  return items.at(-1)!;
}

const likePrefix = (path: string) => `${path.replace(/[\\%_]/g, (c) => `\\${c}`)}/%`;

/** SQL condition: the file belongs to the playlist (one of its folders, or added by hand). */
export function inPlaylist(p: Pick<Playlist, 'id' | 'folders'>): SQL {
  const parts: SQL[] = [sql`exists (select 1 from ${schema.playlistItems} pi where pi.playlist_id = ${p.id} and pi.media_id = ${schema.mediaFiles.id})`];
  for (const f of p.folders) {
    parts.push(f.path ? sql`(${schema.mediaFiles.location} = ${f.location} and ${schema.mediaFiles.path} like ${likePrefix(f.path)})` : sql`${schema.mediaFiles.location} = ${f.location}`);
  }
  return sql`(${sql.join(parts, sql` or `)})`;
}

/**
 * One track for a queue: from the playlist when given, else from the whole library. The separation rules are relaxed
 * step by step (first the artist, then the track) when nothing else is left; a track already queued is never picked.
 */
async function pickTrack(tx: Tx, station: Station, s: AutodjSettings, playlist: Playlist | null, opts: { clock?: boolean } = {}): Promise<MediaFile | null> {
  const mf = schema.mediaFiles;
  const now = Date.now();
  const trackSince = new Date(now - s.trackSeparationMinutes * 60_000).toISOString();
  const artistSince = new Date(now - s.artistSeparationMinutes * 60_000).toISOString();
  const queued = sql`${mf.id} not in (select media_id from ${schema.queueItems} where station_id = ${station.id})`;
  // Last resort for clock items: a track that is only waiting in a queue is taken out of it.
  const loaded = sql`${mf.id} not in (select media_id from ${schema.queueItems} where station_id = ${station.id} and state <> 'queued')`;
  const recentArtists = sql`lower(${mf.artist}) not in (
    select lower(artist) from ${mf} where station_id = ${station.id} and artist <> '' and last_played_at > ${artistSince}::timestamptz
    union select lower(m.artist) from ${schema.queueItems} q join ${mf} m on m.id = q.media_id where q.station_id = ${station.id} and m.artist <> '')`;
  const order =
    playlist?.order === 'sequential'
      ? [sql`case when ${mf.location} || ':' || ${mf.path} > ${playlist.cursor ?? ''} then 0 else 1 end`, asc(mf.location), asc(mf.path)]
      : playlist?.order === 'random'
        ? [sql`random()`]
        : [sql`${mf.lastPlayedAt} asc nulls first`, sql`random()`];
  for (const level of opts.clock ? [0, 1, 2, 3] : [0, 1, 2]) {
    const where = [eq(mf.stationId, station.id), eq(mf.enabled, true), level < 3 ? queued : loaded];
    if (playlist) where.push(inPlaylist(playlist));
    if (level < 2 && s.trackSeparationMinutes > 0) where.push(sql`(${mf.lastPlayedAt} is null or ${mf.lastPlayedAt} < ${trackSince}::timestamptz)`);
    if (level < 1 && s.artistSeparationMinutes > 0) where.push(sql`(${mf.artist} = '' or ${recentArtists})`);
    const [row] = await tx.select().from(mf).where(and(...where)).orderBy(...order).limit(1);
    if (row) {
      if (level === 3) await tx.delete(schema.queueItems).where(and(eq(schema.queueItems.stationId, station.id), eq(schema.queueItems.mediaId, row.id), eq(schema.queueItems.state, 'queued')));
      if (playlist?.order === 'sequential') await tx.update(schema.playlists).set({ cursor: `${row.location}:${row.path}` }).where(eq(schema.playlists.id, playlist.id));
      return row;
    }
  }
  return null;
}

async function bottom(tx: Tx, stationId: string, queue: Queue) {
  const [r] = await tx.select({ p: max(schema.queueItems.position) }).from(schema.queueItems).where(and(eq(schema.queueItems.stationId, stationId), eq(schema.queueItems.queue, queue)));
  return (r?.p ?? 0) + 1;
}

/** Position before every waiting track of a queue (cued and playing items stay first). */
async function top(tx: Tx, stationId: string, queue: Queue) {
  const [r] = await tx
    .select({ p: min(schema.queueItems.position) })
    .from(schema.queueItems)
    .where(and(eq(schema.queueItems.stationId, stationId), eq(schema.queueItems.queue, queue), eq(schema.queueItems.state, 'queued')));
  return (r?.p ?? 1) - 1;
}

/** Position after the requests waiting at the top of a queue, so requests play in the order they came in. */
async function afterRequests(tx: Tx, stationId: string, queue: Queue) {
  const rows = await tx
    .select({ position: schema.queueItems.position, origin: schema.queueItems.origin })
    .from(schema.queueItems)
    .where(and(eq(schema.queueItems.stationId, stationId), eq(schema.queueItems.queue, queue), eq(schema.queueItems.state, 'queued')))
    .orderBy(asc(schema.queueItems.position));
  const i = rows.findIndex((r) => r.origin !== 'request');
  if (i === -1) return (rows.at(-1)?.position ?? 0) + 1;
  if (i === 0) return rows[0]!.position - 1;
  return (rows[i - 1]!.position + rows[i]!.position) / 2;
}

/** Tops up the queue from the rotation playlists to the configured depth. */
async function refill(tx: Tx, station: Station, s: AutodjSettings) {
  if (!s.fill.q1) return;
  const queue = 'q1';
  let pool = await tx
    .select()
    .from(schema.playlists)
    .where(and(eq(schema.playlists.stationId, station.id), eq(schema.playlists.enabled, true), eq(schema.playlists.rotation, true)));
  const [c] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.queueItems)
    .where(and(eq(schema.queueItems.stationId, station.id), ne(schema.queueItems.state, 'playing')));
  let need = s.queueDepth - (c?.n ?? 0);
  let pos = await bottom(tx, station.id, queue);
  while (need > 0 && pool.length) {
    const p = weightedPick(pool)!;
    const track = await pickTrack(tx, station, s, p);
    if (!track) {
      pool = pool.filter((x) => x !== p);
      continue;
    }
    await tx.insert(schema.queueItems).values({ stationId: station.id, queue, mediaId: track.id, position: pos++, origin: 'rotation', playlistId: p.id });
    need--;
  }
}

/** Liquidsoap request URI: the file with its metadata, so the stream carries the title and the panel knows the item. */
export function requestUri(item: { id: string; queue: Queue }, media: MediaFile, full: string, s: AutodjSettings) {
  const q = (v: string) => `"${v.replace(/[\r\n]+/g, ' ').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const meta: Record<string, string> = { hrs_item: item.id, hrs_queue: item.queue, title: media.title };
  if (media.artist) meta.artist = media.artist;
  if (media.album) meta.album = media.album;
  if (s.normalize && media.gainDb != null) meta.liq_amplify = `${media.gainDb.toFixed(2)} dB`;
  Object.assign(meta, cueAnnotations(media, s.crossfadeSeconds));
  return `annotate:${Object.entries(meta).map(([k, v]) => `${k}=${q(v)}`).join(',')}:${full}`;
}

async function loadSources(tx: Tx, stationId: string) {
  return new Map((await tx.select().from(schema.mediaSources).where(eq(schema.mediaSources.stationId, stationId))).map((s) => [s.id, s] as const));
}

/** Path on disk of a library file, or null when its location is gone. */
export function mediaPath(ctx: AppContext, media: MediaFile, sources: Map<string, MediaSource>) {
  const root = locationRoot(ctx, media.stationId, media.location, media.sourceId ? sources.get(media.sourceId) : null);
  if (!root) return null;
  try {
    return filePath(root, media.path);
  } catch {
    return null;
  }
}

/** What the next track comes from under the hour clock; null = the queues as usual. */
interface ClockPick {
  item: typeof schema.queueItems.$inferSelect;
  media: MediaFile;
  cutAt: number | null;
}

/**
 * When the station runs a schedule: asks the hour clock what plays next and puts a clock item or a track of the
 * clock's playlist on top of Q1, loaded right away. Returns null when the queues play (rotation), as without a clock.
 * The clock's progress is stored as it goes, so an item whose playlist is empty is skipped.
 */
async function clockPick(ctx: AppContext, tx: Tx, station: Station, s: AutodjSettings, musicSeconds: number, skipped: string[]): Promise<ClockPick | null> {
  const schedule = await loadSchedule(tx, station);
  if (!schedule.settings.enabled) return null;
  const now = Date.now();
  // The track that starts now (loaded last) ends when the next one starts.
  const [loading] = await tx
    .select({ item: schema.queueItems, media: playTimes })
    .from(schema.queueItems)
    .innerJoin(schema.mediaFiles, eq(schema.mediaFiles.id, schema.queueItems.mediaId))
    .where(and(eq(schema.queueItems.stationId, station.id), inArray(schema.queueItems.state, ['cued', 'loaded', 'playing'])))
    .orderBy(desc(schema.queueItems.cuedAt))
    .limit(1);
  const base = loading?.item.startedAt?.getTime() ?? now;
  const at = Math.max(now, base + (loading ? (playSeconds(loading.media, s.crossfadeSeconds) ?? 0) : 0) * 1000);
  const [row] = await tx.select().from(schema.autodjState).where(eq(schema.autodjState.stationId, station.id));
  let state: ClockState = { hour: row?.clockHour?.getTime() ?? null, clockId: row?.clockId ?? null, step: row?.clockStep ?? 0, done: row?.clockDone ?? 0 };
  const save = (st: ClockState) => {
    const v = { clockHour: st.hour === null ? null : new Date(st.hour), clockId: st.clockId, clockStep: st.step, clockDone: st.done };
    return tx.insert(schema.autodjState).values({ stationId: station.id, ...v }).onConflictDoUpdate({ target: schema.autodjState.stationId, set: v });
  };
  const playlists = new Map((await tx.select().from(schema.playlists).where(eq(schema.playlists.stationId, station.id))).map((p) => [p.id, p] as const));
  for (let attempt = 0; attempt < 20; attempt++) {
    const d = decide({ at, now, tz: schedule.settings.timezone, clockAt: schedule.clockAt, state, musicSeconds });
    state = d.state;
    let track: MediaFile | null = null;
    let label: string | null = null;
    let playlistId: string | null = null;
    let locked = false;
    if (d.kind === 'music') {
      await save(state);
      const p = d.playlistId ? playlists.get(d.playlistId) : undefined;
      if (!p) return null;
      track = await pickTrack(tx, station, s, p);
      // An empty playlist: the queues play instead.
      if (!track) return null;
      label = d.label;
      playlistId = p.id;
    } else {
      const { item } = d;
      let news: Awaited<ReturnType<typeof newsTrack>> = null;
      if (item.kind === 'news') {
        // The bulletin for the news at the item's minute, or the spare jingle.
        const hour = d.state.hour ?? at;
        const clock = d.state.clockId ? schedule.clocks.get(d.state.clockId) : undefined;
        let slot = hour;
        if (clock) for (let k = 0; k <= d.state.step; k++) if (anchorOf(clock.items, k) !== null) slot = hour + anchorOf(clock.items, k)! * 60_000;
        news = await newsTrack(ctx, tx, station, slot);
        track = news?.media ?? null;
      } else if (item.kind === 'track' && item.mediaId) {
        [track = null] = await tx
          .select()
          .from(schema.mediaFiles)
          .where(and(eq(schema.mediaFiles.id, item.mediaId), eq(schema.mediaFiles.stationId, station.id), eq(schema.mediaFiles.enabled, true)));
      } else if (item.kind === 'playlist' && item.playlistId && playlists.has(item.playlistId)) {
        playlistId = item.playlistId;
        track = await pickTrack(tx, station, s, playlists.get(item.playlistId)!, { clock: true });
      }
      if (!track) {
        skipped.push(item.label || (item.playlistId ? (playlists.get(item.playlistId)?.name ?? 'a removed playlist') : item.kind));
        state = skipItem(state);
        continue;
      }
      await save(state);
      label = item.label || news?.label || (playlistId ? playlists.get(playlistId)!.name : null);
      locked = !!item.locked;
    }
    const [queued] = await tx
      .insert(schema.queueItems)
      .values({ stationId: station.id, queue: 'q1', mediaId: track.id, position: await top(tx, station.id, 'q1'), origin: d.kind === 'item' ? 'clock' : 'rotation', playlistId, label, locked })
      .returning();
    return { item: queued!, media: track, cutAt: d.kind === 'item' ? d.cutAt : null };
  }
  await save(state);
  return null;
}

/**
 * The player asks for its next track: top up the queues, follow the hour clock when the station has a schedule, else
 * choose the queue by the rule, take its first track and mark it cued. Missing files are dropped from the queue.
 * Returns null when the library has nothing to play; `cutAt` asks to cut the playing track then (hard timed item).
 */
export async function nextTrack(
  ctx: AppContext,
  stationId: string,
): Promise<{ uri: string; itemId: string; cutAt: number | null; skipped: string[] } | null> {
  const skipped: string[] = [];
  return ctx.db.transaction(async (tx) => {
    await lock(tx, stationId);
    const [station] = await tx.select().from(schema.stations).where(eq(schema.stations.id, stationId));
    if (!station) return null;
    const s = autodjSettings(station);
    await refill(tx, station, s);
    const sources = await loadSources(tx, stationId);
    for (let attempt = 0; attempt < 10; attempt++) {
      const heads = await tx
        .select({ item: schema.queueItems, media: schema.mediaFiles })
        .from(schema.queueItems)
        .innerJoin(schema.mediaFiles, eq(schema.mediaFiles.id, schema.queueItems.mediaId))
        .where(and(eq(schema.queueItems.stationId, stationId), eq(schema.queueItems.state, 'queued')))
        .orderBy(asc(schema.queueItems.position))
        .limit(200);
      let pick = heads[0];
      const scheduled = await clockPick(ctx, tx, station, s, pick?.media.durationSeconds ?? 210, skipped);
      if (scheduled) pick = scheduled;
      if (!pick) {
        // The queue is empty (no playlists, or nothing left in them): any track from the library.
        const track = await pickTrack(tx, station, s, null);
        if (!track) return null;
        const [item] = await tx.insert(schema.queueItems).values({ stationId, queue: 'q1', mediaId: track.id, position: await top(tx, stationId, 'q1'), origin: 'rotation' }).returning();
        pick = { item: item!, media: track };
      }
      const full = mediaPath(ctx, pick.media, sources);
      if (!full || !(await stat(full).then((st) => st.isFile()).catch(() => false))) {
        await tx.delete(schema.queueItems).where(eq(schema.queueItems.id, pick.item.id));
        continue;
      }
      // One track is cued: the one that goes on air next. When the player still holds one that is not on air yet
      // (manual playout waiting for Play, or its start not reported yet), this one is loaded behind it.
      const [ahead] = await tx
        .select({ id: schema.queueItems.id })
        .from(schema.queueItems)
        .where(and(eq(schema.queueItems.stationId, stationId), eq(schema.queueItems.state, 'cued')))
        .limit(1);
      await tx.update(schema.queueItems).set({ state: ahead ? 'loaded' : 'cued', cuedAt: new Date() }).where(eq(schema.queueItems.id, pick.item.id));
      await tx
        .insert(schema.autodjState)
        .values({ stationId, lastQueue: 'q1', streak: 0, seenAt: new Date() })
        .onConflictDoUpdate({ target: schema.autodjState.stationId, set: { seenAt: new Date() } });
      // Keep the queue full for the panel.
      await refill(tx, station, s);
      return { uri: requestUri({ id: pick.item.id, queue: pick.item.queue }, pick.media, full, s), itemId: pick.item.id, cutAt: scheduled?.cutAt ?? null, skipped };
    }
    return null;
  });
}

/**
 * The clock or schedule changed while the player runs (issue #27). The player loads its next track when the one before
 * starts, so a hard timed item that now falls before the playing track ends would wait for that loaded track and start
 * late. Then the loaded track goes back into the queue and true is returned: the player must drop it and ask again, so
 * the planner cues the item with a cut on its minute.
 */
export async function flushForClock(ctx: AppContext, stationId: string, now = Date.now()): Promise<boolean> {
  return ctx.db.transaction(async (tx) => {
    await lock(tx, stationId);
    const [station] = await tx.select().from(schema.stations).where(eq(schema.stations.id, stationId));
    if (!station) return false;
    const schedule = await loadSchedule(tx, station);
    if (!schedule.settings.enabled) return false;
    const rows = await tx
      .select({ item: schema.queueItems, media: playTimes })
      .from(schema.queueItems)
      .innerJoin(schema.mediaFiles, eq(schema.mediaFiles.id, schema.queueItems.mediaId))
      .where(and(eq(schema.queueItems.stationId, stationId), inArray(schema.queueItems.state, ['cued', 'loaded', 'playing'])));
    const playing = rows.find((r) => r.item.state === 'playing');
    if (!playing?.item.startedAt || !rows.some((r) => r.item.state !== 'playing')) return false;
    const ends = playing.item.startedAt.getTime() + (playSeconds(playing.media, autodjSettings(station).crossfadeSeconds) ?? 0) * 1000;
    const [row] = await tx.select().from(schema.autodjState).where(eq(schema.autodjState.stationId, stationId));
    const h = hourStart(now, schedule.settings.timezone);
    const needed = [
      { hour: h, clock: schedule.clockAt(now) },
      { hour: h + 3_600_000, clock: schedule.clockAt(h + 3_600_000) },
    ].some(({ hour, clock }) =>
      clock?.items.some((item, i) => {
        const a = anchorOf(clock.items, i);
        if (a === null || !item.hard) return false;
        const time = hour + a * 60_000;
        // Past already, or the playing track ends before it: the next request handles it as usual.
        if (time <= now - 5000 || ends <= time + 1000) return false;
        // The clock already played it this hour.
        const started = row?.clockHour?.getTime() === hour && row.clockId === clock.id && (row.clockStep > i || (row.clockStep === i && row.clockDone > 0));
        return !started;
      }),
    );
    if (!needed) return false;
    await tx.update(schema.queueItems).set({ state: 'queued', cuedAt: null }).where(and(eq(schema.queueItems.stationId, stationId), inArray(schema.queueItems.state, ['cued', 'loaded'])));
    return true;
  });
}

/**
 * A DJ plays a track now (RHIS Studio: dragged onto the player): a waiting track, or a library track that goes on top of
 * Q1 first. Checks the track and returns its item id; the streams service then hands it to the player (cueNow).
 */
export async function playNow(ctx: AppContext, stationId: string, what: { itemId: string } | { mediaId: string }, addedBy: string | null) {
  const itemId = 'itemId' in what ? what.itemId : (await enqueue(ctx, stationId, what.mediaId, 'q1', { at: 'top', origin: 'manual', addedBy })).id;
  await ctx.db.transaction(async (tx) => {
    await lock(tx, stationId);
    const [item] = await tx.select().from(schema.queueItems).where(and(eq(schema.queueItems.id, itemId), eq(schema.queueItems.stationId, stationId)));
    if (!item) throw notFound('Queue item');
    if (item.state === 'playing') throw badRequest('This track is on air already');
  });
  return itemId;
}

/**
 * Loads a waiting track for play now: marked cued and handed to the player on its own, outside the queue rule and the
 * hour clock. 'loaded' when the player has it loaded ahead already; null when it is gone or its file is missing.
 */
export async function cueNow(ctx: AppContext, stationId: string, itemId: string): Promise<{ uri: string; itemId: string } | 'loaded' | null> {
  return ctx.db.transaction(async (tx) => {
    await lock(tx, stationId);
    const [station] = await tx.select().from(schema.stations).where(eq(schema.stations.id, stationId));
    const [row] = await tx
      .select({ item: schema.queueItems, media: schema.mediaFiles })
      .from(schema.queueItems)
      .innerJoin(schema.mediaFiles, eq(schema.mediaFiles.id, schema.queueItems.mediaId))
      .where(and(eq(schema.queueItems.id, itemId), eq(schema.queueItems.stationId, stationId)));
    if (!station || !row || row.item.state === 'playing') return null;
    if (row.item.state === 'cued' || row.item.state === 'loaded') return 'loaded';
    const full = mediaPath(ctx, row.media, await loadSources(tx, stationId));
    if (!full || !(await stat(full).then((st) => st.isFile()).catch(() => false))) return null;
    // It plays before the track the player loaded ahead, which waits behind it until this one is on air.
    await tx.update(schema.queueItems).set({ state: 'loaded' }).where(and(eq(schema.queueItems.stationId, stationId), eq(schema.queueItems.state, 'cued')));
    await tx.update(schema.queueItems).set({ state: 'cued', cuedAt: new Date() }).where(eq(schema.queueItems.id, itemId));
    return { uri: requestUri({ id: itemId, queue: row.item.queue }, row.media, full, autodjSettings(station)), itemId };
  });
}

/** The player started a track: it is on air now, the previous one is done. */
export async function trackStarted(ctx: AppContext, stationId: string, itemId: string) {
  await ctx.db.transaction(async (tx) => {
    await lock(tx, stationId);
    const [item] = await tx.select().from(schema.queueItems).where(and(eq(schema.queueItems.id, itemId), eq(schema.queueItems.stationId, stationId)));
    await tx.delete(schema.queueItems).where(and(eq(schema.queueItems.stationId, stationId), eq(schema.queueItems.state, 'playing'), ne(schema.queueItems.id, itemId)));
    await tx.insert(schema.autodjState).values({ stationId, seenAt: new Date() }).onConflictDoUpdate({ target: schema.autodjState.stationId, set: { seenAt: new Date() } });
    const now = new Date();
    if (item) await tx.update(schema.queueItems).set({ state: 'playing', startedAt: now }).where(eq(schema.queueItems.id, item.id));
    await promoteLoaded(tx, stationId);
    if (!item) return;
    await tx
      .update(schema.mediaFiles)
      .set({ lastPlayedAt: now, playCount: sql`${schema.mediaFiles.playCount} + 1` })
      .where(eq(schema.mediaFiles.id, item.mediaId));
    if (item.requestId) {
      await tx
        .update(schema.songRequests)
        .set({ status: 'played', handledAt: now, handledBy: sql`coalesce(${schema.songRequests.handledBy}, 'AutoDJ')` })
        .where(eq(schema.songRequests.id, item.requestId));
    }
  });
}

/**
 * After a track went on air, exactly one of the tracks the player has loaded is cued: the one it loaded first (or the
 * one played now), the others are loaded behind it. This also tidies queues from before the `loaded` state, which
 * could have two cued tracks.
 */
async function promoteLoaded(tx: Tx, stationId: string) {
  const rows = await tx
    .select({ id: schema.queueItems.id, state: schema.queueItems.state })
    .from(schema.queueItems)
    .where(and(eq(schema.queueItems.stationId, stationId), inArray(schema.queueItems.state, ['cued', 'loaded'])))
    .orderBy(asc(schema.queueItems.cuedAt));
  const cued = rows.filter((r) => r.state === 'cued');
  const keep = cued[0] ?? rows[0];
  if (!keep) return;
  if (keep.state !== 'cued') await tx.update(schema.queueItems).set({ state: 'cued' }).where(eq(schema.queueItems.id, keep.id));
  const extra = cued.slice(1).map((r) => r.id);
  if (extra.length) await tx.update(schema.queueItems).set({ state: 'loaded' }).where(inArray(schema.queueItems.id, extra));
}

/** The player (re)started: tracks it had loaded ahead go back to waiting, nothing of ours is on air yet. */
export async function playerStarted(ctx: AppContext, stationId: string) {
  await ctx.db.transaction(async (tx) => {
    await lock(tx, stationId);
    await tx.update(schema.queueItems).set({ state: 'queued', cuedAt: null }).where(and(eq(schema.queueItems.stationId, stationId), inArray(schema.queueItems.state, ['cued', 'loaded'])));
    await tx.delete(schema.queueItems).where(and(eq(schema.queueItems.stationId, stationId), eq(schema.queueItems.state, 'playing')));
    await tx.insert(schema.autodjState).values({ stationId, seenAt: new Date() }).onConflictDoUpdate({ target: schema.autodjState.stationId, set: { seenAt: new Date() } });
  });
}

/** Puts a library track in a queue, at the top (before the waiting tracks; requests after earlier requests) or at the bottom. */
export async function enqueue(
  ctx: AppContext,
  stationId: string,
  mediaId: string,
  queue: Queue,
  opts: { at?: 'top' | 'bottom'; origin?: 'manual' | 'request'; requestId?: string | null; addedBy?: string | null } = {},
) {
  return ctx.db.transaction(async (tx) => {
    await lock(tx, stationId);
    const [media] = await tx.select().from(schema.mediaFiles).where(and(eq(schema.mediaFiles.id, mediaId), eq(schema.mediaFiles.stationId, stationId)));
    if (!media) throw notFound('Track');
    const position =
      opts.at === 'top' ? (opts.origin === 'request' ? await afterRequests(tx, stationId, queue) : await top(tx, stationId, queue)) : await bottom(tx, stationId, queue);
    const [item] = await tx
      .insert(schema.queueItems)
      .values({ stationId, queue, mediaId, position, origin: opts.origin ?? 'manual', requestId: opts.requestId ?? null, addedBy: opts.addedBy ?? null })
      .returning();
    return item!;
  });
}

/** Moves a waiting track to a queue, before another track (or to the end). */
export async function moveItem(ctx: AppContext, stationId: string, itemId: string, queue: Queue, beforeId: string | null) {
  await ctx.db.transaction(async (tx) => {
    await lock(tx, stationId);
    const [item] = await tx.select().from(schema.queueItems).where(and(eq(schema.queueItems.id, itemId), eq(schema.queueItems.stationId, stationId)));
    if (!item) throw notFound('Queue item');
    if (item.state !== 'queued') throw badRequest('This track is already loaded by the player');
    let position: number;
    if (beforeId) {
      const rows = await tx
        .select({ id: schema.queueItems.id, position: schema.queueItems.position, state: schema.queueItems.state })
        .from(schema.queueItems)
        .where(and(eq(schema.queueItems.stationId, stationId), eq(schema.queueItems.queue, queue), ne(schema.queueItems.id, itemId)))
        .orderBy(asc(schema.queueItems.position));
      const i = rows.findIndex((r) => r.id === beforeId);
      if (i < 0) throw badRequest('That track is not in this queue');
      if (rows[i]!.state !== 'queued') throw badRequest('Tracks cannot go before the track the player has loaded');
      position = i === 0 ? rows[0]!.position - 1 : (rows[i - 1]!.position + rows[i]!.position) / 2;
    } else position = await bottom(tx, stationId, queue);
    await tx.update(schema.queueItems).set({ queue, position }).where(eq(schema.queueItems.id, item.id));
  });
}

/** Removes waiting tracks; `rotationOnly` clears what the playlists added (they refill on the next track). */
export async function clearQueue(ctx: AppContext, stationId: string, queue: Queue, rotationOnly: boolean) {
  await ctx.db.transaction(async (tx) => {
    await lock(tx, stationId);
    await tx
      .delete(schema.queueItems)
      .where(and(eq(schema.queueItems.stationId, stationId), eq(schema.queueItems.queue, queue), eq(schema.queueItems.state, 'queued'), rotationOnly ? eq(schema.queueItems.origin, 'rotation') : undefined));
  });
}

/**
 * Fills the queues now, so the panel shows what is coming. `fresh` first removes the waiting tracks the playlists
 * added (after the rules or playlists changed); requests and tracks added by hand stay.
 */
export async function fillQueues(ctx: AppContext, stationId: string, fresh = false) {
  await ctx.db.transaction(async (tx) => {
    await lock(tx, stationId);
    if (fresh) {
      await tx
        .delete(schema.queueItems)
        .where(and(eq(schema.queueItems.stationId, stationId), eq(schema.queueItems.state, 'queued'), eq(schema.queueItems.origin, 'rotation')));
    }
    const [station] = await tx.select().from(schema.stations).where(eq(schema.stations.id, stationId));
    if (station) await refill(tx, station, autodjSettings(station));
  });
}

export interface QueueRow {
  id: string;
  queue: Queue;
  state: 'queued' | 'cued' | 'loaded' | 'playing';
  origin: string;
  position: number;
  addedBy: string | null;
  requestId: string | null;
  playlistName: string | null;
  /** Clock item it came from. */
  label: string | null;
  locked: boolean;
  startedAt: Date | null;
  media: { id: string; title: string; artist: string; album: string; durationSeconds: number | null; location: string; path: string } & Cues;
}

/** Everything in the queues, first to last, with the track on air: on air, cued, loaded behind it, then waiting. */
export async function queueRows(ctx: AppContext, stationId: string): Promise<QueueRow[]> {
  const rows = await ctx.db
    .select({ item: schema.queueItems, media: schema.mediaFiles, playlistName: schema.playlists.name })
    .from(schema.queueItems)
    .innerJoin(schema.mediaFiles, eq(schema.mediaFiles.id, schema.queueItems.mediaId))
    .leftJoin(schema.playlists, eq(schema.playlists.id, schema.queueItems.playlistId))
    .where(eq(schema.queueItems.stationId, stationId))
    .orderBy(
      desc(sql`${schema.queueItems.state} = 'playing'`),
      desc(sql`${schema.queueItems.state} = 'cued'`),
      desc(sql`${schema.queueItems.state} = 'loaded'`),
      asc(schema.queueItems.position),
    );
  return rows.map(({ item, media, playlistName }) => ({
    id: item.id,
    queue: item.queue,
    state: item.state,
    origin: item.origin,
    position: item.position,
    addedBy: item.addedBy,
    requestId: item.requestId,
    playlistName,
    label: item.label,
    locked: item.locked,
    startedAt: item.startedAt,
    media: {
      id: media.id,
      title: media.title,
      artist: media.artist,
      album: media.album,
      durationSeconds: media.durationSeconds,
      location: media.location,
      path: media.path,
      cueIn: media.cueIn,
      cueIntro: media.cueIntro,
      cueSegue: media.cueSegue,
      cueFadeOut: media.cueFadeOut,
      cueOut: media.cueOut,
    },
  }));
}

/** Removes the queue entries of tracks that are switched off or deleted from playlists' reach. */
export async function dropDisabled(ctx: AppContext, stationId: string, mediaIds: string[]) {
  if (!mediaIds.length) return;
  await ctx.db
    .delete(schema.queueItems)
    .where(and(eq(schema.queueItems.stationId, stationId), eq(schema.queueItems.state, 'queued'), inArray(schema.queueItems.mediaId, mediaIds)));
}
