// Reporter mode: reporters on location join the station's room on the reporter server (LiveKit on an ingest node) from
// a phone. This window joins the same room as "studio": it hears every phone as its own track, hands the samples to the
// audio engine (which routes them to the DJ's headphones or on air) and publishes what the phones hear back: the
// talk-back (the microphone) for a phone that talks with the DJ and the programme without the reporters (mix-minus) for
// a phone on air. The reporters window (second screen) shows the tiles and sends its clicks here.

import { invoke, Channel } from '@tauri-apps/api/core';
import { ConnectionQuality, LocalAudioTrack, Room, RoomEvent, Track, type Participant, type RemoteParticipant, type RemoteTrack } from 'livekit-client';
import { useSyncExternalStore } from 'react';
import { api } from './api';
import { call, inTauri } from './native';
import { getEngineState } from './engine';

/**
 * What a reporter does now: waiting (heard nowhere), talk (off air with the DJ), live (on air) or muted (on air but
 * turned down, hears the programme). Keep in step with apps/web/src/pages/Reporter.tsx.
 */
export type ReporterState = 'waiting' | 'talk' | 'live' | 'muted';
export type Quality = 'excellent' | 'good' | 'poor' | 'lost' | 'unknown';

export interface Reporter {
  identity: string;
  name: string;
  place: string;
  state: ReporterState;
  /** Peak level 0..1 of the last moment. */
  level: number;
  quality: Quality;
  joinedAt: number;
}

export interface Invite {
  code: string;
  expiresAt: string;
  joinUrl: string;
  uses: number;
}

export interface ReportersSnapshot {
  stationId: string | null;
  status: 'off' | 'loading' | 'connecting' | 'connected' | 'unavailable' | 'error';
  /** Why there is no reporter server: none = no ingest node with reporter mode, offline/starting = it is not up. */
  reason: 'none' | 'offline' | 'starting' | null;
  error: string | null;
  node: string | null;
  invite: Invite | null;
  reporters: Reporter[];
}

interface ServerInfo {
  available: boolean;
  reason: 'none' | 'offline' | 'starting' | null;
  server: { url: string; node: string } | null;
  room: string;
  identity: string;
  token: string | null;
  invite: Invite | null;
}

const TOPIC = 'hrs-reporters';
/** The names of the two tracks the studio publishes; keep in step with apps/web/src/pages/Reporter.tsx. */
export const BACK_TRACKS = { talk: 'talkback', programme: 'programme' } as const;
const isReporter = (p: Participant) => p.identity.startsWith('rep-');

let snap: ReportersSnapshot = { stationId: null, status: 'off', reason: null, error: null, node: null, invite: null, reporters: [] };
const listeners = new Set<() => void>();
const set = (patch: Partial<ReportersSnapshot>) => {
  snap = { ...snap, ...patch };
  listeners.forEach((l) => l());
};
export const getReporters = () => snap;
export const subscribeReporters = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
export const useReporters = <T>(select: (s: ReportersSnapshot) => T) => useSyncExternalStore(subscribeReporters, () => select(snap));

// Audio in the window: one tap per phone that passes its samples on, and a player for the talk-back.
const WORKLET = `
class Tap extends AudioWorkletProcessor {
  constructor(o) { super(); this.frames = o.processorOptions.frames; this.buf = new Float32Array(this.frames * 2); this.at = 0; this.peak = 0; }
  process(inputs) {
    const ch = inputs[0];
    if (!ch || !ch.length) return true;
    const l = ch[0], r = ch[1] || ch[0];
    for (let i = 0; i < l.length; i++) {
      this.buf[this.at++] = l[i]; this.buf[this.at++] = r[i];
      const p = Math.max(Math.abs(l[i]), Math.abs(r[i])); if (p > this.peak) this.peak = p;
      if (this.at === this.buf.length) { this.port.postMessage({ pcm: this.buf, peak: this.peak }, [this.buf.buffer]); this.buf = new Float32Array(this.frames * 2); this.at = 0; this.peak = 0; }
    }
    return true;
  }
}
// Each block from the engine holds the talk-back and then the programme (as long): output 0 and output 1.
class Back extends AudioWorkletProcessor {
  constructor() { super(); this.q = []; this.off = 0; this.size = 0; this.port.onmessage = (e) => { this.q.push(e.data); this.size += e.data.length / 2; while (this.size > sampleRate * 0.4) { this.size -= this.q[0].length / 2 - this.off; this.q.shift(); this.off = 0; } }; }
  process(_in, outputs) {
    const tl = outputs[0][0], tr = outputs[0][1] || outputs[0][0], pl = outputs[1][0], pr = outputs[1][1] || outputs[1][0];
    for (let i = 0; i < tl.length; i++) {
      const b = this.q[0];
      if (!b) { tl[i] = tr[i] = pl[i] = pr[i] = 0; continue; }
      const half = b.length / 2;
      tl[i] = b[this.off]; tr[i] = b[this.off + 1]; pl[i] = b[half + this.off]; pr[i] = b[half + this.off + 1];
      this.off += 2; this.size -= 2;
      if (this.off >= half) { this.q.shift(); this.off = 0; }
    }
    return true;
  }
}
registerProcessor('hrs-tap', Tap);
registerProcessor('hrs-back', Back);
`;

interface Session {
  stationId: string;
  room: Room;
  ctx: AudioContext;
  feeds: Map<string, { el: HTMLMediaElement; src: MediaStreamAudioSourceNode; tap: AudioWorkletNode; out: GainNode }>;
  back: LocalAudioTrack[];
  stopBack: () => void;
  info: ServerInfo;
}
let session: Session | null = null;
let levels = new Map<string, number>();
let levelTimer: ReturnType<typeof setInterval> | null = null;

const qualityOf = (q: ConnectionQuality): Quality =>
  q === ConnectionQuality.Excellent ? 'excellent' : q === ConnectionQuality.Good ? 'good' : q === ConnectionQuality.Poor ? 'poor' : q === ConnectionQuality.Lost ? 'lost' : 'unknown';

const placeOf = (p: Participant) => {
  try {
    return String((JSON.parse(p.metadata || '{}') as { place?: string }).place ?? '').slice(0, 60);
  } catch {
    return '';
  }
};

function reporterList(room: Room, prev: Reporter[]): Reporter[] {
  return [...room.remoteParticipants.values()].filter(isReporter).map((p) => {
    const old = prev.find((r) => r.identity === p.identity);
    return { identity: p.identity, name: p.name || p.identity, place: placeOf(p), state: old?.state ?? 'waiting', level: old?.level ?? 0, quality: qualityOf(p.connectionQuality), joinedAt: old?.joinedAt ?? (p.joinedAt?.getTime() ?? Date.now()) };
  });
}

/** Tells every phone what it does now (they show it big). */
function sendStates() {
  if (!session || session.room.state !== 'connected') return;
  const states = Object.fromEntries(snap.reporters.map((r) => [r.identity, r.state]));
  void session.room.localParticipant.publishData(new TextEncoder().encode(JSON.stringify({ t: 'state', states })), { reliable: true, topic: TOPIC }).catch(() => undefined);
}

const route = (identity: string, state: ReporterState) => {
  // In the browser (development) the talking phone plays through the page itself.
  const f = session?.feeds.get(identity);
  if (f) f.out.gain.value = !inTauri && (state === 'talk' || state === 'live') ? 1 : 0;
  return call('reporter_route', { id: identity, route: state === 'talk' ? 'talk' : state === 'live' ? 'live' : 'off' }).catch(() => undefined);
};

function attach(s: Session, track: RemoteTrack, p: RemoteParticipant) {
  if (track.kind !== Track.Kind.Audio || !isReporter(p)) return;
  detach(s, p.identity);
  // A remote WebRTC track only plays into Web Audio while a media element also has it (a Chromium quirk); muted.
  const el = track.attach();
  el.muted = true;
  el.style.display = 'none';
  document.body.appendChild(el);
  const src = s.ctx.createMediaStreamSource(new MediaStream([track.mediaStreamTrack]));
  const frames = Math.round(s.ctx.sampleRate / 50);
  const tap = new AudioWorkletNode(s.ctx, 'hrs-tap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], processorOptions: { frames } });
  const out = s.ctx.createGain();
  out.gain.value = 0;
  src.connect(tap);
  // Pass-through to the speakers only in the browser; the gain keeps it silent in the app.
  tap.connect(out).connect(s.ctx.destination);
  src.connect(out);
  const id = p.identity;
  tap.port.onmessage = (e: MessageEvent<{ pcm: Float32Array; peak: number }>) => {
    levels.set(id, Math.max(e.data.peak, (levels.get(id) ?? 0) * 0.7));
    if (inTauri) void invoke('reporter_audio', new Uint8Array(e.data.pcm.buffer), { headers: { 'x-reporter': id } }).catch(() => undefined);
  };
  s.feeds.set(id, { el, src, tap, out });
  const r = snap.reporters.find((x) => x.identity === id);
  void route(id, r?.state ?? 'waiting');
}

function detach(s: Session, identity: string) {
  const f = s.feeds.get(identity);
  if (!f) return;
  f.tap.port.onmessage = null;
  f.src.disconnect();
  f.tap.disconnect();
  f.out.disconnect();
  f.el.remove();
  s.feeds.delete(identity);
  levels.delete(identity);
  void call('reporter_remove', { id: identity }).catch(() => undefined);
}

/**
 * What the phones hear: the engine sends the microphone and the programme without the reporters block by block; they
 * go out as the studio's two audio tracks, and each phone subscribes to the one that fits what it does.
 */
async function startBack(s: Session) {
  const node = new AudioWorkletNode(s.ctx, 'hrs-back', { numberOfInputs: 0, numberOfOutputs: 2, outputChannelCount: [2, 2] });
  const dest = s.ctx.createMediaStreamDestination();
  const prog = s.ctx.createMediaStreamDestination();
  dest.channelCount = 2;
  prog.channelCount = 2;
  node.connect(dest, 0);
  node.connect(prog, 1);
  let stop = () => node.disconnect();
  if (inTauri) {
    const ch = new Channel<ArrayBuffer>();
    ch.onmessage = (buf) => node.port.postMessage(new Float32Array(buf));
    await invoke('reporter_back', { channel: ch });
    stop = () => {
      void call('reporter_back_stop').catch(() => undefined);
      node.disconnect();
    };
  } else {
    // In the browser: the microphone of this computer, when there is one, on both.
    const mic = await navigator.mediaDevices?.getUserMedia({ audio: true }).catch(() => null);
    if (mic) {
      const src = s.ctx.createMediaStreamSource(mic);
      src.connect(dest);
      src.connect(prog);
      const prev = stop;
      stop = () => {
        prev();
        mic.getTracks().forEach((x) => x.stop());
      };
    }
  }
  const talk = new LocalAudioTrack(dest.stream.getAudioTracks()[0]!, undefined, false);
  const programme = new LocalAudioTrack(prog.stream.getAudioTracks()[0]!, undefined, false);
  await s.room.localParticipant.publishTrack(talk, { name: BACK_TRACKS.talk, source: Track.Source.Microphone, dtx: false, red: true, audioPreset: { maxBitrate: 64_000 } });
  await s.room.localParticipant.publishTrack(programme, { name: BACK_TRACKS.programme, source: Track.Source.Unknown, dtx: false, red: true, audioPreset: { maxBitrate: 64_000 } });
  s.back = [talk, programme];
  s.stopBack = stop;
}

/** Fetches the reporter server and the code for a station, and joins its room when there is a server. */
export async function openReporters(stationId: string) {
  if (session?.stationId === stationId && (snap.status === 'connected' || snap.status === 'connecting')) return;
  await closeReporters();
  set({ stationId, status: 'loading', reason: null, error: null, node: null, invite: null, reporters: [] });
  let info: ServerInfo;
  try {
    info = await api<ServerInfo>(`/studio/stations/${stationId}/reporters`);
  } catch (err) {
    set({ status: 'error', error: (err as Error).message });
    return;
  }
  if (snap.stationId !== stationId) return;
  if (!info.available || !info.server || !info.token) {
    set({ status: 'unavailable', reason: info.reason, invite: info.invite });
    return;
  }
  set({ status: 'connecting', node: info.server.node, invite: info.invite });
  const engineRate = getEngineState().info?.sampleRate ?? 48_000;
  const ctx = new AudioContext({ sampleRate: engineRate, latencyHint: 'interactive' });
  const room = new Room({ adaptiveStream: false, dynacast: false });
  const s: Session = { stationId, room, ctx, feeds: new Map(), back: [], stopBack: () => {}, info };
  session = s;
  const refresh = () => {
    if (session !== s) return;
    const list = reporterList(room, snap.reporters);
    const joined = list.length > snap.reporters.length;
    // Somebody new waits: tell them so (and everybody else what they do).
    set({ reporters: list });
    sendStates();
    // The code was used once more.
    if (joined) void api<ServerInfo>(`/studio/stations/${stationId}/reporters`).then((i) => session === s && set({ invite: i.invite })).catch(() => undefined);
  };
  room
    .on(RoomEvent.ParticipantConnected, refresh)
    .on(RoomEvent.ParticipantDisconnected, (p) => {
      detach(s, p.identity);
      refresh();
    })
    .on(RoomEvent.ParticipantNameChanged, refresh)
    .on(RoomEvent.TrackSubscribed, (track, _pub, p) => attach(s, track, p))
    .on(RoomEvent.TrackUnsubscribed, (_track, _pub, p) => detach(s, p.identity))
    .on(RoomEvent.ConnectionQualityChanged, (q, p) => {
      if (!isReporter(p)) return;
      set({ reporters: snap.reporters.map((r) => (r.identity === p.identity ? { ...r, quality: qualityOf(q) } : r)) });
    })
    .on(RoomEvent.Reconnecting, () => session === s && set({ status: 'connecting' }))
    .on(RoomEvent.Reconnected, () => {
      if (session !== s) return;
      set({ status: 'connected' });
      sendStates();
    })
    .on(RoomEvent.Disconnected, () => {
      if (session !== s) return;
      set({ status: 'error', error: 'disconnected' });
    });
  try {
    const blob = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
    await ctx.audioWorklet.addModule(blob);
    URL.revokeObjectURL(blob);
    await ctx.resume();
    await room.connect(info.server.url, info.token, { autoSubscribe: true });
    if (session !== s) return void room.disconnect();
    await startBack(s);
    for (const p of room.remoteParticipants.values()) for (const pub of p.audioTrackPublications.values()) if (pub.track) attach(s, pub.track, p);
    set({ status: 'connected' });
    refresh();
  } catch (err) {
    if (session === s) set({ status: 'error', error: (err as Error).message });
    await closeReporters(false);
  }
  levelTimer ??= setInterval(() => {
    if (!snap.reporters.length) return;
    // The levels fall back by themselves between peaks.
    for (const [k, v] of levels) levels.set(k, v * 0.6);
    set({ reporters: snap.reporters.map((r) => ({ ...r, level: levels.get(r.identity) ?? 0 })) });
  }, 100);
}

export async function closeReporters(reset = true) {
  const s = session;
  session = null;
  if (levelTimer) clearInterval(levelTimer);
  levelTimer = null;
  if (s) {
    for (const id of [...s.feeds.keys()]) detach(s, id);
    s.stopBack();
    s.back.forEach((tr) => tr.stop());
    await s.room.disconnect().catch(() => undefined);
    await s.ctx.close().catch(() => undefined);
  }
  await call('reporter_remove', {}).catch(() => undefined);
  if (reset) set({ stationId: null, status: 'off', reason: null, error: null, node: null, invite: null, reporters: [] });
}

/** Puts reporters in a state: one tile, or every selected one at once. */
export function setStates(ids: string[], state: ReporterState) {
  const change = new Set(ids.filter((id) => snap.reporters.some((r) => r.identity === id && r.state !== state)));
  if (!change.size) return;
  set({ reporters: snap.reporters.map((x) => (change.has(x.identity) ? { ...x, state } : x)) });
  for (const id of change) void route(id, state);
  sendStates();
}

/** Talk with a reporter off air (only the DJ hears them, they hear the microphone), or stop talking. */
export function toggleTalk(identity: string) {
  const r = snap.reporters.find((x) => x.identity === identity);
  if (r) setStates([identity], r.state === 'talk' ? 'waiting' : 'talk');
}

/** On air, or back off air (waiting). */
export function toggleLive(identity: string) {
  const r = snap.reporters.find((x) => x.identity === identity);
  if (r) setStates([identity], r.state === 'live' || r.state === 'muted' ? 'waiting' : 'live');
}

/** Turns a reporter on air down for a moment (they stay on air and keep hearing the programme), or up again. */
export function toggleMute(identity: string) {
  const r = snap.reporters.find((x) => x.identity === identity);
  if (r && (r.state === 'live' || r.state === 'muted')) setStates([identity], r.state === 'live' ? 'muted' : 'live');
}

/** Everybody on air (or muted) back off air at once. */
export function allOffAir() {
  setStates(
    snap.reporters.filter((r) => r.state === 'live' || r.state === 'muted').map((r) => r.identity),
    'waiting',
  );
}

/** Ends the call with a reporter: the phone leaves and shows a thank-you. */
export function hangUp(identity: string) {
  const s = session;
  if (!s) return;
  void s.room.localParticipant.publishData(new TextEncoder().encode(JSON.stringify({ t: 'bye' })), { reliable: true, topic: TOPIC, destinationIdentities: [identity] }).catch(() => undefined);
  detach(s, identity);
  set({ reporters: snap.reporters.filter((r) => r.identity !== identity) });
}

/** A new code for the phones (the old one stops working). */
export async function newInvite() {
  if (!snap.stationId) return;
  const invite = await api<Invite>(`/studio/stations/${snap.stationId}/reporters/invite`, { method: 'POST' });
  set({ invite });
}

export async function endInvite() {
  if (!snap.stationId) return;
  await api(`/studio/stations/${snap.stationId}/reporters/invite`, { method: 'DELETE' });
  set({ invite: null });
}

/** Tries again after "not available" or a lost connection. */
export const retryReporters = () => snap.stationId && openReporters(snap.stationId);
