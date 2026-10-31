import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { login, setup } from './helpers.js';

let t: Awaited<ReturnType<typeof setup>>;
let admin: { cookie: string };
let base: string;

/** A node agent on the control channel with these features; it keeps the messages it gets. */
function agent(nodeId: string, secret: string, features: string[]) {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/api/nodes/connect`);
  const got: { t: string; service?: string }[] = [];
  const welcomed = new Promise<void>((resolve) => {
    ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', protocol: 1, nodeId, secret, version: '0.1.0', commit: 'abc1234', hostname: 'node', facts: { caddy: false, cores: 1, addresses: [], features } }));
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data));
      got.push(m);
      if (m.t === 'ping') ws.send(JSON.stringify({ t: 'pong', seq: m.seq }));
      if (m.t === 'welcome') resolve();
    };
  });
  return { welcomed, got, close: () => ws.close() };
}

async function created(name: string) {
  const res = await t.app.inject({ method: 'POST', url: '/api/nodes', headers: admin, payload: { name, roles: ['relay'] } });
  const { node, pairing } = res.json();
  const paired = await t.app.inject({ method: 'POST', url: '/api/nodes/pair', payload: { code: pairing.code, hostname: 'node-host' } });
  return { id: node.id as string, secret: paired.json().secret as string };
}

beforeAll(async () => {
  t = await setup();
  admin = await login(t.app, 'admin@example.com', 'admin-password');
  base = await t.app.listen({ port: 0, host: '127.0.0.1' });
});
afterAll(() => t.close());

describe('restarting a node from the node page', () => {
  it('asks the agent to restart itself or its Icecast, only when it is online and can', async () => {
    const restart = (id: string, service: string) => t.app.inject({ method: 'POST', url: `/api/nodes/${id}/restart`, headers: admin, payload: { service } });
    const n = await created('relay-restart');
    expect((await restart(n.id, 'agent')).statusCode).toBe(409);

    const old = agent(n.id, n.secret, ['recorder']);
    await old.welcomed;
    const refused = await restart(n.id, 'agent');
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.message).toMatch(/Update the node first/);
    old.close();
    await new Promise((r) => setTimeout(r, 300));

    const a = agent(n.id, n.secret, ['recorder', 'restart']);
    await a.welcomed;
    expect((await restart(n.id, 'icecast')).statusCode).toBe(200);
    expect((await restart(n.id, 'agent')).statusCode).toBe(200);
    expect((await restart(n.id, 'everything')).statusCode).toBe(400);
    await new Promise((r) => setTimeout(r, 300));
    expect(a.got.filter((m) => m.t === 'restart_service').map((m) => m.service)).toEqual(['icecast', 'agent']);
    const events = (await t.app.inject({ method: 'GET', url: `/api/nodes/${n.id}/events`, headers: admin })).json();
    expect(JSON.stringify(events)).toContain('restart_requested');
    a.close();
  });
});
