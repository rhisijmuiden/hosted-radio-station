import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetting, nodeUpdatesSchema, putSetting } from '../src/services/settings.js';
import { drainingNodes, inWindow, nextWindow, policyOf } from '../src/services/nodes/updates.js';
import { login, setup } from './helpers.js';

let t: Awaited<ReturnType<typeof setup>>;
let admin: { cookie: string };
let base: string;
let target: string;

const OLD = 'abc1234';

/** A fake node agent that can "update" by reconnecting with another commit. */
function agent(nodeId: string, secret: string, commit = OLD) {
  const messages: Record<string, any>[] = [];
  let ws: WebSocket;
  const open = (c: string) =>
    new Promise<void>((resolve) => {
      ws = new WebSocket(`${base.replace('http', 'ws')}/api/nodes/connect`);
      ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', protocol: 1, nodeId, secret, version: '0.1.0', commit: c, hostname: 'relay-test', facts: { caddy: true, cores: 2, addresses: [] } }));
      ws.onmessage = (ev) => {
        const m = JSON.parse(String(ev.data));
        if (m.t === 'ping') ws.send(JSON.stringify({ t: 'pong', seq: m.seq }));
        // Ready once the plan is in: the hub sends it right after the welcome.
        if (m.t === 'plan') resolve();
        messages.push(m);
      };
    });
  return {
    messages,
    open: () => open(commit),
    /** Restarts on another version, as the node's update script would. */
    restart: async (c: string) => {
      ws.close();
      await new Promise((r) => setTimeout(r, 50));
      await open(c);
    },
    stats: (update: Record<string, unknown> | null) => ws.send(JSON.stringify({ t: 'stats', cpu: 0.1, memory: 0.2, load: 0, uptime: 1, rxBps: 0, txBps: 0, listeners: 0, encoders: 0, icmp: null, problems: [], update, revision: null })),
    report: (state: 'connected' | 'error') =>
      t.app.inject({ method: 'POST', url: '/api/nodes/agent/report', headers: { authorization: `Node ${nodeId}.${secret}` }, payload: { relays: [{ key: 'harder-fm/live', state }], clients: [], probes: [] } }),
    updates: () => messages.filter((m) => m.t === 'update'),
    close: () => ws.close(),
  };
}

async function pairNode(name: string, body: Record<string, unknown> = {}) {
  const res = await t.app.inject({ method: 'POST', url: '/api/nodes', headers: admin, payload: { name, roles: ['relay'], ...body } });
  const { node, pairing } = res.json();
  const p = await t.app.inject({ method: 'POST', url: '/api/nodes/pair', payload: { code: pairing.code.toLowerCase().replace(/-/g, ''), hostname: name } });
  return { id: node.id as string, secret: p.json().secret as string };
}

const settle = () => new Promise((r) => setTimeout(r, 100));
/** Retries an assertion for a few seconds: messages and reconnects arrive over real sockets. */
async function eventually(check: () => unknown | Promise<unknown>) {
  for (let i = 0; ; i++) {
    try {
      return await check();
    } catch (err) {
      if (i >= 30) throw err;
      await settle();
    }
  }
}
const tick = async () => {
  await t.app.nodeUpdates.tick();
  await settle();
};
/** Pretends the current step started this many seconds ago. */
async function age(seconds: number) {
  const r = await getSetting(t.ctx, 'nodeRollout');
  r.current!.phaseAt = new Date(Date.parse(r.current!.phaseAt) - seconds * 1000).toISOString();
  await putSetting(t.ctx, 'nodeRollout', r);
}
const nodeInfo = async (id: string) => (await t.app.inject({ method: 'GET', url: `/api/nodes/${id}`, headers: admin })).json();
async function setUpdates(patch: Record<string, unknown>) {
  const s = await getSetting(t.ctx, 'nodes');
  await putSetting(t.ctx, 'nodes', { ...s, updates: { ...s.updates, ...patch } });
}
async function reset() {
  await putSetting(t.ctx, 'nodeRollout', { current: null, queue: [], paused: null, results: {} });
}

beforeAll(async () => {
  t = await setup();
  admin = await login(t.app, 'admin@example.com', 'admin-password');
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/tenants',
    headers: admin,
    payload: { name: 'Harder.fm', slug: 'harder', plan: 'distribution', limits: { maxStations: 2, maxListeners: 100, maxBitrateKbps: 192, storageQuotaMb: 1 }, owner: { email: 'owner@harder.fm', name: 'Owner', password: 'owner-password' } },
  });
  await t.app.inject({ method: 'POST', url: '/api/stations', headers: admin, payload: { tenantId: res.json().id, name: 'Harder FM', slug: 'harder-fm' } });
  await t.app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(t.app.server.address() as AddressInfo).port}`;
  target = (await t.app.nodeUpdates.target()).commit!;
  // The planner is driven by hand here.
  t.app.nodeUpdates.stop();
  // Skip the grace period after start, in which the planner waits for nodes to reconnect.
  Object.assign(t.app.nodeUpdates, { startedAt: 0 });
});
afterAll(() => t.close());

describe('maintenance windows', () => {
  const tz = 'Europe/Amsterdam';
  it('knows when a window is open, also past midnight', () => {
    const night = { days: [1], start: '23:00', end: '02:00' };
    // Monday 2026-10-26 23:30 and Tuesday 01:30 in Amsterdam (UTC+1 in winter time).
    expect(inWindow(night, tz, new Date('2026-10-26T22:30:00Z'))).toBe(true);
    expect(inWindow(night, tz, new Date('2026-10-27T00:30:00Z'))).toBe(true);
    expect(inWindow(night, tz, new Date('2026-10-27T01:30:00Z'))).toBe(false);
    expect(inWindow(night, tz, new Date('2026-10-26T21:30:00Z'))).toBe(false);
  });

  it('finds the next opening, across daylight saving time', () => {
    const w = { days: [0, 1, 2, 3, 4, 5, 6], start: '03:00', end: '05:00' };
    expect(nextWindow(w, tz, new Date('2026-10-26T12:00:00Z'))!.toISOString()).toBe('2026-10-27T02:00:00.000Z');
    // Sunday 25 October 2026 the clocks went back: Saturday noon (UTC+2) → Sunday 03:00 (UTC+1).
    expect(nextWindow(w, tz, new Date('2026-10-24T10:00:00Z'))!.toISOString()).toBe('2026-10-25T02:00:00.000Z');
    expect(nextWindow({ ...w, days: [] }, tz)).toBeNull();
  });

  it('takes the policy from the node, its group, its role or the network', () => {
    const u = nodeUpdatesSchema.parse({ policy: 'rolling', groups: [{ id: 'canary', name: 'Canary', policy: 'window' }] });
    expect(policyOf({ roles: ['relay'], config: {} }, u)).toMatchObject({ policy: 'rolling', source: 'network' });
    expect(policyOf({ roles: ['relay'], config: { updateGroup: 'canary' } }, u)).toMatchObject({ policy: 'window', source: 'group', group: { id: 'canary' } });
    expect(policyOf({ roles: ['relay'], config: { updateGroup: 'canary', updatePolicy: 'manual' } }, u)).toMatchObject({ policy: 'manual', source: 'node' });
    expect(policyOf({ roles: ['fm'], config: {} }, u)).toMatchObject({ policy: 'manual', source: 'role' });
  });
});

describe('node updates', () => {
  it('updates one node at a time and only goes on after a passing check', async () => {
    await setUpdates({ drainSeconds: 0, healthSeconds: 15 });
    const n1 = await pairNode('a-relay-1');
    const n2 = await pairNode('b-relay-2');
    const a1 = agent(n1.id, n1.secret);
    const a2 = agent(n2.id, n2.secret);
    await Promise.all([a1.open(), a2.open()]);
    await Promise.all([a1.report('connected'), a2.report('connected')]);

    // The server never lets the agents update by themselves.
    const plan = a1.messages.find((m) => m.t === 'plan')!.plan;
    expect(plan.update).toMatchObject({ commit: target, auto: false });
    await eventually(async () => expect((await nodeInfo(n1.id)).update).toMatchObject({ state: 'waiting', policy: 'rolling' }));

    await tick();
    await eventually(() => expect(a1.updates()).toEqual([expect.objectContaining({ commit: target })]));
    await eventually(() => expect(a2.updates()).toEqual([]));
    await eventually(async () => expect((await nodeInfo(n1.id)).update.state).toBe('updating'));

    // The node comes back on the new version, with its stream.
    a1.stats({ state: 'running', message: 'Building' });
    await a1.restart(target);
    await tick();
    await eventually(async () => expect((await nodeInfo(n1.id)).update.state).toBe('checking'));
    await tick();
    await eventually(() => expect(a2.updates()).toEqual([]));
    await a1.report('connected');
    await age(20);
    await tick();
    await eventually(async () => expect((await nodeInfo(n1.id)).update).toMatchObject({ state: 'upToDate', last: { state: 'succeeded', from: { commit: OLD } } }));

    // Now the second node.
    await tick();
    await eventually(() => expect(a2.updates()).toEqual([expect.objectContaining({ commit: target })]));
    a2.close();
    a1.close();
    await reset();
  });

  it('updates all nodes at once on request, and the planner leaves them alone meanwhile', async () => {
    await setUpdates({ drainSeconds: 0, healthSeconds: 15 });
    const n1 = await pairNode('p-relay-1');
    const n2 = await pairNode('p-relay-2');
    const a1 = agent(n1.id, n1.secret);
    const a2 = agent(n2.id, n2.secret);
    await Promise.all([a1.open(), a2.open()]);
    const res = await t.app.inject({ method: 'POST', url: '/api/nodes/updates/all', headers: admin });
    expect(res.statusCode).toBe(200);
    expect(res.json().sent).toBe(2);
    await eventually(() => expect(a1.updates()).toEqual([expect.objectContaining({ commit: target })]));
    await eventually(() => expect(a2.updates()).toEqual([expect.objectContaining({ commit: target })]));
    // No second request from the rollout while they update.
    await tick();
    await tick();
    expect(a1.updates().length + a2.updates().length).toBe(2);
    expect((await getSetting(t.ctx, 'nodeRollout')).current).toBeNull();
    // Only administrators.
    const owner = await login(t.app, 'owner@harder.fm', 'owner-password');
    expect((await t.app.inject({ method: 'POST', url: '/api/nodes/updates/all', headers: owner })).statusCode).toBe(403);
    a1.close();
    a2.close();
    await reset();
  });

  it('rolls a node back when it is not healthy after its update, and pauses the rest', async () => {
    await setUpdates({ drainSeconds: 0, healthSeconds: 15 });
    const n = await pairNode('c-relay-3');
    const other = await pairNode('d-relay-4');
    const a = agent(n.id, n.secret);
    const b = agent(other.id, other.secret);
    await Promise.all([a.open(), b.open()]);
    await Promise.all([a.report('connected'), b.report('connected')]);
    await tick();
    await eventually(() => expect(a.updates()).toHaveLength(1));
    await a.restart(target);
    await tick();
    // The stream does not come back.
    await a.report('error');
    await age(200);
    await tick();
    await eventually(async () => expect((await nodeInfo(n.id)).update.state).toBe('rollingBack'));
    await eventually(() => expect(a.updates().at(-1)).toMatchObject({ commit: OLD }));

    await a.restart(OLD);
    await tick();
    const info = (await nodeInfo(n.id)).update;
    expect(info).toMatchObject({ state: 'failed', last: { state: 'rolledBack' } });
    expect(info.last.message).toContain('did not come back');
    const r = (await t.app.inject({ method: 'GET', url: '/api/nodes/updates', headers: admin })).json();
    expect(r.paused).toMatchObject({ nodeName: 'c-relay-3' });

    // Paused: the other node waits, and the failed version is not tried again on the first one.
    await tick();
    await eventually(() => expect(b.updates()).toEqual([]));
    await eventually(async () => expect((await nodeInfo(other.id)).update.state).toBe('paused'));
    await t.app.inject({ method: 'POST', url: '/api/nodes/updates/resume', headers: admin });
    await tick();
    await eventually(() => expect(a.updates()).toHaveLength(2));
    await eventually(() => expect(b.updates()).toHaveLength(1));
    a.close();
    b.close();
    await reset();
  });

  it('keeps manual and out-of-window nodes on their version until asked, and drains relays first', async () => {
    await setUpdates({ drainSeconds: 30, healthSeconds: 15 });
    const m = await pairNode('e-relay-5');
    const w = await pairNode('f-relay-6');
    await t.app.inject({ method: 'PATCH', url: `/api/nodes/${m.id}`, headers: admin, payload: { config: { updatePolicy: 'manual' } } });
    await t.app.inject({ method: 'PATCH', url: `/api/nodes/${w.id}`, headers: admin, payload: { config: { updatePolicy: 'window', updateWindow: { days: [], start: '03:00', end: '05:00' } } } });
    const am = agent(m.id, m.secret);
    const aw = agent(w.id, w.secret);
    await Promise.all([am.open(), aw.open()]);
    await tick();
    await eventually(() => expect(am.updates()).toEqual([]));
    await eventually(() => expect(aw.updates()).toEqual([]));
    await eventually(async () => expect((await nodeInfo(m.id)).update.state).toBe('manual'));
    await eventually(async () => expect((await nodeInfo(w.id)).update).toMatchObject({ state: 'scheduled', nextWindowAt: null }));

    // Update now: in line, then drained before the update.
    const res = await t.app.inject({ method: 'POST', url: `/api/nodes/${m.id}/update`, headers: admin });
    expect(res.json()).toMatchObject({ ok: true, position: 1 });
    await eventually(async () => expect((await nodeInfo(m.id)).update.state).toBe('queued'));
    await tick();
    await eventually(async () => expect((await nodeInfo(m.id)).update.state).toBe('draining'));
    await eventually(() => expect(am.messages.filter((x) => x.t === 'drain')).toEqual([{ t: 'drain', seconds: 30 }]));
    expect(drainingNodes.has(m.id)).toBe(true);
    await eventually(() => expect(am.updates()).toEqual([]));

    // Still draining: it can be called off.
    const cancel = await t.app.inject({ method: 'POST', url: `/api/nodes/${m.id}/update/cancel`, headers: admin });
    expect(cancel.statusCode).toBe(200);
    expect(drainingNodes.has(m.id)).toBe(false);
    await eventually(() => expect(am.messages.filter((x) => x.t === 'drain').at(-1)).toEqual({ t: 'drain', seconds: 0 }));

    await t.app.inject({ method: 'POST', url: `/api/nodes/${m.id}/update`, headers: admin });
    await tick();
    await age(40);
    await tick();
    await eventually(() => expect(am.updates()).toEqual([expect.objectContaining({ commit: target })]));
    am.close();
    aw.close();
    await reset();
  });

  it('does not count a node that is offline before its update as a failure', async () => {
    await setUpdates({ drainSeconds: 30, healthSeconds: 15 });
    const n = await pairNode('h-relay-8');
    const a = agent(n.id, n.secret);
    await a.open();
    await tick();
    await eventually(async () => expect((await nodeInfo(n.id)).update.state).toBe('draining'));
    // The connection drops (e.g. this server restarted): still draining, nothing paused.
    a.close();
    await settle();
    await tick();
    await eventually(async () => expect((await nodeInfo(n.id)).update.state).toBe('draining'));
    // Gone for good: postponed, without a result or a pause.
    const r = await getSetting(t.ctx, 'nodeRollout');
    r.current!.offlineSeconds = 1000;
    await putSetting(t.ctx, 'nodeRollout', r);
    await tick();
    const after = await getSetting(t.ctx, 'nodeRollout');
    expect(after).toMatchObject({ current: null, paused: null });
    expect(after.results[n.id]).toBeUndefined();
    expect(drainingNodes.has(n.id)).toBe(false);
    await reset();
  });

  it('judges nothing right after this server starts', async () => {
    const r = await getSetting(t.ctx, 'nodeRollout');
    Object.assign(t.app.nodeUpdates, { startedAt: Date.now() });
    await putSetting(t.ctx, 'nodeRollout', { ...r, queue: [] });
    const n = await pairNode('i-relay-9');
    const a = agent(n.id, n.secret);
    await a.open();
    await tick();
    expect(a.updates()).toEqual([]);
    Object.assign(t.app.nodeUpdates, { startedAt: 0 });
    a.close();
    await reset();
  });

  it('only lets administrators put nodes in update groups', async () => {
    const res = await t.app.inject({ method: 'PATCH', url: `/api/nodes/${(await pairNode('g-relay-7')).id}`, headers: admin, payload: { config: { updateGroup: 'nope' } } });
    expect(res.statusCode).toBe(400);
    const s = await getSetting(t.ctx, 'nodes');
    const put = await t.app.inject({ method: 'PUT', url: '/api/nodes/settings', headers: admin, payload: { ...s, updates: { ...s.updates, groups: [{ id: 'x', name: 'A' }, { id: 'x', name: 'B' }] } } });
    expect(put.statusCode).toBe(400);
  });
});
