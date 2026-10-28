// The Rust side of the client (sound card, carts, encoder, streamer, credentials, updates). In a plain browser
// (`pnpm dev`, screenshots) a small simulation stands in, so the interface can be worked on without Windows.

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export interface AppInfo {
  version: string;
  os: string;
  arch: string;
  hostname: string;
  asio: boolean;
}
export interface DeviceInfo {
  host: string;
  name: string;
  channels: number;
  isDefault: boolean;
}
export interface Devices {
  hosts: string[];
  inputs: DeviceInfo[];
  outputs: DeviceInfo[];
}
export interface InputSel {
  host: string;
  device: string;
  left: number;
  right: number;
}
export interface OutputSel {
  host: string;
  device: string;
}
export interface AudioConfig {
  input: InputSel | null;
  output: OutputSel | null;
  inputGainDb: number;
  cartGainDb: number;
  cartsToStream: boolean;
  cartsToOutput: boolean;
  monitorInput: boolean;
  /** The single player goes down while the sound card input (the microphone) has sound. */
  duckSingle: boolean;
}
export interface EngineInfo {
  sampleRate: number;
  input: string | null;
  output: string | null;
  inputRate: number | null;
  outputRate: number | null;
  error: string | null;
}
export interface Meters {
  input: [number, number];
  output: [number, number];
  carts: number;
  limiterDb: number;
}
export interface CartState {
  slot: number;
  loaded: boolean;
  playing: boolean;
  position: number;
  duration: number;
}
export type BroadcastStatus =
  | { state: 'off' }
  | { state: 'connecting'; attempt: number }
  | { state: 'live'; since: number; bytes: number }
  | { state: 'reconnecting'; error: string; retryIn: number }
  | { state: 'failed'; error: string };
export interface Target {
  host: string;
  port: number;
  tls: boolean;
  mount: string;
  username: string;
  password: string;
  bitrate: number;
  sampleRate: number;
  name: string;
}
export interface PreviewState {
  loaded: boolean;
  playing: boolean;
  ended: boolean;
  name: string;
  position: number;
  duration: number;
  device: string | null;
}
export interface Waveform {
  perSecond: number;
  duration: number;
  /** 0–255 per 1/perSecond of a second. */
  peaks: number[];
}
export interface CueTrack {
  waveform: Waveform;
  preview: PreviewState;
}
export interface FolderEntry {
  name: string;
  path: string;
  dir: boolean;
  size: number;
}
export interface Folder {
  /** null: the drives of this PC. */
  path: string | null;
  parent: string | null;
  entries: FolderEntry[];
}
export type EngineEvent =
  | { kind: 'meters'; data: Meters }
  | { kind: 'carts'; data: CartState[] }
  | { kind: 'broadcast'; data: BroadcastStatus }
  | { kind: 'engine'; data: EngineInfo }
  | { kind: 'cartError'; data: { slot: number; error: string } };

// Simulation for the browser

const simFolders: Record<string, FolderEntry[]> = {
  'C:\\': [{ name: 'Users', path: 'C:\\Users', dir: true, size: 0 }],
  'E:\\': [
    { name: 'Jingles', path: 'E:\\Jingles', dir: true, size: 0 },
    { name: 'Mixes', path: 'E:\\Mixes', dir: true, size: 0 },
    { name: 'Avond intro.mp3', path: 'E:\\Avond intro.mp3', dir: false, size: 812_000 },
  ],
  'E:\\Jingles': [
    { name: 'Station ID kort.wav', path: 'E:\\Jingles\\Station ID kort.wav', dir: false, size: 690_000 },
    { name: 'Weerbed.mp3', path: 'E:\\Jingles\\Weerbed.mp3', dir: false, size: 1_420_000 },
    { name: 'Nieuws intro.mp3', path: 'E:\\Jingles\\Nieuws intro.mp3', dir: false, size: 380_000 },
  ],
  '\\\\nas\\muziek': [
    { name: 'Nederpop', path: '\\\\nas\\muziek\\Nederpop', dir: true, size: 0 },
    { name: 'Golden Earring - Radar Love.mp3', path: '\\\\nas\\muziek\\Golden Earring - Radar Love.mp3', dir: false, size: 9_100_000 },
    { name: 'Doe Maar - Smoorverliefd.flac', path: '\\\\nas\\muziek\\Doe Maar - Smoorverliefd.flac', dir: false, size: 24_000_000 },
  ],
};
const simParent = (p: string) => {
  if (/^[A-Z]:\\$/.test(p) || /^\\\\[^\\]+\\[^\\]+$/.test(p)) return null;
  const i = p.lastIndexOf('\\');
  return i > 2 ? p.slice(0, i) : p.slice(0, 3);
};

type Listener = (e: EngineEvent) => void;
const sim = {
  listeners: new Set<Listener>(),
  carts: Array.from({ length: 146 }, (_, slot): CartState & { started: number } => ({ slot, loaded: false, playing: false, position: 0, duration: 0, started: 0 })),
  broadcast: { state: 'off' } as BroadcastStatus,
  config: null as AudioConfig | null,
  previewOutput: null as string | null,
  preview: { loaded: false, playing: false, ended: false, name: '', position: 0, duration: 0, device: null, at: 0 } as PreviewState & { at: number },
  timer: 0 as unknown as ReturnType<typeof setInterval>,
  emit(e: EngineEvent) {
    sim.listeners.forEach((l) => l(e));
  },
  start() {
    if (sim.timer) return;
    let t = 0;
    sim.timer = setInterval(() => {
      t += 1;
      const hasInput = !!sim.config?.input;
      const wobble = (k: number) => (hasInput ? Math.max(0, 0.2 + 0.1 * Math.sin(t / (3 + k)) + 0.06 * Math.sin(t / 1.3 + k) + Math.random() * 0.08) : 0);
      const playing = sim.carts.filter((c) => c.playing);
      const now = Date.now();
      for (const c of playing) {
        c.position = (now - c.started) / 1000;
        if (c.position >= c.duration) {
          c.playing = false;
          c.position = 0;
        }
      }
      const carts = playing.length ? 0.3 + Math.random() * 0.1 : 0;
      const l = wobble(0);
      const r = wobble(1);
      sim.emit({ kind: 'meters', data: { input: [l, r], output: [Math.min(0.94, l + carts * 0.6), Math.min(0.94, r + carts * 0.6)], carts, limiterDb: l > 0.85 ? -1.5 : 0 } });
      if (playing.length || t % 10 === 0) sim.emit({ kind: 'carts', data: sim.carts.map(({ started: _s, ...c }) => c) });
      if (sim.broadcast.state === 'live') {
        sim.broadcast = { ...sim.broadcast, bytes: sim.broadcast.bytes + 640 };
        if (t % 25 === 0) sim.emit({ kind: 'broadcast', data: sim.broadcast });
      }
    }, 40);
  },
  setBroadcast(b: BroadcastStatus) {
    sim.broadcast = b;
    sim.emit({ kind: 'broadcast', data: b });
  },
};

const simDevices: Devices = {
  hosts: ['WASAPI', 'ASIO'],
  inputs: [
    { host: 'WASAPI', name: 'Line In (Behringer UMC404HD)', channels: 4, isDefault: true },
    { host: 'WASAPI', name: 'Microphone (USB Audio)', channels: 2, isDefault: false },
    { host: 'ASIO', name: 'Focusrite USB ASIO', channels: 8, isDefault: false },
  ],
  outputs: [
    { host: 'WASAPI', name: 'Speakers (Realtek Audio)', channels: 2, isDefault: true },
    { host: 'WASAPI', name: 'Line Out (Behringer UMC404HD)', channels: 4, isDefault: false },
  ],
};

function simPreview(): PreviewState {
  const { at, ...p } = sim.preview;
  if (!p.loaded) return p;
  const position = p.playing ? Math.min(p.duration, p.position + (Date.now() - at) / 1000) : p.position;
  const ended = position >= p.duration;
  return { ...p, position, ended, playing: p.playing && !ended };
}

async function simInvoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  sim.start();
  const engineInfo = (): EngineInfo => ({
    sampleRate: 48000,
    input: sim.config?.input?.device ?? null,
    output: sim.config?.output?.device ?? null,
    inputRate: sim.config?.input ? 48000 : null,
    outputRate: sim.config?.output ? 48000 : null,
    error: null,
  });
  switch (cmd) {
    case 'app_info':
      return { version: '0.13.0', os: 'windows', arch: 'x86_64', hostname: 'STUDIO-1', asio: true } as T;
    case 'list_devices':
      return simDevices as T;
    case 'configure_audio':
      sim.config = args.config as AudioConfig;
      sim.emit({ kind: 'engine', data: engineInfo() });
      return engineInfo() as T;
    case 'engine_info':
      return engineInfo() as T;
    case 'load_cart': {
      const c = sim.carts[args.slot as number]!;
      Object.assign(c, { loaded: true, duration: 3 + ((args.slot as number) % 5) * 2.5 });
      sim.emit({ kind: 'carts', data: sim.carts });
      return undefined as T;
    }
    case 'clear_cart':
      Object.assign(sim.carts[args.slot as number]!, { loaded: false, playing: false });
      sim.emit({ kind: 'carts', data: sim.carts });
      return undefined as T;
    case 'play_cart': {
      const c = sim.carts[args.slot as number]!;
      if (c.loaded) Object.assign(c, c.playing ? { playing: false, position: 0 } : { playing: true, started: Date.now(), position: 0 });
      return undefined as T;
    }
    case 'stop_cart':
      Object.assign(sim.carts[args.slot as number]!, { playing: false, position: 0 });
      return undefined as T;
    case 'cache_file':
      return `C:\\Cache\\${args.name as string}` as T;
    case 'stop_all_carts':
      sim.carts.forEach((c) => Object.assign(c, { playing: false, position: 0 }));
      return undefined as T;
    case 'start_broadcast':
      sim.setBroadcast({ state: 'connecting', attempt: 1 });
      setTimeout(() => sim.setBroadcast({ state: 'live', since: Date.now(), bytes: 0 }), 900);
      return undefined as T;
    case 'stop_broadcast':
      sim.setBroadcast({ state: 'off' });
      return undefined as T;
    case 'broadcast_status':
      return sim.broadcast as T;
    case 'send_metadata':
      return undefined as T;
    case 'probe_tcp':
      // The simulation reaches a studio network address (10.x, 192.168.x) unless the URL says ?lan=off.
      return (/^(10|192\.168)\./.test(args.host as string) && !location.search.includes('lan=off')) as T;
    case 'secret_get':
      try {
        return (localStorage.getItem(`sim-secret:${args.server as string}`) ?? null) as T;
      } catch {
        return null as T;
      }
    case 'secret_set':
      try {
        localStorage.setItem(`sim-secret:${args.server as string}`, args.key as string);
      } catch {
        /* private mode */
      }
      return undefined as T;
    case 'secret_delete':
      try {
        localStorage.removeItem(`sim-secret:${args.server as string}`);
      } catch {
        /* private mode */
      }
      return undefined as T;
    case 'preview_output':
      sim.previewOutput = (args.output as OutputSel | null)?.device ?? null;
      return undefined as T;
    case 'preview_file':
    case 'preview_url': {
      const name = (args.name as string | undefined) ?? (args.path as string).split('\\').pop()!.replace(/\.[^.]+$/, '');
      Object.assign(sim.preview, { loaded: true, playing: true, ended: false, name, position: 0, duration: 30 + (name.length % 7) * 31, device: sim.previewOutput ?? 'Speakers (Realtek Audio)', at: Date.now() });
      return simPreview() as T;
    }
    case 'cue_open': {
      // A made-up track: a quiet intro, a loud body with beats, a fade at the end.
      const length = 30 + ((args.name as string).length % 7) * 31;
      const perSecond = 50;
      const peaks = Array.from({ length: length * perSecond }, (_, i) => {
        const t = i / perSecond;
        const level = t < 1.2 ? 0 : t < 12 ? 0.35 : t > length - 8 ? 0.85 * ((length - t) / 8) : 0.85;
        const beat = 0.75 + 0.25 * Math.abs(Math.sin(t * Math.PI * 2.4));
        return Math.round(255 * Math.min(1, level * beat * (0.85 + 0.15 * Math.random())));
      });
      Object.assign(sim.preview, { loaded: true, playing: false, ended: false, name: args.name, position: 0, duration: length, device: sim.previewOutput ?? 'Speakers (Realtek Audio)', at: Date.now() });
      return { waveform: { perSecond, duration: length, peaks }, preview: simPreview() } as T;
    }
    case 'preview_toggle': {
      const p = simPreview();
      Object.assign(sim.preview, p.ended ? { playing: true, ended: false, position: 0, at: Date.now() } : { playing: !p.playing, position: p.position, at: Date.now() });
      return simPreview() as T;
    }
    case 'preview_seek':
      Object.assign(sim.preview, { position: Math.min(args.seconds as number, sim.preview.duration), at: Date.now() });
      return simPreview() as T;
    case 'preview_stop':
      Object.assign(sim.preview, { loaded: false, playing: false, position: 0 });
      return undefined as T;
    case 'preview_state':
      return simPreview() as T;
    case 'list_folder': {
      const path = (args.path as string | null) ?? null;
      if (!path) return { path: null, parent: null, entries: ['C:\\', 'E:\\'].map((d) => ({ name: d.slice(0, 2), path: d, dir: true, size: 0 })) } as T;
      const entries = simFolders[path];
      if (!entries) throw new Error(`cannot open ${path}`);
      return { path, parent: simParent(path), entries } as T;
    }
    case 'upload_file':
      await new Promise((r) => setTimeout(r, 900));
      return { saved: [`music/${(args.path as string).split('\\').pop()}`], skipped: [] } as T;
    case 'install_update':
      throw new Error('Updates can only be installed in the Windows app');
    default:
      throw new Error(`unknown command ${cmd}`);
  }
}

export function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return inTauri ? invoke<T>(cmd, args) : simInvoke<T>(cmd, args);
}

export function onEngine(cb: (e: EngineEvent) => void): () => void {
  if (!inTauri) {
    sim.start();
    sim.listeners.add(cb);
    return () => sim.listeners.delete(cb);
  }
  let un: UnlistenFn | null = null;
  let gone = false;
  void listen<EngineEvent>('engine', (e) => cb(e.payload)).then((u) => (gone ? u() : (un = u)));
  return () => {
    gone = true;
    un?.();
  };
}

export async function onUpdateProgress(cb: (p: { received: number; total: number | null }) => void): Promise<() => void> {
  if (!inTauri) return () => {};
  return listen<{ received: number; total: number | null }>('update-progress', (e) => cb(e.payload));
}

export async function openExternal(url: string) {
  if (!inTauri) {
    window.open(url, '_blank', 'noopener');
    return;
  }
  const { openUrl } = await import('@tauri-apps/plugin-opener');
  await openUrl(url);
}

export async function pickAudioFile(title: string): Promise<string | null> {
  if (!inTauri) return 'C:\\Jingles\\station-id.mp3';
  const { open } = await import('@tauri-apps/plugin-dialog');
  const res = await open({ title, multiple: false, directory: false, filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac'] }] });
  return typeof res === 'string' ? res : null;
}

/** fetch() that is not bound by the browser's CORS rules in the app (requests go out from Rust). */
export async function httpFetch(input: string, init?: RequestInit): Promise<Response> {
  if (!inTauri) return fetch(input, init);
  const { fetch: tauriFetch } = await import('@tauri-apps/plugin-http');
  return tauriFetch(input, init);
}
