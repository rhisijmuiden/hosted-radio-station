import { sql } from 'drizzle-orm';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type App } from '../src/app.js';
import { createDb, runMigrations, schema } from '../src/db/index.js';
import { hashPassword } from '../src/lib/auth.js';
import { loadConfig } from '../src/lib/config.js';
import { createContext } from '../src/lib/context.js';

export const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgres://hosted_radio:dev@localhost/hosted_radio_test';

export async function setup(env: Record<string, string> = {}) {
  const config = loadConfig({
    HRS_ENV_FILE: '/nonexistent',
    NODE_ENV: 'test',
    DATABASE_URL: TEST_DB,
    APP_SECRET: 'test-secret-test-secret-test-secret-123',
    INSTALL_DIR: join(import.meta.dirname, '../../..'),
    DATA_DIR: mkdtempSync(join(tmpdir(), 'hrs-test-')),
    CADDYFILE: '/nonexistent',
    ...env,
  });
  const { db, client } = createDb(config.DATABASE_URL);
  await db.execute(sql`drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;`);
  await runMigrations(db);
  const ctx = createContext(config, db);
  const app = await buildApp(ctx);
  const [admin] = await db
    .insert(schema.users)
    .values({ email: 'admin@example.com', name: 'Admin', passwordHash: await hashPassword('admin-password'), isSuperadmin: true })
    .returning();
  return { app, ctx, db, admin: admin!, close: async () => { await app.close(); await client.end(); } };
}

/** Signs in and returns the session cookie header. */
export async function login(app: App, email: string, password: string) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
  const cookie = res.cookies.find((c) => c.name === 'hrs_session')!;
  return { cookie: `hrs_session=${cookie.value}` };
}
