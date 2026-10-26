import { sql } from 'drizzle-orm';
import type { AppContext } from '../../lib/context.js';
import { getSetting } from '../settings.js';
import { geoipDue, updateGeoip } from './geoip.js';

/**
 * Makes the hourly listener figures from the minute counts. The average of an hour counts missing minutes (nothing on
 * air) as zero; the current hour is divided by the minutes that have passed so far.
 */
export async function rollupHourly(ctx: AppContext, since?: Date) {
  const from = since ?? new Date(Date.now() - 3 * 3600_000);
  await ctx.db.execute(sql`
    insert into listener_hourly (hour, station_id, target, avg, peak, minutes)
    select date_trunc('hour', at) as h, station_id, target,
      sum(avg) / greatest(1, least(60, extract(epoch from least(now(), date_trunc('hour', at) + interval '1 hour') - date_trunc('hour', at)) / 60)),
      max(peak), count(*)
    from listener_samples
    where at >= date_trunc('hour', ${from.toISOString()}::timestamptz)
    group by 1, 2, 3
    on conflict (station_id, target, hour) do update set avg = excluded.avg, peak = excluded.peak, minutes = excluded.minutes`);
}

/** Deletes listener data older than the retention settings. */
export async function pruneStatistics(ctx: AppContext) {
  const s = await getSetting(ctx, 'statistics');
  const days = (n: number) => new Date(Date.now() - n * 86400_000).toISOString();
  await ctx.db.execute(sql`delete from listener_samples where at < ${days(s.sampleRetentionDays)}::timestamptz`);
  if (s.hourlyRetentionDays > 0) await ctx.db.execute(sql`delete from listener_hourly where hour < ${days(s.hourlyRetentionDays)}::timestamptz`);
  if (s.sessionRetentionDays > 0) {
    await ctx.db.execute(sql`delete from listener_sessions where started_at < ${days(s.sessionRetentionDays)}::timestamptz and ended_at is not null`);
    await ctx.db.execute(sql`delete from song_plays where started_at < ${days(s.sessionRetentionDays)}::timestamptz`);
  }
}

let geoipFailedAt = 0;

/** Downloads a GeoIP database when there is none yet or a newer one is due. Failed downloads wait six hours. */
export async function maybeUpdateGeoip(ctx: AppContext) {
  if (Date.now() - geoipFailedAt < 6 * 3600_000) return null;
  if (!(await geoipDue(ctx))) return null;
  try {
    return await updateGeoip(ctx);
  } catch (err) {
    geoipFailedAt = Date.now();
    throw err;
  }
}
