import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src/db/index.js';
import { analysePending, measureBpm, measureKey } from '../src/services/autodj/analyse.js';
import { assignCodes, camelot, codePrefix, normaliseIsrc, normaliseKey, scanLibrary } from '../src/services/autodj/library.js';
import { mediaDir } from '../src/services/streaming/icecast.js';
import { login, setup } from './helpers.js';

let t: Awaited<ReturnType<typeof setup>>;
let owner: { cookie: string };
let stationId: string;

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const RATE = 11025;

/** A kick on every beat with a chord under it: something with a clear tempo and key. */
function song(bpm: number, notes: number[], seconds = 30) {
  const s = new Float32Array(RATE * seconds);
  const period = (60 / bpm) * RATE;
  for (let b = 0; b * period < s.length; b++) {
    const start = Math.round(b * period);
    for (let i = 0; i < 600 && start + i < s.length; i++) s[start + i]! += Math.exp(-i / 80) * Math.sin(i * 0.3) * 0.6;
  }
  for (const m of notes) {
    const f = 440 * 2 ** ((m - 69) / 12);
    for (let i = 0; i < s.length; i++) s[i]! += 0.12 * Math.sin((2 * Math.PI * f * i) / RATE);
  }
  return s;
}

/** 16-bit mono WAV. */
function wav(path: string, samples: Float32Array) {
  mkdirSync(join(path, '..'), { recursive: true });
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + samples.length * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(RATE, 24);
  buf.writeUInt32LE(RATE * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i]!)) * 32000), 44 + i * 2);
  writeFileSync(path, buf);
}

const api = (method: string, url: string, payload?: unknown) => t.app.inject({ method: method as 'GET', url: `/api/stations/${stationId}${url}`, headers: owner, payload: payload as never });

beforeAll(async () => {
  t = await setup();
  const admin = await login(t.app, 'admin@example.com', 'admin-password');
  const tenantId = (
    await t.app.inject({
      method: 'POST',
      url: '/api/tenants',
      headers: admin,
      payload: {
        name: 'Harder FM',
        slug: 'harder',
        plan: 'station',
        limits: { maxStations: 2, maxListeners: 100, maxBitrateKbps: 192, storageQuotaMb: 100 },
        owner: { email: 'owner@harder.fm', name: 'Owner', password: 'owner-password' },
      },
    })
  ).json().id;
  owner = await login(t.app, 'owner@harder.fm', 'owner-password');
  const res = await t.app.inject({ method: 'POST', url: '/api/stations', headers: owner, payload: { tenantId, name: 'Harder.FM', slug: 'harderfm', bitrateKbps: 128 } });
  stationId = res.json().id;
  expect((await api('POST', '/upgrade', {})).statusCode).toBe(200);
}, 60_000);

afterAll(async () => {
  await t?.close();
});

describe('keys, ISRCs and code prefixes', () => {
  it('reads keys however the tags write them', () => {
    expect(['Am', 'A minor', 'Amin', 'a', '8A', '08A', '1m'].map(normaliseKey)).toEqual(['Am', 'Am', 'Am', 'Am', 'Am', 'Am', 'Am']);
    expect(['C', 'C major', 'Cmaj', '8B', '1d'].map(normaliseKey)).toEqual(['C', 'C', 'C', 'C', 'C']);
    expect(['F#m', 'Gbm', 'F♯ minor', '11A'].map(normaliseKey)).toEqual(['F#m', 'F#m', 'F#m', 'F#m']);
    expect(['Bb', 'A#', 'B♭ major', '6B'].map(normaliseKey)).toEqual(['Bb', 'Bb', 'Bb', 'Bb']);
    expect(normaliseKey('o')).toBe('');
    expect(normaliseKey('13A')).toBe('');
    expect(['Am', 'C', 'F#m', 'Bb', 'x'].map(camelot)).toEqual(['8A', '8B', '11A', '6B', '']);
  });

  it('checks ISRCs and makes code prefixes from the station name', () => {
    expect(normaliseIsrc('nl-a1r-24-00123')).toBe('NLA1R2400123');
    expect(normaliseIsrc('NLA1R240012')).toBe('');
    expect(codePrefix({ name: 'Harder.FM', autodj: {} })).toBe('HF');
    expect(codePrefix({ name: 'Radio Schermer', autodj: {} })).toBe('RS');
    expect(codePrefix({ name: 'Qmusic', autodj: {} })).toBe('QMU');
    expect(codePrefix({ name: 'Radio Schermer', autodj: { codePrefix: 'RSX' } })).toBe('RSX');
  });

  it('measures tempo and key of the audio', () => {
    expect(measureBpm(song(128, [57, 60, 64]))).toBeCloseTo(128, 0);
    expect(measureBpm(song(150, [57, 60, 64]))).toBeCloseTo(150, 0);
    expect(measureBpm(song(174, [57, 60, 64]))).toBeCloseTo(174, 0);
    expect(measureKey(song(128, [57, 60, 64, 69]))).toBe('Am');
    expect(measureKey(song(128, [48, 52, 55, 60, 64]))).toBe('C');
    const noise = new Float32Array(RATE * 20).map(() => Math.random() - 0.5);
    expect(measureBpm(noise)).toBeNull();
    expect(measureKey(noise)).toBe('');
  });
});

describe.runIf(hasFfmpeg)('track codes, ISRC, tempo and key in the library', () => {
  let music: string;
  beforeAll(() => {
    music = mediaDir(t.ctx, stationId);
    mkdirSync(join(music, 'music'), { recursive: true });
    execFileSync('ffmpeg', [
      '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
      '-metadata', 'title=Tagged', '-metadata', 'artist=Artist', '-metadata', 'TBPM=150', '-metadata', 'TKEY=8A', '-metadata', 'TSRC=NL-A1R-24-00123',
      '-b:a', '64k', join(music, 'music', 'tagged.mp3'),
    ]);
    wav(join(music, 'music', 'Artist - Measured.wav'), song(128, [57, 60, 64, 69]));
  });

  it('reads ISRC, tempo and key from the tags and gives every track a code', async () => {
    const p = await scanLibrary(t.ctx, stationId);
    expect(p.errors).toEqual([]);
    const items = (await api('GET', '/library?sort=code')).json().items as { title: string; code: string; isrc: string; bpm: number | null; musicKey: string }[];
    expect(items.map((i) => i.code)).toEqual(['HF-00001', 'HF-00002']);
    expect(items.find((i) => i.title === 'Tagged')).toMatchObject({ isrc: 'NLA1R2400123', bpm: 150, musicKey: 'Am' });
    expect((await api('GET', '/library?q=HF-00002')).json().total).toBe(1);
    expect((await api('GET', '/library?q=NL-A1R')).json().total).toBe(1);
  });

  it('measures tempo and key where the tags have none, once', async () => {
    expect(await analysePending(t.ctx)).toBe(1);
    const [m] = await t.db.select().from(schema.mediaFiles).where(eq(schema.mediaFiles.title, 'Measured'));
    expect(m!.bpm).toBeCloseTo(128, 0);
    expect(m!.musicKey).toBe('Am');
    expect(m!.analysedAt).not.toBeNull();
    expect(await analysePending(t.ctx)).toBe(0);
  });

  it('lets managers correct them, kept on the next scan', async () => {
    const [m] = await t.db.select().from(schema.mediaFiles).where(eq(schema.mediaFiles.title, 'Measured'));
    const res = await api('PATCH', `/library/${m!.id}`, { isrc: 'NLA1R2400999', bpm: 64.04, musicKey: 'C major' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ isrc: 'NLA1R2400999', bpm: 64, musicKey: 'C', code: 'HF-00001' });
    expect((await api('PATCH', `/library/${m!.id}`, { isrc: 'nope' })).statusCode).toBe(400);
    expect((await api('PATCH', `/library/${m!.id}`, { musicKey: 'Z' })).statusCode).toBe(400);
    wav(join(music, 'music', 'Artist - Measured.wav'), song(140, [48, 52, 55], 20));
    await scanLibrary(t.ctx, stationId);
    const [after] = await t.db.select().from(schema.mediaFiles).where(eq(schema.mediaFiles.id, m!.id));
    expect(after).toMatchObject({ isrc: 'NLA1R2400999', bpm: 64, musicKey: 'C', code: 'HF-00001' });
  });

  it('numbers new tracks on after the highest code, with a changed prefix', async () => {
    const settings = (await api('GET', '/autodj')).json().settings;
    expect((await api('PUT', '/autodj', { ...settings, codePrefix: 'hfm' })).json().settings.codePrefix).toBe('HFM');
    wav(join(music, 'music', 'Artist - New.wav'), song(128, [57, 60, 64], 10));
    await scanLibrary(t.ctx, stationId);
    const [n] = await t.db.select().from(schema.mediaFiles).where(eq(schema.mediaFiles.title, 'New'));
    expect(n!.code).toBe('HFM-00003');
    expect(await assignCodes(t.ctx, stationId)).toBe(0);
  });
});
