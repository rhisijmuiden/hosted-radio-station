import { buildApp } from './app.js';
import { createDb, runMigrations } from './db/index.js';
import { loadConfig } from './lib/config.js';
import { createContext } from './lib/context.js';
import { NOWPLAYING_CHANNEL } from './services/public/hub.js';
import { STREAMS_CHANNEL } from './services/streaming/state.js';
import { startBackgroundTasks } from './services/tasks.js';

const config = loadConfig();
const { db, client } = createDb(config.DATABASE_URL);
await runMigrations(db);

const ctx = createContext(config, db);
const app = await buildApp(ctx);
const stopTasks = startBackgroundTasks(ctx, app.log);
// The streams service reports new titles and live DJs; the public live feeds pass them on right away.
await client.listen(NOWPLAYING_CHANNEL, (stationId) => app.nowPlaying.notify(stationId));
// Stations, mounts or domains changed: nodes get a new plan when it affects them.
await client.listen(STREAMS_CHANNEL, () => void app.nodes.refreshAll());

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
// A station node (phase 12) connects to its main server once it answers requests itself.
await app.stationNode?.start();
