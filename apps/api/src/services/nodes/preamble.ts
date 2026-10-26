import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * A source node passes every encoder connection on to the ingest gateway of the main server, with one extra line in
 * front of the HTTP request:
 *
 *   HRSNODE 1 <node id> <unix time> <tls|plain> <encoder address> <host or -> <signature>\r\n
 *
 * The signature is an HMAC-SHA256 with the node's secret, so the gateway knows the real address of the encoder and
 * which node it came through. The agent has its own copy of `signPreamble` (apps/node/src/source.ts).
 */
export const PREAMBLE_PREFIX = 'HRSNODE ';
const MAX_SKEW_SECONDS = 300;

export interface Preamble {
  nodeId: string;
  via: 'tls' | 'plain';
  ip: string;
  host: string | null;
}

const payload = (nodeId: string, ts: number, via: string, ip: string, host: string) => `1|${nodeId}|${ts}|${via}|${ip}|${host}`;

export function signPreamble(secret: string, p: Preamble, now = Date.now()) {
  const ts = Math.floor(now / 1000);
  const host = p.host || '-';
  const sig = createHmac('sha256', secret).update(payload(p.nodeId, ts, p.via, p.ip, host)).digest('hex');
  return `${PREAMBLE_PREFIX}1 ${p.nodeId} ${ts} ${p.via} ${p.ip} ${host} ${sig}\r\n`;
}

/** Checks a preamble line (without the line break). Returns null when it is malformed, too old or not signed right. */
export function verifyPreamble(line: string, secretOf: (nodeId: string) => string | null, now = Date.now()): Preamble | null {
  const parts = line.trim().split(' ');
  if (parts.length !== 8 || parts[0] !== 'HRSNODE' || parts[1] !== '1') return null;
  const [, , nodeId, tsRaw, via, ip, host, sig] = parts as [string, string, string, string, string, string, string, string];
  const ts = Number(tsRaw);
  if (!/^[0-9a-f-]{36}$/.test(nodeId) || !Number.isInteger(ts) || Math.abs(now / 1000 - ts) > MAX_SKEW_SECONDS) return null;
  if (via !== 'tls' && via !== 'plain') return null;
  if (!/^[0-9a-fA-F.:]{2,45}$/.test(ip) || !/^[a-z0-9.-]{1,253}$/i.test(host) || !/^[0-9a-f]{64}$/.test(sig)) return null;
  const secret = secretOf(nodeId);
  if (!secret) return null;
  const want = createHmac('sha256', secret).update(payload(nodeId, ts, via, ip, host)).digest();
  const got = Buffer.from(sig, 'hex');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  return { nodeId, via, ip, host: host === '-' ? null : host.toLowerCase() };
}
