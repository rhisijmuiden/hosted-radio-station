import { spawn } from 'node:child_process';
import { and, asc, eq, isNull, or } from 'drizzle-orm';
import { schema } from '../../db/index.js';
import type { AppContext } from '../../lib/context.js';
import { assignCodes, filePath, keyName, locationRoot } from './library.js';
import { autodjSettings } from './settings.js';

/** Sample rate the audio is measured at: enough for the beat and for notes up to about 5 kHz. */
const RATE = 11025;
/** Seconds of the track that are measured, from a fifth into it (past the intro). */
const SPAN = 90;

/**
 * Mono samples of part of a file, decoded by FFmpeg at low priority. Resolves with an empty array when FFmpeg is missing or
 * cannot read the file.
 */
function decode(full: string, start: number, seconds: number): Promise<Float32Array> {
  return new Promise((resolve) => {
    const args = ['-n', '19', 'ffmpeg', '-v', 'error', '-nostdin', '-ss', String(start), '-t', String(seconds), '-i', full, '-ac', '1', '-ar', String(RATE), '-f', 'f32le', '-'];
    const p = spawn('nice', args, { stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks: Buffer[] = [];
    let size = 0;
    p.stdout.on('data', (b: Buffer) => {
      chunks.push(b);
      size += b.length;
    });
    const timer = setTimeout(() => p.kill('SIGKILL'), 120_000);
    p.on('error', () => {
      clearTimeout(timer);
      resolve(new Float32Array(0));
    });
    p.on('close', () => {
      clearTimeout(timer);
      const buf = Buffer.concat(chunks, size);
      const out = new Float32Array(Math.floor(buf.length / 4));
      for (let i = 0; i < out.length; i++) out[i] = buf.readFloatLE(i * 4);
      resolve(out);
    });
  });
}

/** In-place radix-2 FFT; `re` and `im` have a power-of-two length. */
function fft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b]! * cr - im[b]! * ci;
        const ti = re[b]! * ci + im[b]! * cr;
        re[b] = re[a]! - tr;
        im[b] = im[a]! - ti;
        re[a] = re[a]! + tr;
        im[a] = im[a]! + ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

/** Magnitude spectra of overlapping Hann-windowed frames. */
function* spectra(samples: Float32Array, size: number, hop: number) {
  const win = new Float64Array(size).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size));
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  const mag = new Float64Array(size / 2);
  for (let start = 0; start + size <= samples.length; start += hop) {
    for (let i = 0; i < size; i++) {
      re[i] = samples[start + i]! * win[i]!;
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k < size / 2; k++) mag[k] = Math.hypot(re[k]!, im[k]!);
    yield mag;
  }
}

/**
 * Tempo in BPM: the onset strength (rise of the log spectrum, frame by frame) is compared with itself shifted by every beat
 * length between 60 and 200 BPM; the best match wins, with a mild preference for tempos around 120 so that half and double
 * tempo do not win by chance. Null when there is no clear beat.
 */
export function measureBpm(samples: Float32Array, rate = RATE): number | null {
  const size = 1024;
  const hop = 128;
  const env: number[] = [];
  let prev: Float64Array | null = null;
  for (const mag of spectra(samples, size, hop)) {
    const log = mag.map((m) => Math.log1p(1000 * m));
    let flux = 0;
    if (prev) for (let k = 1; k < log.length; k++) flux += Math.max(0, log[k]! - prev[k]!);
    env.push(flux);
    prev = log;
  }
  if (env.length < 400) return null;
  // Only the rises above the local average count.
  const w = 16;
  const onset = env.map((v, i) => {
    let sum = 0;
    let n = 0;
    for (let j = Math.max(0, i - w); j <= Math.min(env.length - 1, i + w); j++, n++) sum += env[j]!;
    return Math.max(0, v - sum / n);
  });
  // A little smoothing, so a beat that falls between frames still lines up with itself.
  for (let pass = 0; pass < 2; pass++) {
    for (let i = onset.length - 2, next = onset[onset.length - 1]!; i > 0; i--) {
      const cur = onset[i]!;
      onset[i] = 0.25 * onset[i - 1]! + 0.5 * cur + 0.25 * next;
      next = cur;
    }
  }
  const fps = rate / hop;
  const corr = (lag: number) => {
    let s = 0;
    for (let i = lag; i < onset.length; i++) s += onset[i]! * onset[i - lag]!;
    return s / (onset.length - lag);
  };
  const zero = corr(0);
  if (zero <= 0) return null;
  const minLag = Math.floor((60 * fps) / 200);
  const maxLag = Math.ceil((60 * fps) / 60);
  const raw = new Float64Array(maxLag + 2);
  for (let lag = minLag - 1; lag <= maxLag + 1; lag++) raw[lag] = corr(lag);
  let best = -1;
  let bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    // A real beat also matches at twice its length; that makes the pick more stable.
    const bpm = (60 * fps) / lag;
    const weight = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2);
    const score = raw[lag]! * weight;
    if (score > bestScore) {
      bestScore = score;
      best = lag;
    }
  }
  // No clear beat: the best match hardly stands out from the average one.
  let mean = 0;
  for (let lag = minLag; lag <= maxLag; lag++) mean += raw[lag]!;
  mean /= maxLag - minLag + 1;
  if (best < 0 || raw[best]! < 1.5 * mean) return null;
  // Every beat also matches at twice its length, so a fast track can win at half its tempo: take the double tempo when
  // that matches nearly as well.
  const half = Math.round(best / 2);
  if (half >= minLag && Math.max(raw[half - 1]!, raw[half]!, raw[half + 1]!) >= 0.85 * raw[best]!) {
    best = [half - 1, half, half + 1].reduce((a, b) => (raw[b]! > raw[a]! ? b : a));
  }
  // Between the frames: the top of a parabola through the best lag and its neighbours.
  const a = raw[best - 1]!;
  const b = raw[best]!;
  const c = raw[best + 1]!;
  const shift = a - 2 * b + c !== 0 ? (0.5 * (a - c)) / (a - 2 * b + c) : 0;
  const bpm = (60 * fps) / (best + Math.max(-0.5, Math.min(0.5, shift)));
  return Math.round(bpm * 10) / 10;
}

// Krumhansl–Kessler key profiles: how strongly each scale step belongs to a major and a minor key.
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function pearson(x: number[], y: number[]) {
  const mx = x.reduce((a, b) => a + b, 0) / x.length;
  const my = y.reduce((a, b) => a + b, 0) / y.length;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < x.length; i++) {
    num += (x[i]! - mx) * (y[i]! - my);
    dx += (x[i]! - mx) ** 2;
    dy += (y[i]! - my) ** 2;
  }
  return dx && dy ? num / Math.sqrt(dx * dy) : 0;
}

/**
 * Musical key as "Am" or "F#": the energy of every pitch class (notes from 55 Hz to 2 kHz, all octaves together) is compared
 * with the major and minor key profiles in all twelve keys; the best match wins. Empty when the audio has no clear tone.
 */
export function measureKey(samples: Float32Array, rate = RATE): string {
  const size = 8192;
  const chroma = new Array<number>(12).fill(0);
  // Each FFT bin belongs to the nearest note; bins between notes count less.
  const bins: { k: number; pc: number; w: number }[] = [];
  for (let k = 1; k < size / 2; k++) {
    const f = (k * rate) / size;
    if (f < 55 || f > 2000) continue;
    const midi = 69 + 12 * Math.log2(f / 440);
    const near = Math.round(midi);
    const w = Math.cos(Math.min(1, Math.abs(midi - near) * 2) * (Math.PI / 2)) ** 2;
    if (w > 0.05) bins.push({ k, pc: ((near % 12) + 12) % 12, w });
  }
  let frames = 0;
  for (const mag of spectra(samples, size, size / 2)) {
    const frame = new Array<number>(12).fill(0);
    let total = 0;
    for (const b of bins) {
      const v = mag[b.k]! * mag[b.k]! * b.w;
      frame[b.pc]! += v;
      total += v;
    }
    if (total <= 1e-9) continue;
    for (let i = 0; i < 12; i++) chroma[i]! += Math.sqrt(frame[i]! / total);
    frames++;
  }
  if (frames < 10) return '';
  // Noise and speech spread evenly over all notes: no key.
  const avg = chroma.reduce((a, b) => a + b, 0) / 12;
  const spread = Math.sqrt(chroma.reduce((a, b) => a + (b - avg) ** 2, 0) / 12) / avg;
  if (spread < 0.15) return '';
  let best = { r: -Infinity, root: 0, minor: false };
  for (let root = 0; root < 12; root++) {
    const rotated = chroma.map((_, i) => chroma[(i + root) % 12]!);
    const maj = pearson(rotated, MAJOR);
    const min = pearson(rotated, MINOR);
    if (maj > best.r) best = { r: maj, root, minor: false };
    if (min > best.r) best = { r: min, root, minor: true };
  }
  // pitch class 0 is C (MIDI note 60 = C)
  return best.r > 0.3 ? keyName(best.root, best.minor) : '';
}

/** Tempo and key of a file; null where it could not be measured. */
export async function analyseFile(full: string, durationSeconds: number | null): Promise<{ bpm: number | null; key: string }> {
  const length = durationSeconds ?? 0;
  const start = length > 40 ? Math.min(60, length * 0.2) : 0;
  const samples = await decode(full, start, length > 0 ? Math.min(SPAN, length - start) : SPAN);
  if (samples.length < RATE * 8) return { bpm: null, key: '' };
  return { bpm: measureBpm(samples), key: measureKey(samples) };
}

let busy = false;

/**
 * Measures tempo and key of tracks whose tags have neither (a few per run, one at a time and at low priority, so playout
 * never notices), and gives new tracks their code. Runs for the Radio stations this server plays.
 */
export async function analysePending(ctx: AppContext, max = 12) {
  if (busy) return 0;
  busy = true;
  try {
    const stations = await ctx.db
      .select()
      .from(schema.stations)
      .where(and(eq(schema.stations.edition, 'station'), isNull(schema.stations.nodeId)));
    let done = 0;
    for (const station of stations) {
      await assignCodes(ctx, station.id);
      if (autodjSettings(station).analyse === false) continue;
      const mf = schema.mediaFiles;
      const rows = await ctx.db
        .select()
        .from(mf)
        .where(and(eq(mf.stationId, station.id), isNull(mf.analysedAt), or(isNull(mf.bpm), eq(mf.musicKey, ''))))
        .orderBy(asc(mf.createdAt))
        .limit(max - done);
      if (!rows.length) continue;
      const sources = await ctx.db.select().from(schema.mediaSources).where(eq(schema.mediaSources.stationId, station.id));
      for (const row of rows) {
        const root = locationRoot(ctx, station.id, row.location, sources.find((s) => s.id === row.location));
        const found = root ? await analyseFile(filePath(root, row.path), row.durationSeconds).catch(() => ({ bpm: null, key: '' })) : { bpm: null, key: '' };
        // Values from the tags or the panel stay; the measurement only fills what is missing.
        await ctx.db
          .update(mf)
          .set({ bpm: row.bpm ?? found.bpm, musicKey: row.musicKey || found.key, analysedAt: new Date() })
          .where(eq(mf.id, row.id));
        done++;
      }
      if (done >= max) break;
    }
    return done;
  } finally {
    busy = false;
  }
}
