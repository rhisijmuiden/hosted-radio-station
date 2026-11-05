import { createHmac, randomInt } from 'node:crypto';
import { and, eq, gt, isNotNull, lt } from 'drizzle-orm';
import { schema } from '../db/index.js';
import type { AppContext } from '../lib/context.js';
import { serves } from './nodes/dedication.js';
import { nodeHost, type Node } from './nodes/plan.js';
import { ingestNodes, stationRouting } from './nodes/routing-rules.js';

/**
 * Reporter mode: reporters on location join a broadcast from a phone (WebRTC, Opus) and RHIS Studio talks with them
 * and, from step 2, puts them on air. The audio goes through a LiveKit server on an ingest node, never through this
 * server (the orchestrator carries no audio); this server only hands out invitation codes and LiveKit access tokens.
 *
 * Every station has one room (station-<id>). RHIS Studio joins it as "studio"; phones join as "rep-<random>".
 */

/** How long an invitation code is valid. */
export const INVITE_MINUTES = 30;
/** How long a phone or RHIS Studio may stay in the room with one token (it joins again with a new one after that). */
const TOKEN_HOURS = 6;
/** The API key every node's LiveKit server knows; the secret differs per node. */
export const LIVEKIT_KEY = 'hrs';
export const STUDIO_IDENTITY = 'studio';

export const roomOf = (stationId: string) => `station-${stationId}`;

/**
 * The LiveKit API secret of a node: derived from the node's own secret, so the node works it out itself and it never
 * travels in a plan. The agent has the same function (apps/node/src/reporters.ts).
 */
export function reporterSecret(nodeSecret: string) {
  return createHmac('sha256', nodeSecret).update('livekit:api').digest('base64url');
}

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');

export interface LivekitGrant {
  room: string;
  roomJoin: true;
  canPublish: boolean;
  canSubscribe: boolean;
  canPublishData: boolean;
  /** Only RHIS Studio: it may mute and remove reporters. */
  roomAdmin?: boolean;
  /** What a participant may publish: a phone only its microphone. */
  canPublishSources?: ('microphone' | 'camera' | 'screen_share' | 'screen_share_audio')[];
}

/** A LiveKit access token (a JWT signed with HS256). */
export function livekitToken(secret: string, opts: { identity: string; name: string; grant: LivekitGrant; metadata?: string; ttlSeconds?: number; now?: number }) {
  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  const body = {
    iss: LIVEKIT_KEY,
    sub: opts.identity,
    name: opts.name,
    nbf: now - 10,
    exp: now + (opts.ttlSeconds ?? TOKEN_HOURS * 3600),
    video: opts.grant,
    ...(opts.metadata ? { metadata: opts.metadata } : {}),
  };
  const unsigned = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(body)}`;
  return `${unsigned}.${createHmac('sha256', secret).update(unsigned).digest('base64url')}`;
}

/** Why there is no reporter server for a station, for RHIS Studio to show. */
export type Unavailable = 'none' | 'offline' | 'starting';

/**
 * The LiveKit server a station's reporters use: the station's own ingest nodes first (in their order), else any other
 * ingest node with reporter mode on that may serve the station. Only nodes whose server runs count.
 */
export async function reporterNode(ctx: AppContext, station: { id: string; tenantId: string; nodeId?: string | null; routing?: Record<string, unknown> | null }): Promise<{ node: Node; url: string } | { node: null; reason: Unavailable }> {
  const rows = await ctx.db.select().from(schema.nodes).where(isNotNull(schema.nodes.pairedAt));
  const candidates = rows.filter((n) => n.roles.includes('source') && n.config?.reporters === true && !!nodeHost(n) && serves(n, station));
  if (!candidates.length) return { node: null, reason: 'none' };
  const order = ingestNodes(stationRouting(station)).map((i) => i.ref);
  const rank = (n: Node) => (order.includes(n.id) ? order.indexOf(n.id) : order.length);
  candidates.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  const running = candidates.find((n) => n.status.online && n.status.reporters?.state === 'running' && n.secret);
  if (running) return { node: running, url: `wss://${nodeHost(running)}` };
  return { node: null, reason: candidates.some((n) => n.status.online) ? 'starting' : 'offline' };
}

/** The LiveKit secret of a node, from its stored (encrypted) secret. */
export const nodeReporterSecret = (ctx: AppContext, node: Pick<Node, 'secret'>) => reporterSecret(node.secret ? ctx.box.decrypt(node.secret) : '');

/** The station's invitation, while it is valid. */
export async function activeInvite(ctx: AppContext, stationId: string) {
  const [row] = await ctx.db
    .select()
    .from(schema.reporterInvites)
    .where(and(eq(schema.reporterInvites.stationId, stationId), gt(schema.reporterInvites.expiresAt, new Date())));
  return row ?? null;
}

/** A new code for the station (the old one stops working): six digits, not in use by another station. */
export async function newInvite(ctx: AppContext, stationId: string, userId: string | null) {
  await ctx.db.delete(schema.reporterInvites).where(lt(schema.reporterInvites.expiresAt, new Date()));
  await ctx.db.delete(schema.reporterInvites).where(eq(schema.reporterInvites.stationId, stationId));
  for (let i = 0; i < 20; i++) {
    const code = String(randomInt(1_000_000)).padStart(6, '0');
    const rows = await ctx.db
      .insert(schema.reporterInvites)
      .values({ stationId, code, createdBy: userId, expiresAt: new Date(Date.now() + INVITE_MINUTES * 60_000) })
      .onConflictDoNothing()
      .returning();
    if (rows[0]) return rows[0];
  }
  throw new Error('No free invitation code');
}

/** Normalises what a reporter typed: digits only. */
export const cleanCode = (code: string) => code.replace(/\D/g, '');
