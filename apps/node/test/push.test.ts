import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import tls from 'node:tls';

process.env.HRS_NODE_DATA = mkdtempSync(join(tmpdir(), 'hrs-node-push-'));
const { PushReceiver } = await import('../src/push.js');

const listen = (server: net.Server) => new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)));
const freePort = async () => {
  const s = net.createServer();
  const port = await listen(s);
  await new Promise((r) => s.close(r));
  return port;
};

/** A stand-in for the node's Icecast: takes one source, keeps what it receives. */
function fakeIcecast() {
  const got: { head: string; body: Buffer[] } = { head: '', body: [] };
  const server = net.createServer((socket) => {
    let head = '';
    const onData = (d: Buffer) => {
      if (got.head) return got.body.push(d);
      head += d.toString('latin1');
      const i = head.indexOf('\r\n\r\n');
      if (i < 0) return;
      got.head = head.slice(0, i);
      socket.write('HTTP/1.0 200 OK\r\n\r\n');
      const rest = Buffer.from(head.slice(i + 4), 'latin1');
      if (rest.length) got.body.push(rest);
    };
    socket.on('data', onData);
  });
  return { server, got };
}

function push(port: number, token: string, mount = '/listen/studio-fm/live') {
  return new Promise<{ socket: tls.TLSSocket; status: string }>((resolve, reject) => {
    const socket = tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false }, () => {
      socket.write(
        [`PUT ${mount} HTTP/1.1`, `Authorization: Basic ${Buffer.from(`source:${token}`).toString('base64')}`, 'Content-Type: audio/mpeg', 'Ice-Audio-Info: bitrate=128', 'Expect: 100-continue', '', ''].join('\r\n'),
      );
    });
    let text = '';
    socket.on('data', (d: Buffer) => {
      text += d.toString('latin1');
      const m = text.match(/HTTP\/1\.1 (?!100)(\d{3}[^\r\n]*)/);
      if (m) resolve({ socket, status: m[1]! });
    });
    socket.on('error', reject);
  });
}

test('takes a pushed stream with the right token and feeds it into the local Icecast', async () => {
  const ice = fakeIcecast();
  const icePort = await listen(ice.server);
  const receiver = new PushReceiver({ icecastPort: () => icePort, secrets: { source: 'src', admin: 'adm' } });
  const port = await freePort();
  const mount = { key: 'studio-fm/live', stationId: 'x', slug: 'studio-fm', path: '/live', name: 'Studio FM', format: 'mp3', url: null, push: { token: 'tok-123' } };
  await receiver.apply(port, [mount]);
  await new Promise((r) => setTimeout(r, 200));

  const wrong = await push(port, 'nope');
  assert.equal(wrong.status.slice(0, 3), '401');
  wrong.socket.destroy();
  const unknown = await push(port, 'tok-123', '/listen/other/live');
  assert.equal(unknown.status.slice(0, 3), '404');
  unknown.socket.destroy();

  const ok = await push(port, 'tok-123');
  assert.equal(ok.status.slice(0, 3), '200');
  assert.match(ice.got.head, /^PUT \/listen\/studio-fm\/live HTTP\/1\.1/);
  assert.match(ice.got.head, /Authorization: Basic c291cmNlOnNyYw==/);
  ok.socket.write(Buffer.from('audio-bytes'));
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(Buffer.concat(ice.got.body).toString(), 'audio-bytes');
  assert.equal(receiver.connected('studio-fm/live'), true);
  assert.equal(receiver.states()[0]!.bitrateKbps, 128);

  ok.socket.destroy();
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(receiver.connected('studio-fm/live'), false);
  receiver.stop();
  ice.server.close();
});
