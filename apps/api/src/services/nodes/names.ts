import { schema } from '../../db/index.js';
import type { AppContext } from '../../lib/context.js';
import { conflict } from '../../lib/errors.js';
import { getSetting, type OrchestratorSettings } from '../settings.js';
import { platformHost } from '../streaming/state.js';

/** The names of this server and of its own roles, as shown everywhere instead of "This server" (phase 18). */
export interface ServerNames {
  orchestrator: string;
  ingest: string;
  relay: string;
  /** The name of this server when none is set: the first part of its host name. */
  defaults: { orchestrator: string; ingest: string; relay: string };
  /** Host name of this server. */
  host: string;
}

/** "onlineradio.rhis.nl" → "onlineradio"; an IP address stays whole. */
export function hostLabel(host: string) {
  if (/^[\d.]+$/.test(host) || host.includes(':')) return host;
  return host.split('.')[0] || host;
}

export function namesFrom(o: OrchestratorSettings, host: string): ServerNames {
  const base = hostLabel(host) || 'orchestrator';
  const orchestrator = o.name || base;
  const defaults = { orchestrator: base, ingest: `${orchestrator} · ingest`, relay: `${orchestrator} · relay` };
  return { orchestrator, ingest: o.ingestName || defaults.ingest, relay: o.relayName || defaults.relay, defaults, host };
}

export async function serverNames(ctx: AppContext): Promise<ServerNames> {
  const [o, host] = await Promise.all([getSetting(ctx, 'orchestrator'), platformHost(ctx)]);
  return namesFrom(o, host);
}

/** Orchestrator only (phase 18): this server carries no audio at all. */
export async function orchestratorOnly(ctx: AppContext) {
  return (await getSetting(ctx, 'orchestrator')).only;
}

/** Names compare without case and surrounding spaces. */
export const nameKey = (name: string) => name.trim().toLowerCase();

/**
 * Refuses a node name that another node or this server (or one of its roles) already has: one name per server, so it
 * can also become its DNS record later.
 */
export async function assertFreeName(ctx: AppContext, name: string, exceptNodeId?: string) {
  const key = nameKey(name);
  const names = await serverNames(ctx);
  if ([names.orchestrator, names.ingest, names.relay].some((n) => nameKey(n) === key)) throw conflict('This server already has that name');
  const rows = await ctx.db.select({ id: schema.nodes.id, name: schema.nodes.name }).from(schema.nodes);
  if (rows.some((r) => r.id !== exceptNodeId && nameKey(r.name) === key)) throw conflict('Another node already has that name');
}
