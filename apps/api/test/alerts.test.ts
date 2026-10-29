import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { schema } from '../src/db/index.js';
import { AlertMonitor } from '../src/services/alerts/monitor.js';
import { noticeLines } from '../src/services/alerts/notify.js';
import { evaluate, type RulesInput } from '../src/services/alerts/rules.js';
import { alertSettingsSchema, getSetting, putSetting } from '../src/services/settings.js';
import { login, setup } from './helpers.js';

const NOW = Date.parse('2026-10-28T20:00:00Z');
const RELAY = '00000000-0000-4000-8000-000000000001';
const INGEST = '00000000-0000-4000-8000-000000000002';
const HARDER = '00000000-0000-4000-8000-0000000000a1';

function input(patch: Partial<RulesInput> = {}): RulesInput {
  return {
    now: NOW,
    nodes: [
      { id: RELAY, name: 'pub-relay-01', roles: ['relay'], pairedAt: new Date(0), online: true, status: { online: true, reportedAt: new Date(NOW - 10_000).toISOString(), relays: [{ key: 'harder-fm/live', state: 'connected' }] } },
      { id: INGEST, name: 'ingest01', roles: ['source'], pairedAt: new Date(0), online: true, status: { online: true } },
    ],
    stations: [{ id: HARDER, name: 'Harder.FM', slug: 'harder-fm', enabled: true }],
    probes: [],
    probeIntervalSeconds: 60,
    rollout: { current: null, paused: null },
    dns: { mode: 'off', error: null },
    settings: { quietStations: [], maintenance: [] },
    orchestratorName: 'onlineradio',
    ...patch,
  };
}

const probe = (where: string, ok: boolean, agoMs = 20_000, from = INGEST) => ({ nodeId: from, target: `harder-fm/live@${where}`, stationId: HARDER, ok, message: ok ? null : 'Timeout', checkedAt: new Date(NOW - agoMs), lastOkAt: new Date(NOW - 3_600_000) as Date | null });

describe('alert rules', () => {
  it('finds nothing when all is well', () => {
    expect(evaluate(input({ probes: [probe(RELAY, true)] }))).toEqual([]);
  });

  it('reports an offline node, but not one being updated or in maintenance', () => {
    const nodes = input().nodes.map((n) => (n.id === RELAY ? { ...n, online: false } : n));
    expect(evaluate(input({ nodes })).map((c) => c.key)).toEqual([`node_offline:${RELAY}`]);
    const current = { nodeId: RELAY, phase: 'updating' } as RulesInput['rollout']['current'];
    expect(evaluate(input({ nodes, rollout: { current, paused: null } }))).toEqual([]);
    expect(evaluate(input({ nodes, settings: { quietStations: [], maintenance: [{ kind: 'node', id: RELAY, until: null, note: '', by: null }] } }))).toEqual([]);
    // Maintenance that ended no longer counts.
    const ended = new Date(NOW - 1000).toISOString();
    expect(evaluate(input({ nodes, settings: { quietStations: [], maintenance: [{ kind: 'node', id: RELAY, until: ended, note: '', by: null }] } }))).toHaveLength(1);
  });

  it('says a station is off air when every stream check fails, and names the relay when only one does', () => {
    const offAir = evaluate(input({ probes: [probe(RELAY, false), probe('main', false)] }));
    expect(offAir.map((c) => [c.kind, c.severity])).toEqual([['station_off_air', 'critical']]);
    expect(offAir[0]!.params.station).toBe('Harder.FM');
    const one = evaluate(input({ probes: [probe(RELAY, false), probe('main', true)] }));
    expect(one.map((c) => c.kind)).toEqual(['stream_down']);
    expect(one[0]!.params.where).toBe('pub-relay-01');
    // A station that never played since it is checked (no encoder yet) has not started, it is not off air.
    expect(evaluate(input({ probes: [{ ...probe(RELAY, false), lastOkAt: null }, { ...probe('main', false), lastOkAt: null }] }))).toEqual([]);
    // Another node that hears it play wins over one that does not.
    expect(evaluate(input({ probes: [probe(RELAY, false), probe(RELAY, true, 20_000, RELAY)] }))).toEqual([]);
  });

  it('ignores old checks, quiet stations and checks of a relay that is offline', () => {
    expect(evaluate(input({ probes: [probe(RELAY, false, 10 * 60_000)] }))).toEqual([]);
    expect(evaluate(input({ probes: [probe(RELAY, false)], settings: { quietStations: [HARDER], maintenance: [] } }))).toEqual([]);
    const nodes = input().nodes.map((n) => (n.id === RELAY ? { ...n, online: false } : n));
    expect(evaluate(input({ nodes, probes: [probe(RELAY, false)] })).map((c) => c.kind)).toEqual(['node_offline']);
  });

  it('reports a relay without its feed, unless the station is off air anyway', () => {
    const nodes = input().nodes.map((n) => (n.id === RELAY ? { ...n, status: { ...n.status, relays: [{ key: 'harder-fm/live', state: 'error' as const, message: 'refused' }] } } : n));
    expect(evaluate(input({ nodes })).map((c) => c.key)).toEqual([`feed_lost:${RELAY}:harder-fm/live`]);
    expect(evaluate(input({ nodes, probes: [probe(RELAY, false)] })).map((c) => c.kind)).toEqual(['station_off_air']);
  });

  it('reports a station node that bypasses its ingest, unless the station is off air anyway', () => {
    const studioDirect = [{ stationId: HARDER, nodeId: INGEST, reason: 'offline', message: null }];
    expect(evaluate(input({ studioDirect })).map((c) => [c.key, c.severity, c.params.reason])).toEqual([[`studio_direct:${HARDER}`, 'warning', 'offline']]);
    expect(evaluate(input({ studioDirect, probes: [probe(RELAY, false), probe('main', false)] })).map((c) => c.kind)).toEqual(['station_off_air']);
    expect(evaluate(input({ studioDirect, settings: { quietStations: [HARDER], maintenance: [] } }))).toEqual([]);
  });

  it('reports paused node updates and a failing Cloudflare sync', () => {
    const out = evaluate(input({ rollout: { current: null, paused: { reason: 'health check failed', nodeId: RELAY, at: '' } }, dns: { mode: 'on', error: 'bad token' } }));
    expect(out.map((c) => c.kind)).toEqual(['updates_paused', 'dns_error']);
  });

  it('writes one message for a round, in Dutch too', () => {
    const a = { id: '1', kind: 'station_off_air' as const, severity: 'critical' as const, params: { station: 'Harder.FM' }, message: 'Timeout', openedAt: new Date(NOW - 120_000), resolvedAt: null, nodeId: null, stationId: HARDER };
    const b = { ...a, id: '2', kind: 'node_offline' as const, params: { node: 'ingest01' }, resolvedAt: new Date(NOW) };
    const nl = noticeLines([a], [b], 'nl', 'Europe/Amsterdam');
    expect(nl.lines.map((l) => l.title)).toEqual(['Harder.FM is uit de lucht', 'Opgelost: Node ingest01 is offline']);
    expect(nl.lines[0]!.detail).toBe('Timeout · sinds 20:58');
    expect(nl.lines[1]!.detail).toBe('na 2 min');
    expect(noticeLines([a], [], 'en', 'UTC').subject).toBe('🔴 Harder.FM is off air');
  });
});

describe('alert monitor', () => {
  let t: Awaited<ReturnType<typeof setup>>;
  let admin: { cookie: string };
  let monitor: AlertMonitor;
  let nodeId: string;
  const sent: { url: string; body: any }[] = [];

  beforeAll(async () => {
    t = await setup();
    admin = await login(t.app, 'admin@example.com', 'admin-password');
    monitor = new AlertMonitor(t.ctx, t.app.nodes, t.app.log, 0);
    const res = await t.app.inject({ method: 'POST', url: '/api/nodes', headers: admin, payload: { name: 'relay-a', roles: ['relay'] } });
    nodeId = res.json().node.id;
    // Paired, but never connected: offline.
    await t.db.update(schema.nodes).set({ pairedAt: new Date() }).where(eq(schema.nodes.id, nodeId));
    await t.db.insert(schema.webhooks).values({ name: 'site', url: 'http://127.0.0.1:9/hook', secret: t.ctx.box.encrypt('s'), events: ['alert.opened', 'alert.resolved'] });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      sent.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
      return new Response(JSON.stringify({ ok: true, result: [{ message: { chat: { id: 4242, first_name: 'Reinder', type: 'private' } } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await t.close();
  });

  it('opens an alert only after the wait time, and sends it once', async () => {
    await putSetting(t.ctx, 'alerts', alertSettingsSchema.parse({ graceSeconds: 60, recoverSeconds: 60, telegram: { enabled: true, botToken: '123:abc', chatId: '4242' } }));
    const start = Date.now();
    expect((await monitor.tick(start)).opened).toHaveLength(0);
    expect((await monitor.tick(start + 30_000)).opened).toHaveLength(0);
    const { opened } = await monitor.tick(start + 61_000);
    expect(opened.map((a) => a.kind)).toEqual(['node_offline']);
    expect((await monitor.tick(start + 75_000)).opened).toHaveLength(0);
    const telegram = sent.filter((s) => s.url.includes('api.telegram.org'));
    expect(telegram).toHaveLength(1);
    expect(telegram[0]!.body.chat_id).toBe('4242');
    expect(telegram[0]!.body.text).toContain('Node relay-a is offline');
    const deliveries = await t.db.select().from(schema.webhookDeliveries);
    expect(deliveries.map((d) => d.event)).toEqual(['alert.opened']);

    const list = await t.app.inject({ method: 'GET', url: '/api/alerts', headers: admin });
    expect(list.json()).toHaveLength(1);
    const summary = await t.app.inject({ method: 'GET', url: '/api/alerts/summary', headers: admin });
    expect(summary.json()).toEqual({ open: 1, critical: 1, unacknowledged: 1 });
    const ack = await t.app.inject({ method: 'POST', url: `/api/alerts/${list.json()[0].id}/acknowledge`, headers: admin });
    expect(ack.json().acknowledgedBy).toBe('admin@example.com');
  });

  it('solves it after maintenance starts, with one recovery message', async () => {
    sent.length = 0;
    const m = await t.app.inject({ method: 'POST', url: '/api/alerts/maintenance', headers: admin, payload: { kind: 'node', id: nodeId, minutes: 60, note: 'moving' } });
    expect(m.statusCode).toBe(200);
    const start = Date.now();
    expect((await monitor.tick(start)).resolved).toHaveLength(0);
    const { resolved } = await monitor.tick(start + 61_000);
    expect(resolved).toHaveLength(1);
    expect(sent.filter((s) => s.url.includes('api.telegram.org'))[0]!.body.text).toContain('Solved: Node relay-a is offline');
    const end = await t.app.inject({ method: 'DELETE', url: `/api/alerts/maintenance/node/${nodeId}`, headers: admin });
    expect(end.json()).toEqual([]);
    const history = await t.app.inject({ method: 'GET', url: '/api/alerts?state=resolved', headers: admin });
    expect(history.json()[0].resolvedAt).toBeTruthy();
  });

  it('keeps quiet below the chosen severity, also when it is solved', async () => {
    sent.length = 0;
    await putSetting(t.ctx, 'alerts', { ...(await getSetting(t.ctx, 'alerts')), minSeverity: 'critical', graceSeconds: 15 });
    await t.db.update(schema.nodes).set({ status: { online: false, problems: [] } }).where(eq(schema.nodes.id, nodeId));
    await putSetting(t.ctx, 'nodeRollout', { ...(await getSetting(t.ctx, 'nodeRollout')), paused: { reason: 'health check failed', nodeId, at: new Date().toISOString() } });
    const start = Date.now();
    await monitor.tick(start);
    const { opened } = await monitor.tick(start + 16_000);
    const paused = opened.find((a) => a.kind === 'updates_paused')!;
    expect(paused.notified).toBe(false);
    expect(sent.filter((s) => s.url.includes('api.telegram.org')).map((s) => s.body.text).join()).not.toContain('paused');
  });

  it('masks the Telegram token, finds chats and sends a test', async () => {
    const s = await t.app.inject({ method: 'GET', url: '/api/alerts/settings', headers: admin });
    expect(s.json().telegram.botToken).toBe('••••••••');
    const put = await t.app.inject({ method: 'PUT', url: '/api/alerts/settings', headers: admin, payload: { ...(s.json() as Record<string, unknown>), language: 'nl' } });
    expect(put.statusCode).toBe(200);
    expect((await getSetting(t.ctx, 'alerts')).telegram.botToken).toBe('123:abc');
    const chats = await t.app.inject({ method: 'POST', url: '/api/alerts/telegram/chats', headers: admin, payload: {} });
    expect(chats.json()).toEqual([{ id: '4242', name: 'Reinder', type: 'private' }]);
    sent.length = 0;
    const test = await t.app.inject({ method: 'POST', url: '/api/alerts/test', headers: admin });
    expect(test.json()).toEqual([{ channel: 'telegram', ok: true, error: null }]);
    expect(sent[0]!.body.text).toContain('Testbericht');
  });
});
