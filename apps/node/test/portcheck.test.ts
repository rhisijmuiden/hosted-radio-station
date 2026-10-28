import assert from 'node:assert/strict';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { checkPorts } from '../src/portcheck.js';

test('a port check tells open ports from closed ones', async () => {
  const server = net.createServer((s) => s.end());
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const open = (server.address() as AddressInfo).port;
  // A port that was just free: nothing listens there.
  const spare = net.createServer();
  await new Promise<void>((r) => spare.listen(0, '127.0.0.1', r));
  const closed = (spare.address() as AddressInfo).port;
  await new Promise<void>((r) => spare.close(() => r()));
  try {
    const res = await checkPorts('127.0.0.1', [closed, open, open, 0, 70000], 2000);
    assert.equal(res.address, '127.0.0.1');
    assert.deepEqual(
      res.results.map((r) => [r.port, r.ok, r.message]),
      [
        [Math.min(open, closed), Math.min(open, closed) === open, Math.min(open, closed) === open ? null : 'refused'],
        [Math.max(open, closed), Math.max(open, closed) === open, Math.max(open, closed) === open ? null : 'refused'],
      ],
    );
  } finally {
    server.close();
  }
});

test('a name that does not resolve fails every port with dns', async () => {
  const res = await checkPorts('does-not-exist.invalid', [80, 443]);
  assert.equal(res.address, null);
  assert.deepEqual(res.results.map((r) => r.message), ['dns', 'dns']);
});
