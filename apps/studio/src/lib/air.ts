import { useSyncExternalStore } from 'react';
import type { StationDetail } from './api';
import { call, type OutputSel } from './native';
import { getSettings, updateSettings } from './settings';

/**
 * Listening to the air (small fix i): the station's public stream, as listeners hear it, on its own sound card output
 * and volume, while this PC is not live. Never while the DJ broadcasts or studio mode runs: the delayed stream would
 * come back over their own microphone.
 */
export interface AirState {
  on: boolean;
  playing: boolean;
  device: string | null;
  error: string | null;
}

const OFF: AirState = { on: false, playing: false, device: null, error: null };
let state: AirState = OFF;
let url: string | null = null;
let poll: ReturnType<typeof setInterval> | null = null;
const subs = new Set<() => void>();

function set(next: AirState) {
  state = next;
  subs.forEach((l) => l());
}

export function useAir(): AirState {
  return useSyncExternalStore(
    (l) => {
      subs.add(l);
      return () => subs.delete(l);
    },
    () => state,
  );
}

/**
 * The address this PC listens on: the listen route of the server it is linked to (it sends the PC on to the nearest
 * relay, like any listener), for the default public mount of the station.
 */
export function airUrl(detail: StationDetail | undefined, server: string): string | null {
  if (!detail || !server) return null;
  const pub = detail.connection.mounts.filter((m) => m.listenUrl);
  const def = detail.mounts.find((m) => m.isDefault);
  const mount = pub.find((m) => m.id === def?.id) ?? pub[0];
  if (!mount?.listenUrl) return null;
  try {
    const u = new URL(mount.listenUrl);
    return `${server.replace(/\/+$/, '')}${u.pathname}`;
  } catch {
    return null;
  }
}

export async function startAir(to: string) {
  url = to;
  const { output, volume } = getSettings().air;
  try {
    set((await call<AirState>('air_start', { url: to, output, volume })) ?? OFF);
  } catch (err) {
    url = null;
    set({ ...OFF, error: String(err) });
    return;
  }
  if (!poll) poll = setInterval(() => void call<AirState>('air_state').then((s) => url && s && set(s)).catch(() => undefined), 1000);
}

export function stopAir() {
  url = null;
  if (poll) clearInterval(poll);
  poll = null;
  if (state.on) void call('air_stop').catch(() => undefined);
  set(OFF);
}

/** The address it plays now, or null. */
export const airPlaying = () => url;

export function setAirVolume(volume: number) {
  updateSettings((s) => ({ air: { ...s.air, volume } }));
  if (state.on) void call('air_volume', { volume }).catch(() => undefined);
}

export async function applyAirOutput(output: OutputSel | null) {
  updateSettings((s) => ({ air: { ...s.air, output } }));
  if (!state.on) return;
  try {
    set(await call<AirState>('air_output', { output }));
  } catch (err) {
    set({ ...state, error: String(err) });
  }
}
