import net from 'node:net';
import { eq } from 'drizzle-orm';
import { schema } from '../../db/index.js';
import type { AppContext } from '../../lib/context.js';
import { streamingSchema } from '../settings.js';
import { defaultListenPort, nodeSettings, type Node } from './plan.js';

/** What a port is for, shown translated in the panel and in e-mails. */
export type PortService = 'encoderTls' | 'encoderPlain' | 'legacy' | 'sftp' | 'ftp' | 'ftpPassive' | 'listeners' | 'listenersTls' | 'push';

export interface InboundPort {
  service: PortService;
  port: number;
  /** The end of a range (FTP passive ports). */
  to?: number;
  /** Who connects: RHIS Studio and encoders, uploads, listeners or the ingests that push to a relay. */
  for: ('studio' | 'encoders' | 'uploads' | 'listeners' | 'ingests')[];
  /** The station it belongs to (legacy Shoutcast ports). */
  station?: string;
}

/**
 * A station node keeps the default ports of a fresh install: the package from the orchestrator carries stations, not
 * settings (phase 12). Its encoder TLS port needs a certificate of its own.
 */
export const STATION_NODE_STREAMING = streamingSchema.parse({});

/** The address the outside world reaches a node on: its own name, else the address it connects to us from. */
export const externalAddress = (n: Pick<Node, 'config' | 'status'>) => nodeSettings(n).publicHost || n.status.ip || null;

/** Its address on its own network: the one set for the studio, else the first address of its interfaces. */
export const internalAddress = (n: Pick<Node, 'config' | 'status'>) => nodeSettings(n).lanAddress || n.status.addresses?.find((a) => !a.includes(':')) || null;

/**
 * The ports a node needs open (or forwarded) from outside, by its roles (phase 18). The connections to the
 * orchestrator and to the relays are made by the node itself, outwards, so they need nothing.
 */
export async function inboundPorts(ctx: AppContext, node: Node): Promise<InboundPort[]> {
  const c = nodeSettings(node);
  const out: InboundPort[] = [];
  if (node.roles.includes('station')) {
    const s = STATION_NODE_STREAMING;
    const tls = !!c.publicHost && !!node.status.caddy;
    if (tls) out.push({ service: 'encoderTls', port: s.ingestTlsPort, for: ['studio', 'encoders'] });
    if (s.ingestPlainPort) out.push({ service: 'encoderPlain', port: s.ingestPlainPort, for: ['studio', 'encoders'] });
    const stations = await ctx.db.select({ slug: schema.stations.slug, legacyPort: schema.stations.legacyPort }).from(schema.stations).where(eq(schema.stations.nodeId, node.id));
    for (const st of stations) if (st.legacyPort) out.push({ service: 'legacy', port: st.legacyPort, to: st.legacyPort + 1, for: ['encoders'], station: st.slug });
    if (s.sftp.enabled) out.push({ service: 'sftp', port: s.sftp.port, for: ['uploads'] });
    if (s.ftp.enabled) {
      out.push({ service: 'ftp', port: s.ftp.port, for: ['uploads'] });
      out.push({ service: 'ftpPassive', port: s.ftp.passivePortFrom, to: s.ftp.passivePortTo, for: ['uploads'] });
    }
  }
  if (node.roles.includes('source')) {
    if (c.sourceTlsPort) out.push({ service: 'encoderTls', port: c.sourceTlsPort, for: ['studio', 'encoders'] });
    if (c.sourcePlainPort) out.push({ service: 'encoderPlain', port: c.sourcePlainPort, for: ['studio', 'encoders'] });
  }
  if (node.roles.includes('relay')) {
    const port = c.listenPort ?? defaultListenPort(node);
    out.push({ service: 'listeners', port, for: ['listeners'] });
    if (node.status.caddy && c.publicHost) out.push({ service: 'listenersTls', port: 443, for: ['listeners'] });
    if (c.pushPort) out.push({ service: 'push', port: c.pushPort, for: ['ingests'] });
  }
  // One entry per port: a source and a station role can share the encoder ports.
  const seen = new Set<string>();
  return out.filter((p) => {
    const key = `${p.port}-${p.to ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Opens a TCP connection to host:port and closes it again: reachable or not, with the reason. */
export function probePort(host: string, port: number, timeoutMs = 4000): Promise<{ ok: boolean; message: string | null; ms: number | null }> {
  const started = Date.now();
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok: boolean, message: string | null) => {
      socket.destroy();
      resolve({ ok, message, ms: ok ? Date.now() - started : null });
    };
    socket.setTimeout(timeoutMs, () => done(false, 'timeout'));
    socket.once('connect', () => done(true, null));
    socket.once('error', (err: NodeJS.ErrnoException) => done(false, err.code === 'ECONNREFUSED' ? 'refused' : err.code === 'EHOSTUNREACH' || err.code === 'ENETUNREACH' ? 'unreachable' : (err.code ?? err.message)));
  });
}
