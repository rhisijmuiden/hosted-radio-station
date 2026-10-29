import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, eq, isNotNull } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { schema } from '../src/db/index.js';
import type { ClockItem } from '../src/db/schema.js';
import { nextTrack, playerStarted, trackStarted } from '../src/services/autodj/planner.js';
import { zonedInstant } from '../src/services/scheduler/time.js';
import { mediaDir } from '../src/services/streaming/icecast.js';
import { login, setup } from './helpers.js';

let t: Awaited<ReturnType<typeof setup>>;
let admin: { cookie: string };
let stationId: string;
const ids: Record<string, string> = {};

const TZ = 'Europe/Amsterdam';
const at = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return zonedInstant('2026-10-29', h * 60 + m, TZ);
};
const item = (p: Partial<ClockItem> & Pick<ClockItem, 'kind'>): ClockItem => ({ id: Math.random().toString(36).slice(2), label: '', playlistId: null, mediaId: null, count: 1, at: null, hard: false, ...p });
const api = (method: string, url: string, payload?: unknown) => t.app.inject({ method: method as 'GET', url: `/api/stations/${stationId}${url}`, headers: admin, payload: payload as never });

interface Row {
  key: string;
  at: string;
  state: string;
  source: string;
  itemId: string | null;
  editable: boolean;
  locked: boolean;
  hard: boolean;
  cut: boolean;
  label: string | null;
  media: { id: string; title: string } | null;
}
const log = async (hours = 2) => {
  const res = await api('GET', `/autodj/log?hours=${hours}`);
  expect(res.statusCode).toBe(200);
  return res.json() as { scheduled: boolean; hours: { hour: string; clock: { name: string } | null }[]; rows: Row[] };
};

async function track(title: string, seconds: number, playlist: string | null) {
  const path = `${title.replace(/\s/g, '-')}.mp3`;
  const dir = mediaDir(t.ctx, stationId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, path), 'not really audio');
  const [m] = await t.db.insert(schema.mediaFiles).values({ stationId, location: 'storage', path, title, artist: title, durationSeconds: seconds }).returning();
  if (playlist) await t.db.insert(schema.playlistItems).values({ playlistId: ids[playlist]!, mediaId: m!.id });
  ids[title] = m!.id;
}

beforeAll(async () => {
  t = await setup();
  admin = await login(t.app, 'admin@example.com', 'admin-password');
  const tenant = await t.app.inject({
    method: 'POST',
    url: '/api/tenants',
    headers: admin,
    payload: { name: 'Harder FM', slug: 'harder', plan: 'station', limits: { maxStations: 2, maxListeners: 100, maxBitrateKbps: 192, storageQuotaMb: 100 }, owner: { email: 'owner@harder.fm', name: 'Owner', password: 'owner-password' } },
  });
  stationId = (await t.app.inject({ method: 'POST', url: '/api/stations', headers: admin, payload: { tenantId: tenant.json().id, name: 'Harder.FM', slug: 'harderfm', bitrateKbps: 128 } })).json().id;
  expect((await api('POST', '/upgrade', {})).statusCode).toBe(200);
  for (const [name, rotation] of [['Hits', true], ['Gold', false], ['Jingles', false]] as const) {
    const [p] = await t.db.insert(schema.playlists).values({ stationId, name, rotation }).returning();
    ids[name] = p!.id;
  }
  for (let i = 1; i <= 12; i++) await track(`Hit ${i}`, 200, 'Hits');
  for (let i = 1; i <= 8; i++) await track(`Gold ${i}`, 200, 'Gold');
  await track('Jingle 1', 10, 'Jingles');
  await track('Jingle 2', 10, 'Jingles');
  await track('Station ID', 10, null);
  const settings = (await api('GET', '/autodj')).json().settings;
  await api('PUT', '/autodj', { ...settings, crossfadeSeconds: 0, artistSeparationMinutes: 0, trackSeparationMinutes: 0 });
  // The station ID on the hour (hard, locked), a locked jingle, gold until half past, then the rotation.
  const clock = await api('POST', '/clocks', {
    name: 'Daytime',
    items: [
      item({ kind: 'track', mediaId: ids['Station ID'], at: 0, hard: true, locked: true }),
      item({ kind: 'playlist', playlistId: ids.Jingles, count: 1, locked: true }),
      item({ kind: 'playlist', playlistId: ids.Gold, count: 0, label: 'Gold hour' }),
      item({ kind: 'rotation', at: 30 }),
    ],
  });
  expect(clock.statusCode).toBe(201);
  const view = (await api('GET', '/scheduler')).json();
  await api('PUT', '/scheduler', { ...view.settings, enabled: true, timezone: TZ, defaultClockId: clock.json().id });
}, 60_000);

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  await t?.close();
});

describe('log editor', () => {
  it('runs the hour clocks ahead with the tracks that will play, and keeps the picks', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(at('07:58'));
    const first = await log();
    expect(first.scheduled).toBe(true);
    expect(first.hours.map((h) => h.clock?.name)).toEqual(['Daytime', 'Daytime']);
    const id = first.rows.find((r) => r.source === 'track' && new Date(r.at).getTime() === at('08:00'))!;
    expect(id).toMatchObject({ media: { title: 'Station ID' }, locked: true, hard: true, editable: false, itemId: null });
    // The track before the hour is cut by the hard station ID.
    expect(first.rows[first.rows.indexOf(id) - 1]!.cut).toBe(true);
    const jingle = first.rows[first.rows.indexOf(id) + 1]!;
    expect(jingle).toMatchObject({ source: 'item', locked: true, editable: false });
    const gold = first.rows.filter((r) => r.source === 'playlist');
    expect(gold.length).toBeGreaterThan(3);
    expect(gold.every((r) => r.media!.title.startsWith('Gold') && r.editable && r.label === 'Gold hour')).toBe(true);
    expect(first.rows.some((r) => r.source === 'queue' && new Date(r.at).getTime() >= at('08:29'))).toBe(true);
    // Asked again, the same tracks.
    const again = await log();
    expect(again.rows.map((r) => r.media?.id)).toEqual(first.rows.map((r) => r.media?.id));
    const planned = await t.db.select().from(schema.queueItems).where(and(eq(schema.queueItems.stationId, stationId), isNotNull(schema.queueItems.slot)));
    expect(planned.length).toBeGreaterThan(gold.length);
    // Planned picks stay out of the queue the panel shows.
    const queue = (await api('GET', '/autodj')).json().queues.q1 as { id: string }[];
    expect(queue.some((q) => planned.some((p) => p.id === q.id))).toBe(false);
  });

  it('places and swaps tracks, but not in locked parts or loaded tracks', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(at('07:58'));
    const rows = (await log()).rows;
    const gold = rows.filter((r) => r.source === 'playlist');
    const later = rows.filter((r) => r.source === 'queue' && new Date(r.at).getTime() > at('08:30'));
    const swapped = await api('POST', '/autodj/log/swap', { a: gold[0]!.itemId, b: later[0]!.itemId });
    expect(swapped.statusCode).toBe(200);
    const after = swapped.json().rows as Row[];
    expect(after.find((r) => r.itemId === gold[0]!.itemId)!.media!.id).toBe(later[0]!.media!.id);
    expect(after.find((r) => r.itemId === later[0]!.itemId)!.media!.id).toBe(gold[0]!.media!.id);
    const placed = await api('PUT', `/autodj/log/${gold[1]!.itemId}`, { mediaId: ids['Hit 12'] });
    expect(placed.statusCode).toBe(200);
    expect((placed.json().rows as Row[]).find((r) => r.itemId === gold[1]!.itemId)!.media!.title).toBe('Hit 12');
    const jingle = rows.find((r) => r.source === 'item')!;
    expect((await api('PUT', `/autodj/log/${jingle.itemId}`, { mediaId: ids['Hit 11'] })).statusCode).toBe(400);
    expect((await api('POST', '/autodj/log/swap', { a: jingle.itemId, b: gold[2]!.itemId })).statusCode).toBe(400);
    // Taking a planned pick out picks again.
    const removed = await api('DELETE', `/autodj/log/${gold[2]!.itemId}`);
    expect(removed.statusCode).toBe(200);
    expect((removed.json().rows as Row[]).some((r) => r.itemId === gold[2]!.itemId)).toBe(false);
  });

  it('plays exactly the log, edits included', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(at('07:58'));
    await playerStarted(t.ctx, stationId);
    const plan = (await log()).rows.filter((r) => new Date(r.at).getTime() < at('08:45'));
    const played: { id: string; at: number }[] = [];
    let now = at('07:58');
    let next = await nextTrack(t.ctx, stationId);
    for (let i = 0; i < plan.length && next; i++) {
      const [q] = await t.db.select().from(schema.queueItems).where(eq(schema.queueItems.id, next.itemId));
      // A hard item cuts the track before it at its minute.
      if (next.cutAt && next.cutAt < now) now = next.cutAt;
      vi.setSystemTime(now);
      await trackStarted(t.ctx, stationId, next.itemId);
      played.push({ id: q!.mediaId, at: now });
      const [m] = await t.db.select().from(schema.mediaFiles).where(eq(schema.mediaFiles.id, q!.mediaId));
      next = await nextTrack(t.ctx, stationId);
      now += m!.durationSeconds! * 1000;
    }
    expect(played.map((p) => p.id)).toEqual(plan.map((r) => r.media!.id));
    expect(played.map((p) => p.at)).toEqual(plan.map((r) => new Date(r.at).getTime()));
  });

  it('shows the queue as the log without hour clocks', async () => {
    const view = (await api('GET', '/scheduler')).json();
    await api('PUT', '/scheduler', { ...view.settings, enabled: false });
    const plan = await log(1);
    expect(plan.scheduled).toBe(false);
    expect(plan.rows.length).toBeGreaterThan(5);
    expect(plan.rows.filter((r) => r.state === 'planned').every((r) => r.source === 'queue' && r.editable)).toBe(true);
  });
});
