import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.HRS_NODE_DATA = mkdtempSync(join(tmpdir(), 'hrs-node-recorder-'));
const { loggingArgs, parseLogFile, RecorderManager, recordingPath, recordingsDir } = await import('../src/recorder.js');

const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('names files after their start and bitrate, and refuses other paths', () => {
  assert.deepEqual(parseLogFile('2026-10-29_21-00-00Z_64k.mp3'), { startedAt: new Date('2026-10-29T21:00:00Z'), kbps: 64 });
  assert.equal(parseLogFile('notes.txt'), null);
  assert.equal(recordingPath(`${S1}/log/2026-10-29_21-00-00Z_64k.mp3`), join(recordingsDir(), S1, 'log', '2026-10-29_21-00-00Z_64k.mp3'));
  assert.equal(recordingPath(`${S1}/log/../../node.json`), null);
  assert.equal(recordingPath(`../${S1}/log/2026-10-29_21-00-00Z_64k.mp3`), null);
  assert.equal(recordingPath(`${S1}/show/2026-10-29_21-00-00Z_64k.mp3`), null);
  const args = loggingArgs('http://x/listen', 48, '/d', 'n1');
  assert.ok(args.includes('48k'));
  assert.equal(args.at(-1), '/d/%Y-%m-%d_%H-%M-%SZ_48k.mp3');
});

test('removes files past the retention, keeps the rest, and lists them for the server', async () => {
  const dir = join(recordingsDir(), S2, 'log');
  mkdirSync(dir, { recursive: true });
  const now = Date.parse('2026-10-29T12:00:00Z');
  for (const name of ['2026-10-20_10-00-00Z_64k.mp3', '2026-10-28_10-00-00Z_64k.mp3', '2026-10-29_11-00-00Z_64k.mp3']) writeFileSync(join(dir, name), Buffer.alloc(8000 * 60));
  const rec = new RecorderManager('n1');
  rec.apply({ stations: [{ stationId: S2, slug: 's2', name: 'S2', logging: { url: 'http://127.0.0.1:9/none', kbps: 64, days: 2 } }] });
  try {
    await rec.sweep(now);
    assert.deepEqual(readdirSync(dir).filter((n) => n.endsWith('.mp3')).sort(), ['2026-10-28_10-00-00Z_64k.mp3', '2026-10-29_11-00-00Z_64k.mp3']);
    const list = (await rec.report())!.filter((f) => f.stationId === S2);
    assert.deepEqual(
      list.map((f) => [f.file, f.startedAt, f.seconds]),
      [
        [`${S2}/log/2026-10-28_10-00-00Z_64k.mp3`, '2026-10-28T10:00:00.000Z', 60],
        [`${S2}/log/2026-10-29_11-00-00Z_64k.mp3`, '2026-10-29T11:00:00.000Z', 60],
      ],
    );
    // Sent once; again only when something changed.
    rec.reported(list);
    assert.equal(await rec.report(), undefined);
  } finally {
    rec.stop();
  }
});

test('sends a part of a file to the server', async () => {
  const dir = join(recordingsDir(), S1, 'log');
  mkdirSync(dir, { recursive: true });
  const name = '2026-10-29_09-00-00Z_64k.mp3';
  writeFileSync(join(dir, name), Buffer.from('0123456789'));
  let got: { url?: string; headers: http.IncomingHttpHeaders; body: string } | null = null;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      got = { url: req.url, headers: req.headers, body };
      res.writeHead(200).end('{}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const rec = new RecorderManager('n1');
  try {
    await rec.send(base, 'Node a.b', 'job-1', `${S1}/log/${name}`, 2, 6);
    assert.equal(got!.url, '/api/nodes/agent/recordings/job-1');
    assert.equal(got!.body, '2345');
    assert.equal(got!.headers['x-hrs-size'], '10');
    assert.equal(got!.headers['x-hrs-start'], '2');
    assert.equal(got!.headers.authorization, 'Node a.b');
    await assert.rejects(rec.send(base, 'Node a.b', 'job-2', `${S1}/log/2026-10-29_08-00-00Z_64k.mp3`, 0, null), /no longer on the recorder/);
    await assert.rejects(rec.send(base, 'Node a.b', 'job-3', `${S1}/log/${name}`, 10, null), /Outside the recording/);
  } finally {
    server.close();
  }
});

test('records a stream into hour files with ffmpeg', { skip: !existsSync('/usr/bin/ffmpeg') }, async () => {
  const src = join(process.env.HRS_NODE_DATA!, 'tone.mp3');
  execFileSync('/usr/bin/ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=30', '-c:a', 'libmp3lame', '-b:a', '128k', src]);
  const audio = readFileSync(src);
  // Plays the file at its bitrate, like a relay.
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'audio/mpeg' });
    let pos = 0;
    const timer = setInterval(() => {
      if (pos >= audio.length) return void (clearInterval(timer), res.end());
      res.write(audio.subarray(pos, (pos += 16_000)));
    }, 1000);
    res.on('close', () => clearInterval(timer));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/listen/s1/live`;
  const rec = new RecorderManager('n1');
  const S3 = '33333333-3333-4333-8333-333333333333';
  rec.apply({ stations: [{ stationId: S3, slug: 's3', name: 'S3', logging: { url, kbps: 32, days: 1 } }] });
  try {
    let state = '';
    for (let i = 0; i < 40 && state !== 'recording'; i++) {
      await wait(500);
      state = (await rec.status())!.stations[0]!.state;
    }
    assert.equal(state, 'recording');
    const files = (await rec.files()).filter((f) => f.stationId === S3);
    assert.equal(files.length, 1);
    assert.match(files[0]!.file, new RegExp(`^${S3}/log/\\d{4}-\\d{2}-\\d{2}_\\d{2}-\\d{2}-\\d{2}Z_32k\\.mp3$`));
    assert.equal(files[0]!.open, true);
    assert.ok(Math.abs(Date.parse(files[0]!.startedAt) - Date.now()) < 60_000);
  } finally {
    rec.stop();
    server.close();
  }
  await wait(500);
  const after = (await rec.files()).filter((f) => f.stationId === S3);
  assert.equal(after[0]!.open, false);
  assert.ok(after[0]!.bytes > 0);
});

test('records a live show as it is sent, and throws a short one away', { skip: !existsSync('/usr/bin/ffmpeg') }, async () => {
  const src = join(process.env.HRS_NODE_DATA!, 'show.mp3');
  execFileSync('/usr/bin/ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=30', '-c:a', 'libmp3lame', '-b:a', '128k', src]);
  const audio = readFileSync(src);
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'audio/mpeg' });
    let pos = 0;
    const timer = setInterval(() => {
      if (pos >= audio.length) return void (clearInterval(timer), res.end());
      res.write(audio.subarray(pos, (pos += 16_000)));
    }, 1000);
    res.on('close', () => clearInterval(timer));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/listen/s4/live`;
  const S4 = '44444444-4444-4444-8444-444444444444';
  const SID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const SID2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const station = (live: { sessionId: string }[], minMinutes: number) => ({
    stationId: S4,
    slug: 's4',
    name: 'S4',
    logging: null,
    shows: { days: 90, minMinutes, live: live.map((l) => ({ ...l, dj: 'DJ Test', startedAt: new Date().toISOString(), url, format: 'mp3' as const, kbps: 128 })) },
  });
  const rec = new RecorderManager('n1');
  try {
    rec.apply({ stations: [station([{ sessionId: SID }], 0)] });
    let state = '';
    for (let i = 0; i < 40 && state !== 'recording'; i++) {
      await wait(500);
      state = (await rec.status())!.stations.find((s) => s.sessionId === SID)?.state ?? '';
    }
    assert.equal(state, 'recording');
    let shows = (await rec.files()).filter((f) => f.stationId === S4 && f.kind === 'show');
    assert.equal(shows.length, 1);
    assert.equal(shows[0]!.sessionId, SID);
    assert.match(shows[0]!.file, new RegExp(`^${S4}/show/\\d{4}-\\d{2}-\\d{2}_\\d{2}-\\d{2}-\\d{2}Z_128k_${SID}\\.mp3$`));
    assert.equal(shows[0]!.open, true);
    // Off air: the file is complete and kept. A second show that is too short goes away.
    rec.apply({ stations: [station([{ sessionId: SID2 }], 1)] });
    for (let i = 0; i < 40 && !(await rec.files()).some((f) => f.sessionId === SID2 && f.bytes > 0); i++) await wait(500);
    rec.apply({ stations: [station([], 1)] });
    await wait(1500);
    shows = (await rec.files()).filter((f) => f.stationId === S4 && f.kind === 'show');
    assert.deepEqual(shows.map((f) => [f.sessionId, f.open]), [[SID, false]]);
    assert.ok(shows[0]!.bytes > 0);
    const probe = execFileSync('/usr/bin/ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,bit_rate', '-of', 'csv=p=0', join(recordingsDir(), shows[0]!.file)]).toString().trim();
    assert.equal(probe, 'mp3,128000');
  } finally {
    rec.stop();
    server.close();
  }
});
