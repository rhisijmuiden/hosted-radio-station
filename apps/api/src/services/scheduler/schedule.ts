import { addDays, wallTime, weekdayOf, zonedInstant } from './time.js';

/** The fields of a schedule block that decide when it runs. */
export interface Block {
  id: string;
  days: number[];
  date: string | null;
  startMinute: number;
  durationMinutes: number;
  enabled: boolean;
}

/** Does the block run on this date (YYYY-MM-DD)? */
const runsOn = (b: Block, date: string) => (b.date ? b.date === date : b.days.includes(weekdayOf(date)));

/**
 * The block that runs at `t`. One-off blocks win over weekly ones; between blocks of the same kind the one that started
 * last wins, so a show inside a longer block takes over for its length.
 */
export function blockAt<B extends Block>(blocks: B[], t: number, tz: string): B | null {
  const w = wallTime(t, tz);
  const yesterday = addDays(w.date, -1);
  let best: { b: B; once: boolean; start: number } | null = null;
  for (const b of blocks) {
    if (!b.enabled) continue;
    let start: number | null = null;
    if (runsOn(b, w.date) && w.minuteOfDay >= b.startMinute && w.minuteOfDay < b.startMinute + b.durationMinutes) start = b.startMinute;
    // Started yesterday and runs past midnight.
    else if (runsOn(b, yesterday) && w.minuteOfDay < b.startMinute + b.durationMinutes - 1440) start = b.startMinute - 1440;
    if (start === null) continue;
    const once = !!b.date;
    if (!best || (once && !best.once) || (once === best.once && start > best.start)) best = { b, once, start };
  }
  return best?.b ?? null;
}

export interface Occurrence<B> {
  block: B;
  start: number;
  end: number;
}

/** The runs of the blocks that overlap [from, to), in order of start. Blocks hidden by others are still listed. */
export function occurrences<B extends Block>(blocks: B[], from: number, to: number, tz: string): Occurrence<B>[] {
  const out: Occurrence<B>[] = [];
  const first = addDays(wallTime(from, tz).date, -1);
  const days = Math.ceil((to - from) / 86_400_000) + 2;
  for (let i = 0; i <= days; i++) {
    const date = addDays(first, i);
    for (const b of blocks) {
      if (!b.enabled || !runsOn(b, date)) continue;
      const start = zonedInstant(date, b.startMinute, tz);
      const end = zonedInstant(date, b.startMinute + b.durationMinutes, tz);
      if (end > from && start < to) out.push({ block: b, start, end });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}
