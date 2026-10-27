import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { and, asc, eq, gt, sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import { schema } from '../db/index.js';
import type { StationNodeMove } from '../db/schema.js';
import { requireTenantRole } from '../lib/auth.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { okOut } from '../lib/schemas.js';
import { authenticateNode } from '../services/nodes/report.js';
import { mediaDir } from '../services/streaming/icecast.js';
import { applyStreams } from '../services/streaming/state.js';
import { insideRoot, listFiles } from '../services/stationnode/files.js';
import { applyMirror, mirrorSchema } from '../services/stationnode/mirror.js';
import { moveToMain, finishMoveToNode } from '../services/stationnode/move.js';
import { buildPackage } from '../services/stationnode/package.js';
import { NODE_TABLES, nodeTable, rowKey, toWire, type WireRow } from '../services/stationnode/tables.js';
import { assertAudioAllowedHere } from '../services/nodes/orchestrator.js';
import { mayPlace, scopeOf } from '../services/nodes/dedication.js';

const stationParams = z.object({ id: z.uuid() });

/**
 * What a station node talks to (phase 12), next to the node agent's routes under /api/nodes: its package, the copy of
 * the tables it owns, the tunnel, and the library of a station that moves to it. All need `Authorization: Node …`.
 */
export const stationNodeAgentRoutes: FastifyPluginAsyncZod = async (app) => {
  const { ctx } = app;
  // Long polls end when the server stops.
  let closing = false;
  app.addHook('preClose', async () => {
    closing = true;
  });

  async function stationNode(header: string | undefined) {
    const node = await authenticateNode(ctx, header);
    if (!node.roles.includes('station')) throw forbidden('This node has no station role');
    return node;
  }

  /** A station that is moving to this node: the node may read its library from here. */
  async function movingTo(nodeId: string, stationId: string) {
    const [s] = await ctx.db.select().from(schema.stations).where(eq(schema.stations.id, stationId));
    const moving = s?.nodeMove?.direction === 'to_node' && s.nodeMove.nodeId === nodeId;
    // Right after the switch the node takes the latest state once more, until its first full report.
    const justMoved = s?.nodeId === nodeId && !s.nodeRuntime?.syncedAt;
    if (!s || (!moving && !justMoved)) throw notFound('Station');
    return s;
  }

  app.get(
    '/package',
    {
      schema: {
        hide: true,
        querystring: z.object({ rev: z.string().max(40).optional(), wait: z.coerce.number().int().min(0).max(30).default(0) }),
      },
    },
    async (req, reply) => {
      let node = await stationNode(req.headers.authorization);
      let pkg = await buildPackage(ctx, node);
      // Long poll: answer when something changed, or after `wait` seconds with 304.
      const until = Date.now() + req.query.wait * 1000;
      const gone = () => closing || req.raw.socket?.destroyed !== false;
      while (req.query.rev && pkg.revision === req.query.rev && Date.now() < until && !gone()) {
        // Looks again every two seconds; notices a closed connection sooner.
        for (let i = 0; i < 4 && !gone(); i++) await new Promise((r) => setTimeout(r, 500));
        if (gone()) break;
        node = await stationNode(req.headers.authorization);
        pkg = await buildPackage(ctx, node);
      }
      if (req.query.rev && pkg.revision === req.query.rev) return reply.status(304).send();
      return pkg;
    },
  );

  app.post('/mirror', { bodyLimit: 64 * 1024 * 1024, schema: { hide: true, body: mirrorSchema } }, async (req) => {
    const node = await stationNode(req.headers.authorization);
    return applyMirror(ctx, node, req.body);
  });

  app.get(
    '/seed/:id/:table',
    {
      schema: {
        hide: true,
        params: z.object({ id: z.uuid(), table: z.string().max(40) }),
        querystring: z.object({ after: z.string().max(80).default(''), limit: z.coerce.number().int().min(1).max(5000).default(2000) }),
      },
    },
    async (req) => {
      const node = await stationNode(req.headers.authorization);
      const s = await movingTo(node.id, req.params.id);
      const t = nodeTable(req.params.table);
      if (!t) throw notFound('Table');
      const col = (name: string) => (t.table as never as Record<string, never>)[name];
      // Pages in key order: one key column for every table but playlist_items.
      const order = t.pk.map((k) => asc(col(k)));
      const where = t.station
        ? eq(col(t.station), s.id)
        : sql`${schema.playlistItems.playlistId} in (select id from playlists where station_id = ${s.id})`;
      const after = req.query.after
        ? t.pk.length === 1
          ? gt(col(t.pk[0]!), req.query.after)
          : sql`(${schema.playlistItems.playlistId}, ${schema.playlistItems.mediaId}) > (${req.query.after.split('|')[0]}::uuid, ${req.query.after.split('|')[1]}::uuid)`
        : undefined;
      const rows = (await ctx.db
        .select()
        .from(t.table)
        .where(and(where, after))
        .orderBy(...order)
        .limit(req.query.limit)) as WireRow[];
      return { rows: rows.map((r) => toWire(t, r, ctx.box)), next: rows.length === req.query.limit ? rowKey(t, rows.at(-1)!) : null };
    },
  );

  app.get('/files/:id', { schema: { hide: true, params: stationParams } }, async (req) => {
    const node = await stationNode(req.headers.authorization);
    const s = await movingTo(node.id, req.params.id);
    return { files: await listFiles(mediaDir(ctx, s.id)) };
  });

  app.get('/files/:id/file', { schema: { hide: true, params: stationParams, querystring: z.object({ path: z.string().min(1).max(1000) }) } }, async (req, reply) => {
    const node = await stationNode(req.headers.authorization);
    const s = await movingTo(node.id, req.params.id);
    let full: string;
    try {
      full = insideRoot(mediaDir(ctx, s.id), req.query.path);
    } catch {
      throw badRequest('Invalid path');
    }
    const st = await stat(full).catch(() => null);
    if (!st?.isFile()) throw notFound('File');
    return reply.header('content-length', st.size).type('application/octet-stream').send(createReadStream(full));
  });

  app.post(
    '/move/:id',
    {
      schema: {
        hide: true,
        params: stationParams,
        body: z.object({
          state: z.enum(['copying', 'ready', 'failed']),
          files: z.number().int().min(0),
          filesDone: z.number().int().min(0),
          bytes: z.number().min(0),
          bytesDone: z.number().min(0),
          message: z.string().max(500).optional(),
        }),
      },
    },
    async (req) => {
      const node = await stationNode(req.headers.authorization);
      const [s] = await ctx.db.select().from(schema.stations).where(eq(schema.stations.id, req.params.id));
      if (!s?.nodeMove || s.nodeMove.direction !== 'to_node' || s.nodeMove.nodeId !== node.id) throw notFound('Station');
      const b = req.body;
      if (b.state === 'ready') {
        await finishMoveToNode(ctx, s, node.id);
        return { ok: true as const };
      }
      const move: StationNodeMove = { ...s.nodeMove, state: b.state, files: b.files, filesDone: b.filesDone, bytes: b.bytes, bytesDone: b.bytesDone, message: b.message };
      await ctx.db.update(schema.stations).set({ nodeMove: move }).where(eq(schema.stations.id, s.id));
      return { ok: true as const };
    },
  );

  app.get('/tunnel', { websocket: true, schema: { hide: true } }, (socket: WebSocket, req) => {
    // The node signs in with its header on the upgrade request, and again in its first message: a proxy on the way
    // (e.g. Cloudflare) may not pass the header on an upgrade.
    let done = false;
    const accept = (node: { id: string }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.off('message', hello);
      app.stationTunnels.attach(node.id, socket);
    };
    const refuse = (why: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      req.log.warn({ why }, 'station node tunnel refused');
      socket.close(4401, 'unauthorized');
    };
    const timer = setTimeout(() => refuse('no sign-in within 10 seconds'), 10_000);
    const hello = (data: Buffer, isBinary: boolean) => {
      if (isBinary) return;
      let msg: { t?: unknown; auth?: unknown };
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      if (msg?.t !== 'hello' || typeof msg.auth !== 'string') return;
      socket.off('message', hello);
      stationNode(msg.auth).then(accept, (err: Error) => refuse(err.message));
    };
    socket.on('message', hello);
    if (req.headers.authorization) {
      stationNode(req.headers.authorization).then(accept, (err: Error) => req.log.warn({ err: err.message }, 'station node tunnel: sign-in header refused, waiting for its first message'));
    }
  });
};

const moveOut = z
  .object({
    direction: z.enum(['to_node', 'to_main']),
    nodeId: z.uuid(),
    state: z.enum(['copying', 'failed']),
    files: z.number(),
    filesDone: z.number(),
    bytes: z.number(),
    bytesDone: z.number(),
    message: z.string().optional(),
    startedAt: z.string(),
  })
  .nullable();

/** Where a station runs: this server or a station node, and moving it. Mounted under /api/stations. */
export const stationPlacementRoutes: FastifyPluginAsyncZod = async (app) => {
  const { ctx } = app;

  app.put(
    '/:id/placement',
    {
      config: { audit: 'station.placement' },
      schema: {
        tags: ['Stations'],
        summary:
          'Move a station to a station node (nodeId) or back to this server (null). The library is copied first; the station switches over when it is complete. force = switch back at once without copying (when the node is lost).',
        params: stationParams,
        body: z.object({ nodeId: z.uuid().nullable(), force: z.boolean().default(false) }),
        response: { 200: z.object({ nodeId: z.uuid().nullable(), move: moveOut }) },
      },
    },
    async (req) => {
      const [s] = await ctx.db.select().from(schema.stations).where(eq(schema.stations.id, req.params.id));
      if (!s) throw notFound('Station');
      const access = await requireTenantRole(ctx, req, s.tenantId, 'owner');
      Object.assign(req.auditInfo, { tenantId: s.tenantId, targetId: s.id, details: { from: s.nodeId, to: req.body.nodeId, force: req.body.force } });
      const target = req.body.nodeId;
      if (s.nodeMove?.state === 'copying' && !req.body.force) throw conflict('This station is already moving; wait until it is done or cancel the move');
      if (target) {
        const [node] = await ctx.db.select().from(schema.nodes).where(eq(schema.nodes.id, target));
        if (!node || !node.roles.includes('station')) throw badRequest('Choose a node with the station node role');
        if (node.tenantId && node.tenantId !== s.tenantId) throw badRequest('This node belongs to another customer');
        if (!mayPlace(node, s, await ctx.db.select({ id: schema.stations.id, tenantId: schema.stations.tenantId, nodeId: schema.stations.nodeId }).from(schema.stations)))
          throw badRequest('This node is dedicated to another customer or station');
        // Administrators place stations on any node; customers only on their own.
        if (access.role !== 'superadmin' && node.tenantId !== s.tenantId) throw forbidden('Only administrators can place a station on a shared node');
        if (!node.pairedAt) throw badRequest('Pair the node first');
        if (s.nodeId === target) return { nodeId: s.nodeId, move: s.nodeMove };
        if (s.nodeId) throw badRequest('Move the station back to this server first');
        const move: StationNodeMove = { direction: 'to_node', nodeId: target, state: 'copying', files: 0, filesDone: 0, bytes: 0, bytesDone: 0, startedAt: new Date().toISOString() };
        await ctx.db.update(schema.stations).set({ nodeMove: move }).where(eq(schema.stations.id, s.id));
        return { nodeId: s.nodeId, move };
      }
      if (!s.nodeId) {
        // Cancels a move to a node that has not switched over yet.
        if (s.nodeMove) await ctx.db.update(schema.stations).set({ nodeMove: null }).where(eq(schema.stations.id, s.id));
        return { nodeId: null, move: null };
      }
      // Orchestrator only: there is no way back to this server, also not when the node is lost.
      await assertAudioAllowedHere(ctx, 'move the station to another station node instead');
      if (req.body.force) {
        await ctx.db.update(schema.stations).set({ nodeId: null, nodeMove: null, nodeRuntime: null }).where(eq(schema.stations.id, s.id));
        await applyStreams(ctx, { stationIds: [s.id], by: req.auth?.user.email });
        return { nodeId: null, move: null };
      }
      const move: StationNodeMove = { direction: 'to_main', nodeId: s.nodeId, state: 'copying', files: 0, filesDone: 0, bytes: 0, bytesDone: 0, startedAt: new Date().toISOString() };
      await ctx.db.update(schema.stations).set({ nodeMove: move }).where(eq(schema.stations.id, s.id));
      void moveToMain(ctx, app.stationTunnels, s.id, req.log, req.auth?.user.email);
      return { nodeId: s.nodeId, move };
    },
  );

  app.delete(
    '/:id/placement/move',
    { config: { audit: 'station.placement_cancel' }, schema: { tags: ['Stations'], summary: 'Cancel a move between this server and a station node', params: stationParams, response: { 200: okOut } } },
    async (req) => {
      const [s] = await ctx.db.select().from(schema.stations).where(eq(schema.stations.id, req.params.id));
      if (!s) throw notFound('Station');
      await requireTenantRole(ctx, req, s.tenantId, 'owner');
      req.auditInfo.tenantId = s.tenantId;
      await ctx.db.update(schema.stations).set({ nodeMove: null }).where(eq(schema.stations.id, s.id));
      // A move back that already warmed up here: the station stays on its node, so stop it here again.
      if (s.nodeMove?.warm) await applyStreams(ctx, { stationIds: [s.id], by: req.auth?.user.email });
      return { ok: true as const };
    },
  );
};


/** The station node of a customer: where its stations run. Mounted under /api/tenants. */
export const tenantStationNodeRoutes: FastifyPluginAsyncZod = async (app) => {
  const { ctx } = app;

  app.put(
    '/:id/station-node',
    {
      config: { audit: 'tenant.station_node' },
      schema: {
        tags: ['Customers'],
        summary:
          'Link a customer to a station node (or null for this server). New stations of the customer start there; with moveStations its existing stations move too, library included.',
        params: stationParams,
        body: z.object({ nodeId: z.uuid().nullable(), moveStations: z.boolean().default(false) }),
        response: { 200: z.object({ stationNodeId: z.uuid().nullable(), moving: z.number().int(), skipped: z.array(z.string()) }) },
      },
    },
    async (req) => {
      const [tenant] = await ctx.db.select().from(schema.tenants).where(eq(schema.tenants.id, req.params.id));
      if (!tenant) throw notFound('Customer');
      const access = await requireTenantRole(ctx, req, tenant.id, 'owner');
      const target = req.body.nodeId;
      if (target) {
        const [node] = await ctx.db.select().from(schema.nodes).where(eq(schema.nodes.id, target));
        if (!node || !node.roles.includes('station')) throw badRequest('Choose a node with the station node role');
        if (node.tenantId && node.tenantId !== tenant.id) throw badRequest('This node belongs to another customer');
        const all = await ctx.db.select({ id: schema.stations.id, tenantId: schema.stations.tenantId, nodeId: schema.stations.nodeId }).from(schema.stations);
        // A node dedicated to one station takes no other stations of the customer, so it cannot be the customer's node.
        if (scopeOf(node).kind === 'station' || !mayPlace(node, { id: '', tenantId: tenant.id, nodeId: null }, all)) throw badRequest('This node is dedicated to another customer or station');
        if (access.role !== 'superadmin' && node.tenantId !== tenant.id) throw forbidden('Only administrators can link a customer to a shared node');
      } else if (req.body.moveStations) await assertAudioAllowedHere(ctx, 'its stations cannot move back to this server');
      await ctx.db.update(schema.tenants).set({ stationNodeId: target }).where(eq(schema.tenants.id, tenant.id));
      Object.assign(req.auditInfo, { tenantId: tenant.id, targetId: tenant.id, details: { from: tenant.stationNodeId, to: target, moveStations: req.body.moveStations } });
      let moving = 0;
      const skipped: string[] = [];
      if (req.body.moveStations) {
        const stations = await ctx.db.select().from(schema.stations).where(eq(schema.stations.tenantId, tenant.id));
        for (const s of stations) {
          if (s.nodeId === target || s.nodeMove?.state === 'copying') {
            if (s.nodeId !== target) skipped.push(s.slug);
            continue;
          }
          if (target && s.nodeId) {
            // On another node: it comes back here first; move it on afterwards.
            skipped.push(s.slug);
            continue;
          }
          const direction = target ? 'to_node' : 'to_main';
          const move: StationNodeMove = { direction, nodeId: (target ?? s.nodeId)!, state: 'copying', files: 0, filesDone: 0, bytes: 0, bytesDone: 0, startedAt: new Date().toISOString() };
          await ctx.db.update(schema.stations).set({ nodeMove: move }).where(eq(schema.stations.id, s.id));
          if (direction === 'to_main') void moveToMain(ctx, app.stationTunnels, s.id, req.log, req.auth?.user.email);
          moving++;
        }
      }
      return { stationNodeId: target, moving, skipped };
    },
  );
};
