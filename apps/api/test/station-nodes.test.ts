import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { schema } from '../src/db/index.js';
import { mediaDir } from '../src/services/streaming/icecast.js';
import { login, setup } from './helpers.js';

const NODE_DB = process.env.TEST_NODE_DATABASE_URL ?? 'postgres://hosted_radio:dev@localhost/hosted_radio_node_test';
const NODE2_DB = process.env.TEST_NODE2_DATABASE_URL ?? 'postgres://hosted_radio:dev@localhost/hosted_radio_node2_test';

let main: Awaited<ReturnType<typeof setup>>;
let node: Awaited<ReturnType<typeof setup>>;
/** A second station node, for a move straight from one node to another. */
let node2: Awaited<ReturnType<typeof setup>>;
let node2Id: string;
let admin: { cookie: string };
let owner: { cookie: string };
let tenantId: string;
let stationId: string;
let nodeId: string;
let mainBase: string;
let nodeSecret: string;

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => resolve(port));
    });
  });

async function until<T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 40_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

const mainStation = async () => (await main.db.select().from(schema.stations).where(eq(schema.stations.id, stationId)))[0]!;

beforeAll(async () => {
  main = await setup();
  admin = await login(main.app, 'admin@example.com', 'admin-password');
  const res = await main.app.inject({
    method: 'POST',
    url: '/api/tenants',
    headers: admin,
    payload: {
      name: 'Studio Klant',
      slug: 'studio',
      plan: 'station',
      limits: { maxStations: 2, maxListeners: 100, maxBitrateKbps: 192, storageQuotaMb: 100, maxNodes: 1 },
      owner: { email: 'owner@studio.nl', name: 'Owner', password: 'owner-password' },
    },
  });
  tenantId = res.json().id;
  owner = await login(main.app, 'owner@studio.nl', 'owner-password');
  const st = await main.app.inject({ method: 'POST', url: '/api/stations', headers: owner, payload: { tenantId, name: 'Studio FM', slug: 'studio-fm', edition: 'station' } });
  expect(st.statusCode).toBe(201);
  stationId = st.json().id;
  // A song in the library of the station on the main server.
  mkdirSync(join(mediaDir(main.ctx, stationId), 'music'), { recursive: true });
  writeFileSync(join(mediaDir(main.ctx, stationId), 'music', 'song.mp3'), Buffer.alloc(300_000, 7));

  await main.app.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${(main.app.server.address() as AddressInfo).port}`;
  mainBase = base;

  const created = await main.app.inject({ method: 'POST', url: '/api/nodes', headers: admin, payload: { name: 'Studio node', roles: ['station'] } });
  expect(created.statusCode).toBe(201);
  nodeId = created.json().node.id;
  const pairing = created.json().pairing.code.toLowerCase().replace(/-/g, '');
  const paired = await main.app.inject({ method: 'POST', url: '/api/nodes/pair', payload: { code: pairing, hostname: 'studio-node' } });
  expect(paired.statusCode).toBe(200);
  const dir = mkdtempSync(join(tmpdir(), 'hrs-station-node-'));
  const linkFile = join(dir, 'station-node.json');
  nodeSecret = paired.json().secret;
  writeFileSync(linkFile, JSON.stringify({ server: base, nodeId, secret: nodeSecret }));

  // The station node: a second installation with its own database, linked to the main server.
  const port = await freePort();
  node = await setup({ DATABASE_URL: NODE_DB, STATION_NODE: linkFile, PORT: String(port) });
  await node.app.listen({ port, host: '127.0.0.1' });
  await node.app.stationNode!.start();

  const created2 = await main.app.inject({ method: 'POST', url: '/api/nodes', headers: admin, payload: { name: 'Own node', roles: ['station'] } });
  node2Id = created2.json().node.id;
  const paired2 = await main.app.inject({ method: 'POST', url: '/api/nodes/pair', payload: { code: created2.json().pairing.code.toLowerCase().replace(/-/g, ''), hostname: 'own-node' } });
  expect(paired2.statusCode).toBe(200);
  const linkFile2 = join(dir, 'station-node-2.json');
  writeFileSync(linkFile2, JSON.stringify({ server: base, nodeId: node2Id, secret: paired2.json().secret }));
  const port2 = await freePort();
  node2 = await setup({ DATABASE_URL: NODE2_DB, STATION_NODE: linkFile2, PORT: String(port2) });
  await node2.app.listen({ port: port2, host: '127.0.0.1' });
  await node2.app.stationNode!.start();
}, 60_000);

afterAll(async () => {
  node?.app.stationNode?.stop();
  node2?.app.stationNode?.stop();
  await node?.close();
  await node2?.close();
  // Keep-alive connections of the node's requests would hold the server open.
  main?.app.server.closeAllConnections();
  await main?.close();
}, 60_000);

describe('station nodes', () => {
  it('moves a station with its library to the node, which then runs it', async () => {
    // A past broadcast that came in through a node: that node only exists on the main server.
    const [session] = await main.db
      .insert(schema.liveSessions)
      .values({ stationId, mountPath: '/live', accountName: 'dj1', via: 'node', nodeId, endedAt: new Date() })
      .returning();
    const res = await main.app.inject({ method: 'PUT', url: `/api/stations/${stationId}/placement`, headers: admin, payload: { nodeId } });
    expect(res.statusCode).toBe(200);
    expect(res.json().move.direction).toBe('to_node');

    await until('the switch-over', async () => (await mainStation()).nodeId === nodeId);
    // The node took the library, the tables and the settings.
    const file = join(mediaDir(node.ctx, stationId), 'music', 'song.mp3');
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file).length).toBe(300_000);
    const [local] = await until('the station on the node', async () => {
      const rows = await node.db.select().from(schema.stations).where(eq(schema.stations.id, stationId));
      return rows[0]?.enabled ? rows : null;
    });
    expect(local!.slug).toBe('studio-fm');
    const playlists = await node.db.select().from(schema.playlists).where(eq(schema.playlists.stationId, stationId));
    expect(playlists.map((p) => p.name)).toEqual(['All music']);
    // Users came along without passwords.
    const users = await node.db.select().from(schema.users);
    expect(users.map((u) => u.email).sort()).toEqual(['admin@example.com', 'owner@studio.nl']);
    expect(users.every((u) => u.passwordHash === null)).toBe(true);
    // The first full report from the node.
    await until('the first full report', async () => (await mainStation()).nodeRuntime?.syncedAt);
    // The broadcast came along without its node, and the main server kept its own.
    const [onNode] = await node.db.select().from(schema.liveSessions).where(eq(schema.liveSessions.id, session!.id));
    expect(onNode?.nodeId).toBeNull();
    const [onMain] = await main.db.select().from(schema.liveSessions).where(eq(schema.liveSessions.id, session!.id));
    expect(onMain?.nodeId).toBe(nodeId);
  }, 90_000);

  it('passes panel requests through the tunnel and mirrors the changes back', async () => {
    const created = await main.app.inject({
      method: 'POST',
      url: `/api/stations/${stationId}/playlists`,
      headers: owner,
      payload: { name: 'Night', queue: 'q1', weight: 3, order: 'shuffle', folders: [] },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id;
    // Made on the node, not here...
    expect((await node.db.select().from(schema.playlists).where(eq(schema.playlists.id, id))).length).toBe(1);
    // ...and back here within a few seconds.
    await until('the mirror', async () => (await main.db.select().from(schema.playlists).where(eq(schema.playlists.id, id))).length === 1);
    const list = await main.app.inject({ method: 'GET', url: `/api/stations/${stationId}/playlists`, headers: owner });
    expect(list.statusCode).toBe(200);
    expect(list.json().map((p: { name: string }) => p.name).sort()).toEqual(['All music', 'Night']);
    // The node refuses identities that did not come through its tunnel.
    const direct = await node.app.inject({ method: 'GET', url: `/api/stations/${stationId}/playlists`, headers: { 'x-hrs-tunnel': 'guess', 'x-hrs-tunnel-user': main.admin.id } });
    expect(direct.statusCode).toBe(401);
  }, 60_000);

  it('refuses uploads in parts for a station node too old for them, with a clear error', async () => {
    const begin = () =>
      main.app.inject({ method: 'POST', url: `/api/stations/${stationId}/library/uploads`, headers: owner, payload: { folder: 'music', path: 'set.mp3', size: 1000 } });
    const [row] = await main.db.select({ status: schema.nodes.status }).from(schema.nodes).where(eq(schema.nodes.id, nodeId));
    // An older node reports its features, without uploads in parts.
    await main.db.update(schema.nodes).set({ status: { ...row!.status, features: ['studio-ingest', 'firewall'] } }).where(eq(schema.nodes.id, nodeId));
    const old = await begin();
    expect(old.statusCode).toBe(409);
    expect(old.json().error.code).toBe('node_outdated');
    // A version that has them goes through to the node.
    await main.db.update(schema.nodes).set({ status: { ...row!.status, features: ['studio-ingest', 'library-uploads'] } }).where(eq(schema.nodes.id, nodeId));
    const ok = await begin();
    expect(ok.statusCode).toBe(200);
    expect(ok.json().offset).toBe(0);
    await main.db.update(schema.nodes).set({ status: row!.status }).where(eq(schema.nodes.id, nodeId));
  });

  it('keeps settings central and refuses to delete the node while it runs stations', async () => {
    const put = await main.app.inject({ method: 'PATCH', url: `/api/stations/${stationId}`, headers: owner, payload: { description: 'Live from the studio' } });
    expect(put.statusCode).toBe(200);
    await until('the new package', async () => (await node.db.select().from(schema.stations).where(eq(schema.stations.id, stationId)))[0]?.description === 'Live from the studio');
    const del = await main.app.inject({ method: 'DELETE', url: `/api/nodes/${nodeId}`, headers: admin });
    expect(del.statusCode).toBe(409);
  }, 60_000);

  it('takes the tunnel sign-in from the first message when a proxy drops the header', async () => {
    const url = `${mainBase.replace(/^http/, 'ws')}/api/nodes/agent/station/tunnel`;
    const signIn = (auth: string) =>
      new Promise<number>((resolve) => {
        const ws = new WebSocket(url);
        ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', auth })));
        ws.on('close', (code) => resolve(code));
        ws.on('error', () => undefined);
      });
    expect(await signIn(`Node ${nodeId}.wrong`)).toBe(4401);
    // A good sign-in takes the node's place, until the node connects again and takes it back.
    expect(await signIn(`Node ${nodeId}.${nodeSecret}`)).toBe(4409);
    await until('the tunnel of the node itself', async () => main.app.stationTunnels.online(nodeId));
  }, 30_000);

  it('keeps the package the same while node rows change', async () => {
    const { buildPackage } = await import('../src/services/stationnode/package.js');
    const [n] = await main.db.select().from(schema.nodes).where(eq(schema.nodes.id, nodeId));
    const first = (await buildPackage(main.ctx, n!)).revision;
    // Status updates move rows around in the table.
    for (let i = 0; i < 3; i++) await main.db.update(schema.nodes).set({ updatedAt: new Date() });
    expect((await buildPackage(main.ctx, n!)).revision).toBe(first);
    // The node keeps the sealed form of the same secrets, so its outputs do not restart on every package.
    const before = await node.db.select().from(schema.stations).where(eq(schema.stations.id, stationId));
    const { applyPackage } = await import('../src/services/stationnode/apply.js');
    await applyPackage(node.ctx, await buildPackage(main.ctx, n!));
    const after = await node.db.select().from(schema.stations).where(eq(schema.stations.id, stationId));
    expect(after[0]!.icecastSourcePassword).toBe(before[0]!.icecastSourcePassword);
  }, 30_000);

  it('moves the station straight to another station node, library and tables included', async () => {
    writeFileSync(join(mediaDir(node.ctx, stationId), 'music', 'made-on-node.mp3'), Buffer.alloc(2000, 3));
    const res = await main.app.inject({ method: 'PUT', url: `/api/stations/${stationId}/placement`, headers: admin, payload: { nodeId: node2Id } });
    expect(res.statusCode).toBe(200);
    expect(res.json().move).toMatchObject({ direction: 'to_node', nodeId: node2Id, fromNodeId: nodeId });
    // The old node keeps it on air until the switch.
    expect((await mainStation()).nodeId).toBe(nodeId);
    await until('the switch-over', async () => (await mainStation()).nodeId === node2Id && !(await mainStation()).nodeMove);
    // The library came from the first node through this server, without landing here.
    for (const [name, size] of [['song.mp3', 300_000], ['made-on-node.mp3', 2000]] as const) {
      const file = join(mediaDir(node2.ctx, stationId), 'music', name);
      expect(existsSync(file)).toBe(true);
      expect(readFileSync(file).length).toBe(size);
    }
    expect(existsSync(join(mediaDir(main.ctx, stationId), 'music', 'made-on-node.mp3'))).toBe(false);
    // The playlist made on the first node came along.
    await until('the station on the new node', async () => (await node2.db.select().from(schema.stations).where(eq(schema.stations.id, stationId)))[0]?.enabled);
    const playlists = await node2.db.select().from(schema.playlists).where(eq(schema.playlists.stationId, stationId));
    expect(playlists.map((p) => p.name).sort()).toEqual(['All music', 'Night']);
    // The first node lets go of it.
    await until('the old node to remove it', async () => (await node.db.select().from(schema.stations)).length === 0);
    await until('the first full report of the new node', async () => (await mainStation()).nodeRuntime?.syncedAt);
  }, 90_000);

  it('keeps a downgraded station parked on its node for 24 hours, and switches back without loss', async () => {
    const down = await main.app.inject({ method: 'POST', url: `/api/stations/${stationId}/downgrade`, headers: owner, payload: { confirm: true } });
    expect(down.statusCode, down.body).toBe(200);
    // Distribution only never runs on a station node: it left the node...
    expect(await mainStation()).toMatchObject({ nodeId: null, edition: 'distribution', downgrade: expect.objectContaining({ nodeId: node2Id }) });
    // ...which keeps its files and tables, switched off.
    await until('the node to park it', async () => (await node2.db.select().from(schema.stations).where(eq(schema.stations.id, stationId)))[0]?.enabled === false);
    expect(existsSync(join(mediaDir(node2.ctx, stationId), 'music', 'song.mp3'))).toBe(true);
    expect((await node2.db.select().from(schema.playlists).where(eq(schema.playlists.stationId, stationId))).length).toBe(2);
    // Switching back puts it on the same node again.
    const back = await main.app.inject({ method: 'POST', url: `/api/stations/${stationId}/upgrade`, headers: owner, payload: {} });
    expect(back.statusCode, back.body).toBe(200);
    expect(await mainStation()).toMatchObject({ nodeId: node2Id, edition: 'station', downgrade: null });
    await until('the station running on the node again', async () => (await node2.db.select().from(schema.stations).where(eq(schema.stations.id, stationId)))[0]?.enabled);
    expect((await node2.db.select().from(schema.playlists).where(eq(schema.playlists.stationId, stationId))).length).toBe(2);
    await until('a full report after switching back', async () => (await mainStation()).nodeRuntime?.syncedAt);
  }, 60_000);

  it('moves the station back with what was made on the node', async () => {
    const node = node2;
    writeFileSync(join(mediaDir(node.ctx, stationId), 'music', 'new.mp3'), Buffer.alloc(1000, 1));
    const res = await main.app.inject({ method: 'PUT', url: `/api/stations/${stationId}/placement`, headers: admin, payload: { nodeId: null } });
    expect(res.statusCode).toBe(200);
    await until('the move back', async () => (await mainStation()).nodeId === null && !(await mainStation()).nodeMove);
    expect(existsSync(join(mediaDir(main.ctx, stationId), 'music', 'new.mp3'))).toBe(true);
    expect((await main.db.select().from(schema.playlists).where(eq(schema.playlists.stationId, stationId))).length).toBe(2);
    // The node lets go of it.
    await until('the node to remove it', async () => (await node.db.select().from(schema.stations)).length === 0);
  }, 90_000);
});
