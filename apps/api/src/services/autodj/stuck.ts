import { and, eq, gt, isNull, or } from 'drizzle-orm';
import { schema } from '../../db/index.js';
import type { AppContext } from '../../lib/context.js';

/** How long a track may run past its end before the playout counts as stuck. */
export const STUCK_AFTER_SECONDS = 5 * 60;

interface OnAir {
  startedAt: Date | null;
  media: { durationSeconds: number | null; cueIn: number | null; cueOut: number | null };
}

/**
 * Whether the player hangs on the track on air: it ran more than five minutes past its end. A live broadcast holds the
 * player, so the time of the broadcasts since the track started is added; while one is on air, or in manual playout
 * (the player waits for Play), it never counts as stuck. Null when nothing is on air or its length is unknown.
 */
export async function stuckSince(ctx: AppContext, stationId: string, onAir: OnAir | null, manual: boolean, now = Date.now()): Promise<Date | null> {
  if (!onAir?.startedAt || manual) return null;
  const end = onAir.media.cueOut ?? onAir.media.durationSeconds;
  if (end == null) return null;
  const started = onAir.startedAt.getTime();
  const due = started + Math.max(0, end - (onAir.media.cueIn ?? 0)) * 1000 + STUCK_AFTER_SECONDS * 1000;
  if (due > now) return null;
  const live = await ctx.db
    .select({ startedAt: schema.liveSessions.startedAt, endedAt: schema.liveSessions.endedAt })
    .from(schema.liveSessions)
    .where(and(eq(schema.liveSessions.stationId, stationId), or(isNull(schema.liveSessions.endedAt), gt(schema.liveSessions.endedAt, onAir.startedAt))));
  if (live.some((l) => !l.endedAt)) return null;
  const held = live.reduce((sum, l) => sum + (l.endedAt!.getTime() - Math.max(started, l.startedAt.getTime())), 0);
  return due + held > now ? null : new Date(due + held);
}
