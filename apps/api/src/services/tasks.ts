import { and, isNotNull, lt, or, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { schema } from '../db/index.js';
import type { AppContext } from '../lib/context.js';
import { tickScheduler } from './backup/jobs.js';
import { getSetting } from './settings.js';
import { recheckDomains } from './streaming/domains.js';
import { applyAllStreams, applyStreams } from './streaming/state.js';
import { scanAllStorage } from './streaming/storage.js';

/** Removes expired sessions and links, and audit entries older than the retention period. */
export async function housekeeping(ctx: AppContext) {
  const now = new Date();
  await ctx.db.delete(schema.sessions).where(lt(schema.sessions.expiresAt, now));
  await ctx.db
    .delete(schema.passwordTokens)
    .where(or(lt(schema.passwordTokens.expiresAt, new Date(now.getTime() - 7 * 86400_000)), isNotNull(schema.passwordTokens.usedAt)));
  const { retentionDays } = await getSetting(ctx, 'audit');
  if (retentionDays > 0) {
    await ctx.db.delete(schema.auditLog).where(lt(schema.auditLog.at, new Date(now.getTime() - retentionDays * 86400_000)));
  }
  // Keep the run history readable: the last 500 runs.
  await ctx.db.delete(schema.backupRuns).where(
    and(
      sql`${schema.backupRuns.state} in ('succeeded', 'failed')`,
      sql`${schema.backupRuns.id} not in (select id from backup_runs order by queued_at desc limit 500)`,
    ),
  );
}

/**
 * Timers of the API process: the backup scheduler every minute, DNS checks of customer domains every five minutes,
 * housekeeping and media folder sizes every six hours. On start every station configuration is rewritten, so a new
 * version's template takes effect.
 */
export function startBackgroundTasks(ctx: AppContext, log: FastifyBaseLogger) {
  const safe = (name: string, fn: () => Promise<unknown>) => () =>
    void fn().catch((err) => log.error({ err }, `${name} failed`));
  const scheduler = setInterval(safe('backup scheduler', () => tickScheduler(ctx)), 60_000);
  const house = setInterval(safe('housekeeping', () => housekeeping(ctx)), 6 * 3600_000);
  const storage = setInterval(safe('storage scan', () => scanAllStorage(ctx)), 6 * 3600_000);
  const domains = setInterval(
    safe('domain check', async () => {
      if (await recheckDomains(ctx)) await applyStreams(ctx);
    }),
    5 * 60_000,
  );
  setTimeout(safe('housekeeping', () => housekeeping(ctx)), 30_000).unref();
  setTimeout(safe('stream configuration', () => applyAllStreams(ctx)), 3_000).unref();
  setTimeout(safe('storage scan', () => scanAllStorage(ctx)), 60_000).unref();
  for (const t of [scheduler, house, storage, domains]) t.unref();
  return () => {
    for (const t of [scheduler, house, storage, domains]) clearInterval(t);
  };
}
