import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src/db/index.js';
import { scanLibrary, tagsFromFileName } from '../src/services/autodj/library.js';
import { autodjScriptPath, autodjSocketPath, autodjToken, encoder } from '../src/services/autodj/liquidsoap.js';
import { chooseQueue, nextTrack, playerStarted, requestUri, trackStarted, weightedPick } from '../src/services/autodj/planner.js';
import { mediaDir } from '../src/services/streaming/icecast.js';
import { buildStreamsState, runsHere, type Station } from '../src/services/streaming/state.js';
import { AutodjController } from '../src/streams/autodj.js';
import { heard, loadSnapshot, resolveMount } from '../src/streams/snapshot.js';
import { login, setup } from './helpers.js';

let t: Awaited<ReturnType<typeof setup>>;
let admin: { cookie: string };
let owner: { cookie: string };
let tenantId: string;
let stationId: string;

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const hasLiquidsoap = spawnSync('liquidsoap', ['--version']).status === 0;

/** A short MP3 with tags (or none). */
function tone(path: string, tags: Record<string, string> = {}, seconds = 2) {
  mkdirSync(join(path, '..'), { recursive: true });
  const meta = Object.entries(tags).flatMap(([k, v]) => ['-metadata', `${k}=${v}`]);
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`, ...meta, '-b:a', '64k', path]);
}

const api = (method: string, url: string, payload?: unknown, headers = owner) => t.app.inject({ method: method as 'GET', url: `/api/stations/${stationId}${url}`, headers, payload: payload as never });

beforeAll(async () => {
  t = await setup();
  admin = await login(t.app, 'admin@example.com', 'admin-password');
  tenantId = (
    await t.app.inject({
      method: 'POST',
      url: '/api/tenants',
      headers: admin,
      payload: {
        name: 'Harder FM',
        slug: 'harder',
        plan: 'distribution',
        limits: { maxStations: 2, maxListeners: 100, maxBitrateKbps: 192, storageQuotaMb: 100 },
        owner: { email: 'owner@harder.fm', name: 'Owner', password: 'owner-password' },
      },
    })
  ).json().id;
  owner = await login(t.app, 'owner@harder.fm', 'owner-password');
  const res = await t.app.inject({ method: 'POST', url: '/api/stations', headers: owner, payload: { tenantId, name: 'Harder FM', slug: 'harderfm', bitrateKbps: 128 } });
  expect(res.statusCode).toBe(201);
  stationId = res.json().id;
}, 60_000);

afterAll(async () => {
  await t?.close();
});

describe('queue rules', () => {
  const ratio = { mode: 'ratio' as const, q1: 3, q2: 1 };
  const both = { q1: true, q2: true };
  it('plays q1 tracks from Q1, then q2 from Q2', () => {
    const seq: string[] = [];
    let last: 'q1' | 'q2' | null = null;
    let streak = 0;
    for (let i = 0; i < 8; i++) {
      const q: 'q1' | 'q2' = chooseQueue(ratio, last, streak, both)!;
      streak = q === last ? streak + 1 : 1;
      last = q;
      seq.push(q);
    }
    expect(seq.join(' ')).toBe('q1 q1 q1 q2 q1 q1 q1 q2');
  });
  it('alternates, prefers a queue, and falls back to the other when one is empty', () => {
    expect(chooseQueue({ mode: 'alternate', q1: 1, q2: 1 }, 'q1', 1, both)).toBe('q2');
    expect(chooseQueue({ mode: 'alternate', q1: 1, q2: 1 }, null, 0, both)).toBe('q1');
    expect(chooseQueue({ mode: 'q2_first', q1: 1, q2: 1 }, 'q2', 9, both)).toBe('q2');
    expect(chooseQueue({ mode: 'q2_first', q1: 1, q2: 1 }, 'q2', 9, { q1: true, q2: false })).toBe('q1');
    expect(chooseQueue(ratio, 'q1', 1, { q1: false, q2: false })).toBeNull();
  });
  it('picks playlists by weight', () => {
    const lists = [{ id: 'a', weight: 1 }, { id: 'b', weight: 3 }];
    expect(weightedPick(lists, () => 0.1)!.id).toBe('a');
    expect(weightedPick(lists, () => 0.5)!.id).toBe('b');
    expect(weightedPick([], () => 0.5)).toBeNull();
  });
  it('reads artist and title from file names', () => {
    expect(tagsFromFileName('music/01 - Headhunterz - Dragonborn.mp3')).toEqual({ artist: 'Headhunterz', title: 'Dragonborn' });
    expect(tagsFromFileName('jingle_station_id.mp3')).toEqual({ artist: '', title: 'jingle station id' });
  });
  it('escapes metadata in request URIs', () => {
    const uri = requestUri({ id: 'i1', queue: 'q2' }, { title: 'Say "hi"', artist: 'A\\B', album: '', gainDb: -4.5 } as never, '/m/x.mp3', { normalize: true } as never);
    expect(uri).toBe('annotate:hrs_item="i1",hrs_queue="q2",title="Say \\"hi\\"",artist="A\\\\B",liq_amplify="-4.50 dB":/m/x.mp3');
  });
  it('makes encoders for every format', () => {
    expect(encoder('mp3', 128)).toContain('%mp3');
    expect(encoder('aac', 96)).toContain('codec="aac"');
    expect(encoder('opus', 64)).toContain('%opus');
    expect(encoder('vorbis', 128)).toContain('%vorbis');
  });
});

describe('upgrade to Radio station', () => {
  it('needs the Radio station plan, which administrators can grant in the same step', async () => {
    expect((await api('GET', '/autodj')).json().edition).toBe('distribution');
    expect((await api('GET', '/library')).statusCode).toBe(400);
    const denied = await api('POST', '/upgrade', { upgradeCustomer: true });
    expect(denied.statusCode).toBe(400);
    const res = await api('POST', '/upgrade', { upgradeCustomer: true }, admin);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.edition).toBe('station');
    expect(body.settings.enabled).toBe(true);
    expect(body.mount).toMatchObject({ path: '/autodj', format: 'mp3', bitrateKbps: 128 });
    expect(body.coveredMounts).toEqual(['/live']);
    expect(body.library.playlists).toBe(1);
    const [tenant] = await t.db.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId));
    expect(tenant!.plan).toBe('station');
  });

  it('adds a private AutoDJ mount the live mount falls back to, and writes the player script', async () => {
    const mounts = await t.db.select().from(schema.stationMounts).where(eq(schema.stationMounts.stationId, stationId));
    const autodj = mounts.find((m) => m.path === '/autodj')!;
    const live = mounts.find((m) => m.path === '/live')!;
    expect(autodj.isPublic).toBe(false);
    expect(live.fallbackMountId).toBe(autodj.id);
    const script = await readFile(autodjScriptPath(t.ctx, stationId), 'utf8');
    expect(script).toContain('mount="/autodj"');
    expect(script).toContain(autodjToken(t.ctx, stationId));
    expect(script).toContain('crossfade(');
    expect(script).toContain('%mp3.cbr(bitrate=128');
    // Manual playout: the queue only plays once armed; in between the player holds.
    expect(script).toContain('[gated, hold, emergency]');
    expect(script).toContain('server.register("play"');
    expect(script).toContain('server.register("manual"');
    // The track is reported when the gate lets it through, not when the queue begins it (it may wait for play).
    expect(script).toMatch(/gated = source.on_track\(switch\(id="hrs_gate".*hrs_on_air\)/);
    // Leaving the hold (play, or back to Auto) reports the cued track too: 2.3 does not always start a gate track then.
    expect(script).toMatch(/if not on then hrs_release\(held\) end/);
    const icecast = await readFile(join(t.ctx.config.DATA_DIR, 'stations', stationId, 'icecast.xml'), 'utf8');
    expect(icecast).toMatch(/<mount-name>\/live<\/mount-name>[\s\S]*<fallback-mount>\/autodj<\/fallback-mount>/);
    const state = await buildStreamsState(t.ctx);
    expect(state.autodj.map((a) => a.id)).toEqual([stationId]);
  });

  it('runs a station here unless it is on a station node, and while it warms up to move back', () => {
    const move = { direction: 'to_main', nodeId: 'n', state: 'copying', files: 0, filesDone: 0, bytes: 0, bytesDone: 0, startedAt: '' } as const;
    const st = (s: Partial<Station>) => ({ nodeId: null, nodeMove: null, ...s }) as Station;
    expect(runsHere(st({}))).toBe(true);
    expect(runsHere(st({ nodeId: 'n' }))).toBe(false);
    expect(runsHere(st({ nodeId: 'n', nodeMove: move }))).toBe(false);
    expect(runsHere(st({ nodeId: 'n', nodeMove: { ...move, warm: true } }))).toBe(true);
    expect(runsHere(st({ nodeId: 'n', nodeMove: { ...move, direction: 'to_node', warm: true } }))).toBe(false);
  });

  it.runIf(hasLiquidsoap)('writes a script Liquidsoap accepts', async () => {
    const r = spawnSync('liquidsoap', ['--check', autodjScriptPath(t.ctx, stationId)], { encoding: 'utf8' });
    expect(r.stderr.replace(/Warning[^\n]*\n?/g, '').trim()).toBe('');
    expect(r.status).toBe(0);
  });

  it('keeps encoders off the AutoDJ mount', async () => {
    const snap = await loadSnapshot(t.ctx);
    expect(resolveMount(snap, null, '/harderfm/live')?.mount.path).toBe('/live');
    expect(resolveMount(snap, null, '/harderfm/autodj')).toBeNull();
    const view = snap.stations.get(stationId)!;
    const live = view.mounts.find((m) => m.path === '/live')!;
    expect(heard(view, live, new Map([['/autodj', {}]]))).toBe(true);
    expect(heard(view, live, new Map())).toBe(false);
    expect(AutodjController.fallsBackTo(view, view.autodjMount!.id).map((m) => m.path)).toEqual(['/live']);
  });

  it('refuses to delete the mount the AutoDJ feeds', async () => {
    const mounts = await t.db.select().from(schema.stationMounts).where(eq(schema.stationMounts.stationId, stationId));
    const res = await api('DELETE', `/mounts/${mounts.find((m) => m.path === '/autodj')!.id}`);
    expect(res.statusCode).toBe(409);
  });
});

describe('manual playout and the queue rule (RHIS Studio)', () => {
  it('switches to manual and back to Auto by itself when the client stops renewing it', async () => {
    let res = await api('POST', '/autodj/mode', { manual: true });
    expect(res.statusCode).toBe(200);
    expect(res.json().playout.manual).toBe(true);
    const until = new Date(res.json().playout.until).getTime();
    expect(until - Date.now()).toBeGreaterThan(20_000);
    expect(until - Date.now()).toBeLessThanOrEqual(30_000);
    // The client dropped away: its last renewal ran out.
    await t.db.update(schema.autodjState).set({ manualUntil: new Date(Date.now() - 1000) }).where(eq(schema.autodjState.stationId, stationId));
    expect((await api('GET', '/autodj')).json().playout).toEqual({ manual: false, holding: false, until: null });
    res = await api('POST', '/autodj/mode', { manual: true });
    res = await api('POST', '/autodj/mode', { manual: false });
    expect(res.json().playout.manual).toBe(false);
    expect((await api('POST', '/autodj/play')).statusCode).toBe(200);
    expect((await api('POST', '/autodj/stop')).statusCode).toBe(200);
  });

  it('tells the player, again when the time runs out, and reads whether it holds', async () => {
    const path = autodjSocketPath(t.ctx, stationId);
    const heard: string[] = [];
    const server = net.createServer((c) => {
      c.on('data', (d) => {
        const cmd = d.toString().split('\n')[0]!;
        heard.push(cmd);
        c.end(`${cmd === 'holding' ? 'true' : 'OK'}\nEND\n`);
      });
    });
    rmSync(path, { force: true });
    await new Promise<void>((r) => server.listen(path, () => r()));
    try {
      const ctrl = new AutodjController(t.ctx, pino({ level: 'silent' }));
      await api('POST', '/autodj/mode', { manual: true });
      const snap = await loadSnapshot(t.ctx);
      await ctrl.sync(snap, []);
      expect(heard).toContain('manual true');
      expect(heard).toContain('holding');
      expect(ctrl.snapshot()[stationId]).toMatchObject({ manual: true, holding: true });
      heard.length = 0;
      await t.db.update(schema.autodjState).set({ manualUntil: new Date(Date.now() - 1000) }).where(eq(schema.autodjState.stationId, stationId));
      await ctrl.sync(snap, []);
      expect(heard).toContain('manual false');
      expect(ctrl.snapshot()[stationId]).toMatchObject({ manual: false, holding: false });
      heard.length = 0;
      await ctrl.command(JSON.stringify({ stationId, command: 'play' }));
      expect(heard).toEqual(['play']);
    } finally {
      server.close();
      rmSync(path, { force: true });
    }
  });

  it('lets DJs choose how the queues take turns', async () => {
    const res = await api('PUT', '/queue-rule', { mode: 'ratio', q1: 1, q2: 3 });
    expect(res.statusCode).toBe(200);
    expect(res.json().settings.rule).toEqual({ mode: 'ratio', q1: 1, q2: 3 });
    expect((await api('PUT', '/queue-rule', { mode: 'sometimes' })).statusCode).toBe(400);
    await api('PUT', '/queue-rule', { mode: 'ratio', q1: 3, q2: 1 });
  });
});

describe.runIf(hasFfmpeg)('library and AutoDJ', () => {
  let music: string;

  beforeAll(() => {
    music = mediaDir(t.ctx, stationId);
    tone(join(music, 'music', 'hardstyle', 'a1.mp3'), { artist: 'Artist A', title: 'One', album: 'Album', REPLAYGAIN_TRACK_GAIN: '-6.20 dB' });
    tone(join(music, 'music', 'hardstyle', 'a2.mp3'), { artist: 'Artist A', title: 'Two' });
    tone(join(music, 'music', 'hardstyle', 'b1.mp3'), { artist: 'Artist B', title: 'Three' });
    tone(join(music, 'music', 'hardstyle', 'c1.mp3'), { artist: 'Artist C', title: 'Four' });
    tone(join(music, 'music', 'jingles', 'Station - Jingle 1.mp3'));
    tone(join(music, 'music', 'jingles', 'Station - Jingle 2.mp3'));
    tone(join(music, 'ondemand', 'show.mp3'), { title: 'Show' });
    writeFileSync(join(music, 'music', 'notes.txt'), 'not audio');
  });

  it('scans tags, lengths and ReplayGain, and leaves on-demand files out', async () => {
    const p = await scanLibrary(t.ctx, stationId);
    expect(p.errors).toEqual([]);
    expect(p.added).toBe(6);
    const res = await api('GET', '/library?sort=title');
    const items = res.json().items as { title: string; artist: string; album: string; durationSeconds: number; gainDb: number | null; path: string; playlistIds: string[] }[];
    expect(items.map((i) => i.title)).toEqual(['Four', 'Jingle 1', 'Jingle 2', 'One', 'Three', 'Two']);
    const one = items.find((i) => i.title === 'One')!;
    expect(one).toMatchObject({ artist: 'Artist A', album: 'Album', path: 'music/hardstyle/a1.mp3' });
    expect(one.durationSeconds).toBeGreaterThan(1.5);
    expect(one.gainDb).toBeCloseTo(-6.2, 1);
    expect(items.find((i) => i.title === 'Jingle 1')!.artist).toBe('Station');
    // Everything is in the "All music" playlist made by the upgrade.
    expect(items.every((i) => i.playlistIds.length === 1)).toBe(true);
    const folders = (await api('GET', '/library/folders')).json();
    expect(folders.folders.map((f: { path: string }) => f.path)).toEqual(['music/hardstyle', 'music/jingles']);
    expect(folders.locations[0]).toMatchObject({ id: 'storage', tracks: 6 });
  });

  it('keeps corrected tags and drops removed files on the next scan', async () => {
    const [two] = await t.db.select().from(schema.mediaFiles).where(eq(schema.mediaFiles.title, 'Two'));
    expect((await api('PATCH', `/library/${two!.id}`, { title: 'Two (Edit)' })).statusCode).toBe(200);
    tone(join(music, 'music', 'hardstyle', 'a2.mp3'), { artist: 'Artist A', title: 'Two' }, 3);
    tone(join(music, 'music', 'extra.mp3'), { artist: 'Gone', title: 'Soon' });
    let p = await scanLibrary(t.ctx, stationId);
    expect(p).toMatchObject({ added: 1, updated: 1, removed: 0 });
    const [after] = await t.db.select().from(schema.mediaFiles).where(eq(schema.mediaFiles.id, two!.id));
    expect(after!.title).toBe('Two (Edit)');
    expect(after!.durationSeconds).toBeGreaterThan(2.5);
    rmSync(join(music, 'music', 'extra.mp3'));
    p = await scanLibrary(t.ctx, stationId);
    expect(p.removed).toBe(1);
  });

  it('fills Q1 and Q2 from their playlists and plays them by the rule, keeping artists apart', async () => {
    const lists = (await api('GET', '/playlists')).json();
    const all = lists[0];
    // Music in Q1, jingles in Q2: three songs, then one jingle.
    expect((await api('PUT', `/playlists/${all.id}`, { ...all, folders: [{ location: 'storage', path: 'music/hardstyle' }] })).statusCode).toBe(200);
    const jingles = await api('POST', '/playlists', { name: 'Jingles', queue: 'q2', weight: 5, order: 'sequential', folders: [{ location: 'storage', path: 'music/jingles' }] });
    expect(jingles.statusCode).toBe(201);
    expect(jingles.json().trackCount).toBe(2);
    const current = (await api('GET', '/autodj')).json().settings;
    const saved = await api('PUT', '/autodj', { ...current, queueDepth: 2, crossfadeSeconds: 0, artistSeparationMinutes: 60, trackSeparationMinutes: 600, rule: { mode: 'ratio', q1: 3, q2: 1 } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().queues.q1).toHaveLength(2);
    expect(saved.json().queues.q2).toHaveLength(2);
    expect(await readFile(autodjScriptPath(t.ctx, stationId), 'utf8')).not.toContain('crossfade(');

    await playerStarted(t.ctx, stationId);
    const played: { queue: string; artist: string; title: string }[] = [];
    for (let i = 0; i < 8; i++) {
      const next = await nextTrack(t.ctx, stationId);
      expect(next).not.toBeNull();
      const meta = Object.fromEntries([...next!.uri.matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g)].map((m) => [m[1], m[2]]));
      expect(next!.uri).toMatch(/:\/.+\.mp3$/);
      played.push({ queue: meta.hrs_queue!, artist: meta.artist ?? '', title: meta.title! });
      await trackStarted(t.ctx, stationId, next!.itemId);
    }
    expect(played.map((p) => p.queue).join(' ')).toBe('q1 q1 q1 q2 q1 q1 q1 q2');
    // Sequential jingles take turns.
    expect(played.filter((p) => p.queue === 'q2').map((p) => p.title)).toEqual(['Jingle 1', 'Jingle 2']);
    // The first three songs are three different artists (separation), even though Artist A has two tracks.
    expect(new Set(played.slice(0, 3).map((p) => p.artist)).size).toBe(3);
    const view = (await api('GET', '/autodj')).json();
    expect(view.nowPlaying.media.title).toBe(played.at(-1)!.title);
    const [one] = await t.db.select().from(schema.mediaFiles).where(eq(schema.mediaFiles.title, 'One'));
    expect(one!.playCount).toBeGreaterThan(0);
  });

  it('puts tracks back when the player restarts, and skips missing files', async () => {
    const next = await nextTrack(t.ctx, stationId);
    const [cued] = await t.db.select().from(schema.queueItems).where(eq(schema.queueItems.id, next!.itemId));
    expect(cued!.state).toBe('cued');
    await playerStarted(t.ctx, stationId);
    const [back] = await t.db.select().from(schema.queueItems).where(eq(schema.queueItems.id, next!.itemId));
    expect(back!.state).toBe('queued');
    // A file that disappeared without a rescan is dropped from the queue.
    const media = await t.db.select().from(schema.mediaFiles).where(eq(schema.mediaFiles.id, back!.mediaId));
    const full = join(music, media[0]!.path);
    const copy = `${full}.bak`;
    execFileSync('mv', [full, copy]);
    const other = await nextTrack(t.ctx, stationId);
    expect(other!.itemId).not.toBe(back!.id);
    execFileSync('mv', [copy, full]);
  });

  it('lets DJs add, move and remove queue tracks', async () => {
    const [four] = await t.db.select().from(schema.mediaFiles).where(eq(schema.mediaFiles.title, 'Four'));
    let res = await api('POST', '/autodj/queue', { mediaId: four!.id, queue: 'q2', at: 'top' });
    expect(res.statusCode).toBe(200);
    let q2 = res.json().queues.q2 as { id: string; origin: string; state: string; media: { title: string } }[];
    const added = q2.find((r) => r.media.title === 'Four' && r.origin === 'manual')!;
    expect(q2.filter((r) => r.state === 'queued')[0]!.id).toBe(added.id);
    res = await api('PATCH', `/autodj/queue/${added.id}`, { queue: 'q1', beforeId: null });
    expect(res.json().queues.q1.at(-1).id).toBe(added.id);
    res = await api('DELETE', `/autodj/queue/${added.id}`);
    expect(res.json().queues.q1.some((r: { id: string }) => r.id === added.id)).toBe(false);
    expect((await api('POST', '/autodj/skip')).statusCode).toBe(200);
  });

  it('takes requests from the library and queues them in order', async () => {
    const pub = await t.app.inject({ method: 'GET', url: '/api/stations/' + stationId + '/public', headers: owner });
    await t.app.inject({ method: 'PUT', url: `/api/stations/${stationId}/public`, headers: owner, payload: { ...pub.json().settings, requests: { enabled: true, onlyWhenLive: false, perHour: 5, message: '' } } });
    const np = await t.app.inject({ url: '/api/public/stations/harderfm/nowplaying' });
    expect(np.json().requests).toMatchObject({ enabled: true, open: true, library: true });
    const settings = (await api('GET', '/autodj')).json().settings;
    await api('PUT', '/autodj', { ...settings, requests: { ...settings.requests, repeatMinutes: 0 } });
    const search = await t.app.inject({ url: '/api/public/stations/harderfm/library?q=artist' });
    expect(search.statusCode).toBe(200);
    const items = search.json().items as { id: string; title: string; requestable: boolean }[];
    const pick = items.filter((i) => i.requestable);
    expect(pick.length).toBeGreaterThan(0);
    const ids: string[] = [];
    for (const title of ['Three', 'Four']) {
      const [m] = await t.db.select().from(schema.mediaFiles).where(eq(schema.mediaFiles.title, title));
      await t.db.delete(schema.queueItems).where(eq(schema.queueItems.mediaId, m!.id));
      const res = await t.app.inject({ method: 'POST', url: '/api/public/stations/harderfm/requests', payload: { mediaId: m!.id, name: 'Listener' }, remoteAddress: `10.0.0.${ids.length + 1}` });
      expect(res.statusCode).toBe(200);
      expect(res.json().queued).toBe(true);
      ids.push(res.json().id);
    }
    const [three] = await t.db.select().from(schema.mediaFiles).where(eq(schema.mediaFiles.title, 'Three'));
    const dup = await t.app.inject({ method: 'POST', url: '/api/public/stations/harderfm/requests', payload: { mediaId: three!.id }, remoteAddress: '10.0.0.9' });
    expect(dup.statusCode).toBe(409);
    const q1 = (await api('GET', '/autodj')).json().queues.q1 as { state: string; origin: string; requestId: string | null; media: { title: string } }[];
    const waiting = q1.filter((r) => r.state === 'queued');
    expect(waiting.slice(0, 2).map((r) => r.media.title)).toEqual(['Three', 'Four']);
    expect(waiting[0]!.origin).toBe('request');
    // Played → the request is marked played.
    const item = await t.db.select().from(schema.queueItems).where(eq(schema.queueItems.requestId, ids[0]!));
    await trackStarted(t.ctx, stationId, item[0]!.id);
    const [req] = await t.db.select().from(schema.songRequests).where(eq(schema.songRequests.id, ids[0]!));
    expect(req!.status).toBe('played');
  });

  it('queues accepted free-text requests that match a library track', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/public/stations/harderfm/requests', payload: { artist: 'artist c', title: 'four', name: 'X' }, remoteAddress: '10.0.1.1' });
    expect(res.json().queued).toBe(false);
    await t.db.delete(schema.queueItems).where(eq(schema.queueItems.origin, 'request'));
    const accepted = await t.app.inject({ method: 'PATCH', url: `/api/stations/${stationId}/requests/${res.json().id}`, headers: owner, payload: { status: 'accepted' } });
    expect(accepted.statusCode).toBe(200);
    const [row] = await t.db.select().from(schema.queueItems).where(eq(schema.queueItems.requestId, res.json().id));
    expect(row?.origin).toBe('request');
  });

  it('answers the player on the hook port, with its token only', async () => {
    const ctrl = new AutodjController(t.ctx, pino({ level: 'silent' }));
    const server = http.createServer((req, res) => {
      if (!ctrl.handle(req, res)) res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/autodj/${stationId}`;
    try {
      expect((await fetch(`${base}/next`, { method: 'POST', headers: { 'x-hrs-token': 'wrong' } })).status).toBe(403);
      const token = { 'x-hrs-token': autodjToken(t.ctx, stationId) };
      expect((await fetch(`${base}/start`, { method: 'POST', headers: token })).status).toBe(200);
      const next = await fetch(`${base}/next`, { method: 'POST', headers: token });
      const uri = await next.text();
      expect(uri).toMatch(/^annotate:hrs_item="([0-9a-f-]{36})"/);
      const item = uri.match(/hrs_item="([^"]+)"/)![1];
      expect((await fetch(`${base}/playing/${item}`, { method: 'POST', headers: token })).status).toBe(200);
      const [row] = await t.db.select().from(schema.queueItems).where(eq(schema.queueItems.id, item!));
      expect(row!.state).toBe('playing');
    } finally {
      server.close();
    }
  });

  it('uploads files into the music folder', async () => {
    const file = join(t.ctx.config.DATA_DIR, 'upload.mp3');
    tone(file, { artist: 'Uploaded', title: 'Track' });
    const boundary = '----hrs';
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="Uploaded - Track.mp3"\r\nContent-Type: audio/mpeg\r\n\r\n`),
      await readFile(file),
      Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="evil.sh"\r\nContent-Type: text/plain\r\n\r\necho\r\n--${boundary}--\r\n`),
    ]);
    const res = await t.app.inject({
      method: 'POST',
      url: `/api/stations/${stationId}/library/upload?folder=music/new`,
      headers: { ...owner, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().saved).toEqual(['music/new/Uploaded - Track.mp3']);
    expect(res.json().skipped.map((s: { name: string }) => s.name)).toEqual(['evil.sh']);
    expect(statSync(join(music, 'music', 'new', 'Uploaded - Track.mp3')).size).toBeGreaterThan(1000);
    const bad = await t.app.inject({ method: 'POST', url: `/api/stations/${stationId}/library/upload?folder=../x`, headers: { ...owner, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: body });
    expect(bad.statusCode).toBe(400);
  });
});

describe('shares', () => {
  it('passes SMB and NFS shares to the system helper, with the password in a private file', async () => {
    const smb = await api('POST', '/sources', { name: 'NAS', type: 'smb', config: { host: 'nas.local', share: 'Music/Hardstyle', username: 'radio', password: 'secret', version: '3.0' } });
    expect(smb.statusCode).toBe(201);
    expect(smb.json().config.password).toBe('••••••••');
    const nfs = await api('POST', '/sources', { name: 'NFS', type: 'nfs', config: { host: '10.0.0.5', export: '/export/music' } });
    expect(nfs.statusCode).toBe(201);
    expect((await api('POST', '/sources', { name: 'Bad', type: 'smb', config: { host: 'nas.local', share: '../etc' } })).statusCode).toBe(400);
    expect((await api('POST', '/sources', { name: 'Local', type: 'local', config: { path: '/tmp' } })).statusCode).toBe(403);
    const local = await api('POST', '/sources', { name: 'Server', type: 'local', config: { path: t.ctx.config.DATA_DIR } }, admin);
    expect(local.statusCode).toBe(201);
    const state = await buildStreamsState(t.ctx);
    expect(state.mediaMounts).toEqual(
      expect.arrayContaining([
        { id: smb.json().id, stationId, type: 'smb', host: 'nas.local', path: 'Music/Hardstyle', version: '3.0', credentials: true },
        { id: nfs.json().id, stationId, type: 'nfs', host: '10.0.0.5', path: '/export/music', version: '', credentials: false },
      ]),
    );
    const cred = join(t.ctx.config.DATA_DIR, 'run', 'media-credentials', smb.json().id);
    expect(await readFile(cred, 'utf8')).toBe('username=radio\npassword=secret\n');
    expect(statSync(cred).mode & 0o777).toBe(0o600);
    // Not mounted here: the scan reports it and leaves the library alone.
    const list = (await api('GET', '/sources')).json();
    expect(list.find((s: { id: string }) => s.id === smb.json().id).status.state).toBe('pending');
    expect((await api('DELETE', `/sources/${smb.json().id}`)).statusCode).toBe(200);
    await buildStreamsState(t.ctx);
    await expect(readFile(cred)).rejects.toThrow();
  });
});

describe('downgrade', () => {
  it('stops the AutoDJ and removes the fallback, keeping the library', async () => {
    const res = await api('POST', '/downgrade');
    expect(res.statusCode).toBe(200);
    const view = (await api('GET', '/autodj')).json();
    expect(view.edition).toBe('distribution');
    expect(view.settings.enabled).toBe(false);
    expect(view.coveredMounts).toEqual([]);
    await expect(readFile(autodjScriptPath(t.ctx, stationId))).rejects.toThrow();
    expect((await buildStreamsState(t.ctx)).autodj).toEqual([]);
    // Upgrading again restores it, now through the station settings.
    const again = await t.app.inject({ method: 'PATCH', url: `/api/stations/${stationId}`, headers: owner, payload: { edition: 'station' } });
    expect(again.statusCode).toBe(200);
    expect((await api('GET', '/autodj')).json()).toMatchObject({ edition: 'station', coveredMounts: ['/live'] });
  });
});
