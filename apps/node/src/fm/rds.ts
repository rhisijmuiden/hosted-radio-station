import { rdsBytes } from './charset.js';

/**
 * RDS encoder (IEC 62106 / EN 50067): turns the station's data into the stream of RDS groups, 104 bits each, that the
 * MPX generator modulates on 57 kHz. It sends:
 *   0A  PS (8 characters), TA/TP, music/speech, decoder info (stereo) and alternative frequencies
 *   2A  RadioText (64 characters) with the A/B flag that tells receivers the text changed
 *   3A  the RadioText+ announcement (AID 4BD7, in group 11A)
 *   11A RadioText+ tags: where the artist and the title are in the RadioText
 *   4A  clock time, once a minute
 */

const POLY = 0x1b9;
const OFFSET = { A: 0x0fc, B: 0x198, C: 0x168, D: 0x1b4 } as const;
const RTPLUS_AID = 0x4bd7;
/** RadioText+ content types. */
export const RTPLUS = { title: 1, album: 2, artist: 4 } as const;

/** The 10 check bits of a 16-bit block (generator x^10+x^8+x^7+x^5+x^4+x^3+1). */
export function checkword(block: number): number {
  let crc = 0;
  for (let i = 15; i >= 0; i--) {
    const bit = (block >> i) & 1;
    const msb = (crc >> 9) & 1;
    crc = (crc << 1) & 0x3ff;
    if (msb ^ bit) crc ^= POLY;
  }
  return crc;
}

/** The 26 bits of a block: 16 data bits and the check bits with the block's offset word. */
export const encodeBlock = (data: number, offset: number) => ((data & 0xffff) << 10) | (checkword(data) ^ offset);

/** Alternative frequency code: 87.6 MHz = 1 … 107.9 MHz = 204. */
export const afCode = (mhz: number) => Math.round((mhz - 87.5) * 10);

export interface RdsTag {
  type: number;
  start: number;
  length: number;
}

export interface RdsData {
  pi: number;
  pty: number;
  tp: boolean;
  ta: boolean;
  music: boolean;
  stereo: boolean;
  /** Alternative frequencies in MHz (method A, at most 25). */
  af: number[];
  ps: string;
  rt: string;
  /** RadioText+ tags in the current RadioText; an empty list sends no tags. */
  tags: RdsTag[];
  rtPlus: boolean;
  clock: boolean;
  /** IANA time zone for the local time offset of the clock, e.g. Europe/Amsterdam. */
  timezone: string;
}

export const DEFAULT_RDS: RdsData = { pi: 0x8000, pty: 0, tp: false, ta: false, music: true, stereo: true, af: [], ps: '', rt: '', tags: [], rtPlus: true, clock: true, timezone: 'UTC' };

/** Minutes the time zone is ahead of UTC at a moment. */
export function zoneOffsetMinutes(timezone: string, at: Date): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }).formatToParts(at);
    const n = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    const local = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'));
    return Math.round((local - Math.floor(at.getTime() / 60_000) * 60_000) / 60_000);
  } catch {
    return 0;
  }
}

export class RdsEncoder {
  private data: RdsData = { ...DEFAULT_RDS };
  private psBytes: number[] = [];
  private rtBytes: number[] = [];
  private rtSegments = 1;
  private abFlag = 0;
  private toggle = 0;
  private psSeg = 0;
  private rtSeg = 0;
  private afPairs: [number, number][] = [];
  private afIdx = 0;
  private slot = 0;
  private lastMinute = -1;
  /** Bits of the group being sent, and where we are in it. */
  private bits: number[] = [];
  private bitIdx = 0;
  /** Last differentially encoded bit. */
  private prev = 0;
  /** Groups sent, by type, for the status page and the tests. */
  readonly sent = { '0A': 0, '2A': 0, '3A': 0, '4A': 0, '11A': 0 };

  constructor(private readonly now: () => Date = () => new Date()) {
    this.set({});
  }

  get current(): Readonly<RdsData> {
    return this.data;
  }

  /** Changes some of the data; a new RadioText flips the A/B flag, a new tag set flips the item toggle. */
  set(patch: Partial<RdsData>) {
    const before = this.data;
    this.data = { ...before, ...patch };
    const d = this.data;
    this.psBytes = rdsBytes(d.ps.slice(0, 8).padEnd(8, ' ')).slice(0, 8);
    if (d.rt !== before.rt || !this.rtBytes.length) {
      const text = rdsBytes(d.rt.trimEnd()).slice(0, 64);
      // Shorter texts end with a carriage return and are sent only as far as needed.
      if (text.length < 64) text.push(0x0d);
      while (text.length % 4) text.push(0x20);
      this.rtBytes = text;
      this.rtSegments = Math.max(1, text.length / 4);
      if (this.rtSeg >= this.rtSegments) this.rtSeg = 0;
      if (before.rt !== d.rt) this.abFlag ^= 1;
    }
    if (JSON.stringify(before.tags) !== JSON.stringify(d.tags) || before.rt !== d.rt) this.toggle ^= 1;
    const codes = d.af
      .map(afCode)
      .filter((c) => c >= 1 && c <= 204)
      .slice(0, 25);
    const list = codes.length ? [224 + codes.length, ...codes] : [224];
    if (list.length % 2) list.push(205);
    this.afPairs = [];
    for (let i = 0; i < list.length; i += 2) this.afPairs.push([list[i]!, list[i + 1]!]);
  }

  /** The next bit to send, already differentially encoded (0 or 1). */
  nextBit(): number {
    if (this.bitIdx >= this.bits.length) {
      this.bits = this.groupBits(this.nextGroup());
      this.bitIdx = 0;
    }
    const bit = this.bits[this.bitIdx++]!;
    this.prev ^= bit;
    return this.prev;
  }

  private groupBits(blocks: [number, number, number, number]): number[] {
    const offsets = [OFFSET.A, OFFSET.B, OFFSET.C, OFFSET.D];
    const out: number[] = [];
    blocks.forEach((b, i) => {
      const word = encodeBlock(b, offsets[i]!);
      for (let k = 25; k >= 0; k--) out.push((word >> k) & 1);
    });
    return out;
  }

  /** Block B header: group type, version A, TP and PTY. */
  private blockB(type: number, low5: number) {
    const d = this.data;
    return (type << 12) | ((d.tp ? 1 : 0) << 10) | ((d.pty & 0x1f) << 5) | (low5 & 0x1f);
  }

  /** Chooses the next group: PS in every other group, then RadioText, RadioText+ and once a minute the clock. */
  nextGroup(): [number, number, number, number] {
    const d = this.data;
    const now = this.now();
    const minute = Math.floor(now.getTime() / 60_000);
    if (d.clock && minute !== this.lastMinute && now.getUTCSeconds() < 2) {
      this.lastMinute = minute;
      this.sent['4A']++;
      return this.group4A(now);
    }
    const slot = this.slot++ % 8;
    if (slot % 2 === 0) {
      this.sent['0A']++;
      return this.group0A();
    }
    if (slot === 7 && d.rtPlus) {
      // Every fourth extra slot: the announcement; the others: the tags.
      if (Math.floor(this.slot / 8) % 4 === 0) {
        this.sent['3A']++;
        return this.group3A();
      }
      this.sent['11A']++;
      return this.group11A();
    }
    this.sent['2A']++;
    return this.group2A();
  }

  private group0A(): [number, number, number, number] {
    const d = this.data;
    const seg = this.psSeg;
    this.psSeg = (seg + 1) % 4;
    // Decoder information, one bit per segment: d3 (dynamic PTY) … d0 (stereo).
    const di = seg === 3 && d.stereo ? 1 : 0;
    const b = this.blockB(0, ((d.ta ? 1 : 0) << 4) | ((d.music ? 1 : 0) << 3) | (di << 2) | seg);
    const pair = this.afPairs[this.afIdx]!;
    this.afIdx = (this.afIdx + 1) % this.afPairs.length;
    const c = (pair[0] << 8) | pair[1];
    const dd = (this.psBytes[seg * 2]! << 8) | this.psBytes[seg * 2 + 1]!;
    return [d.pi, b, c, dd];
  }

  private group2A(): [number, number, number, number] {
    const seg = this.rtSeg;
    this.rtSeg = (seg + 1) % this.rtSegments;
    const r = this.rtBytes;
    const b = this.blockB(2, (this.abFlag << 4) | seg);
    return [this.data.pi, b, (r[seg * 4]! << 8) | r[seg * 4 + 1]!, (r[seg * 4 + 2]! << 8) | r[seg * 4 + 3]!];
  }

  private group3A(): [number, number, number, number] {
    // RadioText+ is carried in group 11A (type 11, version A = 0b10110); no template, no CB flag.
    return [this.data.pi, this.blockB(3, (11 << 1) | 0), 0x0000, RTPLUS_AID];
  }

  private group11A(): [number, number, number, number] {
    const d = this.data;
    // Tag 2 has a 5-bit length marker (at most 32 characters), so the shorter tag goes there.
    const tags = [...d.tags].filter((t) => t.length > 0 && t.start < 64).slice(0, 2);
    tags.sort((a, b) => b.length - a.length);
    const t1 = tags[0] ?? { type: 0, start: 0, length: 1 };
    const t2 = tags[1] ?? { type: 0, start: 0, length: 1 };
    const running = tags.length ? 1 : 0;
    const l1 = Math.min(63, t1.length - 1);
    const l2 = Math.min(31, t2.length - 1);
    // 37 bits: toggle(1) running(1) type1(6) start1(6) len1(6) type2(6) start2(6) len2(5)
    const hi = (this.toggle << 4) | (running << 3) | ((t1.type >> 3) & 0x7);
    const c = ((t1.type & 0x7) << 13) | ((t1.start & 0x3f) << 7) | ((l1 & 0x3f) << 1) | ((t2.type >> 5) & 0x1);
    const dd = ((t2.type & 0x1f) << 11) | ((t2.start & 0x3f) << 5) | (l2 & 0x1f);
    return [d.pi, this.blockB(11, hi), c, dd];
  }

  private group4A(now: Date): [number, number, number, number] {
    const mjd = Math.floor(now.getTime() / 86_400_000) + 40587;
    const hour = now.getUTCHours();
    const min = now.getUTCMinutes();
    const off = zoneOffsetMinutes(this.data.timezone, now);
    const halfHours = Math.min(31, Math.round(Math.abs(off) / 30));
    const b = this.blockB(4, (mjd >> 15) & 0x3);
    const c = ((mjd & 0x7fff) << 1) | ((hour >> 4) & 1);
    const dd = ((hour & 0xf) << 12) | (min << 6) | ((off < 0 ? 1 : 0) << 5) | halfHours;
    return [this.data.pi, b, c, dd];
  }
}

/** Reads the 16 data bits back from a 26-bit block, or null when the check bits do not match. Used by the tests. */
export function decodeBlock(word: number, offset: number): number | null {
  const data = (word >> 10) & 0xffff;
  return ((word & 0x3ff) ^ offset) === checkword(data) ? data : null;
}

export { OFFSET };
