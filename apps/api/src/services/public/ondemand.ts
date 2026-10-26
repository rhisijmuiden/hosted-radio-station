import { execFile } from 'node:child_process';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { and, eq, inArray, isNotNull, isNull, lt } from 'drizzle-orm';
import { schema } from '../../db/index.js';
import type { AppContext } from '../../lib/context.js';
import { mediaDir } from '../streaming/icecast.js';
import { publicSettings } from './settings.js';

const run = promisify(execFile);

/** Files that browsers can play, by extension. */
export const AUDIO_TYPES: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.aac': 'audio/aac',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
};

export const ONDEMAND_FOLDER = 'ondemand';
export const RECORDINGS_FOLDER = 'recordings';

/** Absolute path of an item's file, refusing anything outside the station's media folder. */
export function itemPath(ctx: AppContext, stationId: string, file: string) {
  const root = resolve(mediaDir(ctx, stationId));
  const full = resolve(root, file);
  if (!full.startsWith(root + sep)) throw new Error('outside the media folder');
  return full;
}

export interface Probe {
  durationSeconds: number | null;
  title: string | null;
  artist: string | null;
}

/** Length and tags of an audio file, read with ffprobe. */
export async function probe(path: string): Promise<Probe> {
  try {
    const { stdout } = await run('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_format', path], { timeout: 30_000, maxBuffer: 1024 * 1024 });
    const f = (JSON.parse(stdout) as { format?: { duration?: string; tags?: Record<string, string> } }).format ?? {};
    const tags = Object.fromEntries(Object.entries(f.tags ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const d = Number(f.duration);
    return { durationSeconds: Number.isFinite(d) && d > 0 ? Math.round(d) : null, title: tags.title?.trim() || null, artist: tags.artist?.trim() || null };
  } catch {
    return { durationSeconds: null, title: null, artist: null };
  }
}

/** "2026-10-26 Friday Night Show.mp3" → "2026-10-26 Friday Night Show". */
const titleFromFile = (file: string) => file.split('/').pop()!.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim();

async function listAudio(dir: string, root: string, out: string[] = [], depth = 0) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory() && depth < 3) await listAudio(p, root, out, depth + 1);
    else if (e.isFile() && AUDIO_TYPES[extname(e.name).toLowerCase()]) out.push(relative(root, p).split(sep).join('/'));
  }
  return out;
}

/**
 * Brings the on-demand list in line with the station's `ondemand` folder (uploaded over SFTP/FTP): new files become
 * published items, items whose file is gone are removed. Recordings live in `recordings` and are managed by the
 * recorder; their items are only removed when the file is gone.
 */
export async function scanOnDemand(ctx: AppContext, stationId: string) {
  const root = mediaDir(ctx, stationId);
  await mkdir(join(root, ONDEMAND_FOLDER), { recursive: true, mode: 0o775 }).catch(() => undefined);
  const files = await listAudio(join(root, ONDEMAND_FOLDER), root);
  const items = await ctx.db.select().from(schema.onDemandItems).where(eq(schema.onDemandItems.stationId, stationId));
  const known = new Set(items.map((i) => i.file));
  let changed = false;
  for (const file of files) {
    if (known.has(file)) continue;
    const path = itemPath(ctx, stationId, file);
    const st = await stat(path).catch(() => null);
    // Still being uploaded: wait until the file has not changed for a minute.
    if (!st || Date.now() - st.mtimeMs < 60_000) continue;
    const p = await probe(path);
    await ctx.db
      .insert(schema.onDemandItems)
      .values({
        stationId,
        source: 'upload',
        file,
        title: (p.title ? (p.artist ? `${p.artist} - ${p.title}` : p.title) : titleFromFile(file)).slice(0, 200),
        contentType: AUDIO_TYPES[extname(file).toLowerCase()]!,
        sizeBytes: st.size,
        durationSeconds: p.durationSeconds,
        recordedAt: st.mtime,
        publishedAt: new Date(),
      })
      .onConflictDoNothing();
    changed = true;
  }
  const gone: string[] = [];
  for (const item of items) {
    // A recording in progress has no complete file yet.
    if (item.source === 'recording' && !item.recordedAt) continue;
    if (!(await stat(itemPath(ctx, stationId, item.file)).catch(() => null))) gone.push(item.id);
  }
  if (gone.length) {
    await ctx.db.delete(schema.onDemandItems).where(inArray(schema.onDemandItems.id, gone));
    changed = true;
  }
  return changed;
}

/** Removes unpublished recordings that are older than the station's retention. */
export async function pruneRecordings(ctx: AppContext) {
  const stations = await ctx.db.select({ id: schema.stations.id, publicPage: schema.stations.publicPage }).from(schema.stations);
  for (const s of stations) {
    const { keepDays } = publicSettings(s).recording;
    if (!keepDays) continue;
    const old = await ctx.db
      .select()
      .from(schema.onDemandItems)
      .where(
        and(
          eq(schema.onDemandItems.stationId, s.id),
          eq(schema.onDemandItems.source, 'recording'),
          isNull(schema.onDemandItems.publishedAt),
          isNotNull(schema.onDemandItems.recordedAt),
          lt(schema.onDemandItems.recordedAt, new Date(Date.now() - keepDays * 86400_000)),
        ),
      );
    for (const item of old) {
      await rm(itemPath(ctx, s.id, item.file), { force: true }).catch(() => undefined);
      await ctx.db.delete(schema.onDemandItems).where(eq(schema.onDemandItems.id, item.id));
    }
  }
}

export async function scanAllOnDemand(ctx: AppContext) {
  for (const { id } of await ctx.db.select({ id: schema.stations.id }).from(schema.stations)) await scanOnDemand(ctx, id);
}

/** Recordings that were still running when the streams service stopped: keep what was recorded as a draft. */
export async function finishStaleRecordings(ctx: AppContext) {
  const open = await ctx.db
    .select()
    .from(schema.onDemandItems)
    .where(and(eq(schema.onDemandItems.source, 'recording'), isNull(schema.onDemandItems.recordedAt)));
  for (const item of open) {
    const path = itemPath(ctx, item.stationId, item.file);
    const st = await stat(path).catch(() => null);
    if (!st?.size) {
      await rm(path, { force: true });
      await ctx.db.delete(schema.onDemandItems).where(eq(schema.onDemandItems.id, item.id));
      continue;
    }
    const p = await probe(path);
    await ctx.db
      .update(schema.onDemandItems)
      .set({ recordedAt: item.createdAt, sizeBytes: st.size, durationSeconds: p.durationSeconds })
      .where(eq(schema.onDemandItems.id, item.id));
  }
}
