import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '../../db/index.js';
import type { AppContext } from '../../lib/context.js';
import { recordingFile, recordingTitle } from '../../streams/recorder.js';
import { itemPath, probe } from '../public/ondemand.js';
import { publicSettings } from '../public/settings.js';
import type { Mount } from '../streaming/state.js';

/** What the main server tells about a show it hands over as an on-demand item. */
export const showImportSchema = z.object({
  sessionId: z.uuid(),
  dj: z.string().max(200),
  startedAt: z.coerce.date(),
  /** mp3 | aac | ogg | opus */
  ext: z.enum(['mp3', 'aac', 'ogg', 'opus']),
  contentType: z.string().max(100),
  size: z.coerce.number().int().min(1),
});
export type ShowImport = z.infer<typeof showImportSchema>;

const FORMATS: Record<ShowImport['ext'], Mount['format']> = { mp3: 'mp3', aac: 'aac', ogg: 'vorbis', opus: 'opus' };

/**
 * Makes a show of a recorder node an on-demand item of the station (phase 21 step 3), the same way a recording of
 * phase 5 is: the file goes into the station's `recordings` folder, the item is a draft or published right away as
 * the public page settings say. A broadcast that already has an item (recorded here as well) gets no second one.
 * Runs where the station's on-demand items live: the main server, or the station's station node.
 */
export async function importShow(ctx: AppContext, stationId: string, show: ShowImport, body: Readable): Promise<'created' | 'exists'> {
  const [station] = await ctx.db.select().from(schema.stations).where(eq(schema.stations.id, stationId));
  if (!station) throw new Error('Unknown station');
  const [existing] = await ctx.db.select({ id: schema.onDemandItems.id }).from(schema.onDemandItems).where(eq(schema.onDemandItems.liveSessionId, show.sessionId));
  if (existing) {
    body.resume();
    return 'exists';
  }
  const broadcast = { sessionId: show.sessionId, stationId, mountPath: '', accountName: show.dj, startedAt: show.startedAt };
  const file = recordingFile(broadcast, FORMATS[show.ext]);
  const path = itemPath(ctx, stationId, file);
  await mkdir(dirname(path), { recursive: true, mode: 0o775 });
  const tmp = `${path}.part`;
  try {
    await pipeline(body, createWriteStream(tmp, { mode: 0o664 }));
    const st = await stat(tmp);
    if (st.size !== show.size) throw new Error(`Received ${st.size} of ${show.size} bytes`);
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
  const p = await probe(path);
  const [session] = await ctx.db.select({ id: schema.liveSessions.id }).from(schema.liveSessions).where(eq(schema.liveSessions.id, show.sessionId));
  const { autoPublish } = publicSettings(station).recording;
  const now = new Date();
  const [row] = await ctx.db
    .insert(schema.onDemandItems)
    .values({
      stationId,
      source: 'recording',
      file,
      title: recordingTitle(broadcast),
      host: show.dj.slice(0, 100),
      liveSessionId: session ? session.id : null,
      contentType: show.contentType,
      sizeBytes: show.size,
      durationSeconds: p.durationSeconds,
      recordedAt: show.startedAt,
      publishedAt: autoPublish ? now : null,
    })
    .onConflictDoNothing()
    .returning({ id: schema.onDemandItems.id });
  return row ? 'created' : 'exists';
}
