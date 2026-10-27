import net from 'node:net';
import type { FastifyRequest } from 'fastify';

/** Cloudflare's proxy (edge) ranges. A name that resolves here has the orange cloud on; a client from here came through the proxy. */
const CLOUDFLARE_V4 = ['173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22'];
const v4num = (ip: string) => ip.split('.').reduce((n, p) => n * 256 + Number(p), 0);
export function isCloudflareAddress(ip: string) {
  if (ip.includes(':')) return /^(2400:cb00|2606:4700|2803:f800|2405:b500|2405:8100|2a06:98c0|2a06:98c1|2c0f:f248):/i.test(ip);
  const n = v4num(ip);
  return CLOUDFLARE_V4.some((c) => {
    const [net, bits] = c.split('/') as [string, string];
    const size = 2 ** (32 - Number(bits));
    const start = v4num(net);
    return n >= start && n < start + size;
  });
}

/**
 * The real address of a client. A node or browser that reaches this server through the Cloudflare proxy arrives from
 * a Cloudflare edge address; Cloudflare puts the real one in CF-Connecting-IP. That header is only believed when the
 * request really comes from Cloudflare, so nobody else can choose their address with it.
 */
export function clientIp(req: Pick<FastifyRequest, 'ip' | 'headers'>): string | null {
  const ip = req.ip ?? null;
  if (!ip || !isCloudflareAddress(ip.replace(/^::ffff:/, ''))) return ip;
  const real = req.headers['cf-connecting-ip'];
  const value = (Array.isArray(real) ? real[0] : real)?.trim();
  return value && net.isIP(value) ? value : ip;
}
