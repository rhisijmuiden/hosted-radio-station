import { z } from 'zod';
import type { Station } from '../streaming/state.js';

export const isTimeZone = (tz: string) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

/** Scheduler settings of a Radio station: hour clocks, the weekly schedule and live shows. */
export const schedulerSchema = z.object({
  /** Run the schedule and its hour clocks. Off = the AutoDJ plays its queues only. */
  enabled: z.boolean().default(false),
  /** Time zone the schedule and the clocks' minutes are in. */
  timezone: z.string().refine(isTimeZone, 'Unknown time zone').default('Europe/Amsterdam'),
  /** Clock for the hours without a block in the schedule; null = the queues only. */
  defaultClockId: z.uuid().nullable().default(null),
  /** DJs of live shows may only broadcast during their own shows (accounts without a show are not limited). */
  liveOnlyInShows: z.boolean().default(false),
  /** Minutes before their show that DJs may connect (to check their sound). */
  liveEarlyMinutes: z.number().int().min(0).max(60).default(10),
  /** List the shows on the public page. */
  publicSchedule: z.boolean().default(true),
});
export type SchedulerSettings = z.infer<typeof schedulerSchema>;

export function schedulerSettings(station: Pick<Station, 'scheduler'>): SchedulerSettings {
  const parsed = schedulerSchema.safeParse(station.scheduler ?? {});
  return parsed.success ? parsed.data : schedulerSchema.parse({});
}
