import { eq } from 'drizzle-orm';
import { parseArgs } from 'node:util';
import { createDb, runMigrations, schema } from './db/index.js';
import { hashPassword } from './lib/auth.js';
import { loadConfig } from './lib/config.js';
import { createContext } from './lib/context.js';
import { getSetting, putSetting } from './services/settings.js';
import { emailSchema, passwordSchema } from './lib/schemas.js';

const usage = `Hosted Radio Station command line

Usage:
  hrs migrate                                   Apply database migrations
  hrs create-admin --email <e> --name <n> [--password <p>]
                                                Create an administrator (or promote and reset an existing user)
  hrs reset-password --email <e> [--password <p>]
                                                Set a new password and sign the user out everywhere

  hrs set-setting <key> <json>                  Store an instance setting (proxy, update, smtp), used by install.sh

Without --password a random password is generated and printed.`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { email: { type: 'string' }, name: { type: 'string' }, password: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
});

function randomPassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  return Array.from(crypto.getRandomValues(new Uint32Array(20)), (n) => chars[n % chars.length]).join('');
}

const command = positionals[0];
if (!command || values.help) {
  console.log(usage);
  process.exit(command ? 0 : 1);
}

const config = loadConfig();
const { db, client } = createDb(config.DATABASE_URL);
try {
  await runMigrations(db);
  if (command === 'migrate') {
    console.log('Database is up to date.');
  } else if (command === 'create-admin' || command === 'reset-password') {
    const email = emailSchema.parse(values.email);
    const generated = !values.password;
    const password = passwordSchema.parse(values.password ?? randomPassword());
    const passwordHash = await hashPassword(password);
    const [existing] = await db.select().from(schema.users).where(eq(schema.users.email, email));
    if (command === 'create-admin') {
      if (existing) {
        await db.update(schema.users).set({ isSuperadmin: true, active: true, passwordHash }).where(eq(schema.users.id, existing.id));
      } else {
        await db.insert(schema.users).values({ email, name: values.name ?? email.split('@')[0]!, passwordHash, isSuperadmin: true });
      }
      console.log(`Administrator ${email} is ready.`);
    } else {
      if (!existing) throw new Error(`No user with e-mail address ${email}`);
      await db.update(schema.users).set({ passwordHash }).where(eq(schema.users.id, existing.id));
      await db.delete(schema.sessions).where(eq(schema.sessions.userId, existing.id));
      console.log(`Password for ${email} has been reset.`);
    }
    if (generated) console.log(`Password: ${password}`);
  } else if (command === 'set-setting') {
    const [, key, json] = positionals;
    if (key !== 'proxy' && key !== 'update' && key !== 'smtp') throw new Error('Key must be proxy, update or smtp');
    const ctx = createContext(config, db);
    const current = await getSetting(ctx, key);
    await putSetting(ctx, key, { ...current, ...JSON.parse(json ?? '{}') } as never);
    console.log(`Setting "${key}" saved.`);
  } else {
    console.error(`Unknown command "${command}"\n\n${usage}`);
    process.exitCode = 1;
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await client.end({ timeout: 5 });
}
