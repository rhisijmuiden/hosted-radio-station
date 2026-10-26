import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import http from 'node:http';
import { dirname } from 'node:path';
import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { schema } from '../db/index.js';
import type { AppContext } from '../lib/context.js';
import { itemPath, probe, RECORDINGS_FOLDER } from '../services/public/ondemand.js';
import { publicSettings } from '../services/public/settings.js';
import { CONTENT_TYPES, INTERNAL_AGENT } from '../services/streaming/icecast.js';
import type { Mount } from '../services/streaming/state.js';
import { Relay } from './relays.js';
import type { StationView } from './snapshot.js';

const EXTENSIONS: Record<Mount['format'], string> = { mp3: 'mp3', aac: 'aac', opus: 'opus', vorbis: 'ogg' };

export interface LiveBroadcast {
  sessionId: string;
  stationId: string;
  mountPath: string;
  accountName: string;
  startedAt: Date;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** "recordings/2026-10-26 2100 DJ Reinder.mp3", with only safe characters. */
export function recordingFile(b: LiveBroadcast, format: Mount['format'], timeZone = process.env.TZ) {
  const d = new Date(b.startedAt.toLocaleString('en-US', { timeZone }));
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}`;
  const who = b.accountName.replace(/[^\p{L}\p{N} ._-]+/gu, '').trim().slice(0, 60) || 'live';
  return `${RECORDINGS_FOLDER}/${stamp} ${who} ${b.sessionId.slice(0, 6)}.${EXTENSIONS[format]}`;
}

/**
 * Records a live broadcast into the station's media folder by listening to its source mount on the local Icecast
 * server, the way a listener would (so the encoder protocol does not matter). The recording becomes an on-demand item:
 * a draft, or published right away when the station wants that. Short recordings (a DJ testing) are thrown away.
 */
export class Recorder extends Relay {
  readonly key: string;
  readonly input: { stationId: string; mount: string };
  readonly file: string;
  private req: http.ClientRequest | null = null;
  private out: WriteStream | null = null;
  private bytes = 0;
  private itemId: string | null = null;
  private finished = false;
  private begun: Promise<void> | null = null;

  constructor(
    private readonly ctx: AppContext,
    private readonly view: StationView,
    private readonly mount: Mount,
    private readonly broadcast: LiveBroadcast,
    /** Bytes the customer may still store. */
    private readonly room: number,
    log: FastifyBaseLogger,
  ) {
    super(`record:${broadcast.sessionId}`, 'record', view.station.slug, `${mount.path} → ${RECORDINGS_FOLDER}`, log);
    this.key = JSON.stringify([broadcast.sessionId, view.station.icecastPort, mount.path]);
    this.input = { stationId: view.station.id, mount: mount.path };
    this.file = recordingFile(broadcast, mount.format);
  }

  private begin() {
    this.begun ??= (async () => {
      await mkdir(dirname(itemPath(this.ctx, this.view.station.id, this.file)), { recursive: true, mode: 0o775 });
      const [row] = await this.ctx.db
        .insert(schema.onDemandItems)
        .values({
          stationId: this.view.station.id,
          source: 'recording',
          file: this.file,
          title: this.file.split('/').pop()!.replace(/ [0-9a-f]{6}\.[a-z0-9]+$/, '').slice(0, 200),
          host: this.broadcast.accountName,
          liveSessionId: this.broadcast.sessionId,
          contentType: CONTENT_TYPES[this.mount.format],
        })
        .onConflictDoNothing()
        .returning({ id: schema.onDemandItems.id });
      this.itemId = row?.id ?? null;
    })();
    return this.begun;
  }

  protected async run() {
    await this.begin();
    if (this.bytes >= this.room) throw new Error('storage limit reached');
    const path = itemPath(this.ctx, this.view.station.id, this.file);
    return new Promise<void>((resolve, reject) => {
      const req = http.get(
        { host: '127.0.0.1', port: this.view.station.icecastPort, path: this.mount.path, headers: { 'user-agent': `${INTERNAL_AGENT} recorder` } },
        (res) => {
          if (res.statusCode !== 200) {
            res.resume();
            return reject(new Error(`local server answered ${res.statusCode}`));
          }
          this.set('connected');
          const out = createWriteStream(path, { flags: 'a', mode: 0o664 });
          this.out = out;
          res.on('data', (chunk: Buffer) => {
            this.bytes += chunk.length;
            if (this.bytes >= this.room) {
              req.destroy(new Error('storage limit reached'));
              return;
            }
            if (!out.write(chunk)) res.pause();
          });
          out.on('drain', () => res.resume());
          out.on('error', (err) => req.destroy(err));
          res.on('end', () => out.end(() => resolve()));
          res.on('error', (err) => out.end(() => reject(err)));
        },
      );
      this.req = req;
      req.on('error', (err) => {
        this.out?.end();
        reject(err);
      });
    });
  }

  protected halt() {
    this.req?.destroy();
    this.req = null;
    this.out?.end();
    this.out = null;
  }

  /** Resolves when the recording is saved after stop(). */
  finishing: Promise<void> | null = null;

  override stop() {
    super.stop();
    this.finishing ??= this.finish().catch((err) => this.log.warn({ err, file: this.file }, 'finishing a recording failed'));
  }

  /** The broadcast ended: keep the recording as an on-demand item, or remove it when it is too short. */
  private async finish() {
    if (this.finished) return;
    this.finished = true;
    await this.begun?.catch(() => undefined);
    // Let the file stream close.
    await new Promise((r) => setTimeout(r, 500));
    const path = itemPath(this.ctx, this.view.station.id, this.file);
    const [station] = await this.ctx.db.select({ publicPage: schema.stations.publicPage }).from(schema.stations).where(eq(schema.stations.id, this.view.station.id));
    const settings = publicSettings(station ?? { publicPage: {} }).recording;
    const st = await stat(path).catch(() => null);
    const p = st ? await probe(path) : { durationSeconds: null };
    const seconds = p.durationSeconds ?? Math.round((Date.now() - this.broadcast.startedAt.getTime()) / 1000);
    if (!st || st.size === 0 || seconds < settings.minMinutes * 60) {
      await rm(path, { force: true });
      if (this.itemId) await this.ctx.db.delete(schema.onDemandItems).where(eq(schema.onDemandItems.id, this.itemId));
      return;
    }
    if (this.itemId) {
      await this.ctx.db
        .update(schema.onDemandItems)
        .set({ sizeBytes: st.size, durationSeconds: seconds, recordedAt: this.broadcast.startedAt, publishedAt: settings.autoPublish ? new Date() : null })
        .where(eq(schema.onDemandItems.id, this.itemId));
    }
    this.log.info({ station: this.view.station.slug, file: this.file, seconds }, 'recording saved');
  }
}
