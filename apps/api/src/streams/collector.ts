import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type pino from 'pino';
import { schema } from '../db/index.js';
import type { AppContext } from '../lib/context.js';
import { getSetting, type StatisticsSettings } from '../services/settings.js';
import { GeoIp } from '../services/stats/geoip.js';
import { listenerHash, normalizeIp, referrerHost, shortenIp } from '../services/stats/privacy.js';
import { classifyClient } from '../services/stats/useragent.js';
import { INTERNAL_AGENT, listClients, parseClients, type IcecastClient, type MountStats } from '../services/streaming/icecast.js';
import type { Output } from '../services/streaming/state.js';
import type { Snapshot, StationView } from './snapshot.js';

interface OpenSession {
  id: string;
  startedAt: number;
  mount: string;
}

interface Acc {
  sum: number;
  n: number;
  peak: number;
}

interface Play {
  id: number | null;
  title: string;
  peak: number;
}

export interface ExternalClient {
  id: string;
  ip: string | null;
  userAgent: string | null;
  connectedSeconds: number;
  referer?: string | null;
}

const minuteOf = (t: number) => Math.floor(t / 60_000) * 60_000;

/**
 * Collects listener statistics in the streams service:
 *  - every connection and disconnection, reported by the stations' Icecast servers through the listener hooks (with
 *    the real address that the web server passes along), with location and player;
 *  - listener counts per minute, per mount and external server;
 *  - every title change with the listeners at its start, peak and end.
 * Once a minute it compares its sessions with the client lists of the servers, so nothing stays open when a hook
 * was missed (a restart of this service or of an Icecast server).
 */
export class ListenerCollector {
  readonly geo: GeoIp;
  private settings: StatisticsSettings | null = null;
  private server: http.Server | null = null;
  /** `${stationId}:${clientKey}` → session. */
  private open = new Map<string, OpenSession>();
  /** stationId → target → accumulated counts of the current minute. */
  private acc = new Map<string, Map<string, Acc>>();
  private accMinute = minuteOf(Date.now());
  /** stationId:mount → the title playing. */
  private plays = new Map<string, Play>();
  /** Latest listener count per external output, from the 30-second poll. */
  private external = new Map<string, { stationId: string; listeners: number }>();
  private lastReconcile = 0;
  /** Other local hooks on the same port (the AutoDJ players); returns true when it handled the request. */
  extraHandler?: (req: http.IncomingMessage, res: http.ServerResponse) => boolean;

  constructor(
    private readonly ctx: AppContext,
    private readonly log: pino.Logger,
    private readonly snapshot: () => Snapshot | null,
  ) {
    this.geo = new GeoIp(ctx);
  }

  async start() {
    await this.reload();
    const rows = await this.ctx.db
      .select({ id: schema.listenerSessions.id, stationId: schema.listenerSessions.stationId, key: schema.listenerSessions.clientKey, startedAt: schema.listenerSessions.startedAt, mount: schema.listenerSessions.mountPath })
      .from(schema.listenerSessions)
      .where(isNull(schema.listenerSessions.endedAt));
    for (const r of rows) if (r.key) this.open.set(`${r.stationId}:${r.key}`, { id: r.id, startedAt: r.startedAt.getTime(), mount: r.mount });
    // Plays that were open when the service stopped have ended.
    await this.ctx.db.update(schema.songPlays).set({ endedAt: new Date() }).where(isNull(schema.songPlays.endedAt));
    this.server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.ctx.config.LISTENER_HOOK_PORT, '127.0.0.1', () => resolve());
    }).catch((err) => this.log.error({ err }, 'listener hook port is not available; listener statistics only come from the minute checks'));
  }

  async stop() {
    await this.flush(true);
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }

  async reload() {
    this.settings = await getSetting(this.ctx, 'statistics');
    await this.geo.refresh();
  }

  // Listener hooks

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const allow = () => {
      res.writeHead(200, { 'icecast-auth-user': '1', 'content-type': 'text/plain' });
      res.end('ok');
    };
    if (this.extraHandler?.(req, res)) return;
    const m = req.url?.match(/^\/icecast\/([0-9a-f-]{36})\/(add|remove)$/);
    if (req.method !== 'POST' || !m) {
      res.writeHead(404).end();
      return;
    }
    let body = '';
    req.setEncoding('utf8');
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 16_384) break;
    }
    // Listeners are always let in; recording must never stand in the way of listening.
    allow();
    const p = new URLSearchParams(body);
    try {
      if (m[2] === 'add') await this.listenerAdded(m[1]!, p);
      else await this.listenerRemoved(m[1]!, p);
    } catch (err) {
      this.log.warn({ err }, 'recording a listener failed');
    }
  }

  private async listenerAdded(stationId: string, p: URLSearchParams) {
    const view = this.snapshot()?.stations.get(stationId);
    const agent = p.get('agent') ?? '';
    if (!view || agent.startsWith(INTERNAL_AGENT)) return;
    const client = p.get('client');
    if (!client) return;
    const mount = (p.get('mount') ?? '').split('?')[0]!;
    const ip = normalizeIp(p.get('h_x-hrs-client')) ?? normalizeIp(p.get('ip'));
    const via = p.get('h_x-hrs-via') === 'legacy' ? 'legacy' : 'web';
    // Client ids start again at 1 when an Icecast server restarts: an old session with the same id has ended.
    if (this.open.has(`${stationId}:${client}`)) await this.closeSession(stationId, client, Date.now());
    await this.openSession(view, { key: client, mount, via, ip, userAgent: agent, referer: p.get('h_referer'), startedAt: Date.now() });
  }

  private async listenerRemoved(stationId: string, p: URLSearchParams) {
    const client = p.get('client');
    if (client) await this.closeSession(stationId, client, Date.now());
  }

  private async openSession(
    view: StationView,
    s: { key: string; mount: string; via: string; ip: string | null; userAgent: string | null; referer?: string | null; startedAt: number; outputId?: string },
  ) {
    const key = `${view.station.id}:${s.key}`;
    if (this.open.has(key)) return;
    const settings = this.settings ?? (await getSetting(this.ctx, 'statistics'));
    if (s.ip) await this.geo.refresh().catch(() => undefined);
    const geo = this.geo.lookup(s.ip);
    const client = classifyClient(s.userAgent);
    const isLocal = !s.ip || s.ip === '127.0.0.1' || s.ip === '::1';
    const session: OpenSession = { id: randomUUID(), startedAt: s.startedAt, mount: s.mount };
    this.open.set(key, session);
    await this.ctx.db.insert(schema.listenerSessions).values({
      id: session.id,
      stationId: view.station.id,
      tenantId: view.tenantId,
      mountPath: s.mount.slice(0, 200),
      outputId: s.outputId ?? null,
      via: s.via,
      clientKey: s.key.slice(0, 100),
      startedAt: new Date(s.startedAt),
      ip: isLocal ? null : settings.anonymizeIps ? shortenIp(s.ip!) || null : s.ip,
      listenerHash: isLocal ? null : listenerHash(this.ctx.config.APP_SECRET, s.ip, s.userAgent),
      country: geo?.country ?? null,
      region: geo?.region ?? null,
      city: geo?.city ?? null,
      // A city is enough for the map; round the coordinates so they never point at a home.
      latitude: geo?.latitude != null ? Math.round(geo.latitude * 100) / 100 : null,
      longitude: geo?.longitude != null ? Math.round(geo.longitude * 100) / 100 : null,
      asn: geo?.asn ?? null,
      network: geo?.network?.slice(0, 200) ?? null,
      userAgent: s.userAgent?.slice(0, 500) ?? null,
      device: client.device,
      player: client.player,
      os: client.os,
      referrer: referrerHost(s.referer),
    });
  }

  private async closeSession(stationId: string, clientKey: string, at: number) {
    const key = `${stationId}:${clientKey}`;
    const s = this.open.get(key);
    this.open.delete(key);
    const endedAt = new Date(at);
    if (s) {
      await this.ctx.db
        .update(schema.listenerSessions)
        .set({ endedAt, durationSeconds: Math.max(0, Math.round((at - s.startedAt) / 1000)) })
        .where(eq(schema.listenerSessions.id, s.id));
    } else {
      // Opened before this service started and not loaded (or already closed): close by key.
      await this.ctx.db
        .update(schema.listenerSessions)
        .set({ endedAt, durationSeconds: sql`greatest(0, round(extract(epoch from (${endedAt.toISOString()}::timestamptz - ${schema.listenerSessions.startedAt}))))::int` })
        .where(and(eq(schema.listenerSessions.stationId, stationId), eq(schema.listenerSessions.clientKey, clientKey), isNull(schema.listenerSessions.endedAt)));
    }
  }

  // Counts, titles and the minute check, called by the worker's monitor every few seconds.

  async observe(view: StationView, live: Map<string, MountStats>, internal: Record<string, number>) {
    const id = view.station.id;
    let total = 0;
    const counts = new Map<string, number>();
    for (const [mount, s] of live) {
      const n = Math.max(0, s.listeners - (internal[mount] ?? 0));
      counts.set(`mount:${mount}`, n);
      total += n;
    }
    for (const [outputId, e] of this.external) {
      if (e.stationId !== id) continue;
      counts.set(`output:${outputId}`, e.listeners);
      total += e.listeners;
    }
    if (counts.size) {
      counts.set('*', total);
      if (minuteOf(Date.now()) !== this.accMinute) await this.flush();
      let a = this.acc.get(id);
      if (!a) this.acc.set(id, (a = new Map()));
      for (const [target, n] of counts) {
        const x = a.get(target) ?? { sum: 0, n: 0, peak: 0 };
        x.sum += n;
        x.n += 1;
        x.peak = Math.max(x.peak, n);
        a.set(target, x);
      }
    }
    await this.trackTitles(view, live, total);
  }

  /** Writes the counts of the minute that just ended. */
  async flush(force = false) {
    const minute = minuteOf(Date.now());
    if (!force && minute === this.accMinute) return;
    const at = new Date(this.accMinute);
    const rows = [...this.acc].flatMap(([stationId, targets]) =>
      [...targets].map(([target, x]) => ({ at, stationId, target, avg: x.sum / x.n, peak: x.peak })),
    );
    this.acc = new Map();
    this.accMinute = minute;
    if (!rows.length) return;
    const known = new Set(this.snapshot()?.stations.keys() ?? []);
    const keep = rows.filter((r) => known.has(r.stationId));
    if (!keep.length) return;
    await this.ctx.db
      .insert(schema.listenerSamples)
      .values(keep)
      .onConflictDoUpdate({
        target: [schema.listenerSamples.stationId, schema.listenerSamples.target, schema.listenerSamples.at],
        set: { avg: sql`excluded.avg`, peak: sql`greatest(${schema.listenerSamples.peak}, excluded.peak)` },
      })
      .catch((err) => this.log.warn({ err }, 'saving listener counts failed'));
  }

  private async trackTitles(view: StationView, live: Map<string, MountStats>, listeners: number) {
    const sources = new Set(view.mounts.filter((m) => m.kind === 'source').map((m) => m.path));
    const now = new Date();
    for (const [key, play] of this.plays) {
      if (!key.startsWith(`${view.station.id}:`)) continue;
      const mount = key.slice(view.station.id.length + 1);
      const title = live.get(mount)?.title ?? null;
      if (title === play.title) {
        play.peak = Math.max(play.peak, listeners);
        continue;
      }
      this.plays.delete(key);
      if (play.id != null) {
        await this.ctx.db
          .update(schema.songPlays)
          .set({ endedAt: now, listenersPeak: play.peak, listenersEnd: listeners })
          .where(eq(schema.songPlays.id, play.id))
          .catch(() => undefined);
      }
    }
    for (const [mount, s] of live) {
      const key = `${view.station.id}:${mount}`;
      if (!sources.has(mount) || !s.title?.trim() || this.plays.has(key)) continue;
      const play: Play = { id: null, title: s.title, peak: listeners };
      this.plays.set(key, play);
      const [row] = await this.ctx.db
        .insert(schema.songPlays)
        .values({ stationId: view.station.id, mountPath: mount, title: s.title.slice(0, 500), startedAt: now, listenersStart: listeners, listenersPeak: listeners })
        .returning({ id: schema.songPlays.id })
        .catch(() => [] as { id: number }[]);
      play.id = row?.id ?? null;
    }
  }

  /** Latest count of an external server, from the worker's 30-second poll. */
  setExternalCount(stationId: string, outputId: string, listeners: number | null) {
    if (listeners == null) this.external.delete(outputId);
    else this.external.set(outputId, { stationId, listeners });
  }

  /**
   * Once a minute: sessions whose listener is gone are closed, and listeners without a session (connected while the
   * hook was not reachable) get one, without an address. Takes the client lists of the local servers and, when an
   * admin password is set, of external servers.
   */
  async reconcile(snap: Snapshot, live: Map<string, Map<string, MountStats>>) {
    if (Date.now() - this.lastReconcile < 60_000) return;
    this.lastReconcile = Date.now();
    await this.reload().catch(() => undefined);
    const now = Date.now();
    for (const view of snap.stations.values()) {
      if (!view.active) continue;
      const mounts = [...(live.get(view.station.id)?.keys() ?? [])];
      const seen = new Map<string, { mount: string; c: IcecastClient }>();
      let complete = true;
      for (const mount of mounts) {
        try {
          for (const c of await listClients({ port: view.station.icecastPort, adminPassword: view.adminPassword }, mount)) {
            if (!c.userAgent.startsWith(INTERNAL_AGENT) && c.id) seen.set(c.id, { mount, c });
          }
        } catch {
          complete = false;
        }
      }
      for (const [key, s] of this.open) {
        const [sid, clientKey] = [key.slice(0, 36), key.slice(37)];
        if (sid !== view.station.id || clientKey.startsWith('ext:')) continue;
        // Sessions that started while the lists were read are left for the next round.
        if (!seen.has(clientKey) && complete && s.startedAt < now - 10_000) await this.closeSession(sid, clientKey, now).catch(() => undefined);
        else if (seen.get(clientKey)?.mount && seen.get(clientKey)!.mount !== s.mount) s.mount = seen.get(clientKey)!.mount;
      }
      for (const [id, { mount, c }] of seen) {
        // A listener that just connected may still be on its way through the hook.
        if (this.open.has(`${view.station.id}:${id}`) || c.connectedSeconds < 15) continue;
        await this.openSession(view, { key: id, mount, via: 'web', ip: null, userAgent: c.userAgent, startedAt: now - c.connectedSeconds * 1000 }).catch(() => undefined);
      }
      for (const o of view.outputs) {
        if (o.type === 'local' || !o.enabled || !o.config.adminPassword) continue;
        try {
          await this.syncExternal(view, o, await externalClients(this.ctx, o), now);
        } catch (err) {
          this.log.debug({ err, output: o.name }, 'reading the listeners of an external server failed');
        }
      }
    }
    // Sessions of stations that were removed or switched off.
    const active = new Set([...snap.stations.values()].filter((v) => v.active).map((v) => v.station.id));
    for (const key of [...this.open.keys()]) {
      const sid = key.slice(0, 36);
      if (!active.has(sid)) await this.closeSession(sid, key.slice(37), now).catch(() => undefined);
    }
  }

  private async syncExternal(view: StationView, o: Output, clients: ExternalClient[], now: number) {
    const prefix = `ext:${o.id}:`;
    const ids = new Set(clients.map((c) => `${prefix}${c.id}`));
    for (const key of [...this.open.keys()]) {
      if (!key.startsWith(`${view.station.id}:${prefix}`)) continue;
      const clientKey = key.slice(37);
      if (!ids.has(clientKey)) await this.closeSession(view.station.id, clientKey, now);
    }
    for (const c of clients) {
      if (c.userAgent?.startsWith(INTERNAL_AGENT)) continue;
      await this.openSession(view, {
        key: `${prefix}${c.id}`,
        mount: o.config.mount ?? (o.type === 'icecast' ? '/' : `/sid${o.config.streamId ?? 1}`),
        via: 'external',
        ip: normalizeIp(c.ip),
        userAgent: c.userAgent,
        referer: c.referer,
        startedAt: now - c.connectedSeconds * 1000,
        outputId: o.id,
      });
    }
  }

}

const tag = (xml: string, name: string) => xml.match(new RegExp(`<${name}>([^<]*)</${name}>`, 'i'))?.[1] ?? null;

/** The listener list of an external server (needs its admin password). */
export async function externalClients(ctx: AppContext, output: Output): Promise<ExternalClient[]> {
  const c = output.config;
  const base = `${c.tls ? 'https' : 'http'}://${c.host}:${c.port}`;
  const pass = ctx.box.decrypt(c.adminPassword!);
  const headers = { 'user-agent': 'Mozilla/5.0 (Hosted Radio Station)' };
  const get = async (path: string, auth?: string) => {
    const res = await fetch(`${base}${path}`, { headers: auth ? { ...headers, authorization: auth } : headers, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`answered ${res.status}`);
    return res.text();
  };
  if (output.type === 'icecast') {
    const body = await get(`/admin/listclients?mount=${encodeURIComponent(c.mount ?? '/')}`, `Basic ${Buffer.from(`admin:${pass}`).toString('base64')}`);
    return parseClients(body).map((x) => ({ id: x.id, ip: x.ip, userAgent: x.userAgent, connectedSeconds: x.connectedSeconds }));
  }
  if (output.type === 'shoutcast2') {
    const q = new URLSearchParams({ sid: String(c.streamId ?? 1), mode: 'viewjson', page: '3', pass });
    const list = JSON.parse(await get(`/admin.cgi?${q}`)) as { uid?: number | string; hostname?: string; useragent?: string; connecttime?: number; referer?: string; xff?: string }[];
    return (Array.isArray(list) ? list : []).map((l, i) => ({
      id: String(l.uid ?? i),
      ip: (l.xff || l.hostname) ?? null,
      userAgent: l.useragent ?? null,
      connectedSeconds: Number(l.connecttime ?? 0),
      referer: l.referer ?? null,
    }));
  }
  const q = new URLSearchParams({ mode: 'viewxml', page: '3', pass });
  const xml = await get(`/admin.cgi?${q}`);
  return [...xml.matchAll(/<LISTENER>([\s\S]*?)<\/LISTENER>/gi)].map((m, i) => {
    const time = tag(m[1]!, 'CONNECTTIME') ?? '0';
    // Shoutcast 1 reports "h:mm:ss" or seconds.
    const secs = time.includes(':') ? time.split(':').reduce((n, p) => n * 60 + Number(p), 0) : Number(time);
    return { id: tag(m[1]!, 'UID') ?? tag(m[1]!, 'POINTER') ?? String(i), ip: tag(m[1]!, 'HOSTNAME'), userAgent: tag(m[1]!, 'USERAGENT'), connectedSeconds: secs || 0 };
  });
}
