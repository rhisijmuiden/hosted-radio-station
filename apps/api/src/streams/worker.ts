import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type pino from 'pino';
import { schema } from '../db/index.js';
import type { OutputStatus } from '../db/schema.js';
import type { AppContext } from '../lib/context.js';
import { fetchStats, internalReaders, killSource, updateMetadata, type MountStats } from '../services/streaming/icecast.js';
import { workerStatusPath, type WorkerStatus } from '../services/streaming/status.js';
import { ListenerCollector } from './collector.js';
import { IngestGateway } from './gateway.js';
import { externalListeners, Pusher, Transcoder, type Relay } from './relays.js';
import { loadSnapshot, type Snapshot, type StationView } from './snapshot.js';

/**
 * The streams service (hosted-radio-streams): the ingest gateway for encoders, transcoders and relays to external
 * servers, and a monitor that forwards titles and enforces bitrate limits. It runs apart from the API, so an update
 * of the panel does not drop live broadcasts. The Icecast servers themselves run as their own systemd units.
 */
export class StreamsWorker {
  private snap: Snapshot | null = null;
  readonly gateway: IngestGateway;
  readonly collector: ListenerCollector;
  private relays = new Map<string, Relay>();
  /** Per station: mounts on air with their last title. */
  private live = new Map<string, Map<string, MountStats>>();
  /** Per station: readers of each mount that are our own transcoders and relays. */
  private internal: WorkerStatus['internal'] = {};
  private externalPolledAt = 0;
  private timers: NodeJS.Timeout[] = [];
  private reloading: Promise<void> | null = null;
  private readonly startedAt = new Date().toISOString();

  constructor(
    private readonly ctx: AppContext,
    private readonly log: pino.Logger,
  ) {
    this.gateway = new IngestGateway(ctx, log as never);
    this.collector = new ListenerCollector(ctx, log, () => this.snap);
  }

  async start() {
    // Broadcasts that were open when the service stopped have ended.
    await this.ctx.db
      .update(schema.liveSessions)
      .set({ endedAt: new Date(), endReason: sql`coalesce(${schema.liveSessions.endReason}, 'restart')` })
      .where(isNull(schema.liveSessions.endedAt));
    await this.reload();
    await this.collector.start();
    this.timers.push(setInterval(() => void this.tick().catch((err) => this.log.error({ err }, 'monitor failed')), 3000));
    this.timers.push(setInterval(() => void this.reload(), 30_000));
    this.timers.push(setInterval(() => void this.writeStatus(), 5000));
  }

  async stop() {
    for (const t of this.timers) clearInterval(t);
    for (const r of this.relays.values()) r.stop();
    await this.collector.stop().catch(() => undefined);
    await this.gateway.close();
  }

  /** Reloads stations from the database; called on notifications from the API and every 30 seconds. */
  reload() {
    this.reloading ??= (async () => {
      try {
        this.snap = await loadSnapshot(this.ctx);
        await this.gateway.configure(this.snap);
        this.reconcile();
      } catch (err) {
        this.log.error({ err }, 'loading stations failed');
      } finally {
        this.reloading = null;
      }
    })();
    return this.reloading;
  }

  /** Starts the relays whose input is on air, stops the others and restarts the ones whose settings changed. */
  private reconcile() {
    const snap = this.snap;
    if (!snap) return;
    const wanted = new Map<string, Relay>();
    for (const view of snap.stations.values()) {
      if (!view.active) continue;
      const live = this.live.get(view.station.id) ?? new Map();
      for (const m of view.mounts) {
        if (m.kind !== 'transcode' || !m.sourceMountId) continue;
        const source = view.mounts.find((x) => x.id === m.sourceMountId);
        if (source && live.has(source.path)) wanted.set(`transcode:${m.id}`, new Transcoder(view, m, source, this.log as never));
      }
      for (const o of view.outputs) {
        if (o.type === 'local' || !o.enabled || o.config.push === false || !o.mountId) continue;
        const mount = view.mounts.find((x) => x.id === o.mountId);
        if (mount && live.has(mount.path)) wanted.set(`push:${o.id}`, new Pusher(this.ctx, view, o, mount, this.log as never));
      }
    }
    for (const [id, relay] of this.relays) {
      const next = wanted.get(id);
      if (!next || next.key !== relay.key) {
        relay.stop();
        this.relays.delete(id);
        if (id.startsWith('push:')) void this.saveOutputStatus(id.slice(5), { state: 'idle' });
      }
    }
    for (const [id, relay] of wanted) {
      if (this.relays.has(id)) continue;
      relay.onState = (s) => {
        if (id.startsWith('push:')) void this.saveOutputStatus(id.slice(5), { state: s.state, message: s.message, since: s.since });
      };
      this.relays.set(id, relay);
      relay.start();
    }
  }

  private async saveOutputStatus(outputId: string, patch: Partial<OutputStatus>) {
    await this.ctx.db
      .update(schema.stationOutputs)
      .set({ status: sql`coalesce(${schema.stationOutputs.status}, '{}'::jsonb) || ${JSON.stringify({ ...patch, checkedAt: new Date().toISOString() })}::jsonb` })
      .where(eq(schema.stationOutputs.id, outputId))
      .catch((err) => this.log.warn({ err }, 'saving output status failed'));
  }

  /** Every few seconds: which mounts are on air, new titles, bitrate limits; external listener counts every 30 s. */
  private async tick() {
    const snap = this.snap;
    if (!snap) return;
    let changed = false;
    for (const id of Object.keys(this.internal)) if (!snap.stations.get(id)?.active) delete this.internal[id];
    await Promise.all(
      [...snap.stations.values()].filter((v) => v.active).map(async (view) => {
        let stats: MountStats[];
        try {
          stats = await fetchStats({ port: view.station.icecastPort, adminPassword: view.adminPassword });
        } catch {
          stats = [];
        }
        const before = this.live.get(view.station.id) ?? new Map<string, MountStats>();
        const now = new Map(stats.map((s) => [s.mount, s]));
        if ([...now.keys()].sort().join() !== [...before.keys()].sort().join()) changed = true;
        for (const s of stats) {
          const prev = before.get(s.mount);
          if (s.title && s.title !== prev?.title) void this.forwardTitle(view, s.mount, s.title);
          this.enforceBitrate(view, s);
        }
        this.live.set(view.station.id, now);
        await this.countInternal(view, now);
        await this.collector.observe(view, now, this.internal[view.station.id] ?? {}).catch((err) => this.log.warn({ err }, 'statistics failed'));
      }),
    );
    if (changed) this.reconcile();
    await this.collector.flush().catch((err) => this.log.warn({ err }, 'saving listener counts failed'));
    void this.collector.reconcile(snap, this.live).catch((err) => this.log.warn({ err }, 'checking listener sessions failed'));
    if (Date.now() - this.externalPolledAt > 30_000) {
      this.externalPolledAt = Date.now();
      void this.pollExternal(snap);
    }
  }

  /** Counts the readers of our own jobs on the mounts they read, so the panel can leave them out of listener counts. */
  private async countInternal(view: StationView, live: Map<string, MountStats>) {
    const read = new Set([...this.relays.values()].filter((r) => r.input.stationId === view.station.id && live.has(r.input.mount)).map((r) => r.input.mount));
    const counts: Record<string, number> = {};
    await Promise.all(
      [...read].map(async (mount) => {
        counts[mount] = await internalReaders({ port: view.station.icecastPort, adminPassword: view.adminPassword }, mount).catch(() => 0);
      }),
    );
    if (Object.keys(counts).length) this.internal[view.station.id] = counts;
    else delete this.internal[view.station.id];
  }

  /** A new title on a mount goes to the mounts converted from it and to the external servers it feeds. */
  private async forwardTitle(view: StationView, mountPath: string, title: string) {
    const mount = view.mounts.find((m) => m.path === mountPath);
    if (!mount) return;
    for (const t of view.mounts.filter((m) => m.kind === 'transcode' && m.sourceMountId === mount.id && (m.format === 'mp3' || m.format === 'aac'))) {
      await updateMetadata({ port: view.station.icecastPort, adminPassword: view.adminPassword }, t.path, title).catch(() => undefined);
    }
    for (const o of view.outputs.filter((o) => o.mountId === mount.id)) {
      const relay = this.relays.get(`push:${o.id}`);
      if (relay instanceof Pusher) await relay.updateTitle(title).catch((err) => this.log.debug({ err, output: o.name }, 'title update failed'));
    }
  }

  private enforceBitrate(view: StationView, s: MountStats) {
    const mount = view.mounts.find((m) => m.path === s.mount);
    if (!mount || mount.kind !== 'source' || !s.bitrateKbps) return;
    const limit = Math.min(mount.bitrateKbps, view.maxBitrateKbps);
    if (s.bitrateKbps <= limit * 1.05) return;
    this.log.warn({ station: view.station.slug, mount: s.mount, bitrate: s.bitrateKbps, limit }, 'encoder above the bitrate limit, disconnecting');
    void this.ctx.db
      .update(schema.liveSessions)
      .set({ endReason: 'bitrate' })
      .where(and(eq(schema.liveSessions.stationId, view.station.id), eq(schema.liveSessions.mountPath, s.mount), isNull(schema.liveSessions.endedAt)))
      .then(() => killSource({ port: view.station.icecastPort, adminPassword: view.adminPassword }, s.mount))
      .catch(() => undefined);
  }

  private async pollExternal(snap: Snapshot) {
    for (const view of snap.stations.values()) {
      if (!view.active) continue;
      for (const o of view.outputs) {
        if (o.type === 'local' || !o.enabled) continue;
        try {
          const r = await externalListeners(this.ctx, o);
          const patch: Partial<OutputStatus> = { listeners: r.listeners };
          this.collector.setExternalCount(view.station.id, o.id, r.listeners);
          // Watched servers (no push) report whether their encoder is on air.
          if (o.config.push === false) Object.assign(patch, { state: r.live ? 'connected' : 'idle', message: r.title ?? undefined });
          await this.saveOutputStatus(o.id, patch);
        } catch (err) {
          const patch: Partial<OutputStatus> = { listeners: null };
          this.collector.setExternalCount(view.station.id, o.id, null);
          if (o.config.push === false) Object.assign(patch, { state: 'error', message: (err as Error).message });
          await this.saveOutputStatus(o.id, patch);
        }
      }
    }
  }

  private async writeStatus() {
    const status: WorkerStatus = {
      pid: process.pid,
      startedAt: this.startedAt,
      updatedAt: new Date().toISOString(),
      ingest: { ...this.gateway.portStates(), certificates: this.gateway.certificateHosts },
      relays: [...this.relays.values()].map((r) => r.state),
      encoders: this.gateway.liveCount,
      internal: this.internal,
    };
    const path = workerStatusPath(this.ctx);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(`${path}.tmp`, JSON.stringify(status, null, 2), { mode: 0o640 });
    await rename(`${path}.tmp`, path);
  }
}
