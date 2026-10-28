import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { schema } from '../src/db/index.js';
import type { ClockItem } from '../src/db/schema.js';
import { scanLibrary } from '../src/services/autodj/library.js';
import { flushForClock, nextTrack, playerStarted, trackStarted } from '../src/services/autodj/planner.js';
import { decide, entryStep, type ClockLike, type ClockState } from '../src/services/scheduler/clock.js';
import { blockAt, occurrences, type Block } from '../src/services/scheduler/schedule.js';
import { hourStart, wallTime, zonedInstant } from '../src/services/scheduler/time.js';
import { mediaDir } from '../src/services/streaming/icecast.js';
import { outsideShow } from '../src/services/streaming/sources.js';
import { login, setup } from './helpers.js';

const TZ = 'Europe/Amsterdam';
const MIN = 60_000;
const local = (date: string, hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return zonedInstant(date, h * 60 + m, TZ);
};
const item = (p: Partial<ClockItem> & Pick<ClockItem, 'kind'>): ClockItem => ({
  id: Math.random().toString(36).slice(2),
  label: '',
  playlistId: null,
  mediaId: null,
  count: 1,
  at: null,
  hard: false,
  ...p,
});

describe('time zones', () => {
  it('reads the wall clock and finds the instant of a wall clock time, also around daylight saving', () => {
    const t = Date.UTC(2026, 9, 26, 9, 58, 30); // Monday 10:58:30 in Amsterdam (winter time)
    expect(wallTime(t, TZ)).toMatchObject({ date: '2026-10-26', weekday: 1, hour: 10, minute: 58, minuteOfDay: 658 });
    expect(new Date(hourStart(t, TZ)).toISOString()).toBe('2026-10-26T09:00:00.000Z');
    expect(new Date(zonedInstant('2026-10-26', 600, TZ)).toISOString()).toBe('2026-10-26T09:00:00.000Z');
    expect(new Date(zonedInstant('2026-07-01', 600, TZ)).toISOString()).toBe('2026-07-01T08:00:00.000Z');
    expect(new Date(zonedInstant('2026-03-29', 180, TZ)).toISOString()).toBe('2026-03-29T01:00:00.000Z');
    // Half-hour zones keep their own hours.
    expect(new Date(hourStart(Date.UTC(2026, 0, 1, 10, 50), 'Asia/Kolkata')).toISOString()).toBe('2026-01-01T10:30:00.000Z');
  });
});

describe('schedule blocks', () => {
  const block = (p: Partial<Block> & { id: string }): Block => ({ days: [], date: null, startMinute: 0, durationMinutes: 60, enabled: true, ...p });
  const morning = block({ id: 'morning', days: [1, 2, 3, 4, 5], startMinute: 6 * 60, durationMinutes: 240 });
  const show = block({ id: 'show', days: [1], startMinute: 8 * 60, durationMinutes: 60 });
  const night = block({ id: 'night', days: [7], startMinute: 22 * 60, durationMinutes: 240 });
  const special = block({ id: 'special', date: '2026-10-26', startMinute: 6 * 60, durationMinutes: 30 });
  const all = [morning, show, night, special];

  it('picks the block that runs, the later start inside a longer block, and one-off blocks first', () => {
    expect(blockAt(all, local('2026-10-26', '07:00'), TZ)?.id).toBe('morning');
    expect(blockAt(all, local('2026-10-26', '08:30'), TZ)?.id).toBe('show');
    expect(blockAt(all, local('2026-10-27', '08:30'), TZ)?.id).toBe('morning');
    expect(blockAt(all, local('2026-10-26', '06:10'), TZ)?.id).toBe('special');
    expect(blockAt(all, local('2026-10-26', '11:00'), TZ)).toBeNull();
    // Sunday night runs into Monday.
    expect(blockAt(all, local('2026-10-26', '01:30'), TZ)?.id).toBe('night');
    expect(blockAt(all, local('2026-10-26', '02:30'), TZ)).toBeNull();
    expect(blockAt([{ ...show, enabled: false }], local('2026-10-26', '08:30'), TZ)).toBeNull();
  });

  it('lists the runs in a period', () => {
    const runs = occurrences([show, night], local('2026-10-25', '00:00'), local('2026-10-27', '00:00'), TZ);
    expect(runs.map((r) => [r.block.id, new Date(r.start).toISOString()])).toEqual([
      ['night', '2026-10-25T21:00:00.000Z'],
      ['show', '2026-10-26T07:00:00.000Z'],
    ]);
  });
});

describe('hour clock', () => {
  const news = item({ kind: 'playlist', playlistId: 'news', at: 0, label: 'News' });
  const jingle = item({ kind: 'playlist', playlistId: 'jingles' });
  const rotation = item({ kind: 'rotation' });
  const ads = item({ kind: 'playlist', playlistId: 'ads', at: 30, count: 2, hard: true });
  const clock: ClockLike = { id: 'hit', items: [news, jingle, rotation, ads, rotation] };
  const empty: ClockState = { hour: null, clockId: null, step: 0, done: 0 };

  /** Plays tracks of `seconds` from `start`, `n` times, and returns what each one was. */
  function run(start: number, n: number, seconds = 200, clockAt: (t: number) => ClockLike | null = () => clock) {
    let state = empty;
    let at = start;
    const out: string[] = [];
    for (let i = 0; i < n; i++) {
      const d = decide({ at, now: at, tz: TZ, clockAt, state, musicSeconds: seconds });
      state = d.state;
      const w = wallTime(at, TZ);
      const when = `${String(w.hour).padStart(2, '0')}:${String(w.minute).padStart(2, '0')}`;
      out.push(`${when} ${d.kind === 'item' ? d.item.playlistId : d.playlistId ? `music:${d.playlistId}` : 'music'}`);
      at += seconds * 1000;
    }
    return out;
  }

  it('starts the hour with its first item, plays the items in order and music until a timed item', () => {
    const plan = run(local('2026-10-26', '10:00'), 12);
    expect(plan.slice(0, 3)).toEqual(['10:00 news', '10:03 jingles', '10:06 music']);
    // Commercials at half past: two of them, then music.
    expect(plan.filter((p) => p.endsWith('ads'))).toEqual(['10:30 ads', '10:33 ads']);
    expect(plan.at(-1)).toBe('10:36 music');
  });

  it('starts a timed item at the track change nearest to its minute', () => {
    // 200 s tracks: the change at 10:56:40 is followed by one at 11:00:00, which is closer to the news.
    const plan = run(local('2026-10-26', '10:50'), 6);
    expect(plan).toContain('11:00 news');
    // 300 s tracks: from 10:53 the change at 10:58 is closest (2 minutes early), from 10:52 the one at 11:02.
    expect(run(local('2026-10-26', '10:53'), 3, 300)[1]).toBe('10:58 news');
    expect(run(local('2026-10-26', '10:52'), 3, 300).slice(1)).toEqual(['10:57 music', '11:02 news']);
  });

  it('cuts the playing track for a hard timed item', () => {
    const state: ClockState = { hour: local('2026-10-26', '10:00'), clockId: 'hit', step: 2, done: 1 };
    const now = local('2026-10-26', '10:28');
    const d = decide({ at: local('2026-10-26', '10:31'), now, tz: TZ, clockAt: () => clock, state, musicSeconds: 200 });
    expect(d.kind).toBe('item');
    expect(d.kind === 'item' && d.cutAt).toBe(local('2026-10-26', '10:30'));
    // Soft items wait for the end of the track.
    const soft: ClockLike = { id: 'soft', items: [news, rotation, { ...ads, hard: false }] };
    const s = decide({ at: local('2026-10-26', '10:31'), now, tz: TZ, clockAt: () => soft, state: { ...state, clockId: 'soft', step: 1 }, musicSeconds: 200 });
    expect(s.kind === 'item' && s.cutAt).toBeNull();
  });

  it('picks up in the middle of an hour without playing items that are long overdue', () => {
    const items = clock.items;
    const hour = local('2026-10-26', '10:00');
    expect(entryStep(items, hour, hour + 2 * MIN)).toBe(0); // news a little late is fine
    expect(entryStep(items, hour, hour + 12 * MIN)).toBe(2); // music after the news
    expect(entryStep(items, hour, hour + 31 * MIN)).toBe(3); // the commercials, a minute late
    expect(entryStep(items, hour, hour + 45 * MIN)).toBe(4);
    // Judged by the time now, not by when the playing track ends.
    expect(entryStep(items, hour, hour + 37 * MIN, hour + 29 * MIN)).toBe(3);
    expect(run(local('2026-10-26', '10:12'), 1)).toEqual(['10:12 music']);
  });

  it('hands over to the next hour and to hours without a clock', () => {
    const at = (t: number) => (wallTime(t, TZ).hour === 11 ? null : clock);
    const plan = run(local('2026-10-26', '10:50'), 8, 200, at);
    expect(plan.filter((p) => p.includes('news'))).toEqual([]);
    const back = run(local('2026-10-26', '11:50'), 8, 200, at);
    expect(back).toContain('12:00 news');
  });

  it('fills with a playlist until the next timed item', () => {
    const special: ClockLike = { id: 'x', items: [news, item({ kind: 'playlist', playlistId: 'eighties', count: 0 })] };
    const plan = run(local('2026-10-26', '10:00'), 3, 200, () => special);
    expect(plan).toEqual(['10:00 news', '10:03 music:eighties', '10:06 music:eighties']);
  });
});

describe('scheduler API and AutoDJ', () => {
  let t: Awaited<ReturnType<typeof setup>>;
  let admin: { cookie: string };
  let stationId: string;
  const api = (method: string, url: string, payload?: unknown, headers = admin) =>
    t.app.inject({ method: method as 'GET', url: `/api/stations/${stationId}${url}`, headers, payload: payload as never });
  const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
  let newsId: string;
  let adsId: string;
  let dj: { cookie: string };

  beforeAll(async () => {
    t = await setup();
    admin = await login(t.app, 'admin@example.com', 'admin-password');
    const tenant = await t.app.inject({
      method: 'POST',
      url: '/api/tenants',
      headers: admin,
      payload: {
        name: 'Radio Schermer',
        slug: 'schermer',
        plan: 'station',
        limits: { maxStations: 2, maxListeners: 100, maxBitrateKbps: 192, storageQuotaMb: 100 },
        owner: { email: 'owner@schermer.nl', name: 'Owner', password: 'owner-password' },
      },
    });
    const res = await t.app.inject({ method: 'POST', url: '/api/stations', headers: admin, payload: { tenantId: tenant.json().id, name: 'Radio Schermer', slug: 'schermer', bitrateKbps: 128 } });
    stationId = res.json().id;
    expect((await api('POST', '/upgrade', {})).statusCode).toBe(200);
    await t.app.inject({
      method: 'POST',
      url: `/api/tenants/${tenant.json().id}/members`,
      headers: admin,
      payload: { email: 'dj@schermer.nl', name: 'DJ', password: 'dj-password-1', role: 'dj' },
    });
    dj = await login(t.app, 'dj@schermer.nl', 'dj-password-1');
  }, 60_000);

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(async () => {
    await t?.close();
  });

  it('keeps playlists that only clocks use out of the queues', async () => {
    const news = await api('POST', '/playlists', { name: 'News', queue: 'q1', order: 'sequential', rotation: false, folders: [{ location: 'storage', path: 'music/news' }] });
    expect(news.statusCode).toBe(201);
    expect(news.json().rotation).toBe(false);
    newsId = news.json().id;
    adsId = (await api('POST', '/playlists', { name: 'Commercials', queue: 'q1', rotation: false, folders: [{ location: 'storage', path: 'music/ads' }] })).json().id;
  });

  it('checks clocks: playlists of the station and timed items in order', async () => {
    const bad = await api('POST', '/clocks', {
      name: 'Wrong',
      items: [item({ kind: 'playlist', playlistId: newsId, at: 30 }), item({ kind: 'playlist', playlistId: adsId, at: 15 })],
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.message).toMatch(/follow each other in time/);
    const missing = await api('POST', '/clocks', { name: 'Wrong', items: [item({ kind: 'playlist', playlistId: '00000000-0000-4000-8000-000000000000' })] });
    expect(missing.statusCode).toBe(400);
    const ok = await api('POST', '/clocks', {
      name: 'Hit hour',
      color: '#3366FF',
      items: [
        item({ kind: 'playlist', playlistId: newsId, at: 0, label: 'News', hard: true }),
        item({ kind: 'rotation' }),
        item({ kind: 'playlist', playlistId: adsId, at: 30, count: 2 }),
        item({ kind: 'rotation', hard: true }),
      ],
    });
    expect(ok.statusCode).toBe(201);
    // "hard" only means something for timed items.
    expect(ok.json().items.map((i: ClockItem) => i.hard)).toEqual([true, false, false, false]);
  });

  it('runs a schedule with a default clock and shows, and tells what is on air', async () => {
    const view = (await api('GET', '/scheduler')).json();
    const clock = view.clocks[0];
    const saved = await api('PUT', '/scheduler', { ...view.settings, enabled: true, timezone: TZ, defaultClockId: clock.id });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().onAir.clockId).toBe(clock.id);
    expect((await api('PUT', '/scheduler', { ...view.settings, timezone: 'Mars/Olympus' })).statusCode).toBe(400);
    expect((await api('POST', '/schedule', { name: 'Nothing', startMinute: 60, durationMinutes: 60 })).statusCode).toBe(400);
    const now = wallTime(Date.now(), TZ);
    const show = await api('POST', '/schedule', {
      name: 'Morning show',
      description: 'Wake up!',
      live: true,
      days: [now.weekday],
      startMinute: Math.max(0, now.minuteOfDay - 30),
      durationMinutes: 120,
      clockId: null,
    });
    expect(show.statusCode).toBe(201);
    const after = (await api('GET', '/scheduler')).json();
    expect(after.onAir).toEqual({ entryId: show.json().id, clockId: null });
    const autodj = (await api('GET', '/autodj')).json();
    expect(autodj.schedule).toMatchObject({ enabled: true, entry: { name: 'Morning show', live: true }, clock: null });
    const pub = await t.app.inject({ method: 'GET', url: '/api/public/stations/schermer/schedule' });
    expect(pub.statusCode).toBe(200);
    expect(pub.json().onAir).toMatchObject({ name: 'Morning show', live: true });
    expect(pub.json().upcoming.length).toBeGreaterThan(0);
    const np = await t.app.inject({ method: 'GET', url: '/api/public/stations/schermer/nowplaying' });
    expect(np.json().schedule).toMatchObject({ enabled: true, show: { name: 'Morning show' } });
    await api('DELETE', `/schedule/${show.json().id}`);
  });

  it('lists the format of the coming hours for RHIS Studio', async () => {
    const res = await api('GET', '/autodj/rundown?hours=2');
    expect(res.statusCode).toBe(200);
    const { rows, timezone } = res.json() as { timezone: string; rows: { hour: string; startsAt: string; timed: boolean; hard: boolean; kind: string; source: string; label: string; count: number; seconds: number | null; clock: { name: string } | null; past: boolean }[] };
    expect(timezone).toBe(TZ);
    // Two hours of the default clock: news on the hour, music, two commercials at half past, music.
    expect(rows).toHaveLength(8);
    const hour = rows.slice(0, 4);
    expect(hour.map((r) => [r.kind, r.source, r.label])).toEqual([
      ['item', 'playlist', 'News'],
      ['music', 'queues', ''],
      ['item', 'playlist', 'Commercials'],
      ['music', 'queues', ''],
    ]);
    expect(hour[0]).toMatchObject({ timed: true, hard: true, clock: { name: 'Hit hour' } });
    expect(hour[2]).toMatchObject({ timed: true, count: 2 });
    expect(new Date(hour[2]!.startsAt).getTime() - new Date(hour[0]!.startsAt).getTime()).toBe(30 * MIN);
    // An item without a minute starts with the timed item before it.
    expect(hour[1]!.startsAt).toBe(hour[0]!.startsAt);
    // Expected lengths for backtiming: format items only, from the average track of their playlist.
    expect(hour[1]).toMatchObject({ seconds: null });
    expect(hour.every((r) => r.seconds === null || r.seconds > 0)).toBe(true);
    expect(new Date(rows[4]!.hour).getTime() - new Date(rows[0]!.hour).getTime()).toBe(60 * MIN);
    expect(rows.slice(4).every((r) => !r.past)).toBe(true);
  });

  it('keeps DJs of live shows to their shows when the station asks for it', async () => {
    const [account] = await t.db
      .insert(schema.stationAccounts)
      .values({ stationId, username: 'dj1', passwordHash: 'x' })
      .returning();
    const view = (await api('GET', '/scheduler')).json();
    expect(view.accounts.map((a: { username: string }) => a.username)).toContain('dj1');
    await api('PUT', '/scheduler', { ...view.settings, liveOnlyInShows: true, liveEarlyMinutes: 10 });
    const at = local('2026-10-26', '19:55');
    // Not a DJ of any show yet: not limited.
    expect(await outsideShow(t.ctx, stationId, account!.id, at)).toBeNull();
    const show = await api('POST', '/schedule', { name: 'Evening', live: true, accountIds: [account!.id], days: [1], startMinute: 20 * 60, durationMinutes: 60 });
    expect(show.statusCode).toBe(201);
    expect(await outsideShow(t.ctx, stationId, account!.id, at)).toBeNull(); // 5 minutes early
    expect(await outsideShow(t.ctx, stationId, account!.id, local('2026-10-26', '19:45'))).toEqual({ opensAt: local('2026-10-26', '19:50'), timezone: TZ });
    expect(await outsideShow(t.ctx, stationId, account!.id, local('2026-10-26', '20:59'))).toBeNull();
    expect(await outsideShow(t.ctx, stationId, account!.id, local('2026-10-26', '21:00'))).toEqual({ opensAt: local('2026-11-02', '19:50'), timezone: TZ });
    await api('DELETE', `/schedule/${show.json().id}`);
    await api('PUT', '/scheduler', { ...view.settings, liveOnlyInShows: false });
  });

  describe.runIf(hasFfmpeg)('with tracks', () => {
    const tone = (path: string, tags: Record<string, string>) => {
      mkdirSync(join(path, '..'), { recursive: true });
      const meta = Object.entries(tags).flatMap(([k, v]) => ['-metadata', `${k}=${v}`]);
      execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', ...meta, '-b:a', '64k', path]);
    };

    beforeAll(async () => {
      const dir = mediaDir(t.ctx, stationId);
      tone(join(dir, 'music', 'songs', 's1.mp3'), { artist: 'A', title: 'Song 1' });
      tone(join(dir, 'music', 'songs', 's2.mp3'), { artist: 'B', title: 'Song 2' });
      tone(join(dir, 'music', 'songs', 's3.mp3'), { artist: 'C', title: 'Song 3' });
      tone(join(dir, 'music', 'news', 'news.mp3'), { artist: 'Station', title: 'News' });
      tone(join(dir, 'music', 'ads', 'ad1.mp3'), { artist: 'Shop', title: 'Ad 1' });
      tone(join(dir, 'music', 'ads', 'ad2.mp3'), { artist: 'Garage', title: 'Ad 2' });
      await scanLibrary(t.ctx, stationId);
      const lists = (await api('GET', '/playlists')).json() as { id: string; name: string; rotation: boolean }[];
      const all = lists.find((l) => l.rotation)!;
      await api('PUT', `/playlists/${all.id}`, { ...all, folders: [{ location: 'storage', path: 'music/songs' }] });
      const settings = (await api('GET', '/autodj')).json().settings;
      await api('PUT', '/autodj', { ...settings, crossfadeSeconds: 0, artistSeparationMinutes: 0, trackSeparationMinutes: 0 });
    });

    it('plays the news on the hour, the commercials at half past and the queues in between', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(local('2026-10-26', '10:58'));
      await playerStarted(t.ctx, stationId);
      const play = async () => {
        const next = await nextTrack(t.ctx, stationId);
        await trackStarted(t.ctx, stationId, next!.itemId);
        const [row] = await t.db.select().from(schema.queueItems).where(eq(schema.queueItems.id, next!.itemId));
        const [media] = await t.db.select().from(schema.mediaFiles).where(eq(schema.mediaFiles.id, row!.mediaId));
        return { origin: row!.origin, label: row!.label, title: media!.title, cutAt: next!.cutAt };
      };
      // The commercials of this hour are long overdue: music.
      expect((await play()).origin).toBe('rotation');
      vi.setSystemTime(local('2026-10-26', '10:59') + 59_500);
      const news = await play();
      expect(news).toMatchObject({ origin: 'clock', label: 'News', title: 'News', cutAt: null });
      expect((await play()).title).toMatch(/^Song/);
      const view = (await api('GET', '/autodj')).json();
      expect(view.nowPlaying.media.title).toMatch(/^Song/);
      vi.setSystemTime(local('2026-10-26', '11:29') + 59_000);
      const first = await play();
      const second = await play();
      expect([first.title, second.title].sort()).toEqual(['Ad 1', 'Ad 2']);
      expect(first.label).toBe('Commercials');
      expect((await play()).origin).toBe('rotation');
      const [state] = await t.db.select().from(schema.autodjState).where(eq(schema.autodjState.stationId, stationId));
      expect(state!.clockStep).toBe(3);
    });

    it('takes a clock track out of the queue when its playlist overlaps the rotation', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const songs = (await api('POST', '/playlists', { name: 'Songs again', rotation: false, folders: [{ location: 'storage', path: 'music/songs' }] })).json();
      const view = (await api('GET', '/scheduler')).json();
      const clock = (
        await api('POST', '/clocks', { name: 'Overlap', items: [item({ kind: 'playlist', playlistId: songs.id, at: 0, label: 'Power play' }), item({ kind: 'rotation' })] })
      ).json();
      await api('PUT', '/scheduler', { ...view.settings, defaultClockId: clock.id });
      // Every song is waiting in Q1 already.
      const settings = (await api('GET', '/autodj')).json().settings;
      await api('PUT', '/autodj', { ...settings, queueDepth: 5 });
      vi.setSystemTime(local('2026-10-26', '12:00') + 1000);
      const next = await nextTrack(t.ctx, stationId);
      expect(next!.skipped).toEqual([]);
      const [row] = await t.db.select().from(schema.queueItems).where(eq(schema.queueItems.id, next!.itemId));
      expect(row).toMatchObject({ origin: 'clock', label: 'Power play' });
      const same = await t.db.select().from(schema.queueItems).where(eq(schema.queueItems.mediaId, row!.mediaId));
      expect(same).toHaveLength(1);
    });
    it('keeps DJs from skipping or interrupting a locked item; managers go ahead after a question', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const view = (await api('GET', '/scheduler')).json();
      const news = (await t.db.select().from(schema.mediaFiles).where(eq(schema.mediaFiles.title, 'News')))[0]!;
      const clock = (await api('POST', '/clocks', { name: 'Locked news', items: [item({ kind: 'track', mediaId: news.id, at: 0, label: 'News', locked: true }), item({ kind: 'rotation' })] })).json();
      expect(clock.items[0].locked).toBe(true);
      await api('PUT', '/scheduler', { ...view.settings, enabled: true, defaultClockId: clock.id });
      vi.setSystemTime(local('2026-10-26', '14:00') + 1000);
      await playerStarted(t.ctx, stationId);
      const next = await nextTrack(t.ctx, stationId);
      await trackStarted(t.ctx, stationId, next!.itemId);
      expect((await api('GET', '/autodj')).json().nowPlaying).toMatchObject({ label: 'News', locked: true });
      const rundown = (await api('GET', '/autodj/rundown?hours=1')).json() as { rows: { label: string; locked: boolean }[] };
      expect(rundown.rows.find((r) => r.label === 'News')!.locked).toBe(true);
      expect((await api('POST', '/autodj/skip', {}, dj)).statusCode).toBe(403);
      expect((await api('POST', '/autodj/play-now', { mediaId: news.id }, dj)).statusCode).toBe(403);
      const asked = await api('POST', '/autodj/skip', {});
      expect(asked.statusCode).toBe(409);
      expect(asked.json().error.code).toBe('locked');
      expect((await api('POST', '/autodj/skip', { force: true })).statusCode).toBe(200);
    });
    it('drops the track loaded ahead when a hard item is added before the playing track ends (#27)', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const view = (await api('GET', '/scheduler')).json();
      const clock = (await api('POST', '/clocks', { name: 'Music only', items: [item({ kind: 'rotation', at: 0 })] })).json();
      await api('PUT', '/scheduler', { ...view.settings, enabled: true, defaultClockId: clock.id });
      vi.setSystemTime(local('2026-10-26', '13:04'));
      await playerStarted(t.ctx, stationId);
      const playing = await nextTrack(t.ctx, stationId);
      await trackStarted(t.ctx, stationId, playing!.itemId);
      // The player loads the next track as soon as this one starts.
      const ahead = await nextTrack(t.ctx, stationId);
      const [row] = await t.db.select().from(schema.queueItems).where(eq(schema.queueItems.id, playing!.itemId));
      const [media] = await t.db.select().from(schema.mediaFiles).where(eq(schema.mediaFiles.id, row!.mediaId));
      await t.db.update(schema.mediaFiles).set({ durationSeconds: 300 }).where(eq(schema.mediaFiles.id, media!.id));
      try {
        // Nothing timed in the way yet.
        expect(await flushForClock(t.ctx, stationId)).toBe(false);
        const news = (await t.db.select().from(schema.mediaFiles).where(eq(schema.mediaFiles.title, 'News')))[0]!;
        await api('PUT', `/clocks/${clock.id}`, { ...clock, items: [...clock.items, item({ kind: 'track', mediaId: news.id, at: 6, hard: true, label: 'News' })] });
        expect(await flushForClock(t.ctx, stationId)).toBe(true);
        const [back] = await t.db.select().from(schema.queueItems).where(eq(schema.queueItems.id, ahead!.itemId));
        expect(back!.state).toBe('queued');
        const next = await nextTrack(t.ctx, stationId);
        const [cued] = await t.db.select().from(schema.queueItems).where(eq(schema.queueItems.id, next!.itemId));
        expect(cued).toMatchObject({ origin: 'clock', label: 'News' });
        expect(next!.cutAt).toBe(local('2026-10-26', '13:06'));
        // The item is loaded now: nothing more to drop.
        expect(await flushForClock(t.ctx, stationId)).toBe(false);
      } finally {
        await t.db.update(schema.mediaFiles).set({ durationSeconds: media!.durationSeconds }).where(eq(schema.mediaFiles.id, media!.id));
      }
    });
  });
});
