import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { dataPath, ports, readVersion, writeAtomic, type NodeFile } from './config.js';
import { applyStatus, applyWeb, requestUpdate, updateStatus, type JobStatus } from './helpers.js';
import { icecastConfigPath, icecastSecrets, reloadIcecast, renderIcecastConfig, type IcecastLayout, type IcecastSecrets } from './icecast.js';
import { FmManager } from './fm/manager.js';
import { log } from './log.js';
import { Prober } from './probe.js';
import { IngestManager } from './ingest.js';
import { CLOSE, PROTOCOL_VERSION, type AgentLive, type AgentMessage, type AgentReport, type AuthResult, type NodePlan, type ServerMessage } from './protocol.js';
import { RelayManager } from './relay.js';
import { SourceForwarder } from './source.js';
import { facts, icmpPing, Sampler } from './system.js';

const planPath = () => dataPath('plan.json');

/**
 * The node agent: keeps one WebSocket open to the main server, carries out the plan it gets (relay, source, probes,
 * version) and reports its health. Everything keeps running while the main server is unreachable; the agent
 * reconnects with a growing pause.
 */
export class Agent {
  private ws: WebSocket | null = null;
  private plan: NodePlan | null = null;
  private secrets: IcecastSecrets | null = null;
  private relay: RelayManager | null = null;
  private source: SourceForwarder;
  private ingest: IngestManager | null = null;
  /** Encoder log-ins waiting for the main server's answer. */
  private auths = new Map<number, (r: AuthResult | null) => void>();
  private authSeq = 0;
  /** Broadcast messages the main server has not had yet (kept while it is unreachable). */
  private liveQueue: AgentLive[] = [];
  /** The main server accepted this connection (welcome), so it takes messages. */
  private ready = false;
  private prober = new Prober();
  private fm: FmManager;
  private sampler = new Sampler();
  private hooks: http.Server | null = null;
  private timers: NodeJS.Timeout[] = [];
  private retries = 0;
  /** Last message from the main server; it pings every 5 seconds, so silence means a dead connection. */
  private heardAt = 0;
  private stopped = false;
  private icmp: { rttMs: number | null; loss: number } | null = null;
  private layout: IcecastLayout | null = null;
  private update: JobStatus | null = null;
  /** Id of the update this agent asked for, until the root helper reports on it (an older status file is not news). */
  private updateId: string | null = null;
  /** The commit an automatic update was last asked for, so a failing update is not repeated forever. */
  private autoTried: string | null = null;
  private readonly version = readVersion();

  constructor(private readonly file: NodeFile) {
    this.source = new SourceForwarder({ nodeId: file.nodeId, secret: file.secret });
    this.fm = new FmManager(file.nodeId);
  }

  async start() {
    this.secrets = await icecastSecrets();
    this.relay = new RelayManager({ icecastPort: () => this.layout?.port ?? ports.icecast, secrets: this.secrets, nodeId: this.file.nodeId, trustClientHeader: this.file.web === 'caddy' });
    this.ingest = new IngestManager({
      icecastPort: () => this.layout?.port ?? ports.icecast,
      secrets: this.secrets,
      nodeId: this.file.nodeId,
      auth: (q) => this.askAuth(q),
      live: (m) => this.sendLive(m),
    });
    this.source.ingest = this.ingest;
    await this.startHooks();
    // The plan of the last connection, so the node keeps serving listeners when it starts while the main server is down.
    const saved = await readFile(planPath(), 'utf8').catch(() => null);
    if (saved) await this.applyPlan(JSON.parse(saved) as NodePlan).catch((err) => log.warn('applying the saved plan failed', { err }));
    this.update = await updateStatus();
    this.timers.push(setInterval(() => this.sendStats(), 5000));
    this.timers.push(setInterval(() => void this.report(), 30_000));
    this.timers.push(setInterval(() => void this.relay?.check(), 15_000));
    this.timers.push(setInterval(() => void this.source.refreshCertificates(), 30_000));
    this.timers.push(setInterval(() => void this.pingMain(), 60_000));
    this.timers.push(setInterval(() => this.watchdog(), 5000));
    void this.pingMain();
    this.connect();
    log.info('node agent started', { node: this.file.nodeId, server: this.file.server, version: this.version.version, commit: this.version.commit?.slice(0, 7) });
  }

  async stop() {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.ws?.close(1001, 'stopping');
    this.relay?.stopAll();
    this.ingest?.stop();
    this.source.stop();
    this.prober.stop();
    this.fm.stop();
    this.hooks?.close();
  }

  // Ingest (phase 13): log-ins are checked by the main server, broadcasts are logged there.

  private askAuth(q: { stationId: string; mount: string; user: string | null; pass: string; ip: string; purpose: 'source' | 'metadata' }): Promise<AuthResult | null> {
    if (!this.ready || this.ws?.readyState !== WebSocket.OPEN) return Promise.resolve(null);
    const id = ++this.authSeq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.auths.delete(id);
        resolve(null);
      }, 8000);
      this.auths.set(id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      this.send({ t: 'auth', id, ...q });
    });
  }

  private sendLive(m: AgentLive) {
    if (this.ready && this.ws?.readyState === WebSocket.OPEN) return this.send(m);
    this.liveQueue.push(m);
    if (this.liveQueue.length > 1000) this.liveQueue.splice(0, this.liveQueue.length - 1000);
  }

  /** After (re)connecting: the broadcasts that started or ended meanwhile, then the ones on air now. */
  private flushLive() {
    for (const m of this.liveQueue.splice(0)) this.send(m);
    this.send({ t: 'live_sync', sessionIds: this.ingest?.sessionIds() ?? [] });
  }

  // Control channel

  private connect() {
    if (this.stopped) return;
    const url = `${this.file.server.replace(/^http/, 'ws')}/api/nodes/connect`;
    const ws = new WebSocket(url);
    this.ws = ws;
    this.heardAt = Date.now();
    ws.onopen = () => {
      this.heardAt = Date.now();
      const f = facts(this.file.web);
      this.send({ t: 'hello', protocol: PROTOCOL_VERSION, nodeId: this.file.nodeId, secret: this.file.secret, version: this.version.version, commit: this.version.commit, hostname: f.hostname, facts: f.facts });
    };
    ws.onmessage = (ev) => {
      this.heardAt = Date.now();
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      void this.onMessage(msg).catch((err) => log.error('handling a message failed', { t: msg.t, err }));
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.ready = false;
      if (this.stopped) return;
      // A restart of the main server takes a few seconds (1001 = it said so): try again soon, a little apart per node,
      // and only slow down to every 30 s when it stays away for about two minutes.
      if (ev.code === 1001) this.retries = 0;
      const n = this.retries++;
      let delay = (n < 30 ? Math.min(5000, 1000 * (n + 1)) : 30_000) + Math.floor(Math.random() * 500);
      if (ev.code === CLOSE.unauthorized) {
        // Unpaired or removed in the panel: stop serving, and look again now and then in case it was a mistake.
        log.error('the main server does not accept this node; pair it again with "hrs-node pair"', { reason: ev.reason });
        this.relay?.stopAll();
        this.ingest?.stop();
        void this.source.apply(null);
        this.prober.stop();
        this.fm.stop();
        delay = 5 * 60_000;
      } else if (ev.code === CLOSE.protocol) {
        log.error('the main server speaks another protocol version; update this node', { reason: ev.reason });
        delay = 60_000;
      } else if (ev.code !== CLOSE.replaced) {
        log.warn('connection to the main server lost', { code: ev.code, reason: ev.reason, retryIn: delay });
      }
      setTimeout(() => this.connect(), delay);
    };
    ws.onerror = () => undefined;
  }

  /**
   * A connection that hangs while connecting, or goes quiet (a half-open TCP connection after a restart or a network
   * change), is dropped so the reconnect starts. A stuck socket may never fire its close event, so the agent moves on.
   */
  private watchdog() {
    const ws = this.ws;
    // The server pings every 5 seconds.
    if (!ws || this.stopped || Date.now() - this.heardAt < 15_000) return;
    log.warn('no answer from the main server; reconnecting', { state: ws.readyState });
    this.reconnect(1000);
  }

  /** Drops the connection without waiting for its close event, and connects again after `delay` ms. */
  private reconnect(delay: number) {
    const ws = this.ws;
    if (!ws) return;
    this.ws = null;
    this.ready = false;
    ws.onclose = null;
    try {
      ws.close();
    } catch {
      // already closing
    }
    setTimeout(() => this.connect(), delay);
  }

  private send(msg: AgentMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private event(kind: string, level: 'info' | 'warning' | 'error', details: Record<string, string | number | null> = {}) {
    this.send({ t: 'event', kind, level, details });
  }

  private async onMessage(msg: ServerMessage) {
    switch (msg.t) {
      case 'welcome':
        this.retries = 0;
        this.ready = true;
        log.info('connected to the main server', { name: msg.name });
        // The update helper waits for this after a restart: a new version that cannot reach the server is rolled back.
        await writeAtomic(dataPath('run', 'agent-state.json'), JSON.stringify({ commit: this.version.commit, connectedAt: new Date().toISOString() }), 0o644).catch(() => undefined);
        this.flushLive();
        return;
      case 'auth_result': {
        const done = this.auths.get(msg.id);
        this.auths.delete(msg.id);
        done?.(msg);
        return;
      }
      case 'ping':
        return this.send({ t: 'pong', seq: msg.seq });
      case 'plan':
        await this.applyPlan(msg.plan);
        await writeAtomic(planPath(), JSON.stringify(msg.plan));
        await this.maybeAutoUpdate(msg.plan);
        return;
      case 'update':
        return this.startUpdate(msg.branch, msg.commit, 'requested');
      case 'drain':
        this.relay?.drain(msg.seconds);
        if (msg.seconds > 0) this.event('draining', 'info', { seconds: msg.seconds, listeners: this.relay?.listenerCount ?? 0 });
        return;
      case 'fm':
        return this.fm.setContext({ dj: msg.dj, show: msg.show });
      case 'restart':
        log.info('the main server restarts; reconnecting');
        this.retries = 0;
        return this.reconnect(1000 + Math.floor(Math.random() * 500));
    }
  }

  // Plan

  private async applyPlan(plan: NodePlan) {
    this.plan = plan;
    const caddy = this.file.web === 'caddy';
    const layout: IcecastLayout = caddy ? { bind: '127.0.0.1', port: ports.icecast } : { bind: '0.0.0.0', port: plan.web.listenPort ?? 8000 };
    const mounts = plan.relay?.mounts ?? [];
    const body = renderIcecastConfig({ name: plan.name, hostname: plan.web.publicHost ?? facts(this.file.web).hostname, layout, mounts, ingest: plan.ingest?.stations ?? [], maxListeners: plan.relay?.maxListeners ?? 0, secrets: this.secrets! });
    const current = await readFile(icecastConfigPath(), 'utf8').catch(() => null);
    const restart = !this.layout || this.layout.port !== layout.port || this.layout.bind !== layout.bind;
    this.layout = layout;
    if (current !== body) {
      await writeAtomic(icecastConfigPath(), body, 0o640);
      if (!restart) await reloadIcecast();
    }
    // The root helper starts Icecast (again when its port changed) and sets up the web server and certificates.
    await applyWeb({
      web: this.file.web,
      publicHost: plan.web.publicHost,
      listenPort: caddy ? (plan.web.listenPort ?? 80) : layout.port,
      icecastPort: layout.port,
      icecastBind: layout.bind,
      certHosts: [...new Set([plan.web.publicHost, ...(plan.source?.hosts ?? [])].filter((h): h is string => !!h))].sort(),
      station: !!plan.station,
      ffmpeg: !!plan.ingest?.stations.some((st) => st.mounts.some((m) => m.kind === 'transcode')),
    });
    // Give Icecast a moment to read the new mounts before the streams come in.
    setTimeout(
      () => {
        this.relay?.apply(mounts, plan.relay?.pushPort ?? null);
        this.ingest?.apply(plan.ingest ?? null);
      },
      current !== body ? 1500 : 0,
    );
    await this.source.apply(plan.source);
    this.prober.apply(plan.probes);
    // Plans of older main servers have no fm field.
    this.fm.apply(plan.roles.includes('fm') ? (plan.fm ?? null) : null);
    log.info('plan applied', { revision: plan.revision, roles: plan.roles.join(',') || 'none', mounts: mounts.length, probes: plan.probes?.targets.length ?? 0 });
  }

  // Updates

  private async maybeAutoUpdate(plan: NodePlan) {
    const want = plan.update.commit;
    if (!plan.update.auto || !want || want === this.version.commit || this.autoTried === want) return;
    if (this.update?.state === 'running') return;
    this.autoTried = want;
    await this.startUpdate(plan.update.branch, want, 'automatic');
  }

  private async startUpdate(branch: string | null, commit: string | null, why: string) {
    if (commit && commit === this.version.commit) return;
    log.info('updating the node', { branch, commit: commit?.slice(0, 7), why });
    this.updateId = await requestUpdate(branch, commit);
    this.update = { state: 'running', message: 'Starting', at: new Date().toISOString() };
    this.event('update_started', 'info', { commit: commit?.slice(0, 7) ?? null, why });
  }

  // Health

  private async pingMain() {
    const host = new URL(this.file.server).hostname;
    const r = await icmpPing(host);
    // 100% loss while the control channel works means ICMP is filtered, not that every packet is lost.
    this.icmp = r && r.loss < 1 ? r : null;
  }

  private sendStats() {
    void (async () => {
      const [apply, update] = await Promise.all([applyStatus(), updateStatus()]);
      if (update && (!this.updateId || update.id === this.updateId)) {
        this.update = update;
        this.updateId = null;
      }
      const s = this.sampler.sample();
      this.send({
        t: 'stats',
        ...s,
        listeners: this.relay?.listenerCount ?? 0,
        encoders: this.source.encoders,
        icmp: this.icmp,
        applyLog: apply?.state === 'failed' && apply.log?.length ? apply.log.slice(-20) : undefined,
        problems: [...(apply?.problems ?? []), ...this.source.problems, ...(this.relay?.push.problems ?? []), ...(this.ingest?.problems() ?? []), ...this.fm.problemList].slice(0, 10),
        update: this.update ? { state: this.update.state, message: this.update.message, at: this.update.at } : null,
        revision: this.plan?.revision ?? null,
        ingest: this.ingest?.status() ?? [],
        fm: this.fm.status(),
      });
    })().catch((err) => log.debug('sending stats failed', { err }));
  }

  private async report() {
    const probes = this.prober.drain();
    const ended = this.relay?.drainEnded() ?? [];
    const body: AgentReport = { relays: this.relay?.states() ?? [], clients: this.relay?.reportClients() ?? [], probes, ended };
    try {
      const res = await fetch(`${this.file.server}/api/nodes/agent/report`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Node ${this.file.nodeId}.${this.file.secret}`, 'user-agent': 'Hosted Radio Station node' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`answered ${res.status}`);
      await res.body?.cancel();
    } catch (err) {
      this.prober.restore(probes);
      this.relay?.restoreEnded(ended);
      log.debug('report failed', { err });
    }
  }

  // Listener hooks of the node's Icecast

  private startHooks() {
    return new Promise<void>((resolve) => {
      this.hooks = http.createServer((req, res) => {
        const m = req.url?.match(/^\/hook\/(add|remove|ingest)$/);
        let body = '';
        req.setEncoding('utf8');
        req.on('data', (c: string) => {
          if (body.length < 16_384) body += c;
        });
        req.on('end', () => {
          if (m?.[1] === 'ingest') {
            // Ingest mounts are read by the node itself only (pushes to relays, converted mounts).
            const ip = new URLSearchParams(body).get('ip') ?? '';
            const local = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
            res.writeHead(200, { ...(local ? { 'icecast-auth-user': '1' } : {}), 'content-type': 'text/plain' }).end(local ? 'ok' : 'no');
            return;
          }
          // Listeners are always let in.
          res.writeHead(200, { 'icecast-auth-user': '1', 'content-type': 'text/plain' }).end('ok');
          if (m && req.method === 'POST') this.relay?.hook(m[1] as 'add' | 'remove', new URLSearchParams(body));
        });
      });
      this.hooks.on('error', (err) => {
        log.error('listener hook port is not available', { port: ports.hooks, err });
        resolve();
      });
      this.hooks.listen(ports.hooks, '127.0.0.1', () => resolve());
    });
  }
}
