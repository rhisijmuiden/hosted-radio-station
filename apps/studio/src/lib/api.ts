import { getSettings } from './settings';
import { call, httpFetch } from './native';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

let apiKey: string | null = null;
export const setApiKey = (k: string | null) => (apiKey = k);
export const getApiKey = () => apiKey;

/** Called with every 401, so the app can return to the sign-in screen. */
let onUnauthorized: () => void = () => {};
export const setOnUnauthorized = (fn: () => void) => (onUnauthorized = fn);

export async function api<T>(path: string, init: { method?: string; body?: unknown; server?: string; auth?: boolean } = {}): Promise<T> {
  const server = init.server ?? getSettings().server;
  const headers: Record<string, string> = { accept: 'application/json' };
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  if (init.auth !== false && apiKey) headers.authorization = `Bearer ${apiKey}`;
  let res: Response;
  try {
    res = await httpFetch(`${server}/api${path}`, { method: init.method ?? 'GET', headers, body: init.body !== undefined ? JSON.stringify(init.body) : undefined });
  } catch (err) {
    throw new ApiError(0, 'network', err instanceof Error && err.message ? err.message : 'The server cannot be reached');
  }
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && init.auth !== false) onUnauthorized();
    const err = data?.error;
    throw new ApiError(res.status, err?.code ?? 'error', err?.message ?? res.statusText);
  }
  return data as T;
}

/** The API key of this PC for a server, from the Windows Credential Manager. */
export const loadKey = (server: string) => call<string | null>('secret_get', { server });
export const saveKey = (server: string, key: string) => call<void>('secret_set', { server, key });
export const forgetKey = (server: string) => call<void>('secret_delete', { server });

// Types of the server API used by the client.

export type Role = 'superadmin' | 'owner' | 'manager' | 'dj';
export interface Me {
  user: { id: string; email: string; name: string; isSuperadmin: boolean; locale: string };
  memberships: { tenantId: string; tenantName: string; role: Exclude<Role, 'superadmin'> }[];
}
export interface StationListItem {
  id: string;
  tenantName: string;
  name: string;
  slug: string;
  edition: 'distribution' | 'station';
  enabled: boolean;
  onAir: boolean;
  listeners: number | null;
}
export interface Mount {
  id: string;
  path: string;
  name: string;
  kind: 'source' | 'transcode';
  format: 'mp3' | 'aac' | 'opus' | 'vorbis';
  bitrateKbps: number;
  isDefault: boolean;
}
export interface StationDetail extends StationListItem {
  tenantId?: string;
  mounts: Mount[];
  role: Role;
  connection: {
    ingestHost: string;
    tls: { port: number; available: boolean };
    plain: { port: number } | null;
    mounts: { id: string; path: string; encoderMount: string; listenUrl: string | null }[];
    /** Where everything connects (server 1.2 and later): the station node with its internal and external address. */
    endpoints?: Endpoint[];
  };
}
export interface Endpoint {
  role: 'stationNode' | 'ingest' | 'backupIngest' | 'uploads';
  name: string;
  node: { id: string; name: string } | null;
  online: boolean;
  external: string | null;
  internal: string | null;
  ports: { service: string; port: number; to?: number; tls?: boolean; old?: boolean }[];
}
export interface LiveSession {
  id: string;
  mountPath: string;
  accountName: string;
  userAgent: string | null;
  startedAt: string;
}
export interface StationStatus {
  running: boolean;
  listeners: number;
  mounts: { id: string | null; path: string; live: boolean; listeners: number; title: string | null }[];
  live: LiveSession[];
}
export interface Account {
  id: string;
  username: string;
  displayName: string;
  userId: string | null;
  canBroadcast: boolean;
  mountIds: string[];
  enabled: boolean;
  /** Fields the Manage view uses (every server since 1.0 sends them). */
  userName?: string | null;
  canUpload?: boolean;
  lastUsedAt?: string | null;
  uploadLogin?: string;
  /** Only in the answer that created the account or generated a new password. */
  password?: string;
}
/** A user of the customer, from /tenants/:id/members. */
export interface Member {
  user: { id: string; name: string; email: string };
  role: string;
}
/** Cue points in seconds from the start of the file; null = not set. Missing on servers before 1.3. */
export interface Cues {
  cueIn?: number | null;
  cueIntro?: number | null;
  cueSegue?: number | null;
  cueFadeOut?: number | null;
  cueOut?: number | null;
}
export interface Media extends Cues {
  id: string;
  title: string;
  artist: string;
  album: string;
  durationSeconds: number | null;
  location: string;
  path: string;
  enabled: boolean;
  /** The station's own number, e.g. HF-03007; ISRC, tempo and key ("Am"). Servers with `track-codes` only. */
  code?: string | null;
  isrc?: string;
  bpm?: number | null;
  musicKey?: string;
}
export interface QueueRow {
  id: string;
  queue: 'q1' | 'q2';
  state: 'queued' | 'cued' | 'loaded' | 'playing';
  origin: string;
  addedBy: string | null;
  requestId: string | null;
  playlistName: string | null;
  label: string | null;
  /** From a locked item of the format (server 1.3): DJs cannot skip it or play something over it. */
  locked?: boolean;
  startedAt: string | null;
  media: Pick<Media, 'id' | 'title' | 'artist' | 'album' | 'durationSeconds' | 'location' | 'path'> & Cues;
}
export interface AutoDj {
  edition: 'distribution' | 'station';
  settings: { enabled: boolean; crossfadeSeconds?: number };
  /** stuckSince: the track on air ran more than five minutes past its end with no DJ live (server 1.5.1 and later). */
  player: { expected: boolean; connected: boolean; paused: boolean; stuckSince?: string | null };
  /** Manual playout: every track waits for Play; holding = the track ended and the player waits. */
  playout: { manual: boolean; holding: boolean; until: string | null };
  nowPlaying: QueueRow | null;
  /** One queue since server 1.3 (`q1`); an older server may still have tracks in `q2`. */
  queues: { q1: QueueRow[]; q2?: QueueRow[] };
  schedule: { enabled: boolean; clock: { name: string; color: string } | null; entry: { name: string; live: boolean } | null };
}
/** One item of the format of the coming hours (an hour clock item), from /autodj/rundown. */
export interface RundownRow {
  hour: string;
  startsAt: string;
  timed: boolean;
  hard: boolean;
  /** DJs cannot skip it or play something over it (server 1.3). */
  locked?: boolean;
  kind: 'music' | 'item';
  source: 'queues' | 'playlist' | 'track' | 'news';
  label: string;
  count: number;
  /** Expected length of a format item in seconds (server 1.3; null = unknown). */
  seconds?: number | null;
  clock: { id: string; name: string; color: string } | null;
  show: { id: string; name: string; live: boolean } | null;
  current: boolean;
  past: boolean;
}
/** One row of the log editor (/autodj/log, servers with the `log-editor` feature). */
export interface LogRow {
  key: string;
  at: string;
  state: 'playing' | 'cued' | 'loaded' | 'planned';
  source: 'queue' | 'playlist' | 'item' | 'track' | 'news';
  itemId: string | null;
  editable: boolean;
  locked: boolean;
  hard: boolean;
  cut: boolean;
  origin: string | null;
  addedBy: string | null;
  label: string | null;
  media: { id: string; title: string; artist: string; durationSeconds: number | null; code: string | null; bpm: number | null; musicKey: string } | null;
  seconds: number | null;
}
export interface LogPlan {
  timezone: string;
  scheduled: boolean;
  until: string;
  hours: { hour: string; clock: { id: string; name: string; color: string } | null; show: { id: string; name: string; live: boolean } | null }[];
  rows: LogRow[];
}
/** The news bulletin of a Radio station, from /news (servers with the `news` feature). */
export interface NewsView {
  settings: { enabled: boolean; name: string; leadMinutes: number; maxAgeMinutes: number; fallbackMediaId: string | null };
  status: { mediaId: string | null; durationSeconds: number | null; fetchedAt: string | null; sourceAt: string | null; slot: string | null; error: string | null; ext: string | null };
  /** The coming news times from the hour clocks, with whether the bulletin may play then. */
  slots: { at: string; fresh: boolean }[];
  fallback: { id: string; title: string; artist: string; durationSeconds: number | null; ext: string } | null;
}
export interface Rundown {
  timezone: string;
  enabled: boolean;
  rows: RundownRow[];
}
/** A track the AutoDJ played, newest first (servers with the `history` feature). */
export interface Played {
  mediaId: string;
  title: string;
  artist: string;
  path: string;
  durationSeconds: number | null;
  playedAt: string;
}
/** The answer to /studio/hello: servers before 1.1 answer only { ok }. */
export interface Hello {
  ok: true;
  serverVersion?: string;
  features?: string[];
}
export interface StudioRelease {
  version: string;
  notes: string;
  installerUrl: string | null;
  sha256: string | null;
  publishedAt: string;
}
export interface StudioReleases {
  production: StudioRelease | null;
  test: StudioRelease | null;
  error: string | null;
}

/** Recording of live shows (phase 21 step 4). */
export interface LiveRecording {
  recorder: boolean;
  showsByDefault: boolean;
  live: { sessionId: string; accountName: string; startedAt: string; record: boolean; chosen: boolean; recording: boolean }[];
}
export interface ShowRecording {
  id: string;
  dj: string | null;
  startedAt: string;
  durationSeconds: number;
  sizeBytes: number;
  open: boolean;
  available: boolean;
  onDemand: boolean;
}

/** The nodes a station uses and their health, from /stations/:id/network (servers with the `manage` feature). */
export interface NetworkNode {
  /** A node id, or "main" for the orchestrator itself. */
  id: string;
  name: string;
  role: 'station' | 'ingest' | 'backupIngest' | 'relay' | 'recorder';
  shared: boolean;
  state: 'online' | 'standby' | 'warning' | 'offline';
  cpu: number | null;
  memory: number | null;
  checks: { ok: number; total: number } | null;
  firewall: string | null;
  version: string | null;
  /** The commit of the build (servers after 1.6 step 2). */
  commit?: string | null;
  listeners: number | null;
  issues: { kind: 'offline' | 'problem' | 'check' | 'relay' | 'firewall'; message: string | null }[];
}
export interface StationNetwork {
  nodes: NetworkNode[];
}
/** How a station travels, from /stations/:id/routing (managers). */
export interface StationRouting {
  routing: { ingest: string; backupIngest: string | null; relays: 'auto' | string[]; spareRelays: boolean; delivery: 'ingest' | 'direct' };
  studio: { ingests: { id: string; name: string; online: boolean; priority: number }[]; direct: 'chosen' | 'update' | 'none' | 'offline' | 'nocert' | 'failing' | null; error: string | null } | null;
  locked: 'station_node' | null;
  orchestratorOnly: boolean;
  autodjHere: boolean;
  canEdit: boolean;
  options: { ingests: { id: string; name: string; location: string; online: boolean; own: boolean }[]; relays: { id: string; name: string; location: string; online: boolean; own: boolean }[] };
  stale: { id: string; name: string }[];
  status: {
    active: string | null;
    ingests: { ref: string; priority: number; name: string; online: boolean; onAir: boolean }[];
    relays: { id: string; name: string; online: boolean; connected: number; total: number; spare: boolean }[];
  };
}
/** A playlist (music category) of the AutoDJ, from /stations/:id/playlists. */
export interface Playlist {
  id: string;
  name: string;
  queue: 'q1' | 'q2';
  weight: number;
  order: 'shuffle' | 'random' | 'sequential';
  folders: { location: string; path: string }[];
  enabled: boolean;
  /** Feeds its queue; off = only for hour clocks. */
  rotation: boolean;
  trackCount: number;
  averageSeconds: number | null;
  createdAt: string;
}
export type PlaylistFolder = Playlist['folders'][number];
/** The folders of the library per location, from /stations/:id/library/folders. */
export interface LibraryFolders {
  locations: { id: string; name: string; type: 'storage' | 'local' | 'smb' | 'nfs'; tracks: number }[];
  folders: { location: string; path: string; tracks: number }[];
}
/** Progress of the last library scan. */
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
/** The rotation rules and sound of the AutoDJ (the settings of /stations/:id/autodj), as the web panel edits them. */
export interface AutodjSettings {
  enabled: boolean;
  mountId: string | null;
  crossfadeSeconds: number;
  normalize: boolean;
  rule: { mode: string; q1: number; q2: number };
  queueDepth: number;
  fill: { q1: boolean; q2: boolean };
  artistSeparationMinutes: number;
  trackSeparationMinutes: number;
  pauseWhenLive: boolean;
  codePrefix?: string;
  analyse?: boolean;
  requests: { fromLibrary: boolean; autoQueue: boolean; queue: string; repeatMinutes: number };
}
/** One item of an hour clock (phase 7). */
export interface ClockItem {
  id: string;
  kind: 'rotation' | 'playlist' | 'track' | 'news';
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
/** Hour clocks and the weekly schedule, from /stations/:id/scheduler. */
export interface SchedulerView {
  settings: { enabled: boolean; timezone: string; defaultClockId: string | null; liveOnlyInShows: boolean; liveEarlyMinutes: number; publicSchedule: boolean };
  clocks: Clock[];
  entries: ScheduleEntry[];
  accounts: { id: string; username: string; displayName: string }[];
  now: { date: string; weekday: number; minuteOfDay: number; second: number };
  onAir: { entryId: string | null; clockId: string | null };
  tracks: { id: string; title: string; artist: string; durationSeconds: number | null }[];
}
