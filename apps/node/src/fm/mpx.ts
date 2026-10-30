import type { RdsEncoder } from './rds.js';

/**
 * MPX (FM multiplex) generator at 192 kHz. From stereo audio that is already pre-emphasised, limited and low-passed at
 * 15 kHz (ffmpeg does that), it makes the composite signal an FM exciter takes:
 *
 *   mono (L+R)/2  +  stereo (L−R)/2 on a 38 kHz DSB-SC carrier  +  19 kHz pilot  +  RDS on 57 kHz
 *
 * 38 kHz and 57 kHz are the 2nd and 3rd harmonic of the pilot and the RDS bit rate is 57 kHz / 48, so everything stays
 * locked to one phase. 1.0 is 100% modulation (75 kHz deviation).
 *
 * The audio comes from the network and the samples go out at the clock of the sound card (or of the RTP sender). The
 * two clocks never run exactly alike, so the generator keeps a buffer of audio and reads it a few ppm faster or slower
 * to hold the buffer at its target. While there is no audio the pilot and RDS keep going, so receivers stay in stereo
 * and keep showing the station.
 */

export const MPX_RATE = 192_000;
const PILOT_HZ = 19_000;
const BIT_RATE = 1187.5;
/** Bits on each side of a symbol that its shaped pulse reaches into. */
const PULSE_SPAN = 2;
const PULSE_RES = 512;

/**
 * The shaped biphase pulse of one RDS bit (IEC 62106: impulse pair filtered with cos(πfT/4) up to 2/T), as a table over
 * [-PULSE_SPAN, PULSE_SPAN] bit periods. Normalised so that the RDS signal peaks at 1.
 */
const PULSE = (() => {
  const a = Math.PI / 4;
  // Impulse response of H(f) = cos(πf/4) for |f| ≤ 2 (T = 1).
  const h = (t: number) => {
    const b = 2 * Math.PI * t;
    const term = (x: number) => (Math.abs(x) < 1e-9 ? 2 : Math.sin(2 * x) / x);
    return term(a - b) + term(a + b);
  };
  const n = 2 * PULSE_SPAN * PULSE_RES + 1;
  const table = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / PULSE_RES - PULSE_SPAN;
    table[i] = h(t) - h(t - 0.5);
  }
  // Peak over a long pseudo-random symbol sequence.
  let seed = 12345;
  const syms: number[] = [];
  for (let i = 0; i < 4000; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    syms.push(seed & 0x10000 ? 1 : -1);
  }
  let peak = 0;
  for (let k = PULSE_SPAN; k < syms.length - PULSE_SPAN; k++) {
    for (let f = 0; f < PULSE_RES; f += 8) {
      let v = 0;
      // Symbol k − j started j bits (plus f) ago.
      for (let j = -PULSE_SPAN; j < PULSE_SPAN; j++) v += syms[k - j]! * table[(j + PULSE_SPAN) * PULSE_RES + f]!;
      peak = Math.max(peak, Math.abs(v));
    }
  }
  for (let i = 0; i < n; i++) table[i]! /= peak;
  return table;
})();

const pulseAt = (t: number) => {
  // t in bit periods, relative to the start of the symbol.
  const x = (t + PULSE_SPAN) * PULSE_RES;
  if (x <= 0 || x >= PULSE.length - 1) return 0;
  const i = Math.floor(x);
  const f = x - i;
  return PULSE[i]! * (1 - f) + PULSE[i + 1]! * f;
};

export interface MpxSettings {
  stereo: boolean;
  rds: boolean;
  /** Share of 100% modulation: pilot (8–10% is usual) and RDS (2–6%). */
  pilot: number;
  rdsLevel: number;
  /** Output gain in dB, to match the input of the exciter. */
  gainDb: number;
  /** Audio the generator keeps ahead, in seconds. */
  bufferSeconds: number;
  /**
   * The input is a finished MPX signal (Stereo Tool's stereo encoder) on the first channel: it is only buffered and
   * kept in step with the output clock, without adding a pilot or RDS.
   */
  passthrough: boolean;
}

export const DEFAULT_MPX: MpxSettings = { stereo: true, rds: true, pilot: 0.09, rdsLevel: 0.04, gainDb: 0, bufferSeconds: 1.5, passthrough: false };

export interface MpxMeters {
  /** Peak of the MPX signal over the last second, 1 = 100%. */
  peak: number;
  /** Peak of left and right audio over the last second (0..1). */
  left: number;
  right: number;
  /** Audio in the buffer, in seconds. */
  buffered: number;
  /** How much faster (+) or slower (−) the audio is read to hold the buffer, in ppm. */
  ppm: number;
  underruns: number;
  overruns: number;
  /** Audio is being sent (false while buffering or without input). */
  playing: boolean;
}

export class MpxGenerator {
  private settings: MpxSettings = { ...DEFAULT_MPX };
  /** Stereo frames, interleaved, as a ring. */
  private ring: Float32Array;
  private readonly cap: number;
  private written = 0;
  private readPos = 0;
  private playing = false;
  private fill = 0;
  private ratio = 1;
  private phase = 0;
  /** Position in the RDS bit stream (bits); symbols holds the amplitudes of the bits around it. */
  private bitPos = 0;
  private symbols: number[] = [];
  private symbolBase = 0;
  private underruns = 0;
  private overruns = 0;
  private peaks = { mpx: 0, left: 0, right: 0, at: 0, samples: 0 };
  private shown = { peak: 0, left: 0, right: 0 };
  private tail: Buffer | null = null;

  constructor(
    private readonly rds: RdsEncoder | null,
    capacitySeconds = 10,
  ) {
    this.cap = Math.round(capacitySeconds * MPX_RATE);
    this.ring = new Float32Array(this.cap * 2);
    for (let i = 0; i < 2 * PULSE_SPAN + 1; i++) this.symbols.push(this.nextSymbol());
  }

  configure(patch: Partial<MpxSettings>) {
    this.settings = { ...this.settings, ...patch };
  }

  get config(): Readonly<MpxSettings> {
    return this.settings;
  }

  private nextSymbol() {
    return this.rds ? (this.rds.nextBit() ? 1 : -1) : 0;
  }

  get buffered() {
    return (this.written - this.readPos) / MPX_RATE;
  }

  /** Takes decoded audio: 32-bit float stereo at 192 kHz, little endian, in chunks of any size. */
  push(chunk: Buffer) {
    const buf = this.tail ? Buffer.concat([this.tail, chunk]) : chunk;
    const frames = Math.floor(buf.length / 8);
    // An incomplete frame waits for the next chunk.
    this.tail = buf.length > frames * 8 ? Buffer.from(buf.subarray(frames * 8)) : null;
    const free = this.cap - (this.written - Math.floor(this.readPos));
    if (frames > free) {
      // The buffer is full: drop the oldest audio.
      this.readPos += frames - free;
      this.overruns++;
    }
    for (let i = 0; i < frames; i++) {
      const at = ((this.written + i) % this.cap) * 2;
      this.ring[at] = buf.readFloatLE(i * 8);
      this.ring[at + 1] = buf.readFloatLE(i * 8 + 4);
    }
    this.written += frames;
    const target = this.settings.bufferSeconds * MPX_RATE;
    // A burst at the start of a stream (Icecast sends seconds at once) would make the delay long: skip to the target.
    if (this.written - this.readPos > target + 3 * MPX_RATE) this.readPos = this.written - target;
  }

  /** Clears the audio (new stream). The pilot and RDS go on. */
  reset() {
    this.written = 0;
    this.readPos = 0;
    this.playing = false;
    this.tail = null;
    this.ratio = 1;
  }

  private frame(pos: number, out: [number, number]) {
    const i = Math.floor(pos);
    const f = pos - i;
    const a = (i % this.cap) * 2;
    const b = ((i + 1) % this.cap) * 2;
    out[0] = this.ring[a]! + (this.ring[b]! - this.ring[a]!) * f;
    out[1] = this.ring[a + 1]! + (this.ring[b + 1]! - this.ring[a + 1]!) * f;
  }

  /** Makes `count` MPX samples (floats, 1 = 100%). */
  render(count: number): Float32Array {
    const s = this.settings;
    const out = new Float32Array(count);
    const target = s.bufferSeconds * MPX_RATE;
    let avail = this.written - this.readPos;
    if (!this.playing && avail >= target) {
      // Start (again) at the target delay; a burst at the start of a stream would otherwise stay as extra delay.
      this.playing = true;
      this.readPos = this.written - target;
      this.fill = target;
      avail = target;
    }
    if (this.playing && avail < count + 2) {
      this.playing = false;
      this.underruns++;
    }
    // Hold the buffer at its target: read at most 500 ppm faster or slower.
    this.fill = this.fill ? this.fill * 0.98 + avail * 0.02 : avail;
    this.ratio = this.playing ? 1 + Math.max(-0.0005, Math.min(0.0005, (0.002 * (this.fill - target)) / target)) : 1;
    const audio = 1 - (s.stereo ? s.pilot : 0) - (s.rds ? s.rdsLevel : 0);
    const gain = 10 ** (s.gainDb / 20);
    const dPhase = PILOT_HZ / MPX_RATE;
    const dBit = BIT_RATE / MPX_RATE;
    const lr: [number, number] = [0, 0];
    let pk = this.peaks.mpx;
    let pl = this.peaks.left;
    let pr = this.peaks.right;
    for (let n = 0; n < count; n++) {
      let l = 0;
      let r = 0;
      if (this.playing) {
        this.frame(this.readPos, lr);
        this.readPos += this.ratio;
        l = Math.max(-1, Math.min(1, lr[0]));
        r = Math.max(-1, Math.min(1, lr[1]));
        if (Math.abs(l) > pl) pl = Math.abs(l);
        if (Math.abs(r) > pr) pr = Math.abs(r);
      }
      const w = 2 * Math.PI * this.phase;
      let v: number;
      if (s.passthrough) v = l;
      else if (s.stereo) v = audio * ((l + r) / 2 + ((l - r) / 2) * Math.sin(2 * w)) + s.pilot * Math.sin(w);
      else v = (audio * (l + r)) / 2;
      if (s.rds && this.rds && !s.passthrough) {
        // Sum the shaped pulses of the symbols around this moment.
        let base = 0;
        const rel = this.bitPos - this.symbolBase;
        for (let j = 0; j < this.symbols.length; j++) base += this.symbols[j]! * pulseAt(rel - (j - PULSE_SPAN));
        v += s.rdsLevel * base * Math.sin(3 * w);
      }
      this.phase += dPhase;
      if (this.phase >= 1) this.phase -= 1;
      this.bitPos += dBit;
      if (this.bitPos - this.symbolBase >= 1) {
        this.symbolBase += 1;
        this.symbols.shift();
        this.symbols.push(this.nextSymbol());
      }
      if (Math.abs(v) > pk) pk = Math.abs(v);
      out[n] = v * gain;
    }
    // Keep the numbers small over a long run.
    if (this.symbolBase > 1e6) {
      this.bitPos -= this.symbolBase;
      this.symbolBase = 0;
    }
    this.peaks.mpx = pk;
    this.peaks.left = pl;
    this.peaks.right = pr;
    this.peaks.samples += count;
    if (this.peaks.samples >= MPX_RATE) {
      this.shown = { peak: pk, left: pl, right: pr };
      this.peaks = { mpx: 0, left: 0, right: 0, at: 0, samples: 0 };
    }
    return out;
  }

  meters(): MpxMeters {
    return {
      peak: this.shown.peak,
      left: this.shown.left,
      right: this.shown.right,
      buffered: Math.round(this.buffered * 100) / 100,
      ppm: Math.round((this.ratio - 1) * 1e6),
      underruns: this.underruns,
      overruns: this.overruns,
      playing: this.playing,
    };
  }
}

/** Converts MPX samples to signed 32-bit little-endian PCM, on one channel or copied to both. */
export function toS32(samples: Float32Array, channels: 1 | 2): Buffer {
  const out = Buffer.alloc(samples.length * 4 * channels);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]!));
    const x = Math.round(v * 2147483647);
    out.writeInt32LE(x, i * 4 * channels);
    if (channels === 2) out.writeInt32LE(x, i * 8 + 4);
  }
  return out;
}
