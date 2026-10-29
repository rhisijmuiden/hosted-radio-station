import { useSyncExternalStore } from 'react';
import type { LinkMode, ManualLink } from './link';
import type { StudioLayout } from './layout';
import type { AudioConfig, OutputSel } from './native';

export interface CartSlot {
  label: string;
  path: string;
  color: string;
  looped: boolean;
}

export interface Settings {
  /** e.g. https://radio.example.com */
  server: string;
  stationId: string | null;
  channel: 'production' | 'test';
  audio: AudioConfig;
  /**
   * plainHosts: encoder addresses where the DJ chose to connect without TLS (their certificate is not trusted).
   * link: how Go Live reaches a station node (see lib/link.ts); manual: the address for link 'manual'.
   */
  live: { accountId: string | null; mountId: string | null; bitrate: number; title: string; plainHosts: string[]; link: LinkMode; manual: ManualLink };
  carts: (CartSlot | null)[];
  cartPage: number;
  /** Pre-listen, off air: its own sound card output (null = the Windows default). */
  preview: { output: OutputSel | null };
  /** Network shares in the library panel, e.g. \\\\nas\\muziek. */
  shares: string[];
  /** The layout of Assist; the DJ profile on the server has the say when it has one (see lib/layout.ts). */
  layout: Partial<StudioLayout> | null;
  /** The list of the single player of the OmniPlayer layout; it plays on this PC. */
  single: { items: SingleItem[]; auto: boolean };
  /** The news player of the OmniPlayer layout starts the bulletin at the news time while live. */
  news: { auto: boolean };
}

/** A track in the single player: a file of this PC (or a share), or a track of the station library. */
export interface SingleItem {
  id: string;
  title: string;
  path?: string;
  mediaId?: string;
  ext: string;
}

const KEY = 'rhis-studio-settings';

const defaults: Settings = {
  server: '',
  stationId: null,
  channel: 'production',
  audio: { input: null, output: null, inputGainDb: 0, cartGainDb: 0, cartsToStream: true, cartsToOutput: true, monitorInput: false, duckSingle: true },
  live: { accountId: null, mountId: null, bitrate: 192, title: '', plainHosts: [], link: 'auto', manual: { host: '', port: 8010, tls: false } },
  carts: Array.from({ length: 48 }, () => null),
  cartPage: 0,
  preview: { output: null },
  shares: [],
  layout: null,
  single: { items: [], auto: false },
  news: { auto: true },
};

function load(): Settings {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Settings>;
    return { ...defaults, ...raw, audio: { ...defaults.audio, ...raw.audio }, live: { ...defaults.live, ...raw.live }, preview: { ...defaults.preview, ...raw.preview }, shares: Array.isArray(raw.shares) ? raw.shares : [], layout: raw.layout && typeof raw.layout === 'object' ? raw.layout : null, single: { items: Array.isArray(raw.single?.items) ? raw.single.items : [], auto: !!raw.single?.auto }, news: { auto: raw.news?.auto !== false }, carts: raw.carts?.length === 48 ? raw.carts : defaults.carts };
  } catch {
    return defaults;
  }
}

let current = load();
const listeners = new Set<() => void>();

export function getSettings() {
  return current;
}

export function updateSettings(patch: Partial<Settings> | ((s: Settings) => Partial<Settings>)) {
  current = { ...current, ...(typeof patch === 'function' ? patch(current) : patch) };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* private mode */
  }
  listeners.forEach((l) => l());
}

export function useSettings(): Settings {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}

/** "radio.example.com" → "https://radio.example.com"; keeps http:// for LAN servers. */
export function normalizeServer(input: string) {
  let s = input.trim().replace(/\/+$/, '');
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  return s.replace(/\/api$/, '');
}
