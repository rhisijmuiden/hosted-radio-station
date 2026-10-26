import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type pino from 'pino';
import { schema } from '../db/index.js';
import type { NodeStatus, OutputStatus } from '../db/schema.js';
import type { AppContext } from '../lib/context.js';
import { NOWPLAYING_CHANNEL } from '../services/public/hub.js';
import { finishStaleRecordings } from '../services/public/ondemand.js';
import { publicSettings } from '../services/public/settings.js';
import { fetchStats, internalReaders, killSource, updateMetadata, type MountStats } from '../services/streaming/icecast.js';
import { nodeStationStats, type Station } from '../services/streaming/state.js';
import { workerStatusPath, type WorkerStatus } from '../services/streaming/status.js';
import { ListenerCollector } from './collector.js';
import { IngestGateway } from './gateway.js';
import { Recorder } from './recorder.js';
import { externalListeners, Pusher, Transcoder, type Relay } from './relays.js';
import { AutodjController } from './autodj.js';
import { heard, loadSnapshot, type Snapshot, type StationView } from './snapshot.js';

/** The mounts a station has on air on an ingest node, as statistics of this server (listeners are on the relays). */
function ingestStats(status: NodeStatus | undefined, stationId: string): MountStats[] {
  if (!status?.online) return [];
  // A status that was not refreshed for a while is from a node that hangs.
  if (status.updatedAt && Date.now() - new Date(status.updatedAt).getTime() > 30_000) return [];
  return (status.ingest ?? [])
    .filter((m) => m.stationId === stationId)
    .map((m) => ({ mount: m.mount, listeners: 0, listenerPeak: 0, title: m.title, bitrateKbps: m.bitrateKbps, contentType: m.contentType, sourceIp: null, userAgent: null, streamStart: null, bytesRead: 0, bytesSent: 0 }));
}

/**
 * The streams service (hosted-radio-streams): the ingest gateway for encoders, transcoders and relays to external
 * servers, and a monitor that forwards titles and enforces bitrate limits. It runs apart from the API, so an update
 * of the panel does not drop live broadcasts. The Icecast servers themselves run as their own systemd units.
 */
export class StreamsWorker {
  private snap: Snapshot | null = null;
  readonly gateway: IngestGateway;
  readonly collector: ListenerCollector;
  readonly autodj: AutodjController;
  private relays = new Map<string, Relay>();
  /** Per station: mounts on air with their last title (here, or on the ingest node that is on air). */
  private live = new Map<string, Map<string, MountStats>>();
  /** Per station: mounts on air on this server's own Icecast. */
  private local = new Map<string, Map<string, MountStats>>();
  /** Per station: readers of each mount that are our own transcoders and relays. */
  private internal: WorkerStatus['internal'] = {};
  private externalPolledAt = 0;
  private timers: NodeJS.Timeout[] = [];
  private reloading: Promise<void> | null = null;
  private readonly startedAt = new Date().toISOString();
  /** Bytes stored per customer, refreshed with the stations (for the storage limit of recordings). */
  private storageUsed = new Map<string, number>();

  constructor(
    private readonly ctx: AppContext,
    private readonly log: pino.Logger,
  ) {
    this.gateway = new IngestGateway(ctx, log as never);
    this.collector = new ListenerCollector(ctx, log, () => this.snap);
    this.autodj = new AutodjController(ctx, log);
    this.collector.extraHandler = (req, res) => this.autodj.handle(req, res);
    this.gateway.onBroadcast = (b) => {
      this.reconcile();
      this.notifyNowPlaying(b.stationId);
      if (this.snap) void this.autodj.sync(this.snap, this.gateway.broadcasts.values());
    };
  }

  /** Tells the API that now playing of a station changed, so the live feeds of the public pages update right away. */
  private notifyNowPlaying(stationId: string) {
    void this.ctx.db.execute(sql`select pg_notify(${NOWPLAYING_CHANNEL}, ${stationId})`).catch(() => undefined);
  }

  async start() {
    // Broadcasts that were open when the service stopped have ended (not those on ingest nodes: they go on).
    await this.ctx.db
      .update(schema.liveSessions)
      .set({ endedAt: new Date(), endReason: sql`coalesce(${schema.liveSessions.endReason}, 'restart')` })
      .where(and(isNull(schema.liveSessions.endedAt), eq(schema.liveSessions.onNode, false)));
    await finishStaleRecordings(this.ctx).catch((err) => this.log.warn({ err }, 'checking old recordings failed'));
    await this.reload();
    await this.collector.start();
    this.timers.push(setInterval(() => void this.tick().catch((err) => this.log.error({ err }, 'monitor failed')), 3000));
    this.timers.push(setInterval(() => void this.reload(), 30_000));
    this.timers.push(setInterval(() => void this.writeStatus(), 5000));
  }

  async stop() {
    for (const t of this.timers) clearInterval(t);
    for (const r of this.relays.values()) r.stop();
    await Promise.all([...this.relays.values()].map((r) => (r instanceof Recorder ? r.finishing : null)));
    await this.collector.stop().catch(() => undefined);
    await this.gateway.close();
  }

  /** Reloads stations from the database; called on notifications from the API and every 30 seconds. */
  reload() {
    this.reloading ??= (async () => {
      try {
        this.snap = await loadSnapshot(this.ctx);
        const usage = await this.ctx.db
          .select({ tenantId: schema.stations.tenantId, bytes: sql<string>`sum(${schema.stations.storageBytes})` })
          .from(schema.stations)
          .groupBy(schema.stations.tenantId);
        this.storageUsed = new Map(usage.map((u) => [u.tenantId, Number(u.bytes ?? 0)]));
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
      // Stations on a station node or with only ingest nodes have no audio here.
      if (!view.active || view.onNode || !view.ingest.local) continue;
      const live = this.local.get(view.station.id) ?? new Map();
      for (const m of view.mounts) {
        if (m.kind !== 'transcode' || !m.sourceMountId) continue;
        const source = view.mounts.find((x) => x.id === m.sourceMountId);
        if (source && heard(view, source, live)) wanted.set(`transcode:${m.id}`, new Transcoder(view, m, source, this.log as never));
      }
      for (const o of view.outputs) {
        if (o.type === 'local' || !o.enabled || o.config.push === false || !o.mountId) continue;
        const mount = view.mounts.find((x) => x.id === o.mountId);
        if (mount && heard(view, mount, live)) wanted.set(`push:${o.id}`, new Pusher(this.ctx, view, o, mount, this.log as never));
      }
      // Next to an ingest node this server feeds the relays directly, while it has the station on air.
      for (const o of view.ingest.pushes) {
        const mount = view.mounts.find((x) => x.id === o.mountId);
        if (mount && heard(view, mount, live)) wanted.set(`relay:${o.id}`, new Pusher(this.ctx, view, o, mount, this.log as never, 'relay'));
      }
      if (publicSettings(view.station).recording.enabled) {
        const room = view.storageQuotaMb * 1024 * 1024 - (this.storageUsed.get(view.tenantId) ?? 0);
        for (const b of this.gateway.broadcasts.values()) {
          if (b.stationId !== view.station.id) continue;
          const mount = view.mounts.find((m) => m.path === b.mountPath);
          // A running recorder keeps its own budget; new ones need room left.
          if (mount && live.has(mount.path) && (room > 0 || this.relays.has(`record:${b.sessionId}`))) {
            wanted.set(`record:${b.sessionId}`, new Recorder(this.ctx, view, mount, b, Math.max(room, 0), this.log as never));
          }
        }
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
      if (relay instanceof Transcoder) relay.titleOf = () => this.live.get(relay.input.stationId)?.get(relay.input.mount)?.title ?? undefined;
      relay.onState = (s) => {
        if (id.startsWith('push:')) void this.saveOutputStatus(id.slice(5), { state: s.state, message: s.message, since: s.since });
        // A converted mount that (re)connects gets the title that is playing now, not only the next one.
        if (relay instanceof Transcoder && s.state === 'connected') void this.titleForTranscode(relay);
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
    const [runtimes, ingest] = await Promise.all([this.nodeRuntimes(snap), this.ingestNodes(snap)]);
    await Promise.all(
      [...snap.stations.values()].filter((v) => v.active).map(async (view) => {
        let stats: MountStats[];
        let here = true;
        if (view.onNode) {
          // What the station node reported a moment ago.
          const station = runtimes.get(view.station.id);
          stats = (station && nodeStationStats(station)) ?? [];
          here = false;
        } else {
          let own: MountStats[] = [];
          if (view.ingest.local) {
            try {
              own = await fetchStats({ port: view.station.icecastPort, adminPassword: view.adminPassword });
            } catch {
              own = [];
            }
          }
          const was = [...(this.local.get(view.station.id)?.keys() ?? [])].sort().join();
          this.local.set(view.station.id, new Map(own.map((s) => [s.mount, s])));
          // Jobs here follow this server's own mounts, also when another ingest is the one the relays hear.
          if (was !== own.map((s) => s.mount).sort().join()) changed = true;
          stats = own;
          // With ingest nodes, the relays hear the best ingest that is on air: this server or a node.
          if (view.ingest.nodes.length) {
            const candidates = [
              ...(view.ingest.local ? [{ priority: view.ingest.priority, stats: own, here: true }] : []),
              ...view.ingest.nodes.map((n) => ({ priority: n.priority, stats: ingestStats(ingest.get(n.id), view.station.id), here: false })),
            ].sort((a, b) => a.priority - b.priority);
            const best = candidates.find((c) => c.stats.length) ?? candidates[0]!;
            stats = best.stats;
            here = best.here;
          }
        }
        const before = this.live.get(view.station.id) ?? new Map<string, MountStats>();
        const now = new Map(stats.map((s) => [s.mount, s]));
        let moved = false;
        if ([...now.keys()].sort().join() !== [...before.keys()].sort().join()) changed = moved = true;
        const regrouped = moved;
        this.live.set(view.station.id, now);
        for (const s of stats) {
          const prev = before.get(s.mount);
          if (s.title !== (prev?.title ?? null)) moved = true;
          // When a source comes or goes, mounts that fall back switch to another title too, so send them all again.
          if (!here) continue;
          if (s.title && (regrouped || s.title !== prev?.title)) void this.forwardTitle(view, s.mount, s.title);
          this.enforceBitrate(view, s);
        }
        if (here) await this.countInternal(view, now);
        else delete this.internal[view.station.id];
        await this.collector.observe(view, now, this.internal[view.station.id] ?? {}).catch((err) => this.log.warn({ err }, 'statistics failed'));
        // After the collector, so the new title already has its play with a start time.
        if (moved) this.notifyNowPlaying(view.station.id);
      }),
    );
    if (changed) this.reconcile();
    void this.autodj.sync(snap, this.gateway.broadcasts.values()).catch((err) => this.log.warn({ err }, 'AutoDJ sync failed'));
    await this.collector.flush().catch((err) => this.log.warn({ err }, 'saving listener counts failed'));
    void this.collector.reconcile(snap, this.live).catch((err) => this.log.warn({ err }, 'checking listener sessions failed'));
    if (Date.now() - this.externalPolledAt > 30_000) {
      this.externalPolledAt = Date.now();
      void this.pollExternal(snap);
      void this.collector.refreshNodes().catch(() => undefined);
    }
  }

  /** The latest reports of the stations on station nodes (they change every few seconds, the snapshot every 30). */
  private async nodeRuntimes(snap: Snapshot) {
    const ids = [...snap.stations.values()].filter((v) => v.active && v.onNode).map((v) => v.station.id);
    if (!ids.length) return new Map<string, Station>();
    const rows = await this.ctx.db.select().from(schema.stations).where(inArray(schema.stations.id, ids));
    return new Map(rows.map((r) => [r.id, r]));
  }

  /** What the ingest nodes in use report right now (saved by the API every few seconds). */
  private async ingestNodes(snap: Snapshot) {
    const ids = [...new Set([...snap.stations.values()].filter((v) => v.active).flatMap((v) => v.ingest.nodes.map((n) => n.id)))];
    if (!ids.length) return new Map<string, NodeStatus>();
    const rows = await this.ctx.db.select({ id: schema.nodes.id, status: schema.nodes.status }).from(schema.nodes).where(inArray(schema.nodes.id, ids));
    return new Map(rows.map((r) => [r.id, r.status]));
  }

  /**
   * Counts the readers of our own jobs (transcoders, relays, relay nodes), so the panel can leave them out of listener
   * counts. Every mount on air is checked: a reader of a mount that is off air lands on its fallback mount.
   */
  private async countInternal(view: StationView, live: Map<string, MountStats>) {
    const counts: Record<string, number> = {};
    await Promise.all(
      [...live.keys()].map(async (mount) => {
        counts[mount] = await internalReaders({ port: view.station.icecastPort, adminPassword: view.adminPassword }, mount).catch(() => 0);
      }),
    );
    if (Object.keys(counts).length) this.internal[view.station.id] = counts;
    else delete this.internal[view.station.id];
  }

  private async titleForTranscode(relay: Transcoder) {
    const view = this.snap?.stations.get(relay.input.stationId);
    const title = view && this.heardFrom(view, relay.input.mount)?.title;
    if (!view || !title || relay.setTitle(title)) return;
    await updateMetadata({ port: view.station.icecastPort, adminPassword: view.adminPassword }, relay.output, title).catch(() => undefined);
  }

  /**
   * The mount whose audio listeners of a mount hear: the mount itself while it has a source, else the mount it falls
   * back to (for example /live without a DJ plays /autodj).
   */
  private heardFrom(view: StationView, mountPath: string): MountStats | undefined {
    const live = this.live.get(view.station.id);
    let cur = view.mounts.find((m) => m.path === mountPath);
    for (let i = 0; cur && i < 20; i++) {
      const stats = live?.get(cur.path);
      if (stats) return stats;
      const next: string | null = cur.fallbackMountId;
      cur = next ? view.mounts.find((m) => m.id === next) : undefined;
    }
    return undefined;
  }

  /**
   * A new title on a mount goes to the mounts converted from it and to the external servers it feeds, also those of
   * mounts that fall back to it while they have no source of their own.
   */
  private async forwardTitle(view: StationView, mountPath: string, title: string) {
    const sources = new Set(view.mounts.filter((m) => m.kind === 'source' && this.heardFrom(view, m.path)?.mount === mountPath).map((m) => m.id));
    if (!sources.size) return;
    // Ogg (Opus, Vorbis) mounts carry the title inside the stream, so their transcoder takes it; others go through
    // Icecast's /admin/metadata.
    for (const t of view.mounts.filter((m) => m.kind === 'transcode' && m.sourceMountId && sources.has(m.sourceMountId))) {
      const relay = this.relays.get(`transcode:${t.id}`);
      if (relay instanceof Transcoder && relay.setTitle(title)) continue;
      await updateMetadata({ port: view.station.icecastPort, adminPassword: view.adminPassword }, t.path, title).catch(() => undefined);
    }
    for (const o of view.outputs.filter((o) => o.mountId && sources.has(o.mountId))) {
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
        // Relay nodes fed by a station node report their listeners to the main server themselves.
        if (o.type === 'local' || !o.enabled || o.config.relayNodeId) continue;
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
      autodj: this.autodj.snapshot(),
      onAir: Object.fromEntries([...this.local].filter(([, m]) => m.size).map(([id, m]) => [id, [...m.keys()]])),
    };
    const path = workerStatusPath(this.ctx);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(`${path}.tmp`, JSON.stringify(status, null, 2), { mode: 0o640 });
    await rename(`${path}.tmp`, path);
  }
}
