import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.HRS_NODE_DATA = mkdtempSync(join(tmpdir(), 'hrs-node-ingest-'));
const { IngestManager } = await import('../src/ingest.js');

const SECRET = 'ingest-secret';
const token = (key: string) => createHmac('sha256', SECRET).update(`record:${key}`).digest('base64url');

/** Sends a request line to the ingest the way the encoder port hands it over, and returns what comes back. */
async function ask(ingest: InstanceType<typeof IngestManager>, path: string): Promise<string> {
  const server = net.createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const accepted = new Promise<net.Socket>((r) => server.once('connection', r));
  const client = net.connect((server.address() as AddressInfo).port, '127.0.0.1');
  const side = await accepted;
  let got = '';
  client.on('data', (d) => (got += d.toString('latin1')));
  const req = { method: 'GET', path, version: 'HTTP/1.1', headers: new Map<string, string>(), rawHeaders: [] as [string, string][], rest: Buffer.alloc(0) };
  assert.equal(ingest.takes(req, null), path.startsWith('/ingest/s1/live') || path.startsWith('/ingest/s1/low'));
  if (ingest.takes(req, null)) void ingest.handle(side, req, 'plain', '127.0.0.1', null);
  await new Promise((r) => setTimeout(r, 1600));
  client.destroy();
  side.destroy();
  server.close();
  return got;
}

test('a recorder reads a mount straight from the ingest with its token, nobody else', async () => {
  // The node's own Icecast with the ingest mount on air.
  const icecast = http.createServer((req, res) => {
    if (req.url !== '/ingest/s1/live') return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'audio/mpeg' });
    res.write(Buffer.from('ID3audio'));
  });
  await new Promise<void>((r) => icecast.listen(0, '127.0.0.1', () => r()));
  const ingest = new IngestManager({
    icecastPort: () => (icecast.address() as AddressInfo).port,
    secrets: { source: 's', admin: 'a' },
    nodeId: 'n1',
    secret: () => SECRET,
    auth: async () => null,
    live: () => undefined,
  });
  const mount = (path: string, kind: 'source' | 'transcode', isPublic = true) => ({ path, name: '', kind, format: 'mp3', bitrateKbps: 128, sourcePath: kind === 'transcode' ? '/live' : null, fallbackPath: null, isPublic });
  ingest.apply({
    stations: [{ stationId: 'st1', slug: 's1', name: 'S1', tenantId: 't1', priority: 0, mounts: [mount('/live', 'source'), mount('/low', 'transcode'), mount('/raw', 'source', false)], targets: [], outputs: [] }],
    hosts: {},
  });
  try {
    const ok = await ask(ingest, `/ingest/s1/live?token=${token('s1/live')}`);
    assert.match(ok, /^HTTP\/1\.0 200 OK/);
    assert.match(ok, /Content-Type: audio\/mpeg/);
    assert.match(ok, /ID3audio$/);
    assert.match(await ask(ingest, `/ingest/s1/live?token=${token('s1/low')}`), /^HTTP\/1\.0 403/);
    assert.match(await ask(ingest, '/ingest/s1/live'), /^HTTP\/1\.0 403/);
    // A mount that is not on air.
    assert.match(await ask(ingest, `/ingest/s1/low?token=${token('s1/low')}`), /^HTTP\/1\.0 404/);
    // Not a public mount: not offered at all.
    await ask(ingest, `/ingest/s1/raw?token=${token('s1/raw')}`);
  } finally {
    ingest.apply(null);
    icecast.closeAllConnections();
    icecast.close();
  }
});
