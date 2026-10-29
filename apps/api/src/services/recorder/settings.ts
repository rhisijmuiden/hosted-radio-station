import { z } from 'zod';

/** Bitrates a logging recording can have (MP3, kbps). */
export const LOGGING_BITRATES = [32, 48, 64, 96, 128] as const;

/**
 * What a recorder node records of a station (phase 21), set per station. Logging = a continuous recording of the
 * station's default stream at a low bitrate, in files of one hour, kept for `loggingDays` days on the recorder.
 */
export const recordingSchema = z.object({
  logging: z.boolean().default(true),
  loggingKbps: z
    .number()
    .int()
    .refine((v) => (LOGGING_BITRATES as readonly number[]).includes(v), `Use one of ${LOGGING_BITRATES.join(', ')} kbps`)
    .default(64),
  loggingDays: z.number().int().min(1).max(366).default(31),
});
export type StationRecording = z.infer<typeof recordingSchema>;

export const stationRecording = (s: { recording?: Record<string, unknown> | null }): StationRecording => {
  const r = recordingSchema.safeParse(s.recording ?? {});
  return r.success ? r.data : recordingSchema.parse({});
};

export const recordingPatch = recordingSchema.partial();
