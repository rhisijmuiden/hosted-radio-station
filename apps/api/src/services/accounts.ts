import { and, eq, gt, isNull } from 'drizzle-orm';
import { schema } from '../db/index.js';
import type { AppContext } from '../lib/context.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { renderTemplate } from './email-templates.js';
import { sendMail } from './mail.js';

type User = typeof schema.users.$inferSelect;

const LIFETIME = { reset: 3600_000, invite: 3 * 86400_000 } as const;
export type TokenPurpose = keyof typeof LIFETIME;

/** Creates a single-use link token; earlier unused tokens of the user stop working. */
export async function createPasswordToken(ctx: AppContext, userId: string, purpose: TokenPurpose) {
  const token = randomToken();
  await ctx.db.delete(schema.passwordTokens).where(eq(schema.passwordTokens.userId, userId));
  await ctx.db.insert(schema.passwordTokens).values({
    id: sha256(token),
    userId,
    purpose,
    expiresAt: new Date(Date.now() + LIFETIME[purpose]),
  });
  return token;
}

/** Returns the user of a valid, unused token. */
export async function findPasswordToken(ctx: AppContext, token: string) {
  const [row] = await ctx.db
    .select({ token: schema.passwordTokens, user: schema.users })
    .from(schema.passwordTokens)
    .innerJoin(schema.users, eq(schema.users.id, schema.passwordTokens.userId))
    .where(
      and(eq(schema.passwordTokens.id, sha256(token)), isNull(schema.passwordTokens.usedAt), gt(schema.passwordTokens.expiresAt, new Date())),
    );
  return row && row.user.active ? row : null;
}

export async function consumePasswordToken(ctx: AppContext, token: string) {
  await ctx.db.update(schema.passwordTokens).set({ usedAt: new Date() }).where(eq(schema.passwordTokens.id, sha256(token)));
}

const link = (ctx: AppContext, token: string) => `${ctx.config.PUBLIC_URL.replace(/\/$/, '')}/reset-password?token=${encodeURIComponent(token)}`;

export async function sendPasswordReset(ctx: AppContext, user: User) {
  const token = await createPasswordToken(ctx, user.id, 'reset');
  const msg = renderTemplate('reset', user.locale, { name: user.name }, link(ctx, token));
  await sendMail(ctx, { to: user.email, ...msg });
}

/** Sends an invitation with a link to choose a password. `where` names the customer, or the platform. */
export async function sendInvite(ctx: AppContext, user: User, inviter: string, where: string) {
  const token = await createPasswordToken(ctx, user.id, 'invite');
  const msg = renderTemplate('invite', user.locale, { name: user.name, inviter, where, email: user.email }, link(ctx, token));
  await sendMail(ctx, { to: user.email, ...msg });
}
