import { sql } from 'drizzle-orm';
import type { AppContext } from '../../lib/context.js';
import { schedulerSettings } from '../scheduler/settings.js';
import { addDays, wallTime, zonedInstant } from '../scheduler/time.js';
import type { Station } from '../streaming/state.js';

/**
 * Reports of the music a station played, for the collecting societies (phase 21 step 5): Buma/Stemra asks for every
 * play with its makers, SENA for every recording with how often and to how many listeners it was played. Plays come
 * from the title changes of the station's source mounts (song_plays), completed with the library (ISRC, composer,
 * label) when the title is a track of the station, and with the DJ when someone was live.
 */

export interface PlayRow {
  startedAt: Date;
  endedAt: Date | null;
  /** Date and time in the station's time zone. */
  date: string;
  time: string;
  durationSeconds: number;
  artist: string;
  title: string;
  composer: string;
  album: string;
  label: string;
  year: number | null;
  isrc: string;
  code: string;
  source: 'autodj' | 'live';
  dj: string | null;
  mount: string;
  avgListeners: number;
  peakListeners: number;
  /** Listening hours during the play: the station's listeners minute by minute. */
  listenerHours: number;
}

export interface TrackRow {
  artist: string;
  title: string;
  composer: string;
  album: string;
  label: string;
  isrc: string;
  code: string;
  plays: number;
  totalSeconds: number;
  listenerHours: number;
  firstPlayed: Date;
  lastPlayed: Date;
}

/** A period of whole days in the station's time zone: from the start of `from` to the end of `to`. */
export function reportPeriod(station: Pick<Station, 'scheduler'>, from: string, to: string) {
  const tz = schedulerSettings(station).timezone;
  return { tz, start: new Date(zonedInstant(from, 0, tz)), end: new Date(zonedInstant(addDays(to, 1), 0, tz)) };
}

/** "Artist - Title" as stream titles carry them; without a dash the whole text is the title. */
export function splitTitle(raw: string) {
  const i = raw.indexOf(' - ');
  return i > 0 ? { artist: raw.slice(0, i).trim(), title: raw.slice(i + 3).trim() } : { artist: '', title: raw.trim() };
}

const num = (v: unknown) => (v == null ? 0 : Number(v));
const two = (n: number) => String(n).padStart(2, '0');

/** Every play in the period, oldest first. Plays shorter than `minSeconds` (jingles, idents) are left out. */
export async function rightsPlays(ctx: AppContext, station: Station, from: string, to: string, minSeconds = 30): Promise<PlayRow[]> {
  const { tz, start, end } = reportPeriod(station, from, to);
  const result = (await ctx.db.execute(sql`
    select p.started_at, p.ended_at, p.title as stream_title, p.mount_path, p.listeners_start, p.listeners_peak,
      m.artist, m.title, m.composer, m.album, m.label, m.year, m.isrc, m.code, m.duration_seconds,
      l.account_name as dj,
      (select coalesce(sum(x.avg), 0) from listener_samples x
        where x.station_id = p.station_id and x.target = '*' and x.at >= date_trunc('minute', p.started_at) and x.at < coalesce(p.ended_at, p.started_at + make_interval(secs => coalesce(m.duration_seconds, 0)))) as listener_minutes,
      (select max(x.peak) from listener_samples x
        where x.station_id = p.station_id and x.target = '*' and x.at >= date_trunc('minute', p.started_at) and x.at < coalesce(p.ended_at, p.started_at + make_interval(secs => coalesce(m.duration_seconds, 0)))) as sample_peak
    from song_plays p
    left join lateral (
      select f.artist, f.title, f.composer, f.album, f.label, f.year, f.isrc, f.code, f.duration_seconds from media_files f
      where f.station_id = p.station_id and lower(f.artist || ' - ' || f.title) = lower(p.title)
      order by (f.isrc <> '') desc, f.created_at limit 1
    ) m on true
    left join lateral (
      select s.account_name from live_sessions s
      where s.station_id = p.station_id and s.started_at <= p.started_at + interval '5 seconds' and (s.ended_at is null or s.ended_at > p.started_at)
      order by s.started_at desc limit 1
    ) l on true
    where p.station_id = ${station.id} and p.started_at >= ${start.toISOString()}::timestamptz and p.started_at < ${end.toISOString()}::timestamptz
      -- The same title on a second source mount at the same moment is one play.
      and not exists (select 1 from song_plays q where q.station_id = p.station_id and q.title = p.title and q.mount_path < p.mount_path
        and q.started_at between p.started_at - interval '30 seconds' and p.started_at + interval '30 seconds')
    order by p.started_at, p.mount_path`)) as unknown as Record<string, unknown>[];
  const out: PlayRow[] = [];
  for (const r of result) {
    const startedAt = new Date(r.started_at as string);
    const endedAt = r.ended_at ? new Date(r.ended_at as string) : null;
    const duration = endedAt ? (endedAt.getTime() - startedAt.getTime()) / 1000 : num(r.duration_seconds);
    if (duration < minSeconds) continue;
    const split = splitTitle(String(r.stream_title));
    const w = wallTime(startedAt.getTime(), tz);
    const minutes = Math.max(1, Math.ceil(duration / 60));
    const listenerMinutes = num(r.listener_minutes);
    out.push({
      startedAt,
      endedAt,
      date: w.date,
      time: `${two(w.hour)}:${two(w.minute)}:${two(w.second)}`,
      durationSeconds: Math.round(duration),
      artist: (r.artist as string | null) ?? split.artist,
      title: (r.title as string | null) ?? split.title,
      composer: (r.composer as string | null) ?? '',
      album: (r.album as string | null) ?? '',
      label: (r.label as string | null) ?? '',
      year: r.year == null ? null : num(r.year),
      isrc: (r.isrc as string | null) ?? '',
      code: (r.code as string | null) ?? '',
      source: r.dj ? 'live' : 'autodj',
      dj: (r.dj as string | null) ?? null,
      mount: String(r.mount_path),
      avgListeners: Math.round((listenerMinutes / minutes) * 10) / 10,
      peakListeners: Math.max(num(r.listeners_peak), num(r.sample_peak)),
      listenerHours: Math.round((listenerMinutes / 60) * 100) / 100,
    });
  }
  return out;
}

/** The plays per recording: one line per ISRC, or per artist and title when there is none. Most played first. */
export function rightsTracks(plays: PlayRow[]): TrackRow[] {
  const byKey = new Map<string, TrackRow>();
  for (const p of plays) {
    const key = p.isrc || `${p.artist.toLowerCase()}\n${p.title.toLowerCase()}`;
    const t = byKey.get(key);
    if (!t) {
      byKey.set(key, { artist: p.artist, title: p.title, composer: p.composer, album: p.album, label: p.label, isrc: p.isrc, code: p.code, plays: 1, totalSeconds: p.durationSeconds, listenerHours: p.listenerHours, firstPlayed: p.startedAt, lastPlayed: p.startedAt });
      continue;
    }
    t.plays++;
    t.totalSeconds += p.durationSeconds;
    t.listenerHours = Math.round((t.listenerHours + p.listenerHours) * 100) / 100;
    t.lastPlayed = p.startedAt;
    for (const k of ['composer', 'album', 'label', 'isrc', 'code'] as const) if (!t[k] && p[k]) t[k] = p[k];
  }
  return [...byKey.values()].sort((a, b) => b.plays - a.plays || a.artist.localeCompare(b.artist) || a.title.localeCompare(b.title));
}

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : String(v);
  return `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replaceAll('"', '""')}"`;
};
/** Comma-separated, every cell quoted, CRLF, with a BOM so Excel reads UTF-8. */
export const toCsv = (lines: unknown[][]) => `﻿${lines.map((l) => l.map(csvCell).join(',')).join('\r\n')}\r\n`;

const mmss = (s: number) => `${Math.floor(s / 60)}:${two(s % 60)}`;

export const playsCsv = (rows: PlayRow[]) =>
  toCsv([
    ['date', 'time', 'duration', 'duration_seconds', 'artist', 'title', 'composer', 'album', 'label', 'year', 'isrc', 'track_code', 'source', 'dj', 'mount', 'avg_listeners', 'peak_listeners', 'listener_hours'],
    ...rows.map((r) => [r.date, r.time, mmss(r.durationSeconds), r.durationSeconds, r.artist, r.title, r.composer, r.album, r.label, r.year, r.isrc, r.code, r.source, r.dj, r.mount, r.avgListeners, r.peakListeners, r.listenerHours]),
  ]);

export const tracksCsv = (rows: TrackRow[]) =>
  toCsv([
    ['artist', 'title', 'composer', 'album', 'label', 'isrc', 'track_code', 'plays', 'total_duration', 'total_seconds', 'listener_hours', 'first_played', 'last_played'],
    ...rows.map((r) => [r.artist, r.title, r.composer, r.album, r.label, r.isrc, r.code, r.plays, mmss(r.totalSeconds), r.totalSeconds, r.listenerHours, r.firstPlayed, r.lastPlayed]),
  ]);
