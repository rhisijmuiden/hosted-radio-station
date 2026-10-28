import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkName, OutsideChecks, type DnsResolver } from '../src/services/alerts/outside.js';
import { evaluate } from '../src/services/alerts/rules.js';
import { login, setup } from './helpers.js';

let t: Awaited<ReturnType<typeof setup>>;
let admin: { cookie: string };
let base: string;

/**
 * A fake monitoring node on the control channel: it answers port checks with the ports in `open` reachable, and
 * remembers what it was asked.
 */
function monitorAgent(nodeId: string, secret: string, open: number[]) {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/api/nodes/connect`);
  const asked: { host: string; ports: number[] }[] = [];
  const opened = new Promise<void>((resolve) => {
    ws.onopen = () => {
      ws.send(JSON.stringify({ t: 'hello', protocol: 1, nodeId, secret, version: '0.1.0', commit: 'abc1234', hostname: 'monitor', facts: { caddy: false, cores: 1, addresses: ['198.51.100.9'], features: ['portcheck'] } }));
      resolve();
    };
  });
  ws.onmessage = (ev) => {
    const m = JSON.parse(String(ev.data));
    if (m.t === 'ping') ws.send(JSON.stringify({ t: 'pong', seq: m.seq }));
    if (m.t === 'portcheck') {
      asked.push({ host: m.host, ports: m.ports });
      const results = (m.ports as number[]).map((port) => ({ port, ok: open.includes(port), message: open.includes(port) ? null : 'timeout', ms: open.includes(port) ? 20 : null }));
      ws.send(JSON.stringify({ t: 'portcheck_result', id: m.id, address: '203.0.113.7', results }));
    }
  };
  return { opened, asked, close: () => ws.close() };
}

/** A plain node agent that only answers pings. */
function nodeAgent(nodeId: string, secret: string) {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/api/nodes/connect`);
  const opened = new Promise<void>((resolve) => {
    ws.onopen = () => {
      ws.send(JSON.stringify({ t: 'hello', protocol: 1, nodeId, secret, version: '0.1.0', commit: 'abc1234', hostname: 'node', facts: { caddy: false, cores: 1, addresses: ['10.0.0.5'] } }));
      resolve();
    };
  });
  ws.onmessage = (ev) => {
    const m = JSON.parse(String(ev.data));
    if (m.t === 'ping') ws.send(JSON.stringify({ t: 'pong', seq: m.seq }));
  };
  return { opened, close: () => ws.close() };
}

async function pair(body: Record<string, unknown>) {
  const res = await t.app.inject({ method: 'POST', url: '/api/nodes', headers: admin, payload: body });
  expect(res.statusCode).toBe(201);
  const { node, pairing } = res.json();
  const p = await t.app.inject({ method: 'POST', url: '/api/nodes/pair', payload: { code: pairing.code, hostname: 'node-host' } });
  return { id: node.id as string, secret: p.json().secret as string };
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  t = await setup();
  admin = await login(t.app, 'admin@example.com', 'admin-password');
  await t.app.listen({ port: 0, host: '127.0.0.1' });
  const addr = t.app.server.address();
  base = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : '';
});
afterAll(() => t.close());

describe('ports from outside through the monitoring node', () => {
  it('checks the ports of a node from the monitoring node, old ones too, and alerts on what is wrong', async () => {
    const ingest = await pair({ name: 'pub-ingest-01', roles: ['source'] });
    await t.app.inject({ method: 'PATCH', url: `/api/nodes/${ingest.id}`, headers: admin, payload: { config: { publicHost: 'ingest.example.com', sourcePlainPort: 8200, sourceTlsPort: 8201 } } });
    const monitor = await pair({ name: 'pub-monitor-01', roles: ['monitor'] });
    // 8201 is filtered; the old plain port 8010 still answers although old ports are off.
    const m = monitorAgent(monitor.id, monitor.secret, [8200, 8010]);
    const n = nodeAgent(ingest.id, ingest.secret);
    await Promise.all([m.opened, n.opened]);
    await wait(300);

    const fw = (await t.app.inject({ method: 'POST', url: `/api/nodes/${ingest.id}/firewall/check`, headers: admin })).json();
    expect(fw.checkedFrom).toEqual({ kind: 'monitor', nodeId: monitor.id, name: 'pub-monitor-01' });
    expect(fw.dns).toEqual({ host: 'ingest.example.com', state: 'ok', checkedOn: '203.0.113.7' });
    expect(fw.checks['8200']).toMatchObject({ ok: true });
    expect(fw.checks['8201']).toMatchObject({ ok: false, message: 'timeout' });
    expect(fw.oldOpen).toEqual([8010]);
    expect(m.asked[0]).toEqual({ host: 'ingest.example.com', ports: expect.arrayContaining([8200, 8201, 8010, 8443]) });

    // The round every 10 minutes does the same for every node and feeds the alerts.
    const outside = new OutsideChecks(t.ctx, t.app.nodes, t.app.log);
    await outside.firewall();
    expect(outside.firewallResults()).toEqual([{ nodeId: ingest.id, closed: ['8201'], oldOpen: [8010] }]);
    m.close();
    n.close();
  });

  it('checks from this server when no monitoring node is online', async () => {
    const node = await pair({ name: 'lonely-ingest', roles: ['source'] });
    await t.app.inject({ method: 'PATCH', url: `/api/nodes/${node.id}`, headers: admin, payload: { config: { publicAddress: '127.0.0.1', sourcePlainPort: 65010, sourceTlsPort: 0 } } });
    const n = nodeAgent(node.id, node.secret);
    await n.opened;
    await wait(300);
    const fw = (await t.app.inject({ method: 'POST', url: `/api/nodes/${node.id}/firewall/check`, headers: admin })).json();
    expect(fw.checkedFrom).toEqual({ kind: 'server' });
    // Without a monitoring node the round from outside has nothing to say.
    const outside = new OutsideChecks(t.ctx, t.app.nodes, t.app.log);
    await outside.firewall();
    expect(outside.firewallResults()).toEqual([]);
    n.close();
  }, 15_000);
});

describe('public DNS', () => {
  const rec = (name: string, type: string, content: string, proxied = false) => ({ name, type, content, proxied, ttl: 300, purpose: 'node' as const, ref: null, state: 'ok' as const });
  const resolver = (table: Record<string, string[]>): DnsResolver => {
    const get = (key: string) => async () => {
      if (!table[key]) throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
      return table[key]!;
    };
    return { resolve4: (n) => get(`A ${n}`)(), resolve6: (n) => get(`AAAA ${n}`)(), resolveCname: (n) => get(`CNAME ${n}`)() };
  };

  it('compares what the world resolves with the records the sync made', async () => {
    const r = resolver({ 'A relay.example.com': ['203.0.113.5'], 'A pool.example.com': ['203.0.113.5'], 'A example.com': ['104.16.1.1'], 'A proxied.example.com': ['203.0.113.1'], 'CNAME src.example.com': ['origin.example.com'] });
    expect(await checkName(r, 'relay.example.com', [rec('relay.example.com', 'A', '203.0.113.5')])).toBeNull();
    expect(await checkName(r, 'pool.example.com', [rec('pool.example.com', 'A', '203.0.113.5'), rec('pool.example.com', 'A', '203.0.113.6')])).toBe('resolves to 203.0.113.5 instead of 203.0.113.5, 203.0.113.6');
    expect(await checkName(r, 'example.com', [rec('example.com', 'A', '203.0.113.1', true)])).toBeNull();
    expect(await checkName(r, 'proxied.example.com', [rec('proxied.example.com', 'A', '203.0.113.1', true)])).toBe('resolves to 203.0.113.1, not through the Cloudflare proxy');
    expect(await checkName(r, 'src.example.com', [rec('src.example.com', 'CNAME', 'origin.example.com')])).toBeNull();
    expect(await checkName(r, 'gone.example.com', [rec('gone.example.com', 'A', '203.0.113.9')])).toBe('not found in public DNS');
  });
});

describe('outside check rules', () => {
  const NOW = Date.now();
  const node = { id: 'n1', name: 'pub-ingest-01', roles: ['source' as const], pairedAt: new Date(), online: true, status: { online: true } };
  const base = {
    now: NOW,
    nodes: [node],
    stations: [],
    probes: [],
    probeIntervalSeconds: 60,
    rollout: { current: null, paused: null },
    dns: { mode: 'on' as const, error: null },
    settings: { quietStations: [], maintenance: [] },
    orchestratorName: 'onlineradio',
  };

  it('alerts on ports closed from outside, old ports still open and names that resolve wrong', () => {
    const out = evaluate({ ...base, firewall: [{ nodeId: 'n1', closed: ['8201'], oldOpen: [8010] }], dnsWrong: [{ name: 'relay.example.com', message: 'not found in public DNS' }] });
    expect(out.map((c) => [c.key, c.params])).toEqual([
      ['port_closed:n1', { node: 'pub-ingest-01', ports: '8201' }],
      ['old_port_open:n1', { node: 'pub-ingest-01', ports: '8010' }],
      ['dns_wrong:relay.example.com', { name: 'relay.example.com' }],
    ]);
    // A node that is offline has its own alert; with DNS sync off the names are not ours to check.
    expect(evaluate({ ...base, nodes: [{ ...node, online: false }], dns: { mode: 'off', error: null }, firewall: [{ nodeId: 'n1', closed: ['8201'], oldOpen: [] }], dnsWrong: [{ name: 'x', message: '' }] }).map((c) => c.kind)).toEqual(['node_offline']);
  });
});
