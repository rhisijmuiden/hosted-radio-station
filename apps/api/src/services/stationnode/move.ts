import http from 'node:http';
import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { schema } from '../../db/index.js';
import type { StationNodeMove } from '../../db/schema.js';
import type { AppContext } from '../../lib/context.js';
import { INTERNAL_AGENT, mediaDir } from '../streaming/icecast.js';
import { applyStreams, autodjMount, type Station } from '../streaming/state.js';
import { missingFiles, receiveFile, type FileEntry } from './files.js';
import type { StationTunnels } from './hub.js';
import { nodeRequest, readJson } from './proxy.js';

/**
 * The last step of a move to a station node: the node has the library and says it is ready. From now on it runs the
 * station; this server stops its own Icecast and AutoDJ for it, and the relays take the streams from the node.
 */
export async function finishMoveToNode(ctx: AppContext, s: Station, nodeId: string) {
  await ctx.db
    .update(schema.stations)
    .set({ nodeId, nodeMove: null, nodeRuntime: { updatedAt: new Date().toISOString(), mounts: [], autodj: null, encoders: 0, relays: {}, revision: null, syncedAt: null } })
    .where(eq(schema.stations.id, s.id));
  await applyStreams(ctx, { stationIds: [s.id], by: 'station node' });
}

/** Waits until the station's Icecast here plays `mount` (or, without an AutoDJ, answers at all). */
async function waitOnAir(port: number, mount: string | null, timeoutMs: number) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const status = await new Promise<number>((resolve) => {
      const req = http.get({ host: '127.0.0.1', port, path: mount ?? '/', headers: { 'user-agent': `${INTERNAL_AGENT} warm-up` }, timeout: 2000 }, (res) => {
        res.destroy();
        resolve(res.statusCode ?? 0);
      });
      req.once('timeout', () => req.destroy());
      req.once('error', () => resolve(0));
    });
    if (mount ? status === 200 : status > 0) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function setMove(ctx: AppContext, stationId: string, patch: Partial<StationNodeMove>) {
  const [s] = await ctx.db.select({ move: schema.stations.nodeMove }).from(schema.stations).where(eq(schema.stations.id, stationId));
  if (!s?.move) return false;
  await ctx.db.update(schema.stations).set({ nodeMove: { ...s.move, ...patch } }).where(eq(schema.stations.id, stationId));
  return true;
}

/**
 * Brings a station back from its station node: copies the files the node has and this server misses, asks the node
 * for a last full report of its tables, and then switches over. The node stops the station when it no longer finds
 * it in its package. A failure leaves the station on the node and shows why.
 */
export async function moveToMain(ctx: AppContext, tunnels: StationTunnels, stationId: string, log: FastifyBaseLogger, by = 'system') {
  try {
    const [s] = await ctx.db.select().from(schema.stations).where(eq(schema.stations.id, stationId));
    if (!s?.nodeId || s.nodeMove?.direction !== 'to_main') return;
    const nodeId = s.nodeId;
    const root = mediaDir(ctx, s.id);
    const { files } = await readJson<{ files: FileEntry[] }>(await nodeRequest(tunnels, nodeId, 'GET', `/api/internal/station-node/files/${s.id}`, { timeoutMs: 300_000 }));
    const todo = await missingFiles(root, files);
    const bytes = todo.reduce((n, f) => n + f.size, 0);
    let filesDone = 0;
    let bytesDone = 0;
    await setMove(ctx, s.id, { files: todo.length, bytes, filesDone, bytesDone });
    let reported = Date.now();
    for (const f of todo) {
      const res = await nodeRequest(tunnels, nodeId, 'GET', `/api/internal/station-node/files/${s.id}/file?${new URLSearchParams({ path: f.path })}`, { timeoutMs: 120_000 });
      if (res.status !== 200) {
        res.body.resume();
        throw new Error(`${f.path}: the node answered ${res.status}`);
      }
      await receiveFile(root, f, res.body);
      filesDone++;
      bytesDone += f.size;
      if (Date.now() - reported > 3000) {
        reported = Date.now();
        // The move was cancelled in the meantime.
        if (!(await setMove(ctx, s.id, { filesDone, bytesDone }))) return;
      }
    }
    // The tables of the node as they are now, then the switch.
    await readJson(await nodeRequest(tunnels, nodeId, 'POST', `/api/internal/station-node/flush/${s.id}`, { body: '{}', timeoutMs: 600_000 }));
    const [now] = await ctx.db.select({ move: schema.stations.nodeMove }).from(schema.stations).where(eq(schema.stations.id, s.id));
    if (now?.move?.direction !== 'to_main') return;
    // Make before break: start the station here first and switch over once it is on air, so the relays find it at once.
    if (!(await setMove(ctx, s.id, { warm: true }))) return;
    await applyStreams(ctx, { stationIds: [s.id], by });
    const [warm] = await ctx.db.select().from(schema.stations).where(eq(schema.stations.id, s.id));
    const mounts = await ctx.db.select().from(schema.stationMounts).where(eq(schema.stationMounts.stationId, s.id));
    // Without the system helpers nothing starts the station here (development, tests).
    const on = warm && ctx.config.SYSTEM_HELPERS === '1' ? await waitOnAir(s.icecastPort, autodjMount(warm, mounts)?.path ?? null, 60_000) : true;
    if (!on) log.warn({ station: s.slug }, 'the station did not come on air here in time; switching over anyway');
    await ctx.db.update(schema.stations).set({ nodeId: null, nodeMove: null, nodeRuntime: null }).where(eq(schema.stations.id, s.id));
    await applyStreams(ctx, { stationIds: [s.id], by });
    log.info({ station: s.slug, files: todo.length }, 'station moved back from its station node');
  } catch (err) {
    log.warn({ err, stationId }, 'moving a station back from its station node failed');
    // The station stays on its node: stop what a warm-up started here.
    const warm = await setMove(ctx, stationId, { state: 'failed', warm: false, message: (err as Error).message.slice(0, 300) }).catch(() => false);
    if (warm) await applyStreams(ctx, { stationIds: [stationId], by }).catch(() => undefined);
  }
}
