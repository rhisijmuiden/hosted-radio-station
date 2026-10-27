import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

// The agent reads its paths when it loads, so they point to a scratch folder first.
const dir = mkdtempSync(join(tmpdir(), 'hrs-node-enroll-'));
process.env.HRS_NODE_CONFIG = join(dir, 'etc', 'node.json');
process.env.HRS_NODE_DATA = join(dir, 'data');
process.env.HRS_NODE_INSTALL = join(dir, 'opt');
const SETUP_PORT = 20000 + Math.floor(Math.random() * 20000);
process.env.HRS_NODE_SETUP_PORT = String(SETUP_PORT);
process.env.HRS_NODE_LOG = 'error';

const { checkRegistration, register, setupPageHtml, waitForPairing, normalizeServer } = await import('../src/enroll.js');

/** A fake orchestrator: one valid pairing code, and a registration that is accepted on the second question. */
let orchestrator: http.Server;
let server = '';
let statusCalls = 0;
let registered: Record<string, unknown> | null = null;
before(async () => {
  orchestrator = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const json = (status: number, data: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(data));
      const b = JSON.parse(body || '{}');
      if (req.url === '/api/nodes/pair') {
        if (b.code === 'GOOD-CODE-1234') return json(200, { nodeId: '11111111-2222-3333-4444-555555555555', name: 'radionode4', secret: 's3cret-from-code' });
        return json(400, { error: { code: 'invalid_code', message: 'This pairing code is unknown or has expired' } });
      }
      if (req.url === '/api/nodes/register') {
        registered = b;
        return json(201, { id: '99999999-2222-3333-4444-555555555555', code: 'K7QM-3XRA', token: 'token-token-token-token-token', expiresAt: new Date(Date.now() + 86_400_000).toISOString(), pollSeconds: 5 });
      }
      if (req.url === '/api/nodes/register/status') {
        statusCalls++;
        return json(200, statusCalls < 2 ? { state: 'pending' } : { state: 'accepted', nodeId: '22222222-2222-3333-4444-555555555555', name: 'radionode5', secret: 's3cret-from-registration' });
      }
      json(404, {});
    });
  });
  await new Promise<void>((r) => orchestrator.listen(0, '127.0.0.1', () => r()));
  server = `http://127.0.0.1:${(orchestrator.address() as AddressInfo).port}`;
});
after(() => {
  orchestrator.close();
  rmSync(dir, { recursive: true, force: true });
});

const form = (data: Record<string, string>, lang = 'en') =>
  fetch(`http://127.0.0.1:${SETUP_PORT}/`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'accept-language': lang }, body: new URLSearchParams(data) });

test('orchestrator addresses are cleaned up', () => {
  assert.equal(normalizeServer(' radio.example.com/ '), 'https://radio.example.com');
  assert.equal(normalizeServer('http://10.10.4.240'), 'http://10.10.4.240');
  assert.throws(() => normalizeServer('not a url'));
});

test('the setup page has only the orchestrator URL and the pairing code, in English and Dutch', () => {
  const en = setupPageHtml('en');
  assert.equal((en.match(/<input /g) ?? []).length, 2);
  assert.match(en, /name="server"/);
  assert.match(en, /name="code"/);
  assert.match(setupPageHtml('nl'), /Koppelcode/);
  // What the user typed is escaped.
  assert.doesNotMatch(setupPageHtml('en', { server: '"><script>' }), /<script>/);
});

test('pairing on the setup page writes node.json and closes the page for good', async () => {
  const paired = waitForPairing();
  // The page needs a moment to start listening.
  for (let i = 0; i < 50; i++) {
    const ok = await fetch(`http://127.0.0.1:${SETUP_PORT}/`).then((r) => r.ok, () => false);
    if (ok) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const page = await (await fetch(`http://127.0.0.1:${SETUP_PORT}/`, { headers: { 'accept-language': 'nl-NL,nl;q=0.9' } })).text();
  assert.match(page, /Deze node instellen/);

  const wrong = await form({ server, code: 'BAD' });
  assert.equal(wrong.status, 400);
  assert.match(await wrong.text(), /unknown or has expired/);
  assert.equal(existsSync(process.env.HRS_NODE_CONFIG!), false);

  const right = await form({ server, code: 'GOOD-CODE-1234' });
  assert.equal(right.status, 200);
  assert.match(await right.text(), /Paired as “radionode4”/);

  const file = await paired;
  assert.equal(file.nodeId, '11111111-2222-3333-4444-555555555555');
  assert.equal(file.secret, 's3cret-from-code');
  assert.equal(file.server, server);
  await assert.rejects(fetch(`http://127.0.0.1:${SETUP_PORT}/`));
  rmSync(process.env.HRS_NODE_CONFIG!);
});

test('a registration waits for acceptance and then becomes node.json', async () => {
  const reg = await register(server, 'relay');
  assert.equal(reg.code, 'K7QM-3XRA');
  assert.equal(registered?.role, 'relay');
  assert.equal(typeof registered?.hostname, 'string');
  assert.equal(await checkRegistration(reg), 'pending');
  const file = await waitForPairing();
  assert.equal(file.nodeId, '22222222-2222-3333-4444-555555555555');
  assert.equal(file.secret, 's3cret-from-registration');
  assert.equal(existsSync(join(process.env.HRS_NODE_DATA!, 'registration.json')), false);
});
