import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.HRS_NODE_DATA = mkdtempSync(join(tmpdir(), 'hrs-node-probe-'));
const { checkStreamDeep, IcyReader, icyTitle } = await import('../src/probe.js');

const meta = (title: string) => {
  const text = Buffer.from(`StreamTitle='${title}';`);
  const blocks = Math.ceil(text.length / 16);
  return Buffer.concat([Buffer.from([blocks]), text, Buffer.alloc(blocks * 16 - text.length)]);
};

test('reads titles and strips ICY metadata', () => {
  assert.equal(icyTitle("StreamTitle='Artist - Song';StreamUrl='';"), 'Artist - Song');
  const r = new IcyReader(4);
  const stream = Buffer.concat([Buffer.from('abcd'), meta('One'), Buffer.from('efgh'), Buffer.from([0]), Buffer.from('ij')]);
  // In awkward pieces, as a socket delivers them.
  const out = [stream.subarray(0, 3), stream.subarray(3, 9), stream.subarray(9)].map((c) => r.push(c));
  assert.equal(Buffer.concat(out).toString(), 'abcdefghij');
  assert.equal(r.title, 'One');
});

/** A stand-in for a relay: plays a file at its real bitrate, with ICY titles when the player asks for them. */
async function relay(file: Buffer, kbps: number) {
  const metaint = 8192;
  const server = http.createServer((req, res) => {
    const icy = req.headers['icy-metadata'] === '1';
    res.writeHead(200, { 'content-type': 'audio/mpeg', ...(icy ? { 'icy-metaint': String(metaint) } : {}) });
    let pos = 0;
    let sinceMeta = 0;
    const perTick = Math.round((kbps * 1000) / 8 / 10);
    const send = (n: number) => {
      while (n > 0 && pos < file.length) {
        const take = Math.min(n, icy ? metaint - sinceMeta : n, file.length - pos);
        res.write(file.subarray(pos, pos + take));
        pos += take;
        n -= take;
        sinceMeta += take;
        if (icy && sinceMeta === metaint) {
          res.write(meta('Harder.FM - Live'));
          sinceMeta = 0;
        }
      }
    };
    send(perTick * 10); // the burst on connect
    const timer = setInterval(() => send(perTick), 100);
    req.on('close', () => clearInterval(timer));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/live`, close: () => server.close() };
}

const ffmpeg = existsSync('/usr/bin/ffmpeg');
const mp3 = (source: string) => {
  const out = join(process.env.HRS_NODE_DATA!, `${source.replace(/\W/g, '')}.mp3`);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', source, '-t', '20', '-b:a', '128k', '-y', out]);
  return readFileSync(out);
};

test('a deep check measures bitrate, format, title and level', { skip: !ffmpeg && 'ffmpeg is not installed' }, async () => {
  const r = await relay(mp3('sine=frequency=440:sample_rate=44100'), 128);
  try {
    const res = await checkStreamDeep(r.url, 4);
    assert.equal(res.ok, true);
    assert.equal(res.contentType, 'audio/mpeg');
    assert.equal(res.title, 'Harder.FM - Live');
    assert.ok(res.bitrateKbps! > 110 && res.bitrateKbps! < 145, `bitrate ${res.bitrateKbps}`);
    assert.equal(res.silent, false);
    assert.ok(res.levelDb! > -20, `level ${res.levelDb}`);
  } finally {
    r.close();
  }
});

test('a stream of silence plays, but counts as silent', { skip: !ffmpeg && 'ffmpeg is not installed' }, async () => {
  const r = await relay(mp3('anullsrc=r=44100:cl=stereo'), 128);
  try {
    const res = await checkStreamDeep(r.url, 3);
    assert.equal(res.ok, true);
    assert.equal(res.silent, true);
    assert.match(res.message ?? '', /Silence/);
  } finally {
    r.close();
  }
});

test('a missing stream fails with its HTTP status', async () => {
  const server = http.createServer((_req, res) => res.writeHead(404).end());
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const res = await checkStreamDeep(`http://127.0.0.1:${(server.address() as AddressInfo).port}/x`, 3);
  server.close();
  assert.equal(res.ok, false);
  assert.equal(res.message, 'HTTP 404');
  assert.equal(res.silent, null);
});
