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
