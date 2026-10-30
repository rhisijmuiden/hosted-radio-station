import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import dgram from 'node:dgram';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { FmPlan, FmStereoTool } from '../src/protocol.js';

process.env.HRS_NODE_DATA = mkdtempSync(join(tmpdir(), 'hrs-node-st-'));
const { FmManager } = await import('../src/fm/manager.js');
const { MPX_RATE, MpxGenerator } = await import('../src/fm/mpx.js');
const { stereoToolArgs, wavHeader } = await import('../src/fm/stereotool.js');

const st: FmStereoTool = { binary: { sha256: 'f'.repeat(64), size: 1 }, licence: 'KEY-1', mpx: 'stereotool', inputRate: 192000, webPort: 17010, uecpPort: 17011, extraArgs: ['--x'] };

test('Stereo Tool arguments: stdin to stdout, licence, web interface and extra options', () => {
  assert.deepEqual(stereoToolArgs(st, null), ['-', '-', '-q', '-k', 'KEY-1', '-w', '17010', '--x']);
  assert.deepEqual(stereoToolArgs({ ...st, licence: '', extraArgs: [] }, '/p.sts'), ['-', '-', '-q', '-s', '/p.sts', '-w', '17010']);
});

test('WAV header for a pipe: PCM, rate, channels and open-ended sizes', () => {
  const h = wavHeader(192000);
  assert.equal(h.toString('ascii', 0, 4), 'RIFF');
  assert.equal(h.readUInt32LE(4), 0xffffffff);
  assert.equal(h.readUInt16LE(20), 1);
  assert.equal(h.readUInt16LE(22), 2);
  assert.equal(h.readUInt32LE(24), 192000);
  assert.equal(h.readUInt32LE(28), 192000 * 4);
  assert.equal(h.readUInt32LE(40), 0xffffffff);
});

test('MPX passthrough: the first channel goes out as it is, without a pilot', () => {
  const gen = new MpxGenerator(null);
  gen.configure({ passthrough: true, bufferSeconds: 0.5, gainDb: 0 });
  const frames = MPX_RATE;
  const buf = Buffer.alloc(frames * 8);
  for (let i = 0; i < frames; i++) {
    buf.writeFloatLE(0.5, i * 8);
    buf.writeFloatLE(-0.25, i * 8 + 4);
  }
  gen.push(buf);
  const out = gen.render(1000);
  assert.ok(out.every((v) => Math.abs(v - 0.5) < 1e-6));
  // Without audio: silence, also no pilot (Stereo Tool makes it).
  const silent = new MpxGenerator(null);
  silent.configure({ passthrough: true });
  assert.ok(silent.render(1000).every((v) => v === 0));
});

const hasFfmpeg = spawnSync('sh', ['-c', 'command -v ffmpeg'], { stdio: 'ignore' }).status === 0;

test('FM chain through Stereo Tool: decoder, Stereo Tool, MPX reader, RTP out', { skip: !hasFfmpeg && 'ffmpeg is not installed' }, async (t) => {
  // A stand-in for Stereo Tool that notes its arguments and passes the audio through.
  const dir = join(process.env.HRS_NODE_DATA!, 'stereotool');
  mkdirSync(dir, { recursive: true });
  const argsFile = join(dir, 'args.txt');
  writeFileSync(join(dir, 'stereo_tool_cmd_64'), `#!/bin/sh\necho "$@" > ${argsFile}\nexec cat\n`);
  chmodSync(join(dir, 'stereo_tool_cmd_64'), 0o755);
  writeFileSync(join(dir, 'stereo_tool_cmd_64.sha256'), `${st.binary!.sha256}\n`);

  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'audio/mpeg' });
    const src = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-re', '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000', '-ac', '2', '-f', 'mp3', 'pipe:1'], { stdio: ['ignore', 'pipe', 'ignore'] });
    src.stdout.pipe(res);
    res.once('close', () => src.kill('SIGKILL'));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const udp = dgram.createSocket('udp4');
  await new Promise<void>((r) => udp.bind(0, '127.0.0.1', r));
  let packets = 0;
  udp.on('message', () => packets++);

  const fm = new FmManager('node-1', { url: 'http://127.0.0.1:9', secret: 's' });
  t.after(() => {
    fm.stop();
    server.close();
    udp.close();
  });
  const plan: FmPlan = {
    station: { id: 's', slug: 'test', name: 'Test FM' },
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/live`,
    texts: { ps: 'TEST', psMode: 'static', psSeconds: 4, rtSong: '{title}', rtLive: '{dj}', rtIdle: '{station}' },
    rds: { enabled: true, pi: 0x8000, pty: 0, tp: false, ta: false, music: true, af: [], rtPlus: false, clock: false, timezone: 'Europe/Amsterdam' },
    audio: { stereo: true, preemphasis: 50, limiter: true, pilot: 0.09, rdsLevel: 0.04, gainDb: 0, bufferSeconds: 0.5 },
    output: { kind: 'rtp', device: 'default', channels: 1, rtpHost: '127.0.0.1', rtpPort: (udp.address() as AddressInfo).port, rtpTtl: 1 },
    uecp: null,
    stereoTool: st,
  };
  fm.apply(plan);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && !(fm.status()?.stereoTool?.state === 'running' && fm.status()?.meters?.playing && packets > 50)) await new Promise((r) => setTimeout(r, 200));
  const status = fm.status()!;
  assert.equal(status.stereoTool?.state, 'running', JSON.stringify(status));
  assert.equal(status.input, 'connected');
  assert.ok(status.meters?.playing, 'MPX is playing');
  assert.ok(packets > 50, `RTP packets arrive (${packets})`);
  assert.match(readFileSync(argsFile, 'utf8'), /^- - -q -k KEY-1 -w 17010 --x/);
});
