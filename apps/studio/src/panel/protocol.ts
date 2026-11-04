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
}

/** Levels 0..1 on the meter scale, about ten times a second. */
export interface PanelMeters {
  t: 'meters';
  music: number;
  mic: number;
  air: number;
}

export type PanelCommand = { cmd: 'mic' } | { cmd: 'next' } | { cmd: 'stop' } | { cmd: 'fader'; channel: 0 | 1 | 2 };

export type PanelMessage = PanelState | PanelMeters | { t: 'hello'; tablet: { id: string; name: string } } | { t: 'ping' };
