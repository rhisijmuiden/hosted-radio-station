import { useSyncExternalStore } from 'react';
import { api, ApiError, getApiKey, type Account, type AutoDj, type Me, type QueueRow, type StationDetail, type StationListItem } from './api';
import { engineState, onDeck } from './engine';
import { liveChoice, sendTitle, startLive, stopLive } from './golive';
import { call, type AppInfo, type BroadcastStatus, type DeckLoad, type DeckState } from './native';
import { getSettings } from './settings';
import { playLength } from './cues';
import { queueOf } from './queue';

/**
 * Studio mode (server feature `studio-mode`): RHIS Studio becomes the station's player. It asks the server for every
 * next track of the queue (the hour clock and locked items included), plays it on players A and B with the server's cue
 * points and crossfade, mixes the microphone and the jingles in and sends that mix live. Every track it starts is
 * reported, so the log stays the server's. Studio mode is renewed every few seconds while the broadcast is up; when this
 * PC stops (closed, crashed, connection gone) the server's AutoDJ takes over at the next track after 10 seconds.
 */

export type StudioPhase = 'off' | 'preparing' | 'waiting' | 'on' | 'stopping' | 'lost';

/** A track from the queue on one of the players. */
export type StudioTrack = Pick<QueueRow, 'id' | 'label' | 'locked' | 'playlistName'> & { media: QueueRow['media'] & { gainDb?: number | null } };

export interface StudioView {
  phase: StudioPhase;
  stationId: string | null;
  /** The microphone goes into the mix. */
  mic: boolean;
  /** What is on players A and B (from the queue), and which one is on air. */
  tracks: (StudioTrack | null)[];
  air: number | null;
  /** Waiting to take over at the end of the AutoDJ's track: until when, and the track that starts then. */
  waitUntil: number | null;
  first: StudioTrack | null;
  /** The next track is being fetched from the server. */
  fetching: boolean;
  error: string | null;
  lostAt: number | null;
  /** Manual playout: the next track waits for Play. */
  manual: boolean;
}

/** Studio mode stays on this long after a renewal on the server; renewed every few seconds. */
const RENEW_MS = 3000;
/** A broadcast that keeps reconnecting this long ends studio mode: the server's AutoDJ takes over. */
const LOST_AFTER_MS = 8000;
/** Taking over at the end of a track: go live this much before it ends (connecting takes a moment). */
const LEAD_MS = 1200;
/** Handing back: the AutoDJ gets the next track ready while the players fade out. */
const HAND_BACK_MS = 1500;

let view: StudioView = { phase: 'off', stationId: null, mic: false, tracks: [null, null], air: null, waitUntil: null, first: null, fetching: false, error: null, lostAt: null, manual: false };
const listeners = new Set<() => void>();
function set(patch: Partial<StudioView>) {
  view = { ...view, ...patch };
  listeners.forEach((l) => l());
}

export function useStudio<T>(select: (s: StudioView) => T): T {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => select(view),
  );
}
export const studioView = () => view;

let pcName: string | null = null;
async function pc() {
  if (!pcName) pcName = (await call<AppInfo>('app_info')).hostname || 'RHIS Studio';
  return pcName;
}

/** Session data of one studio mode run. */
let run: {
  station: StationListItem;
  crossfade: number;
  normalize: boolean;
  /** The AutoDJ's track that this PC took over (it is on air already: not reported again). */
  takenOver: string | null;
  renew: ReturnType<typeof setInterval> | null;
  lastLive: number;
  /** The broadcast was live at least once in this run. */
  everLive: boolean;
  lastRenewed: number;
  requesting: boolean;
  retry: ReturnType<typeof setTimeout> | null;
  cut: ReturnType<typeof setTimeout> | null;
  /** The first track starts by itself, also in manual playout. */
  startFirst: boolean;
  cancelled: boolean;
} | null = null;

const audioUrl = (stationId: string, mediaId: string) => `${getSettings().server}/api/stations/${stationId}/library/${mediaId}/audio`;
const extOf = (path: string) => (/\.([a-z0-9]{1,5})$/i.exec(path)?.[1] ?? 'mp3').toLowerCase();

/** The file of a library track on this PC (downloaded once). */
function fetchFile(stationId: string, media: { id: string; path: string }) {
  return call<string>('cache_file', { url: audioUrl(stationId, media.id), token: getApiKey() ?? '', name: `studio-${media.id}.${extOf(media.path)}` });
}

const titleOf = (t: StudioTrack) => [t.media.artist, t.media.title || t.media.path].filter(Boolean).join(' - ');

/**
 * The cue points of a track as the deck plays them, the same as the AutoDJ: from cue in to cue out; the next track
 * starts at the segue (or the end less the crossfade); without crossfade a segue ends the track there.
 */
export function deckLoad(track: StudioTrack, path: string, crossfade: number, normalize: boolean, from?: number): DeckLoad {
  const m = track.media;
  const start = from ?? m.cueIn ?? 0;
  const end = m.cueOut ?? m.durationSeconds ?? null;
  const out = m.cueSegue != null && crossfade <= 0 ? m.cueSegue : end;
  const nextAt = m.cueSegue ?? (end != null ? Math.max(start, end - crossfade) : null);
  return {
    path,
    id: track.id,
    title: titleOf(track),
    start,
    end: out,
    nextAt,
    fadeOutAt: crossfade > 0 && m.cueFadeOut != null ? m.cueFadeOut : null,
    fadeIn: from != null ? Math.min(crossfade, 2) : crossfade,
    gainDb: normalize && m.gainDb != null ? m.gainDb : 0,
  };
}

const post = <T>(path: string, body: unknown) => api<T>(`/stations/${run!.station.id}/autodj/studio${path}`, { method: 'POST', body });

function decks(): DeckState[] {
  return engineState().decks;
}

/** The deck that holds the track that goes on air next. */
function nextDeck(): number | null {
  const i = view.tracks.findIndex((t, i) => t && i !== view.air && !decks()[i]?.playing);
  return i < 0 ? null : i;
}

/** Keeps one track loaded behind the one on air: asks the server for it when a player is free. */
async function ensureNext() {
  const r = run;
  if (!r || view.phase !== 'on' || r.requesting || nextDeck() != null) return;
  const free = view.tracks.findIndex((t) => !t);
  if (free < 0) return;
  r.requesting = true;
  set({ fetching: true });
  try {
    const res = await post<{ track: StudioTrack | null; cutAt: number | null; crossfadeSeconds: number; normalize: boolean }>('/next', { pc: await pc() });
    if (run !== r || view.phase !== 'on') return;
    r.crossfade = res.crossfadeSeconds;
    r.normalize = res.normalize;
    if (!res.track) {
      r.retry = setTimeout(() => void ensureNext(), 5000);
      return;
    }
    const track = res.track;
    const path = await fetchFile(r.station.id, track.media);
    if (run !== r) return;
    await call('deck_mode', { auto: !view.manual, crossfade: r.crossfade });
    await call('deck_load', { deck: free, load: deckLoad(track, path, r.crossfade, r.normalize) });
    const tracks = [...view.tracks];
    tracks[free] = track;
    set({ tracks, error: null });
    // A hard timed item of the hour clock: the track on air is cut so it starts on its minute.
    if (res.cutAt) {
      if (r.cut) clearTimeout(r.cut);
      r.cut = setTimeout(() => {
        if (run === r && view.tracks[free]?.id === track.id && !decks()[free]?.playing) void call('deck_play', { deck: free, fade: null });
      }, Math.max(0, res.cutAt - Date.now()));
    }
    autoStart();
  } catch (err) {
    if (run !== r) return;
    if (err instanceof ApiError && err.status === 409) return lost(err.message);
    set({ error: (err as Error).message });
    r.retry = setTimeout(() => void ensureNext(), 5000);
  } finally {
    r.requesting = false;
    set({ fetching: false });
  }
}

/** Nothing on air and the next track ready: it starts (Auto, or the first track of studio mode). */
function autoStart() {
  const r = run;
  if (!r || view.phase !== 'on' || view.air != null) return;
  if (view.manual && !r.startFirst) return;
  const n = nextDeck();
  if (n == null || !decks()[n]?.ready) return;
  r.startFirst = false;
  void call('deck_play', { deck: n, fade: null });
}

onDeck(
  (e) => {
    const r = run;
    if (!r) return;
    if (e.kind === 'started') {
      set({ air: e.deck });
      const track = view.tracks[e.deck];
      if (track && track.id === e.id) {
        void sendTitle(titleOf(track)).catch(() => undefined);
        if (e.id !== r.takenOver) void pc().then((name) => post(`/playing/${e.id}`, { pc: name })).catch((err) => err instanceof ApiError && err.status === 409 && lost(err.message));
        r.takenOver = null;
      }
      void ensureNext();
    } else if (e.kind === 'ended') {
      const tracks = [...view.tracks];
      if (tracks[e.deck]?.id === e.id) tracks[e.deck] = null;
      set({ tracks, air: view.air === e.deck ? null : view.air });
      void ensureNext();
      autoStart();
    } else if (e.kind === 'next') {
      autoStart();
    }
  },
  () => autoStart(),
);

/** Renews studio mode while the broadcast is up; a broadcast that stays down hands the station back. */
async function renew() {
  const r = run;
  if (!r || view.phase !== 'on') return;
  const b = engineState().broadcast;
  if (b.state === 'live') r.everLive = true;
  const now = Date.now();
  if (b.state === 'live') r.lastLive = now;
  if (b.state === 'failed' || b.state === 'off' || now - r.lastLive > LOST_AFTER_MS) return lost(broadcastReason(b, r.everLive));
  try {
    await post('', { on: true, pc: await pc() });
    r.lastRenewed = Date.now();
  } catch (err) {
    if (run !== r) return;
    if (err instanceof ApiError && err.status === 409) return lost(err.message);
    // The server answers again within the grace time, or it took over meanwhile.
    if (Date.now() - r.lastRenewed > 10_000) lost('serverLost');
  }
}

function clearTimers() {
  if (!run) return;
  if (run.renew) clearInterval(run.renew);
  if (run.retry) clearTimeout(run.retry);
  if (run.cut) clearTimeout(run.cut);
}

async function silenceDecks(fade: number) {
  for (const deck of [0, 1]) await call('deck_stop', { deck, fade }).catch(() => undefined);
}

/**
 * Why the broadcast ended studio mode, for the banner: the encoder's own error, or `noBroadcast` (translated there)
 * when it never got through to the station.
 */
function broadcastReason(b: BroadcastStatus, everLive: boolean) {
  if ((b.state === 'failed' || b.state === 'reconnecting') && b.error) return b.error;
  return everLive ? 'broadcastLost' : 'noBroadcast';
}

/** The connection or the server ended studio mode: the AutoDJ plays; this PC is off air. */
function lost(reason: string | null) {
  if (!run || view.phase === 'lost' || view.phase === 'off') return;
  const r = run;
  clearTimers();
  run = null;
  void silenceDecks(1);
  void call('set_mic', { open: false });
  stopLive();
  void pc()
    .then((name) => api(`/stations/${r.station.id}/autodj/studio`, { method: 'POST', body: { on: false, pc: name } }))
    .catch(() => undefined);
  set({ phase: 'lost', mic: false, tracks: [null, null], air: null, lostAt: Date.now(), error: reason, fetching: false });
}

/**
 * Takes over from the AutoDJ: at the end of the track on air (`end`), or now with that same track from the same place
 * (`now`). Throws with the reason when it cannot (no live account, the server said no).
 */
export async function startStudio(station: StationListItem, me: Me | null | false, data: AutoDj, how: 'end' | 'now', texts: { notReady: string; noOutput: string }) {
  if (run || (view.phase !== 'off' && view.phase !== 'lost')) return;
  // Without a sound card for the output the DJ hears nothing and the mix may not reach the station: refuse up front.
  const info = engineState().info;
  if (!info?.output) throw new Error(texts.noOutput.replace('{{error}}', info?.error ?? '–'));
  const crossfade = data.settings.crossfadeSeconds ?? 0;
  const manual = !!data.playout?.manual;
  run = { station, crossfade, normalize: true, takenOver: null, renew: null, lastLive: Date.now(), everLive: false, lastRenewed: Date.now(), requesting: false, retry: null, cut: null, startFirst: true, cancelled: false };
  const r = run;
  set({ phase: 'preparing', stationId: station.id, mic: false, tracks: [null, null], air: null, waitUntil: null, first: null, error: null, lostAt: null, manual });
  let on = false;
  try {
    const name = await pc();
    const [detail, accounts] = await Promise.all([api<StationDetail>(`/stations/${station.id}`), api<Account[]>(`/stations/${station.id}/accounts`)]);
    const choice = liveChoice(detail, accounts, me, getSettings().live);
    if (!choice.mount || !choice.account) throw new Error(texts.notReady);
    await call('set_mic', { open: false });
    await call('deck_mode', { auto: !manual, crossfade });
    for (const deck of [0, 1]) await call('deck_clear', { deck });
    const np = data.nowPlaying;
    const sampleRate = engineState().info?.sampleRate ?? 48000;
    if (how === 'now' && np?.startedAt) {
      // The track on air goes on here from the same place, with a short crossfade over the AutoDJ.
      const path = await fetchFile(station.id, np.media);
      const elapsed = (Date.now() - new Date(np.startedAt).getTime()) / 1000;
      await call('deck_load', { deck: 0, load: deckLoad(np, path, crossfade, false, (np.media.cueIn ?? 0) + elapsed) });
      r.takenOver = np.id;
      set({ tracks: [np, null] });
      await post('', { on: true, pc: name });
      on = true;
      await startLive(station, detail, choice, { sampleRate, notReady: texts.notReady });
      r.startFirst = false;
      await call('deck_play', { deck: 0, fade: 0 });
    } else {
      // At the end of the track on air: the track after it is fetched now, the PC goes live just before the end.
      const first = queueOf(data).find((q) => q.state === 'cued') ?? queueOf(data)[0] ?? null;
      if (first) void fetchFile(station.id, first.media).catch(() => undefined);
      const length = np ? playLength(np.media, crossfade) : null;
      const ends = np?.startedAt && length != null ? new Date(np.startedAt).getTime() + length * 1000 : Date.now();
      if (ends - Date.now() > LEAD_MS) {
        set({ phase: 'waiting', waitUntil: ends, first });
        await new Promise<void>((resolve) => {
          const tick = () => (r.cancelled || Date.now() >= ends - LEAD_MS ? resolve() : setTimeout(tick, 100));
          tick();
        });
        if (r.cancelled) throw new Error('cancelled');
      }
      await post('', { on: true, pc: name });
      on = true;
      await startLive(station, detail, choice, { sampleRate, notReady: texts.notReady });
    }
    if (run !== r) return;
    r.lastLive = Date.now();
    r.lastRenewed = Date.now();
    r.renew = setInterval(() => void renew(), RENEW_MS);
    set({ phase: 'on', waitUntil: null, first: null });
    await ensureNext();
  } catch (err) {
    if (run === r) {
      clearTimers();
      run = null;
    }
    if (on) {
      stopLive();
      void api(`/stations/${station.id}/autodj/studio`, { method: 'POST', body: { on: false, pc: await pc() } }).catch(() => undefined);
    }
    await silenceDecks(0);
    void call('set_mic', { open: true });
    set({ phase: 'off', tracks: [null, null], air: null, waitUntil: null, first: null, fetching: false, mic: false });
    if ((err as Error).message !== 'cancelled') throw err;
  }
}

/** Back to AutoDJ: the server's AutoDJ goes on with the next track of the queue while the players fade out. */
export async function stopStudio() {
  const r = run;
  if (!r) {
    // Waiting to take over, or after a lost connection: nothing is on air from here.
    set({ phase: 'off', error: null, lostAt: null, waitUntil: null, first: null });
    void call('set_mic', { open: true });
    return;
  }
  clearTimers();
  set({ phase: 'stopping' });
  await api(`/stations/${r.station.id}/autodj/studio`, { method: 'POST', body: { on: false, pc: await pc() } }).catch(() => undefined);
  void silenceDecks(HAND_BACK_MS / 1000);
  await new Promise((res) => setTimeout(res, HAND_BACK_MS));
  stopLive();
  run = null;
  for (const deck of [0, 1]) await call('deck_clear', { deck }).catch(() => undefined);
  // Outside studio mode the sound card input always goes live, as before.
  await call('set_mic', { open: true });
  set({ phase: 'off', mic: false, tracks: [null, null], air: null, fetching: false, error: null });
}

/** Cancels a take over that waits for the end of the track. */
export function cancelStudio() {
  if (run && view.phase === 'waiting') run.cancelled = true;
}

export function toggleMic(open = !view.mic) {
  if (view.phase !== 'on') return;
  void call('set_mic', { open });
  set({ mic: open });
}

/** Next: the track loaded behind the one on air starts now (with the crossfade). */
export function studioNext() {
  const n = nextDeck();
  if (view.phase !== 'on' || n == null || !decks()[n]?.ready) return;
  if (run) run.startFirst = false;
  void call('deck_play', { deck: n, fade: null });
}

/** Manual playout: the track on air stops; the next one waits for Play. */
export function studioStop() {
  if (view.phase !== 'on' || view.air == null) return;
  void call('deck_stop', { deck: view.air, fade: 0.4 });
}

/** Manual or Auto, as the server has it: in Auto the next track starts by itself. */
export function studioManual(manual: boolean) {
  if (view.manual === manual) return;
  set({ manual });
  if (run) void call('deck_mode', { auto: !manual, crossfade: run.crossfade });
  autoStart();
}

export const studio = { start: startStudio, stop: stopStudio, cancel: cancelStudio, mic: toggleMic, next: studioNext, stopTrack: studioStop, manual: studioManual };
