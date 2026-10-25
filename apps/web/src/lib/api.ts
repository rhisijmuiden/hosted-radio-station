export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly field?: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method: init.method ?? 'GET',
      credentials: 'same-origin',
      headers: init.body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'network', 'The server cannot be reached');
  }
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const err = data?.error;
    throw new ApiError(res.status, err?.code ?? 'error', err?.message ?? res.statusText, err?.field);
  }
  return data as T;
}

export type Role = 'owner' | 'manager' | 'dj';
export type Plan = 'distribution' | 'station';

export interface User {
  id: string;
  email: string;
  name: string;
  isSuperadmin: boolean;
  locale: string;
  active: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}
export interface UserDetail extends User {
  memberships: { tenantId: string; tenantName: string; role: Role }[];
}
export interface Me {
  user: User;
  via: 'session' | 'api_key';
  memberships: { tenantId: string; tenantName: string; tenantSlug: string; plan: Plan; role: Role }[];
}
export interface TenantLimits {
  maxStations: number;
  maxListeners: number;
  maxBitrateKbps: number;
  storageQuotaMb: number;
}
export interface Tenant {
  id: string;
  name: string;
  slug: string;
  plan: Plan;
  limits: TenantLimits;
  active: boolean;
  externalRef: string | null;
  createdAt: string;
  memberCount: number;
}
export interface Member {
  user: User;
  role: Role;
  createdAt: string;
}
export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  tenantId: string | null;
  tenantName: string | null;
  readOnly: boolean;
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}
export interface SmtpSettings {
  enabled: boolean;
  host: string;
  port: number;
  security: 'starttls' | 'tls' | 'none';
  username: string;
  password: string;
  fromName: string;
  fromAddress: string;
  replyTo: string;
  verifyCertificate: boolean;
  dkim: { enabled: boolean; domain: string; selector: string; privateKey: string };
}
export interface ProxySettings {
  mode: 'builtin' | 'external';
  domain: string;
  acmeEmail: string;
  trustedProxies: string[];
  httpPort: number;
}
export type Channel = 'main' | 'test';
export interface UpdateCheck {
  channel: Channel;
  currentCommit: string | null;
  latestCommit: string | null;
  updateAvailable: boolean;
  checkedAt: string;
  error: string | null;
}
export interface SystemInfo {
  name: string;
  version: string;
  commit: string | null;
  commitDate: string | null;
  branch: string | null;
  channel: Channel;
  node: string;
  helpers: boolean;
  addresses: string[];
  lastCheck: UpdateCheck | null;
}
export interface JobStatus {
  id: string | null;
  state: 'idle' | 'queued' | 'running' | 'succeeded' | 'failed';
  channel?: string;
  fromCommit?: string;
  toCommit?: string;
  message?: string;
  startedAt?: string;
  finishedAt?: string;
  log: string;
}

export interface AuthOptions {
  passwordReset: boolean;
  sso: boolean;
}

export interface AuditEntry {
  id: number;
  at: string;
  actorUserId: string | null;
  actorEmail: string | null;
  actorName: string | null;
  via: string;
  tenantId: string | null;
  tenantName: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  success: boolean;
  ip: string | null;
  userAgent: string | null;
  details: Record<string, unknown> | null;
}
export interface AuditPage {
  items: AuditEntry[];
  nextBefore: number | null;
}

export interface SsoProvider {
  type: 'oidc' | 'saml';
  enabled: boolean;
  displayName: string;
  emailDomains: string[];
  allowPasswordLogin: boolean;
  autoCreateUsers: boolean;
  defaultRole: 'manager' | 'dj';
  oidc?: { issuer: string; clientId: string; clientSecret: string; scopes: string };
  saml?: { entryPoint: string; idpCert: string; idpIssuer: string; emailAttribute: string; nameAttribute: string };
  updatedAt?: string;
}
export interface SsoConfig {
  provider: SsoProvider | null;
  endpoints: { oidcRedirectUri: string; samlEntityId: string; samlAcsUrl: string; samlMetadataUrl: string; loginUrl: string };
}

export type BackupTargetType = 'ftp' | 'ftps' | 'sftp' | 'onedrive' | 'local';
export interface BackupSchedule {
  incremental: { enabled: boolean; everyHours: number; at: string };
  full: { enabled: boolean; weekday: number; at: string };
}
export interface BackupRetention {
  keepLast: number;
  keepDaily: number;
  keepWeekly: number;
  keepMonthly: number;
}
export interface BackupRun {
  id: string;
  targetId: string | null;
  targetName: string;
  kind: 'full' | 'incremental' | 'restore';
  state: 'queued' | 'running' | 'succeeded' | 'failed';
  trigger: string;
  requestedBy: string | null;
  snapshotId: string | null;
  filesNew: number | null;
  filesChanged: number | null;
  bytesAdded: number | null;
  bytesTotal: number | null;
  message: string | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}
export interface BackupRunDetail extends BackupRun {
  log: string;
  params: Record<string, unknown> | null;
}
export interface BackupTarget {
  id: string;
  name: string;
  type: BackupTargetType;
  description: string;
  enabled: boolean;
  config: Record<string, unknown>;
  schedule: BackupSchedule;
  retention: BackupRetention;
  createdAt: string;
  lastRun: BackupRun | null;
  lastSuccess: BackupRun | null;
  nextFull: string | null;
  nextIncremental: string | null;
}
export interface Snapshot {
  id: string;
  shortId: string;
  time: string;
  hostname: string;
  tags: string[];
  paths: string[];
  kind: 'full' | 'incremental' | 'unknown';
  sizeBytes: number | null;
  filesNew: number | null;
}
export interface BackupSettings {
  notifyOn: 'never' | 'failure' | 'always';
  notifyEmails: string[];
  notifyLanguage: 'en' | 'nl';
  onedriveClientId: string;
}
