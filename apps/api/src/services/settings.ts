import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '../db/index.js';
import type { AppContext } from '../lib/context.js';

/** Masked value returned by the API instead of a stored secret. */
export const SECRET_MASK = '••••••••';

export const smtpSchema = z.object({
  enabled: z.boolean().default(false),
  host: z.string().default(''),
  port: z.number().int().min(1).max(65535).default(587),
  /** starttls = upgrade on 587, tls = implicit TLS on 465, none = plain (local relays only). */
  security: z.enum(['starttls', 'tls', 'none']).default('starttls'),
  username: z.string().default(''),
  password: z.string().default(''),
  fromName: z.string().default('Hosted Radio Station'),
  fromAddress: z.string().default(''),
  replyTo: z.string().default(''),
  /** Reject servers with invalid certificates. Only switch off for testing. */
  verifyCertificate: z.boolean().default(true),
  dkim: z
    .object({
      enabled: z.boolean().default(false),
      domain: z.string().default(''),
      selector: z.string().default(''),
      privateKey: z.string().default(''),
    })
    .default({ enabled: false, domain: '', selector: '', privateKey: '' }),
});
export type SmtpSettings = z.infer<typeof smtpSchema>;

const domainRe = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const ipOrCidrRe = /^(\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?|[0-9a-f:]+(\/\d{1,3})?)$/i;

export const proxySchema = z.object({
  /** builtin = Caddy terminates HTTPS itself; external = an upstream reverse proxy terminates HTTPS. */
  mode: z.enum(['builtin', 'external']).default('builtin'),
  /** Public host name. Empty in builtin mode = plain HTTP on every address (no certificate). */
  domain: z.string().trim().toLowerCase().refine((v) => v === '' || domainRe.test(v), 'Invalid domain name').default(''),
  acmeEmail: z.string().trim().refine((v) => v === '' || z.email().safeParse(v).success, 'Invalid e-mail address').default(''),
  /** IPs/CIDRs of the external proxy, trusted for X-Forwarded-For (real listener IPs and GeoIP). */
  trustedProxies: z.array(z.string().trim().regex(ipOrCidrRe, 'Invalid IP address or CIDR range')).max(32).default([]),
  /** Port Caddy listens on in external mode (plain HTTP inside the LAN). */
  httpPort: z.number().int().min(1).max(65535).default(80),
});
export type ProxySettings = z.infer<typeof proxySchema>;

export const updateSchema = z.object({
  /** Git branch that is followed: main = production, test = test. */
  channel: z.enum(['main', 'test']).default('main'),
  autoCheck: z.boolean().default(true),
});
export type UpdateSettings = z.infer<typeof updateSchema>;

export const backupSettingsSchema = z.object({
  /** E-mail after backups: never, only when one fails, or always. Restores always notify. */
  notifyOn: z.enum(['never', 'failure', 'always']).default('failure'),
  notifyEmails: z.array(z.email().trim().toLowerCase()).max(10).default([]),
  notifyLanguage: z.enum(['en', 'nl']).default('en'),
  /** Application (client) ID of your own Microsoft Entra app, for signing in to OneDrive from the panel. */
  onedriveClientId: z
    .string()
    .trim()
    .refine((v) => v === '' || /^[0-9a-f-]{36}$/i.test(v), 'Use the application (client) ID, a GUID')
    .default(''),
});
export type BackupSettings = z.infer<typeof backupSettingsSchema>;

export const auditSettingsSchema = z.object({
  /** Entries older than this are deleted every night. 0 = keep forever. */
  retentionDays: z.number().int().min(0).max(3650).default(365),
});

const portSchema = z.number().int().min(1024).max(65535);

/** Encoder ingest, port ranges and file upload (SFTP/FTP). */
export const streamingSchema = z
  .object({
    /** Encoders deliver with TLS here (Icecast protocol), e.g. src.example.com:8443. */
    ingestTlsPort: portSchema.default(8443),
    /** Encoders without TLS (Icecast protocol). 0 = off. */
    ingestPlainPort: z.union([z.literal(0), portSchema]).default(8010),
    /** Internal Icecast servers, one port per station, bound to 127.0.0.1. */
    icecastPortFrom: portSchema.default(18000),
    icecastPortTo: portSchema.default(18999),
    /** Public ports for legacy Shoutcast v1 encoders: each station that uses it gets port and port + 1. */
    legacyPortFrom: portSchema.default(8100),
    legacyPortTo: portSchema.default(8199),
    /** Host name customers point their CNAME records at. Empty = the domain under Web server. */
    cnameTarget: z.string().trim().toLowerCase().refine((v) => v === '' || domainRe.test(v), 'Invalid domain name').default(''),
    /** Public IP addresses of this server, accepted as A/AAAA records instead of a CNAME. */
    publicIps: z.array(z.string().trim().regex(ipOrCidrRe, 'Invalid IP address')).max(16).default([]),
    sftp: z
      .object({ enabled: z.boolean().default(true), port: portSchema.default(2022) })
      .default({ enabled: true, port: 2022 }),
    ftp: z
      .object({
        enabled: z.boolean().default(true),
        port: z.number().int().min(1).max(65535).default(21),
        /** Only allow FTP with TLS (explicit FTPS). */
        requireTls: z.boolean().default(false),
        passivePortFrom: portSchema.default(50000),
        passivePortTo: portSchema.default(50100),
        /** Public IP sent to FTP clients in passive mode, needed behind NAT. Empty = automatic. */
        passiveIp: z.string().trim().refine((v) => v === '' || ipOrCidrRe.test(v), 'Invalid IP address').default(''),
      })
      .default({ enabled: true, port: 21, requireTls: false, passivePortFrom: 50000, passivePortTo: 50100, passiveIp: '' }),
  })
  .refine((v) => v.icecastPortFrom < v.icecastPortTo && v.legacyPortFrom < v.legacyPortTo, 'A port range must start below its end')
  .refine((v) => v.ftp.passivePortFrom < v.ftp.passivePortTo, 'The passive port range must start below its end');
export type StreamingSettings = z.infer<typeof streamingSchema>;

/** Listener statistics: privacy, how long data is kept, and where GeoIP data comes from. */
export const statisticsSchema = z.object({
  /** Keep only the first part of listener addresses (IPv4 /24, IPv6 /48). Location is looked up before shortening. */
  anonymizeIps: z.boolean().default(true),
  /** Connections shorter than this are left out of reports (players that probe a stream, bots). */
  minSessionSeconds: z.number().int().min(0).max(600).default(5),
  /** Leave out search engines, monitoring and other bots. */
  excludeBots: z.boolean().default(true),
  /** Listener sessions (with location and player) are deleted after this many days. 0 = keep forever. */
  sessionRetentionDays: z.number().int().min(0).max(3650).default(400),
  /** Minute-by-minute listener counts; after this only hourly figures remain. */
  sampleRetentionDays: z.number().int().min(7).max(730).default(90),
  /** Hourly listener counts. 0 = keep forever. */
  hourlyRetentionDays: z.number().int().min(0).max(3650).default(0),
  geoip: z
    .object({
      /** dbip = free DB-IP Lite (no account needed), maxmind = MaxMind GeoLite2 with your own license key. */
      provider: z.enum(['dbip', 'maxmind']).default('dbip'),
      maxmindAccountId: z.string().trim().max(20).default(''),
      maxmindLicenseKey: z.string().trim().max(100).default(''),
      /** Download a new database every month (DB-IP) or week (MaxMind). */
      autoUpdate: z.boolean().default(true),
    })
    .default({ provider: 'dbip', maxmindAccountId: '', maxmindLicenseKey: '', autoUpdate: true }),
});
export type StatisticsSettings = z.infer<typeof statisticsSchema>;

const registry = {
  smtp: { schema: smtpSchema, secrets: ['password', 'dkim.privateKey'] },
  proxy: { schema: proxySchema, secrets: [] },
  update: { schema: updateSchema, secrets: [] },
  backup: { schema: backupSettingsSchema, secrets: [] },
  audit: { schema: auditSettingsSchema, secrets: [] },
  streaming: { schema: streamingSchema, secrets: [] },
  statistics: { schema: statisticsSchema, secrets: ['geoip.maxmindLicenseKey'] },
} as const;
type Registry = typeof registry;
export type SettingKey = keyof Registry;
type Value<K extends SettingKey> = z.infer<Registry[K]['schema']>;

function mapPath(obj: Record<string, unknown>, path: string, fn: (v: string) => string) {
  const parts = path.split('.');
  let cur: Record<string, unknown> | undefined = obj;
  for (const p of parts.slice(0, -1)) cur = cur?.[p] as Record<string, unknown> | undefined;
  const last = parts.at(-1)!;
  if (cur && typeof cur[last] === 'string' && cur[last] !== '') cur[last] = fn(cur[last] as string);
}

/** Returns the decrypted setting, with defaults filled in. */
export async function getSetting<K extends SettingKey>(ctx: AppContext, key: K): Promise<Value<K>> {
  const [row] = await ctx.db.select().from(schema.settings).where(eq(schema.settings.key, key));
  const value = structuredClone((row?.value ?? {}) as Record<string, unknown>);
  for (const path of registry[key].secrets) mapPath(value, path, (v) => ctx.box.decrypt(v));
  return registry[key].schema.parse(value) as Value<K>;
}

/** Same as getSetting, with secrets replaced by a mask, for API responses. */
export async function getMaskedSetting<K extends SettingKey>(ctx: AppContext, key: K): Promise<Value<K>> {
  const value = (await getSetting(ctx, key)) as Record<string, unknown>;
  for (const path of registry[key].secrets) mapPath(value, path, () => SECRET_MASK);
  return value as Value<K>;
}

/** Stores a setting. Secret fields equal to the mask keep their current value. */
export async function putSetting<K extends SettingKey>(ctx: AppContext, key: K, input: Value<K>): Promise<void> {
  const current = (await getSetting(ctx, key)) as Record<string, unknown>;
  const next = structuredClone(registry[key].schema.parse(input)) as Record<string, unknown>;
  for (const path of registry[key].secrets) {
    let keep: string | undefined;
    mapPath(current, path, (v) => (keep = v));
    mapPath(next, path, (v) => (v === SECRET_MASK ? (keep ?? '') : v));
    mapPath(next, path, (v) => ctx.box.encrypt(v));
  }
  await ctx.db
    .insert(schema.settings)
    .values({ key, value: next })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: next, updatedAt: new Date() } });
}
