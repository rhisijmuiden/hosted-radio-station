import { and, eq } from 'drizzle-orm';
import { schema } from '../../db/index.js';
import type { Db } from '../../db/index.js';
import type { Station } from '../streaming/state.js';
import { blockAt } from './schedule.js';
import { schedulerSettings, type SchedulerSettings } from './settings.js';

export type Clock = typeof schema.clocks.$inferSelect;
export type ScheduleEntry = typeof schema.scheduleEntries.$inferSelect;
type Reader = Pick<Db, 'select'>;

export interface LoadedSchedule {
  settings: SchedulerSettings;
  clocks: Map<string, Clock>;
  entries: ScheduleEntry[];
  /** The block that runs at a moment. */
  entryAt: (t: number) => ScheduleEntry | null;
  /** The clock that runs at a moment: the block's, else the default clock outside blocks. */
  clockAt: (t: number) => Clock | null;
}

/** A station's schedule and clocks, ready to answer "what runs when". */
export async function loadSchedule(db: Reader, station: Pick<Station, 'id' | 'scheduler'>): Promise<LoadedSchedule> {
  const settings = schedulerSettings(station);
  const [clocks, entries] = await Promise.all([
    db.select().from(schema.clocks).where(eq(schema.clocks.stationId, station.id)),
    db
      .select()
      .from(schema.scheduleEntries)
      .where(and(eq(schema.scheduleEntries.stationId, station.id), eq(schema.scheduleEntries.enabled, true))),
  ]);
  const byId = new Map(clocks.map((c) => [c.id, c] as const));
  const entryAt = (t: number) => blockAt(entries, t, settings.timezone);
  const clockAt = (t: number) => {
    const e = entryAt(t);
    const id = e ? e.clockId : settings.defaultClockId;
    return (id && byId.get(id)) || null;
  };
  return { settings, clocks: byId, entries, entryAt, clockAt };
}
