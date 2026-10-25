import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { chownSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lastSlot, nextSlot, processQueue, tickScheduler } from '../src/services/backup/jobs.js';
import { rcloneObscure } from '../src/services/backup/targets.js';
import { login, setup } from './helpers.js';

const hasTools = (() => {
  try {
    execFileSync('restic', ['version']);
    execFileSync('rclone', ['version']);
    return true;
  } catch {
    return false;
  }
})();

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });

const hasFtpServer = (() => {
  try {
    execFileSync('python3', ['-c', 'import pyftpdlib, OpenSSL']);
    return true;
  } catch {
    return false;
  }
})();

/** SFTP comes from `rclone serve sftp`; FTP and FTPS from pyftpdlib (test/fixtures/ftp-server.py). */
async function serve(kind: 'sftp' | 'ftp' | 'ftps', dir: string) {
  const port = await freePort();
  let child: ChildProcess;
  if (kind === 'sftp') {
    child = spawn('rclone', ['serve', 'sftp', dir, '--addr', `127.0.0.1:${port}`, '--user', 'backup', '--pass', 'p@ss word'], { stdio: 'ignore' });
  } else {
    const args = [join(import.meta.dirname, 'fixtures', 'ftp-server.py'), dir, String(port), 'backup', 'p@ss word'];
    if (kind === 'ftps') {
      const cert = join(dir, '..', `cert-${port}.pem`);
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-keyout', cert, '-out', cert], { stdio: 'ignore' });
      args.push(cert);
    }
    child = spawn('python3', args, { stdio: 'ignore' });
  }
  for (let i = 0; i < 50; i++) {
    const up = await new Promise<boolean>((r) => {
      const sock = createServer();
      sock.once('error', () => r(true));
      sock.listen(port, '127.0.0.1', () => sock.close(() => r(false)));
    });
    if (up) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  return { port, child };
}

let t: Awaited<ReturnType<typeof setup>>;
let admin: { cookie: string };
let configDir: string;
const children: ChildProcess[] = [];

beforeAll(async () => {
  configDir = mkdtempSync(join(tmpdir(), 'hrs-conf-'));
  writeFileSync(join(configDir, 'hosted-radio.env'), 'EXAMPLE=1\n');
  t = await setup({ BACKUP_CONFIG_PATHS: configDir });
  admin = await login(t.app, 'admin@example.com', 'admin-password');
});
afterAll(async () => {
  for (const c of children) c.kill();
  await t.close();
});

describe('schedule', () => {
  const schedule = { incremental: { enabled: true, everyHours: 6, at: '01:30' }, full: { enabled: true, weekday: 0, at: '03:00' } };
  it('finds the last and next moments', () => {
    const now = new Date(2026, 9, 21, 14, 0); // Wednesday 14:00
    expect(lastSlot(schedule, 'incremental', now)).toEqual(new Date(2026, 9, 21, 13, 30));
    expect(nextSlot(schedule, 'incremental', now)).toEqual(new Date(2026, 9, 21, 19, 30));
    expect(lastSlot(schedule, 'full', now)).toEqual(new Date(2026, 9, 18, 3, 0)); // Sunday
    expect(nextSlot(schedule, 'full', now)).toEqual(new Date(2026, 9, 25, 3, 0));
    expect(lastSlot({ ...schedule, full: { ...schedule.full, enabled: false } }, 'full', now)).toBeNull();
  });
});

describe('rclone', () => {
  it.skipIf(!hasTools)('obscures passwords exactly like rclone', () => {
    expect(execFileSync('rclone', ['reveal', rcloneObscure('p@ss word €')]).toString().trim()).toBe('p@ss word €');
  });
});

describe.skipIf(!hasTools)('backup and restore', () => {
  let localId: string;
  let recoveryKey: string;
  const repoDir = join(mkdtempSync(join(tmpdir(), 'hrs-repo-')), 'repo');

  const runAndWait = async (id: string, kind: 'full' | 'incremental') => {
    const res = await t.app.inject({ method: 'POST', url: `/api/backups/targets/${id}/run`, headers: admin, payload: { kind } });
    expect(res.statusCode).toBe(202);
    await processQueue(t.ctx);
    const run = (await t.app.inject({ url: `/api/backups/runs/${res.json().id}`, headers: admin })).json();
    if (run.state !== 'succeeded') console.log(run.log);
    return run;
  };

  it('tests a new location', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/backups/test', headers: admin, payload: { type: 'local', config: { path: repoDir } } });
    expect(res.json()).toMatchObject({ ok: true, repository: 'empty' });
    const bad = await t.app.inject({ method: 'POST', url: '/api/backups/test', headers: admin, payload: { type: 'local', config: { path: '/nonexistent/x/repo' } } });
    expect(bad.statusCode).toBe(400);
  });

  it('makes full and incremental backups', async () => {
    mkdirSync(join(t.ctx.config.DATA_DIR, 'media'), { recursive: true });
    writeFileSync(join(t.ctx.config.DATA_DIR, 'media', 'jingle.mp3'), 'first version');
    const created = await t.app.inject({ method: 'POST', url: '/api/backups/targets', headers: admin, payload: { name: 'NAS', type: 'local', config: { path: repoDir } } });
    expect(created.statusCode).toBe(201);
    localId = created.json().id;
    recoveryKey = created.json().recoveryKey;
    expect(recoveryKey.length).toBeGreaterThan(20);

    const full = await runAndWait(localId, 'full');
    expect(full).toMatchObject({ state: 'succeeded', kind: 'full' });
    expect(full.snapshotId).toMatch(/^[0-9a-f]{64}$/);
    expect(full.log).toContain('Database saved');

    writeFileSync(join(t.ctx.config.DATA_DIR, 'media', 'news.mp3'), 'new file');
    const incr = await runAndWait(localId, 'incremental');
    expect(incr.state).toBe('succeeded');
    expect(incr.filesNew).toBeGreaterThanOrEqual(1);

    const snaps = (await t.app.inject({ url: `/api/backups/targets/${localId}/snapshots`, headers: admin })).json();
    expect(snaps.map((s: { kind: string }) => s.kind)).toEqual(['incremental', 'full']);
    const target = (await t.app.inject({ url: `/api/backups/targets/${localId}`, headers: admin })).json();
    expect(target.lastSuccess.id).toBe(incr.id);
    expect(target.nextFull).toBeTruthy();
  });

  it.runIf(process.getuid?.() === 0)('gives the service group read access to a local repository', async () => {
    // As root (like the worker on a server) with a data folder owned by another group, as the service account.
    chownSync(t.ctx.config.DATA_DIR, 0, 4321);
    expect((await runAndWait(localId, 'incremental')).state).toBe('succeeded');
    for (const p of [repoDir, join(repoDir, 'config'), join(repoDir, 'keys'), join(repoDir, 'keys', readdirSync(join(repoDir, 'keys'))[0]!)]) {
      const st = statSync(p);
      expect(st.gid).toBe(4321);
      expect(st.mode & 0o040).toBe(0o040);
    }
    chownSync(t.ctx.config.DATA_DIR, 0, 0);
  });

  it('restores files, configuration and the database', async () => {
    writeFileSync(join(t.ctx.config.DATA_DIR, 'media', 'jingle.mp3'), 'broken');
    writeFileSync(join(configDir, 'hosted-radio.env'), 'EXAMPLE=changed\n');
    // A customer created after the backup disappears again when the database is restored.
    await t.app.inject({ method: 'POST', url: '/api/tenants', headers: admin, payload: { name: 'After backup', slug: 'after-backup' } });
    const snaps = (await t.app.inject({ url: `/api/backups/targets/${localId}/snapshots`, headers: admin })).json();
    const res = await t.app.inject({
      method: 'POST',
      url: `/api/backups/targets/${localId}/restore`,
      headers: admin,
      payload: { snapshotId: snaps[0].id, parts: { database: true, files: true, config: true }, confirm: 'RESTORE' },
    });
    expect(res.statusCode).toBe(202);
    await processQueue(t.ctx);
    expect(readFileSync(join(t.ctx.config.DATA_DIR, 'media', 'jingle.mp3'), 'utf8')).toBe('first version');
    expect(readFileSync(join(configDir, 'hosted-radio.env'), 'utf8')).toBe('EXAMPLE=1\n');
    expect(existsSync(join(t.ctx.config.DATA_DIR, 'restore-staging'))).toBe(false);
    // Sessions are part of the database, so sign in again.
    admin = await login(t.app, 'admin@example.com', 'admin-password');
    const tenants = (await t.app.inject({ url: '/api/tenants', headers: admin })).json();
    expect(tenants.map((x: { slug: string }) => x.slug)).not.toContain('after-backup');
    const run = (await t.app.inject({ url: `/api/backups/runs/${res.json().id}`, headers: admin })).json();
    expect(run).toMatchObject({ state: 'succeeded', kind: 'restore' });
    // The backup that was running while its own database dump was made is not left "running".
    const runs = (await t.app.inject({ url: '/api/backups/runs', headers: admin })).json();
    expect(runs.some((r: { state: string }) => r.state === 'running')).toBe(false);
  });

  it('connects to existing backups with the recovery key', async () => {
    const probe = await t.app.inject({ method: 'POST', url: '/api/backups/test', headers: admin, payload: { type: 'local', config: { path: repoDir } } });
    expect(probe.json().repository).toBe('existing');
    const wrong = await t.app.inject({ method: 'POST', url: '/api/backups/test', headers: admin, payload: { type: 'local', config: { path: repoDir }, repoPassword: 'nope' } });
    expect(wrong.json().repository).toBe('wrong_password');
    const right = await t.app.inject({ method: 'POST', url: '/api/backups/test', headers: admin, payload: { type: 'local', config: { path: repoDir }, repoPassword: recoveryKey } });
    expect(right.json().repository).toBe('ready');
    const key = await t.app.inject({ url: `/api/backups/targets/${localId}/recovery-key`, headers: admin });
    expect(key.json().recoveryKey).toBe(recoveryKey);
  });

  it('backs up over SFTP, FTP and FTPS', async () => {
    const kinds = hasFtpServer ? (['sftp', 'ftp', 'ftps'] as const) : (['sftp'] as const);
    for (const kind of kinds) {
      const dir = join(mkdtempSync(join(tmpdir(), `hrs-${kind}-`)), 'root');
      mkdirSync(dir);
      const { port, child } = await serve(kind, dir);
      children.push(child);
      const config = {
        host: '127.0.0.1',
        port,
        username: 'backup',
        password: 'p@ss word',
        path: 'radio/backups',
        ...(kind === 'ftps' ? { tlsMode: 'explicit', skipCertCheck: true } : {}),
      };
      const test = await t.app.inject({ method: 'POST', url: '/api/backups/test', headers: admin, payload: { type: kind, config } });
      expect(test.json(), `${kind} test`).toMatchObject({ ok: true, repository: 'empty' });
      const created = await t.app.inject({ method: 'POST', url: '/api/backups/targets', headers: admin, payload: { name: kind.toUpperCase(), type: kind, config } });
      expect(created.json().config.password).toBe('••••••••');
      const run = await runAndWait(created.json().id, 'full');
      expect(run.state, `${kind} backup`).toBe('succeeded');
      expect(existsSync(join(dir, 'radio', 'backups', 'config'))).toBe(true);
      const wrong = await t.app.inject({ method: 'POST', url: '/api/backups/test', headers: admin, payload: { type: kind, config: { ...config, password: 'wrong' } } });
      expect(wrong.statusCode, `${kind} wrong password`).toBe(400);
    }
  }, 120_000);

  it('queues scheduled backups once per moment', async () => {
    const { schema } = await import('../src/db/index.js');
    const { eq } = await import('drizzle-orm');
    const longAgo = new Date(Date.now() - 30 * 86400_000);
    await t.ctx.db.update(schema.backupTargets).set({ updatedAt: longAgo, lastFullSlotAt: null, lastIncrementalSlotAt: null }).where(eq(schema.backupTargets.id, localId));
    const before = (await t.app.inject({ url: `/api/backups/runs?targetId=${localId}`, headers: admin })).json().length;
    expect(await tickScheduler(t.ctx)).toBeGreaterThanOrEqual(1);
    await tickScheduler(t.ctx);
    const runs = (await t.app.inject({ url: `/api/backups/runs?targetId=${localId}`, headers: admin })).json();
    expect(runs.length).toBe(before + 1);
    expect(runs[0]).toMatchObject({ trigger: 'schedule', state: 'queued' });
    const cancel = await t.app.inject({ method: 'POST', url: `/api/backups/runs/${runs[0].id}/cancel`, headers: admin });
    expect(cancel.statusCode).toBe(200);
  });

  it('keeps secrets out of the database in plain text', async () => {
    const { schema } = await import('../src/db/index.js');
    const rows = await t.ctx.db.select().from(schema.backupTargets);
    expect(JSON.stringify(rows)).not.toContain('p@ss word');
    expect(JSON.stringify(rows)).not.toContain(recoveryKey);
  });
});
