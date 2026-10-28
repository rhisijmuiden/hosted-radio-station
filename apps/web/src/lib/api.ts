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
  memberships: { tenantId: string; tenantName: string; tenantSlug: string; plan: Plan; role: Role; billed: boolean }[];
}
export interface TenantLimits {
  maxStations: number;
  maxListeners: number;
  maxBitrateKbps: number;
  storageQuotaMb: number;
  maxNodes: number;
}
export interface Tenant {
  id: string;
  name: string;
  slug: string;
  plan: Plan;
  limits: TenantLimits;
  active: boolean;
  externalRef: string | null;
  /** Station node where new stations of this customer start (phase 12). */
  stationNodeId: string | null;
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
  scope: 'full' | 'provisioning';
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
  /** Names of this server and its own roles (phase 18). */
  server: { name: string; ingest: string; relay: string; orchestratorOnly: boolean };
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
  /** The station node that runs the station (phase 12), or null for this server. */
  nodeId: string | null;
  nodeOnline: boolean | null;
  nodeSeenAt: string | null;
  nodeMove: StationMove | null;
  createdAt: string;
}
export interface StationMove {
  direction: 'to_node' | 'to_main';
  nodeId: string;
  state: 'copying' | 'failed';
  files: number;
  filesDone: number;
  bytes: number;
  bytesDone: number;
  message?: string;
  startedAt: string;
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
  /** The ingest node behind the ingest host, when the station is routed to one. */
  node: { id: string; name: string } | null;
  /** The backup ingest: encoders can use it as their backup server. */
  backup: { host: string; node: { id: string; name: string } | null; tls: { port: number; available: boolean }; plain: { port: number } | null } | null;
  tls: { port: number; available: boolean };
  plain: { port: number } | null;
  legacy: { port: number; sourcePort: number; mount: string | null } | null;
  listenBase: string;
  mounts: { id: string; path: string; encoderMount: string; listenUrl: string | null }[];
  upload: { host: string; sftpPort: number | null; ftpPort: number | null; ftpRequireTls: boolean };
  endpoints: ConnectionEndpoint[];
  panelUrl: string;
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
  /** Works, but could be better: 'a_record' or 'old_target' (phase 15). */
  warning?: string;
  /** The CNAME target the record should have. */
  expected?: string;
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
  ingestNodeId: string | null;
  /** Cloudflare DNS: this domain's own CNAME targets on the platform domain. */
  targets: { panel: string; ingest: string } | null;
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
  encoderHost: string;
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
  /** Relay nodes that carry the station ("node:<id>" in filters). */
  nodes: { id: string; name: string }[];
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
  /** DJs cannot skip it or play something else over it (missing on clocks saved before 1.3). */
  locked?: boolean;
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

// Nodes (distribution network)

export type NodeRole = 'relay' | 'source' | 'station' | 'fm';
/** FM/MPX settings of a node (phase 11). Shares are 0..1 of 100% modulation. */
export interface FmConfig {
  stationId: string | null;
  mount: string | null;
  rds: boolean;
  pi: string;
  ps: string;
  psMode: 'static' | 'dynamic';
  psSeconds: number;
  rtSong: string;
  rtLive: string;
  rtIdle: string;
  rtPlus: boolean;
  pty: number;
  tp: boolean;
  ta: boolean;
  music: boolean;
  af: number[];
  clock: boolean;
  stereo: boolean;
  preemphasis: 0 | 50 | 75;
  limiter: boolean;
  pilot: number;
  rdsLevel: number;
  gainDb: number;
  bufferSeconds: number;
  output: 'soundcard' | 'rtp' | 'none';
  device: string;
  channels: 1 | 2;
  rtpHost: string;
  rtpPort: number;
  rtpTtl: number;
  uecp: boolean;
  uecpTransport: 'tcp' | 'udp' | 'serial';
  uecpHost: string;
  uecpPort: number;
  uecpDevice: string;
  uecpBaud: number;
  uecpSite: number;
  uecpEncoder: number;
}
export interface FmStatus {
  input: 'idle' | 'connecting' | 'connected' | 'error';
  inputMessage?: string;
  title: string | null;
  output: 'off' | 'starting' | 'running' | 'error';
  outputMessage?: string;
  uecp: 'off' | 'connecting' | 'connected' | 'error';
  uecpMessage?: string;
  meters: { peak: number; left: number; right: number; buffered: number; ppm: number; underruns: number; overruns: number; playing: boolean } | null;
  ps: string;
  psFrames: string[];
  rt: string;
  tags: { type: number; start: number; length: number }[];
  groups: Record<string, number>;
}
export interface NodeConfig {
  publicHost: string;
  listenPort: number | null;
  relayStations: 'all' | string[];
  maxListeners: number;
  sourcePlainPort: number | null;
  sourceTlsPort: number | null;
  probe: boolean;
  /** Relay: where station nodes push their streams (TLS). */
  pushPort: number;
  /** Keeps the ports from before the port plan open next to the new ones (1.3). */
  oldPorts: boolean;
  /** Station node: its address on the studio network, for encoders and RHIS Studio there. */
  lanAddress: string;
  fm: FmConfig;
  updatePolicy: 'inherit' | UpdatePolicy;
  updateGroup: string | null;
  updateWindow: UpdateWindow | null;
  /** Cloudflare DNS (phase 15). */
  dnsName: string;
  dnsRecord: boolean;
  certDns?: boolean;
  publicAddress: string;
  /** Set by the platform: the node's platform name while its record exists. */
  dnsHost: string;
  publicHostCheck: { ok: boolean; found: string[]; error?: string; at: string } | null;
  /** Shared or dedicated (1.1.1). */
  dedication: NodeDedication;
  dedicatedTenantId: string | null;
  dedicatedStationId: string | null;
}
export type NodeDedication = 'auto' | 'shared' | 'customer' | 'station';
/** Who a node serves: everyone, one customer, one station, or the stations that run on it (a station node). */
export interface NodeScope {
  kind: 'shared' | 'customer' | 'station' | 'placed' | 'none';
  tenantId: string | null;
  stationId: string | null;
}
export type UpdatePolicy = 'rolling' | 'window' | 'manual';
export interface UpdateWindow {
  days: number[];
  start: string;
  end: string;
}
export interface UpdateGroup {
  id: string;
  name: string;
  policy: UpdatePolicy;
  window: UpdateWindow;
}
export interface NodeUpdatesSettings {
  enabled: boolean;
  policy: UpdatePolicy;
  window: UpdateWindow;
  timezone: string;
  drainSeconds: number;
  healthSeconds: number;
  groups: UpdateGroup[];
}
export interface VersionRef {
  commit: string | null;
  branch: string | null;
}
export type NodeUpdateState = 'upToDate' | 'waiting' | 'scheduled' | 'manual' | 'paused' | 'disabled' | 'failed' | 'queued' | 'draining' | 'updating' | 'checking' | 'rollingBack';
export interface NodeUpdateInfo {
  policy: UpdatePolicy;
  source: 'node' | 'group' | 'role' | 'network';
  group: { id: string; name: string } | null;
  window: UpdateWindow;
  state: NodeUpdateState;
  target: VersionRef;
  nextWindowAt: string | null;
  phaseAt: string | null;
  phaseEndsAt: string | null;
  message: string | null;
  queuePosition: number | null;
  last: { state: 'succeeded' | 'failed' | 'rolledBack'; target: VersionRef; from: VersionRef; message: string | null; at: string; rollbackTo: string | null } | null;
}
export interface NodeRolloutInfo {
  target: VersionRef & { version: string };
  enabled: boolean;
  paused: { reason: string; nodeId: string | null; nodeName: string | null; at: string } | null;
  current: { nodeId: string; nodeName: string; phase: 'draining' | 'updating' | 'checking' | 'rollingBack'; target: VersionRef; manual: boolean; by: string | null; startedAt: string; message: string | null } | null;
  queue: { nodeId: string; nodeName: string; by: string | null }[];
  upToDate: number;
  paired: number;
}
export type RelayState = 'connecting' | 'connected' | 'error' | 'idle';
export interface NodeStatus {
  online: boolean;
  version?: string;
  commit?: string | null;
  hostname?: string;
  caddy?: boolean;
  addresses?: string[];
  ip?: string | null;
  country?: string | null;
  city?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  cpu?: number;
  memory?: number;
  load?: number;
  cores?: number;
  uptime?: number;
  rxBps?: number;
  txBps?: number;
  rttMs?: number | null;
  loss?: number;
  timeouts24h?: number;
  icmp?: { rttMs: number | null; loss: number } | null;
  listeners?: number;
  relays?: { key: string; state: RelayState; message?: string; bitrateKbps?: number | null; listeners?: number }[];
  encoders?: number;
  problems?: string[];
  applyLog?: string[];
  update?: { state: 'idle' | 'running' | 'succeeded' | 'failed'; message?: string; at?: string } | null;
  ffmpeg?: boolean;
  soundcards?: { device: string; name: string }[];
  fm?: FmStatus | null;
  updatedAt?: string;
}
export interface NodeItem {
  id: string;
  tenantId: string | null;
  tenantName: string | null;
  name: string;
  location: string;
  roles: NodeRole[];
  config: NodeConfig;
  paired: boolean;
  pairedAt: string | null;
  pairingExpiresAt: string | null;
  lastSeenAt: string | null;
  status: NodeStatus;
  listenBase: string | null;
  updateAvailable: boolean;
  update: NodeUpdateInfo;
  ingestHosts: string[];
  scope: NodeScope;
  createdAt: string;
}
export interface NodePairing {
  code: string;
  expiresAt: string;
  command: string;
  /** This server's address, for the node's setup page and `hrs-node pair`. */
  server: string;
}
/** A machine that registered itself and waits under "Pending nodes" (phase 16). */
export interface NodeRegistration {
  id: string;
  code: string;
  hostname: string;
  ip: string | null;
  addresses: string[];
  version: string;
  preferredRole: NodeRole | null;
  suggestedName: string;
  createdAt: string;
  expiresAt: string;
}
export interface NodeEvent {
  id: number;
  at: string;
  level: 'info' | 'warning' | 'error';
  kind: string;
  details: Record<string, string | number | null>;
}
export interface NodeMetric {
  at: string;
  rttAvg: number | null;
  rttMax: number | null;
  pings: number;
  lost: number;
  cpu: number | null;
  memory: number | null;
  rxBps: number | null;
  txBps: number | null;
  listeners: number | null;
}
export interface NodeProbe {
  target: string;
  stationId: string;
  stationName: string;
  url: string;
  where: string;
  whereName: string;
  ok: boolean;
  httpStatus: number | null;
  ttfbMs: number | null;
  message: string | null;
  checkedAt: string;
  lastOkAt: string | null;
  uptime24h: number | null;
}
export interface NodesSettings {
  autoUpdate: boolean;
  updates: NodeUpdatesSettings;
  routeListeners: boolean;
  probeIntervalSeconds: number;
  latencyWarnMs: number;
  metricsRetentionDays: number;
  /** Where source nodes pass encoders on to this server; empty = its public name. */
  ingestAddress: string;
  /** Machines may register themselves and wait under "Pending nodes" (phase 16). */
  openRegistration: boolean;
}
export type PortService = 'encoderTls' | 'encoderPlain' | 'legacy' | 'sftp' | 'ftp' | 'ftpPassive' | 'listeners' | 'listenersTls' | 'push';
/** Where a station's studio, encoders and uploads connect, as the orchestrator hands it out (phase 18). */
export interface ConnectionEndpoint {
  role: 'stationNode' | 'ingest' | 'backupIngest' | 'uploads';
  name: string;
  /** Null = this server. */
  node: { id: string; name: string } | null;
  online: boolean;
  external: string | null;
  internal: string | null;
  /** `old`: a port from before the port plan (1.3), after the new one. */
  ports: { service: PortService; port: number; to?: number; tls?: boolean; old?: boolean }[];
}
export interface StationConnection {
  endpoints: ConnectionEndpoint[];
  panelUrl: string;
  orchestrator: string;
  orchestratorOnly: boolean;
}
export interface ServerNames {
  orchestrator: { name: string; default: string; shown: string; host: string };
  ingest: { name: string; default: string; shown: string };
  relay: { name: string; default: string; shown: string };
  nodes: { id: string; name: string; roles: NodeRole[]; location: string; hostname: string | null; ip: string | null; tenantName: string | null; online: boolean }[];
}
export type AudioUse = 'ingest' | 'backupIngest' | 'listeners' | 'autodj' | 'moving';
export interface OrchestratorView {
  only: boolean;
  stations: { id: string; name: string; slug: string; tenantId: string; tenantName: string; uses: AudioUse[] }[];
  ingestNodes: number;
  stationNodes: number;
  relayNodes: number;
}
export interface FirewallPort {
  service: PortService;
  port: number;
  to?: number;
  for: ('studio' | 'encoders' | 'uploads' | 'listeners' | 'ingests')[];
  station?: string;
  /** A port from before the port plan, open while the node keeps its old ports (1.3). */
  old?: boolean;
}
/** The port plan (1.3): ports per role, and where the old ports are still open. */
export interface PortPlan {
  ports: {
    orchestrator: { https: number; http: number };
    ingest: { plain: number; tls: number; shoutcastFrom: number; shoutcastTo: number };
    relay: { push: number };
    stationNode: { plain: number; tls: number; sftp: number };
  };
  old: { plain: number; tls: number; push: number; sftp: number; shoutcastFrom: number; shoutcastTo: number };
  thisServer: boolean;
  orchestratorOnly: boolean;
  oldShoutcast: number;
  nodes: { id: string; name: string; roles: NodeRole[]; online: boolean; oldPorts: boolean }[];
}
export interface NodeFirewall {
  selfHosted: boolean;
  external: string | null;
  internal: string | null;
  /** The node has a public address on its own interface: nothing to forward. */
  publicInterface: boolean;
  /** How the node's name resolved at the last check. */
  dns: { host: string; state: 'ok' | 'stale' | 'missing'; checkedOn: string } | null;
  ports: FirewallPort[];
  checks: Record<string, { ok: boolean; message: string | null; ms: number | null; at: string }>;
}
export interface TopologyNode {
  id: string;
  name: string;
  /** FM/MPX node: the station node of its studio, drawn beside it (null = none). */
  home?: string | null;
  /** Host name and address, for who manages the node. */
  hostname: string | null;
  ip: string | null;
  /** One of this server's own roles (local:ingest, local:relay), not a node. */
  local: boolean;
  /** Stations this node is the main or backup ingest of. */
  ingestStations: number;
  location: string;
  roles: NodeRole[];
  own: boolean;
  tenantId: string | null;
  paired: boolean;
  online: boolean;
  degraded: boolean;
  version: string | null;
  rttMs: number | null;
  loss: number | null;
  timeouts24h: number | null;
  cpu: number | null;
  txBps: number | null;
  listeners: number;
  encoders: number;
  country: string | null;
  city: string | null;
  stations: number;
  updateAvailable: boolean;
  relaysUp: number;
  relaysTotal: number;
  /** FM/MPX node with its station on air. */
  fmOnAir: boolean;
}
/** "local" = this server's own ingest; otherwise an ingest node id. */
export type IngestRef = 'local' | string;
export interface StationRouting {
  ingest: IngestRef;
  backupIngest: IngestRef | null;
  relays: 'auto' | string[];
  spareRelays: boolean;
  /** Station on a station node (1.3): through the ingests (default) or straight to the relays. */
  delivery: 'ingest' | 'direct';
}
export interface RoutingChoice {
  id: string;
  name: string;
  location: string;
  online: boolean;
  own: boolean;
}
export interface StationRoutingView {
  routing: StationRouting;
  /** Station on a station node: where it sends its streams now. `direct` says why it feeds the relays itself. */
  studio: { ingests: { id: string; name: string; online: boolean; priority: number }[]; direct: 'chosen' | 'update' | 'none' | 'offline' | 'failing' | null } | null;
  locked: 'station_node' | null;
  /** This server carries no audio (phase 18). */
  orchestratorOnly: boolean;
  autodjHere: boolean;
  canEdit: boolean;
  options: { ingests: RoutingChoice[]; relays: RoutingChoice[] };
  /** Chosen relays that can no longer carry the station; dropped on the next save. */
  stale: { id: string; name: string }[];
  status: {
    active: IngestRef | null;
    ingests: { ref: IngestRef; priority: number; name: string; online: boolean; onAir: boolean }[];
    relays: { id: string; name: string; online: boolean; connected: number; total: number; spare: boolean }[];
  };
}
export interface TopologyStudio {
  id: string;
  station: string;
  stationId: string;
  account: string;
  mount: string;
  via: string;
  nodeId: string | null;
  since: string;
}
export interface TopologyLink {
  from: string;
  to: string;
  kind: 'control' | 'stream';
  active: boolean;
  degraded: boolean;
  rttMs: number | null;
  loss: number | null;
  /** Streams on the line and their bitrate together. */
  streams: number;
  kbps: number | null;
  /** A backup ingest feeding the relay on standby. */
  standby: boolean;
}
export type TopologyCell = 'onAir' | 'standby' | 'degraded' | 'down' | 'idle';
export interface TopologyStation {
  id: string;
  name: string;
  tenantId: string | null;
  edition: 'distribution' | 'station';
  stationNode: string | null;
  ingest: string | null;
  backup: string | null;
  active: string | null;
  relays: string[];
  listeners: number;
  cells: Record<string, TopologyCell>;
}
export interface Topology {
  view: 'admin' | 'customer';
  main: { id: 'main'; name: string; host: string | null; orchestratorOnly: boolean; version: string; commit: string | null; branch: string | null; listeners: number; stations: number };
  nodes: TopologyNode[];
  studios: TopologyStudio[];
  links: TopologyLink[];
  stations: TopologyStation[];
  audience: { nodeId: string; stationId: string; country: string | null; listeners: number }[];
  kpis: {
    nodesOnline: number;
    nodesTotal: number;
    degraded: number;
    listeners: number;
    relayListeners: number;
    avgRttMs: number | null;
    worst: string | null;
    worstRttMs: number | null;
    txBps: number;
    timeouts24h: number;
  };
}

export interface StudioRelease {
  version: string;
  tag: string;
  publishedAt: string;
  notes: string;
  url: string;
  installerUrl: string | null;
  sha256: string | null;
  size: number | null;
}
export interface StudioReleases {
  repository: string | null;
  production: StudioRelease | null;
  test: StudioRelease | null;
  checkedAt: string | null;
  error: string | null;
}
export interface StudioDevice {
  id: string;
  deviceName: string;
  clientVersion: string | null;
  apiKeyId: string;
  lastUsedAt: string | null;
  createdAt: string;
}
export interface StudioLink {
  code: string;
  deviceName: string;
  clientVersion: string | null;
  ip: string | null;
  state: 'pending' | 'approved' | 'denied' | 'used' | 'expired';
  createdAt: string;
  expiresAt: string;
}

// Phase 10: hosted service

export interface Localized {
  en: string;
  nl: string;
}
export interface Package {
  id: string;
  code: string;
  name: string;
  description: Localized;
  features: Localized[];
  edition: Plan;
  limits: TenantLimits;
  currency: string;
  priceMonthCents: number;
  priceYearCents: number | null;
  setupFeeCents: number;
  trialDays: number;
  public: boolean;
  active: boolean;
  sortOrder: number;
  subscriberCount: number;
  createdAt: string;
  updatedAt: string;
}
export type PackageInput = Omit<Package, 'id' | 'subscriberCount' | 'createdAt' | 'updatedAt'>;
export type SubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'suspended' | 'cancelled';
export type BillingInterval = 'month' | 'year';
export interface BillingContact {
  company: string;
  name: string;
  email: string;
  address: string;
  postcode: string;
  city: string;
  country: string;
  vatNumber: string;
  reference: string;
}
interface PackageBrief {
  id: string;
  code: string;
  name: string;
  edition: Plan;
  currency: string;
}
export interface Subscription {
  id: string;
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  package: PackageBrief;
  pendingPackage: PackageBrief | null;
  interval: BillingInterval;
  pendingInterval: BillingInterval | null;
  status: SubscriptionStatus;
  trialEndsAt: string | null;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
  cancelledAt: string | null;
  suspendedAt: string | null;
  customPriceCents: number | null;
  discountPercent: number;
  customLimits: boolean;
  billing: BillingContact;
  locale: string;
  notes: string;
  priceCents: number;
  monthlyCents: number;
  createdAt: string;
}
export interface SubscriptionInfo {
  subscription: Subscription | null;
  billingEnabled: boolean;
  mollie: boolean;
  next: { at: string; subtotalCents: number; vatCents: number; totalCents: number; vatRate: number } | null;
}
export interface InvoiceLine {
  description: string;
  quantity: number;
  unitCents: number;
  amountCents: number;
}
export interface Invoice {
  id: string;
  number: string;
  tenantId: string | null;
  tenantName: string;
  subscriptionId: string | null;
  status: 'open' | 'paid' | 'void';
  overdue: boolean;
  issuedAt: string;
  dueAt: string;
  periodStart: string | null;
  periodEnd: string | null;
  currency: string;
  lines: InvoiceLine[];
  subtotalCents: number;
  vatRate: number;
  vatScheme: 'standard' | 'reverse_charge' | 'export';
  vatCents: number;
  totalCents: number;
  buyer: BillingContact;
  locale: string;
  notes: string;
  paidAt: string | null;
  paymentMethod: string | null;
  paymentRef: string | null;
  payable: boolean;
  sentAt: string | null;
  remindedAt: string | null;
  publicUrl: string;
}
export interface InvoicePage {
  total: number;
  items: Invoice[];
}
export interface BillingOverview {
  enabled: boolean;
  mrrCents: number;
  arrCents: number;
  subscriptions: Record<SubscriptionStatus, number>;
  openInvoices: number;
  openCents: number;
  overdueCents: number;
  paidLast30Cents: number;
}
export interface BillingSettings {
  enabled: boolean;
  company: {
    company: string;
    name: string;
    email: string;
    phone: string;
    address: string;
    postcode: string;
    city: string;
    country: string;
    vatNumber: string;
    cocNumber: string;
    iban: string;
    bic: string;
    website: string;
  };
  invoicePrefix: string;
  vatRate: number;
  reverseCharge: boolean;
  paymentTermDays: number;
  reminderAfterDays: number;
  suspendAfterDays: number;
  emailInvoices: boolean;
  bccEmail: string;
  footer: string;
  mollie: { enabled: boolean; apiKey: string };
}
export interface Webhook {
  id: string;
  name: string;
  url: string;
  events: string[];
  active: boolean;
  createdAt: string;
  lastDelivery: { state: string; event: string; responseStatus: number | null; at: string } | null;
  secret?: string;
}
export interface WebhookDelivery {
  id: string;
  event: string;
  state: 'pending' | 'sending' | 'delivered' | 'failed';
  attempts: number;
  responseStatus: number | null;
  error: string | null;
  nextAttemptAt: string;
  deliveredAt: string | null;
  createdAt: string;
  payload: Record<string, unknown>;
}
export const WEBHOOK_EVENTS = [
  'customer.created',
  'subscription.created',
  'subscription.updated',
  'subscription.cancelled',
  'subscription.suspended',
  'subscription.resumed',
  'invoice.created',
  'invoice.paid',
  'invoice.overdue',
] as const;

// Phase 15: Cloudflare DNS

export type DnsMode = 'off' | 'dryRun' | 'on';
export interface CloudflareSettings {
  mode: DnsMode;
  apiToken: string;
  zoneId: string;
  zoneName: string;
  domain: string;
  originLabel: string;
  poolLabel: string;
  streamLabel: string;
  srcLabel: string;
  nodeLabel: string;
  nodeRecords: boolean;
  customerTargets: boolean;
  ttl: number;
  originAddresses: string[];
  panelRecord: { manage: boolean; proxied: boolean };
  cacheRules: boolean;
  /** Read only: where records go, and this installation's id in record comments. */
  platformDomain?: string;
  install?: string;
}
export type DnsPurpose = 'origin' | 'panel' | 'node' | 'pool' | 'stream' | 'src';
export interface DnsState {
  at: string | null;
  mode: DnsMode;
  error: string | null;
  origin: { addresses: string[]; source: 'settings' | 'streaming' | 'detected' | 'none' };
  records: { name: string; type: string; content: string; proxied: boolean; ttl: number; purpose: DnsPurpose; ref: string | null; state: 'ok' | 'create' | 'update' | 'conflict' }[];
  stale: { name: string; type: string; content: string }[];
  problems: { kind: string; ref: string | null; name: string | null }[];
  lastChanges: { action: 'create' | 'update' | 'delete'; name: string; type: string; content: string; proxied: boolean; before: string | null }[];
  lastChangeAt: string | null;
  cache: { state: 'off' | 'ok' | 'pending' | 'error'; host: string | null; rules: number; foreign: number; error: string | null; at: string | null };
}
export interface DnsTestResult {
  ok: boolean;
  zoneId: string | null;
  zoneName: string | null;
  records: number | null;
  message: string | null;
}
export interface NodeDns {
  active: boolean;
  domain: string | null;
  platformName: string | null;
  live: boolean;
  addresses: string[];
  problem: 'noAddress' | 'nameTaken' | 'off' | null;
  host: string | null;
  ownHost: string | null;
  check: { ok: boolean; found: string[]; error?: string; at: string } | null;
}
