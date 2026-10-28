import { promises as dns } from 'node:dns';
import net from 'node:net';
import type { PortCheckResult } from './protocol.js';

/** At most this many ports per check, and this many at a time. */
const MAX_PORTS = 200;
const PARALLEL = 16;

/** Opens a TCP connection to host:port and closes it again: reachable or not, with the reason. */
export function probePort(host: string, port: number, timeoutMs = 4000): Promise<PortCheckResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok: boolean, message: string | null) => {
      socket.destroy();
      resolve({ port, ok, message, ms: ok ? Date.now() - started : null });
    };
    socket.setTimeout(timeoutMs, () => done(false, 'timeout'));
    socket.once('connect', () => done(true, null));
    socket.once('error', (err: NodeJS.ErrnoException) =>
      done(false, err.code === 'ECONNREFUSED' ? 'refused' : err.code === 'EHOSTUNREACH' || err.code === 'ENETUNREACH' ? 'unreachable' : err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN' ? 'dns' : (err.code ?? err.message)),
    );
  });
}

/**
 * A port check for the server (monitoring node, phase 20): the name is looked up once here, as a listener or encoder
 * out there would, and every port is tried on that address.
 */
export async function checkPorts(host: string, ports: number[], timeoutMs = 4000): Promise<{ address: string | null; results: PortCheckResult[] }> {
  const list = [...new Set(ports.filter((p) => Number.isInteger(p) && p > 0 && p < 65536))].slice(0, MAX_PORTS);
  let address: string | null = host;
  if (!net.isIP(host)) {
    try {
      address = (await dns.lookup(host)).address;
    } catch {
      return { address: null, results: list.map((port) => ({ port, ok: false, message: 'dns', ms: null })) };
    }
  }
  const results: PortCheckResult[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(PARALLEL, list.length) }, async () => {
      while (next < list.length) {
        const port = list[next++]!;
        results.push(await probePort(address!, port, timeoutMs));
      }
    }),
  );
  return { address, results: results.sort((a, b) => a.port - b.port) };
}
