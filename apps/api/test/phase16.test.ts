import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { login, setup } from './helpers.js';

let t: Awaited<ReturnType<typeof setup>>;
let admin: { cookie: string };
let owner: { cookie: string };
let base: string;
let ipSeq = 10;

/** Each registration from its own address, so the rate limit of /register stays out of the way. */
async function register(body: Record<string, unknown> = {}) {
  return t.app.inject({ method: 'POST', url: '/api/nodes/register', remoteAddress: `10.9.0.${ipSeq++}`, payload: { hostname: 'radionode4', version: '1.1.1', addresses: ['10.10.4.124'], ...body } });
}
const status = (token: string) => t.app.inject({ method: 'POST', url: '/api/nodes/register/status', payload: { token } });

/** A fake node agent that says hello and resolves with the server's first answer. */
function hello(nodeId: string, secret: string) {
  return new Promise<{ t: string } | { closed: number }>((resolve) => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/api/nodes/connect`);
    ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', protocol: 1, nodeId, secret, version: '1.1.1', commit: 'abc1234', hostname: 'radionode4', facts: { caddy: false, cores: 2, addresses: ['10.10.4.124'] } }));
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.t === 'welcome') {
        resolve(m);
        ws.close();
      }
    };
    ws.onclose = (ev) => resolve({ closed: ev.code });
  });
}

beforeAll(async () => {
  t = await setup();
  admin = await login(t.app, 'admin@example.com', 'admin-password');
  await t.app.inject({
    method: 'POST',
    url: '/api/tenants',
    headers: admin,
    payload: {
      name: 'Radio Schermer',
      slug: 'schermer',
      plan: 'distribution',
      limits: { maxStations: 1, maxListeners: 100, maxBitrateKbps: 192, storageQuotaMb: 1, maxNodes: 1 },
      owner: { email: 'owner@schermer.nl', name: 'Owner', password: 'owner-password' },
    },
  });
  owner = await login(t.app, 'owner@schermer.nl', 'owner-password');
  await t.app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(t.app.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await t.close();
});

describe('phase 16: node self-registration', () => {
  it('registers a machine that waits under Pending nodes with its code', async () => {
    const res = await register({ role: 'relay' });
    expect(res.statusCode).toBe(201);
    const reg = res.json();
    expect(reg.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(reg.token.length).toBeGreaterThan(20);
    expect((await status(reg.token)).json()).toEqual({ state: 'pending' });

    const list = await t.app.inject({ method: 'GET', url: '/api/nodes/pending', headers: admin });
    expect(list.statusCode).toBe(200);
    const item = list.json().find((x: { id: string }) => x.id === reg.id);
    expect(item).toMatchObject({ code: reg.code, hostname: 'radionode4', addresses: ['10.10.4.124'], preferredRole: 'relay', suggestedName: 'radionode4' });
    expect(item.ip).toMatch(/^10\.9\.0\./);
    // The token never shows up in the panel.
    expect(JSON.stringify(item)).not.toContain(reg.token);
  });

  it('only administrators see and accept pending nodes', async () => {
    const reg = (await register()).json();
    expect((await t.app.inject({ method: 'GET', url: '/api/nodes/pending', headers: owner })).statusCode).toBe(403);
    const res = await t.app.inject({ method: 'POST', url: `/api/nodes/pending/${reg.id}/accept`, headers: owner, payload: { name: 'sneaky' } });
    expect(res.statusCode).toBe(403);
    expect((await status(reg.token)).json().state).toBe('pending');
  });

  it('gives an accepted node its keys, and it connects with them', async () => {
    const reg = (await register({ hostname: 'radionode5', role: 'source' })).json();
    const res = await t.app.inject({ method: 'POST', url: `/api/nodes/pending/${reg.id}/accept`, headers: admin, payload: { name: 'radionode5', location: 'Velsen', roles: ['source'] } });
    expect(res.statusCode).toBe(201);
    const node = res.json();
    expect(node).toMatchObject({ name: 'radionode5', location: 'Velsen', roles: ['source'], paired: true });

    const answer = (await status(reg.token)).json();
    expect(answer).toMatchObject({ state: 'accepted', nodeId: node.id, name: 'radionode5' });
    expect(answer.secret.length).toBeGreaterThan(20);
    // Asked again (the node crashed before it saved the answer): the same keys.
    expect((await status(reg.token)).json().secret).toBe(answer.secret);
    expect(await hello(node.id, answer.secret)).toMatchObject({ t: 'welcome' });

    // Once the node has connected, the registration is gone: it is no longer pending and its token is spent.
    const list = await t.app.inject({ method: 'GET', url: '/api/nodes/pending', headers: admin });
    expect(list.json().some((x: { id: string }) => x.id === reg.id)).toBe(false);
    expect((await status(reg.token)).json()).toEqual({ state: 'expired' });

    const events = await t.app.inject({ method: 'GET', url: `/api/nodes/${node.id}/events`, headers: admin });
    expect(events.json().some((e: { kind: string; details: { via?: string } }) => e.kind === 'paired' && e.details.via === 'registration')).toBe(true);
  });

  it('cannot accept the same machine twice or under a name in use', async () => {
    const reg = (await register({ hostname: 'radionode6' })).json();
    const taken = await t.app.inject({ method: 'POST', url: `/api/nodes/pending/${reg.id}/accept`, headers: admin, payload: { name: 'radionode5' } });
    expect(taken.statusCode).toBe(409);
    const ok = await t.app.inject({ method: 'POST', url: `/api/nodes/pending/${reg.id}/accept`, headers: admin, payload: { name: 'radionode6' } });
    expect(ok.statusCode).toBe(201);
    const again = await t.app.inject({ method: 'POST', url: `/api/nodes/pending/${reg.id}/accept`, headers: admin, payload: { name: 'radionode6b' } });
    expect(again.statusCode).toBe(404);
  });

  it('a node removed after acceptance does not get keys any more', async () => {
    const reg = (await register({ hostname: 'radionode7' })).json();
    const node = (await t.app.inject({ method: 'POST', url: `/api/nodes/pending/${reg.id}/accept`, headers: admin, payload: { name: 'radionode7' } })).json();
    expect((await t.app.inject({ method: 'DELETE', url: `/api/nodes/${node.id}`, headers: admin })).statusCode).toBeLessThan(300);
    expect((await status(reg.token)).json()).toEqual({ state: 'expired' });
  });

  it('tells a refused machine so', async () => {
    const reg = (await register({ hostname: 'stranger' })).json();
    const res = await t.app.inject({ method: 'POST', url: `/api/nodes/pending/${reg.id}/reject`, headers: admin });
    expect(res.statusCode).toBe(200);
    expect((await status(reg.token)).json()).toEqual({ state: 'rejected' });
    const list = await t.app.inject({ method: 'GET', url: '/api/nodes/pending', headers: admin });
    expect(list.json().some((x: { id: string }) => x.id === reg.id)).toBe(false);
  });

  it('an unknown token is simply expired', async () => {
    expect((await status('x'.repeat(43))).json()).toEqual({ state: 'expired' });
  });

  it('takes no registrations when open registration is off; pairing codes keep working', async () => {
    const current = (await t.app.inject({ method: 'GET', url: '/api/nodes/settings', headers: admin })).json();
    expect(current.openRegistration).toBe(true);
    const put = await t.app.inject({ method: 'PUT', url: '/api/nodes/settings', headers: admin, payload: { ...current, openRegistration: false } });
    expect(put.statusCode).toBe(200);
    const res = await register({ hostname: 'late' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('registration_closed');

    const created = await t.app.inject({ method: 'POST', url: '/api/nodes', headers: admin, payload: { name: 'by-code', roles: ['relay'] } });
    const { pairing } = created.json();
    expect(pairing.server).toBe(t.ctx.config.PUBLIC_URL.replace(/\/$/, ''));
    const paired = await t.app.inject({ method: 'POST', url: '/api/nodes/pair', payload: { code: pairing.code, hostname: 'by-code' } });
    expect(paired.statusCode).toBe(200);
    await t.app.inject({ method: 'PUT', url: '/api/nodes/settings', headers: admin, payload: { ...current, openRegistration: true } });
  });
});
