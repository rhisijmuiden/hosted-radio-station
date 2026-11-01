import { useEffect, useSyncExternalStore } from 'react';
import { call, onEngine, type BroadcastStatus, type CartState, type DeckEvent, type DeckState, type EngineInfo, type Meters } from './native';

interface EngineState {
  meters: Meters;
  carts: CartState[];
  broadcast: BroadcastStatus;
  info: EngineInfo | null;
  cartErrors: Record<number, string>;
  /** Studio mode: players A and B. */
  decks: DeckState[];
}

let state: EngineState = {
  meters: { input: [0, 0], output: [0, 0], carts: 0, limiterDb: 0 },
  carts: [],
  broadcast: { state: 'off' },
  info: null,
  cartErrors: {},
  decks: [],
};
const listeners = new Set<() => void>();
const meterListeners = new Set<(m: Meters) => void>();
const deckListeners = new Set<(e: DeckEvent) => void>();
const deckStateListeners = new Set<(d: DeckState[]) => void>();
let started = false;

function set(patch: Partial<EngineState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

/** Subscribes once to the Rust engine; meters go to their own listeners so they do not re-render the whole app. */
export function startEngineEvents() {
  if (started) return;
  started = true;
  onEngine((e) => {
    switch (e.kind) {
      case 'meters':
        state.meters = e.data;
        meterListeners.forEach((l) => l(e.data));
        break;
      case 'carts':
        set({ carts: e.data });
        break;
      case 'broadcast':
        set({ broadcast: e.data });
        break;
      case 'engine':
        set({ info: e.data });
        break;
      case 'cartError':
        set({ cartErrors: { ...state.cartErrors, [e.data.slot]: e.data.error } });
        break;
      case 'decks':
        set({ decks: e.data });
        deckStateListeners.forEach((l) => l(e.data));
        break;
      case 'deck':
        deckListeners.forEach((l) => l(e.data));
        break;
    }
  });
  void call<BroadcastStatus>('broadcast_status').then((b) => set({ broadcast: b }));
  void call<EngineInfo>('engine_info').then((info) => set({ info }));
}

export function useEngine<T>(select: (s: EngineState) => T): T {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => select(state),
  );
}

export function clearCartError(slot: number) {
  const { [slot]: _gone, ...rest } = state.cartErrors;
  set({ cartErrors: rest });
}

/** Calls `cb` with every meter update (about 25 per second). */
export function useMeters(cb: (m: Meters) => void) {
  useEffect(() => {
    meterListeners.add(cb);
    return () => {
      meterListeners.delete(cb);
    };
  }, [cb]);
}

/** The engine state now, outside React (studio mode). */
export const engineState = () => state;

/** Studio mode: what happens on the players (started, next point, ended), and their state. */
export function onDeck(cb: (e: DeckEvent) => void, states?: (d: DeckState[]) => void) {
  startEngineEvents();
  deckListeners.add(cb);
  if (states) deckStateListeners.add(states);
  return () => {
    deckListeners.delete(cb);
    if (states) deckStateListeners.delete(states);
  };
}
