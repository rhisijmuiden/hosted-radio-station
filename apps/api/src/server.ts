import { buildApp } from './app.js';
import { createDb, runMigrations } from './db/index.js';
import { loadConfig } from './lib/config.js';
import { createContext } from './lib/context.js';
import { startBackgroundTasks } from './services/tasks.js';

const config = loadConfig();
const { db, client } = createDb(config.DATABASE_URL);
await runMigrations(db);

const ctx = createContext(config, db);
const app = await buildApp(ctx);
const stopTasks = startBackgroundTasks(ctx, app.log);

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  stopTasks();
  await app.close();
  await client.end({ timeout: 5 });
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: config.HOST, port: config.PORT });
