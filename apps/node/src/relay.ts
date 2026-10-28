import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { AGENT, killClient, listClients, localMount, updateTitle, type IcecastSecrets } from './icecast.js';
import { log } from './log.js';
import type { AgentReport, RelayMount } from './protocol.js';
import { LINGER_MS, PushReceiver } from './push.js';

type RelayState = AgentReport['relays'][number];

/**
 * Reads the in-stream titles of an Icecast/Shoutcast stream (ICY metadata every `interval` bytes) and returns the
 * audio without them. Exported for tests.
 */
export class IcyReader {
  private left: number;
  private metaLen = -1;
  private meta: Buffer[] = [];
  private metaGot = 0;

  constructor(
    private readonly interval: number,
    private readonly onTitle: (title: string) => void,
  ) {
    this.left = interval;
  }

  push(chunk: Buffer): Buffer[] {
    const audio: Buffer[] = [];
    let i = 0;
    while (i < chunk.length) {
      if (this.metaLen < 0 && this.left > 0) {
        const take = Math.min(this.left, chunk.length - i);
        audio.push(chunk.subarray(i, i + take));
        this.left -= take;
        i += take;
      } else if (this.metaLen < 0) {
        this.metaLen = chunk[i]! * 16;
        i++;
        if (this.metaLen === 0) {
          this.metaLen = -1;
          this.left = this.interval;
        } else {
          this.meta = [];
          this.metaGot = 0;
        }
      } else {
        const take = Math.min(this.metaLen - this.metaGot, chunk.length - i);
        this.meta.push(chunk.subarray(i, i + take));
        this.metaGot += take;
        i += take;
        if (this.metaGot === this.metaLen) {
          const text = Buffer.concat(this.meta).toString('utf8').replace(/\0+$/, '');
          const title = text.match(/StreamTitle='(.*?)';/s)?.[1];
          if (title !== undefined) this.onTitle(title);
          this.metaLen = -1;
          this.left = this.interval;
        }
      }
    }
    return audio;
  }
}

/** Logs in as the source of a mount on the node's own Icecast server (HTTP PUT). */
export function sourceConnection(port: number, mount: string, password: string, headers: Record<string, string>): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('error', (err) => reject(new Error(`local Icecast: ${err.message}`)));
    socket.once('connect', () => {
      const head = [
        `PUT ${mount} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        `Authorization: Basic ${Buffer.from(`source:${password}`).toString('base64')}`,
        `User-Agent: ${AGENT}`,
        ...Object.entries(headers).map(([k, v]) => `${k}: ${v.replace(/[\r\n]/g, ' ')}`),
        'Expect: 100-continue',
      ];
      socket.write(`${head.join('\r\n')}\r\n\r\n`);
      let text = '';
      const timer = setTimeout(() => done(new Error('no answer from the local Icecast')), 10_000);
      const onData = (d: Buffer) => {
        text += d.toString('latin1');
        if (/HTTP\/1\.[01] (?!100)\d{3}[^\r\n]*\r\n(?:[^\r\n]+\r\n)*\r\n/.test(text) || text.length > 8192) done(null);
      };
      const onClose = () => done(new Error('the local Icecast closed the connection'));
      function done(err: Error | null) {
        clearTimeout(timer);
        socket.off('data', onData);
        socket.off('close', onClose);
        if (err) {
          socket.destroy();
          return reject(err);
        }
        const status = [...text.matchAll(/HTTP\/1\.[01] (\d{3})/g)].map((m) => m[1]).find((c) => c !== '100');
        if (status === '200') return resolve(socket);
        socket.destroy();
        reject(new Error(status === '403' ? `mount ${mount} is in use` : `local Icecast answered ${status ?? '?'}`));
      }
      socket.on('data', onData);
      socket.once('close', onClose);
    });
  });
}

function get(url: string, headers: Record<string, string>): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.get(url, { headers, timeout: 15_000 }, resolve);
    req.once('timeout', () => req.destroy(new Error('timeout')));
    req.once('error', reject);
  });
}

/** Pulls one stream from the main server and feeds it into the node's Icecast, again and again with a growing pause. */
class Puller {
  state: RelayState;
  private stopped = false;
  private failures = 0;
  private retry: NodeJS.Timeout | null = null;
  private res: http.IncomingMessage | null = null;
  private sock: net.Socket | null = null;
  private title: string | null = null;
  /** The stream moves to a push (a station node took the station over): keep the source open for it. */
  private handing = false;
  /**
   * A source connection into Icecast left open by the push this stream had before (see PushReceiver.apply), or by
   * this puller's own last run.
   */
  inherited: net.Socket | null = null;
  /** Since when `inherited` waits for the stream; it is given up after LINGER_MS. */
  private held = 0;

  constructor(
    readonly mount: RelayMount,
    private readonly ctx: { icecastPort: () => number; secrets: IcecastSecrets; nodeId: string },
  ) {
    this.state = { key: mount.key, state: 'idle' };
  }

  start() {
    void this.loop();
  }

  stop() {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    this.res?.destroy();
    this.sock?.destroy();
    this.inherited?.destroy();
    this.inherited = null;
  }

  /** Keeps the source connection into Icecast open, also when the pulled stream ends, until a push takes it. */
  handOver() {
    this.handing = true;
  }

  /** The open source connection, for the push that takes this stream over; the puller stops without closing it. */
  takeSource(): net.Socket | null {
    const sock = this.sock && !this.sock.destroyed ? this.sock : null;
    this.sock = null;
    this.stop();
    return sock;
  }

  private async loop() {
    if (this.stopped) return;
    this.state = { key: this.mount.key, state: 'connecting' };
    const started = Date.now();
    try {
      await this.run();
      this.state = { key: this.mount.key, state: 'error', message: 'The stream ended' };
    } catch (err) {
      this.state = { key: this.mount.key, state: 'error', message: (err as Error).message };
    }
    this.res?.destroy();
    // Handing over: Icecast keeps the listeners for a few seconds without data, until the push arrives.
    if (this.handing && this.sock && !this.sock.destroyed) return;
    // The stream ended upstream (the main server restarted it or reloaded its web server): keep the source open a
    // moment, so listeners stay connected when it comes back.
    if (!this.stopped && this.sock && !this.sock.destroyed) this.inherited = this.sock;
    else this.sock?.destroy();
    this.sock = null;
    if (this.inherited) {
      this.held ||= Date.now();
      if (this.inherited.destroyed || Date.now() - this.held > LINGER_MS) {
        this.inherited.destroy();
        this.inherited = null;
        this.held = 0;
      }
    }
    if (this.stopped) return;
    this.failures = Date.now() - started > 60_000 ? 0 : this.failures + 1;
    // A stream that is not on air (404) is tried again soon, so listeners hear it when it starts.
    // While it holds the open source of the push before it, every second: Icecast drops an idle source after 10 s.
    const delay = this.inherited && !this.inherited.destroyed ? 1000 : Math.min(15_000, 1000 * 2 ** Math.min(this.failures, 4));
    this.retry = setTimeout(() => void this.loop(), delay);
  }

  private async run() {
    const res = await get(this.mount.url!, { 'user-agent': `${AGENT} ${this.ctx.nodeId}`, 'icy-metadata': '1' });
    this.res = res;
    if (res.statusCode !== 200) {
      res.resume();
      throw new Error(res.statusCode === 404 ? 'Not on air' : `The main server answered ${res.statusCode}`);
    }
    const contentType = String(res.headers['content-type'] ?? 'audio/mpeg');
    const metaint = Number(res.headers['icy-metaint']) || 0;
    const br = Number(res.headers['icy-br']) || Number(String(res.headers['ice-audio-info'] ?? '').match(/bitrate=(\d+)/)?.[1]) || null;
    const port = this.ctx.icecastPort();
    const target = localMount(this.mount);
    const kept = this.inherited && !this.inherited.destroyed ? this.inherited : null;
    this.inherited = null;
    this.held = 0;
    const sock = kept ?? await sourceConnection(port, target, this.ctx.secrets.source, {
      'Content-Type': contentType,
      'Ice-Name': this.mount.name,
      'Ice-Public': '0',
      ...(br ? { 'Ice-Audio-Info': `bitrate=${br}` } : {}),
    });
    this.sock = sock;
    this.state = { key: this.mount.key, state: 'connected', bitrateKbps: br };
    log.info('relaying', { mount: this.mount.key });
    const reader = metaint
      ? new IcyReader(metaint, (title) => {
          if (title === this.title) return;
          this.title = title;
          // Give Icecast a moment to register the source before the first title.
          setTimeout(() => void updateTitle(port, this.ctx.secrets.admin, target, title).catch(() => undefined), 300);
        })
      : null;
    await new Promise<void>((resolve, reject) => {
      res.on('data', (chunk: Buffer) => {
        for (const part of reader ? reader.push(chunk) : [chunk]) if (part.length && !sock.write(part)) res.pause();
      });
      sock.on('drain', () => res.resume());
      res.once('end', () => resolve());
      res.once('error', reject);
      res.once('close', () => resolve());
      sock.once('error', reject);
      sock.once('close', () => reject(new Error('the local Icecast dropped the stream')));
    });
  }
}

interface Client {
  key: string;
  id: string;
  ip: string | null;
  userAgent: string | null;
  referer: string | null;
  since: number;
}

/**
 * The relay role: one puller per carried mount, and the listeners of the node's Icecast, reported to it through the
 * listener hooks (with the real address that Caddy passes in X-Hrs-Client). Once a minute the list is compared with
 * Icecast's own, so nothing stays behind when a hook was missed.
 */
export class RelayManager {
  private pullers = new Map<string, Puller>();
  /** Pullers of streams that a station node now pushes, kept until its push takes over their source connection. */
  private handing = new Map<string, { puller: Puller; timer: NodeJS.Timeout }>();
  /** Streams that station nodes push here instead (phase 12). */
  readonly push: PushReceiver;
  private mounts: RelayMount[] = [];
  private clients = new Map<string, Client>();
  /** Listeners that left since the last report. */
  private ended: { key: string; id: string; endedAt: string }[] = [];
  private lastCheck = 0;
  private draining: NodeJS.Timeout[] = [];

  constructor(private readonly ctx: { icecastPort: () => number; secrets: IcecastSecrets; nodeId: string; trustClientHeader: boolean }) {
    this.push = new PushReceiver({ ...ctx, inherit: (key) => this.takeHandover(key) });
  }

  apply(mounts: RelayMount[], pushPort: number | number[] | null = null) {
    this.mounts = mounts;
    const handedBack = new Map<string, net.Socket>();
    void this.push.apply(pushPort, mounts, (key, local) => handedBack.set(key, local)).catch((err) => log.error('push port failed', { err }));
    const wanted = new Map(mounts.filter((m) => m.url).map((m) => [m.key, m]));
    const pushed = new Set(mounts.filter((m) => m.push && !m.url).map((m) => m.key));
    for (const [key, p] of this.pullers) {
      const want = wanted.get(key);
      if (!want || JSON.stringify(want) !== JSON.stringify(p.mount)) {
        this.pullers.delete(key);
        // The station moved to a station node: its push takes over this source, so listeners stay connected.
        if (!want && pushed.has(key) && !this.push.connected(key)) {
          p.handOver();
          this.handing.get(key)?.puller.stop();
          this.handing.set(key, { puller: p, timer: setTimeout(() => this.takeHandover(key)?.destroy(), 30_000) });
        } else p.stop();
      }
    }
    for (const [key, m] of wanted) {
      if (this.pullers.has(key)) continue;
      const p = new Puller(m, this.ctx);
      p.inherited = handedBack.get(key) ?? null;
      handedBack.delete(key);
      this.pullers.set(key, p);
      p.start();
    }
    for (const local of handedBack.values()) local.destroy();
  }

  /**
   * Before an update: disconnects the listeners one by one, spread over `seconds`, so their players reconnect through
   * the listen route (which now picks another relay) instead of all at once when the node restarts. 0 = stop.
   */
  drain(seconds: number) {
    for (const t of this.draining) clearTimeout(t);
    this.draining = [];
    if (seconds <= 0) return;
    const list = [...this.clients.values()];
    const step = list.length ? (seconds * 1000 * 0.8) / list.length : 0;
    list.forEach((c, i) => {
      const m = this.mounts.find((x) => x.key === c.key);
      if (!m) return;
      const t = setTimeout(() => void killClient(this.ctx.icecastPort(), this.ctx.secrets.admin, localMount(m), c.id).catch((err) => log.debug('moving a listener failed', { err })), Math.round(i * step));
      t.unref();
      this.draining.push(t);
    });
    log.info('moving listeners to other relays before an update', { listeners: list.length, seconds });
  }

  /** The source connection a puller kept open for the push of the same stream (see apply). */
  private takeHandover(key: string): net.Socket | null {
    const h = this.handing.get(key);
    if (!h) return null;
    this.handing.delete(key);
    clearTimeout(h.timer);
    return h.puller.takeSource();
  }

  stopAll() {
    this.drain(0);
    for (const key of [...this.handing.keys()]) this.takeHandover(key)?.destroy();
    for (const p of this.pullers.values()) p.stop();
    this.pullers.clear();
    this.push.stop();
    for (const k of [...this.clients.keys()]) this.drop(k);
  }

  /** "/listen/<slug>/<mount>" → "<slug>/<mount>" */
  private keyOf(mount: string) {
    const clean = mount.split('?')[0]!;
    return clean.startsWith('/listen/') ? clean.slice(8) : null;
  }

  /** An Icecast listener hook (add/remove), body as form fields. */
  hook(action: 'add' | 'remove', p: URLSearchParams) {
    const key = this.keyOf(p.get('mount') ?? '');
    const id = p.get('client');
    if (!key || !id) return;
    if (action === 'remove') {
      this.drop(`${key}#${id}`);
      return;
    }
    const agent = p.get('agent') ?? '';
    // Our own probes and other nodes are not listeners.
    if (agent.startsWith('Hosted Radio Station')) return;
    // Only the node's own web server sets X-Hrs-Client; without it a listener could send any address.
    const ip = (this.ctx.trustClientHeader && p.get('h_x-hrs-client')) || p.get('ip') || null;
    this.clients.set(`${key}#${id}`, { key, id, ip, userAgent: agent || null, referer: p.get('h_referer') || null, since: Date.now() });
  }

  /** Drops listeners Icecast no longer has, and adds the ones a missed hook left out. */
  async check() {
    if (Date.now() - this.lastCheck < 55_000) return;
    this.lastCheck = Date.now();
    const port = this.ctx.icecastPort();
    const live = (m: RelayMount) => (m.push ? this.push.connected(m.key) : this.pullers.get(m.key)?.state.state === 'connected');
    for (const m of this.mounts) {
      const key = m.key;
      if (!live(m)) {
        for (const k of [...this.clients.keys()]) if (k.startsWith(`${key}#`)) this.drop(k);
        continue;
      }
      try {
        const list = await listClients(port, this.ctx.secrets.admin, localMount(m));
        const ids = new Set(list.map((c) => c.id));
        for (const k of [...this.clients.keys()]) if (k.startsWith(`${key}#`) && !ids.has(k.slice(key.length + 1)) && Date.now() - this.clients.get(k)!.since > 10_000) this.drop(k);
        for (const c of list) {
          if (c.userAgent.startsWith('Hosted Radio Station') || this.clients.has(`${key}#${c.id}`) || c.connectedSeconds < 15) continue;
          this.clients.set(`${key}#${c.id}`, { key, id: c.id, ip: null, userAgent: c.userAgent || null, referer: null, since: Date.now() - c.connectedSeconds * 1000 });
        }
      } catch (err) {
        log.debug('reading the listeners failed', { mount: key, err });
      }
    }
  }

  /** Forgets a listener and remembers when it left, for the next report. */
  private drop(k: string) {
    const c = this.clients.get(k);
    if (!c) return;
    this.clients.delete(k);
    this.ended.push({ key: c.key, id: c.id, endedAt: new Date().toISOString() });
    if (this.ended.length > 10_000) this.ended.splice(0, this.ended.length - 10_000);
  }

  /** The listeners that left since the last call (put back with restoreEnded when the report failed). */
  drainEnded() {
    return this.ended.splice(0);
  }

  restoreEnded(list: { key: string; id: string; endedAt: string }[]) {
    this.ended.unshift(...list);
  }

  get listenerCount() {
    return this.clients.size;
  }

  states(): RelayState[] {
    const count = (key: string) => [...this.clients.values()].filter((c) => c.key === key).length;
    return [...[...this.pullers.values()].map((p) => p.state), ...this.push.states()].map((s) => ({ ...s, listeners: count(s.key) }));
  }

  reportClients(): AgentReport['clients'] {
    const now = Date.now();
    return [...this.clients.values()].map((c) => ({ key: c.key, id: c.id, ip: c.ip, userAgent: c.userAgent, referer: c.referer, connectedSeconds: Math.round((now - c.since) / 1000) }));
  }
}
