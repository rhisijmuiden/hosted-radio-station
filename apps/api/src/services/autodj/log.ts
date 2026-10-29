import { and, asc, eq, inArray, isNotNull, isNull, lt, notInArray, or, sql } from 'drizzle-orm';
import { schema } from '../../db/index.js';
import type { AppContext } from '../../lib/context.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { hourStart } from '../scheduler/time.js';
import { NEWS, type MediaFile } from './library.js';
import { playSeconds } from './cues.js';
import { appendRotation, clockContext, clockCursor, clockStep, nextStart, slotKey, type ClockCursor, type Tx } from './planner.js';

const HOUR = 3_600_000;
/** Steps the plan makes at most, so a clock of very short items cannot run away. */
const MAX_STEPS = 400;

type QueueItem = typeof schema.queueItems.$inferSelect;

export interface LogRow {
  /** Stable key for the list: the queue item, or the place in the clock for a fixed track or the news. */
  key: string;
  at: Date;
  state: 'playing' | 'cued' | 'loaded' | 'planned';
  /** queue = the queue (rotation, requests, added by hand); playlist = music of a clock playlist; item = a clock item. */
  source: 'queue' | 'playlist' | 'item' | 'track' | 'news';
  /** The queue item behind the row, to change it; null for a fixed track or the news. */
  itemId: string | null;
  editable: boolean;
  locked: boolean;
  /** A hard timed item: it cuts the track before it at its minute. */
  hard: boolean;
  /** The track gets cut by a hard timed item before its end. */
  cut: boolean;
  origin: string | null;
  addedBy: string | null;
  label: string | null;
  media: Pick<MediaFile, 'id' | 'title' | 'artist' | 'durationSeconds' | 'code' | 'bpm' | 'musicKey'> | null;
  /** How long it plays until the next row starts. */
  seconds: number | null;
}

export interface LogHour {
  hour: Date;
  clock: { id: string; name: string; color: string } | null;
  show: { id: string; name: string; live: boolean } | null;
}

export interface LogPlan {
  timezone: string;
  /** The station runs hour clocks; without them the log is the queue. */
  scheduled: boolean;
  until: Date;
  hours: LogHour[];
  rows: LogRow[];
}

const mediaOut = (m: MediaFile): LogRow['media'] => ({ id: m.id, title: m.title, artist: m.artist, durationSeconds: m.durationSeconds, code: m.code, bpm: m.bpm, musicKey: m.musicKey });

/** The same lock as the planner's: the player, the panel and the log editor change the queue one at a time. */
async function lock(tx: Tx, stationId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`autodj:${stationId}`}))`);
}

/**
 * The log of the coming hours as the AutoDJ will play it: the hour clocks are run ahead from where the player is, with
 * the real tracks. Picks of clock playlists are planned (kept as picks waiting for their place, so the player plays
 * exactly them) and the queue is filled far enough; both can be changed in the log editor. Fixed tracks and the news
 * come from the clock and only show. Without hour clocks the log is the queue.
 */
export async function planLog(ctx: AppContext, stationId: string, hours: number): Promise<LogPlan> {
  return ctx.db.transaction(async (tx) => {
    await lock(tx, stationId);
    const [station] = await tx.select().from(schema.stations).where(eq(schema.stations.id, stationId));
    if (!station) throw notFound('Station');
    const c = await clockContext(tx, station);
    const { s, schedule } = c;
    const tz = schedule.settings.timezone;
    const scheduled = schedule.settings.enabled;
    const now = Date.now();
    const until = hourStart(now, tz) + hours * HOUR;
    const rows: LogRow[] = [];
    const qi = schema.queueItems;

    // What the player holds already: on air, cued and loaded behind it.
    const held = await tx
      .select({ item: qi, media: schema.mediaFiles })
      .from(qi)
      .innerJoin(schema.mediaFiles, eq(schema.mediaFiles.id, qi.mediaId))
      .where(and(eq(qi.stationId, stationId), inArray(qi.state, ['playing', 'cued', 'loaded'])))
      .orderBy(asc(qi.cuedAt));
    held.sort((a, b) => Number(b.item.state === 'playing') - Number(a.item.state === 'playing'));
    let t = now;
    let prevStart = now;
    for (const h of held) {
      const start = h.item.state === 'playing' ? (h.item.startedAt?.getTime() ?? now) : t;
      const seconds = playSeconds(h.media, s.crossfadeSeconds);
      rows.push(row(h.item, h.media, start, h.item.state as LogRow['state'], seconds, h.item.origin === 'clock' ? 'item' : 'queue'));
      prevStart = start;
      t = start + (seconds ?? 0) * 1000;
    }
    t = Math.max(t, await nextStart(tx, stationId, s, now));

    // The waiting queue, in the order it plays.
    const queue = await tx
      .select({ item: qi, media: schema.mediaFiles })
      .from(qi)
      .innerJoin(schema.mediaFiles, eq(schema.mediaFiles.id, qi.mediaId))
      .where(and(eq(qi.stationId, stationId), eq(qi.state, 'queued'), isNull(qi.slot)))
      .orderBy(asc(qi.position));
    let q = 0;
    const nextFromQueue = async () => queue[q++] ?? (await appendRotation(tx, station, s));

    let cursor: ClockCursor = await clockCursor(tx, stationId);
    const visited = new Set<string>();
    for (let n = 0; n < MAX_STEPS && t < until; n++) {
      const musicSeconds = queue[q]?.media.durationSeconds ?? 210;
      const step = scheduled ? await clockStep(ctx, tx, c, { at: t, now: prevStart, prev: cursor, musicSeconds, plan: true }, []) : null;
      if (step) cursor = step.cursor;
      let start = t;
      if (!step || step.kind === 'queue') {
        const next = await nextFromQueue();
        if (!next) break;
        const seconds = playSeconds(next.media, s.crossfadeSeconds);
        rows.push(row(next.item, next.media, start, 'planned', seconds, 'queue', step?.label || undefined));
        prevStart = start;
        t = start + (seconds || 180) * 1000;
        continue;
      }
      if (step.cutAt != null && step.cutAt < t) {
        start = step.cutAt;
        const last = rows.at(-1);
        if (last) {
          last.cut = true;
          last.seconds = Math.max(0, Math.round((start - last.at.getTime()) / 1000));
        }
      }
      const key = slotKey(step.cursor);
      let item: QueueItem | null = step.planned;
      if (!item && step.plannable) {
        // Planned now, so the player plays this very pick and it can be changed.
        [item = null] = await tx
          .insert(qi)
          .values({
            stationId,
            queue: 'q1',
            mediaId: step.media.id,
            position: 0,
            origin: step.fromItem ? 'clock' : 'rotation',
            playlistId: step.playlistId,
            label: step.label,
            locked: step.locked,
            slot: key,
            slotHour: step.cursor.state.hour === null ? null : new Date(step.cursor.state.hour),
          })
          .returning();
      }
      if (item?.slot) visited.add(item.slot);
      const seconds = playSeconds(step.media, s.crossfadeSeconds);
      const source = step.itemKind === null ? 'playlist' : step.itemKind === 'news' ? 'news' : step.itemKind === 'track' ? 'track' : 'item';
      const r = item ? row(item, step.media, start, 'planned', seconds, source) : fixedRow(key, step.media, start, seconds, source);
      r.locked = step.locked;
      r.hard = step.hard && step.fromItem;
      r.label = step.label;
      r.editable = !!item && !step.locked;
      rows.push(r);
      prevStart = start;
      t = start + (seconds || 180) * 1000;
    }

    // Picks planned before for places the clock no longer gets to (the clock or the timing changed).
    await tx.delete(qi).where(
      and(
        eq(qi.stationId, stationId),
        eq(qi.state, 'queued'),
        isNotNull(qi.slot),
        or(lt(qi.slotHour, new Date(hourStart(now, tz) - HOUR)), and(lt(qi.slotHour, new Date(until)), visited.size ? notInArray(qi.slot, [...visited]) : undefined)),
      ),
    );

    const hoursOut: LogHour[] = [];
    for (let h = hourStart(now, tz); h < until; h += HOUR) {
      const clock = scheduled ? schedule.clockAt(h) : null;
      const entry = scheduled ? schedule.entryAt(h) : null;
      hoursOut.push({ hour: new Date(h), clock: clock && { id: clock.id, name: clock.name, color: clock.color }, show: entry && { id: entry.id, name: entry.name, live: entry.live } });
    }
    return { timezone: tz, scheduled, until: new Date(until), hours: hoursOut, rows };
  });
}

function row(item: QueueItem, media: MediaFile, at: number, state: LogRow['state'], seconds: number | null, source: LogRow['source'], label?: string | null): LogRow {
  return {
    key: item.id,
    at: new Date(at),
    state,
    source,
    itemId: item.id,
    editable: state === 'planned' && !item.locked,
    locked: item.locked,
    hard: false,
    cut: false,
    origin: item.origin,
    addedBy: item.addedBy,
    label: label === undefined ? item.label : label,
    media: mediaOut(media),
    seconds: seconds == null ? null : Math.round(seconds),
  };
}

function fixedRow(key: string, media: MediaFile, at: number, seconds: number | null, source: LogRow['source']): LogRow {
  return { key: `fixed:${key}`, at: new Date(at), state: 'planned', source, itemId: null, editable: false, locked: false, hard: false, cut: false, origin: 'clock', addedBy: null, label: null, media: mediaOut(media), seconds: seconds == null ? null : Math.round(seconds) };
}

/** A waiting row of the log that may change: in the queue or planned, not loaded by the player, not locked. */
async function editableItem(tx: Tx, stationId: string, itemId: string) {
  const [item] = await tx.select().from(schema.queueItems).where(and(eq(schema.queueItems.id, itemId), eq(schema.queueItems.stationId, stationId)));
  if (!item) throw notFound('Log item');
  if (item.state !== 'queued') throw badRequest('This track is already loaded by the player');
  if (item.locked) throw badRequest('This is a locked part of the format');
  return item;
}

/** Places another library track on a row of the log. */
export async function replaceInLog(ctx: AppContext, stationId: string, itemId: string, mediaId: string, by: string | null) {
  await ctx.db.transaction(async (tx) => {
    await lock(tx, stationId);
    await editableItem(tx, stationId, itemId);
    const [media] = await tx
      .select({ id: schema.mediaFiles.id, location: schema.mediaFiles.location })
      .from(schema.mediaFiles)
      .where(and(eq(schema.mediaFiles.id, mediaId), eq(schema.mediaFiles.stationId, stationId), eq(schema.mediaFiles.enabled, true)));
    if (!media || media.location === NEWS) throw notFound('Track');
    await tx.update(schema.queueItems).set({ mediaId, addedBy: by }).where(eq(schema.queueItems.id, itemId));
  });
}

/** Swaps the tracks of two rows of the log; the rows keep their place in the format. */
export async function swapInLog(ctx: AppContext, stationId: string, a: string, b: string) {
  if (a === b) return;
  await ctx.db.transaction(async (tx) => {
    await lock(tx, stationId);
    const x = await editableItem(tx, stationId, a);
    const y = await editableItem(tx, stationId, b);
    await tx.update(schema.queueItems).set({ mediaId: y.mediaId, addedBy: y.addedBy }).where(eq(schema.queueItems.id, x.id));
    await tx.update(schema.queueItems).set({ mediaId: x.mediaId, addedBy: x.addedBy }).where(eq(schema.queueItems.id, y.id));
  });
}

/** Takes a row out of the log: a planned pick is picked again, a queue track leaves the queue. */
export async function removeFromLog(ctx: AppContext, stationId: string, itemId: string) {
  await ctx.db.transaction(async (tx) => {
    await lock(tx, stationId);
    await editableItem(tx, stationId, itemId);
    await tx.delete(schema.queueItems).where(eq(schema.queueItems.id, itemId));
  });
}
