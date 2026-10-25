import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import * as schema from './schema.js';

export type Db = ReturnType<typeof createDb>['db'];

export function createDb(url: string) {
  const client = postgres(url, { max: 10, onnotice: () => {} });
  return { db: drizzle(client, { schema }), client };
}

export async function runMigrations(db: Db) {
  const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));
  await migrate(db, { migrationsFolder });
}

export { schema };
