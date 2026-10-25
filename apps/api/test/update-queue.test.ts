import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { login, setup } from './helpers.js';

let t: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => {
  t = await setup({ SYSTEM_HELPERS: '1' });
});
afterAll(() => t.close());

it('queues an update request for the root helper and switches channel', async () => {
  const headers = await login(t.app, 'admin@example.com', 'admin-password');
  const res = await t.app.inject({ method: 'POST', url: '/api/system/update', headers, payload: { channel: 'test' } });
  expect(res.statusCode).toBe(202);
  const request = JSON.parse(readFileSync(join(t.ctx.config.DATA_DIR, 'run', 'update-request.json'), 'utf8'));
  expect(request).toMatchObject({ id: res.json().id, channel: 'test', requestedBy: 'admin@example.com' });

  const status = await t.app.inject({ url: '/api/system/update/status', headers });
  expect(status.json().state).toBe('queued');
  const again = await t.app.inject({ method: 'POST', url: '/api/system/update', headers, payload: {} });
  expect(again.statusCode).toBe(409);
  expect((await t.app.inject({ url: '/api/system/info', headers })).json().channel).toBe('test');
});

it('strips terminal colour codes from the update log', async () => {
  const headers = await login(t.app, 'admin@example.com', 'admin-password');
  writeFileSync(join(t.ctx.config.DATA_DIR, 'run', 'update.log'), '\u001b[36mvite\u001b[39m building\u001b[0m\n');
  const status = await t.app.inject({ url: '/api/system/update/status', headers });
  expect(status.json().log).toBe('vite building\n');
});
