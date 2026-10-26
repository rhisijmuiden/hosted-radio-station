import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';

/** Keeps the network part of an address: IPv4 /24 (203.0.113.0), IPv6 /48 (2001:db8:1::). */
export function shortenIp(ip: string): string {
  const v4 = ip.replace(/^::ffff:/i, '');
  if (isIP(v4) === 4) return v4.split('.').slice(0, 3).concat('0').join('.');
  if (isIP(ip) === 6) {
    const [head] = ip.split('::');
    const groups = (ip.includes('::') ? head!.split(':').filter(Boolean) : ip.split(':')).slice(0, 3);
    while (groups.length < 3) groups.push('0');
    return `${groups.join(':')}::`;
  }
  return '';
}

export const normalizeIp = (ip: string | null | undefined) => {
  if (!ip) return null;
  const v = ip.trim().replace(/^::ffff:/i, '');
  return isIP(v) ? v : null;
};

/** Same listener (address and player) → same value, without storing the address itself. */
export function listenerHash(secret: string, ip: string | null, userAgent: string | null) {
  if (!ip) return null;
  return createHmac('sha256', `${secret}:listeners`).update(`${ip}|${userAgent ?? ''}`).digest('base64url').slice(0, 22);
}

/** Host name of a referring page, without path or query. */
export function referrerHost(referer: string | null | undefined) {
  if (!referer) return null;
  try {
    return new URL(referer).hostname.replace(/^www\./, '').slice(0, 200) || null;
  } catch {
    return null;
  }
}
