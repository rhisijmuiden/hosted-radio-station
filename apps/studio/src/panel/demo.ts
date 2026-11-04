import type { PanelCart, PanelCommand, PanelDeck, PanelLogRow, PanelMeters, PanelState } from './protocol';

// A pretend studio for the browser (`pnpm dev`, `?demo`): two players, the microphone and a log with the news, so the
// tablet panel can be tried out and photographed without RHIS Studio. `?demo=off` shows studio mode switched off and
// `?demo=faders` fader start.

const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
const mode = params.get('demo');

const tracks = [
  { title: 'Houdini', artist: 'Dua Lipa', length: 185, intro: 9 },
  { title: 'Espresso', artist: 'Sabrina Carpenter', length: 175, intro: 14 },
  { title: 'Fortnight', artist: 'Taylor Swift', length: 228, intro: 6 },
  { title: 'Beautiful Things', artist: 'Benson Boone', length: 180, intro: 11 },
  { title: 'Training Season', artist: 'Dua Lipa', length: 209, intro: 8 },
];

let started = Date.now() - 67_000;
let index = 0;
let mic = false;
let faders: [number, number, number] = [1, 0, 0];
let airDeck = 0;

const C = ['#FF6B57', '#9CC3FF', '#4ACB8C', '#F2B640', '#B18CFF', '#FF8FC7', '#5ED3D1', '#A3AEC4'];
const mk = (slot: number, label: string, duration: number, color: string, looped = false): PanelCart => ({ slot, label, color, looped, loaded: true, playing: false, startedAt: null, duration });
const own = [['ID short', 4], ['Sweeper', 6], ['Bumper', 3], ['Weather', 5], ['Traffic', 4], ['Applause', 7], ['Horn', 2], ['Drum roll', 5], ['Festival ID', 8], ['Crowd', 10]].map(([l, d], i) => mk(48 + i, l as string, d as number, C[i % C.length]!));
const station = [['Station ID', 6], ['News intro', 9], ['News outro', 5], ['Ad in', 3], ['Ad out', 3], ['Weekend promo', 22], ['Bed 1', 90], ['Bed 2', 120]].map(([l, d], i) => mk(96 + i, l as string, d as number, i < 3 ? '#9CC3FF' : C[(i + 3) % C.length]!, i >= 6));
const wall = [['Laser', 1], ['Stinger', 2], ['Countdown', 10], ['Outro', 12]].map(([l, d], i) => mk(i, l as string, d as number, C[(i + 5) % C.length]!));
const playing = new Map<number, number>([[49, Date.now() - 2000]]);
function carts() {
  const now = Date.now();
  const live = (c: PanelCart): PanelCart => {
    const at = playing.get(c.slot);
    if (at != null && (now - at) / 1000 >= c.duration && !c.looped) playing.delete(c.slot);
    const p = playing.get(c.slot);
    return p != null ? { ...c, playing: true, startedAt: p } : c;
  };
  return { own: own.map(live), station: station.map(live), wall: wall.map(live) };
}

const track = (i: number) => tracks[i % tracks.length]!;

function deck(i: number): PanelDeck {
  const onAir = i === airDeck;
  const tr = track(onAir ? index : index + 1);
  const position = onAir ? (Date.now() - started) / 1000 : 0;
  return { title: tr.title, artist: tr.artist, role: onAir ? 'air' : 'next', ready: true, playing: onAir, locked: false, position, start: 0, end: tr.length, intro: tr.intro, length: tr.length };
}

export function demoState(): PanelState {
  const now = Date.now();
  if ((now - started) / 1000 >= track(index).length) next();
  const log: PanelLogRow[] = [];
  let at = started;
  for (let n = 0; n < 4; n++) {
    const tr = track(index + n);
    log.push({ id: `t${index + n}`, at, title: tr.title, artist: tr.artist, kind: 'music', locked: false, role: n === 0 ? 'air' : n === 1 ? 'next' : 'queued' });
    at += tr.length * 1000;
  }
  const top = new Date(at);
  top.setMinutes(top.getMinutes() < 30 ? 30 : 60, 0, 0);
  log.splice(3, 0, { id: 'jingle', at: log[3]!.at, title: 'Jingle', artist: 'Station ID', kind: 'item', locked: false, role: 'queued' });
  log.push({ id: 'news', at: top.getTime(), title: 'News', artist: 'ANP', kind: 'news', locked: true, role: 'queued' });
  const on = mode !== 'off';
  return {
    t: 'state',
    now,
    pc: 'STUDIO-1',
    station: 'Radio Schermer',
    user: 'Reinder',
    phase: on ? 'on' : 'off',
    available: true,
    mic,
    micAutoOff: false,
    manual: false,
    faderStart: mode === 'faders',
    faders,
    decks: [deck(0), deck(1)].map((d, i) => (on ? d : { ...d, role: 'empty' as const, title: '', artist: '', playing: false, position: 0, length: null, intro: null, ready: false, locked: false })) as [PanelDeck, PanelDeck],
    canNext: on,
    log: on ? log : [],
    nextBlock: { at: top.getTime(), label: 'News', locked: true, hard: true },
    error: null,
    carts: carts(),
  };
}

function next() {
  index++;
  airDeck = 1 - airDeck;
  started = Date.now();
  faders = [airDeck === 0 ? 1 : 0, airDeck === 1 ? 1 : 0, faders[2]];
}

export function runDemoCommand(c: PanelCommand, push: (s: PanelState) => void) {
  if (c.cmd === 'cart') {
    if (playing.has(c.slot)) playing.delete(c.slot);
    else playing.set(c.slot, Date.now());
  } else if (c.cmd === 'stopCarts') playing.clear();
  else if (c.cmd === 'mic') {
    mic = !mic;
    faders[2] = mic ? 1 : 0;
  } else if (c.cmd === 'next') next();
  else if (c.cmd === 'fader') {
    if (c.channel === 2) {
      mic = !mic;
      faders[2] = mic ? 1 : 0;
    } else if (c.channel !== airDeck) next();
  }
  push(demoState());
}

let phase = 0;
export function demoMeters(): PanelMeters {
  phase += 0.35;
  const music = mode === 'off' ? 0 : (mic ? 0.45 : 0.68) + 0.18 * Math.abs(Math.sin(phase)) * Math.random();
  const voice = mic ? 0.55 + 0.3 * Math.random() : 0.04;
  return { t: 'meters', music, mic: voice, air: Math.max(music, voice) * (0.9 + 0.1 * Math.random()) };
}
