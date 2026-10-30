import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { schema } from '../../db/index.js';
import type { AppContext } from '../../lib/context.js';
import { HOP_BY_HOP } from './tunnel.js';
import type { StationTunnels } from './hub.js';

/**
 * Panel and public routes whose data belongs to the station node of a station (its library, queues, playlists, hour
 * clocks, schedule, requests, on-demand, live broadcasts). For a station on a node they are answered by the node.
 * The station settings themselves (PUT /autodj, PUT /scheduler and PUT /news) stay here: the node gets them with its package.
 */
const STATION_ROUTE =
  /^\/api\/stations\/([0-9a-f-]{36})\/(autodj(?:\/[^?]*)?|library(?:\/[^?]*)?|playlists(?:\/[^?]*)?|sources(?:\/[^?]*)?|clocks(?:\/[^?]*)?|schedule(?:\/[^?]*)?|scheduler|news(?:\/[^?]*)?|requests(?:\/[^?]*)?|ondemand(?:\/[^?]*)?|live|status|mounts\/[0-9a-f-]{36}\/disconnect)(?:\?.*)?$/;
const PUBLIC_ROUTE = /^\/api\/public\/stations\/([a-z0-9-]{1,48})\/(library|requests|ondemand(?:\/[^?]*)?)(?:\?.*)?$/;
const KEPT_HERE = new Set(['PUT autodj', 'PUT scheduler', 'PUT news']);

/** Headers that tell the node who the caller is; the node only believes them from its own tunnel. */
export const TUNNEL_HEADERS = {
  user: 'x-hrs-tunnel-user',
  keyTenant: 'x-hrs-tunnel-key-tenant',
  readOnly: 'x-hrs-tunnel-read-only',
  scope: 'x-hrs-tunnel-scope',
  /** Requests of this server itself (moves, final sync). */
  system: 'x-hrs-tunnel-system',
} as const;

type Placement = { id: string; nodeId: string | null };

export function stationPlacements(ctx: AppContext) {
  let cache: { at: number; byId: Map<string, Placement>; bySlug: Map<string, Placement> } | null = null;
  return async () => {
    if (!cache || Date.now() - cache.at > 3000) {
      const rows = await ctx.db.select({ id: schema.stations.id, slug: schema.stations.slug, nodeId: schema.stations.nodeId }).from(schema.stations);
      cache = { at: Date.now(), byId: new Map(rows.map((r) => [r.id, r])), bySlug: new Map(rows.map((r) => [r.slug, r])) };
    }
    return cache;
  };
}

/** Which station node should answer this request, or null when this server does. */
export async function nodeFor(placements: ReturnType<typeof stationPlacements>, method: string, url: string): Promise<string | null> {
  let m = url.match(STATION_ROUTE);
  if (m) {
    const sub = m[2]!;
    if (KEPT_HERE.has(`${method} ${sub}`)) return null;
    return (await placements()).byId.get(m[1]!)?.nodeId ?? null;
  }
  m = url.match(PUBLIC_ROUTE);
  if (m) return (await placements()).bySlug.get(m[1]!)?.nodeId ?? null;
  return null;
}

/**
 * Passes requests for stations on a station node through its tunnel, as the signed-in user. While the node is
 * offline, reading still works from the copy on this server; changes are refused until the node is back.
 */
export function registerStationProxy(app: FastifyInstance, tunnels: StationTunnels) {
  const placements = stationPlacements(app.ctx);
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/stations/') && !req.url.startsWith('/api/public/stations/')) return;
    const nodeId = await nodeFor(placements, req.method, req.url);
    if (!nodeId) return;
    const peer = tunnels.peer(nodeId);
    if (!peer) {
      if (req.method === 'GET' || req.method === 'HEAD') return;
      return reply.status(503).send({ error: { code: 'node_offline', message: 'The station node of this station is offline; changes are possible again when it is back online' } });
    }
    return forward(req, reply, peer);
  });
}

async function forward(req: FastifyRequest, reply: FastifyReply, peer: NonNullable<ReturnType<StationTunnels['peer']>>) {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined || HOP_BY_HOP.has(k) || k === 'cookie' || k === 'authorization' || k.startsWith('x-hrs-') || k.startsWith('x-forwarded-')) continue;
    headers[k] = Array.isArray(v) ? v.join(', ') : v;
  }
  headers['x-forwarded-for'] = req.ip;
  headers['x-forwarded-proto'] = req.protocol;
  if (req.auth) {
    headers[TUNNEL_HEADERS.user] = req.auth.user.id;
    if (req.auth.keyTenantId) headers[TUNNEL_HEADERS.keyTenant] = req.auth.keyTenantId;
    if (req.auth.readOnly) headers[TUNNEL_HEADERS.readOnly] = '1';
    headers[TUNNEL_HEADERS.scope] = req.auth.scope;
  }
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  let res;
  try {
    res = await peer.request({ method: req.method, path: req.url, headers }, hasBody ? req.raw : null);
  } catch (err) {
    req.log.warn({ err }, 'station node request failed');
    return reply.status(502).send({ error: { code: 'node_error', message: `The station node did not answer: ${(err as Error).message}` } });
  }
  reply.hijack();
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(res.headers)) if (!HOP_BY_HOP.has(k.toLowerCase())) out[k] = v;
  reply.raw.writeHead(res.status, out);
  await pipeline(res.body, reply.raw).catch(() => reply.raw.destroy());
}

/** A request of this server to a station node, e.g. for files of a station that moves back. Throws when offline. */
export async function nodeRequest(
  tunnels: StationTunnels,
  nodeId: string,
  method: string,
  path: string,
  opts: { body?: string | Readable; contentType?: string; contentLength?: number; timeoutMs?: number } = {},
) {
  const peer = tunnels.peer(nodeId);
  if (!peer) throw new Error('The station node is offline');
  const headers: Record<string, string> = { [TUNNEL_HEADERS.system]: '1' };
  if (opts.body !== undefined) headers['content-type'] = opts.contentType ?? 'application/json';
  if (opts.contentLength !== undefined) headers['content-length'] = String(opts.contentLength);
  return peer.request({ method, path, headers }, opts.body ?? null, { timeoutMs: opts.timeoutMs });
}

/** Reads a whole (JSON) answer of a station node. */
export async function readJson<T>(res: { status: number; body: NodeJS.ReadableStream }): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const c of res.body) chunks.push(Buffer.from(c as Buffer));
  const text = Buffer.concat(chunks).toString('utf8');
  if (res.status >= 400) throw new Error(`The station node answered ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text) as T;
}

export const placementOf = async (ctx: AppContext, stationId: string) =>
  (await ctx.db.select({ nodeId: schema.stations.nodeId }).from(schema.stations).where(eq(schema.stations.id, stationId)))[0]?.nodeId ?? null;
