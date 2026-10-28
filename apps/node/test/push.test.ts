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
  const got: { head: string; body: Buffer[]; titles: string[]; puts: number } = { head: '', body: [], titles: [], puts: 0 };
  const server = net.createServer((socket) => {
    let head = '';
    let source = false;
    const onData = (d: Buffer) => {
      if (source) return got.body.push(d);
      head += d.toString('latin1');
      const i = head.indexOf('\r\n\r\n');
      if (i < 0) return;
      // Title updates (GET /admin/metadata) come on connections of their own.
      if (head.startsWith('GET ')) {
        got.titles.push(new URL(head.split(' ')[1]!, 'http://x').searchParams.get('song') ?? '');
        return socket.end('HTTP/1.0 200 OK\r\nContent-Length: 0\r\n\r\n');
      }
      source = true;
      got.puts++;
      got.head = head.slice(0, i);
      socket.write('HTTP/1.0 200 OK\r\n\r\n');
      const rest = Buffer.from(head.slice(i + 4), 'latin1');
      if (rest.length) got.body.push(rest);
    };
    socket.on('data', onData);
  });
  return { server, got };
}

function push(port: number, token: string, mount = '/listen/studio-fm/live', priority?: number) {
  return new Promise<{ socket: tls.TLSSocket; status: string }>((resolve, reject) => {
    const socket = tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false }, () => {
      socket.write(
        [`PUT ${mount} HTTP/1.1`, `Authorization: Basic ${Buffer.from(`source:${token}`).toString('base64')}`, 'Content-Type: audio/mpeg', 'Ice-Audio-Info: bitrate=128', ...(priority === undefined ? [] : [`X-Hrs-Priority: ${priority}`]), 'Expect: 100-continue', '', ''].join('\r\n'),
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

test('keeps the backup ingest on standby and switches to it without dropping the local source', async () => {
  const ice = fakeIcecast();
  const icePort = await listen(ice.server);
  const receiver = new PushReceiver({ icecastPort: () => icePort, secrets: { source: 'src', admin: 'adm' } });
  const port = await freePort();
  await receiver.apply(port, [{ key: 'studio-fm/live', stationId: 'x', slug: 'studio-fm', path: '/live', name: 'Studio FM', format: 'mp3', url: null, push: { token: 'tok-123' } }]);
  await new Promise((r) => setTimeout(r, 200));

  const backup = await push(port, 'tok-123', undefined, 1);
  assert.equal(backup.status.slice(0, 3), '200');
  const main = await push(port, 'tok-123', undefined, 0);
  assert.equal(main.status.slice(0, 3), '200');
  main.socket.write(Buffer.from('main;'));
  backup.socket.write(Buffer.from('backup;'));
  // A title of the backup while it stands by is kept, not shown.
  await new Promise<void>((resolve) => {
    const q = new URLSearchParams({ mount: '/listen/studio-fm/live', mode: 'updinfo', song: 'Backup song' });
    const c = tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false }, () =>
      c.write(`GET /admin/metadata?${q} HTTP/1.1\r\nAuthorization: Basic ${Buffer.from('source:tok-123').toString('base64')}\r\nX-Hrs-Priority: 1\r\n\r\n`),
    );
    c.once('data', () => (c.destroy(), resolve()));
  });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(Buffer.concat(ice.got.body).toString(), 'main;');
  assert.deepEqual(ice.got.titles, []);

  main.socket.destroy();
  await new Promise((r) => setTimeout(r, 200));
  backup.socket.write(Buffer.from('backup;'));
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(Buffer.concat(ice.got.body).toString(), 'main;backup;');
  assert.equal(ice.got.head.match(/^PUT /gm)?.length, 1);
  assert.equal(receiver.connected('studio-fm/live'), true);
  assert.equal(receiver.states()[0]!.message, 'From the backup ingest');
  // On the switch the backup's last title comes along.
  assert.deepEqual(ice.got.titles, ['Backup song']);

  backup.socket.destroy();
  receiver.stop();
  ice.server.close();
});

test('takes over the source a puller kept open, so listeners stay connected when a station moves to a station node', async () => {
  const ice = fakeIcecast();
  const icePort = await listen(ice.server);
  const { sourceConnection } = await import('../src/relay.js');
  // The puller's source connection, still open after the main server stopped the stream.
  let kept: net.Socket | null = await sourceConnection(icePort, '/listen/studio-fm/live', 'src', { 'Content-Type': 'audio/mpeg' });
  kept.write(Buffer.from('pulled;'));
  const receiver = new PushReceiver({
    icecastPort: () => icePort,
    secrets: { source: 'src', admin: 'adm' },
    inherit: () => {
      const s = kept;
      kept = null;
      return s;
    },
  });
  const port = await freePort();
  await receiver.apply(port, [{ key: 'studio-fm/live', stationId: 'x', slug: 'studio-fm', path: '/live', name: 'Studio FM', format: 'mp3', url: null, push: { token: 'tok-123' } }]);
  await new Promise((r) => setTimeout(r, 200));

  const ok = await push(port, 'tok-123');
  assert.equal(ok.status.slice(0, 3), '200');
  ok.socket.write(Buffer.from('pushed;'));
  await new Promise((r) => setTimeout(r, 200));
  // One source login on Icecast: the push continues on the puller's connection.
  assert.equal(ice.got.head.match(/^PUT /gm)?.length, 1);
  assert.equal(Buffer.concat(ice.got.body).toString(), 'pulled;pushed;');
  assert.equal(receiver.connected('studio-fm/live'), true);

  ok.socket.destroy();
  receiver.stop();
  ice.server.close();
});

test('hands its source back when the stream is pulled again (the station moved back from its station node)', async () => {
  const ice = fakeIcecast();
  const icePort = await listen(ice.server);
  const receiver = new PushReceiver({ icecastPort: () => icePort, secrets: { source: 'src', admin: 'adm' } });
  const port = await freePort();
  const mount = { key: 'studio-fm/live', stationId: 'x', slug: 'studio-fm', path: '/live', name: 'Studio FM', format: 'mp3', url: null, push: { token: 'tok-123' } };
  await receiver.apply(port, [mount]);
  await new Promise((r) => setTimeout(r, 200));
  const ok = await push(port, 'tok-123');
  ok.socket.write(Buffer.from('pushed;'));
  await new Promise((r) => setTimeout(r, 200));

  let back: net.Socket | null = null;
  await receiver.apply(port, [{ ...mount, url: 'http://main/listen/studio-fm/live', push: null }], (_key, local) => (back = local));
  assert.ok(back);
  (back as net.Socket).write(Buffer.from('pulled;'));
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(ice.got.head.match(/^PUT /gm)?.length, 1);
  assert.equal(Buffer.concat(ice.got.body).toString(), 'pushed;pulled;');

  (back as net.Socket).destroy();
  ok.socket.destroy();
  receiver.stop();
  ice.server.close();
});

test('keeps its source open a moment when the push ends, for a push that comes back or a puller that takes it back', async () => {
  const ice = fakeIcecast();
  const icePort = await listen(ice.server);
  const receiver = new PushReceiver({ icecastPort: () => icePort, secrets: { source: 'src', admin: 'adm' }, lingerMs: 600 });
  const port = await freePort();
  const mount = { key: 'studio-fm/live', stationId: 'x', slug: 'studio-fm', path: '/live', name: 'Studio FM', format: 'mp3', url: null, push: { token: 'tok-123' } };
  await receiver.apply(port, [mount]);
  await new Promise((r) => setTimeout(r, 200));

  // The station node restarts its stream: the new push continues on the same source connection.
  const first = await push(port, 'tok-123');
  first.socket.write(Buffer.from('one;'));
  await new Promise((r) => setTimeout(r, 100));
  first.socket.destroy();
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(receiver.connected('studio-fm/live'), false);
  const again = await push(port, 'tok-123');
  again.socket.write(Buffer.from('two;'));
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(ice.got.puts, 1);
  assert.equal(Buffer.concat(ice.got.body).toString(), 'one;two;');

  // The station moves back: the node stops pushing before this relay is told to pull, and still gets the source back.
  again.socket.destroy();
  await new Promise((r) => setTimeout(r, 200));
  let back: net.Socket | null = null;
  await receiver.apply(port, [{ ...mount, url: 'http://main/listen/studio-fm/live', push: null }], (_key, local) => (back = local));
  assert.ok(back);
  assert.equal((back as net.Socket).destroyed, false);
  (back as net.Socket).destroy();

  // Nobody comes back: after the wait the source closes, so Icecast ends the stream.
  await receiver.apply(port, [mount]);
  const last = await push(port, 'tok-123');
  last.socket.destroy();
  await new Promise((r) => setTimeout(r, 900));
  const fresh = await push(port, 'tok-123');
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(ice.got.puts, 3);

  fresh.socket.destroy();
  receiver.stop();
  ice.server.close();
});

test('a puller keeps its source open when the pulled stream ends, so listeners stay connected when it comes back', async () => {
  const { createServer } = await import('node:http');
  const { RelayManager } = await import('../src/relay.js');
  const ice = fakeIcecast();
  const icePort = await listen(ice.server);
  // The main server's stream: ends after the first chunk, then plays again.
  let served = 0;
  const main = createServer((_req, res) => {
    served++;
    res.writeHead(200, { 'content-type': 'audio/mpeg' });
    if (served === 1) return res.end('first;');
    res.write('second;');
  });
  const mainPort = await listen(main);
  const relay = new RelayManager({ icecastPort: () => icePort, secrets: { source: 'src', admin: 'adm' }, nodeId: 'n', trustClientHeader: false });
  relay.apply([{ key: 'studio-fm/live', stationId: 'x', slug: 'studio-fm', path: '/live', name: 'Studio FM', format: 'mp3', url: `http://127.0.0.1:${mainPort}/listen/studio-fm/live`, push: null }]);
  await new Promise((r) => setTimeout(r, 1800));
  assert.ok(served >= 2);
  assert.equal(ice.got.puts, 1);
  assert.equal(Buffer.concat(ice.got.body).toString(), 'first;second;');
  relay.stopAll();
  main.closeAllConnections();
  main.close();
  ice.server.close();
});

test('listens on the new and the old push port while the node keeps its old ports (port plan)', async () => {
  const ice = fakeIcecast();
  const icePort = await listen(ice.server);
  const receiver = new PushReceiver({ icecastPort: () => icePort, secrets: { source: 'src', admin: 'adm' } });
  const [fresh, old] = [await freePort(), await freePort()];
  const mount = { key: 'studio-fm/live', stationId: 'x', slug: 'studio-fm', path: '/live', name: 'Studio FM', format: 'mp3', url: null, push: { token: 'tok-123' } };
  await receiver.apply([fresh, old], [mount]);
  await new Promise((r) => setTimeout(r, 200));
  for (const port of [fresh, old]) {
    const wrong = await push(port, 'nope');
    assert.equal(wrong.status.slice(0, 3), '401');
    wrong.socket.destroy();
  }
  // Switched off: only the new port is left.
  await receiver.apply([fresh], [mount]);
  await new Promise((r) => setTimeout(r, 200));
  await assert.rejects(push(old, 'nope'));
  const still = await push(fresh, 'nope');
  assert.equal(still.status.slice(0, 3), '401');
  still.socket.destroy();
  receiver.stop();
  ice.server.close();
});
