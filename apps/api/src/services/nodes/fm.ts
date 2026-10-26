import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '../../db/index.js';
import type { AppContext } from '../../lib/context.js';
import { publicShows } from '../scheduler/public.js';
import { schedulerSettings } from '../scheduler/settings.js';
import type { FmPlan } from './protocol.js';

/**
 * Settings of an FM/MPX node (phase 11), kept in the node's config under `fm`. One node is one transmitter: one
 * station, one MPX output, optionally one RDS encoder over UECP.
 */
export const fmConfigSchema = z.object({
  stationId: z.uuid().nullable().default(null),
  /** Mount path to put on air; null = the station's default mount. */
  mount: z.string().max(100).nullable().default(null),

  // RDS
  rds: z.boolean().default(true),
  pi: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[0-9A-F]{4}$/, 'The PI code is 4 hexadecimal characters')
    .default('8000'),
  ps: z.string().max(8).default(''),
  psMode: z.enum(['static', 'dynamic']).default('static'),
  psSeconds: z.number().int().min(2).max(15).default(4),
  rtSong: z.string().max(120).default('{artist} - {title}'),
  rtLive: z.string().max(120).default('{dj} live on {station}'),
  rtIdle: z.string().max(120).default('{station}'),
  rtPlus: z.boolean().default(true),
  pty: z.number().int().min(0).max(31).default(0),
  tp: z.boolean().default(false),
  ta: z.boolean().default(false),
  music: z.boolean().default(true),
  af: z.array(z.number().min(87.6).max(107.9)).max(25).default([]),
  clock: z.boolean().default(true),

  // Audio and MPX
  stereo: z.boolean().default(true),
  preemphasis: z.union([z.literal(0), z.literal(50), z.literal(75)]).default(50),
  limiter: z.boolean().default(true),
  /** Pilot and RDS injection as a share of 100% modulation. */
  pilot: z.number().min(0.06).max(0.12).default(0.09),
  rdsLevel: z.number().min(0.01).max(0.1).default(0.04),
  gainDb: z.number().min(-24).max(12).default(0),
  bufferSeconds: z.number().min(0.5).max(10).default(1.5),

  // Output
  output: z.enum(['soundcard', 'rtp', 'none']).default('soundcard'),
  device: z
    .string()
    .trim()
    .max(100)
    .regex(/^[A-Za-z0-9:,_.=-]*$/, 'Invalid sound card device')
    .default('default'),
  channels: z.union([z.literal(1), z.literal(2)]).default(2),
  rtpHost: z
    .string()
    .trim()
    .max(253)
    .regex(/^[A-Za-z0-9.:-]*$/, 'Invalid address')
    .default(''),
  rtpPort: z.number().int().min(1024).max(65535).default(5004),
  rtpTtl: z.number().int().min(1).max(64).default(16),

  // UECP to an existing RDS encoder
  uecp: z.boolean().default(false),
  uecpTransport: z.enum(['tcp', 'udp', 'serial']).default('tcp'),
  uecpHost: z
    .string()
    .trim()
    .max(253)
    .regex(/^[A-Za-z0-9.:-]*$/, 'Invalid address')
    .default(''),
  uecpPort: z.number().int().min(1).max(65535).default(4001),
  uecpDevice: z
    .string()
    .trim()
    .regex(/^\/dev\/tty[A-Za-z0-9]{1,20}$/, 'Use a serial device such as /dev/ttyUSB0')
    .default('/dev/ttyUSB0'),
  uecpBaud: z.union([z.literal(1200), z.literal(2400), z.literal(4800), z.literal(9600), z.literal(19200), z.literal(38400), z.literal(57600), z.literal(115200)]).default(9600),
  uecpSite: z.number().int().min(0).max(1023).default(0),
  uecpEncoder: z.number().int().min(0).max(63).default(0),
});
export type FmSettings = z.infer<typeof fmConfigSchema>;

export const fmSettings = (raw: unknown): FmSettings => {
  const r = fmConfigSchema.safeParse(raw ?? {});
  return r.success ? r.data : fmConfigSchema.parse({});
};

/** What the plan of an FM node holds; null when it has no station (yet). */
export async function buildFmPlan(ctx: AppContext, c: FmSettings, base: string, stations: { id: string; slug: string; name: string }[]): Promise<FmPlan | null> {
  const station = c.stationId ? stations.find((s) => s.id === c.stationId) : undefined;
  if (!station) return null;
  const [row] = await ctx.db.select({ scheduler: schema.stations.scheduler }).from(schema.stations).where(eq(schema.stations.id, station.id));
  const mounts = await ctx.db
    .select({ path: schema.stationMounts.path, isDefault: schema.stationMounts.isDefault })
    .from(schema.stationMounts)
    .where(and(eq(schema.stationMounts.stationId, station.id), eq(schema.stationMounts.isPublic, true)))
    .orderBy(asc(schema.stationMounts.sortOrder), asc(schema.stationMounts.createdAt));
  const mount = mounts.find((m) => m.path === c.mount) ?? mounts.find((m) => m.isDefault) ?? mounts[0];
  return {
    station,
    url: mount ? `${base}/listen/${station.slug}${mount.path}` : null,
    texts: { ps: c.ps, psMode: c.psMode, psSeconds: c.psSeconds, rtSong: c.rtSong, rtLive: c.rtLive, rtIdle: c.rtIdle },
    rds: { enabled: c.rds, pi: parseInt(c.pi, 16), pty: c.pty, tp: c.tp, ta: c.ta, music: c.music, af: c.af, rtPlus: c.rtPlus, clock: c.clock, timezone: row ? schedulerSettings(row).timezone : 'Europe/Amsterdam' },
    audio: { stereo: c.stereo, preemphasis: c.preemphasis, limiter: c.limiter, pilot: c.pilot, rdsLevel: c.rdsLevel, gainDb: c.gainDb, bufferSeconds: c.bufferSeconds },
    output: { kind: c.output === 'rtp' && !c.rtpHost ? 'none' : c.output, device: c.device || 'default', channels: c.channels, rtpHost: c.rtpHost, rtpPort: c.rtpPort, rtpTtl: c.rtpTtl },
    uecp:
      c.uecp && (c.uecpTransport === 'serial' || c.uecpHost)
        ? { transport: c.uecpTransport, host: c.uecpHost, port: c.uecpPort, device: c.uecpDevice, baud: c.uecpBaud, site: c.uecpSite, encoder: c.uecpEncoder }
        : null,
  };
}

/**
 * Who is live and which show runs on a station, for the RadioText of its FM nodes. The song itself the node reads
 * from the stream, so its text changes exactly when the music does.
 */
export async function fmContext(ctx: AppContext, stationId: string): Promise<{ dj: string | null; show: string | null }> {
  const [station] = await ctx.db.select().from(schema.stations).where(eq(schema.stations.id, stationId));
  if (!station) return { dj: null, show: null };
  const [live] = await ctx.db
    .select({ name: schema.liveSessions.accountName, displayName: schema.stationAccounts.displayName })
    .from(schema.liveSessions)
    .leftJoin(schema.stationAccounts, eq(schema.stationAccounts.id, schema.liveSessions.accountId))
    .where(and(eq(schema.liveSessions.stationId, stationId), isNull(schema.liveSessions.endedAt)))
    .orderBy(desc(schema.liveSessions.startedAt))
    .limit(1);
  let show: string | null = null;
  const s = schedulerSettings(station);
  if (station.edition === 'station' && s.enabled) {
    // The FM display shows the show even when the schedule is not on the public page.
    const shows = await publicShows(ctx, { ...station, scheduler: { ...s, publicSchedule: true } }, 1).catch(() => null);
    show = shows?.onAir?.name ?? null;
  }
  return { dj: live ? live.displayName || live.name : null, show };
}
