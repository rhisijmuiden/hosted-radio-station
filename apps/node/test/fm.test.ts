import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rdsBytes } from '../src/fm/charset.js';
import { audioFilter } from '../src/fm/manager.js';
import { MPX_RATE, MpxGenerator, toS32 } from '../src/fm/mpx.js';
import { afCode, checkword, decodeBlock, encodeBlock, OFFSET, RdsEncoder, RTPLUS, zoneOffsetMinutes } from '../src/fm/rds.js';
import { fill, psFrames, renderTexts, type FmTexts } from '../src/fm/texts.js';
import { crcCcitt, uecpFrame, uecpMessages } from '../src/fm/uecp.js';

const texts: FmTexts = { ps: 'HARDERFM', psMode: 'static', psSeconds: 3, rtSong: '{artist} - {title}', rtLive: '{dj} live on {station}', rtIdle: '{station}' };

test('RDS blocks carry the right check bits and offsets', () => {
  assert.equal(checkword(0), 0);
  for (const data of [0x8201, 0x0000, 0xffff, 0x1234]) {
    for (const off of Object.values(OFFSET)) {
      const word = encodeBlock(data, off);
      assert.equal(decodeBlock(word, off), data);
      // One flipped bit is noticed.
      assert.equal(decodeBlock(word ^ (1 << 13), off), null);
    }
  }
  assert.equal(afCode(87.6), 1);
  assert.equal(afCode(107.9), 204);
});

test('RDS characters: ASCII stays, accents map to the RDS table', () => {
  assert.deepEqual(rdsBytes('AZ az09'), [0x41, 0x5a, 0x20, 0x61, 0x7a, 0x30, 0x39]);
  assert.deepEqual(rdsBytes('éëü'), [0x82, 0x93, 0x99]);
  assert.deepEqual(rdsBytes('Ł'), [0x4c]);
  assert.deepEqual(rdsBytes('€'), [0xa9]);
});

/** Collects the groups the encoder makes, decoded back from its bits. */
function groups(enc: RdsEncoder, count: number) {
  const out: [number, number, number, number][] = [];
  for (let g = 0; g < count; g++) out.push(enc.nextGroup());
  return out;
}

test('RDS groups: PS, RadioText with A/B flag and RadioText+ tags', () => {
  const enc = new RdsEncoder(() => new Date('2026-10-26T12:00:30Z'));
  enc.set({ pi: 0x8201, pty: 10, tp: true, ps: 'HARDERFM', rt: 'Avicii - Levels', tags: [{ type: RTPLUS.artist, start: 0, length: 6 }, { type: RTPLUS.title, start: 9, length: 6 }], af: [101.2, 99.1] });
  const gs = groups(enc, 64);
  const ps = Array(8).fill('?');
  const rt: string[] = [];
  let ab = -1;
  let aid = false;
  let tag: number[] | null = null;
  const afs = new Set<number>();
  for (const [a, b, c, d] of gs) {
    assert.equal(a, 0x8201);
    assert.equal((b >> 5) & 0x1f, 10);
    assert.equal((b >> 10) & 1, 1);
    const type = b >> 12;
    if (type === 0) {
      const seg = b & 3;
      ps[seg * 2] = String.fromCharCode(d >> 8);
      ps[seg * 2 + 1] = String.fromCharCode(d & 0xff);
      afs.add(c >> 8).add(c & 0xff);
    } else if (type === 2) {
      ab = (b >> 4) & 1;
      const seg = b & 0xf;
      rt[seg] = String.fromCharCode(c >> 8, c & 0xff, d >> 8, d & 0xff);
    } else if (type === 3) {
      aid = d === 0x4bd7 && (b & 0x1f) === 22;
    } else if (type === 11) {
      const bits = (BigInt(b & 0x1f) << 32n) | (BigInt(c) << 16n) | BigInt(d);
      const at = (shift: number, len: number) => Number((bits >> BigInt(shift)) & ((1n << BigInt(len)) - 1n));
      tag = [at(29, 6), at(23, 6), at(17, 6), at(11, 6), at(5, 6), at(0, 5)];
    }
  }
  assert.equal(ps.join(''), 'HARDERFM');
  assert.equal(rt.join('').split('\r')[0], 'Avicii - Levels');
  assert.equal(ab, 1);
  assert.ok(aid, 'RadioText+ announced in 3A');
  // Longest tag first: artist (6) and title (6) are as long, so the order is kept.
  assert.deepEqual(tag, [RTPLUS.artist, 0, 5, RTPLUS.title, 9, 5]);
  assert.ok(afs.has(224 + 2) && afs.has(afCode(101.2)) && afs.has(afCode(99.1)));

  // A new text flips the A/B flag.
  enc.set({ rt: 'Next' });
  const after = groups(enc, 8).find(([, b]) => b >> 12 === 2)!;
  assert.equal((after[1] >> 4) & 1, 0);
});

test('RDS clock time is sent once at the start of a minute with the local offset', () => {
  let now = new Date('2026-07-01T10:15:00.500Z');
  const enc = new RdsEncoder(() => now);
  enc.set({ timezone: 'Europe/Amsterdam' });
  const first = enc.nextGroup();
  assert.equal(first[1] >> 12, 4);
  const mjd = ((first[1] & 3) << 15) | (first[2] >> 1);
  assert.equal(mjd, 61222); // 2026-07-01
  const hour = ((first[2] & 1) << 4) | (first[3] >> 12);
  assert.equal(hour, 10);
  assert.equal((first[3] >> 6) & 0x3f, 15);
  assert.equal(first[3] & 0x1f, 4); // +2:00 in half hours
  assert.notEqual(enc.nextGroup()[1] >> 12, 4);
  now = new Date('2026-07-01T10:15:30Z');
  assert.ok(groups(enc, 20).every(([, b]) => b >> 12 !== 4));
  assert.equal(zoneOffsetMinutes('Europe/Amsterdam', new Date('2026-01-10T12:00:00Z')), 60);
});

/** Feeds a generator stereo audio made by fn(n) -> [l, r]. */
function feed(gen: MpxGenerator, seconds: number, fn: (n: number) => [number, number], start = 0) {
  const frames = Math.round(seconds * MPX_RATE);
  const buf = Buffer.alloc(frames * 8);
  for (let i = 0; i < frames; i++) {
    const [l, r] = fn(start + i);
    buf.writeFloatLE(l, i * 8);
    buf.writeFloatLE(r, i * 8 + 4);
  }
  // In uneven pieces, as a pipe delivers it.
  for (let i = 0; i < buf.length; i += 4093) gen.push(buf.subarray(i, i + 4093));
  return start + frames;
}

/** Amplitude of the frequency hz in x, whatever its phase. */
const correlate = (x: Float32Array, hz: number) => {
  let si = 0;
  let co = 0;
  for (let n = 0; n < x.length; n++) {
    const w = 2 * Math.PI * ((hz * n) / MPX_RATE);
    si += x[n]! * Math.sin(w);
    co += x[n]! * Math.cos(w);
  }
  return (2 * Math.hypot(si, co)) / x.length;
};

test('MPX: pilot at its level, left-only audio in mono and stereo parts, peak within 100%', () => {
  const gen = new MpxGenerator(null);
  gen.configure({ rds: false, pilot: 0.09, bufferSeconds: 0.7 });
  const tone = (n: number): [number, number] => [0.8 * Math.sin((2 * Math.PI * 1000 * n) / MPX_RATE), 0];
  feed(gen, 0.5, tone);
  // Pilot alone while buffering.
  const silent = gen.render(MPX_RATE / 10);
  assert.ok(!gen.meters().playing);
  assert.ok(Math.abs(correlate(silent, 19_000) - 0.09) < 0.002, 'pilot level');
  feed(gen, 1, tone, MPX_RATE / 2);
  const out = gen.render(MPX_RATE / 2);
  assert.ok(gen.meters().playing);
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  assert.ok(peak <= 1.0001, `peak ${peak}`);
  // The 1 kHz tone appears as (L+R)/2 in mono and as (L−R)/2 on 38 kHz (half at 37, half at 39 kHz).
  const audio = 1 - 0.09;
  // Over a short window: the generator reads a few hundred ppm fast here, which shifts the tone a little.
  const win = out.subarray(0, MPX_RATE / 10);
  assert.ok(Math.abs(correlate(win, 1000) - 0.4 * audio) < 0.01);
  assert.ok(Math.abs(correlate(win, 37_000) - 0.2 * audio) < 0.01);
  assert.ok(Math.abs(correlate(out, 19_000) - 0.09) < 0.002);
});

test('MPX: RDS on 57 kHz decodes back to the PS', () => {
  const enc = new RdsEncoder(() => new Date('2026-10-26T12:00:30Z'));
  enc.set({ pi: 0x8abc, ps: 'RADIO 1 ', rt: 'Hello' });
  const gen = new MpxGenerator(enc);
  gen.configure({ stereo: true, rds: true, rdsLevel: 0.05 });
  const x = gen.render(Math.round(MPX_RATE * 1.2));
  // Coherent demodulation at 57 kHz, then integrate each half of a bit (biphase).
  const spb = MPX_RATE / 1187.5;
  const base = new Float64Array(x.length);
  for (let n = 0; n < x.length; n++) base[n] = x[n]! * Math.sin(2 * Math.PI * ((57_000 * n) / MPX_RATE));
  const symbols: number[] = [];
  for (let k = 1; (k + 1) * spb < x.length; k++) {
    let v = 0;
    for (let n = Math.round((k - 0.25) * spb); n < Math.round((k + 0.25) * spb); n++) v += base[n]!;
    for (let n = Math.round((k + 0.25) * spb); n < Math.round((k + 0.75) * spb); n++) v -= base[n]!;
    symbols.push(v > 0 ? 1 : 0);
  }
  const bits = symbols.slice(1).map((s, i) => s ^ symbols[i]!);
  const word = (at: number) => bits.slice(at, at + 26).reduce((a, b) => a * 2 + b, 0);
  const ps = Array(8).fill('?');
  let found = 0;
  for (let i = 0; i + 104 <= bits.length; i++) {
    const a = decodeBlock(word(i), OFFSET.A);
    const b = decodeBlock(word(i + 26), OFFSET.B);
    if (a !== 0x8abc || b === null) continue;
    const d = decodeBlock(word(i + 78), OFFSET.D);
    if (b >> 12 === 0 && d !== null) {
      const seg = b & 3;
      ps[seg * 2] = String.fromCharCode(d >> 8);
      ps[seg * 2 + 1] = String.fromCharCode(d & 0xff);
      found++;
    }
    i += 103;
  }
  assert.ok(found >= 4, `found ${found} PS groups`);
  assert.equal(ps.join(''), 'RADIO 1 ');
});

test('MPX: the buffer holds its target when the audio comes in faster than it goes out', () => {
  const gen = new MpxGenerator(null);
  gen.configure({ rds: false, bufferSeconds: 0.5 });
  let n = feed(gen, 0.6, () => [0.1, 0.1]);
  // 300 ppm more audio than the output reads, over 60 simulated seconds.
  for (let s = 0; s < 600; s++) {
    gen.render(MPX_RATE / 10);
    n = feed(gen, 0.10003, () => [0.1, 0.1], n);
  }
  const m = gen.meters();
  assert.ok(m.ppm > 0, `reads faster (${m.ppm} ppm)`);
  assert.ok(m.buffered < 1.2, `buffer ${m.buffered}s`);
  assert.equal(m.underruns, 0);
  assert.equal(toS32(new Float32Array([1, -1]), 2).length, 16);
});

test('ffmpeg audio chain follows the settings', () => {
  const a = { stereo: true, preemphasis: 50 as const, limiter: true, pilot: 0.09, rdsLevel: 0.04, gainDb: 0, bufferSeconds: 1.5 };
  assert.match(audioFilter(a), /aemphasis=mode=production:type=50fm,alimiter=.*firequalizer.*aresample=192000$/);
  assert.doesNotMatch(audioFilter({ ...a, preemphasis: 0, limiter: false }), /aemphasis|alimiter/);
});

test('UECP frames: CRC-CCITT, byte stuffing and messages', () => {
  assert.equal(crcCcitt([...Buffer.from('123456789')]), 0xd64e);
  const frame = uecpFrame(uecpMessages.pi(0x8201), { site: 0, encoder: 0, sequence: 1 });
  assert.equal(frame[0], 0xfe);
  assert.equal(frame.at(-1), 0xff);
  // Nothing between STA and STP may look like STA or STP.
  assert.ok([...frame.subarray(1, -1)].every((b) => b !== 0xfe && b !== 0xff));
  const stuffed = uecpFrame([0x02, 0, 0, 0xfe, 0xff, 0xfd], { site: 0, encoder: 0, sequence: 0 });
  assert.ok(stuffed.includes(Buffer.from([0xfd, 0x01, 0xfd, 0x02, 0xfd, 0x00])));
  assert.deepEqual(uecpMessages.ps('ABC'), [0x02, 0, 0, 0x41, 0x42, 0x43, 0x20, 0x20, 0x20, 0x20, 0x20]);
  assert.deepEqual(uecpMessages.rt('Hi', 1), [0x0a, 0, 0, 3, 1, 0x48, 0x69]);
});

test('RadioText and PS from the templates', () => {
  const ctx = { station: 'Harder.FM', dj: null, show: null };
  const song = renderTexts(texts, ctx, 'Headhunterz - Dragonborn');
  assert.equal(song.rt, 'Headhunterz - Dragonborn');
  assert.deepEqual(song.tags, [
    { type: RTPLUS.artist, start: 0, length: 11 },
    { type: RTPLUS.title, start: 14, length: 10 },
  ]);
  assert.deepEqual(song.ps, ['HARDERFM']);
  // No artist in the title: no dangling separator.
  assert.equal(renderTexts(texts, ctx, 'Station jingle').rt, 'Station jingle');
  assert.equal(fill('{artist} - {title}', { artist: null, title: 'X' }), 'X');
  assert.equal(renderTexts(texts, { ...ctx, dj: 'DJ Rob' }, 'whatever').rt, 'DJ Rob live on Harder.FM');
  assert.equal(renderTexts(texts, ctx, null).rt, 'Harder.FM');
  const dyn = renderTexts({ ...texts, psMode: 'dynamic' }, ctx, 'Headhunterz - Dragonborn');
  assert.deepEqual(dyn.ps, ['HARDERFM', 'Headhunt', '  erz   ', 'Dragonbo', '   rn   ']);
  assert.deepEqual(psFrames('The Prodigy'), ['  The   ', 'Prodigy ']);
});
