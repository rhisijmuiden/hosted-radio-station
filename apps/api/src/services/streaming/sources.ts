import { and, eq } from 'drizzle-orm';
import { schema } from '../../db/index.js';
import { verifyPassword } from '../../lib/auth.js';
import type { AppContext } from '../../lib/context.js';
import { occurrences } from '../scheduler/schedule.js';
import { schedulerSettings } from '../scheduler/settings.js';

/**
 * Stations that keep DJs to their shows: an account that is the DJ of a live show may only broadcast from a few
 * minutes before one of its shows until the show ends. Accounts without a show (a studio) are not limited.
 */
export async function outsideShow(ctx: AppContext, stationId: string, accountId: string, now = Date.now()) {
  const [station] = await ctx.db.select({ id: schema.stations.id, scheduler: schema.stations.scheduler, edition: schema.stations.edition }).from(schema.stations).where(eq(schema.stations.id, stationId));
  if (!station || station.edition !== 'station') return false;
  const s = schedulerSettings(station);
  if (!s.enabled || !s.liveOnlyInShows) return false;
  const shows = (
    await ctx.db
      .select()
      .from(schema.scheduleEntries)
      .where(and(eq(schema.scheduleEntries.stationId, stationId), eq(schema.scheduleEntries.enabled, true), eq(schema.scheduleEntries.live, true)))
  ).filter((e) => e.accountIds.includes(accountId));
  if (!shows.length) return false;
  const early = s.liveEarlyMinutes * 60_000;
  return !occurrences(shows, now, now + early + 1, s.timezone).some((o) => o.start - early <= now && now < o.end);
}

export type Account = typeof schema.stationAccounts.$inferSelect;

/**
 * Checks an encoder log-in for a mount. Legacy Shoutcast encoders only send a password; they log in with
 * "username:password" (or "username" as user name and the password, when the encoder has both fields).
 */
export async function authenticateSource(
  ctx: AppContext,
  stationId: string,
  mountId: string,
  username: string | null,
  password: string,
): Promise<Account | null> {
  let user = username?.trim().toLowerCase() || '';
  let pass = password;
  // Encoders without a user name field send "source" (the Icecast default) or nothing.
  if ((!user || user === 'source') && pass.includes(':')) {
    const i = pass.indexOf(':');
    user = pass.slice(0, i).trim().toLowerCase();
    pass = pass.slice(i + 1);
  }
  if (!user || !pass) return null;
  const [account] = await ctx.db
    .select()
    .from(schema.stationAccounts)
    .where(and(eq(schema.stationAccounts.stationId, stationId), eq(schema.stationAccounts.username, user)));
  if (!account || !account.enabled || !account.canBroadcast) return null;
  if (account.mountIds.length && !account.mountIds.includes(mountId)) return null;
  if (!(await verifyPassword(account.passwordHash, pass))) return null;
  if (await outsideShow(ctx, stationId, account.id)) return null;
  return account;
}
