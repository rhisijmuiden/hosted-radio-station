import { createHash, createHmac } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dataPath, writeAtomic } from './config.js';
import type { ReporterPlan, ReporterStatus } from './protocol.js';

/**
 * Reporter mode: the LiveKit server of an ingest node, which phones of reporters on location and RHIS Studio join
 * (WebRTC). The agent writes its configuration; the root helper (hrs-node-apply) installs LiveKit, runs it as the
 * service hrs-node-livekit and lets the node's web server pass /rtc and /twirp on to it.
 */

/** Where the root helper installs LiveKit. */
export const LIVEKIT_BIN = process.env.HRS_NODE_LIVEKIT_BIN ?? '/usr/local/bin/livekit-server';
export const livekitConfigPath = () => dataPath('livekit', 'livekit.yaml');

/** The API secret of this node's LiveKit server; the main server works out the same from the node's secret. */
export const reporterSecret = (nodeSecret: string) => createHmac('sha256', nodeSecret).update('livekit:api').digest('base64url');

/** LiveKit's configuration for a plan. Only safe values end up in it: numbers, an IP address and our own secret. */
export function renderLivekitConfig(plan: ReporterPlan, secret: string) {
  const ip = plan.publicIp && /^[0-9a-fA-F.:]+$/.test(plan.publicIp) ? plan.publicIp : null;
  return [
    '# Managed by the Hosted Radio Station node agent (reporter mode). Manual changes are overwritten.',
    `port: ${Number(plan.signalPort)}`,
    // The web socket is only reached through the node's web server (HTTPS); the audio ports are public.
    'bind_addresses: ["127.0.0.1"]',
    'rtc:',
    `  tcp_port: ${Number(plan.rtcPort)}`,
    `  udp_port: ${Number(plan.rtcPort)}`,
    ip ? `  node_ip: "${ip}"` : '  use_external_ip: true',
    'keys:',
    `  hrs: "${secret}"`,
    'room:',
    // A room without anyone in it closes after five minutes; it opens again with the next one to join.
    '  empty_timeout: 300',
    '  departure_timeout: 20',
    'logging:',
    '  level: info',
    '',
  ].join('\n');
}

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');

/** A short-lived token for LiveKit's own API, to count the rooms and the people in them. */
function adminToken(secret: string) {
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ iss: 'hrs', sub: 'hrs-node', nbf: now - 10, exp: now + 60, video: { roomList: true } })}`;
  return `${unsigned}.${createHmac('sha256', secret).update(unsigned).digest('base64url')}`;
}

export class ReporterManager {
  private plan: ReporterPlan | null = null;
  private secret = '';
  private last: ReporterStatus | null = null;

  constructor(private readonly nodeSecret: () => string) {}

  /** Writes LiveKit's configuration; returns what the root helper needs (null = no reporter server on this node). */
  async apply(plan: ReporterPlan | null): Promise<{ signalPort: number; rtcPort: number; config: string } | null> {
    this.plan = plan;
    if (!plan) {
      this.last = null;
      return null;
    }
    this.secret = reporterSecret(this.nodeSecret());
    const body = renderLivekitConfig(plan, this.secret);
    await writeAtomic(livekitConfigPath(), body, 0o640);
    // The root helper restarts LiveKit when this changes.
    return { signalPort: plan.signalPort, rtcPort: plan.rtcPort, config: createHash('sha256').update(body).digest('hex').slice(0, 16) };
  }

  /** What LiveKit does, for the stats: it answers "OK" on its own port when it runs. */
  async status(): Promise<ReporterStatus | null> {
    const plan = this.plan;
    if (!plan) return null;
    if (!existsSync(LIVEKIT_BIN)) return (this.last = { state: 'installing', message: 'Installing LiveKit' });
    const base = `http://127.0.0.1:${plan.signalPort}`;
    try {
      const res = await fetch(`${base}/`, { signal: AbortSignal.timeout(2000) });
      if (!res.ok) return (this.last = { state: 'error', message: `LiveKit answers ${res.status}` });
    } catch {
      // Just after a change it takes a moment to come up.
      return (this.last = { state: this.last?.state === 'running' || this.last?.state === 'error' ? 'error' : 'starting', message: 'LiveKit does not answer' });
    }
    let rooms = 0;
    let participants = 0;
    try {
      const res = await fetch(`${base}/twirp/livekit.RoomService/ListRooms`, {
        method: 'POST',
        headers: { authorization: `Bearer ${adminToken(this.secret)}`, 'content-type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) {
        const list = ((await res.json()) as { rooms?: { num_participants?: number }[] }).rooms ?? [];
        rooms = list.filter((r) => (r.num_participants ?? 0) > 0).length;
        participants = list.reduce((a, r) => a + (r.num_participants ?? 0), 0);
      }
    } catch {
      /* the count is extra */
    }
    return (this.last = { state: 'running', rooms, participants });
  }

  get problems(): string[] {
    return this.last?.state === 'error' ? [`Reporter server: ${this.last.message ?? 'not running'}`] : [];
  }
}
