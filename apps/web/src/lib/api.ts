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

export const SECRET_MASK = '••••••••';

export type Edition = 'distribution' | 'station';
export type AudioFormat = 'mp3' | 'aac' | 'opus' | 'vorbis';
export type OutputType = 'local' | 'icecast' | 'shoutcast1' | 'shoutcast2';

export interface Station {
  id: string;
  tenantId: string;
  tenantName: string;
  name: string;
  slug: string;
  edition: Edition;
  description: string;
  genre: string;
  website: string;
  enabled: boolean;
  maxListeners: number;
  legacyPort: number | null;
  legacyMountId: string | null;
  storageBytes: number;
  createdAt: string;
}
export interface StationListItem extends Station {
  onAir: boolean;
  listeners: number | null;
  mountCount: number;
}
export interface Mount {
  id: string;
  path: string;
  name: string;
  kind: 'source' | 'transcode';
  sourceMountId: string | null;
  format: AudioFormat;
  bitrateKbps: number;
  isPublic: boolean;
  isDefault: boolean;
  fallbackMountId: string | null;
  maxListeners: number | null;
  sortOrder: number;
}
export interface OutputConfig {
  host?: string;
  port?: number;
  tls?: boolean;
  mount?: string;
  username?: string;
  password?: string;
  streamId?: number;
  adminPassword?: string;
  push?: boolean;
  publicUrl?: string;
}
export interface OutputStatus {
  state: 'idle' | 'connecting' | 'connected' | 'error';
  message?: string;
  listeners?: number | null;
  since?: string;
  checkedAt?: string;
}
export interface Output {
  id: string;
  type: OutputType;
  name: string;
  enabled: boolean;
  mountId: string | null;
  config: OutputConfig;
  status: OutputStatus | null;
}
export interface ConnectionInfo {
  ingestHost: string;
  tls: { port: number; available: boolean };
  plain: { port: number } | null;
  legacy: { port: number; sourcePort: number; mount: string | null } | null;
  listenBase: string;
  mounts: { id: string; path: string; encoderMount: string; listenUrl: string | null }[];
  upload: { host: string; sftpPort: number | null; ftpPort: number | null; ftpRequireTls: boolean };
}
export interface StationDetail extends Station {
  tenantPlan: Plan;
  mounts: Mount[];
  outputs: Output[];
  connection: ConnectionInfo;
  role: Role | 'superadmin';
}
export interface LiveSession {
  id: string;
  mountId: string | null;
  mountPath: string;
  accountId: string | null;
  accountName: string;
  via: string;
  ip: string | null;
  userAgent: string | null;
  bitrateKbps: number | null;
  startedAt: string;
  endedAt: string | null;
  bytesIn: number;
  endReason: string | null;
}
export interface StationStatus {
  running: boolean;
  mounts: {
    id: string | null;
    path: string;
    live: boolean;
    listeners: number;
    title: string | null;
    bitrateKbps: number | null;
    contentType: string | null;
    streamStart: string | null;
  }[];
  listeners: number;
  live: LiveSession[];
  outputs: Pick<Output, 'id' | 'name' | 'type' | 'enabled' | 'status'>[];
}
export interface StationAccount {
  id: string;
  username: string;
  displayName: string;
  userId: string | null;
  userName: string | null;
  canBroadcast: boolean;
  canUpload: boolean;
  mountIds: string[];
  enabled: boolean;
  lastUsedAt: string | null;
  createdAt: string;
  uploadLogin: string;
  /** Only when it was generated. */
  password?: string;
}

export interface DomainCheck {
  host: string;
  ok: boolean;
  found: string[];
  error?: string;
}
export interface TenantDomain {
  id: string;
  domain: string;
  panelHost: string;
  ingestHost: string;
  status: 'pending' | 'verified' | 'failed';
  verifiedManually: boolean;
  checks: DomainCheck[];
  checkedAt: string | null;
  verifiedAt: string | null;
  createdAt: string;
}
export interface TenantUsage {
  stations: { used: number; limit: number };
  listeners: { allocated: number; now: number; limit: number };
  bitrate: { limit: number };
  storage: { usedBytes: number; limitBytes: number };
}

export interface StreamingSettings {
  ingestTlsPort: number;
  ingestPlainPort: number;
  icecastPortFrom: number;
  icecastPortTo: number;
  legacyPortFrom: number;
  legacyPortTo: number;
  cnameTarget: string;
  publicIps: string[];
  sftp: { enabled: boolean; port: number };
  ftp: { enabled: boolean; port: number; requireTls: boolean; passivePortFrom: number; passivePortTo: number; passiveIp: string };
}
interface PortState {
  port: number;
  ok: boolean;
  error?: string;
}
export interface StreamsStatus {
  worker: {
    alive: boolean;
    pid: number;
    startedAt: string;
    updatedAt: string;
    ingest: { tls: PortState | null; plain: PortState | null; legacy: (PortState & { station: string })[]; certificates: string[] };
    relays: { id: string; kind: 'transcode' | 'push' | 'monitor'; station: string; name: string; state: string; message?: string; since?: string }[];
    encoders: number;
  } | null;
  apply: { id: string | null; state: string; message?: string; startedAt?: string; finishedAt?: string; log: string } | null;
}

// Statistics

export interface StatsStation {
  id: string;
  name: string;
  tenantId: string;
  tenantName: string;
  mounts: string[];
  outputs: { id: string; name: string }[];
}
export interface StatsKpis {
  listeningHours: number;
  avgListeners: number;
  peakListeners: number;
  peakAt: string | null;
  sessions: number;
  uniqueListeners: number;
  avgSessionSeconds: number;
  countries: number;
}
export interface BreakdownRow {
  key: string;
  sessions: number;
  listeners: number;
  hours: number;
}
export interface Place {
  country: string | null;
  city: string | null;
  lat: number;
  lon: number;
  sessions: number;
  listeners: number;
  hours: number;
}
export interface StatsReport {
  from: string;
  to: string;
  kpis: StatsKpis;
  previous: StatsKpis;
  timeseries: { bucket: string; points: { t: string; avg: number; peak: number }[] };
  countries: BreakdownRow[];
  regions: BreakdownRow[];
  cities: BreakdownRow[];
  devices: BreakdownRow[];
  players: BreakdownRow[];
  os: BreakdownRow[];
  mounts: BreakdownRow[];
  referrers: BreakdownRow[];
  networks: BreakdownRow[];
  durations: { fromSeconds: number; toSeconds: number | null; sessions: number }[];
  heatmap: { weekday: number; hour: number; avg: number }[];
  places: Place[];
}
export interface ListenerSession {
  id: string;
  stationId: string;
  stationName: string;
  mount: string;
  via: string;
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number;
  ip: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  network: string | null;
  device: string | null;
  player: string | null;
  os: string | null;
  referrer: string | null;
  userAgent: string | null;
}
export interface StatsLive {
  total: number;
  stations: { id: string; name: string; listeners: number; onAir: boolean }[];
  countries: { key: string; listeners: number }[];
  devices: { key: string; listeners: number }[];
  trend: { t: string; listeners: number }[];
  places: Place[];
  recent: ListenerSession[];
}
export interface StatsProgramme {
  songs: { title: string; plays: number; avgListeners: number; avgPeak: number; avgChange: number; lastPlayed: string }[];
  plays: {
    id: number;
    stationId: string;
    stationName: string;
    mount: string;
    title: string;
    startedAt: string;
    endedAt: string | null;
    listenersStart: number;
    listenersPeak: number;
    listenersEnd: number | null;
  }[];
  broadcasts: {
    id: string;
    stationId: string;
    stationName: string;
    accountName: string;
    mount: string;
    startedAt: string;
    endedAt: string | null;
    avgListeners: number;
    peakListeners: number;
  }[];
}
export interface StatisticsSettings {
  anonymizeIps: boolean;
  minSessionSeconds: number;
  excludeBots: boolean;
  sessionRetentionDays: number;
  sampleRetentionDays: number;
  hourlyRetentionDays: number;
  geoip: { provider: 'dbip' | 'maxmind'; maxmindAccountId: string; maxmindLicenseKey: string; autoUpdate: boolean };
}
export interface GeoipDatabase {
  provider: 'dbip' | 'maxmind';
  release: string;
  downloadedAt: string;
  cityBuiltAt: string | null;
  hasAsn: boolean;
}

// Public pages (phase 5)

export type LinkKind = 'instagram' | 'facebook' | 'x' | 'tiktok' | 'youtube' | 'soundcloud' | 'mixcloud' | 'whatsapp';
export interface PublicPageSettings {
  enabled: boolean;
  showListeners: boolean;
  showHistory: boolean;
  historyCount: number;
  artwork: boolean;
  accentColor: string;
  theme: 'auto' | 'light' | 'dark';
  links: Record<LinkKind, string>;
  requests: { enabled: boolean; onlyWhenLive: boolean; perHour: number; message: string };
  onDemand: { enabled: boolean };
  recording: { enabled: boolean; autoPublish: boolean; keepDays: number; minMinutes: number };
}
export interface PublicPageInfo {
  settings: PublicPageSettings;
  logoUrl: string | null;
  pageUrl: string;
  embedBase: string;
  apiBase: string;
}
export type RequestStatus = 'pending' | 'accepted' | 'played' | 'rejected';
export interface SongRequest {
  id: string;
  /** Picked from the library (Radio stations). */
  mediaId: string | null;
  artist: string;
  title: string;
  message: string;
  requesterName: string;
  status: RequestStatus;
  handledBy: string | null;
  handledAt: string | null;
  createdAt: string;
}
export interface OnDemandItem {
  id: string;
  source: 'recording' | 'upload';
  file: string;
  title: string;
  description: string;
  host: string;
  contentType: string;
  sizeBytes: number;
  durationSeconds: number | null;
  recordedAt: string | null;
  publishedAt: string | null;
  plays: number;
  createdAt: string;
  recording: boolean;
  previewUrl: string;
}

// Phase 6: AutoDJ

export type QueueName = 'q1' | 'q2';
export type QueueRuleMode = 'alternate' | 'ratio' | 'q1_first' | 'q2_first';
export interface AutodjSettings {
  enabled: boolean;
  mountId: string | null;
  crossfadeSeconds: number;
  normalize: boolean;
  rule: { mode: QueueRuleMode; q1: number; q2: number };
  queueDepth: number;
  fill: { q1: boolean; q2: boolean };
  artistSeparationMinutes: number;
  trackSeparationMinutes: number;
  pauseWhenLive: boolean;
  requests: { fromLibrary: boolean; autoQueue: boolean; queue: QueueName; repeatMinutes: number };
}
export interface QueueRow {
  id: string;
  queue: QueueName;
  state: 'queued' | 'cued' | 'playing';
  origin: 'rotation' | 'request' | 'manual' | 'clock';
  addedBy: string | null;
  requestId: string | null;
  playlistName: string | null;
  /** Clock item it came from. */
  label: string | null;
  startedAt: string | null;
  media: { id: string; title: string; artist: string; album: string; durationSeconds: number | null; location: string; path: string };
}
export interface AutodjView {
  edition: Edition;
  settings: AutodjSettings;
  mount: { id: string; path: string; format: AudioFormat; bitrateKbps: number } | null;
  coveredMounts: string[];
  player: { expected: boolean; connected: boolean; seenAt: string | null; paused: boolean };
  nowPlaying: QueueRow | null;
  queues: { q1: QueueRow[]; q2: QueueRow[] };
  library: { tracks: number; enabled: number; playlists: number };
  schedule: { enabled: boolean; clock: { id: string; name: string; color: string } | null; entry: { id: string; name: string; live: boolean } | null };
}
export interface MediaFile {
  id: string;
  location: string;
  path: string;
  title: string;
  artist: string;
  album: string;
  genre: string;
  year: number | null;
  durationSeconds: number | null;
  bitrateKbps: number | null;
  gainDb: number | null;
  sizeBytes: number;
  enabled: boolean;
  edited: boolean;
  playCount: number;
  lastPlayedAt: string | null;
  createdAt: string;
  playlistIds: string[];
}
export interface LibraryLocation {
  id: string;
  name: string;
  type: 'storage' | 'local' | 'smb' | 'nfs';
  tracks: number;
}
export interface LibraryFolders {
  locations: LibraryLocation[];
  folders: { location: string; path: string; tracks: number }[];
}
export interface ScanProgress {
  running: boolean;
  location: string | null;
  found: number;
  added: number;
  updated: number;
  removed: number;
  startedAt: string | null;
  finishedAt: string | null;
  errors: string[];
}
export interface PlaylistFolder {
  location: string;
  path: string;
}
export interface Playlist {
  id: string;
  name: string;
  queue: QueueName;
  weight: number;
  order: 'shuffle' | 'random' | 'sequential';
  folders: PlaylistFolder[];
  enabled: boolean;
  /** Feeds its queue; off = only for hour clocks. */
  rotation: boolean;
  trackCount: number;
  averageSeconds: number | null;
  createdAt: string;
}
export type MediaSourceType = 'local' | 'smb' | 'nfs';
export interface MediaSource {
  id: string;
  name: string;
  type: MediaSourceType;
  enabled: boolean;
  config: { path?: string; host?: string; share?: string; export?: string; username?: string; password?: string; domain?: string; version?: string };
  status: { state: 'pending' | 'ok' | 'error'; message?: string; checkedAt?: string } | null;
  fileCount: number;
  scannedAt: string | null;
}

// Phase 7: scheduler

export interface ClockItem {
  id: string;
  kind: 'rotation' | 'playlist' | 'track';
  label: string;
  playlistId: string | null;
  mediaId: string | null;
  /** Tracks (playlist); 0 = until the next timed item. */
  count: number;
  /** Minute of the hour; null = after the item before. */
  at: number | null;
  hard: boolean;
}
export interface Clock {
  id: string;
  name: string;
  color: string;
  items: ClockItem[];
  createdAt: string;
  updatedAt: string;
}
export interface ScheduleEntry {
  id: string;
  name: string;
  description: string;
  clockId: string | null;
  live: boolean;
  accountIds: string[];
  /** ISO weekdays, 1 = Monday. */
  days: number[];
  date: string | null;
  startMinute: number;
  durationMinutes: number;
  isPublic: boolean;
  enabled: boolean;
  createdAt: string;
}
export interface SchedulerSettings {
  enabled: boolean;
  timezone: string;
  defaultClockId: string | null;
  liveOnlyInShows: boolean;
  liveEarlyMinutes: number;
  publicSchedule: boolean;
}
export interface SchedulerView {
  settings: SchedulerSettings;
  clocks: Clock[];
  entries: ScheduleEntry[];
  accounts: { id: string; username: string; displayName: string }[];
  now: { date: string; weekday: number; minuteOfDay: number; second: number };
  onAir: { entryId: string | null; clockId: string | null };
  tracks: { id: string; title: string; artist: string; durationSeconds: number | null }[];
}
