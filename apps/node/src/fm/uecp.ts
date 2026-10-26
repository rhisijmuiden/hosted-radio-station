import { spawn } from 'node:child_process';
import dgram from 'node:dgram';
import { createWriteStream, type WriteStream } from 'node:fs';
import net from 'node:net';
import { log } from '../log.js';
import { rdsBytes } from './charset.js';

/**
 * UECP (Universal Encoder Communication Protocol, EBU SPB 490): how the node steers an RDS encoder that is already
 * in the chain at the transmitter, over TCP, UDP or a serial port. Frames are
 *
 *   STA(FE) ADD(2) SQC MFL MSG… CRC(2) STP(FF)
 *
 * with the CRC-CCITT over ADD…MSG and the bytes FD–FF between STA and STP escaped as FD 00 / FD 01 / FD 02.
 */

export const MEC = { pi: 0x01, ps: 0x02, tatp: 0x03, di: 0x04, ms: 0x05, pty: 0x07, rt: 0x0a } as const;

export function crcCcitt(bytes: number[]): number {
  let crc = 0xffff;
  for (const b of bytes) {
    crc = ((crc >> 8) | (crc << 8)) & 0xffff;
    crc ^= b;
    crc ^= (crc & 0xff) >> 4;
    crc ^= (crc << 12) & 0xffff;
    crc ^= ((crc & 0xff) << 5) & 0xffff;
  }
  return ~crc & 0xffff;
}

/** One UECP frame around a message (MEC and its data). Site address 0–1023, encoder address 0–63; 0 = all. */
export function uecpFrame(msg: number[], opts: { site: number; encoder: number; sequence: number }): Buffer {
  const add = ((opts.site & 0x3ff) << 6) | (opts.encoder & 0x3f);
  const body = [add >> 8, add & 0xff, opts.sequence & 0xff, msg.length, ...msg];
  const crc = crcCcitt(body);
  body.push(crc >> 8, crc & 0xff);
  const out = [0xfe];
  for (const b of body) {
    if (b >= 0xfd) out.push(0xfd, b - 0xfd);
    else out.push(b);
  }
  out.push(0xff);
  return Buffer.from(out);
}

/** Data set 0 (the current one), programme service 0 (the main service). */
const DSN = 0;
const PSN = 0;

export interface UecpData {
  pi: number;
  ps: string;
  rt: string;
  pty: number;
  tp: boolean;
  ta: boolean;
  music: boolean;
  stereo: boolean;
}

export const uecpMessages = {
  pi: (pi: number) => [MEC.pi, DSN, PSN, (pi >> 8) & 0xff, pi & 0xff],
  ps: (ps: string) => [MEC.ps, DSN, PSN, ...rdsBytes(ps.slice(0, 8).padEnd(8, ' ')).slice(0, 8)],
  tatp: (tp: boolean, ta: boolean) => [MEC.tatp, DSN, PSN, ((tp ? 1 : 0) << 1) | (ta ? 1 : 0)],
  di: (stereo: boolean) => [MEC.di, DSN, PSN, stereo ? 1 : 0],
  ms: (music: boolean) => [MEC.ms, DSN, PSN, music ? 1 : 0],
  pty: (pty: number) => [MEC.pty, DSN, PSN, pty & 0x1f],
  /** RadioText: MEL, then the configuration byte (transmissions = 0: send until replaced; A/B flag toggles). */
  rt: (rt: string, ab: number) => {
    const text = rdsBytes(rt.trimEnd()).slice(0, 64);
    return [MEC.rt, DSN, PSN, text.length + 1, ab & 1, ...text];
  },
};

export interface UecpTarget {
  transport: 'tcp' | 'udp' | 'serial';
  host: string;
  port: number;
  device: string;
  baud: number;
  site: number;
  encoder: number;
}

export type UecpState = 'off' | 'connecting' | 'connected' | 'error';

/** Keeps the connection to the encoder and sends what changed; everything again after a (re)connect. */
export class UecpClient {
  private socket: net.Socket | null = null;
  private udp: dgram.Socket | null = null;
  private serial: WriteStream | null = null;
  private seq = 0;
  private ab = 0;
  private abText: string | null = null;
  private sent: Partial<Record<keyof UecpData, string>> = {};
  private data: UecpData | null = null;
  private retry: NodeJS.Timeout | null = null;
  private keepalive: NodeJS.Timeout | null = null;
  private retries = 0;
  private stopped = false;
  state: UecpState = 'connecting';
  message: string | undefined;

  constructor(private readonly target: UecpTarget) {
    this.open();
    // Send everything again now and then, for encoders that were restarted without the connection noticing.
    this.keepalive = setInterval(() => {
      this.sent = {};
      this.flush();
    }, 60_000);
  }

  stop() {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    if (this.keepalive) clearInterval(this.keepalive);
    this.socket?.destroy();
    this.udp?.close();
    this.serial?.destroy();
    this.state = 'off';
  }

  update(data: UecpData) {
    this.data = data;
    this.flush();
  }

  private fail(message: string) {
    if (this.stopped) return;
    this.state = 'error';
    this.message = message;
    this.socket?.destroy();
    this.socket = null;
    this.serial?.destroy();
    this.serial = null;
    if (this.retry) return;
    const delay = Math.min(60_000, 2000 * 2 ** Math.min(this.retries++, 5));
    log.warn('RDS encoder connection failed', { message, retryIn: delay });
    this.retry = setTimeout(() => {
      this.retry = null;
      this.open();
    }, delay);
  }

  private connected() {
    this.state = 'connected';
    this.message = undefined;
    this.retries = 0;
    this.sent = {};
    this.flush();
  }

  private open() {
    if (this.stopped) return;
    const t = this.target;
    this.state = 'connecting';
    if (t.transport === 'tcp') {
      const s = net.connect({ host: t.host, port: t.port });
      this.socket = s;
      s.setTimeout(15_000);
      s.once('connect', () => {
        s.setTimeout(0);
        s.setKeepAlive(true, 30_000);
        this.connected();
      });
      s.on('data', () => undefined);
      s.once('timeout', () => this.fail('no answer'));
      s.once('error', (err) => this.fail(err.message));
      s.once('close', () => this.socket === s && this.fail('connection closed'));
    } else if (t.transport === 'udp') {
      this.udp = dgram.createSocket(t.host.includes(':') ? 'udp6' : 'udp4');
      this.udp.on('error', (err) => this.fail(err.message));
      this.connected();
    } else {
      // Set the speed with stty, then write to the device like a file.
      const stty = spawn('stty', ['-F', t.device, String(t.baud), 'raw', '-echo', 'cs8', '-cstopb', '-parenb'], { stdio: 'ignore' });
      stty.once('error', (err) => this.fail(`stty: ${err.message}`));
      stty.once('exit', (code) => {
        if (code !== 0) return this.fail(`cannot open ${t.device}`);
        const w = createWriteStream(t.device, { flags: 'w' });
        this.serial = w;
        w.once('open', () => this.connected());
        w.once('error', (err) => this.fail(err.message));
      });
    }
  }

  private write(frame: Buffer) {
    const t = this.target;
    if (t.transport === 'tcp') this.socket?.write(frame);
    else if (t.transport === 'udp') this.udp?.send(frame, t.port, t.host);
    else this.serial?.write(frame);
  }

  private send(key: keyof UecpData, value: string, msg: number[]) {
    if (this.sent[key] === value) return;
    this.sent[key] = value;
    this.seq = (this.seq + 1) & 0xff || 1;
    this.write(uecpFrame(msg, { site: this.target.site, encoder: this.target.encoder, sequence: this.seq }));
  }

  private flush() {
    const d = this.data;
    if (!d || this.state !== 'connected') return;
    this.send('pi', d.pi.toString(16), uecpMessages.pi(d.pi));
    this.send('pty', String(d.pty), uecpMessages.pty(d.pty));
    this.send('tp', `${d.tp}${d.ta}`, uecpMessages.tatp(d.tp, d.ta));
    this.send('music', String(d.music), uecpMessages.ms(d.music));
    this.send('stereo', String(d.stereo), uecpMessages.di(d.stereo));
    this.send('ps', d.ps, uecpMessages.ps(d.ps));
    if (this.abText !== d.rt) {
      // A new text flips the A/B flag, so receivers clear the old one.
      if (this.abText !== null) this.ab ^= 1;
      this.abText = d.rt;
    }
    this.send('rt', d.rt, uecpMessages.rt(d.rt, this.ab));
  }
}
