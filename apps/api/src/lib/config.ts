import { readFileSync } from 'node:fs';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().default(8000),
  DATABASE_URL: z.string().default('postgres://hosted_radio@localhost/hosted_radio'),
  /** Valkey/Redis, used for rate limiting across processes. Empty = in-memory. */
  REDIS_URL: z.string().default(''),
  /** 32+ random bytes (hex/base64), used to encrypt secrets stored in the database. */
  APP_SECRET: z.string().min(32),
  /** Public base URL, e.g. https://radio.example.com. Used for SSO redirects and e-mail links. */
  PUBLIC_URL: z.string().url().default('http://localhost:8000'),
  /** Root of the git checkout, used by the update service. */
  INSTALL_DIR: z.string().default(process.cwd()),
  /** Writable data directory (media, backups staging, job state). */
  DATA_DIR: z.string().default('/var/lib/hosted-radio'),
  /** Directory with the built admin panel, served by the API in production. */
  WEB_DIST: z.string().optional(),
  /** Comma-separated IPs/CIDRs whose X-Forwarded-For header is trusted (the local Caddy by default). */
  TRUSTED_PROXIES: z.string().default('127.0.0.1,::1'),
  /** Set to "1" when the privileged helper units (update, restore, proxy) are installed. */
  SYSTEM_HELPERS: z.enum(['0', '1']).default('0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type Config = z.infer<typeof schema>;

/** Reads the environment, falling back to the env file written by install.sh. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const merged = { ...readEnvFile(env.HRS_ENV_FILE ?? '/etc/hosted-radio/hosted-radio.env'), ...env };
  return schema.parse(merged);
}

function readEnvFile(path: string): Record<string, string> {
  try {
    const out: Record<string, string> = {};
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) out[m[1]!] = m[2]!.replace(/^"(.*)"$/, '$1');
    }
    return out;
  } catch {
    return {};
  }
}
