import type { ClockItem } from '../../db/schema.js';
import { hourStart } from './time.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** A timed item that is due this late when the player picks it up again (after a pause) is skipped. */
const LATE = 5 * MINUTE;
/** A hard timed item starts this much early rather than playing a few seconds of a song. */
const HARD_EARLY = 15_000;

export interface ClockLike {
  id: string;
  items: ClockItem[];
}

/** Where the station is in its hour clock (stored in autodj_state). */
export interface ClockState {
  /** Start of the hour being played (ms), null = none. */
  hour: number | null;
  clockId: string | null;
  /** Index of the item in progress, and tracks played of it (rotation: 1 once it started). */
  step: number;
  done: number;
}

export type Decision =
  /** Music: from the queues (playlistId null) or from one playlist. */
  | { kind: 'music'; playlistId: string | null; label: string | null; state: ClockState }
  /** One track of a clock item; `cutAt` = cut the track that plays at that moment (hard timing). */
  | { kind: 'item'; item: ClockItem; state: ClockState; cutAt: number | null };

export interface DecideInput {
  /** When the next track will start: the end of the track that is playing now. */
  at: number;
  /** The real time. */
  now: number;
  tz: string;
  /** The clock of the schedule at a moment (null = the queues only). */
  clockAt: (t: number) => ClockLike | null;
  state: ClockState;
  /** Length of the music track that would play next, to see whether a timed item is better started first. */
  musicSeconds: number;
}

/** Minute of the hour an item is timed at; the first item of a clock starts the hour. */
export const anchorOf = (items: ClockItem[], i: number) => items[i]?.at ?? (i === 0 ? 0 : null);

/** Items that play music until the next timed item. */
export const isFill = (item: ClockItem) => item.kind === 'rotation' || (item.kind === 'playlist' && item.count === 0);

/**
 * The item to start with when a clock is picked up in the middle of an hour (start, after a pause, or when the schedule
 * changes): the last timed item that is due, unless it is more than a few minutes late; then the music after it.
 */
export function entryStep(items: ClockItem[], hour: number, at: number) {
  let k = -1;
  for (let i = 0; i < items.length; i++) {
    const a = anchorOf(items, i);
    if (a !== null && hour + a * MINUTE <= at) k = i;
  }
  if (k === -1) return 0;
  if (hour + anchorOf(items, k)! * MINUTE + LATE >= at) return k;
  for (let i = k + 1; i < items.length; i++) if (anchorOf(items, i) !== null || isFill(items[i]!)) return i;
  return items.length;
}

/**
 * Decides what the AutoDJ plays next under an hour clock. Timed items start at the track change nearest to their
 * minute (soft) or cut the track that plays at their minute (hard). Items without a minute follow the one before; a
 * rotation item plays music until the next timed item is due. When an hour's items are done, music plays until the
 * next hour's clock starts. Pure: the caller stores the returned state.
 */
export function decide(input: DecideInput): Decision {
  const { at, now, tz, clockAt, musicSeconds } = input;
  const h = hourStart(at, tz);
  const current = clockAt(at);
  const ahead = clockAt(h + HOUR);
  let st: ClockState = { ...input.state };
  let hour: number;
  let clock: ClockLike | null;
  if (st.hour === h + HOUR && st.clockId === (ahead?.id ?? null)) {
    // The next hour's clock already started (its first item went just before the hour).
    hour = st.hour;
    clock = ahead;
  } else if (st.hour === h && st.clockId === (current?.id ?? null)) {
    hour = h;
    clock = current;
  } else {
    hour = h;
    clock = current;
    st = { hour: h, clockId: current?.id ?? null, step: current ? entryStep(current.items, h, at) : 0, done: 0 };
  }

  const due = (time: number, hard: boolean) => (hard ? at >= time - HARD_EARLY : at >= time || at + (musicSeconds * 1000) / 2 >= time);
  const cut = (time: number, hard: boolean) => (hard && at > time + 1000 && time > now - 5000 ? Math.max(time, now) : null);
  const nextHour = () => {
    const nh = hour + HOUR;
    const nc = clockAt(nh);
    if (!nc?.items.length) return null;
    return { time: nh + (nc.items[0]!.at ?? 0) * MINUTE, hard: nc.items[0]!.hard, nh, nc };
  };
  /** The next timed item after `step`: in this hour, else the start of the next hour's clock. */
  const nextAnchor = (items: ClockItem[], step: number) => {
    for (let i = step + 1; i < items.length; i++) {
      const a = anchorOf(items, i);
      if (a !== null) return { time: hour + a * MINUTE, hard: items[i]!.hard };
    }
    return nextHour();
  };
  const music = (playlistId: string | null = null, label: string | null = null): Decision => ({ kind: 'music', playlistId, label, state: st });

  for (let guard = 0; guard < 200; guard++) {
    const items = clock?.items ?? [];
    if (st.step >= items.length) {
      const na = nextHour();
      if (na && due(na.time, na.hard)) {
        hour = na.nh;
        clock = na.nc;
        st = { hour, clockId: clock.id, step: 0, done: 0 };
        continue;
      }
      return music();
    }
    const item = items[st.step]!;
    const a = anchorOf(items, st.step);
    let cutAt: number | null = null;
    if (a !== null && st.done === 0) {
      const time = hour + a * MINUTE;
      // Not yet: music until it is.
      if (!due(time, item.hard)) return music();
      cutAt = cut(time, item.hard);
    }
    if (isFill(item)) {
      const na = nextAnchor(items, st.step);
      if (na && due(na.time, na.hard)) {
        st = { ...st, step: st.step + 1, done: 0 };
        continue;
      }
      st = { ...st, done: 1 };
      return music(item.kind === 'playlist' ? item.playlistId : null, item.label || null);
    }
    const count = item.kind === 'track' ? 1 : Math.max(1, item.count);
    if (st.done < count) {
      st = { ...st, done: st.done + 1 };
      return { kind: 'item', item, state: st, cutAt: st.done === 1 ? cutAt : null };
    }
    st = { ...st, step: st.step + 1, done: 0 };
  }
  return music();
}

/** Skips the rest of the item the state is at (its playlist was empty or its track is gone). */
export const skipItem = (state: ClockState): ClockState => ({ ...state, done: 1_000 });
