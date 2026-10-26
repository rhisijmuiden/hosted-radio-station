import { and, eq } from 'drizzle-orm';
import { schema } from '../../db/index.js';
import { verifyPassword } from '../../lib/auth.js';
import type { AppContext } from '../../lib/context.js';

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
  return account;
}
