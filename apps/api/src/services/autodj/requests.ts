import { and, eq, ilike, inArray, sql } from 'drizzle-orm';
import { schema } from '../../db/index.js';
import type { AppContext } from '../../lib/context.js';
import type { Station } from '../streaming/state.js';
import { enqueue } from './planner.js';
import { autodjActive, autodjSettings } from './settings.js';

type Request = typeof schema.songRequests.$inferSelect;

/** Listeners can pick requests from the library: the AutoDJ plays and the station allows it. */
export const libraryRequests = (station: Station) => autodjActive(station) && autodjSettings(station).requests.fromLibrary;

/**
 * Why a library track cannot be requested right now, or null when it can: it is switched off, played too recently,
 * already waiting in a queue or already requested.
 */
export async function requestBlocker(ctx: AppContext, station: Station, mediaId: string): Promise<string | null> {
  const s = autodjSettings(station);
  const [media] = await ctx.db.select().from(schema.mediaFiles).where(and(eq(schema.mediaFiles.id, mediaId), eq(schema.mediaFiles.stationId, station.id)));
  if (!media || !media.enabled) return 'This track cannot be requested';
  if (media.lastPlayedAt && Date.now() - media.lastPlayedAt.getTime() < s.requests.repeatMinutes * 60_000) return 'This track played a moment ago; try again later';
  const [queued] = await ctx.db
    .select({ id: schema.queueItems.id })
    .from(schema.queueItems)
    .where(and(eq(schema.queueItems.stationId, station.id), eq(schema.queueItems.mediaId, mediaId)))
    .limit(1);
  if (queued) return 'This track is already coming up';
  const [open] = await ctx.db
    .select({ id: schema.songRequests.id })
    .from(schema.songRequests)
    .where(and(eq(schema.songRequests.stationId, station.id), eq(schema.songRequests.mediaId, mediaId), inArray(schema.songRequests.status, ['pending', 'accepted'])))
    .limit(1);
  if (open) return 'Someone already requested this track';
  return null;
}

/**
 * Puts an accepted request in the AutoDJ queue (at the top of the queue the station chose). A free-text request is
 * matched to a library track with the same artist and title. Returns whether it was queued.
 */
export async function queueRequest(ctx: AppContext, station: Station, request: Request, by: string): Promise<boolean> {
  if (!autodjActive(station)) return false;
  let mediaId = request.mediaId;
  if (!mediaId) {
    const [match] = await ctx.db
      .select({ id: schema.mediaFiles.id })
      .from(schema.mediaFiles)
      .where(
        and(
          eq(schema.mediaFiles.stationId, station.id),
          eq(schema.mediaFiles.enabled, true),
          ilike(schema.mediaFiles.artist, request.artist.replace(/[\\%_]/g, (c) => `\\${c}`)),
          ilike(schema.mediaFiles.title, request.title.replace(/[\\%_]/g, (c) => `\\${c}`)),
        ),
      )
      .orderBy(sql`${schema.mediaFiles.lastPlayedAt} asc nulls first`)
      .limit(1);
    if (!match) return false;
    mediaId = match.id;
    await ctx.db.update(schema.songRequests).set({ mediaId }).where(eq(schema.songRequests.id, request.id));
  }
  const [already] = await ctx.db.select({ id: schema.queueItems.id }).from(schema.queueItems).where(eq(schema.queueItems.requestId, request.id)).limit(1);
  if (already) return true;
  await enqueue(ctx, station.id, mediaId, 'q1', { at: 'top', origin: 'request', requestId: request.id, addedBy: by });
  return true;
}
