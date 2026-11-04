import { eq, gt } from 'drizzle-orm';
import { schema } from '../../db/index.js';
import type { AppContext } from '../../lib/context.js';

/**
 * Studio mode (RHIS Studio): a studio PC becomes the player. It asks the planner for every next track, plays it itself
 * with the jingles and the microphone, sends that mix live and reports each track it starts, so the queue, the hour
 * clock and the log stay the server's. The AutoDJ holds meanwhile. The PC renews studio mode every few seconds; when it
 * stops (closed, crashed, network gone) the AutoDJ takes over again at the next track of the queue.
 */
export const STUDIO_GRACE_MS = 10_000;

export interface StudioState {
  active: boolean;
  pc: string | null;
  user: string | null;
  until: Date | null;
}

export async function studioState(ctx: AppContext, stationId: string, now = Date.now()): Promise<StudioState> {
  const [row] = await ctx.db
    .select({ until: schema.autodjState.studioUntil, pc: schema.autodjState.studioPc, user: schema.autodjState.studioUser })
    .from(schema.autodjState)
    .where(eq(schema.autodjState.stationId, stationId));
  const active = !!row?.until && row.until.getTime() > now;
  return { active, pc: active ? (row?.pc ?? null) : null, user: active ? (row?.user ?? null) : null, until: active ? row!.until : null };
}

/** Stations in studio mode now. */
export async function studioStations(ctx: AppContext): Promise<Set<string>> {
  const rows = await ctx.db.select({ stationId: schema.autodjState.stationId }).from(schema.autodjState).where(gt(schema.autodjState.studioUntil, new Date()));
  return new Set(rows.map((r) => r.stationId));
}
