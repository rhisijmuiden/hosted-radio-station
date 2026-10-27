import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src/db/index.js';
import { cloudflareSchema } from '../src/services/settings.js';
import { desiredRecords, isPublicAddress, labelOf, nodeAddresses, planChanges, type DnsNode } from '../src/services/dns/records.js';
import type { CfRecord } from '../src/services/dns/cloudflare.js';
import { login, setup } from './helpers.js';

/** A Cloudflare API with one zone, example.com, kept in memory. */
function fakeCloudflare() {
  const records: CfRecord[] = [];
  let seq = 0;
  const calls: string[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const ok = (result: unknown, extra: Record<string, unknown> = {}) => send(200, { success: true, errors: [], result, ...extra });
    if (req.headers.authorization !== 'Bearer good-token') return send(403, { success: false, errors: [{ code: 9109, message: 'Invalid access token' }] });
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const path = url.pathname.replace(/^\/client\/v4/, '');
      calls.push(`${req.method} ${path}`);
      if (path === '/user/tokens/verify') return ok({ status: 'active' });
      if (path === '/zones') return ok(url.searchParams.get('name') === 'example.com' ? [{ id: 'z1', name: 'example.com' }] : []);
      const m = path.match(/^\/zones\/z1\/dns_records(?:\/(.+))?$/);
      if (!m) return send(404, { success: false, errors: [{ code: 7003, message: 'Not found' }] });
      const id = m[1];
      if (req.method === 'GET') return ok(records, { result_info: { page: 1, total_pages: 1 } });
      if (req.method === 'POST') {
        const r = { id: `r${++seq}`, ...JSON.parse(body) } as CfRecord;
        records.push(r);
        return ok(r);
      }
      const i = records.findIndex((r) => r.id === id);
      if (i < 0) return send(404, { success: false, errors: [{ code: 81044, message: 'Record does not exist' }] });
      if (req.method === 'PUT') {
        records[i] = { id: id!, ...JSON.parse(body) };
        return ok(records[i]);
      }
      if (req.method === 'DELETE') {
        records.splice(i, 1);
        return ok({ id });
      }
      send(405, { success: false, errors: [] });
    });
  });
  return { server, records, calls };
}

const settings = (over: Record<string, unknown> = {}) => cloudflareSchema.parse({ mode: 'on', apiToken: 'good-token', domain: 'radio.example.com', ...over });

const node = (over: Partial<DnsNode> = {}): DnsNode => ({
  id: '00000000-0000-4000-8000-000000000001',
  name: 'Relay 1',
  tenantSlug: null,
  roles: ['relay'],
  online: true,
  draining: false,
  dnsName: '',
  dnsRecord: true,
  publicAddress: '',
  ip: '203.0.113.10',
  addresses: [],
  ...over,
});

describe('DNS record plan', () => {
  it('knows public addresses', () => {
    expect(isPublicAddress('10.10.4.121')).toBe(false);
    expect(isPublicAddress('100.64.1.1')).toBe(false);
    expect(isPublicAddress('203.0.113.10')).toBe(true);
    expect(isPublicAddress('fd00::1')).toBe(false);
    expect(isPublicAddress('2a01:7c8::1')).toBe(true);
    expect(labelOf('Relay Amsterdam · 1')).toBe('relay-amsterdam-1');
  });

  it('takes the address a node connects from, a manual one first, and never a LAN address', () => {
    expect(nodeAddresses({ publicAddress: '', ip: '10.10.4.121', addresses: ['10.10.4.121'] })).toEqual([]);
    expect(nodeAddresses({ publicAddress: '198.51.100.7', ip: '10.10.4.121', addresses: [] })).toEqual(['198.51.100.7']);
    expect(nodeAddresses({ publicAddress: '', ip: '::ffff:203.0.113.10', addresses: ['2a01:7c8::5', 'fe80::1'] })).toEqual(['203.0.113.10', '2a01:7c8::5']);
  });

  it('wants origin, node, pool and customer target records, DNS only', () => {
    const { records, problems } = desiredRecords({
      base: 'radio.example.com',
      settings: settings(),
      origin: ['198.51.100.1'],
      nodes: [node(), node({ id: '00000000-0000-4000-8000-000000000002', name: 'Studio', tenantSlug: 'harderfm', roles: ['station'], ip: '192.0.2.200' }), node({ id: '00000000-0000-4000-8000-000000000003', name: 'Relay 2', ip: '10.0.0.5' })],
      domains: [{ id: 'd1', tenantSlug: 'harderfm', targetLabel: 'harderfm', ingestNodeId: '00000000-0000-4000-8000-000000000001' }],
    });
    const by = (name: string) => records.filter((r) => r.name === name).map((r) => `${r.type} ${r.content}`);
    expect(by('origin.radio.example.com')).toEqual(['A 198.51.100.1']);
    expect(by('relay-1.radio.example.com')).toEqual(['A 203.0.113.10']);
    expect(by('listen.radio.example.com')).toEqual(['A 203.0.113.10']);
    expect(by('harderfm.stream.radio.example.com')).toEqual(['CNAME origin.radio.example.com']);
    expect(by('harderfm.src.radio.example.com')).toEqual(['CNAME relay-1.radio.example.com']);
    // 192.0.2.x is documentation space: no public address, so no record.
    expect(problems).toContainEqual({ kind: 'noAddress', ref: '00000000-0000-4000-8000-000000000002', name: 'harderfm-studio.node.radio.example.com' });
    expect(problems.some((p) => p.ref === '00000000-0000-4000-8000-000000000003')).toBe(true);
    expect(records.every((r) => !r.proxied && r.ttl === 60)).toBe(true);
  });

  it('takes a relay out of the pool when it is offline or drained, and falls back to this server', () => {
    const base = { base: 'radio.example.com', settings: settings(), origin: ['198.51.100.1'], domains: [] };
    const pool = (nodes: DnsNode[]) => desiredRecords({ ...base, nodes }).records.filter((r) => r.purpose === 'pool').map((r) => r.content);
    expect(pool([node(), node({ id: '00000000-0000-4000-8000-000000000004', name: 'r2', ip: '203.0.113.11' })])).toEqual(['203.0.113.10', '203.0.113.11']);
    expect(pool([node({ online: false }), node({ id: '00000000-0000-4000-8000-000000000004', name: 'r2', ip: '203.0.113.11', draining: true })])).toEqual(['198.51.100.1']);
  });

  it('only changes its own records and leaves a conflict alone', () => {
    const { records } = desiredRecords({ base: 'radio.example.com', settings: settings({ poolLabel: '' }), origin: ['198.51.100.1'], nodes: [node()], domains: [] });
    const zone: CfRecord[] = [
      { id: 'a', name: 'origin.radio.example.com', type: 'A', content: '198.51.100.9', proxied: false, ttl: 60, comment: 'hrs:abcd1234:origin:198.51.100.9' },
      { id: 'b', name: 'relay-1.radio.example.com', type: 'A', content: '192.0.2.1', proxied: true, ttl: 1, comment: 'mine' },
      { id: 'c', name: 'old.radio.example.com', type: 'A', content: '192.0.2.2', proxied: false, ttl: 60, comment: 'hrs:abcd1234:node:gone:192.0.2.2' },
      { id: 'd', name: 'other.radio.example.com', type: 'A', content: '192.0.2.3', proxied: false, ttl: 60, comment: 'hrs:ffff0000:origin:192.0.2.3' },
    ];
    const plan = planChanges('abcd1234', 'radio.example.com', records, zone);
    expect(plan.creates.map((r) => r.name)).toEqual(['origin.radio.example.com']);
    expect(plan.deletes.map((r) => r.id).sort()).toEqual(['a', 'c']);
    expect(plan.conflicts.map((c) => c.record.name)).toEqual(['relay-1.radio.example.com']);
    expect(plan.creates[0]!.comment).toBe('hrs:abcd1234:origin:198.51.100.1');
  });
});

describe('Cloudflare DNS', () => {
  let t: Awaited<ReturnType<typeof setup>>;
  let admin: { cookie: string };
  let cf: ReturnType<typeof fakeCloudflare>;
  let tenantId: string;
  let relayId: string;

  beforeAll(async () => {
    cf = fakeCloudflare();
    await new Promise<void>((r) => cf.server.listen(0, '127.0.0.1', r));
    const port = (cf.server.address() as AddressInfo).port;
    t = await setup({ PUBLIC_URL: 'https://radio.example.com', CLOUDFLARE_API_URL: `http://127.0.0.1:${port}/client/v4`, PUBLIC_IP_URL: '' });
    admin = await login(t.app, 'admin@example.com', 'admin-password');
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/tenants',
      headers: admin,
      payload: { name: 'Harder.FM', slug: 'harderfm', plan: 'station', limits: { maxStations: 2, maxListeners: 100, maxBitrateKbps: 192, storageQuotaMb: 10, maxNodes: 2 }, owner: { email: 'owner@harder.test', name: 'Owner', password: 'owner-password' } },
    });
    tenantId = res.json().id;
    const n = await t.app.inject({ method: 'POST', url: '/api/nodes', headers: admin, payload: { name: 'Relay 1', roles: ['relay'] } });
    relayId = n.json().node.id;
    await t.db.update(schema.nodes).set({ pairedAt: new Date(), status: { online: false, ip: '10.10.4.121', addresses: ['10.10.4.121'] } }).where(eq(schema.nodes.id, relayId));
  });
  afterAll(async () => {
    await t.close();
    cf.server.close();
  });

  it('tests the token and finds the zone of the platform domain', async () => {
    const bad = await t.app.inject({ method: 'POST', url: '/api/dns/test', headers: admin, payload: { apiToken: 'wrong', domain: 'radio.example.com' } });
    expect(bad.json()).toMatchObject({ ok: false });
    expect(bad.json().message).toContain('Invalid access token');
    const put = await t.app.inject({ method: 'PUT', url: '/api/dns/settings', headers: admin, payload: { ...settings({ mode: 'dryRun', originAddresses: ['198.51.100.1'] }) } });
    expect(put.statusCode).toBe(200);
    expect(put.json().apiToken).toBe('••••••••');
    expect(put.json().platformDomain).toBe('radio.example.com');
    const ok = await t.app.inject({ method: 'POST', url: '/api/dns/test', headers: admin, payload: {} });
    expect(ok.json()).toMatchObject({ ok: true, zoneId: 'z1', zoneName: 'example.com', records: 0 });
  });

  it('shows what it would do in a dry run without writing anything', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/dns/sync', headers: admin });
    const state = res.json();
    expect(state.error).toBeNull();
    expect(state.records).toContainEqual(expect.objectContaining({ name: 'origin.radio.example.com', content: '198.51.100.1', state: 'create' }));
    // The relay connects from a LAN address: no record, and the panel says why.
    expect(state.problems).toContainEqual({ kind: 'noAddress', ref: relayId, name: 'relay-1.radio.example.com' });
    expect(cf.records).toHaveLength(0);
    expect(cf.calls.some((c) => c.startsWith('POST'))).toBe(false);
  });

  it('writes the records in mode "on", with an audit entry per change, and gives the node its platform name', async () => {
    await t.app.inject({ method: 'PATCH', url: `/api/nodes/${relayId}`, headers: admin, payload: { config: { publicAddress: '203.0.113.10', dnsName: 'relay1' } } });
    await t.app.inject({ method: 'PUT', url: '/api/dns/settings', headers: admin, payload: { ...settings({ originAddresses: ['198.51.100.1'] }), apiToken: '••••••••' } });
    const state = (await t.app.inject({ method: 'POST', url: '/api/dns/sync', headers: admin })).json();
    expect(state.error).toBeNull();
    const names = cf.records.map((r) => `${r.name} ${r.type} ${r.content}`).sort();
    expect(names).toEqual(['listen.radio.example.com A 198.51.100.1', 'origin.radio.example.com A 198.51.100.1', 'relay1.radio.example.com A 203.0.113.10']);
    expect(cf.records.every((r) => r.comment?.startsWith('hrs:') && !r.proxied)).toBe(true);
    const audit = await t.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'dns.create'));
    expect(audit.length).toBe(3);
    const [n] = await t.db.select().from(schema.nodes).where(eq(schema.nodes.id, relayId));
    expect(n!.config.dnsHost).toBe('relay1.radio.example.com');
    const dns = (await t.app.inject({ method: 'GET', url: `/api/nodes/${relayId}/dns`, headers: admin })).json();
    expect(dns).toMatchObject({ active: true, platformName: 'relay1.radio.example.com', live: true, host: 'relay1.radio.example.com', addresses: ['203.0.113.10'] });
    // Nothing changed: a second run writes nothing.
    const before = cf.calls.length;
    await t.app.inject({ method: 'POST', url: '/api/dns/sync', headers: admin });
    expect(cf.calls.slice(before).filter((c) => !c.startsWith('GET'))).toEqual([]);
  });

  it('follows a new address and leaves someone else\'s record alone', async () => {
    cf.records.push({ id: 'foreign', name: 'radio.example.com', type: 'A', content: '192.0.2.50', proxied: true, ttl: 1, comment: null });
    await t.app.inject({ method: 'PATCH', url: `/api/nodes/${relayId}`, headers: admin, payload: { config: { publicAddress: '203.0.113.20' } } });
    const state = (await t.app.inject({ method: 'POST', url: '/api/dns/sync', headers: admin })).json();
    expect(cf.records.find((r) => r.name === 'relay1.radio.example.com')?.content).toBe('203.0.113.20');
    expect(cf.records.find((r) => r.id === 'foreign')?.content).toBe('192.0.2.50');
    expect(state.lastChanges).toContainEqual(expect.objectContaining({ action: 'create', name: 'relay1.radio.example.com', content: '203.0.113.20' }));
    // The panel record is off by default; switched on, the existing record is a conflict, not overwritten.
    await t.app.inject({ method: 'PUT', url: '/api/dns/settings', headers: admin, payload: { ...settings({ originAddresses: ['198.51.100.1'], panelRecord: { manage: true, proxied: true } }), apiToken: '••••••••' } });
    const s2 = (await t.app.inject({ method: 'POST', url: '/api/dns/sync', headers: admin })).json();
    expect(s2.problems).toContainEqual({ kind: 'conflict', ref: null, name: 'radio.example.com' });
    expect(cf.records.filter((r) => r.name === 'radio.example.com')).toHaveLength(1);
  });

  it('gives a customer domain its own targets', async () => {
    const add = await t.app.inject({ method: 'POST', url: `/api/tenants/${tenantId}/domains`, headers: admin, payload: { domain: 'harder.invalid' } });
    expect(add.statusCode).toBe(201);
    expect(add.json().targets).toEqual({ panel: 'harderfm.stream.radio.example.com', ingest: 'harderfm.src.radio.example.com' });
    expect(add.json().checks[0]).toMatchObject({ host: 'stream.harder.invalid', ok: false, expected: 'harderfm.stream.radio.example.com' });
    await t.app.inject({ method: 'POST', url: '/api/dns/sync', headers: admin });
    expect(cf.records.find((r) => r.name === 'harderfm.stream.radio.example.com')).toMatchObject({ type: 'CNAME', content: 'origin.radio.example.com', proxied: false });
    expect(cf.records.find((r) => r.name === 'harderfm.src.radio.example.com')).toMatchObject({ type: 'CNAME', content: 'origin.radio.example.com' });
  });

  it('removes only its own records', async () => {
    const refused = await t.app.inject({ method: 'POST', url: '/api/dns/purge', headers: admin, payload: { confirm: true } });
    expect(refused.statusCode).toBe(400);
    await t.app.inject({ method: 'PUT', url: '/api/dns/settings', headers: admin, payload: { ...settings({ mode: 'off' }), apiToken: '••••••••' } });
    const res = await t.app.inject({ method: 'POST', url: '/api/dns/purge', headers: admin, payload: { confirm: true } });
    expect(res.statusCode).toBe(200);
    expect(cf.records.map((r) => r.id)).toEqual(['foreign']);
    const [n] = await t.db.select().from(schema.nodes).where(eq(schema.nodes.id, relayId));
    expect(n!.config.dnsHost).toBe('');
  });
});
