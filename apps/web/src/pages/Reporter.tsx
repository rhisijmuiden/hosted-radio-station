import clsx from 'clsx';
import { LogOut, Mic, MicOff, Radio, RefreshCw } from 'lucide-react';
import { ConnectionQuality, createLocalAudioTrack, DisconnectReason, Room, RoomEvent, Track, type LocalAudioTrack, type RemoteTrack } from 'livekit-client';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import { setLanguage } from '../i18n';
import { api, ApiError } from '../lib/api';

/**
 * Reporter mode: the page a reporter on location opens on a phone (later also inside the Android app). With the code
 * from the DJ they join the station's room on the reporter server; RHIS Studio decides whether they wait, talk with the
 * DJ off air, or are on air, and says so in a data message.
 */

/** What RHIS Studio sends in the room (topic "hrs-reporters"); keep in step with apps/studio/src/lib/reporters.ts. */
type ReporterState = 'waiting' | 'talk' | 'live' | 'muted';
type StudioMessage = { t: 'state'; states: Record<string, ReporterState> } | { t: 'bye' };
const TOPIC = 'hrs-reporters';
const STUDIO = 'studio';

interface Joined {
  url: string;
  token: string;
  identity: string;
  station: { name: string };
}

type Phase = { kind: 'form' } | { kind: 'joining' } | { kind: 'in'; station: string } | { kind: 'ended'; reason: 'left' | 'removed' | 'lost' };

const STORE = 'hrs-reporter';
const remembered = (): { name?: string; place?: string; mic?: string } => {
  try {
    return JSON.parse(localStorage.getItem(STORE) ?? '{}');
  } catch {
    return {};
  }
};

export function ReporterPage() {
  const { t, i18n } = useTranslation();
  const [params] = useSearchParams();
  const saved = remembered();
  const [code, setCode] = useState((params.get('code') ?? '').replace(/\D/g, '').slice(0, 6));
  const [name, setName] = useState(saved.name ?? '');
  const [place, setPlace] = useState(saved.place ?? '');
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [mic, setMic] = useState(saved.mic ?? '');
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'form' });
  const [state, setState] = useState<ReporterState>('waiting');
  const [studioHere, setStudioHere] = useState(false);
  const [muted, setMuted] = useState(false);
  const [quality, setQuality] = useState<ConnectionQuality>(ConnectionQuality.Unknown);
  const [reconnecting, setReconnecting] = useState(false);
  const [level, setLevel] = useState(0);
  const room = useRef<Room | null>(null);
  const track = useRef<LocalAudioTrack | null>(null);
  const back = useRef<HTMLAudioElement | null>(null);
  const identity = useRef('');
  const stateRef = useRef<ReporterState>('waiting');
  const lang = i18n.language.startsWith('nl') ? 'nl' : 'en';

  // The microphones, once the browser lets us see their names.
  const listMics = () =>
    navigator.mediaDevices
      ?.enumerateDevices()
      .then((d) => setMics(d.filter((x) => x.kind === 'audioinput' && x.deviceId)))
      .catch(() => undefined);
  useEffect(() => {
    void listMics();
  }, []);

  // The studio's voice only plays while the DJ talks with this phone or it is on air.
  useEffect(() => {
    stateRef.current = state;
    if (back.current) back.current.muted = !(state === 'talk' || state === 'live');
  }, [state]);

  // The level of the own microphone, for the meter.
  useEffect(() => {
    if (phase.kind !== 'in' || !track.current) return;
    const ctx = new AudioContext();
    const src = ctx.createMediaStreamSource(new MediaStream([track.current.mediaStreamTrack]));
    const an = ctx.createAnalyser();
    an.fftSize = 512;
    src.connect(an);
    const buf = new Float32Array(an.fftSize);
    let raf = 0;
    const tick = () => {
      an.getFloatTimeDomainData(buf);
      let peak = 0;
      for (const v of buf) peak = Math.max(peak, Math.abs(v));
      setLevel((l) => Math.max(peak, l * 0.85));
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => {
      cancelAnimationFrame(raf);
      void ctx.close();
    };
  }, [phase.kind]);

  // Keep the screen on while connected: a phone that locks its screen may stop the microphone.
  useEffect(() => {
    if (phase.kind !== 'in' || !('wakeLock' in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    const take = () => void navigator.wakeLock.request('screen').then((l) => (lock = l)).catch(() => undefined);
    take();
    const again = () => document.visibilityState === 'visible' && take();
    document.addEventListener('visibilitychange', again);
    return () => {
      document.removeEventListener('visibilitychange', again);
      void lock?.release();
    };
  }, [phase.kind]);

  useEffect(() => () => void room.current?.disconnect(), []);

  async function join(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setPhase({ kind: 'joining' });
    try {
      localStorage.setItem(STORE, JSON.stringify({ name, place, mic }));
    } catch {
      /* private mode */
    }
    let joined: Joined;
    try {
      joined = await api<Joined>('/public/reporters/join', { method: 'POST', body: { code, name, place } });
    } catch (err) {
      setError(err instanceof ApiError && err.code === 'invalid_code' ? t('reporter.invalidCode') : err instanceof ApiError && err.status === 429 ? t('auth.tooMany') : (err as Error).message);
      setPhase({ kind: 'form' });
      return;
    }
    identity.current = joined.identity;
    try {
      // Echo cancelling and noise suppression on: the phone may hear the studio over its speaker.
      track.current = await createLocalAudioTrack({ deviceId: mic || undefined, echoCancellation: true, noiseSuppression: true, autoGainControl: true });
      void listMics();
    } catch {
      setError(t('reporter.noMic'));
      setPhase({ kind: 'form' });
      return;
    }
    const r = new Room({ adaptiveStream: false, dynacast: false });
    room.current = r;
    const studioPresent = () => setStudioHere([...r.remoteParticipants.values()].some((p) => p.identity === STUDIO));
    r.on(RoomEvent.ParticipantConnected, studioPresent)
      .on(RoomEvent.ParticipantDisconnected, studioPresent)
      .on(RoomEvent.TrackSubscribed, (tr: RemoteTrack, _pub, p) => {
        if (tr.kind !== Track.Kind.Audio || p.identity !== STUDIO) return;
        const el = tr.attach() as HTMLAudioElement;
        el.muted = !(stateRef.current === 'talk' || stateRef.current === 'live');
        back.current?.remove();
        back.current = el;
        document.body.appendChild(el);
      })
      .on(RoomEvent.DataReceived, (payload, p, _kind, topic) => {
        if (topic !== TOPIC || p?.identity !== STUDIO) return;
        try {
          const msg = JSON.parse(new TextDecoder().decode(payload)) as StudioMessage;
          if (msg.t === 'state') setState(msg.states[identity.current] ?? 'waiting');
          if (msg.t === 'bye') void r.disconnect().then(() => setPhase({ kind: 'ended', reason: 'removed' }));
        } catch {
          /* not ours */
        }
      })
      .on(RoomEvent.ConnectionQualityChanged, (q, p) => p.isLocal && setQuality(q))
      .on(RoomEvent.Reconnecting, () => setReconnecting(true))
      .on(RoomEvent.Reconnected, () => setReconnecting(false))
      .on(RoomEvent.Disconnected, (reason) => {
        track.current?.stop();
        back.current?.remove();
        setPhase((ph) => (ph.kind === 'ended' ? ph : { kind: 'ended', reason: reason === DisconnectReason.CLIENT_INITIATED ? 'left' : reason === DisconnectReason.PARTICIPANT_REMOVED ? 'removed' : 'lost' }));
      });
    try {
      await r.connect(joined.url, joined.token);
      await r.localParticipant.publishTrack(track.current, { source: Track.Source.Microphone, audioPreset: { maxBitrate: 48_000 }, dtx: false, red: true });
      // Browsers only play sound after a tap; the join button was one.
      await r.startAudio();
      studioPresent();
      setPhase({ kind: 'in', station: joined.station.name });
    } catch (err) {
      track.current?.stop();
      void r.disconnect();
      setError(t('reporter.connectFailed', { message: (err as Error).message }));
      setPhase({ kind: 'form' });
    }
  }

  const toggleMute = async () => {
    const tr = track.current;
    if (!tr) return;
    if (tr.isMuted) await tr.unmute();
    else await tr.mute();
    setMuted(tr.isMuted);
  };
  const leave = () => void room.current?.disconnect();

  const shell = (body: React.ReactNode, sub?: string) => (
    <div className="flex min-h-full flex-col bg-nacht text-white" style={{ paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' }}>
      <header className="flex items-center gap-3 border-b border-white/10 px-5 py-3">
        <span className="grid size-8 place-items-center rounded-lg bg-koraal">
          <Radio className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <b className="block truncate text-[15px]">{phase.kind === 'in' ? phase.station : t('reporter.title')}</b>
          <small className="block truncate text-xs text-white/60">{sub ?? t('reporter.subtitle')}</small>
        </div>
        <button onClick={() => void setLanguage(lang === 'nl' ? 'en' : 'nl')} className="rounded-full border border-white/20 px-3 py-1 text-xs font-semibold">
          {lang === 'nl' ? 'EN' : 'NL'}
        </button>
      </header>
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-4 px-5 py-6">{body}</main>
      <footer className="pb-4 text-center text-[11px] text-white/40">Powered by RHIS</footer>
    </div>
  );

  if (phase.kind === 'ended') {
    return shell(
      <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
        <p className="text-lg font-semibold">{t(`reporter.ended.${phase.reason}`)}</p>
        <button className="inline-flex items-center gap-2 rounded-xl bg-koraal px-5 py-3 font-bold" onClick={() => setPhase({ kind: 'form' })}>
          <RefreshCw className="size-4" /> {t('reporter.again')}
        </button>
      </div>,
    );
  }

  if (phase.kind === 'in') {
    const status = !studioHere ? 'noStudio' : muted ? 'selfMuted' : state;
    const qualityKey = quality === ConnectionQuality.Excellent ? 'excellent' : quality === ConnectionQuality.Good ? 'good' : quality === ConnectionQuality.Poor ? 'poor' : quality === ConnectionQuality.Lost ? 'lost' : 'unknown';
    return shell(
      <>
        <div
          data-testid="reporter-status"
          className={clsx(
            'grid gap-1 rounded-2xl border p-5 text-center',
            status === 'live' && 'border-koraal bg-koraal',
            status === 'talk' && 'border-[#C79BFF]/60 bg-[#C79BFF]/15',
            (status === 'waiting' || status === 'noStudio') && 'border-warning/50 bg-warning/10',
            (status === 'muted' || status === 'selfMuted') && 'border-offline/50 bg-offline/15',
          )}
        >
          <b className={clsx('text-2xl tracking-wide', status === 'talk' && 'text-[#C79BFF]', (status === 'waiting' || status === 'noStudio') && 'text-warning', (status === 'muted' || status === 'selfMuted') && 'text-offline')}>
            {t(`reporter.state.${status}`)}
          </b>
          <small className={status === 'live' ? 'text-white' : 'text-white/60'}>{t(`reporter.stateHint.${status}`)}</small>
        </div>
        <div className="flex h-16 items-end justify-center gap-1" aria-hidden>
          {Array.from({ length: 16 }, (_, i) => {
            const on = level * 16 * 1.6 > i;
            return <i key={i} className={clsx('w-2 rounded-sm transition-[height]', on ? (i > 13 ? 'bg-offline' : i > 10 ? 'bg-warning' : 'bg-online') : 'bg-white/10')} style={{ height: `${20 + i * 5}%` }} />;
          })}
        </div>
        {reconnecting && <p className="rounded-lg bg-warning/15 px-3 py-2 text-center text-[13px] text-warning">{t('reporter.reconnecting')}</p>}
        <dl className="grid gap-2 text-[13px]">
          <div className="flex justify-between">
            <dt className="text-white/60">{t('reporter.youHear')}</dt>
            <dd className="font-mono">{state === 'talk' || state === 'live' ? t('reporter.hearStudio') : t('reporter.hearNothing')}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-white/60">{t('reporter.connection')}</dt>
            <dd className={clsx('font-mono', qualityKey === 'poor' || qualityKey === 'lost' ? 'text-warning' : 'text-online')}>{t(`reporter.quality.${qualityKey}`)}</dd>
          </div>
        </dl>
        <button
          onClick={() => void toggleMute()}
          className={clsx('mx-auto mt-2 grid size-24 place-items-center rounded-full border-2 text-xs font-extrabold', muted ? 'border-offline bg-offline/20 text-offline' : 'border-white/20 bg-white/5')}
        >
          {muted ? <MicOff className="size-7" /> : <Mic className="size-7" />}
          {muted ? t('reporter.unmute') : t('reporter.mute')}
        </button>
        <button onClick={leave} className="mt-auto inline-flex items-center justify-center gap-2 rounded-xl border border-white/20 py-3 font-bold">
          <LogOut className="size-4" /> {t('reporter.leave')}
        </button>
      </>,
      `${name}${place ? ` · ${place}` : ''}`,
    );
  }

  const input = 'w-full rounded-xl border border-white/15 bg-white/5 px-3 py-3 text-[15px] text-white placeholder:text-white/35 focus:border-lucht focus:outline-none';
  return shell(
    <form onSubmit={(e) => void join(e)} className="flex flex-1 flex-col gap-4">
      <p className="text-[14px] text-white/70">{t('reporter.intro')}</p>
      <label className="grid gap-1.5 text-xs font-semibold text-white/70">
        {t('reporter.code')}
        <input
          className={clsx(input, 'text-center font-mono text-2xl tracking-[0.3em]')}
          inputMode="numeric"
          autoComplete="one-time-code"
          value={code.length > 3 ? `${code.slice(0, 3)} ${code.slice(3)}` : code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
          placeholder="000 000"
          required
        />
      </label>
      <label className="grid gap-1.5 text-xs font-semibold text-white/70">
        {t('reporter.name')}
        <input className={input} value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder={t('reporter.namePlaceholder')} required />
      </label>
      <label className="grid gap-1.5 text-xs font-semibold text-white/70">
        {t('reporter.place')}
        <input className={input} value={place} maxLength={60} onChange={(e) => setPlace(e.target.value)} placeholder={t('reporter.placePlaceholder')} />
      </label>
      {mics.length > 1 && (
        <label className="grid gap-1.5 text-xs font-semibold text-white/70">
          {t('reporter.mic')}
          <select className={input} value={mic} onChange={(e) => setMic(e.target.value)}>
            <option value="">{t('reporter.micDefault')}</option>
            {mics.map((m) => (
              <option key={m.deviceId} value={m.deviceId}>
                {m.label || m.deviceId.slice(0, 8)}
              </option>
            ))}
          </select>
        </label>
      )}
      {error && <p className="rounded-lg bg-offline/15 px-3 py-2 text-[13px] text-offline">{error}</p>}
      <button type="submit" disabled={phase.kind === 'joining' || code.length !== 6 || !name.trim()} className="mt-auto rounded-xl bg-koraal py-3.5 text-[15px] font-extrabold disabled:opacity-50">
        {phase.kind === 'joining' ? t('reporter.joining') : t('reporter.join')}
      </button>
      <p className="text-center text-[11px] text-white/45">{t('reporter.headset')}</p>
    </form>,
  );
}

export default ReporterPage;
