import { and, eq, inArray } from 'drizzle-orm';
import { schema } from '../../db/index.js';
import type { AppContext } from '../../lib/context.js';
import type { Station } from '../streaming/state.js';
import { occurrences } from './schedule.js';
import { schedulerSettings } from './settings.js';

export interface PublicShow {
  name: string;
  description: string;
  live: boolean;
  /** Names of the show's DJs. */
  djs: string[];
  start: string;
  end: string;
}

/** The schedule is shown to listeners: Radio station with a running schedule that is set to be public. */
export const scheduleIsPublic = (station: Pick<Station, 'edition' | 'scheduler'>) => {
  const s = schedulerSettings(station);
  return station.edition === 'station' && s.enabled && s.publicSchedule;
};

/**
 * The public blocks of a station from now on for `days` days. A block that is hidden by another one (a show inside a
 * longer block) is cut around it, so listeners see what runs when.
 */
export async function publicShows(ctx: AppContext, station: Pick<Station, 'id' | 'edition' | 'scheduler'>, days = 7, now = Date.now()) {
  const s = schedulerSettings(station);
  if (!scheduleIsPublic(station)) return { timezone: s.timezone, onAir: null, upcoming: [] as PublicShow[] };
  const entries = await ctx.db
    .select()
    .from(schema.scheduleEntries)
    .where(and(eq(schema.scheduleEntries.stationId, station.id), eq(schema.scheduleEntries.enabled, true)));
  const accountIds = [...new Set(entries.flatMap((e) => (e.live ? e.accountIds : [])))];
  const accounts = accountIds.length
    ? await ctx.db
        .select({ id: schema.stationAccounts.id, username: schema.stationAccounts.username, displayName: schema.stationAccounts.displayName })
        .from(schema.stationAccounts)
        .where(inArray(schema.stationAccounts.id, accountIds))
    : [];
  const names = new Map(accounts.map((a) => [a.id, a.displayName || a.username] as const));
  const runs = occurrences(entries, now, now + days * 86_400_000, s.timezone);
  // Cut every run where a block that wins over it runs (one-off blocks, else the one that started later).
  const wins = (a: (typeof runs)[number], b: (typeof runs)[number]) => (!!a.block.date !== !!b.block.date ? !!a.block.date : a.start > b.start);
  const shown: { block: (typeof entries)[number]; start: number; end: number }[] = [];
  for (const r of runs) {
    let pieces = [{ start: r.start, end: r.end }];
    for (const o of runs) {
      if (o === r || !wins(o, r)) continue;
      pieces = pieces.flatMap((p) =>
        o.end <= p.start || o.start >= p.end ? [p] : [{ start: p.start, end: o.start }, { start: o.end, end: p.end }].filter((x) => x.end - x.start >= 60_000),
      );
    }
    for (const p of pieces) if (p.end > now) shown.push({ block: r.block, ...p });
  }
  shown.sort((a, b) => a.start - b.start);
  const toShow = (x: (typeof shown)[number]): PublicShow => ({
    name: x.block.name,
    description: x.block.description,
    live: x.block.live,
    djs: x.block.live ? x.block.accountIds.map((id) => names.get(id)).filter((n): n is string => !!n) : [],
    start: new Date(x.start).toISOString(),
    end: new Date(x.end).toISOString(),
  });
  const visible = shown.filter((x) => x.block.isPublic);
  const current = shown.find((x) => x.start <= now && now < x.end);
  return {
    timezone: s.timezone,
    onAir: current?.block.isPublic ? toShow(current) : null,
    upcoming: visible.filter((x) => x !== current).map(toShow),
  };
}
