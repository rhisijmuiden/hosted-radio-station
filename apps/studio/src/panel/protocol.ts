// What RHIS Studio and the tablet panel say to each other over the WebSocket of the panel server (src-tauri/src/panel.rs).
// The PC publishes its state; the tablet only sends commands, which the PC checks and carries out.

export type PanelPhase = 'off' | 'preparing' | 'waiting' | 'on' | 'stopping' | 'lost';

/** Player A or B as the PC has it. Times are seconds in the file, as the deck counts them. */
export interface PanelDeck {
  title: string;
  artist: string;
  /** On air, next (loaded behind the one on air) or empty. */
  role: 'air' | 'next' | 'empty';
  ready: boolean;
  playing: boolean;
  locked: boolean;
  position: number;
  start: number;
  end: number;
  /** Where the intro ends (seconds in the file), when the track has one. */
  intro: number | null;
  /** Length of the track that waits, in seconds. */
  length: number | null;
}

/** One line of the log: a track of the queue or a fixed block of the hour clock. */
export interface PanelLogRow {
  id: string;
  /** When it starts (PC clock, epoch ms). */
  at: number;
  title: string;
  artist: string;
  kind: 'music' | 'item' | 'news' | 'block';
  locked: boolean;
  role: 'air' | 'next' | 'queued';
}

/** A jingle or cart button; it plays on the PC (into the broadcast like the cart wall there). */
export interface PanelCart {
  /** The engine slot: what the tablet sends back to play or stop it. */
  slot: number;
  label: string;
  color: string;
  looped: boolean;
  loaded: boolean;
  playing: boolean;
  /** While it plays: when it started (PC clock, epoch ms), so the tablet counts down by itself. */
  startedAt: number | null;
  duration: number;
}

/** The button groups of the Jingles tab: the DJ's own jingles, the station's carts, the cart wall of the PC. */
export interface PanelCarts {
  own: PanelCart[];
  station: PanelCart[] | null;
  wall: PanelCart[];
}

export interface PanelState {
  t: 'state';
  /** The PC's clock when it sent this (epoch ms), so the tablet counts with the PC's time. */
  now: number;
  pc: string;
  station: string | null;
  user: string | null;
  phase: PanelPhase;
  /** Studio mode can be used for the station chosen on the PC. */
  available: boolean;
  mic: boolean;
  micAutoOff: boolean;
  manual: boolean;
  faderStart: boolean;
  faders: [number, number, number];
  decks: [PanelDeck, PanelDeck];
  /** Next works now: a track is ready behind the one on air (and no locked item is on air). */
  canNext: boolean;
  log: PanelLogRow[];
  nextBlock: { at: number; label: string; locked: boolean; hard: boolean } | null;
  error: string | null;
  /** RHIS Studio 0.33 and later. */
  carts?: PanelCarts;
}

/** Levels 0..1 on the meter scale, about ten times a second. */
export interface PanelMeters {
  t: 'meters';
  music: number;
  mic: number;
  air: number;
}

export type PanelCommand =
  | { cmd: 'mic' }
  | { cmd: 'next' }
  | { cmd: 'stop' }
  | { cmd: 'fader'; channel: 0 | 1 | 2 }
  /** Plays a jingle or cart, or stops it while it plays. */
  | { cmd: 'cart'; slot: number }
  /** Stops every jingle and cart that plays. */
  | { cmd: 'stopCarts' };

export type PanelMessage = PanelState | PanelMeters | { t: 'hello'; tablet: { id: string; name: string } } | { t: 'ping' };
