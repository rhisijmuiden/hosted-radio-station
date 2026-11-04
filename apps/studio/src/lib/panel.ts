import { useEffect, useSyncExternalStore } from 'react';
import { api, ApiError, getApiKey } from './api';
import { call, inTauri, onPanel, type PanelEvent, type PanelStatus } from './native';
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

// https for the tablets (step 4): a host name for this PC under the platform domain that points at its address on the
// studio network, and a Let's Encrypt certificate for it. Studio fetches the certificate itself (src-tauri/src/
// panel_tls.rs); the server sets the DNS records. Without Cloudflare DNS on the server the panel simply stays on http.

/** Let's Encrypt certificates last 90 days; renewed after 60. */
const RENEW_AFTER = 60 * 86_400_000;
/** After a failure: Let's Encrypt allows only a few failed tries per hour for one name. */
const RETRY_AFTER = 60 * 60_000;
/** The address record is checked again this often (and whenever the address of this PC changes). */
const RECHECK = 6 * 60 * 60_000;

export interface PanelTls {
  busy: boolean;
  /** Why the last try failed. */
  error: string | null;
  /** The server cannot give this PC a name: no Cloudflare DNS there (or an older server). */
  unavailable: boolean;
}
let tls: PanelTls = { busy: false, error: null, unavailable: false };
const tlsListeners = new Set<() => void>();
function setTls(next: Partial<PanelTls>) {
  tls = { ...tls, ...next };
  tlsListeners.forEach((l) => l());
}
export function usePanelTls(): PanelTls {
  return useSyncExternalStore(
    (l) => {
      tlsListeners.add(l);
      return () => tlsListeners.delete(l);
    },
    () => tls,
  );
}

let lastTry = { at: 0, address: '', failed: false };

/**
 * Makes sure the panel host name points at this PC and the certificate is there and fresh. `force`: now, also right
 * after a failure (the button in the settings).
 */
export async function ensurePanelTls(server: string, force = false) {
  const token = getApiKey();
  if (!inTauri || tls.busy || !token || !server || !status?.running || !status.address) return;
  const now = Date.now();
  const address = status.address;
  const due = status.tlsIssuedAt == null || now - status.tlsIssuedAt > RENEW_AFTER;
  if (!force && address === lastTry.address && now - lastTry.at < (lastTry.failed ? RETRY_AFTER : RECHECK) && !(due && !lastTry.failed)) return;
  lastTry = { at: now, address, failed: false };
  setTls({ busy: true });
  try {
    const { host } = await api<{ host: string }>('/studio/panel-host', { method: 'POST', body: { address } });
    if (due || status.tlsHost !== host) setStatus(await call<PanelStatus>('panel_tls_issue', { host, server, token }));
    setTls({ busy: false, error: null, unavailable: false });
  } catch (err) {
    lastTry.failed = true;
    // 409: no Cloudflare DNS on the server; 404: a server from before this feature.
    if (err instanceof ApiError && (err.status === 409 || err.status === 404)) setTls({ busy: false, error: null, unavailable: true });
    else setTls({ busy: false, error: err instanceof Error ? err.message : String(err) });
  }
}

/** Keeps https of the panel going while it runs: at start, when the address changes and every few hours. */
export function usePanelTlsKeeper(server: string | null, supported: boolean) {
  const s = usePanel();
  const running = !!s?.running;
  const address = s?.address ?? null;
  useEffect(() => {
    if (!server || !supported || !running || !address) return;
    void ensurePanelTls(server);
    const id = setInterval(() => void ensurePanelTls(server), 15 * 60_000);
    return () => clearInterval(id);
  }, [server, supported, running, address]);
}
