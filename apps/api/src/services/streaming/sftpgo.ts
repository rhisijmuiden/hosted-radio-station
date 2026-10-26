import { join } from 'node:path';
import { and, eq, inArray } from 'drizzle-orm';
import { schema } from '../../db/index.js';
import { verifyPassword } from '../../lib/auth.js';
import type { AppContext } from '../../lib/context.js';
import type { StreamingSettings } from '../settings.js';
import { mediaDir } from './icecast.js';
import { tenantStorageUsage } from './storage.js';

/**
 * SFTPGo serves SFTP/SCP and FTP/FTPS uploads. It keeps no users of its own: every log-in is checked by
 * POST /api/internal/sftpgo/auth, which maps "<station>.<account>" to the station's media folder.
 */
export async function renderSftpgoEnv(ctx: AppContext, s: StreamingSettings) {
  const api = `http://127.0.0.1:${ctx.config.PORT}/api/internal/sftpgo`;
  const certs = join(ctx.config.DATA_DIR, 'certs');
  const env: Record<string, string | number> = {
    SFTPGO_CONFIG_DIR: join(ctx.config.DATA_DIR, 'sftpgo'),
    SFTPGO_LOG_FILE_PATH: '',
    SFTPGO_DATA_PROVIDER__DRIVER: 'memory',
    SFTPGO_DATA_PROVIDER__NAME: '',
    SFTPGO_DATA_PROVIDER__CREATE_DEFAULT_ADMIN: 'false',
    SFTPGO_DATA_PROVIDER__EXTERNAL_AUTH_HOOK: `${api}/auth`,
    SFTPGO_DATA_PROVIDER__EXTERNAL_AUTH_SCOPE: 1,
    SFTPGO_DATA_PROVIDER__TRACK_QUOTA: 2,
    SFTPGO_COMMON__ACTIONS__EXECUTE_ON: 'upload,delete,rename',
    SFTPGO_COMMON__ACTIONS__HOOK: `${api}/event`,
    SFTPGO_COMMON__DEFENDER__ENABLED: 'true',
    SFTPGO_COMMON__DEFENDER__DRIVER: 'memory',
    SFTPGO_HTTPD__BINDINGS__0__PORT: 0,
    SFTPGO_TELEMETRY__BIND_PORT: 0,
    SFTPGO_WEBDAVD__BINDINGS__0__PORT: 0,
    SFTPGO_SFTPD__BINDINGS__0__PORT: s.sftp.enabled ? s.sftp.port : 0,
    SFTPGO_SFTPD__ENABLED_SSH_COMMANDS: 'md5sum,sha1sum,sha256sum,cd,pwd,scp',
    SFTPGO_FTPD__BINDINGS__0__PORT: s.ftp.enabled ? s.ftp.port : 0,
    // 0 = plain FTP and explicit TLS, 1 = explicit TLS required.
    SFTPGO_FTPD__BINDINGS__0__TLS_MODE: s.ftp.requireTls ? 1 : 0,
    SFTPGO_FTPD__BINDINGS__0__FORCE_PASSIVE_IP: s.ftp.passiveIp,
    SFTPGO_FTPD__BINDINGS__0__CERTIFICATE_FILE: join(certs, 'default.crt'),
    SFTPGO_FTPD__BINDINGS__0__CERTIFICATE_KEY_FILE: join(certs, 'default.key'),
    SFTPGO_FTPD__PASSIVE_PORT_RANGE__START: s.ftp.passivePortFrom,
    SFTPGO_FTPD__PASSIVE_PORT_RANGE__END: s.ftp.passivePortTo,
    SFTPGO_FTPD__BANNER: 'Hosted Radio Station',
    SFTPGO_SFTPD__BANNER: 'Hosted Radio Station',
  };
  return `# Written by Hosted Radio Station (Settings → Streaming). Changes are overwritten.\n${Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')}\n`;
}

const LOGIN_RE = /^([a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?)\.([a-z0-9_-]{1,32})$/;

/** An empty username tells SFTPGo the log-in failed. Never answer with an empty body: SFTPGo would accept it. */
export const deniedLogin = { username: '' };

/** Checks an upload log-in "<station slug>.<username>" and returns the SFTPGo user, limited to the station's media. */
export async function sftpgoLogin(ctx: AppContext, login: string, password: string, usedQuotaSize = 0) {
  const m = login.toLowerCase().match(LOGIN_RE);
  if (!m || !password) return null;
  const [row] = await ctx.db
    .select({ account: schema.stationAccounts, station: schema.stations, tenant: schema.tenants })
    .from(schema.stationAccounts)
    .innerJoin(schema.stations, eq(schema.stations.id, schema.stationAccounts.stationId))
    .innerJoin(schema.tenants, eq(schema.tenants.id, schema.stations.tenantId))
    .where(and(eq(schema.stations.slug, m[1]!), eq(schema.stationAccounts.username, m[2]!)));
  if (!row || !row.account.enabled || !row.account.canUpload || !row.station.enabled || !row.tenant.active) return null;
  if (!(await verifyPassword(row.account.passwordHash, password))) return null;
  await ctx.db.update(schema.stationAccounts).set({ lastUsedAt: new Date() }).where(eq(schema.stationAccounts.id, row.account.id));

  // The storage limit counts for the whole customer. Over the limit, files can still be listed, downloaded and deleted.
  const quotaBytes = row.tenant.limits.storageQuotaMb * 1024 * 1024;
  const used = await tenantStorageUsage(ctx, row.tenant.id);
  const remaining = Math.max(0, quotaBytes - used);
  const full = quotaBytes > 0 && remaining <= 0;
  return {
    status: 1,
    username: `${row.station.slug}.${row.account.username}`,
    home_dir: mediaDir(ctx, row.station.id),
    permissions: { '/': full ? ['list', 'download', 'delete', 'rename', 'create_dirs'] : ['*'] },
    // SFTPGo counts this user's uploads on top of what it already counted; give it what is left for the customer.
    quota_size: quotaBytes > 0 ? usedQuotaSize + Math.max(remaining, 1) : 0,
    quota_files: 0,
    description: `${row.station.name} – ${row.account.displayName || row.account.username}`,
    additional_info: JSON.stringify({ stationId: row.station.id, accountId: row.account.id }),
  };
}

/** Station ids for SFTPGo users, from the "<slug>.<user>" log-in names in its events. */
export async function stationIdsForLogins(ctx: AppContext, logins: string[]) {
  const slugs = [...new Set(logins.map((l) => l.toLowerCase().match(LOGIN_RE)?.[1]).filter((s): s is string => !!s))];
  if (!slugs.length) return [];
  const rows = await ctx.db.select({ id: schema.stations.id }).from(schema.stations).where(inArray(schema.stations.slug, slugs));
  return rows.map((r) => r.id);
}
