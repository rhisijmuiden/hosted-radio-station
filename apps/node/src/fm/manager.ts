import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { dataPath } from '../config.js';
import { AGENT } from '../icecast.js';
import { log } from '../log.js';
import type { FmPlan, FmStatus } from '../protocol.js';
import { IcyReader } from '../relay.js';
import { MPX_RATE, MpxGenerator, toS32 } from './mpx.js';
import { RdsEncoder } from './rds.js';
import { renderTexts, type FmContext, type FmRendered } from './texts.js';
import { UecpClient } from './uecp.js';

/** 10 ms of MPX per write. */
const CHUNK = MPX_RATE / 100;

/** Playback devices of the node's sound cards (from /proc/asound), for the panel. */
export function soundCards(): { device: string; name: string }[] {
  try {
    const cards = new Map<string, string>();
    for (const line of readFileSync('/proc/asound/cards', 'utf8').split('\n')) {
      const m = line.match(/^\s*(\d+)\s+\[[^\]]*\]:\s*(.+?)\s*$/);
      if (m) cards.set(String(Number(m[1])), m[2]!.split(' - ').pop()!.trim());
    }
    const out: { device: string; name: string }[] = [];
    for (const line of readFileSync('/proc/asound/pcm', 'utf8').split('\n')) {
      const m = line.match(/^(\d+)-(\d+):\s*([^:]*?)\s*:\s*([^:]*?)\s*:(.*)$/);
      if (!m || !/playback/.test(m[5]!)) continue;
      const card = String(Number(m[1]));
      const dev = String(Number(m[2]));
      out.push({ device: `plughw:${card},${dev}`, name: `${cards.get(card) ?? `Card ${card}`} – ${m[3] || m[4]}`.slice(0, 60) });
    }
    // Keep the hello message small.
    return out.slice(0, 8);
  } catch {
    return [];
  }
}

const hasCommand = (cmd: string) => spawnSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }).status === 0;

/** The ffmpeg audio chain before the MPX generator: pre-emphasis, limiter, 15 kHz low-pass, 192 kHz. */
export function audioFilter(a: FmPlan['audio']): string {
  const f: string[] = ['aformat=channel_layouts=stereo', 'aresample=48000'];
  if (a.preemphasis) f.push(`aemphasis=mode=production:type=${a.preemphasis === 75 ? '75fm' : '50fm'}`);
  if (a.limiter) f.push('alimiter=limit=0.95:attack=1:release=40:level=disabled');
  // FM stereo leaves no room above 15 kHz: the pilot sits at 19 kHz.
  f.push("firequalizer=gain='if(lt(f,15000),0,-90)':delay=0.008:accuracy=20");
  f.push(`aresample=${MPX_RATE}`);
  return f.join(',');
}

type Part = 'idle' | 'connecting' | 'connected' | 'error';

/**
 * The FM/MPX role: pulls the station's stream from the main server, decodes it with ffmpeg, makes the MPX signal with
 * RDS and plays it on a 192 kHz sound card or sends it as RTP. Or, without MPX, steers an existing RDS encoder over
 * UECP. Everything restarts by itself; while the stream is away the pilot and RDS stay on air.
 */
export class FmManager {
  private plan: FmPlan | null = null;
  private context: FmContext | null = null;
  private title: string | null = null;
  private rds = new RdsEncoder();
  private gen: MpxGenerator | null = null;
  private uecp: UecpClient | null = null;
  private uecpKey = '';
  private input: http.ClientRequest | null = null;
  private decoder: ChildProcess | null = null;
  private sink: ChildProcess | null = null;
  private sinkKey = '';
  private inputKey = '';
  private inputState: Part = 'idle';
  private inputMessage: string | undefined;
  private outputState: 'off' | 'starting' | 'running' | 'error' = 'off';
  private outputMessage: string | undefined;
  private timers = new Set<NodeJS.Timeout>();
  private psTimer: NodeJS.Timeout | null = null;
  private psIdx = 0;
  private rendered: FmRendered = { ps: ['        '], rt: '', tags: [] };
  private inputRetries = 0;
  private sinkRetries = 0;
  private problems: string[] = [];
  private stopped = false;

  constructor(private readonly nodeId: string) {}

  get active() {
    return !!this.plan;
  }

  apply(plan: FmPlan | null) {
    this.plan = plan;
    this.problems = [];
    if (!plan) return this.stopAll();
    this.stopped = false;
    const r = plan.rds;
    this.rds.set({ pi: r.pi, pty: r.pty, tp: r.tp, ta: r.ta, music: r.music, af: r.af, rtPlus: r.rtPlus, clock: r.clock, timezone: r.timezone, stereo: plan.audio.stereo });
    this.context ??= { station: plan.station.name, dj: null, show: null };
    this.context.station = plan.station.name;

    const wantsMpx = plan.output.kind !== 'none';
    if (wantsMpx && !hasCommand('ffmpeg')) this.problems.push('FM: ffmpeg is not installed. Run install-fm.sh (or install-node.sh --fm) on the node again.');
    if (plan.output.kind === 'soundcard' && !hasCommand('aplay')) this.problems.push('FM: aplay (alsa-utils) is not installed. Run install-fm.sh on the node again.');

    if (wantsMpx) {
      this.gen ??= new MpxGenerator(this.rds);
      this.gen.configure({ stereo: plan.audio.stereo, rds: r.enabled, pilot: plan.audio.pilot, rdsLevel: plan.audio.rdsLevel, gainDb: plan.audio.gainDb, bufferSeconds: plan.audio.bufferSeconds });
    } else {
      this.gen = null;
    }
    this.retext();

    // Output: restart only when it changed.
    const sinkKey = wantsMpx ? JSON.stringify(plan.output) : '';
    if (sinkKey !== this.sinkKey) {
      this.sinkKey = sinkKey;
      this.stopSink();
      if (wantsMpx) this.startSink();
    }
    // Input: the stream (for the audio and for the song titles in it).
    const inputKey = JSON.stringify([plan.url, wantsMpx ? audioFilter(plan.audio) : null]);
    if (inputKey !== this.inputKey) {
      this.inputKey = inputKey;
      this.stopInput();
      if (plan.url) this.startInput();
    }
    const uecpKey = plan.uecp ? JSON.stringify(plan.uecp) : '';
    if (uecpKey !== this.uecpKey) {
      this.uecpKey = uecpKey;
      this.uecp?.stop();
      this.uecp = plan.uecp ? new UecpClient(plan.uecp) : null;
      this.pushUecp();
    }
  }

  /** Live DJ and show from the main server. */
  setContext(ctx: Partial<FmContext>) {
    if (!this.plan) return;
    this.context = { station: this.plan.station.name, dj: ctx.dj ?? null, show: ctx.show ?? null };
    this.retext();
  }

  private retext() {
    if (!this.plan || !this.context) return;
    const next = renderTexts(this.plan.texts, this.context, this.title);
    const changed = JSON.stringify(next) !== JSON.stringify(this.rendered);
    this.rendered = next;
    if (!changed && this.psTimer) return;
    this.psIdx = 0;
    this.rds.set({ ps: next.ps[0]!, rt: next.rt, tags: next.tags });
    if (this.psTimer) clearInterval(this.psTimer);
    this.psTimer = null;
    if (next.ps.length > 1) {
      this.psTimer = setInterval(() => {
        this.psIdx = (this.psIdx + 1) % this.rendered.ps.length;
        this.rds.set({ ps: this.rendered.ps[this.psIdx]! });
        this.pushUecp();
      }, Math.max(1, this.plan.texts.psSeconds) * 1000);
    }
    this.pushUecp();
  }

  private pushUecp() {
    if (!this.uecp || !this.plan) return;
    const d = this.rds.current;
    this.uecp.update({ pi: d.pi, ps: d.ps, rt: d.rt, pty: d.pty, tp: d.tp, ta: d.ta, music: d.music, stereo: d.stereo });
  }

  private later(fn: () => void, ms: number) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
  }

  // Input

  private startInput() {
    const plan = this.plan;
    if (!plan?.url || this.stopped) return;
    const url = plan.url;
    const key = this.inputKey;
    this.inputState = 'connecting';
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.get(url, { headers: { 'user-agent': `${AGENT} ${this.nodeId} fm`, 'icy-metadata': '1' }, timeout: 15_000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return this.inputFailed(`HTTP ${res.statusCode}`, key);
      }
      this.inputState = 'connected';
      this.inputMessage = undefined;
      this.inputRetries = 0;
      const metaint = Number(res.headers['icy-metaint']) || 0;
      const icy = metaint ? new IcyReader(metaint, (t) => this.onTitle(t)) : null;
      const decoder = this.plan?.output.kind !== 'none' ? this.startDecoder() : null;
      res.on('data', (chunk: Buffer) => {
        const audio = icy ? icy.push(chunk) : [chunk];
        if (decoder?.stdin?.writable) for (const a of audio) decoder.stdin.write(a);
      });
      res.once('end', () => this.inputFailed('the stream ended', key));
      res.once('error', (err) => this.inputFailed(err.message, key));
    });
    req.once('timeout', () => req.destroy(new Error('no answer')));
    req.once('error', (err) => this.inputFailed(err.message, key));
    this.input = req;
  }

  private inputFailed(message: string, key: string) {
    if (key !== this.inputKey || this.stopped) return;
    if (this.inputState === 'error' && this.inputMessage === message) return;
    this.inputState = 'error';
    this.inputMessage = message;
    this.stopInput(false);
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.inputRetries++, 5));
    log.warn('FM stream input lost', { message, retryIn: delay });
    this.later(() => key === this.inputKey && this.startInput(), delay);
  }

  private stopInput(clearState = true) {
    this.input?.destroy();
    this.input = null;
    if (this.decoder) {
      this.decoder.removeAllListeners('exit');
      this.decoder.kill('SIGKILL');
      this.decoder = null;
    }
    if (clearState) {
      this.inputState = 'idle';
      this.inputMessage = undefined;
    }
  }

  private onTitle(title: string) {
    const t = title.trim() || null;
    if (t === this.title) return;
    this.title = t;
    log.debug('FM title', { title: t });
    this.retext();
  }

  private startDecoder(): ChildProcess | null {
    if (!this.plan || !this.gen) return null;
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', 'pipe:0', '-vn', '-af', audioFilter(this.plan.audio), '-ac', '2', '-ar', String(MPX_RATE), '-f', 'f32le', 'pipe:1'];
    const p = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.decoder = p;
    let err = '';
    p.stderr!.on('data', (c: Buffer) => (err = (err + c.toString()).slice(-500)));
    p.stdout!.on('data', (c: Buffer) => this.gen?.push(c));
    p.stdin!.on('error', () => undefined);
    p.once('error', (e) => this.inputFailed(`ffmpeg: ${e.message}`, this.inputKey));
    p.once('exit', (code) => {
      if (this.decoder !== p) return;
      this.decoder = null;
      this.inputFailed(`the decoder stopped (${code}): ${err.trim().split('\n').pop() ?? ''}`.trim(), this.inputKey);
    });
    return p;
  }

  // Output

  private startSink() {
    const plan = this.plan;
    if (!plan || !this.gen || this.stopped) return;
    const o = plan.output;
    const key = this.sinkKey;
    let p: ChildProcess;
    if (o.kind === 'soundcard') {
      p = spawn('aplay', ['-q', '-D', o.device || 'default', '-t', 'raw', '-f', 'S32_LE', '-r', String(MPX_RATE), '-c', String(o.channels), '-B', '250000', '-'], { stdio: ['pipe', 'ignore', 'pipe'] });
    } else {
      const target = `rtp://${o.rtpHost.includes(':') ? `[${o.rtpHost}]` : o.rtpHost}:${o.rtpPort}?ttl=${o.rtpTtl}&pkt_size=1240`;
      p = spawn(
        'ffmpeg',
        ['-hide_banner', '-loglevel', 'error', '-nostdin', '-re', '-f', 's32le', '-ar', String(MPX_RATE), '-ac', '1', '-i', 'pipe:0', '-c:a', 'pcm_s24be', '-sdp_file', dataPath('fm.sdp'), '-f', 'rtp', target],
        { stdio: ['pipe', 'ignore', 'pipe'] },
      );
    }
    this.sink = p;
    this.outputState = 'starting';
    let err = '';
    p.stderr!.on('data', (c: Buffer) => (err = (err + c.toString()).slice(-500)));
    p.stdin!.on('error', () => undefined);
    p.once('spawn', () => {
      this.outputState = 'running';
      this.outputMessage = undefined;
      this.pump(p);
      // Count it as stable after a while, so a device that keeps failing waits longer each time.
      this.later(() => this.sink === p && (this.sinkRetries = 0), 30_000);
    });
    p.once('error', (e) => this.sinkFailed(p, key, e.message));
    p.once('exit', (code) => this.sinkFailed(p, key, `${o.kind === 'soundcard' ? 'aplay' : 'ffmpeg'} stopped (${code})${err.trim() ? `: ${err.trim().split('\n').pop()}` : ''}`));
  }

  private sinkFailed(p: ChildProcess, key: string, message: string) {
    if (this.sink !== p) return;
    this.sink = null;
    if (key !== this.sinkKey || this.stopped) return;
    this.outputState = 'error';
    this.outputMessage = message;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.sinkRetries++, 5));
    log.warn('FM output failed', { message, retryIn: delay });
    this.later(() => key === this.sinkKey && !this.sink && this.startSink(), delay);
  }

  /** Writes MPX as fast as the output takes it; the sound card (or ffmpeg -re) sets the pace. */
  private pump(p: ChildProcess) {
    const stdin = p.stdin;
    if (!stdin || this.sink !== p || !this.gen || !this.plan) return;
    const channels = this.plan.output.kind === 'soundcard' ? this.plan.output.channels : 1;
    for (let i = 0; i < 40; i++) {
      if (!stdin.writable) return;
      if (!stdin.write(toS32(this.gen.render(CHUNK), channels))) {
        stdin.once('drain', () => this.pump(p));
        return;
      }
    }
    setImmediate(() => this.pump(p));
  }

  private stopSink() {
    if (!this.sink) return;
    const p = this.sink;
    this.sink = null;
    p.kill('SIGTERM');
    this.outputState = 'off';
    this.outputMessage = undefined;
  }

  private stopAll() {
    this.stopped = true;
    this.stopInput();
    this.stopSink();
    this.uecp?.stop();
    this.uecp = null;
    this.uecpKey = '';
    this.sinkKey = '';
    this.inputKey = '';
    this.gen = null;
    if (this.psTimer) clearInterval(this.psTimer);
    this.psTimer = null;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  stop() {
    this.plan = null;
    this.stopAll();
  }

  get problemList() {
    return this.problems;
  }

  status(): FmStatus | null {
    if (!this.plan) return null;
    return {
      input: this.inputState,
      inputMessage: this.inputMessage?.slice(0, 200),
      title: this.title?.slice(0, 120) ?? null,
      output: this.plan.output.kind === 'none' ? 'off' : this.outputState,
      outputMessage: this.outputMessage?.slice(0, 200),
      uecp: this.uecp ? this.uecp.state : 'off',
      uecpMessage: this.uecp?.message?.slice(0, 200),
      meters: this.gen?.meters() ?? null,
      ps: this.rds.current.ps,
      psFrames: this.rendered.ps,
      rt: this.rendered.rt,
      tags: this.rendered.tags,
      groups: { ...this.rds.sent },
    };
  }
}
