import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.HRS_NODE_DATA = mkdtempSync(join(tmpdir(), 'hrs-node-reporters-'));
const bin = join(process.env.HRS_NODE_DATA, 'livekit-server');
process.env.HRS_NODE_LIVEKIT_BIN = bin;
const { livekitConfigPath, renderLivekitConfig, ReporterManager, reporterSecret } = await import('../src/reporters.js');

test('derives the same LiveKit secret as the main server', () => {
  assert.equal(reporterSecret('abc'), createHmac('sha256', 'abc').update('livekit:api').digest('base64url'));
});

test('writes a LiveKit configuration with the web socket on 127.0.0.1 only', () => {
  const body = renderLivekitConfig({ signalPort: 17010, rtcPort: 8500, publicIp: null }, 'secret');
  assert.match(body, /^port: 17010$/m);
  assert.match(body, /^bind_addresses: \["127\.0\.0\.1"\]$/m);
  assert.match(body, /^ {2}udp_port: 8500$/m);
  assert.match(body, /^ {2}tcp_port: 8500$/m);
  assert.match(body, /^ {2}use_external_ip: true$/m);
  assert.match(body, /^ {2}hrs: "secret"$/m);
  const fixed = renderLivekitConfig({ signalPort: 17010, rtcPort: 8500, publicIp: '203.0.113.5' }, 'secret');
  assert.match(fixed, /^ {2}node_ip: "203\.0\.113\.5"$/m);
  // Never anything else than an address.
  assert.match(renderLivekitConfig({ signalPort: 17010, rtcPort: 8500, publicIp: '1.2.3.4"\nkeys:' }, 's'), /use_external_ip: true/);
});

test('reports installing, then running with the rooms LiveKit has', async () => {
  let auth = '';
  const server = http.createServer((req, res) => {
    if (req.url === '/') return res.end('OK');
    if (req.url === '/twirp/livekit.RoomService/ListRooms') {
      auth = String(req.headers.authorization);
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ rooms: [{ name: 'station-1', num_participants: 3 }, { name: 'station-2', num_participants: 0 }] }));
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const m = new ReporterManager(() => 'node-secret');
  assert.equal(await m.status(), null);
  const out = await m.apply({ signalPort: port, rtcPort: 8500, publicIp: null });
  assert.equal(out?.signalPort, port);
  assert.match(out!.config, /^[0-9a-f]{16}$/);
  assert.match(readFileSync(livekitConfigPath(), 'utf8'), new RegExp(`hrs: "${reporterSecret('node-secret')}"`));
  assert.equal((await m.status())?.state, 'installing');
  writeFileSync(bin, '');
  assert.deepEqual(await m.status(), { state: 'running', rooms: 1, participants: 3 });
  // The count is asked with a token signed with the node's own LiveKit secret.
  const [h, b, sig] = auth.slice(7).split('.');
  assert.equal(createHmac('sha256', reporterSecret('node-secret')).update(`${h}.${b}`).digest('base64url'), sig);
  await new Promise((r) => server.close(r));
  assert.equal((await m.status())?.state, 'error');
  assert.equal(m.problems.length, 1);
  assert.equal(await m.apply(null), null);
  assert.equal(await m.status(), null);
});
