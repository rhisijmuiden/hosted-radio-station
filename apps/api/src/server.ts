import { buildApp } from './app.js';
import { createDb, runMigrations } from './db/index.js';
import { loadConfig } from './lib/config.js';
import { createContext } from './lib/context.js';

const config = loadConfig();
const { db, client } = createDb(config.DATABASE_URL);
await runMigrations(db);

const app = await buildApp(createContext(config, db));

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await client.end({ timeout: 5 });
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: config.HOST, port: config.PORT });
