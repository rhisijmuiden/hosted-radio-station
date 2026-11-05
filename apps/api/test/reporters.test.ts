import { createHmac } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src/db/index.js';
import { buildPlan } from '../src/services/nodes/plan.js';
import { inboundPorts } from '../src/services/nodes/ports.js';
import { livekitToken, reporterSecret } from '../src/services/reporters.js';
import { login, setup } from './helpers.js';

let t: Awaited<ReturnType<typeof setup>>;
let owner: { cookie: string };
let dj: { cookie: string };
let stranger: { cookie: string };
let stationId: string;
let nodeId: string;
const NODE_SECRET = 'node-secret-for-reporters';

const decode = (jwt: string) => JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString());

beforeAll(async () => {
  t = await setup();
  const admin = await login(t.app, 'admin@example.com', 'admin-password');
  const tenant = await t.app.inject({
    method: 'POST',
    url: '/api/tenants',
    headers: admin,
    payload: { name: 'Festival FM', slug: 'festival', plan: 'station', owner: { email: 'owner@festival.fm', name: 'Owner', password: 'owner-password' } },
  });
  owner = await login(t.app, 'owner@festival.fm', 'owner-password');
  await t.app.inject({ method: 'POST', url: `/api/tenants/${tenant.json().id}/members`, headers: owner, payload: { email: 'dj@festival.fm', name: 'DJ Bas', password: 'dj-password-1', role: 'dj' } });
  dj = await login(t.app, 'dj@festival.fm', 'dj-password-1');
  await t.app.inject({
    method: 'POST',
    url: '/api/tenants',
    headers: admin,
    payload: { name: 'Other FM', slug: 'other', plan: 'station', owner: { email: 'owner@other.fm', name: 'Other', password: 'other-password' } },
  });
  stranger = await login(t.app, 'owner@other.fm', 'other-password');
  const station = await t.app.inject({ method: 'POST', url: '/api/stations', headers: owner, payload: { tenantId: tenant.json().id, name: 'Festival FM', slug: 'festival-fm' } });
  stationId = station.json().id;
  const [node] = await t.db
    .insert(schema.nodes)
    .values({
      name: 'ingest-1',
      roles: ['source'],
      config: { publicHost: 'ingest1.example.com' },
      secret: t.ctx.box.encrypt(NODE_SECRET),
      pairedAt: new Date(),
      status: { online: true, caddy: true, features: ['reporters'] },
    })
    .returning();
  nodeId = node!.id;
});
afterAll(() => t.close());

const setNode = async (config: Record<string, unknown>, status: Record<string, unknown>) => {
  const [n] = await t.db.select().from(schema.nodes).where(eq(schema.nodes.id, nodeId));
  await t.db.update(schema.nodes).set({ config: { ...n!.config, ...config }, status: { ...n!.status, ...status } }).where(eq(schema.nodes.id, nodeId));
};
const nodeRow = async () => (await t.db.select().from(schema.nodes).where(eq(schema.nodes.id, nodeId)))[0]!;

describe('LiveKit tokens', () => {
  it('signs an HS256 token LiveKit accepts', () => {
    const jwt = livekitToken('s3cret', { identity: 'rep-1', name: 'Sanne', grant: { room: 'r', roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true }, now: 1_000_000_000_000 });
    const [h, b, sig] = jwt.split('.');
    expect(JSON.parse(Buffer.from(h!, 'base64url').toString())).toEqual({ alg: 'HS256', typ: 'JWT' });
    expect(createHmac('sha256', 's3cret').update(`${h}.${b}`).digest('base64url')).toBe(sig);
    const body = decode(jwt);
    expect(body).toMatchObject({ iss: 'hrs', sub: 'rep-1', name: 'Sanne', video: { room: 'r', roomJoin: true } });
    expect(body.exp - body.nbf).toBeGreaterThan(3600);
  });
});

describe('reporter server on an ingest node', () => {
  it('is not in the plan or the ports until reporter mode is on', async () => {
    expect((await buildPlan(t.ctx, await nodeRow())).reporters).toBeNull();
    expect((await inboundPorts(t.ctx, await nodeRow())).some((p) => p.service === 'reporters')).toBe(false);
  });

  it('plans LiveKit and opens its port for UDP and TCP once it is on', async () => {
    await setNode({ reporters: true }, {});
    const plan = await buildPlan(t.ctx, await nodeRow());
    expect(plan.reporters).toEqual({ signalPort: 17010, rtcPort: 8500, publicIp: null });
    const ports = await inboundPorts(t.ctx, await nodeRow());
    expect(ports).toContainEqual({ service: 'reporters', port: 8500, for: ['reporters'], udp: true });
    expect(ports).toContainEqual({ service: 'listenersTls', port: 443, for: ['reporters'] });
  });

  it('tells RHIS Studio the server is still starting while LiveKit does not run yet', async () => {
    const res = await t.app.inject({ url: `/api/studio/stations/${stationId}/reporters`, headers: dj });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ available: false, reason: 'starting', token: null, invite: null });
  });

  it('gives RHIS Studio a studio token for the station room once it runs', async () => {
    await setNode({}, { reporters: { state: 'running' } });
    const res = await t.app.inject({ url: `/api/studio/stations/${stationId}/reporters`, headers: dj });
    expect(res.json()).toMatchObject({ available: true, server: { url: 'wss://ingest1.example.com', node: 'ingest-1' }, room: `station-${stationId}`, identity: 'studio' });
    const token = res.json().token as string;
    const [h, b, sig] = token.split('.');
    expect(createHmac('sha256', reporterSecret(NODE_SECRET)).update(`${h}.${b}`).digest('base64url')).toBe(sig);
    expect(decode(token).video).toMatchObject({ room: `station-${stationId}`, roomAdmin: true, canPublish: true });
  });

  it('keeps other customers out', async () => {
    expect((await t.app.inject({ url: `/api/studio/stations/${stationId}/reporters`, headers: stranger })).statusCode).toBe(403);
  });
});

describe('invitations', () => {
  let code: string;

  it('makes a six-digit code with a join link', async () => {
    const res = await t.app.inject({ method: 'POST', url: `/api/studio/stations/${stationId}/reporters/invite`, headers: dj });
    expect(res.statusCode).toBe(200);
    code = res.json().code;
    expect(code).toMatch(/^\d{6}$/);
    expect(res.json().joinUrl).toMatch(new RegExp(`/reporter\\?code=${code}$`));
    expect((await t.app.inject({ url: `/api/studio/stations/${stationId}/reporters`, headers: dj })).json().invite.code).toBe(code);
  });

  it('lets a phone join with the code, with only its microphone', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/public/reporters/join', payload: { code: `${code.slice(0, 3)} ${code.slice(3)}`, name: 'Sanne', place: 'Main stage' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ url: 'wss://ingest1.example.com', station: { name: 'Festival FM' } });
    expect(res.json().identity).toMatch(/^rep-[0-9a-f]{12}$/);
    const body = decode(res.json().token);
    expect(body).toMatchObject({ name: 'Sanne', video: { room: `station-${stationId}`, canPublishSources: ['microphone'] } });
    expect(body.video.roomAdmin).toBeUndefined();
    expect(JSON.parse(body.metadata)).toEqual({ role: 'reporter', place: 'Main stage' });
  });

  it('refuses a wrong code', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/public/reporters/join', payload: { code: code === '000000' ? '000001' : '000000', name: 'X' } });
    expect(res.statusCode).toBe(404);
  });

  it('replaces the code with a new one, and ends it', async () => {
    const res = await t.app.inject({ method: 'POST', url: `/api/studio/stations/${stationId}/reporters/invite`, headers: dj });
    const next = res.json().code;
    expect((await t.app.inject({ method: 'POST', url: '/api/public/reporters/join', payload: { code: next, name: 'Mark' } })).statusCode).toBe(200);
    if (next !== code) expect((await t.app.inject({ method: 'POST', url: '/api/public/reporters/join', payload: { code, name: 'Mark' } })).statusCode).toBe(404);
    await t.app.inject({ method: 'DELETE', url: `/api/studio/stations/${stationId}/reporters/invite`, headers: dj });
    expect((await t.app.inject({ method: 'POST', url: '/api/public/reporters/join', payload: { code: next, name: 'Mark' } })).statusCode).toBe(404);
  });

  it('refuses phones while the server is down', async () => {
    const res = await t.app.inject({ method: 'POST', url: `/api/studio/stations/${stationId}/reporters/invite`, headers: dj });
    await setNode({}, { online: false });
    expect((await t.app.inject({ method: 'POST', url: '/api/public/reporters/join', payload: { code: res.json().code, name: 'Mark' } })).statusCode).toBe(503);
    expect((await t.app.inject({ url: `/api/studio/stations/${stationId}/reporters`, headers: dj })).json().reason).toBe('offline');
  });
});
