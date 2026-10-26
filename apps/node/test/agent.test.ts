import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseClients, renderIcecastConfig } from '../src/icecast.js';
import { IcyReader } from '../src/relay.js';
import { signPreamble } from '../src/source.js';
import { parsePing } from '../src/system.js';

test('ICY metadata is taken out of the audio and the title is read', () => {
  const titles: string[] = [];
  const reader = new IcyReader(4, (t) => titles.push(t));
  const meta = Buffer.from("StreamTitle='Artist - Song';");
  const block = Buffer.concat([meta, Buffer.alloc(Math.ceil(meta.length / 16) * 16 - meta.length)]);
  const stream = Buffer.concat([Buffer.from('abcd'), Buffer.from([block.length / 16]), block, Buffer.from('efgh'), Buffer.from([0]), Buffer.from('ij')]);
  // Fed in awkward pieces, as the network delivers it.
  const out: Buffer[] = [];
  for (let i = 0; i < stream.length; i += 3) out.push(...reader.push(stream.subarray(i, i + 3)));
  assert.equal(Buffer.concat(out).toString(), 'abcdefghij');
  assert.deepEqual(titles, ['Artist - Song']);
});

test('the preamble is signed exactly like the main server expects', () => {
  // The same input signed by apps/api/src/services/nodes/preamble.ts.
  const line = signPreamble('s3cret', { nodeId: '11111111-2222-3333-4444-555555555555', via: 'tls', ip: '203.0.113.7', host: 'src.example.com' }, 1_800_000_000_000);
  assert.equal(line, 'HRSNODE 1 11111111-2222-3333-4444-555555555555 1800000000 tls 203.0.113.7 src.example.com b7d3b3d3d326fdff651973d1b9379db13ca782596bf377f8ff3237f88b493c7c\r\n');
});

test('ping summaries are read', () => {
  const out = '--- 10.0.0.1 ping statistics ---\n10 packets transmitted, 9 received, 10% packet loss, time 4508ms\nrtt min/avg/max/mdev = 0.412/0.873/1.920/0.401 ms\n';
  assert.deepEqual(parsePing(out), { loss: 0.1, rttMs: 0.873 });
  assert.equal(parsePing('ping: unknown host'), null);
});

test('icecast config has a mount with listener hooks per carried stream', () => {
  const xml = renderIcecastConfig({
    name: 'Relay <AMS>',
    hostname: 'relay.example.com',
    layout: { bind: '127.0.0.1', port: 8100 },
    mounts: [{ key: 'harder/live', stationId: 'x', slug: 'harder', path: '/live', name: 'Harder.fm', format: 'mp3', url: 'http://main/listen/harder/live' }],
    maxListeners: 0,
    secrets: { source: 's', admin: 'a' },
  });
  assert.match(xml, /<mount-name>\/listen\/harder\/live<\/mount-name>/);
  assert.match(xml, /listener_add" value="http:\/\/127\.0\.0\.1:\d+\/hook\/add"/);
  assert.match(xml, /<location>Relay &lt;AMS&gt;<\/location>/);
  assert.match(xml, /<bind-address>127\.0\.0\.1<\/bind-address>/);
});

test('icecast client lists are parsed', () => {
  const body = '<icestats><source mount="/x"><listener><IP>1.2.3.4</IP><UserAgent>VLC/3.0</UserAgent><Connected>42</Connected><ID>7</ID></listener></source></icestats>';
  assert.deepEqual(parseClients(body), [{ id: '7', ip: '1.2.3.4', userAgent: 'VLC/3.0', connectedSeconds: 42 }]);
});

test('draining before an update disconnects the listeners one by one', async () => {
  const { createServer } = await import('node:http');
  const { RelayManager } = await import('../src/relay.js');
  const kills: { path: string; at: number }[] = [];
  // Stands in for both the main server's stream (404, so the puller just waits) and the node's Icecast admin.
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/admin/killclient')) kills.push({ path: req.url, at: Date.now() });
    res.writeHead(req.url?.startsWith('/admin/') ? 200 : 404).end('<iceresponse/>');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  const relay = new RelayManager({ icecastPort: () => port, secrets: { source: 's', admin: 'a' }, nodeId: 'n', trustClientHeader: false });
  relay.apply([{ key: 'harder/live', stationId: 'x', slug: 'harder', path: '/live', name: 'Harder', format: 'mp3', url: `http://127.0.0.1:${port}/listen/harder/live` }]);
  for (const id of ['1', '2', '3']) relay.hook('add', new URLSearchParams({ mount: '/listen/harder/live', client: id, agent: 'VLC/3.0', ip: '203.0.113.1' }));
  assert.equal(relay.listenerCount, 3);
  const start = Date.now();
  relay.drain(1);
  await new Promise((r) => setTimeout(r, 1200));
  relay.stopAll();
  server.close();
  assert.deepEqual(kills.map((k) => new URLSearchParams(k.path.split('?')[1]).get('id')), ['1', '2', '3']);
  assert.equal(new URLSearchParams(kills[0]!.path.split('?')[1]).get('mount'), '/listen/harder/live');
  // Spread out, not all at once.
  assert.ok(kills[2]!.at - start >= 400);
});
