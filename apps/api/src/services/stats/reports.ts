import { sql, type SQL } from 'drizzle-orm';
import type { AppContext } from '../../lib/context.js';
import { getSetting, type StatisticsSettings } from '../settings.js';

/** What a report covers: a set of stations, a period and the time zone for days and hours. */
export interface Scope {
  stationIds: string[];
  from: Date;
  to: Date;
  tz: string;
  /** Only this mount (local listeners) or output (external server). */
  mount?: string;
}

type Row = Record<string, unknown>;
const rows = async <T = Row>(ctx: AppContext, q: SQL) => (await ctx.db.execute(q)) as unknown as T[];
const num = (v: unknown) => (v == null ? 0 : Number(v));
const ids = (list: string[]) => sql.join(list.map((id) => sql`${id}::uuid`), sql`, `);

export const BUCKETS = [
  { name: '1m', minutes: 1 },
  { name: '5m', minutes: 5 },
  { name: '15m', minutes: 15 },
  { name: '1h', minutes: 60 },
  { name: '3h', minutes: 180 },
  { name: '1d', minutes: 1440 },
  { name: '1w', minutes: 10080 },
] as const;

/** Bucket size that gives at most ~300 points for the period. */
export function pickBucket(from: Date, to: Date) {
  const minutes = (to.getTime() - from.getTime()) / 60_000;
  return BUCKETS.find((b) => minutes / b.minutes <= 300) ?? BUCKETS.at(-1)!;
}

/** Minute samples exist for the whole period and are worth using (short periods). */
function useSamples(s: Scope, bucketMinutes: number, settings: StatisticsSettings) {
  return bucketMinutes < 60 && s.from.getTime() > Date.now() - settings.sampleRetentionDays * 86400_000;
}

const target = (s: Scope) => (s.mount ? (s.mount.startsWith('output:') || s.mount.startsWith('node:') ? s.mount : `mount:${s.mount}`) : '*');

/** Listeners over time: average and peak per bucket, summed over the stations. */
export async function timeseries(ctx: AppContext, s: Scope) {
  if (!s.stationIds.length) return { bucket: pickBucket(s.from, s.to).name, points: [] as { t: string; avg: number; peak: number }[] };
  const settings = await getSetting(ctx, 'statistics');
  const b = pickBucket(s.from, s.to);
  const fromSamples = useSamples(s, b.minutes, settings);
  const table = fromSamples ? sql`listener_samples` : sql`listener_hourly`;
  const col = fromSamples ? sql`at` : sql`hour`;
  // Missing minutes (nothing on air) count as zero listeners: the average is the sum divided by the bucket length.
  const perUnit = fromSamples ? 1 : 60;
  const bucketExpr =
    b.minutes >= 1440
      ? sql`(date_trunc(${b.minutes === 1440 ? 'day' : 'week'}, ${col} at time zone ${s.tz}) at time zone ${s.tz})`
      : sql`date_bin(${`${b.minutes} minutes`}::interval, ${col}, timestamptz '2000-01-03 00:00:00+00')`;
  const result = await rows<{ t: Date; avg: number; peak: number }>(
    ctx,
    sql`
      with per_station as (
        select ${bucketExpr} as t, station_id, sum(avg) * ${perUnit} as minutes, max(peak) as peak
        from ${table}
        where station_id in (${ids(s.stationIds)}) and target = ${target(s)} and ${col} >= ${s.from.toISOString()}::timestamptz and ${col} < ${s.to.toISOString()}::timestamptz
        group by 1, 2
      )
      select t, sum(minutes) as minutes, sum(peak) as peak from per_station group by t order by t`,
  );
  const span = (t: Date) => {
    // The bucket's length in minutes, clipped to the period and to now.
    const start = Math.max(new Date(t).getTime(), s.from.getTime());
    const len = b.minutes >= 1440 ? (b.minutes === 1440 ? 1440 : 10080) : b.minutes;
    const end = Math.min(new Date(t).getTime() + len * 60_000, s.to.getTime(), Date.now());
    return Math.max(1, (end - start) / 60_000);
  };
  return {
    bucket: b.name,
    points: result.map((r) => {
      const minutes = num((r as unknown as { minutes: unknown }).minutes);
      return { t: new Date(r.t).toISOString(), avg: Math.round((minutes / span(r.t)) * 10) / 10, peak: num(r.peak) };
    }),
  };
}

/** Listening hours, average and peak listeners from the counts (local and external servers alike). */
async function audienceTotals(ctx: AppContext, s: Scope, settings: StatisticsSettings) {
  const recent = s.from.getTime() > Date.now() - settings.sampleRetentionDays * 86400_000;
  const where = sql`station_id in (${ids(s.stationIds)}) and target = ${target(s)}`;
  const [tot] = recent
    ? await rows(ctx, sql`select coalesce(sum(avg), 0) / 60.0 as hours from listener_samples where ${where} and at >= ${s.from.toISOString()}::timestamptz and at < ${s.to.toISOString()}::timestamptz`)
    : await rows(ctx, sql`select coalesce(sum(avg), 0) as hours from listener_hourly where ${where} and hour >= ${s.from.toISOString()}::timestamptz and hour < ${s.to.toISOString()}::timestamptz`);
  const [peak] = recent
    ? await rows(ctx, sql`select at as t, sum(peak) as peak from listener_samples where ${where} and at >= ${s.from.toISOString()}::timestamptz and at < ${s.to.toISOString()}::timestamptz group by at order by 2 desc, 1 desc limit 1`)
    : await rows(ctx, sql`select hour as t, sum(peak) as peak from listener_hourly where ${where} and hour >= ${s.from.toISOString()}::timestamptz and hour < ${s.to.toISOString()}::timestamptz group by hour order by 2 desc, 1 desc limit 1`);
  const hours = num(tot?.hours);
  const spanHours = Math.max(1 / 60, (Math.min(s.to.getTime(), Date.now()) - s.from.getTime()) / 3600_000);
  return { listeningHours: Math.round(hours * 10) / 10, avgListeners: Math.round((hours / spanHours) * 10) / 10, peakListeners: num(peak?.peak), peakAt: peak?.t ? new Date(peak.t as string).toISOString() : null };
}

/** Sessions that overlap the period, minus too-short ones and (optionally) bots. */
function sessionFilter(s: Scope, settings: StatisticsSettings) {
  const mount = s.mount
    ? s.mount.startsWith('output:')
      ? sql`and output_id = ${s.mount.slice(7)}::uuid`
      : s.mount.startsWith('node:')
        ? sql`and node_id = ${s.mount.slice(5)}::uuid`
        : sql`and mount_path = ${s.mount} and output_id is null and node_id is null`
    : sql``;
  return sql`station_id in (${ids(s.stationIds)})
    and started_at < ${s.to.toISOString()}::timestamptz
    and (ended_at is null or ended_at > ${s.from.toISOString()}::timestamptz)
    and coalesce(duration_seconds, extract(epoch from now() - started_at)) >= ${settings.minSessionSeconds}
    ${settings.excludeBots ? sql`and coalesce(device, '') <> 'bot'` : sql``}
    ${mount}`;
}

/** Seconds of a session inside the period. */
const overlap = (s: Scope) =>
  sql`greatest(0, extract(epoch from least(coalesce(ended_at, now()), ${s.to.toISOString()}::timestamptz) - greatest(started_at, ${s.from.toISOString()}::timestamptz)))`;

export async function kpis(ctx: AppContext, s: Scope) {
  const empty = { listeningHours: 0, avgListeners: 0, peakListeners: 0, peakAt: null as string | null, sessions: 0, uniqueListeners: 0, avgSessionSeconds: 0, countries: 0 };
  if (!s.stationIds.length) return empty;
  const settings = await getSetting(ctx, 'statistics');
  const [a, [b]] = await Promise.all([
    audienceTotals(ctx, s, settings),
    rows(
      ctx,
      sql`select count(*) as sessions, count(distinct listener_hash) as uniques, count(distinct country) as countries,
            coalesce(avg(coalesce(duration_seconds, extract(epoch from now() - started_at))), 0) as avg_seconds
          from listener_sessions where ${sessionFilter(s, settings)}`,
    ),
  ]);
  return { ...a, sessions: num(b?.sessions), uniqueListeners: num(b?.uniques), avgSessionSeconds: Math.round(num(b?.avg_seconds)), countries: num(b?.countries) };
}

export const DIMENSIONS = ['country', 'region', 'city', 'device', 'player', 'os', 'mount', 'referrer', 'network'] as const;
export type Dimension = (typeof DIMENSIONS)[number];

const dimensionExpr: Record<Dimension, SQL> = {
  country: sql`coalesce(country, '')`,
  region: sql`coalesce(country, '') || '|' || coalesce(region, '')`,
  city: sql`coalesce(country, '') || '|' || coalesce(city, '')`,
  device: sql`coalesce(device, 'other')`,
  player: sql`coalesce(player, 'Unknown')`,
  os: sql`coalesce(os, 'Unknown')`,
  mount: sql`case when output_id is not null then 'output:' || output_id::text when node_id is not null then 'node:' || node_id::text else mount_path end`,
  referrer: sql`coalesce(referrer, '')`,
  network: sql`coalesce(network, '')`,
};

/** Sessions, unique listeners and listening time per value of a dimension, biggest first. */
export async function breakdown(ctx: AppContext, s: Scope, dim: Dimension, limit = 50) {
  if (!s.stationIds.length) return [];
  const settings = await getSetting(ctx, 'statistics');
  const result = await rows(
    ctx,
    sql`select ${dimensionExpr[dim]} as key, count(*) as sessions, count(distinct listener_hash) as listeners, sum(${overlap(s)}) as seconds
        from listener_sessions where ${sessionFilter(s, settings)}
        group by 1 order by 4 desc nulls last, 2 desc limit ${limit}`,
  );
  return result.map((r) => ({ key: String(r.key ?? ''), sessions: num(r.sessions), listeners: num(r.listeners), hours: Math.round((num(r.seconds) / 3600) * 10) / 10 }));
}

const DURATION_EDGES = [60, 300, 900, 1800, 3600, 7200];

/** How long people listen: sessions per length band. */
export async function durations(ctx: AppContext, s: Scope) {
  if (!s.stationIds.length) return [];
  const settings = await getSetting(ctx, 'statistics');
  const result = await rows(
    ctx,
    sql`select width_bucket(coalesce(duration_seconds, extract(epoch from now() - started_at)), array[${sql.join(DURATION_EDGES.map((e) => sql`${e}`), sql`, `)}]::float8[]) as band, count(*) as n
        from listener_sessions where ${sessionFilter(s, settings)} group by 1 order by 1`,
  );
  const by = new Map(result.map((r) => [num(r.band), num(r.n)]));
  return [0, ...DURATION_EDGES].map((from, i) => ({ fromSeconds: from, toSeconds: DURATION_EDGES[i] ?? null, sessions: by.get(i) ?? 0 }));
}

/** Average listeners per weekday (1 = Monday) and hour, in the report's time zone. */
export async function heatmap(ctx: AppContext, s: Scope) {
  if (!s.stationIds.length) return [];
  const result = await rows(
    ctx,
    sql`with per_hour as (
          select hour, sum(avg) as avg from listener_hourly
          where station_id in (${ids(s.stationIds)}) and target = ${target(s)} and hour >= ${s.from.toISOString()}::timestamptz and hour < ${s.to.toISOString()}::timestamptz
          group by hour
        ), hours as (
          select h from generate_series(date_trunc('hour', ${s.from.toISOString()}::timestamptz), least(${s.to.toISOString()}::timestamptz, now()) - interval '1 hour', interval '1 hour') as h
        )
        select extract(isodow from h at time zone ${s.tz}) as dow, extract(hour from h at time zone ${s.tz}) as hr, avg(coalesce(p.avg, 0)) as avg
        from hours left join per_hour p on p.hour = hours.h group by 1, 2`,
  );
  return result.map((r) => ({ weekday: num(r.dow), hour: num(r.hr), avg: Math.round(num(r.avg) * 10) / 10 }));
}

/** Places on the map: cities with coordinates and their listening time. */
export async function places(ctx: AppContext, s: Scope, opts: { openOnly?: boolean } = {}) {
  if (!s.stationIds.length) return [];
  const settings = await getSetting(ctx, 'statistics');
  const result = await rows(
    ctx,
    sql`select country, city, round(avg(latitude)::numeric, 2) as lat, round(avg(longitude)::numeric, 2) as lon, count(*) as sessions,
          count(distinct listener_hash) as listeners, sum(${overlap(s)}) as seconds
        from listener_sessions
        where ${sessionFilter(s, settings)} and latitude is not null ${opts.openOnly ? sql`and ended_at is null` : sql``}
        group by country, city order by sessions desc limit 400`,
  );
  return result.map((r) => ({
    country: (r.country as string | null) ?? null,
    city: (r.city as string | null) ?? null,
    lat: num(r.lat),
    lon: num(r.lon),
    sessions: num(r.sessions),
    listeners: num(r.listeners),
    hours: Math.round((num(r.seconds) / 3600) * 10) / 10,
  }));
}

/** Most played titles in the period, and how the audience moved while they played. */
export async function topSongs(ctx: AppContext, s: Scope, limit = 50) {
  if (!s.stationIds.length) return [];
  const result = await rows(
    ctx,
    sql`select title, count(*) as plays, avg(listeners_start) as avg_start, avg(listeners_peak) as avg_peak,
          avg(coalesce(listeners_end, listeners_start) - listeners_start) as avg_change, max(started_at) as last_played
        from song_plays
        where station_id in (${ids(s.stationIds)}) and started_at >= ${s.from.toISOString()}::timestamptz and started_at < ${s.to.toISOString()}::timestamptz
          and (ended_at is null or ended_at - started_at > interval '20 seconds')
        group by title order by 2 desc, 6 desc limit ${limit}`,
  );
  return result.map((r) => ({
    title: String(r.title),
    plays: num(r.plays),
    avgListeners: Math.round(num(r.avg_start) * 10) / 10,
    avgPeak: Math.round(num(r.avg_peak) * 10) / 10,
    avgChange: Math.round(num(r.avg_change) * 10) / 10,
    lastPlayed: new Date(r.last_played as string).toISOString(),
  }));
}

/** The latest plays in the period, newest first. */
export async function recentPlays(ctx: AppContext, s: Scope, limit = 50) {
  if (!s.stationIds.length) return [];
  const result = await rows(
    ctx,
    sql`select p.id, p.station_id, st.name as station_name, p.mount_path, p.title, p.started_at, p.ended_at, p.listeners_start, p.listeners_peak, p.listeners_end
        from song_plays p join stations st on st.id = p.station_id
        where p.station_id in (${ids(s.stationIds)}) and p.started_at >= ${s.from.toISOString()}::timestamptz and p.started_at < ${s.to.toISOString()}::timestamptz
        order by p.started_at desc limit ${limit}`,
  );
  return result.map((r) => ({
    id: num(r.id),
    stationId: String(r.station_id),
    stationName: String(r.station_name),
    mount: String(r.mount_path),
    title: String(r.title),
    startedAt: new Date(r.started_at as string).toISOString(),
    endedAt: r.ended_at ? new Date(r.ended_at as string).toISOString() : null,
    listenersStart: num(r.listeners_start),
    listenersPeak: num(r.listeners_peak),
    listenersEnd: r.listeners_end == null ? null : num(r.listeners_end),
  }));
}

/** Live broadcasts in the period with the station's average and peak listeners while they were on air. */
export async function broadcasts(ctx: AppContext, s: Scope, limit = 100) {
  if (!s.stationIds.length) return [];
  const result = await rows(
    ctx,
    sql`select l.id, l.station_id, st.name as station_name, l.account_name, l.mount_path, l.started_at, l.ended_at,
          (select coalesce(sum(x.avg), 0) / greatest(1, extract(epoch from coalesce(l.ended_at, now()) - l.started_at) / 60)
             from listener_samples x where x.station_id = l.station_id and x.target = '*' and x.at >= date_trunc('minute', l.started_at) and x.at < coalesce(l.ended_at, now())) as avg,
          (select max(x.peak) from listener_samples x where x.station_id = l.station_id and x.target = '*' and x.at >= date_trunc('minute', l.started_at) and x.at < coalesce(l.ended_at, now())) as peak
        from live_sessions l join stations st on st.id = l.station_id
        where l.station_id in (${ids(s.stationIds)}) and l.started_at < ${s.to.toISOString()}::timestamptz and (l.ended_at is null or l.ended_at > ${s.from.toISOString()}::timestamptz)
        order by l.started_at desc limit ${limit}`,
  );
  return result.map((r) => ({
    id: String(r.id),
    stationId: String(r.station_id),
    stationName: String(r.station_name),
    accountName: String(r.account_name),
    mount: String(r.mount_path),
    startedAt: new Date(r.started_at as string).toISOString(),
    endedAt: r.ended_at ? new Date(r.ended_at as string).toISOString() : null,
    avgListeners: Math.round(num(r.avg) * 10) / 10,
    peakListeners: num(r.peak),
  }));
}

export interface SessionRow {
  id: string;
  stationId: string;
  stationName: string;
  mount: string;
  via: string;
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number;
  ip: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  network: string | null;
  device: string | null;
  player: string | null;
  os: string | null;
  referrer: string | null;
  userAgent: string | null;
}

/** Listener sessions, newest first; `before` continues a previous page. */
export async function sessions(ctx: AppContext, s: Scope, opts: { limit: number; before?: Date; openOnly?: boolean; country?: string }) {
  if (!s.stationIds.length) return [] as SessionRow[];
  const settings = await getSetting(ctx, 'statistics');
  const result = await rows(
    ctx,
    sql`select ls.*, st.name as station_name, coalesce(ls.duration_seconds, extract(epoch from now() - ls.started_at))::int as secs,
          coalesce(o.name, '') as output_name
        from (
          select * from listener_sessions
          where ${sessionFilter(s, settings)}
            ${opts.before ? sql`and started_at < ${opts.before.toISOString()}::timestamptz` : sql``}
            ${opts.openOnly ? sql`and ended_at is null` : sql``}
            ${opts.country ? sql`and country = ${opts.country}` : sql``}
          order by started_at desc limit ${opts.limit}
        ) ls join stations st on st.id = ls.station_id left join station_outputs o on o.id = ls.output_id
        order by ls.started_at desc`,
  );
  return result.map(
    (r): SessionRow => ({
      id: String(r.id),
      stationId: String(r.station_id),
      stationName: String(r.station_name),
      mount: r.output_id ? String(r.output_name || r.mount_path) : String(r.mount_path),
      via: String(r.via),
      startedAt: new Date(r.started_at as string).toISOString(),
      endedAt: r.ended_at ? new Date(r.ended_at as string).toISOString() : null,
      durationSeconds: num(r.secs),
      ip: (r.ip as string | null) ?? null,
      country: (r.country as string | null) ?? null,
      region: (r.region as string | null) ?? null,
      city: (r.city as string | null) ?? null,
      network: (r.network as string | null) ?? null,
      device: (r.device as string | null) ?? null,
      player: (r.player as string | null) ?? null,
      os: (r.os as string | null) ?? null,
      referrer: (r.referrer as string | null) ?? null,
      userAgent: (r.user_agent as string | null) ?? null,
    }),
  );
}

/** Listeners right now per station (open sessions) and their countries and players. */
export async function liveAudience(ctx: AppContext, stationIds: string[]) {
  if (!stationIds.length) return { countries: [], devices: [], trend: [] as { t: string; listeners: number }[] };
  const settings = await getSetting(ctx, 'statistics');
  const now = new Date();
  const s: Scope = { stationIds, from: new Date(now.getTime() - 1000), to: now, tz: 'UTC' };
  const open = sql`${sessionFilter(s, { ...settings, minSessionSeconds: 0 })} and ended_at is null`;
  const [countries, devices, trend] = await Promise.all([
    rows(ctx, sql`select coalesce(country, '') as key, count(*) as n from listener_sessions where ${open} group by 1 order by 2 desc limit 30`),
    rows(ctx, sql`select coalesce(device, 'other') as key, count(*) as n from listener_sessions where ${open} group by 1 order by 2 desc`),
    rows(
      ctx,
      sql`select at, sum(avg) as avg from listener_samples where station_id in (${ids(stationIds)}) and target = '*' and at >= now() - interval '60 minutes' group by at order by at`,
    ),
  ]);
  return {
    countries: countries.map((r) => ({ key: String(r.key), listeners: num(r.n) })),
    devices: devices.map((r) => ({ key: String(r.key), listeners: num(r.n) })),
    trend: trend.map((r) => ({ t: new Date(r.at as string).toISOString(), listeners: Math.round(num(r.avg) * 10) / 10 })),
  };
}
