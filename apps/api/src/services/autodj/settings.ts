import { z } from 'zod';
import type { Station } from '../streaming/state.js';

/**
 * How the AutoDJ picks the next track from its two queues:
 * - alternate: Q1, Q2, Q1, Q2, …
 * - ratio: `q1` tracks from Q1, then `q2` tracks from Q2
 * - q1_first / q2_first: that queue whenever it has a track, the other one only when it is empty
 * An empty queue never stops the music: the other queue plays instead.
 */
export const queueRuleSchema = z.object({
  mode: z.enum(['alternate', 'ratio', 'q1_first', 'q2_first']).default('ratio'),
  q1: z.number().int().min(1).max(20).default(3),
  q2: z.number().int().min(1).max(20).default(1),
});

/** AutoDJ settings of a Radio station. Changes to format-independent settings take effect at the next track. */
export const autodjSchema = z.object({
  enabled: z.boolean().default(false),
  /** The private source mount the AutoDJ feeds; the default mount falls back to it when no DJ is live. */
  mountId: z.uuid().nullable().default(null),
  /** Overlap between tracks in seconds; 0 = none. Changing it restarts the player (a second of silence). */
  crossfadeSeconds: z.number().min(0).max(15).default(3),
  /** Even out loudness with the ReplayGain tags of the files. */
  normalize: z.boolean().default(true),
  rule: queueRuleSchema.default({ mode: 'ratio', q1: 3, q2: 1 }),
  /** Tracks kept waiting in each queue; playlists top the queues up to this. */
  queueDepth: z.number().int().min(1).max(50).default(5),
  /** Fill a queue from its playlists. Off = only tracks added by hand and requests. */
  fill: z.object({ q1: z.boolean().default(true), q2: z.boolean().default(true) }).default({ q1: true, q2: true }),
  /** Minutes before the same artist may play again, and the same track. Relaxed when nothing else is left. */
  artistSeparationMinutes: z.number().int().min(0).max(1440).default(45),
  trackSeparationMinutes: z.number().int().min(0).max(10080).default(180),
  /** Hold the AutoDJ while a DJ is live on a mount that falls back to it, and continue with a new track afterwards. */
  pauseWhenLive: z.boolean().default(true),
  requests: z
    .object({
      /** Listeners pick a track from the library on the public page. */
      fromLibrary: z.boolean().default(true),
      /** Requests go straight into the queue; off = a DJ accepts them first. */
      autoQueue: z.boolean().default(true),
      queue: z.enum(['q1', 'q2']).default('q1'),
      /** Minutes before a track can be requested again after it played. */
      repeatMinutes: z.number().int().min(0).max(1440).default(60),
    })
    .default({ fromLibrary: true, autoQueue: true, queue: 'q1', repeatMinutes: 60 }),
});
export type AutodjSettings = z.infer<typeof autodjSchema>;

export function autodjSettings(station: Pick<Station, 'autodj'>): AutodjSettings {
  const parsed = autodjSchema.safeParse(station.autodj ?? {});
  return parsed.success ? parsed.data : autodjSchema.parse({});
}

/** The AutoDJ plays for this station: Radio station edition, switched on and with its mount. */
export const autodjActive = (station: Pick<Station, 'edition' | 'autodj'>) => {
  const s = autodjSettings(station);
  return station.edition === 'station' && s.enabled && !!s.mountId;
};
