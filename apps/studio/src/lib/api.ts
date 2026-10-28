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
  player: { expected: boolean; connected: boolean; paused: boolean };
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
  source: 'queues' | 'playlist' | 'track';
  label: string;
  count: number;
  /** Expected length of a format item in seconds (server 1.3; null = unknown). */
  seconds?: number | null;
  clock: { id: string; name: string; color: string } | null;
  show: { id: string; name: string; live: boolean } | null;
  current: boolean;
  past: boolean;
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
