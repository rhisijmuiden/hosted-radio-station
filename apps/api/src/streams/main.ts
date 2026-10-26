import pino from 'pino';
import { createDb } from '../db/index.js';
import { loadConfig } from '../lib/config.js';
import { createContext } from '../lib/context.js';
import { STREAMS_CHANNEL } from '../services/streaming/state.js';
import { StreamsWorker } from './worker.js';

/** Entry point of hosted-radio-streams.service. */
async function main() {
  const config = loadConfig();
  const log = pino({ level: config.LOG_LEVEL, base: { svc: 'streams' } });
  const { db, client } = createDb(config.DATABASE_URL);
  const ctx = createContext(config, db);
  const worker = new StreamsWorker(ctx, log);
  await worker.start();
  await client.listen(STREAMS_CHANNEL, () => void worker.reload());
  log.info('streams service started');
  const shutdown = async (signal: string) => {
    log.info({ signal }, 'shutting down');
    await worker.stop();
    await client.end({ timeout: 5 });
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

await main();
