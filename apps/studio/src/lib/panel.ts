import { useEffect, useSyncExternalStore } from 'react';
import { call, onPanel, type PanelEvent, type PanelStatus } from './native';
import { getSettings, updateSettings } from './settings';
import { studio, studioView } from './studio';
import { engineState } from './engine';
import type { PanelCommand } from '../panel/protocol';

/**
 * The tablet panel on this PC (server side in src-tauri/src/panel.rs): on or off, the paired tablets, and what to do
 * with a command from a tablet. RHIS Studio stays in charge: a tablet can do what the DJ can do with the studio mode
 * buttons, nothing more, and only while studio mode runs here.
 */

let status: PanelStatus | null = null;
const listeners = new Set<() => void>();
function setStatus(s: PanelStatus) {
  status = s;
  listeners.forEach((l) => l());
}

export function usePanel(): PanelStatus | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => status,
  );
}

export async function refreshPanel() {
  setStatus(await call<PanelStatus>('panel_status'));
}

/** Switches the panel on (on the port of the settings) or off, and keeps that choice. */
export async function setPanelEnabled(enabled: boolean, port = getSettings().panel.port) {
  updateSettings((s) => ({ panel: { ...s.panel, enabled, port } }));
  try {
    setStatus(await call<PanelStatus>(enabled ? 'panel_start' : 'panel_stop', enabled ? { port } : {}));
  } catch (err) {
    await refreshPanel();
    throw err;
  }
}

export async function revokeTablet(id: string) {
  setStatus(await call<PanelStatus>('panel_revoke', { id }));
}

/** The jingle and cart slots the tablets can see (and so may play); kept by the panel bridge. */
let cartSlots = new Set<number>();
export function setPanelCartSlots(slots: Set<number>) {
  cartSlots = slots;
}

/**
 * A command from a tablet, checked against what the buttons on this PC allow right now. Jingles and carts work as on
 * the PC, also outside studio mode; the players and the microphone only in studio mode.
 */
export function runCommand(c: PanelCommand) {
  if (c.cmd === 'cart') {
    if (typeof c.slot === 'number' && cartSlots.has(c.slot)) void call('play_cart', { slot: c.slot });
    return;
  }
  if (c.cmd === 'stopCarts') {
    for (const st of engineState().carts) if (st.playing && cartSlots.has(st.slot)) void call('stop_cart', { slot: st.slot });
    return;
  }
  const v = studioView();
  if (v.phase !== 'on') return;
  const air = v.air != null ? v.tracks[v.air] : null;
  switch (c.cmd) {
    case 'mic':
      return studio.mic();
    case 'next':
      // A locked item of the hour clock on air: only on the PC itself (managers are asked there).
      if (air?.locked && engineState().decks[v.air!]?.playing) return;
      return studio.next();
    case 'stop':
      if (v.manual || v.faderStart) studio.stopTrack();
      return;
    case 'fader':
      if (v.faderStart && [0, 1, 2].includes(c.channel)) studio.toggleFader(c.channel);
      return;
  }
}

function isCommand(cmd: Record<string, unknown>): cmd is PanelCommand {
  return typeof cmd.cmd === 'string';
}

let started = false;
/** At start-up: the panel comes back on when it was on, and commands from tablets are carried out. */
export function startPanel() {
  if (started) return;
  started = true;
  onPanel((e: PanelEvent) => {
    if (e.kind === 'command' && isCommand(e.cmd)) runCommand(e.cmd);
    else if (e.kind === 'tablets') void refreshPanel();
  });
  const { enabled, port } = getSettings().panel;
  if (enabled) void call<PanelStatus>('panel_start', { port }).then(setStatus, () => void refreshPanel());
  else void refreshPanel().catch(() => undefined);
}

/** Keeps the list of tablets fresh while it is on screen (connected, last seen). */
export function usePanelPolling() {
  useEffect(() => {
    void refreshPanel().catch(() => undefined);
    const id = setInterval(() => void refreshPanel().catch(() => undefined), 5000);
    return () => clearInterval(id);
  }, []);
}
