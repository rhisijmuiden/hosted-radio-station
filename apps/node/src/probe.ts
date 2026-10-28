import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { AGENT } from './icecast.js';
import type { AgentReport, NodePlan, ProbeMeasure, ProbeTarget } from './protocol.js';

type Result = AgentReport['probes'][number];

/** Checks one stream: it must answer 200 and deliver some audio within a few seconds. */
export function checkStream(url: string, timeoutMs = 8000): Promise<{ ok: boolean; httpStatus: number | null; ttfbMs: number | null; message?: string }> {
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    let bytes = 0;
    let ttfb: number | null = null;
    let status: number | null = null;
    const done = (ok: boolean, message?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      resolve({ ok, httpStatus: status, ttfbMs: ttfb, message });
    };
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.get(url, { headers: { 'user-agent': `${AGENT} probe`, 'icy-metadata': '0' } }, (res) => {
      status = res.statusCode ?? null;
      if (status !== 200) {
        res.resume();
        return done(false, `HTTP ${status}`);
      }
      res.on('data', (chunk: Buffer) => {
        ttfb ??= Date.now() - started;
        bytes += chunk.length;
        if (bytes >= 8192) done(true);
      });
      res.on('end', () => done(bytes > 0, bytes > 0 ? undefined : 'No audio'));
    });
    req.on('error', (err) => done(false, (err as NodeJS.ErrnoException).code ?? err.message));
    const timer = setTimeout(() => done(bytes > 0, bytes > 0 ? undefined : 'Timeout'), timeoutMs);
  });
}

/** Quieter than this over the whole check counts as silence (dBFS). */
export const SILENCE_DB = -50;

/** Reads "StreamTitle='…';" from an ICY metadata block. */
export function icyTitle(meta: string) {
  const m = /StreamTitle='(.*?)';/s.exec(meta);
  return m ? m[1]!.trim() || null : null;
}

/** Splits an ICY stream into audio and metadata: every `metaint` audio bytes come a length byte and the metadata. */
export class IcyReader {
  private left: number;
  private metaLeft = -1;
  private meta: Buffer[] = [];
  title: string | null = null;

  constructor(private readonly metaint: number) {
    this.left = metaint;
  }

  /** The audio bytes of a chunk; titles found on the way are kept. */
  push(chunk: Buffer): Buffer {
    if (!this.metaint) return chunk;
    const audio: Buffer[] = [];
    let i = 0;
    while (i < chunk.length) {
      if (this.metaLeft > 0) {
        const n = Math.min(this.metaLeft, chunk.length - i);
        this.meta.push(chunk.subarray(i, i + n));
        this.metaLeft -= n;
        i += n;
        if (this.metaLeft === 0) {
          const t = icyTitle(Buffer.concat(this.meta).toString('utf8'));
          if (t) this.title = t;
          this.meta = [];
          this.metaLeft = -1;
          this.left = this.metaint;
        }
      } else if (this.left === 0) {
        this.metaLeft = chunk[i]! * 16;
        i++;
        if (this.metaLeft === 0) {
          this.metaLeft = -1;
          this.left = this.metaint;
        }
      } else {
        const n = Math.min(this.left, chunk.length - i);
        audio.push(chunk.subarray(i, i + n));
        this.left -= n;
        i += n;
      }
    }
    return Buffer.concat(audio);
  }
}

/** The loudest moment of some audio, in dBFS, through ffmpeg's volumedetect. Null when ffmpeg is missing or fails. */
function measureLevel(): { write: (b: Buffer) => void; done: () => Promise<number | null> } {
  if (!existsSync('/usr/bin/ffmpeg')) return { write: () => undefined, done: async () => null };
  const child = spawn('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'info', '-i', 'pipe:0', '-af', 'volumedetect', '-f', 'null', '-'], { stdio: ['pipe', 'ignore', 'pipe'] });
  let err = '';
  child.stderr.on('data', (d: Buffer) => {
    err = (err + d.toString('utf8')).slice(-4000);
  });
  child.stdin.on('error', () => undefined);
  const exited = new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    child.on('error', () => resolve(null));
    child.on('close', () => {
      clearTimeout(timer);
      const m = /max_volume:\s*(-?[\d.]+|-inf) dB/.exec(err);
      resolve(m ? (m[1] === '-inf' ? -120 : Number(m[1])) : null);
    });
  });
  return {
    write: (b) => {
      if (b.length && !child.stdin.destroyed) child.stdin.write(b);
    },
    done: () => {
      child.stdin.end();
      return exited;
    },
  };
}

/**
 * A deep check (monitoring node, phase 20): listens for some seconds like a player, and measures the bitrate, the
 * format, the title in the stream and how loud it is (to find a stream that plays silence).
 */
export function checkStreamDeep(url: string, seconds: number, timeoutMs = 8000): Promise<{ ok: boolean; httpStatus: number | null; ttfbMs: number | null; message?: string } & ProbeMeasure> {
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    let status: number | null = null;
    let ttfb: number | null = null;
    let contentType: string | null = null;
    let reader: IcyReader | null = null;
    let level: ReturnType<typeof measureLevel> | null = null;
    let bytes = 0;
    let firstAt = 0;
    let burstUntil = 0;
    let timer: NodeJS.Timeout;
    const finish = async (ok: boolean, message?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      const levelDb = level ? await level.done() : null;
      const span = firstAt ? (Date.now() - firstAt) / 1000 : 0;
      const bitrateKbps = span >= 2 ? Math.round((bytes * 8) / span / 1000) : null;
      const silent = ok && levelDb !== null ? levelDb < SILENCE_DB : null;
      resolve({ ok, httpStatus: status, ttfbMs: ttfb, message: silent ? `Silence (${levelDb} dB)` : message, bitrateKbps, contentType, title: reader?.title ?? null, levelDb, silent });
    };
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.get(url, { headers: { 'user-agent': `${AGENT} probe`, 'icy-metadata': '1' } }, (res) => {
      status = res.statusCode ?? null;
      if (status !== 200) {
        res.resume();
        return void finish(false, `HTTP ${status}`);
      }
      contentType = String(res.headers['content-type'] ?? '').split(';')[0]!.trim().slice(0, 60) || null;
      reader = new IcyReader(Number(res.headers['icy-metaint']) || 0);
      level = measureLevel();
      res.on('data', (chunk: Buffer) => {
        const audio = reader!.push(chunk);
        if (!audio.length) return;
        const now = Date.now();
        if (ttfb === null) {
          ttfb = now - started;
          burstUntil = now + 1500;
          clearTimeout(timer);
          timer = setTimeout(() => void finish(true), seconds * 1000);
        } else if (now >= burstUntil) {
          // The server sends a burst of audio on connect; the bitrate is measured from the steady flow after it.
          firstAt ||= now;
          bytes += audio.length;
        }
        level!.write(audio);
      });
      res.on('end', () => void finish(ttfb !== null, ttfb !== null ? 'Stream ended' : 'No audio'));
    });
    req.on('error', (err) => void finish(false, (err as NodeJS.ErrnoException).code ?? err.message));
    timer = setTimeout(() => void finish(false, 'Timeout'), timeoutMs);
  });
}

const check = (t: ProbeTarget) => (t.deep ? checkStreamDeep(t.url, Math.min(30, Math.max(3, t.deep.seconds))) : checkStream(t.url));

/** Remote probes: checks the streams in the plan every interval and keeps the results until the next report. */
export class Prober {
  private plan: NodePlan['probes'] = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private results: Result[] = [];

  apply(plan: NodePlan['probes']) {
    const changed = JSON.stringify(plan) !== JSON.stringify(this.plan);
    this.plan = plan;
    if (!changed) return;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (!plan?.targets.length) return;
    this.timer = setInterval(() => void this.round(), plan.intervalSeconds * 1000);
    setTimeout(() => void this.round(), 5000);
  }

  stop() {
    this.apply(null);
  }

  private async round() {
    const plan = this.plan;
    if (!plan || this.running) return;
    this.running = true;
    try {
      const queue = [...plan.targets];
      await Promise.all(
        // Deep checks listen for seconds each (a monitoring node checks every stream): more of them at a time.
        Array.from({ length: Math.min(plan.targets.some((t) => t.deep) ? 8 : 4, queue.length) }, async () => {
          for (let t = queue.shift(); t; t = queue.shift()) {
            const r = await check(t);
            this.results.push({ target: t.target, stationId: t.stationId, url: t.url, ...r, at: new Date().toISOString() });
          }
        }),
      );
      // Keep the latest result per target if reports fail for a while.
      if (this.results.length > 2000) this.results = this.results.slice(-1000);
    } finally {
      this.running = false;
    }
  }

  /** The results since the last report. */
  drain(): Result[] {
    const out = this.results;
    this.results = [];
    return out;
  }

  /** Puts results back when the report could not be sent. */
  restore(results: Result[]) {
    this.results = [...results, ...this.results].slice(-2000);
  }
}
