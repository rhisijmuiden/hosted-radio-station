import { createCipheriv, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { schema } from '../../db/index.js';
import type { AppContext } from '../../lib/context.js';
import { randomToken } from '../../lib/crypto.js';
import { SECRET_MASK } from '../settings.js';

type TargetRow = typeof schema.backupTargets.$inferSelect;

const host = z.string().trim().min(1).max(253).regex(/^[A-Za-z0-9.:[\]-]+$/, 'Invalid host name');
/** Folder on the remote side. Relative paths start in the login folder. */
const remotePath = z
  .string()
  .trim()
  .max(500)
  .regex(/^[^\n\r"'`$\\]*$/, 'Invalid folder')
  .default('hosted-radio-backup');

export const ftpConfig = z.object({
  host,
  port: z.number().int().min(1).max(65535).default(21),
  username: z.string().trim().min(1).max(200),
  password: z.string().max(500).default(''),
  path: remotePath,
});
export const ftpsConfig = ftpConfig.extend({
  /** explicit = FTPES (AUTH TLS on port 21), implicit = TLS from the first byte (port 990). */
  tlsMode: z.enum(['explicit', 'implicit']).default('explicit'),
  skipCertCheck: z.boolean().default(false),
});
export const sftpConfig = z.object({
  host,
  port: z.number().int().min(1).max(65535).default(22),
  username: z.string().trim().min(1).max(200),
  password: z.string().max(500).default(''),
  /** OpenSSH or PEM private key; used instead of (or with) the password. */
  privateKey: z.string().max(20_000).default(''),
  keyPassphrase: z.string().max(500).default(''),
  /** Optional known_hosts line ("host ssh-ed25519 AAAA...") so the server identity is checked. */
  hostKey: z.string().trim().max(5000).default(''),
  path: remotePath,
});
export const onedriveConfig = z.object({
  path: remotePath,
  /** OAuth token as JSON (rclone format: access_token, refresh_token, expiry). */
  token: z.string().max(20_000).default(''),
  /** device = signed in through this panel with your own Microsoft app; rclone = pasted from `rclone authorize`. */
  tokenSource: z.enum(['device', 'rclone']).default('rclone'),
  clientId: z.string().trim().max(100).default(''),
  driveId: z.string().trim().max(300).default(''),
  driveType: z.enum(['personal', 'business', 'documentLibrary', '']).default(''),
  account: z.string().trim().max(300).default(''),
});
export const localConfig = z.object({
  /** Absolute path, e.g. a mounted NAS share. */
  path: z.string().trim().min(2).max(500).regex(/^\/[^\n\r"'`$\\]*$/, 'Use an absolute path, e.g. /mnt/backup'),
});

export const TARGET_TYPES = ['ftp', 'ftps', 'sftp', 'onedrive', 'local'] as const;
export type TargetType = (typeof TARGET_TYPES)[number];

const configSchemas = { ftp: ftpConfig, ftps: ftpsConfig, sftp: sftpConfig, onedrive: onedriveConfig, local: localConfig } as const;
const secretFields: Record<TargetType, string[]> = {
  ftp: ['password'],
  ftps: ['password'],
  sftp: ['password', 'privateKey', 'keyPassphrase'],
  onedrive: ['token'],
  local: [],
};

export type AnyTargetConfig = z.infer<(typeof configSchemas)[TargetType]>;

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM');
export const scheduleSchema = z.object({
  incremental: z
    .object({ enabled: z.boolean().default(true), everyHours: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(6), z.literal(8), z.literal(12), z.literal(24)]).default(24), at: hhmm.default('02:00') })
    .default({ enabled: true, everyHours: 24, at: '02:00' }),
  full: z
    .object({ enabled: z.boolean().default(true), /** 0 = Sunday … 6 = Saturday, -1 = every day */ weekday: z.number().int().min(-1).max(6).default(0), at: hhmm.default('03:00') })
    .default({ enabled: true, weekday: 0, at: '03:00' }),
});
export const retentionSchema = z.object({
  keepLast: z.number().int().min(0).max(1000).default(7),
  keepDaily: z.number().int().min(0).max(1000).default(14),
  keepWeekly: z.number().int().min(0).max(1000).default(8),
  keepMonthly: z.number().int().min(0).max(1000).default(12),
});

export function parseConfig(type: TargetType, config: unknown) {
  return configSchemas[type].parse(config) as AnyTargetConfig;
}

/** Validates the config for its type; returns zod issues as one readable message. */
export function validateConfig(type: TargetType, config: unknown) {
  const res = configSchemas[type].safeParse(config);
  if (!res.success) {
    const issue = res.error.issues[0]!;
    throw Object.assign(new Error(`${issue.path.join('.') || 'config'}: ${issue.message}`), { statusCode: 400 });
  }
  return res.data as AnyTargetConfig;
}

export function decryptConfig(ctx: AppContext, row: Pick<TargetRow, 'type' | 'config'>): AnyTargetConfig {
  const cfg = { ...(row.config as Record<string, unknown>) };
  for (const f of secretFields[row.type]) if (typeof cfg[f] === 'string' && cfg[f]) cfg[f] = ctx.box.decrypt(cfg[f] as string);
  return parseConfig(row.type, cfg);
}

export function maskConfig(type: TargetType, cfg: AnyTargetConfig) {
  const out = { ...(cfg as Record<string, unknown>) };
  for (const f of secretFields[type]) if (out[f]) out[f] = SECRET_MASK;
  return out;
}

/** Encrypts secrets; a masked secret keeps the current value. */
export function encryptConfig(ctx: AppContext, type: TargetType, next: AnyTargetConfig, current: AnyTargetConfig | null) {
  const out = { ...(next as Record<string, unknown>) };
  for (const f of secretFields[type]) {
    let v = out[f] as string;
    if (v === SECRET_MASK) v = ((current as Record<string, unknown> | null)?.[f] as string) ?? '';
    out[f] = v ? ctx.box.encrypt(v) : '';
  }
  return out;
}

/** Fills masked secrets of an unsaved config from the stored one (for "test connection" before saving). */
export function unmask(type: TargetType, next: AnyTargetConfig, current: AnyTargetConfig | null) {
  const out = { ...(next as Record<string, unknown>) };
  for (const f of secretFields[type]) if (out[f] === SECRET_MASK) out[f] = (current as Record<string, unknown> | null)?.[f] ?? '';
  return out as AnyTargetConfig;
}

export const generateRepoPassword = () => randomToken(30);

// rclone

/** rclone stores passwords "obscured": AES-256-CTR with a fixed, public key. Same algorithm as `rclone obscure`. */
const RCLONE_KEY = Buffer.from([
  0x9c, 0x93, 0x5b, 0x48, 0x73, 0x0a, 0x55, 0x4d, 0x6b, 0xfd, 0x7c, 0x63, 0xc8, 0x86, 0xa9, 0x2b, 0xd3, 0x90, 0x19, 0x8e, 0xb8, 0x12, 0x8a,
  0xfb, 0xf4, 0xde, 0x16, 0x2b, 0x8b, 0x95, 0xf6, 0x38,
]);
export function rcloneObscure(plain: string) {
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-ctr', RCLONE_KEY, iv);
  return Buffer.concat([iv, cipher.update(plain, 'utf8'), cipher.final()]).toString('base64url');
}

export const RCLONE_REMOTE = 'hrs';

/** rclone.conf contents for a target, plus the restic repository string. */
export function rcloneSetup(type: TargetType, cfg: AnyTargetConfig, knownHostsFile: string) {
  const lines: string[] = [`[${RCLONE_REMOTE}]`];
  const set = (k: string, v: string | number | boolean) => lines.push(`${k} = ${String(v).replace(/[\r\n]/g, '')}`);
  if (type === 'local') return { conf: '', repo: (cfg as z.infer<typeof localConfig>).path, knownHosts: null };
  let knownHosts: string | null = null;
  if (type === 'ftp' || type === 'ftps') {
    const c = cfg as z.infer<typeof ftpsConfig>;
    set('type', 'ftp');
    set('host', c.host);
    set('port', c.port);
    set('user', c.username);
    if (c.password) set('pass', rcloneObscure(c.password));
    // Many FTP servers limit connections per user; restic uploads in parallel.
    set('concurrency', 4);
    // restic only needs names and sizes. LIST works on every server, while some answer MLST for a folder that does
    // not exist yet with a code rclone does not expect.
    set('disable_mlsd', true);
    if (type === 'ftps') {
      set(c.tlsMode === 'implicit' ? 'tls' : 'explicit_tls', true);
      if (c.skipCertCheck) set('no_check_certificate', true);
    }
  } else if (type === 'sftp') {
    const c = cfg as z.infer<typeof sftpConfig>;
    set('type', 'sftp');
    set('host', c.host);
    set('port', c.port);
    set('user', c.username);
    if (c.password) set('pass', rcloneObscure(c.password));
    if (c.privateKey) set('key_pem', c.privateKey.trim().replace(/\r?\n/g, '\\n'));
    if (c.keyPassphrase) set('key_file_pass', rcloneObscure(c.keyPassphrase));
    if (c.hostKey) {
      knownHosts = `${c.hostKey}\n`;
      set('known_hosts_file', knownHostsFile);
    }
    // Storage boxes often have no shell; restic does not need remote checksums.
    set('shell_type', 'none');
    set('disable_hashcheck', true);
  } else {
    const c = cfg as z.infer<typeof onedriveConfig>;
    set('type', 'onedrive');
    if (c.clientId && c.tokenSource === 'device') set('client_id', c.clientId);
    set('token', c.token);
    set('drive_id', c.driveId);
    set('drive_type', c.driveType || 'personal');
  }
  const path = (cfg as { path: string }).path.replace(/^\/+(?=.)/, type === 'onedrive' ? '' : '/');
  return { conf: `${lines.join('\n')}\n`, repo: `rclone:${RCLONE_REMOTE}:${path}`, knownHosts };
}

/** Reads the (possibly refreshed) OAuth token back from an rclone.conf that rclone may have rewritten. */
export function tokenFromConf(conf: string) {
  const m = conf.match(/^token\s*=\s*(\{.*\})\s*$/m);
  return m ? m[1]! : null;
}

export function describeTarget(type: TargetType, cfg: AnyTargetConfig) {
  const c = cfg as Record<string, unknown>;
  if (type === 'local') return String(c.path);
  if (type === 'onedrive') return `OneDrive${c.account ? ` (${c.account})` : ''}: ${c.path}`;
  return `${type}://${c.username}@${c.host}:${c.port}/${String(c.path).replace(/^\//, '')}`;
}
