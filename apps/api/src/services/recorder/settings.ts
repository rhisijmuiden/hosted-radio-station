import { z } from 'zod';

/** Bitrates a logging recording can have (MP3, kbps). */
export const LOGGING_BITRATES = [32, 48, 64, 96, 128] as const;

/**
 * What a recorder node records of a station (phase 21), set per station. Logging = a continuous recording of the
 * station's default stream at a low bitrate, in files of one hour, kept for `loggingDays` days on the recorder.
 * Shows = every live broadcast (Go Live in RHIS Studio, or an encoder), recorded as it is sent, one file per show;
 * shows shorter than `showsMinMinutes` (a DJ testing) are thrown away. A finished show becomes an on-demand item
 * when `showsOnDemand` is on (step 3). `deleteUploaded` removes a recording from the recorder once every upload
 * destination that takes it has it.
 */
export const recordingSchema = z.object({
  logging: z.boolean().default(true),
  loggingKbps: z
    .number()
    .int()
    .refine((v) => (LOGGING_BITRATES as readonly number[]).includes(v), `Use one of ${LOGGING_BITRATES.join(', ')} kbps`)
    .default(64),
  loggingDays: z.number().int().min(1).max(366).default(31),
  shows: z.boolean().default(true),
  showsDays: z.number().int().min(1).max(3650).default(90),
  showsMinMinutes: z.number().int().min(0).max(120).default(2),
  showsOnDemand: z.boolean().default(true),
  deleteUploaded: z.boolean().default(false),
});
export type StationRecording = z.infer<typeof recordingSchema>;

export const stationRecording = (s: { recording?: Record<string, unknown> | null }): StationRecording => {
  const r = recordingSchema.safeParse(s.recording ?? {});
  return r.success ? r.data : recordingSchema.parse({});
};

export const recordingPatch = recordingSchema.partial();
