import { createHash } from 'node:crypto';
import type { AppContext } from '../../lib/context.js';
import { getSetting } from '../settings.js';
import { domainTargets } from './records.js';

/**
 * Cloudflare DNS as it stands: the settings, the platform domain records go under, and whether records are written
 * (mode "on" with a token and a domain).
 */
export async function dnsConfig(ctx: AppContext) {
  const [s, proxy] = await Promise.all([getSetting(ctx, 'cloudflare'), getSetting(ctx, 'proxy')]);
  const base = (s.domain || proxy.domain || '').replace(/\.$/, '');
  return { s, base, active: s.mode === 'on' && !!base && !!s.apiToken };
}

/**
 * Short id of this installation, part of every record comment, so two installations in one zone (a test server next
 * to production) never touch each other's records.
 */
export const installId = (ctx: AppContext) => createHash('sha256').update(`hrs-dns:${ctx.config.APP_SECRET}`).digest('hex').slice(0, 8);

/** The targets of a customer domain, when Cloudflare DNS is on and the domain has its label. */
export async function targetsOf(ctx: AppContext, label: string | null) {
  if (!label) return null;
  const { s, base, active } = await dnsConfig(ctx);
  if (!active || !s.customerTargets) return null;
  return domainTargets(label, base, s);
}
