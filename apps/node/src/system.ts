import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { cpus, hostname, loadavg, networkInterfaces, totalmem, uptime } from 'node:os';
import { soundCards } from './fm/manager.js';

/**
 * What this version can do beyond its protocol version. "studio-ingest" (1.3): on a station node, the station software
 * of this version sends its streams through an ingest node (it is updated together with the agent).
 */
const FEATURES = ['studio-ingest'];

/** Facts the main server shows about the node. */
export function facts(web: 'caddy' | 'direct') {
  let os = 'Linux';
  try {
    os = readFileSync('/etc/os-release', 'utf8').match(/^PRETTY_NAME="?([^"\n]*)"?/m)?.[1] ?? os;
  } catch {
    /* not Linux */
  }
  const addresses = Object.values(networkInterfaces())
    .flat()
    .filter((a) => a && !a.internal && (a.family === 'IPv4' || !a.address.startsWith('fe80')))
    .map((a) => a!.address);
  return {
    hostname: hostname(),
    facts: { cores: cpus().length, memoryMb: Math.round(totalmem() / 1048576), os, caddy: web === 'caddy' && existsSync('/usr/bin/caddy'), addresses, ffmpeg: existsSync('/usr/bin/ffmpeg'), soundcards: soundCards(), features: FEATURES },
  };
}

function cpuTimes() {
  try {
    const line = readFileSync('/proc/stat', 'utf8').split('\n')[0]!;
    const n = line.trim().split(/\s+/).slice(1).map(Number);
    const idle = (n[3] ?? 0) + (n[4] ?? 0);
    return { idle, total: n.reduce((a, b) => a + b, 0) };
  } catch {
    return null;
  }
}

function netBytes() {
  try {
    let rx = 0;
    let tx = 0;
    for (const line of readFileSync('/proc/net/dev', 'utf8').split('\n').slice(2)) {
      const [name, rest] = line.split(':');
      if (!rest || name!.trim() === 'lo') continue;
      const f = rest.trim().split(/\s+/).map(Number);
      rx += f[0] ?? 0;
      tx += f[8] ?? 0;
    }
    return { rx, tx };
  } catch {
    return null;
  }
}

function memoryUsed() {
  try {
    const info = readFileSync('/proc/meminfo', 'utf8');
    const total = Number(info.match(/MemTotal:\s+(\d+)/)?.[1]);
    const avail = Number(info.match(/MemAvailable:\s+(\d+)/)?.[1]);
    return total ? 1 - avail / total : 0;
  } catch {
    return 0;
  }
}

/** CPU, memory, load and traffic since the previous call. */
export class Sampler {
  private cpu = cpuTimes();
  private net = netBytes();
  private at = Date.now();

  sample() {
    const cpu = cpuTimes();
    const net = netBytes();
    const now = Date.now();
    const secs = Math.max(0.5, (now - this.at) / 1000);
    const busy = cpu && this.cpu && cpu.total > this.cpu.total ? 1 - (cpu.idle - this.cpu.idle) / (cpu.total - this.cpu.total) : 0;
    const out = {
      cpu: Math.max(0, Math.min(1, busy)),
      memory: memoryUsed(),
      load: loadavg()[0] ?? 0,
      uptime: Math.round(uptime()),
      rxBps: net && this.net ? Math.max(0, ((net.rx - this.net.rx) * 8) / secs) : 0,
      txBps: net && this.net ? Math.max(0, ((net.tx - this.net.tx) * 8) / secs) : 0,
    };
    this.cpu = cpu;
    this.net = net;
    this.at = now;
    return out;
  }
}

/** Parses the summary of `ping -q`. Exported for tests. */
export function parsePing(out: string): { rttMs: number | null; loss: number } | null {
  const loss = out.match(/([\d.]+)% packet loss/);
  if (!loss) return null;
  const rtt = out.match(/= [\d.]+\/([\d.]+)\/[\d.]+/);
  return { loss: Number(loss[1]) / 100, rttMs: rtt ? Number(rtt[1]) : null };
}

/** ICMP ping to a host (10 packets). Null when ping is missing, not allowed or the host does not answer ICMP at all. */
export function icmpPing(host: string): Promise<{ rttMs: number | null; loss: number } | null> {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn('ping', ['-n', '-q', '-c', '10', '-i', '0.5', '-W', '2', host], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      return resolve(null);
    }
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', () => {
      clearTimeout(timer);
      resolve(parsePing(out));
    });
  });
}

/**
 * The node's public IPv4 address as the internet sees it (phase 19), also behind a router or NAT, so its platform
 * name in DNS points at the right place and the panel shows the real address. Asked of Cloudflare's trace page, with
 * ipify as second source, at most every 15 minutes; a failed lookup keeps the last known address.
 */
let lastPublicIp: { ip: string | null; at: number } = { ip: null, at: 0 };
let lookingUp: Promise<void> | null = null;
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

async function lookupPublicIp(): Promise<string | null> {
  const sources: [string, (body: string) => string | undefined][] = [
    ['https://1.1.1.1/cdn-cgi/trace', (b) => b.match(/^ip=(.+)$/m)?.[1]],
    ['https://api.ipify.org', (b) => b],
  ];
  for (const [url, parse] of sources) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) continue;
      const ip = parse((await res.text()).trim())?.trim();
      if (ip && IPV4.test(ip)) return ip;
    } catch {
      /* try the next source */
    }
  }
  return null;
}

export function publicIp(): string | null {
  if (!lookingUp && Date.now() - lastPublicIp.at > 15 * 60_000) {
    lookingUp = lookupPublicIp()
      .then((ip) => {
        lastPublicIp = { ip: ip ?? lastPublicIp.ip, at: Date.now() };
      })
      .finally(() => (lookingUp = null));
  }
  return lastPublicIp.ip;
}
