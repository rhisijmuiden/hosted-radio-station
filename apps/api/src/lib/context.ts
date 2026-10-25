import type { Config } from './config.js';
import type { Db } from '../db/index.js';
import { SecretBox } from './crypto.js';

export interface AppContext {
  config: Config;
  db: Db;
  box: SecretBox;
}

export function createContext(config: Config, db: Db): AppContext {
  return { config, db, box: new SecretBox(config.APP_SECRET) };
}

declare module 'fastify' {
  interface FastifyInstance {
    ctx: AppContext;
  }
}
