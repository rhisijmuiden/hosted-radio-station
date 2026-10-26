import { useSyncExternalStore } from 'react';
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
  live: { accountId: string | null; mountId: string | null; bitrate: number; title: string };
  carts: (CartSlot | null)[];
  cartPage: number;
  /** Pre-listen, off air: its own sound card output (null = the Windows default). */
  preview: { output: OutputSel | null };
  /** Network shares in the library panel, e.g. \\\\nas\\muziek. */
  shares: string[];
}

const KEY = 'rhis-studio-settings';

const defaults: Settings = {
  server: '',
  stationId: null,
  channel: 'production',
  audio: { input: null, output: null, inputGainDb: 0, cartGainDb: 0, cartsToStream: true, cartsToOutput: true, monitorInput: false },
  live: { accountId: null, mountId: null, bitrate: 192, title: '' },
  carts: Array.from({ length: 48 }, () => null),
  cartPage: 0,
  preview: { output: null },
  shares: [],
};

function load(): Settings {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Settings>;
    return { ...defaults, ...raw, audio: { ...defaults.audio, ...raw.audio }, live: { ...defaults.live, ...raw.live }, preview: { ...defaults.preview, ...raw.preview }, shares: Array.isArray(raw.shares) ? raw.shares : [], carts: raw.carts?.length === 48 ? raw.carts : defaults.carts };
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
