import { useSyncExternalStore } from 'react';
import { demoMeters, demoState, runDemoCommand } from './demo';
import type { PanelCommand, PanelMessage, PanelMeters, PanelState } from './protocol';

/**
 * The tablet's side of the connection with RHIS Studio: pairing (once, with a code), then a WebSocket that reconnects
 * by itself. The PC sends its state a few times a second; the tablet only sends commands.
 */

const TOKEN_KEY = 'rhis-panel-token';

/** In the browser without RHIS Studio (`pnpm dev`, `?demo`): a pretend studio for trying out and screenshots. */
const query = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
export const demo = query.has('demo') || (typeof location !== 'undefined' && location.port === '5174' && !query.has('nodemo'));

/**
 * Coming over from the http address (see upgrade below): the token travels in the hash, is kept for this https address
 * and taken out of the address bar at once.
 */
if (typeof location !== 'undefined' && location.hash.startsWith('#token=')) {
  const handed = decodeURIComponent(location.hash.slice('#token='.length));
  try {
    if (handed) localStorage.setItem(TOKEN_KEY, handed);
  } catch {
    /* private mode */
  }
  history.replaceState(null, '', location.pathname + location.search);
}

export type Link = 'unpaired' | 'connecting' | 'online' | 'offline' | 'revoked';

interface Store {
  link: Link;
  state: PanelState | null;
  /** When the state came in (this tablet's clock), to count on between updates. */
  receivedAt: number;
  /** The PC's clock less this tablet's clock (ms). */
  offset: number;
  tablet: { id: string; name: string } | null;
}

let store: Store = { link: demo ? 'online' : token() ? 'connecting' : 'unpaired', state: null, receivedAt: 0, offset: 0, tablet: null };
const listeners = new Set<() => void>();
const meterListeners = new Set<(m: PanelMeters) => void>();
function set(patch: Partial<Store>) {
  store = { ...store, ...patch };
  listeners.forEach((l) => l());
}

export function usePanelStore<T>(select: (s: Store) => T): T {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => select(store),
  );
}
export const panelStore = () => store;

export function onMeters(cb: (m: PanelMeters) => void) {
  meterListeners.add(cb);
  return () => {
    meterListeners.delete(cb);
  };
}

function token(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function setToken(value: string | null) {
  try {
    if (value) localStorage.setItem(TOKEN_KEY, value);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* private mode: paired for this visit only */
  }
}

/** Pairs this tablet with the code from RHIS Studio. Throws 'wrong', 'expired' or the error. */
export async function pair(code: string, name: string) {
  const res = await fetch('/api/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: code.trim(), name }) });
  if (res.status === 403) throw new Error('wrong');
  if (res.status === 410) throw new Error('expired');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { id: string; token: string };
  setToken(body.token);
  set({ link: 'connecting' });
  connect();
}

/** Forgets the pairing on this tablet (RHIS Studio still lists it until it is removed there). */
export function forget() {
  setToken(null);
  socket?.close();
  socket = null;
  set({ link: 'unpaired', state: null, tablet: null });
}

let socket: WebSocket | null = null;
let retry: ReturnType<typeof setTimeout> | null = null;
let watchdog: ReturnType<typeof setInterval> | null = null;
let attempt = 0;
let lastHeard = 0;

function handle(msg: PanelMessage) {
  lastHeard = Date.now();
  switch (msg.t) {
    case 'hello':
      set({ tablet: msg.tablet, link: 'online' });
      if (msg.https) void upgrade(msg.https);
      break;
    case 'state':
      set({ state: msg, receivedAt: Date.now(), offset: msg.now - Date.now(), link: 'online' });
      break;
    case 'meters':
      meterListeners.forEach((l) => l(msg));
      break;
  }
}

let upgrading = false;
/**
 * On the plain http address while the PC also serves https with a valid certificate: move there when this tablet can
 * reach it (a router that refuses private addresses in public DNS keeps the tablet on http, which works just the same).
 * The token goes along in the hash, which never leaves the tablet.
 */
async function upgrade(https: string) {
  if (upgrading || location.protocol !== 'http:') return;
  upgrading = true;
  try {
    const target = new URL(https);
    await fetch(new URL('panel.webmanifest', target), { mode: 'no-cors', cache: 'no-store', signal: AbortSignal.timeout(4000) });
    const tk = token();
    if (!tk) return;
    target.pathname = location.pathname;
    target.search = new URLSearchParams([...new URLSearchParams(location.search)].filter(([k]) => k !== 'pair')).toString();
    target.hash = `token=${encodeURIComponent(tk)}`;
    location.replace(target.toString());
  } catch {
    /* not reachable from here: stay on http */
  }
}

function scheduleRetry() {
  if (retry) return;
  // Quickly at first, then every few seconds: the wifi is usually back soon.
  const wait = Math.min(5000, 500 * 2 ** Math.min(attempt, 4));
  attempt++;
  retry = setTimeout(() => {
    retry = null;
    connect();
  }, wait);
}

/** Opens the connection (or keeps it open); a lost connection is tried again and again. */
export function connect() {
  if (demo) return startDemo();
  const tk = token();
  if (!tk) return set({ link: 'unpaired' });
  if (socket && socket.readyState <= WebSocket.OPEN) return;
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?token=${encodeURIComponent(tk)}`);
  socket = ws;
  let opened = false;
  ws.onopen = () => {
    opened = true;
    attempt = 0;
    lastHeard = Date.now();
  };
  ws.onmessage = (e) => {
    try {
      handle(JSON.parse(String(e.data)) as PanelMessage);
    } catch {
      /* not for us */
    }
  };
  ws.onclose = () => {
    if (socket !== ws) return;
    socket = null;
    if (!token()) return;
    // Never opened: maybe this tablet was removed on the PC; ask before trying on.
    if (!opened) {
      void fetch(`/api/hello?token=${encodeURIComponent(tk)}`)
        .then((r) => {
          if (r.status === 401) {
            setToken(null);
            set({ link: 'revoked', state: null });
          } else {
            set({ link: 'offline' });
            scheduleRetry();
          }
        })
        .catch(() => {
          set({ link: 'offline' });
          scheduleRetry();
        });
      return;
    }
    set({ link: 'offline' });
    scheduleRetry();
  };
  if (!watchdog) {
    // The PC sends at least every few seconds; silence means the wifi is gone even when the socket does not say so.
    watchdog = setInterval(() => {
      if (socket?.readyState === WebSocket.OPEN && Date.now() - lastHeard > 8000) socket.close();
    }, 2000);
  }
}

/** A command for the PC; it does what the studio mode buttons there would do. */
export function send(c: PanelCommand) {
  if (demo) return runDemoCommand(c, (s) => set({ state: s, receivedAt: Date.now(), offset: 0 }));
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ t: 'cmd', ...c }));
}

let demoStarted = false;
function startDemo() {
  if (demoStarted) return;
  demoStarted = true;
  set({ link: 'online', tablet: { id: 'demo', name: 'iPad studio 1' } });
  const push = () => set({ state: demoState(), receivedAt: Date.now(), offset: 0 });
  push();
  setInterval(push, 1000);
  setInterval(() => meterListeners.forEach((l) => l(demoMeters())), 100);
}

// Back from the background (a tablet that slept): reconnect at once instead of waiting for the next try.
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || demo || !token()) return;
    if (retry) {
      clearTimeout(retry);
      retry = null;
    }
    attempt = 0;
    connect();
  });
}
