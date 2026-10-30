import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { and, asc, eq, gte, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { schema } from '../../db/index.js';
import type { AppContext } from '../../lib/context.js';
import { errorLine, run, withRemote } from '../backup/engine.js';
import { freshToken } from '../backup/onedrive.js';
import { decryptConfig, encryptConfig, type AnyTargetConfig, type TargetType } from '../backup/targets.js';
import type { NodeHub } from '../nodes/hub.js';
import type { StationTunnels } from '../stationnode/hub.js';
import { nodeRequest, readJson } from '../stationnode/proxy.js';
import { importShow, type ShowImport } from './ondemand.js';
import { stationRecording } from './settings.js';

type Recording = typeof schema.recordings.$inferSelect;
type Destination = typeof schema.recordingDestinations.$inferSelect;

/** The most one request asks of a recorder (the same parts the panel player uses). */
const PART = 8 * 1024 * 1024;
/** Waits after a failed upload: 1, 5, 15, 30 minutes, then every hour. */
const BACKOFF_MIN = [1, 5, 15, 30, 60];
/** Recordings that finished before a destination was added are not uploaded there (except the hour it was added in). */
const BACKFILL_MS = 3600_000;
/** Shows that ended longer ago than this do not become on-demand items any more. */
const SHOW_WINDOW_MS = 7 * 86400_000;
/** A show is taken this long after its broadcast ended: the recorder closes it, or throws it away when it was too short. */
const SETTLE_MS = 2 * 60_000;
/** Recordings handled per round, so one busy station does not hold up the rest for long. */
const PER_ROUND = 20;

export const retryDelay = (attempts: number) => (BACKOFF_MIN[Math.min(attempts, BACKOFF_MIN.length) - 1] ?? 60) * 60_000;

/** Uploads one local file to `remotePath` under the destination's folder. Returns the OAuth token when rclone refreshed it. */
export type Uploader = (dest: { type: TargetType; config: AnyTargetConfig }, localFile: string, remotePath: string) => Promise<string | null>;

export const rcloneUpload: Uploader = (dest, localFile, remotePath) =>
  withRemote({ type: dest.type, config: dest.config, repoPassword: '' }, async (remote) => {
    const base = remote.repo.slice('rclone:'.length);
    const to = base.endsWith(':') ? `${base}${remotePath}` : `${base}/${remotePath}`;
    const res = await run('rclone', ['copyto', '--retries', '1', '--low-level-retries', '3', '--contimeout', '20s', '--timeout', '120s', localFile, to], {
      env: remote.env,
      timeoutMs: 60 * 60_000,
    });
    if (res.code !== 0) throw new Error(errorLine(res));
    return remote.readToken();
  });

const pad = (n: number) => String(n).padStart(2, '0');
const clean = (s: string) => s.replace(/[^\p{L}\p{N} ._-]+/gu, '').trim().replace(/\s+/g, '-').slice(0, 60);

/**
 * Where a recording goes in a destination: "<station>/logging/2026-10/<station>_2026-10-29_21-00-00Z_64k.mp3" or
 * "<station>/shows/2026-10/<station>_2026-10-29_21-04Z_DJ-Reinder_abcdef.mp3". Times are UTC, as on the recorder.
 */
export function remotePathOf(rec: Pick<Recording, 'kind' | 'file' | 'startedAt' | 'sessionId'>, slug: string, dj: string | null) {
  const d = rec.startedAt;
  const month = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
  const name = rec.file.slice(rec.file.lastIndexOf('/') + 1);
  if (rec.kind !== 'show') return `${slug}/logging/${month}/${slug}_${name}`;
  const ext = name.slice(name.lastIndexOf('.') + 1);
  const stamp = `${month}-${pad(d.getUTCDate())}_${pad(d.getUTCHours())}-${pad(d.getUTCMinutes())}Z`;
  return `${slug}/shows/${month}/${slug}_${stamp}_${clean(dj ?? '') || 'live'}_${(rec.sessionId ?? '').slice(0, 6)}.${ext}`;
}

/** Fetches a whole recording from its recorder node into a local file, part by part. */
export async function saveRecording(hub: NodeHub, rec: Pick<Recording, 'nodeId' | 'file'>, dest: string) {
  const out = createWriteStream(dest, { mode: 0o600 });
  try {
    let at = 0;
    let size = Infinity;
    while (at < size) {
      const part = await hub.fetchRecording(rec.nodeId, rec.file, at, at + PART, 60_000);
      size = part.size;
      if (part.length === 0) break;
      await pipeline(part.body, out, { end: false });
      at = part.start + part.length;
    }
  } finally {
    await new Promise<void>((resolve) => out.end(() => resolve()));
  }
  return (await stat(dest)).size;
}

/** Joins the parts of a show (a recorder that had to start again) into one file, without encoding again. */
async function joinParts(files: string[], dest: string) {
  if (files.length === 1) return files[0]!;
  const list = `${dest}.txt`;
  await writeFile(list, files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'));
  const res = await run('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-map', '0:a', dest], { timeoutMs: 10 * 60_000 });
  if (res.code !== 0) throw new Error(`Joining the parts of the show failed: ${res.stderr.trim().split('\n').at(-1) ?? res.code}`);
  return dest;
}

/**
 * Takes the recordings of recorder nodes further (phase 21 step 3), from the main server:
 * - uploads every finished recording to the destinations of its station (FTP, FTPS, SFTP, OneDrive), and tries a
 *   failed upload again later;
 * - makes a finished show an on-demand item of the station, on this server or on the station's station node;
 * - asks the recorder to remove a recording once it is everywhere it had to go, when the station wants that.
 * The audio is fetched from the recorder the same way the panel player does, so it also works behind NAT.
 */
export class RecordingDelivery {
  private timer: NodeJS.Timeout | null = null;
  private busy: Promise<void> | null = null;
  /** Shows whose on-demand item failed: session id → when to try again. */
  private showRetry = new Map<string, number>();
  /** Files the recorder was asked to remove: file → when. Asked again after ten minutes when it is still there. */
  private removing = new Map<string, number>();

  constructor(
    private readonly ctx: AppContext,
    private readonly hub: NodeHub,
    private readonly tunnels: StationTunnels | null,
    private readonly log: FastifyBaseLogger,
    private readonly upload: Uploader = rcloneUpload,
  ) {}

  start() {
    this.timer = setInterval(() => void this.tick(), 30_000);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One round. A round that is still running is not started twice. */
  tick(now = new Date()) {
    this.busy ??= (async () => {
      try {
        await this.uploads(now);
        await this.shows(now);
        await this.cleanUp(now);
      } catch (err) {
        this.log.warn({ err }, 'delivering recordings failed');
      } finally {
        this.busy = null;
      }
    })();
    return this.busy;
  }

  private async withTemp<T>(fn: (dir: string) => Promise<T>) {
    const dir = await mkdtemp(join(tmpdir(), 'hrs-recording-'));
    await chmod(dir, 0o700);
    try {
      return await fn(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** Finished recordings a destination still needs: never tried, or failed and due again. */
  private async due(dest: Destination, now: Date, limit: number) {
    const d = schema.recordingDeliveries;
    const r = schema.recordings;
    return this.ctx.db
      .select({ rec: r, slug: schema.stations.slug, dj: schema.liveSessions.accountName })
      .from(r)
      .innerJoin(schema.stations, eq(schema.stations.id, r.stationId))
      .leftJoin(schema.liveSessions, eq(schema.liveSessions.id, r.sessionId))
      .leftJoin(d, and(eq(d.recordingId, r.id), eq(d.destinationId, dest.id)))
      .where(
        and(
          eq(r.stationId, dest.stationId),
          inArray(r.kind, dest.kinds.length ? dest.kinds : ['none']),
          eq(r.open, false),
          gte(r.startedAt, new Date(dest.createdAt.getTime() - BACKFILL_MS)),
          or(isNull(d.recordingId), and(eq(d.state, 'failed'), lte(d.nextAt, now))),
        ),
      )
      .orderBy(asc(r.startedAt))
      .limit(limit);
  }

  private async uploads(now: Date) {
    const dests = await this.ctx.db.select().from(schema.recordingDestinations).where(eq(schema.recordingDestinations.enabled, true));
    // Per recording the destinations it still has to go to, so it is fetched from the recorder once.
    const work = new Map<string, { rec: Recording; slug: string; dj: string | null; dests: Destination[] }>();
    for (const dest of dests) {
      for (const row of await this.due(dest, now, PER_ROUND)) {
        if (!this.hub.isOnline(row.rec.nodeId)) continue;
        const w = work.get(row.rec.id) ?? { rec: row.rec, slug: row.slug, dj: row.dj, dests: [] };
        w.dests.push(dest);
        work.set(row.rec.id, w);
      }
    }
    for (const w of [...work.values()].slice(0, PER_ROUND)) {
      await this.withTemp(async (dir) => {
        const local = join(dir, 'audio');
        let fetchError: string | null = null;
        try {
          await saveRecording(this.hub, w.rec, local);
        } catch (err) {
          fetchError = `Fetching it from the recorder failed: ${(err as Error).message}`;
        }
        for (const dest of w.dests) {
          let error = fetchError;
          if (!error) {
            try {
              await this.send(dest, local, remotePathOf(w.rec, w.slug, w.dj));
            } catch (err) {
              error = (err as Error).message.slice(0, 500);
            }
          }
          await this.record(w.rec.id, dest.id, error, new Date());
          if (error) this.log.warn({ destination: dest.name, file: w.rec.file, error }, 'uploading a recording failed');
        }
      });
    }
  }

  /** Uploads to one destination, renewing a OneDrive sign-in first and keeping a token rclone refreshed. */
  private async send(dest: Destination, local: string, remotePath: string) {
    const cfg = decryptConfig(this.ctx, dest);
    if (dest.type === 'onedrive') {
      const c = cfg as AnyTargetConfig & { token: string; tokenSource: string; clientId: string };
      if (c.tokenSource === 'device' && c.clientId) {
        const renewed = await freshToken(c.clientId, c.token);
        if (renewed) {
          c.token = JSON.stringify(renewed);
          await this.saveConfig(dest, cfg);
        }
      }
    }
    const token = await this.upload({ type: dest.type, config: cfg }, local, remotePath);
    if (dest.type === 'onedrive' && token && token !== (cfg as { token: string }).token) {
      (cfg as { token: string }).token = token;
      await this.saveConfig(dest, cfg);
    }
  }

  private async saveConfig(dest: Destination, cfg: AnyTargetConfig) {
    await this.ctx.db
      .update(schema.recordingDestinations)
      .set({ config: encryptConfig(this.ctx, dest.type, cfg, null) })
      .where(eq(schema.recordingDestinations.id, dest.id));
  }

  private async record(recordingId: string, destinationId: string, error: string | null, at: Date) {
    const d = schema.recordingDeliveries;
    const [prev] = await this.ctx.db.select({ attempts: d.attempts }).from(d).where(and(eq(d.recordingId, recordingId), eq(d.destinationId, destinationId)));
    const attempts = (prev?.attempts ?? 0) + 1;
    const values = error
      ? { state: 'failed', attempts, nextAt: new Date(at.getTime() + retryDelay(attempts)), error, at }
      : { state: 'done', attempts, nextAt: null, error: null, at };
    await this.ctx.db
      .insert(d)
      .values({ recordingId, destinationId, ...values })
      .onConflictDoUpdate({ target: [d.recordingId, d.destinationId], set: values })
      // The recording went away while it was uploaded (the recorder removed it).
      .catch(() => undefined);
  }

  /** Finished shows that become on-demand items: their broadcast ended, no part is still being written. */
  private async shows(now: Date) {
    const r = schema.recordings;
    const rows = await this.ctx.db
      .select({ rec: r, station: schema.stations, session: schema.liveSessions })
      .from(r)
      .innerJoin(schema.stations, eq(schema.stations.id, r.stationId))
      .innerJoin(schema.liveSessions, eq(schema.liveSessions.id, r.sessionId))
      .where(and(eq(r.kind, 'show'), isNull(r.ondemandAt), isNotNull(schema.liveSessions.endedAt), gte(schema.liveSessions.endedAt, new Date(now.getTime() - SHOW_WINDOW_MS)), lte(schema.liveSessions.endedAt, new Date(now.getTime() - SETTLE_MS))))
      .orderBy(asc(r.startedAt))
      .limit(500);
    // One show per broadcast, from one recorder (two recorders may have recorded the same broadcast).
    const shows = new Map<string, typeof rows>();
    for (const row of rows) {
      if (!stationRecording(row.station).showsOnDemand) continue;
      const key = row.rec.sessionId!;
      const parts = shows.get(key) ?? [];
      if (parts.length && parts[0]!.rec.nodeId !== row.rec.nodeId) continue;
      parts.push(row);
      shows.set(key, parts);
    }
    let done = 0;
    for (const [sessionId, parts] of shows) {
      if (done >= PER_ROUND) break;
      if (parts.some((p) => p.rec.open) || (this.showRetry.get(sessionId) ?? 0) > now.getTime()) continue;
      if (!this.hub.isOnline(parts[0]!.rec.nodeId)) continue;
      const { station, session } = parts[0]!;
      try {
        await this.withTemp(async (dir) => {
          const files: string[] = [];
          for (const [i, p] of parts.entries()) {
            const f = join(dir, `part-${i}.${p.rec.file.slice(p.rec.file.lastIndexOf('.') + 1)}`);
            await saveRecording(this.hub, p.rec, f);
            files.push(f);
          }
          const ext = parts[0]!.rec.file.slice(parts[0]!.rec.file.lastIndexOf('.') + 1) as ShowImport['ext'];
          const audio = await joinParts(files, join(dir, `show.${ext}`));
          const size = (await stat(audio)).size;
          const show: ShowImport = { sessionId, dj: session.accountName, startedAt: parts[0]!.rec.startedAt, ext, contentType: parts[0]!.rec.contentType, size };
          if (station.nodeId) {
            if (!this.tunnels) throw new Error('No connection to station nodes here');
            const query = new URLSearchParams({ ...show, startedAt: show.startedAt.toISOString(), size: String(size) });
            await readJson(
              await nodeRequest(this.tunnels, station.nodeId, 'PUT', `/api/internal/station-node/ondemand/${station.id}?${query}`, {
                body: createReadStream(audio),
                contentType: 'application/octet-stream',
                contentLength: size,
                timeoutMs: 30 * 60_000,
              }),
            );
          } else {
            await importShow(this.ctx, station.id, show, createReadStream(audio));
          }
        });
        await this.ctx.db.update(r).set({ ondemandAt: new Date() }).where(eq(r.sessionId, sessionId));
        this.showRetry.delete(sessionId);
        this.log.info({ station: station.slug, dj: session.accountName }, 'a recorded show is now an on-demand item');
      } catch (err) {
        this.showRetry.set(sessionId, now.getTime() + 10 * 60_000);
        this.log.warn({ err, station: station.slug, sessionId }, 'making a recorded show an on-demand item failed');
      }
      done++;
    }
  }

  /**
   * Recordings of stations that remove what was uploaded: once every enabled destination that takes the recording has
   * it (and a show is an on-demand item, when the station wants that), the recorder is asked to remove the file.
   */
  private async cleanUp(now: Date) {
    const stations = (await this.ctx.db.select({ id: schema.stations.id, recording: schema.stations.recording }).from(schema.stations)).filter((s) => stationRecording(s).deleteUploaded);
    if (!stations.length) return;
    for (const [file, at] of this.removing) if (now.getTime() - at > 10 * 60_000) this.removing.delete(file);
    const dests = await this.ctx.db
      .select()
      .from(schema.recordingDestinations)
      .where(and(eq(schema.recordingDestinations.enabled, true), inArray(schema.recordingDestinations.stationId, stations.map((s) => s.id))));
    if (!dests.length) return;
    const r = schema.recordings;
    const d = schema.recordingDeliveries;
    const rows = await this.ctx.db
      .select({ rec: r, done: sql<string[]>`coalesce(array_agg(${d.destinationId}) filter (where ${d.state} = 'done'), '{}')` })
      .from(r)
      .leftJoin(d, eq(d.recordingId, r.id))
      .where(and(inArray(r.stationId, [...new Set(dests.map((x) => x.stationId))]), eq(r.open, false)))
      .groupBy(r.id)
      .limit(5000);
    const wants = new Map(stations.map((s) => [s.id, stationRecording(s)]));
    for (const { rec, done } of rows) {
      if (this.removing.has(`${rec.nodeId}:${rec.file}`)) continue;
      const need = dests.filter((x) => x.stationId === rec.stationId && x.kinds.includes(rec.kind) && rec.startedAt.getTime() >= x.createdAt.getTime() - BACKFILL_MS);
      if (!need.length || !need.every((x) => done.includes(x.id))) continue;
      if (rec.kind === 'show' && wants.get(rec.stationId)?.showsOnDemand && !rec.ondemandAt) continue;
      if (this.hub.deleteRecording(rec.nodeId, rec.file)) this.removing.set(`${rec.nodeId}:${rec.file}`, now.getTime());
    }
  }
}
