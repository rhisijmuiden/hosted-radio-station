import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { AGENT, listClients, localMount, updateTitle, type IcecastSecrets } from './icecast.js';
import { log } from './log.js';
import type { AgentReport, RelayMount } from './protocol.js';

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
function sourceConnection(port: number, mount: string, password: string, headers: Record<string, string>): Promise<net.Socket> {
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
    this.sock?.destroy();
    if (this.stopped) return;
    this.failures = Date.now() - started > 60_000 ? 0 : this.failures + 1;
    // A stream that is not on air (404) is tried again soon, so listeners hear it when it starts.
    const delay = Math.min(15_000, 1000 * 2 ** Math.min(this.failures, 4));
    this.retry = setTimeout(() => void this.loop(), delay);
  }

  private async run() {
    const res = await get(this.mount.url, { 'user-agent': `${AGENT} ${this.ctx.nodeId}`, 'icy-metadata': '1' });
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
    const sock = await sourceConnection(port, target, this.ctx.secrets.source, {
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
  private clients = new Map<string, Client>();
  private lastCheck = 0;

  constructor(private readonly ctx: { icecastPort: () => number; secrets: IcecastSecrets; nodeId: string; trustClientHeader: boolean }) {}

  apply(mounts: RelayMount[]) {
    const wanted = new Map(mounts.map((m) => [m.key, m]));
    for (const [key, p] of this.pullers) {
      const want = wanted.get(key);
      if (!want || JSON.stringify(want) !== JSON.stringify(p.mount)) {
        p.stop();
        this.pullers.delete(key);
      }
    }
    for (const [key, m] of wanted) {
      if (this.pullers.has(key)) continue;
      const p = new Puller(m, this.ctx);
      this.pullers.set(key, p);
      p.start();
    }
  }

  stopAll() {
    for (const p of this.pullers.values()) p.stop();
    this.pullers.clear();
    this.clients.clear();
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
      this.clients.delete(`${key}#${id}`);
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
    for (const [key, p] of this.pullers) {
      if (p.state.state !== 'connected') {
        for (const k of [...this.clients.keys()]) if (k.startsWith(`${key}#`)) this.clients.delete(k);
        continue;
      }
      try {
        const list = await listClients(port, this.ctx.secrets.admin, localMount(p.mount));
        const ids = new Set(list.map((c) => c.id));
        for (const k of [...this.clients.keys()]) if (k.startsWith(`${key}#`) && !ids.has(k.slice(key.length + 1)) && Date.now() - this.clients.get(k)!.since > 10_000) this.clients.delete(k);
        for (const c of list) {
          if (c.userAgent.startsWith('Hosted Radio Station') || this.clients.has(`${key}#${c.id}`) || c.connectedSeconds < 15) continue;
          this.clients.set(`${key}#${c.id}`, { key, id: c.id, ip: null, userAgent: c.userAgent || null, referer: null, since: Date.now() - c.connectedSeconds * 1000 });
        }
      } catch (err) {
        log.debug('reading the listeners failed', { mount: key, err });
      }
    }
  }

  get listenerCount() {
    return this.clients.size;
  }

  states(): RelayState[] {
    return [...this.pullers.values()].map((p) => ({ ...p.state, listeners: [...this.clients.values()].filter((c) => c.key === p.mount.key).length }));
  }

  reportClients(): AgentReport['clients'] {
    const now = Date.now();
    return [...this.clients.values()].map((c) => ({ key: c.key, id: c.id, ip: c.ip, userAgent: c.userAgent, referer: c.referer, connectedSeconds: Math.round((now - c.since) / 1000) }));
  }
}
