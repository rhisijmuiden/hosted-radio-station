import { timingSafeEqual } from 'node:crypto';
import { and, eq, gt, lt, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { WebSocket } from 'ws';
import { schema } from '../../db/index.js';
import type { NodeStatus } from '../../db/schema.js';
import type { AppContext } from '../../lib/context.js';
import { getSetting } from '../settings.js';
import { GeoIp } from '../stats/geoip.js';
import { fmContext } from './fm.js';
import { authorizeIngest, recordLive, syncLive } from './ingest.js';
import { buildPlan, type Node } from './plan.js';
import { CLOSE, MIN_PROTOCOL_VERSION, PROTOCOL_VERSION, type AgentMessage, type AgentStats, type FmStatus, type ServerMessage } from './protocol.js';

const PING_MS = 5000;
/** A ping without an answer after this long counts as a timeout. */
const PING_TIMEOUT_MS = 4000;
const HELLO_TIMEOUT_MS = 10_000;

interface Minute {
  rtts: number[];
  pings: number;
  lost: number;
}

interface Conn {
  nodeId: string;
  tenantId: string | null;
  socket: WebSocket;
  status: NodeStatus;
  seq: number;
  pending: Map<number, number>;
  minute: Minute;
  /** Outcome of the last five minutes of pings, for the loss figure: [pings, lost] per minute. */
  recent: [number, number][];
  revision: string | null;
  savedAt: number;
  latencyHigh: boolean;
  timer: NodeJS.Timeout;
  /** FM/MPX: the station it puts on air and the live DJ/show it was told last. */
  fmStation: string | null;
  fmSent: string;
}

/** Compares a secret with the stored (encrypted) one in constant time. */
export function secretMatches(ctx: AppContext, sealed: string | null, given: string) {
  if (!sealed || !given) return false;
  let plain: string;
  try {
    plain = ctx.box.decrypt(sealed);
  } catch {
    return false;
  }
  const a = Buffer.from(plain);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : undefined);
const num = (v: unknown, max = Number.MAX_SAFE_INTEGER) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(-max, Math.min(max, v)) : 0);

/** The FM status of a node, checked field by field (it ends up in the panel). */
export function sanitizeFm(f: FmStatus): FmStatus {
  const pick = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(v as T) ? (v as T) : fallback);
  const m = f.meters && typeof f.meters === 'object' ? f.meters : null;
  return {
    input: pick(f.input, ['idle', 'connecting', 'connected', 'error'] as const, 'idle'),
    inputMessage: str(f.inputMessage, 300),
    title: str(f.title, 300) ?? null,
    output: pick(f.output, ['off', 'starting', 'running', 'error'] as const, 'off'),
    outputMessage: str(f.outputMessage, 300),
    uecp: pick(f.uecp, ['off', 'connecting', 'connected', 'error'] as const, 'off'),
    uecpMessage: str(f.uecpMessage, 300),
    meters: m
      ? { peak: num(m.peak, 10), left: num(m.left, 10), right: num(m.right, 10), buffered: num(m.buffered, 3600), ppm: num(m.ppm, 1e6), underruns: num(m.underruns), overruns: num(m.overruns), playing: !!m.playing }
      : null,
    ps: str(f.ps, 8) ?? '',
    psFrames: Array.isArray(f.psFrames) ? f.psFrames.slice(0, 20).map((p) => String(p).slice(0, 8)) : [],
    rt: str(f.rt, 64) ?? '',
    tags: Array.isArray(f.tags) ? f.tags.slice(0, 2).map((t) => ({ type: num(t?.type, 63), start: num(t?.start, 64), length: num(t?.length, 64) })) : [],
    groups: Object.fromEntries(Object.entries(f.groups && typeof f.groups === 'object' ? f.groups : {}).slice(0, 8).map(([k, v]) => [k.slice(0, 4), num(v)])),
  };
}

export async function nodeEvent(ctx: AppContext, nodeId: string, kind: string, level: 'info' | 'warning' | 'error' = 'info', details: Record<string, string | number | null> = {}) {
  await ctx.db.insert(schema.nodeEvents).values({ nodeId, kind, level, details }).catch(() => undefined);
}

/**
 * The control channel to the nodes. Every paired node keeps one WebSocket open to this server: it authenticates with
 * its secret, gets its plan (roles, streams, probes, version) and sends its health every few seconds. The hub pings
 * each node every five seconds for latency and timeouts, and writes a health figure per minute.
 */
export class NodeHub {
  private conns = new Map<string, Conn>();
  private timers: NodeJS.Timeout[] = [];
  private refreshing: Promise<void> | null = null;
  private refreshAgain = false;
  readonly geo: GeoIp;
  /** Called when nodes come, go or are drained: Cloudflare DNS follows (phase 15). */
  onChange: (() => void) | null = null;

  constructor(
    private readonly ctx: AppContext,
    private readonly log: FastifyBaseLogger,
  ) {
    this.geo = new GeoIp(ctx);
  }

  async start() {
    // Nobody is connected right after a start.
    await this.ctx.db.execute(sql`update nodes set status = jsonb_set(status, '{online}', 'false') where (status->>'online')::boolean`).catch(() => undefined);
    this.timers.push(setInterval(() => void this.flushMinute().catch((err) => this.log.warn({ err }, 'saving node health failed')), 60_000));
    // Probe targets depend on which relays are online; plans are cheap to compare.
    this.timers.push(setInterval(() => void this.refreshAll(), 60_000));
    // Shows start and end on the clock: tell FM nodes about the current one now and then.
    this.timers.push(setInterval(() => void this.fmRefresh(), 30_000));
    this.timers.push(setInterval(() => void this.cleanup().catch((err) => this.log.warn({ err }, 'cleaning up node health failed')), 3600_000));
    for (const t of this.timers) t.unref();
  }

  /**
   * Before the server closes (preClose, while the WebSockets are still open): tells every agent it restarts. Caddy keeps
   * the agent's side open after the close itself and drops its code, so the agent would only notice by its watchdog.
   */
  async announceRestart() {
    for (const c of this.conns.values()) this.send(c, { t: 'restart' });
    if (this.conns.size) await new Promise((r) => setTimeout(r, 200));
  }

  async stop() {
    for (const t of this.timers) clearInterval(t);
    for (const c of this.conns.values()) {
      clearInterval(c.timer);
      c.socket.close(1001, 'server restarting');
    }
    this.conns.clear();
  }

  isOnline(nodeId: string) {
    return this.conns.has(nodeId);
  }

  /** Live status of a connected node (fresher than the stored one). */
  liveStatus(nodeId: string): NodeStatus | null {
    return this.conns.get(nodeId)?.status ?? null;
  }

  private send(c: Conn, msg: ServerMessage) {
    if (c.socket.readyState === c.socket.OPEN) c.socket.send(JSON.stringify(msg));
  }

  /** Takes a new agent connection: waits for its hello and checks the secret. */
  attach(socket: WebSocket, ip: string | null) {
    let conn: Conn | null = null;
    const helloTimer = setTimeout(() => socket.close(CLOSE.unauthorized, 'hello expected'), HELLO_TIMEOUT_MS);
    socket.on('message', (data: Buffer) => {
      let msg: AgentMessage;
      try {
        msg = JSON.parse(data.toString('utf8'));
      } catch {
        return;
      }
      if (!conn) {
        if (msg.t !== 'hello') return;
        clearTimeout(helloTimer);
        void this.hello(socket, msg, ip).then((c) => (conn = c)).catch((err) => {
          this.log.warn({ err }, 'node hello failed');
          socket.close(1011, 'error');
        });
        return;
      }
      this.onMessage(conn, msg);
    });
    socket.on('close', () => {
      clearTimeout(helloTimer);
      if (conn && this.conns.get(conn.nodeId) === conn) void this.gone(conn);
    });
    socket.on('error', () => socket.terminate());
  }

  private async hello(socket: WebSocket, msg: Extract<AgentMessage, { t: 'hello' }>, ip: string | null): Promise<Conn | null> {
    if (typeof msg.protocol !== 'number' || msg.protocol < MIN_PROTOCOL_VERSION || msg.protocol > PROTOCOL_VERSION) {
      socket.close(CLOSE.protocol, `protocol ${PROTOCOL_VERSION} expected`);
      return null;
    }
    const id = typeof msg.nodeId === 'string' && /^[0-9a-f-]{36}$/.test(msg.nodeId) ? msg.nodeId : null;
    const [node] = id ? await this.ctx.db.select().from(schema.nodes).where(eq(schema.nodes.id, id)) : [];
    if (!node || !secretMatches(this.ctx, node.secret, String(msg.secret ?? ''))) {
      socket.close(CLOSE.unauthorized, 'unknown node or wrong secret');
      return null;
    }
    const old = this.conns.get(node.id);
    if (old) {
      clearInterval(old.timer);
      this.conns.delete(node.id);
      old.socket.close(CLOSE.replaced, 'replaced by a new connection');
    }
    await this.geo.refresh().catch(() => undefined);
    const geo = this.geo.lookup(ip);
    const status: NodeStatus = {
      ...node.status,
      online: true,
      version: String(msg.version ?? '').slice(0, 40),
      commit: typeof msg.commit === 'string' ? msg.commit.slice(0, 40) : null,
      hostname: String(msg.hostname ?? '').slice(0, 100),
      caddy: !!msg.facts?.caddy,
      cores: Number(msg.facts?.cores) || undefined,
      addresses: Array.isArray(msg.facts?.addresses) ? msg.facts.addresses.slice(0, 10).map(String) : [],
      ffmpeg: !!msg.facts?.ffmpeg,
      soundcards: Array.isArray(msg.facts?.soundcards) ? msg.facts.soundcards.slice(0, 16).map((c) => ({ device: String(c?.device ?? '').slice(0, 100), name: String(c?.name ?? '').slice(0, 120) })) : [],
      ip,
      country: geo?.country ?? null,
      city: geo?.city ?? null,
      latitude: geo?.latitude ?? null,
      longitude: geo?.longitude ?? null,
      updatedAt: new Date().toISOString(),
    };
    const conn: Conn = {
      nodeId: node.id,
      tenantId: node.tenantId,
      socket,
      status,
      seq: 0,
      pending: new Map(),
      minute: { rtts: [], pings: 0, lost: 0 },
      recent: [],
      revision: null,
      savedAt: Date.now(),
      latencyHigh: false,
      timer: setInterval(() => this.ping(conn), PING_MS),
      fmStation: null,
      fmSent: '',
    };
    conn.timer.unref();
    this.conns.set(node.id, conn);
    await this.ctx.db.update(schema.nodes).set({ status, lastSeenAt: new Date() }).where(eq(schema.nodes.id, node.id));
    await nodeEvent(this.ctx, node.id, 'online', 'info', { ip, version: status.version ?? null });
    this.log.info({ node: node.name, ip }, 'node connected');
    this.send(conn, { t: 'welcome', nodeId: node.id, name: node.name, serverTime: new Date().toISOString() });
    await this.pushPlan(conn, { ...node, status });
    this.ping(conn);
    // Other nodes may route to this one (spare relays, push targets that need its address).
    this.replanSoon();
    return conn;
  }

  private ping(c: Conn) {
    const now = Date.now();
    for (const [seq, sent] of c.pending) {
      if (now - sent > PING_TIMEOUT_MS) {
        c.pending.delete(seq);
        c.minute.lost++;
      }
    }
    c.seq++;
    c.pending.set(c.seq, now);
    c.minute.pings++;
    this.send(c, { t: 'ping', seq: c.seq });
  }

  private onMessage(c: Conn, msg: AgentMessage) {
    if (msg.t === 'pong') {
      const sent = c.pending.get(msg.seq);
      if (sent === undefined) return;
      c.pending.delete(msg.seq);
      const rtt = Date.now() - sent;
      c.minute.rtts.push(rtt);
      // Show a rolling figure right away instead of waiting for the minute.
      const last = c.minute.rtts.slice(-12);
      c.status.rttMs = Math.round((last.reduce((a, b) => a + b, 0) / last.length) * 10) / 10;
    } else if (msg.t === 'stats') {
      this.onStats(c, msg);
    } else if (msg.t === 'auth') {
      void authorizeIngest(this.ctx, { id: c.nodeId, tenantId: c.tenantId }, msg)
        .catch((err) => {
          this.log.warn({ err }, 'checking an encoder log-in failed');
          return { t: 'auth_result' as const, id: msg.id, ok: false, message: 'The log-in could not be checked right now.' };
        })
        .then((r) => this.send(c, r));
    } else if (msg.t === 'live') {
      void recordLive(this.ctx, { id: c.nodeId, tenantId: c.tenantId }, msg).catch((err) => this.log.warn({ err }, 'logging a broadcast on a node failed'));
    } else if (msg.t === 'live_sync') {
      void syncLive(this.ctx, c.nodeId, Array.isArray(msg.sessionIds) ? msg.sessionIds.map(String) : []).catch((err) => this.log.warn({ err }, 'syncing broadcasts of a node failed'));
    } else if (msg.t === 'event' && typeof msg.kind === 'string' && /^[a-z_]{1,40}$/.test(msg.kind)) {
      const level = msg.level === 'warning' || msg.level === 'error' ? msg.level : 'info';
      const details: Record<string, string | number | null> = {};
      for (const [k, v] of Object.entries(msg.details ?? {}).slice(0, 10)) {
        if (typeof v === 'number' || v === null) details[k.slice(0, 40)] = v;
        else details[k.slice(0, 40)] = String(v).slice(0, 300);
      }
      void nodeEvent(this.ctx, c.nodeId, msg.kind, level, details);
    }
  }

  private onStats(c: Conn, m: AgentStats) {
    const num = (v: unknown, max = Number.MAX_SAFE_INTEGER) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(max, v)) : undefined);
    const s = c.status;
    s.cpu = num(m.cpu, 1);
    s.memory = num(m.memory, 1);
    s.load = num(m.load);
    s.uptime = num(m.uptime);
    s.rxBps = num(m.rxBps);
    s.txBps = num(m.txBps);
    s.listeners = num(m.listeners);
    s.encoders = num(m.encoders);
    s.icmp = m.icmp && typeof m.icmp === 'object' ? { rttMs: num(m.icmp.rttMs) ?? null, loss: num(m.icmp.loss, 1) ?? 0 } : null;
    if (Array.isArray(m.ingest)) {
      const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : null);
      s.ingest = m.ingest.slice(0, 200).map((x) => ({
        stationId: String(x.stationId).slice(0, 36),
        mount: String(x.mount).slice(0, 100),
        title: str(x.title, 300),
        bitrateKbps: num(x.bitrateKbps, 10_000) ?? null,
        contentType: str(x.contentType, 60),
        pushing: Array.isArray(x.pushing) ? x.pushing.slice(0, 50).map((p) => String(p).slice(0, 36)) : [],
      }));
    } else delete s.ingest;
    s.problems = Array.isArray(m.problems) ? m.problems.slice(0, 10).map((p) => String(p).slice(0, 300)) : [];
    if (Array.isArray(m.applyLog) && m.applyLog.length) s.applyLog = m.applyLog.slice(-20).map((l) => String(l).slice(0, 200));
    else delete s.applyLog;
    if (m.update && typeof m.update === 'object') {
      const prev = s.update?.state;
      s.update = { state: m.update.state, message: m.update.message?.slice(0, 300), at: m.update.at };
      if (prev && prev !== m.update.state && (m.update.state === 'succeeded' || m.update.state === 'failed')) {
        void nodeEvent(this.ctx, c.nodeId, m.update.state === 'succeeded' ? 'update_done' : 'update_failed', m.update.state === 'succeeded' ? 'info' : 'error', { message: m.update.message ?? null });
      }
    }
    s.fm = m.fm && typeof m.fm === 'object' ? sanitizeFm(m.fm) : null;
    s.updatedAt = new Date().toISOString();
    // Ingest status feeds now playing on this server, so it is saved more often.
    if (Date.now() - c.savedAt > (s.ingest?.length ? 3000 : 10_000)) void this.save(c);
  }

  private async save(c: Conn) {
    c.savedAt = Date.now();
    await this.ctx.db
      .update(schema.nodes)
      .set({ status: c.status, lastSeenAt: new Date() })
      .where(eq(schema.nodes.id, c.nodeId))
      .catch((err) => this.log.warn({ err }, 'saving node status failed'));
  }

  private async gone(c: Conn) {
    clearInterval(c.timer);
    this.conns.delete(c.nodeId);
    c.status = { ...c.status, online: false, ingest: [], updatedAt: new Date().toISOString() };
    await this.writeMinute(c).catch(() => undefined);
    await this.ctx.db.update(schema.nodes).set({ status: c.status, lastSeenAt: new Date() }).where(eq(schema.nodes.id, c.nodeId)).catch(() => undefined);
    await nodeEvent(this.ctx, c.nodeId, 'offline', 'warning');
    this.log.info({ node: c.nodeId }, 'node disconnected');
    // Spare relays step in, ingests stop pushing to it.
    this.replanSoon();
  }

  /** Removes health figures and events older than the retention. */
  async cleanup() {
    const { metricsRetentionDays } = await getSetting(this.ctx, 'nodes');
    await this.ctx.db.delete(schema.nodeMetrics).where(lt(schema.nodeMetrics.at, new Date(Date.now() - metricsRetentionDays * 86400_000)));
    await this.ctx.db.delete(schema.nodeEvents).where(lt(schema.nodeEvents.at, new Date(Date.now() - Math.max(90, metricsRetentionDays) * 86400_000)));
  }

  /** Writes the health figures of the minute that ended for every connected node. */
  async flushMinute() {
    const settings = await getSetting(this.ctx, 'nodes');
    for (const c of this.conns.values()) {
      await this.writeMinute(c, settings.latencyWarnMs);
      await this.save(c);
    }
  }

  private async writeMinute(c: Conn, warnMs?: number) {
    const m = c.minute;
    c.minute = { rtts: [], pings: 0, lost: 0 };
    if (!m.pings) return;
    const at = new Date(Math.floor(Date.now() / 60_000) * 60_000 - 60_000);
    const rttAvg = m.rtts.length ? m.rtts.reduce((a, b) => a + b, 0) / m.rtts.length : null;
    const s = c.status;
    await this.ctx.db
      .insert(schema.nodeMetrics)
      .values({ nodeId: c.nodeId, at, rttAvg, rttMax: m.rtts.length ? Math.max(...m.rtts) : null, pings: m.pings, lost: m.lost, cpu: s.cpu ?? null, memory: s.memory ?? null, rxBps: s.rxBps ?? null, txBps: s.txBps ?? null, listeners: s.listeners ?? null })
      .onConflictDoUpdate({
        target: [schema.nodeMetrics.nodeId, schema.nodeMetrics.at],
        set: { pings: sql`${schema.nodeMetrics.pings} + excluded.pings`, lost: sql`${schema.nodeMetrics.lost} + excluded.lost` },
      });
    c.recent = [...c.recent, [m.pings, m.lost] as [number, number]].slice(-5);
    const pings = c.recent.reduce((n, r) => n + r[0], 0);
    s.loss = pings ? c.recent.reduce((n, r) => n + r[1], 0) / pings : 0;
    if (rttAvg !== null) s.rttMs = Math.round(rttAvg * 10) / 10;
    const [day] = await this.ctx.db
      .select({ lost: sql<number>`coalesce(sum(${schema.nodeMetrics.lost}), 0)::int` })
      .from(schema.nodeMetrics)
      .where(and(eq(schema.nodeMetrics.nodeId, c.nodeId), gt(schema.nodeMetrics.at, new Date(Date.now() - 86400_000))));
    s.timeouts24h = day?.lost ?? 0;
    if (warnMs !== undefined && rttAvg !== null) {
      const high = rttAvg > warnMs || m.lost > m.pings / 2;
      if (high !== c.latencyHigh) {
        c.latencyHigh = high;
        await nodeEvent(this.ctx, c.nodeId, high ? 'latency_high' : 'latency_ok', high ? 'warning' : 'info', { ms: Math.round(rttAvg), lost: m.lost });
      }
    }
  }

  private async pushPlan(c: Conn, node: Node) {
    const plan = await buildPlan(this.ctx, node);
    if (plan.revision === c.revision) return;
    c.revision = plan.revision;
    this.send(c, { t: 'plan', plan });
    const station = plan.fm?.station.id ?? null;
    if (station !== c.fmStation) {
      c.fmStation = station;
      c.fmSent = '';
      if (station) await this.fmSend(c);
    }
  }

  /** Sends an FM node who is live and which show runs, when that changed. */
  private async fmSend(c: Conn) {
    if (!c.fmStation) return;
    const now = await fmContext(this.ctx, c.fmStation);
    const key = JSON.stringify(now);
    if (key === c.fmSent) return;
    c.fmSent = key;
    this.send(c, { t: 'fm', dj: now.dj, show: now.show });
  }

  /** A DJ went live or off air on a station (from the streams service): its FM nodes update their RadioText. */
  fmNotify(stationId: string) {
    for (const c of this.conns.values()) if (c.fmStation === stationId) void this.fmSend(c).catch((err) => this.log.warn({ err }, 'telling an FM node failed'));
  }

  private async fmRefresh() {
    for (const c of this.conns.values()) if (c.fmStation) await this.fmSend(c).catch((err) => this.log.warn({ err }, 'telling an FM node failed'));
  }

  /** Sends a node its plan again when anything in it changed (after a change in the panel). */
  async refresh(nodeId: string) {
    const c = this.conns.get(nodeId);
    if (!c) return;
    const [node] = await this.ctx.db.select().from(schema.nodes).where(eq(schema.nodes.id, nodeId));
    if (node) await this.pushPlan(c, { ...node, status: c.status });
  }

  /** Re-plans every connected node; called when stations change and every minute. */
  refreshAll(): Promise<void> {
    // A change made while a round runs gets a round of its own, so no node keeps a plan from before the change.
    if (this.refreshing) {
      this.refreshAgain = true;
      return this.refreshing;
    }
    const round = async () => {
      do {
        this.refreshAgain = false;
        // One node that cannot be planned must not keep the others on an old plan.
        for (const id of [...this.conns.keys()]) {
          let timer: NodeJS.Timeout | undefined;
          const late = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error('planning took longer than 20 s')), 20_000)));
          await Promise.race([this.refresh(id), late])
            .catch((err) => this.log.warn({ err, nodeId: id }, 'planning a node failed'))
            .finally(() => clearTimeout(timer));
        }
      } while (this.refreshAgain);
    };
    // Cleared in a callback, so also after a round without nodes that finishes at once: clearing it inside the round
    // would run before the assignment and leave a finished round in place for good, so no node got a new plan again.
    this.refreshing = round().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private replanTimer: NodeJS.Timeout | null = null;

  /** Re-plans all nodes shortly, once for a burst of changes (several nodes connecting after a restart). */
  replanSoon() {
    this.onChange?.();
    if (this.replanTimer) return;
    this.replanTimer = setTimeout(() => {
      this.replanTimer = null;
      void this.refreshAll();
    }, 2000);
    this.replanTimer.unref();
  }

  /** Asks a node to update to the version of this server now. Returns false when it is not connected. */
  requestUpdate(nodeId: string, branch: string | null, commit: string | null) {
    const c = this.conns.get(nodeId);
    if (!c) return false;
    this.send(c, { t: 'update', branch, commit });
    c.status.update = { state: 'running', message: 'Requested', at: new Date().toISOString() };
    return true;
  }

  /** Tells a node an update is coming (seconds > 0) or that it is over (0). Returns false when it is not connected. */
  drain(nodeId: string, seconds: number) {
    const c = this.conns.get(nodeId);
    if (!c) return false;
    this.send(c, { t: 'drain', seconds });
    this.onChange?.();
    return true;
  }

  /** Closes the connection of a node that was unpaired or removed; the agent stops trying. */
  disconnect(nodeId: string) {
    const c = this.conns.get(nodeId);
    if (!c) return;
    void this.gone(c);
    c.socket.close(CLOSE.unauthorized, 'unpaired');
  }
}
