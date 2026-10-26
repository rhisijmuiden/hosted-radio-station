import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import WebSocket from 'ws';
import { z } from 'zod';
import { schema } from '../../db/index.js';
import { TUNNEL_CALL_TOKEN } from '../../lib/auth.js';
import type { AppContext } from '../../lib/context.js';
import { mediaDir } from '../streaming/icecast.js';
import { applyStreams, stationStats } from '../streaming/state.js';
import { scanStationStorage } from '../streaming/storage.js';
import { workerStatusPath, workerStatusSchema } from '../streaming/status.js';
import { applyPackage } from './apply.js';
import { allRows, clearStationTables, forgetChanges, installChangeTracking, lastChange, pendingChanges } from './changes.js';
import { missingFiles, receiveFile, type FileEntry } from './files.js';
import type { MirrorBatch } from './mirror.js';
import type { StationPackage } from './package.js';
import { HOP_BY_HOP, TunnelPeer } from './tunnel.js';
import { NODE_TABLES, upsertRows, fromWire, type WireRow } from './tables.js';

/**
 * The file the node agent writes for the API of a station node: where the main server is and how to sign in.
 * `servers` may list more than one address (a standby orchestrator); the node uses the first that answers.
 */
const linkConfigSchema = z
  .object({ server: z.string().url().optional(), servers: z.array(z.string().url()).optional(), nodeId: z.uuid(), secret: z.string().min(16) })
  .refine((c) => c.server || c.servers?.length, 'server missing');
export type LinkConfig = { servers: string[]; nodeId: string; secret: string };

export async function readLinkConfig(path: string): Promise<LinkConfig> {
  const c = linkConfigSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  return { servers: [...new Set([...(c.servers ?? []), ...(c.server ? [c.server] : [])].map((s) => s.replace(/\/$/, '')))], nodeId: c.nodeId, secret: c.secret };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs on a station node (phase 12), inside its API. Keeps the node in line with the main server:
 * - takes its package (long poll) and applies it;
 * - prepares stations that move here (tables and library), then reports that they are ready;
 * - reports what changed in its own tables and how its stations are doing, every few seconds;
 * - keeps a tunnel open so the main server can pass on panel requests for its stations.
 */
export class StationNodeLink {
  private cfg: LinkConfig | null = null;
  private server = 0;
  private stopped = false;
  private readonly abort = new AbortController();
  private revision: string | null = null;
  private pkg: StationPackage | null = null;
  private active: string[] = [];
  /** Stations whose tables were taken over since they became active here. */
  private seeded = new Set<string>();
  private preparing = new Map<string, Promise<void>>();
  private needFull = true;
  private ws: WebSocket | null = null;
  private mirroring: Promise<void> | null = null;
  private storageAt = 0;
  private timers: NodeJS.Timeout[] = [];
  state: { connected: boolean; tunnel: boolean; lastPackageAt: string | null; lastMirrorAt: string | null; error: string | null } = {
    connected: false,
    tunnel: false,
    lastPackageAt: null,
    lastMirrorAt: null,
    error: null,
  };

  constructor(
    private readonly ctx: AppContext,
    private readonly log: FastifyBaseLogger,
  ) {}

  private get base() {
    return this.cfg!.servers[this.server % this.cfg!.servers.length]!;
  }

  private get auth() {
    return `Node ${this.cfg!.nodeId}.${this.cfg!.secret}`;
  }

  /** Tries the next main server address (when there is more than one). */
  private failover() {
    if (this.cfg && this.cfg.servers.length > 1) this.server++;
  }

  private async call(method: string, path: string, body?: unknown, timeoutMs = 60_000) {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: { authorization: this.auth, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), this.abort.signal]),
    });
    if (res.status >= 400) throw new Error(`${method} ${path}: ${res.status} ${(await res.text()).slice(0, 200)}`);
    return res;
  }

  async start() {
    this.cfg = await readLinkConfig(this.ctx.config.STATION_NODE);
    await installChangeTracking(this.ctx);
    // Stations that already run here were seeded before.
    const rows = await this.ctx.db.select({ id: schema.stations.id }).from(schema.stations).where(eq(schema.stations.enabled, true));
    for (const r of rows) this.seeded.add(r.id);
    void this.packageLoop();
    this.connectTunnel();
    this.timers.push(setInterval(() => void this.mirror(), 5000));
    // Once a day everything again, in case a change got lost.
    this.timers.push(setInterval(() => (this.needFull = true), 24 * 3600_000));
    for (const t of this.timers) t.unref();
    this.log.info({ servers: this.cfg.servers }, 'station node link started');
  }

  stop() {
    this.stopped = true;
    this.abort.abort();
    for (const t of this.timers) clearInterval(t);
    this.ws?.close(1001, 'stopping');
  }

  // ---- package ----

  private async packageLoop() {
    while (!this.stopped) {
      try {
        const q = new URLSearchParams({ wait: '25', ...(this.revision ? { rev: this.revision } : {}) });
        const res = await this.call('GET', `/api/nodes/agent/station/package?${q}`, undefined, 40_000);
        this.state.connected = true;
        this.state.error = null;
        if (res.status === 304) continue;
        const pkg = (await res.json()) as StationPackage;
        await this.apply(pkg);
      } catch (err) {
        if (this.stopped) return;
        this.state.connected = false;
        this.state.error = (err as Error).message;
        this.log.warn({ err }, 'station package failed');
        this.failover();
        await sleep(5000);
      }
    }
  }

  private async apply(pkg: StationPackage) {
    const r = await applyPackage(this.ctx, pkg, (id) => this.seeded.has(id));
    this.pkg = pkg;
    this.revision = pkg.revision;
    this.state.lastPackageAt = new Date().toISOString();
    for (const id of r.removed) this.seeded.delete(id);
    // A station that just switched over: take the latest state of its tables once more, then switch it on.
    for (const id of r.active) {
      if (this.seeded.has(id)) continue;
      await this.takeOver(id);
      const enabled = pkg.stations.find((p) => p.station.id === id)?.station.enabled === true;
      if (this.seeded.has(id) && enabled) await this.ctx.db.update(schema.stations).set({ enabled: true }).where(eq(schema.stations.id, id));
    }
    this.active = r.active.filter((id) => this.seeded.has(id));
    for (const id of r.moving) if (!this.preparing.has(id)) this.prepare(id);
    await applyStreams(this.ctx, { stationIds: [...r.stationIds], by: 'main server' });
    this.log.info({ revision: pkg.revision, active: r.active.length, moving: r.moving.length, removed: r.removed.length }, 'station package applied');
  }

  private async takeOver(stationId: string) {
    try {
      await this.seedTables(stationId);
      // Files that were added on the main server during the move.
      await this.copyFiles(stationId, () => undefined);
      this.seeded.add(stationId);
      this.needFull = true;
    } catch (err) {
      this.log.warn({ err, stationId }, 'taking over a station failed; trying again shortly');
      this.revision = null;
      await sleep(10_000);
    }
  }

  /** Copies the tables of a station from the main server, replacing what is here. */
  private async seedTables(stationId: string) {
    const pages: { t: (typeof NODE_TABLES)[number]; rows: WireRow[] }[] = [];
    for (const t of NODE_TABLES) {
      let after = '';
      for (;;) {
        const q = new URLSearchParams({ after, limit: '2000' });
        const res = (await (await this.call('GET', `/api/nodes/agent/station/seed/${stationId}/${t.name}?${q}`)).json()) as { rows: WireRow[]; next: string | null };
        if (res.rows.length) pages.push({ t, rows: res.rows });
        if (!res.next) break;
        after = res.next;
      }
    }
    await this.ctx.db.transaction(async (tx) => {
      await clearStationTables(tx as never, stationId);
      for (const p of pages) await upsertRows(tx as never, p.t, p.rows.map((r) => fromWire(p.t, r, this.ctx.box)));
    });
  }

  /** Copies the media files of a station that the node misses. */
  private async copyFiles(stationId: string, progress: (p: { files: number; filesDone: number; bytes: number; bytesDone: number }) => unknown) {
    const { files } = (await (await this.call('GET', `/api/nodes/agent/station/files/${stationId}`, undefined, 300_000)).json()) as { files: FileEntry[] };
    const root = mediaDir(this.ctx, stationId);
    const todo = await missingFiles(root, files);
    const p = { files: todo.length, filesDone: 0, bytes: todo.reduce((n, f) => n + f.size, 0), bytesDone: 0 };
    await progress(p);
    let reported = Date.now();
    for (const f of todo) {
      const res = await this.call('GET', `/api/nodes/agent/station/files/${stationId}/file?${new URLSearchParams({ path: f.path })}`, undefined, 30 * 60_000);
      await receiveFile(root, f, Readable.fromWeb(res.body as never));
      p.filesDone++;
      p.bytesDone += f.size;
      if (Date.now() - reported > 3000) {
        reported = Date.now();
        await progress(p);
      }
    }
    return p;
  }

  /** A station that moves here: its library and tables, then "ready"; the main server switches it over. */
  private prepare(stationId: string) {
    const run = (async () => {
      const report = (state: 'copying' | 'ready' | 'failed', p: { files: number; filesDone: number; bytes: number; bytesDone: number }, message?: string) =>
        this.call('POST', `/api/nodes/agent/station/move/${stationId}`, { state, ...p, message });
      let last = { files: 0, filesDone: 0, bytes: 0, bytesDone: 0 };
      try {
        last = await this.copyFiles(stationId, (p) => report('copying', p));
        await this.seedTables(stationId);
        await report('ready', last);
        this.log.info({ stationId, files: last.files }, 'station ready to switch over');
      } catch (err) {
        this.log.warn({ err, stationId }, 'preparing a station failed');
        await report('failed', last, (err as Error).message.slice(0, 300)).catch(() => undefined);
      }
    })().finally(() => this.preparing.delete(stationId));
    this.preparing.set(stationId, run);
  }

  // ---- mirror ----

  /** Sends changed rows and the state of the stations. `full`: every row (start, once a day, before a move back). */
  mirror(full = false): Promise<void> {
    if (this.mirroring) return full ? this.mirroring.then(() => this.mirror(true)) : this.mirroring;
    this.mirroring = (async () => {
      if (!this.cfg || !this.pkg) return;
      try {
        if (full || this.needFull) await this.fullSync();
        else {
          const changes = await pendingChanges(this.ctx, this.active);
          const batch: MirrorBatch = { stationIds: this.active, upserts: changes.upserts, deletes: changes.deletes, full: null, runtime: await this.runtime() };
          await this.call('POST', '/api/nodes/agent/station/mirror', batch);
          await forgetChanges(this.ctx, changes.lastSeq);
        }
        this.state.lastMirrorAt = new Date().toISOString();
      } catch (err) {
        this.log.warn({ err }, 'station report failed');
      } finally {
        this.mirroring = null;
      }
    })();
    return this.mirroring;
  }

  private async fullSync() {
    const upTo = await lastChange(this.ctx);
    const stationIds = this.active;
    const keys: Record<string, string[]> = {};
    for (const t of NODE_TABLES) {
      keys[t.name] = [];
      for await (const rows of allRows(this.ctx, t, stationIds)) {
        for (const r of rows) keys[t.name]!.push(t.pk.map((k) => String(r[k])).join('|'));
        await this.call('POST', '/api/nodes/agent/station/mirror', { stationIds, upserts: { [t.name]: rows }, deletes: {}, full: null, runtime: {} } satisfies MirrorBatch, 120_000);
      }
    }
    await this.call('POST', '/api/nodes/agent/station/mirror', { stationIds, upserts: {}, deletes: {}, full: { keys }, runtime: await this.runtime() } satisfies MirrorBatch, 300_000);
    await forgetChanges(this.ctx, upTo);
    this.needFull = false;
  }

  /** How each running station is doing: mounts, AutoDJ, encoders, pushes to the relays, storage. */
  private async runtime(): Promise<MirrorBatch['runtime']> {
    const out: MirrorBatch['runtime'] = {};
    if (!this.active.length) return out;
    let autodj: Record<string, { seenAt: string | null; paused: boolean; reachable: boolean }> = {};
    try {
      const w = workerStatusSchema.parse(JSON.parse(await readFile(workerStatusPath(this.ctx), 'utf8')));
      if (Date.now() - new Date(w.updatedAt).getTime() < 30_000) autodj = w.autodj;
    } catch {
      /* the streams service is not running */
    }
    // Folder sizes every ten minutes.
    const scan = Date.now() - this.storageAt > 10 * 60_000;
    if (scan) this.storageAt = Date.now();
    for (const id of this.active) {
      const [station] = await this.ctx.db.select().from(schema.stations).where(eq(schema.stations.id, id));
      if (!station) continue;
      const [stats, encoders, outputs] = await Promise.all([
        stationStats(this.ctx, station),
        this.ctx.db.select({ n: sql<number>`count(*)::int` }).from(schema.liveSessions).where(and(eq(schema.liveSessions.stationId, id), isNull(schema.liveSessions.endedAt))),
        this.ctx.db.select().from(schema.stationOutputs).where(and(eq(schema.stationOutputs.stationId, id), isNotNull(sql`${schema.stationOutputs.config}->>'relayNodeId'`))),
      ]);
      const relays: MirrorBatch['runtime'][string]['relays'] = {};
      for (const o of outputs) {
        const relayId = o.config.relayNodeId!;
        const state = o.status?.state ?? 'idle';
        // One relay can take several mounts: the worst state counts.
        const rank = { error: 3, connecting: 2, idle: 1, connected: 0 } as const;
        const prev = relays[relayId];
        if (!prev || rank[state] > rank[prev.state]) relays[relayId] = { state, ...(o.status?.message ? { message: o.status.message.slice(0, 300) } : {}) };
      }
      const a = autodj[id];
      let storageBytes: number | null = null;
      if (scan) storageBytes = await scanStationStorage(this.ctx, id).catch(() => null);
      out[id] = {
        mounts: (stats ?? []).map((s) => ({
          mount: s.mount,
          title: s.title,
          listeners: s.listeners,
          bitrateKbps: s.bitrateKbps,
          contentType: s.contentType,
          listenerPeak: s.listenerPeak,
          streamStart: s.streamStart,
        })),
        autodj: a ? { connected: a.reachable, paused: a.paused, seenAt: a.seenAt } : null,
        encoders: encoders[0]?.n ?? 0,
        relays,
        revision: this.revision,
        storageBytes,
      };
    }
    return out;
  }

  // ---- tunnel ----

  private connectTunnel() {
    if (this.stopped || !this.cfg) return;
    const url = `${this.base.replace(/^http/, 'ws')}/api/nodes/agent/station/tunnel`;
    const ws = new WebSocket(url, { headers: { authorization: this.auth }, maxPayload: 256 * 1024, handshakeTimeout: 15_000 });
    this.ws = ws;
    const peer = new TunnelPeer(ws, 'n');
    peer.onRequest = (head, body, respond) => this.local(head, body, respond);
    let alive = Date.now();
    const watchdog = setInterval(() => {
      // The main server pings every 15 seconds.
      if (Date.now() - alive > 45_000) ws.terminate();
    }, 5000);
    watchdog.unref();
    ws.on('open', () => {
      this.state.tunnel = true;
      this.log.info('station node tunnel open');
    });
    ws.on('ping', () => (alive = Date.now()));
    ws.on('message', (data, isBinary) => {
      alive = Date.now();
      peer.handle(data as Buffer, isBinary);
    });
    ws.on('error', (err) => this.log.debug({ err }, 'station node tunnel error'));
    ws.on('close', (code) => {
      clearInterval(watchdog);
      peer.close();
      this.state.tunnel = false;
      if (this.ws === ws) this.ws = null;
      if (code !== 4409) this.failover();
      if (!this.stopped) setTimeout(() => this.connectTunnel(), 5000).unref();
    });
  }

  /** Passes a request from the main server to this node's own API, as the user the main server names. */
  private local(head: { method: string; path: string; headers: Record<string, string> }, body: Readable, respond: (h: { status: number; headers: Record<string, string | string[]> }, b?: Readable | string | null) => void) {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(head.headers)) if (!HOP_BY_HOP.has(k.toLowerCase()) && k.toLowerCase() !== 'x-hrs-tunnel') headers[k] = v;
    headers['x-hrs-tunnel'] = TUNNEL_CALL_TOKEN;
    const req = http.request({ host: '127.0.0.1', port: this.ctx.config.PORT, method: head.method, path: head.path, headers }, (res) => {
      const out: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(res.headers)) if (v !== undefined && !HOP_BY_HOP.has(k)) out[k] = v;
      respond({ status: res.statusCode ?? 502, headers: out }, res);
    });
    req.on('error', (err) => respond({ status: 502, headers: { 'content-type': 'application/json' } }, JSON.stringify({ error: { code: 'node_error', message: err.message } })));
    body.pipe(req);
  }
}
