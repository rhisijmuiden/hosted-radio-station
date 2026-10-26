import http from 'node:http';
import https from 'node:https';
import { AGENT } from './icecast.js';
import type { AgentReport, NodePlan } from './protocol.js';

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
        Array.from({ length: Math.min(4, queue.length) }, async () => {
          for (let t = queue.shift(); t; t = queue.shift()) {
            const r = await checkStream(t.url);
            this.results.push({ target: t.target, stationId: t.stationId, url: t.url, ...r, at: new Date().toISOString() });
          }
        }),
      );
      // Keep the latest result per target if reports fail for a while.
      if (this.results.length > 400) this.results = this.results.slice(-200);
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
    this.results = [...results, ...this.results].slice(-400);
  }
}
