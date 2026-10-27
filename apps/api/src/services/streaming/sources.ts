import { and, eq, gt } from 'drizzle-orm';
import { schema } from '../../db/index.js';
import { verifyPassword } from '../../lib/auth.js';
import type { AppContext } from '../../lib/context.js';
import { sha256 } from '../../lib/crypto.js';
import { occurrences } from '../scheduler/schedule.js';
import { schedulerSettings } from '../scheduler/settings.js';

/** Why a DJ may not broadcast now: outside their shows; `opensAt` = when they can connect next (within a week). */
export interface OutsideShow {
  opensAt: number | null;
  timezone: string;
}

/**
 * Stations that keep DJs to their shows: an account that is the DJ of a live show may only broadcast from a few
 * minutes before one of its shows until the show ends. Accounts without a show (a studio) are not limited.
 * Returns null when the account may broadcast now.
 */
export async function outsideShow(ctx: AppContext, stationId: string, accountId: string, now = Date.now()): Promise<OutsideShow | null> {
  const [station] = await ctx.db.select({ id: schema.stations.id, scheduler: schema.stations.scheduler, edition: schema.stations.edition }).from(schema.stations).where(eq(schema.stations.id, stationId));
  if (!station || station.edition !== 'station') return null;
  const s = schedulerSettings(station);
  if (!s.enabled || !s.liveOnlyInShows) return null;
  const shows = (
    await ctx.db
      .select()
      .from(schema.scheduleEntries)
      .where(and(eq(schema.scheduleEntries.stationId, stationId), eq(schema.scheduleEntries.enabled, true), eq(schema.scheduleEntries.live, true)))
  ).filter((e) => e.accountIds.includes(accountId));
  if (!shows.length) return null;
  const early = s.liveEarlyMinutes * 60_000;
  const runs = occurrences(shows, now, now + 7 * 86_400_000, s.timezone);
  if (runs.some((o) => o.start - early <= now && now < o.end)) return null;
  const next = runs.find((o) => o.start - early > now);
  return { opensAt: next ? next.start - early : null, timezone: s.timezone };
}

/** Encoder passwords handed out to the studio client start with this. */
export const LIVE_TOKEN_PREFIX = 'hrsl_';

/** How long a station node waits for a password the main server just handed out (it comes with the next package). */
export const LIVE_TOKEN_WAIT_MS = 8000;

async function validLiveToken(ctx: AppContext, accountId: string, token: string, wait = LIVE_TOKEN_WAIT_MS) {
  const find = async () => {
    const [row] = await ctx.db
      .select({ id: schema.studioLiveTokens.id })
      .from(schema.studioLiveTokens)
      .where(and(eq(schema.studioLiveTokens.hash, sha256(token)), eq(schema.studioLiveTokens.accountId, accountId), gt(schema.studioLiveTokens.expiresAt, new Date())));
    return !!row;
  };
  if (await find()) return true;
  // On a station node the studio client is often quicker than the package that brings the new password.
  if (!ctx.config.STATION_NODE) return false;
  for (const until = Date.now() + wait; Date.now() < until; ) {
    await new Promise((r) => setTimeout(r, 500));
    if (await find()) return true;
  }
  return false;
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
  /** Told when the log-in is right but the DJ is outside their shows. */
  onOutsideShow?: (refusal: OutsideShow, account: Account) => void,
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
  if (!(pass.startsWith(LIVE_TOKEN_PREFIX) ? await validLiveToken(ctx, account.id, pass) : await verifyPassword(account.passwordHash, pass))) return null;
  const refusal = await outsideShow(ctx, stationId, account.id);
  if (refusal) {
    onOutsideShow?.(refusal, account);
    return null;
  }
  return account;
}
