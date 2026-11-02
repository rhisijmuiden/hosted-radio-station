import clsx from 'clsx';
import { AlertTriangle, Lock, Mic, MicOff, Play, Radio, SkipForward, Square } from 'lucide-react';
import { useEffect, useState, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Badge, Button, Dialog } from './ui';
import { ApiError, type AutoDj } from '../lib/api';
import { playLength } from '../lib/cues';
import { useEngine } from '../lib/engine';
import { duration } from '../lib/format';
import { ask, call, type AppInfo } from '../lib/native';
import { useNow } from '../lib/now';
import { useAutoDj } from '../lib/queries';
import { clock, DRAG, queueOf } from '../lib/queue';
import { useSession } from '../lib/session';
import { studio, useStudio, type StudioTrack } from '../lib/studio';
import { addLocalFile, DRAG_FILE, DRAG_MEDIA, useCanUpload } from './Library';

let hostname: string | null = null;
/** The name of this PC, as studio mode reports it to the server. */
function useHostname() {
  const [name, setName] = useState(hostname);
  useEffect(() => {
    if (!hostname) void call<AppInfo>('app_info').then((i) => setName((hostname = i.hostname)));
  }, []);
  return name;
}

/** Studio mode can be used here: a Radio station on a server that has it. */
export function useStudioAvailable() {
  const { station, supports } = useSession();
  return !!station && station.edition === 'station' && supports('studio-mode');
}

/** AutoDJ or Studio mode, in the top bar: who plays the queue. */
export function StudioModeSwitch() {
  const { t } = useTranslation();
  const { station } = useSession();
  const available = useStudioAvailable();
  const autodj = useAutoDj(available ? station?.id : undefined);
  const phase = useStudio((s) => s.phase);
  const here = useHostname();
  const [open, setOpen] = useState(false);
  if (!available || !station) return null;
  const mine = phase !== 'off' && phase !== 'lost';
  const elsewhere = !mine && autodj.data?.studio?.active && autodj.data.studio.pc !== here ? autodj.data.studio : null;
  const back = async () => {
    if (await ask(t('studio.backConfirm'))) void studio.stop();
  };
  return (
    <>
      <div role="group" aria-label={t('studio.modeLabel')} className="flex shrink-0 rounded-md border border-line bg-surface p-0.5">
        <button
          type="button"
          aria-pressed={!mine}
          onClick={() => (phase === 'waiting' ? studio.cancel() : mine ? void back() : undefined)}
          className={clsx('h-8 rounded-[7px] px-3 text-[12.5px] font-bold transition-colors', !mine ? 'bg-online/15 text-online' : 'text-muted hover:text-ink')}
        >
          {t('studio.autodj')}
        </button>
        <button
          type="button"
          aria-pressed={mine}
          disabled={!!elsewhere || !autodj.data}
          title={elsewhere ? t('studio.otherPc', { pc: elsewhere.pc, user: elsewhere.user ? `(${elsewhere.user})` : '' }) : t('studio.modeHint')}
          onClick={() => !mine && setOpen(true)}
          className={clsx(
            'h-8 rounded-[7px] px-3 text-[12.5px] font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-60',
            mine ? 'bg-studio text-nacht' : 'text-muted hover:text-ink',
          )}
        >
          {elsewhere ? t('studio.onPc', { pc: elsewhere.pc }) : t('studio.mode')}
        </button>
      </div>
      {open && autodj.data && <TakeOverDialog data={autodj.data} onClose={() => setOpen(false)} />}
    </>
  );
}

const trackTitle = (m: { title: string; path: string } | undefined | null) => (m ? m.title || m.path : '');

/** Take over: at the end of the track on air, or now with that same track. */
function TakeOverDialog({ data, onClose }: { data: AutoDj; onClose: () => void }) {
  const { t } = useTranslation();
  const { station, me } = useSession();
  const now = useNow(500);
  const [how, setHow] = useState<'end' | 'now'>('end');
  const np = data.nowPlaying;
  const crossfade = data.settings.crossfadeSeconds ?? 0;
  const length = np ? playLength(np.media, crossfade) : null;
  const left = np?.startedAt && length != null ? Math.max(0, (new Date(np.startedAt).getTime() + length * 1000 - now) / 1000) : null;
  const next = queueOf(data).find((q) => q.state === 'cued') ?? queueOf(data)[0];
  const go = () => {
    if (!station) return;
    onClose();
    studio.start(station, me, data, how === 'now' && np ? 'now' : 'end', { notReady: t('studio.needsLive'), noOutput: t('studio.noOutput') }).catch((err) => toast.error((err as Error).message));
  };
  const option = (value: 'end' | 'now', title: string, text: string, disabled = false) => (
    <label
      className={clsx(
        'flex cursor-pointer gap-3 rounded-md border px-4 py-3',
        how === value ? 'border-studio bg-studio/10' : 'border-line hover:bg-hover',
        disabled && 'cursor-not-allowed opacity-50',
      )}
    >
      <input type="radio" name="takeover" className="mt-1 accent-[var(--studio)]" checked={how === value} disabled={disabled} onChange={() => setHow(value)} />
      <span>
        <span className="block text-sm font-bold">{title}</span>
        <span className="mt-0.5 block text-[13px] text-muted">{text}</span>
      </span>
    </label>
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('studio.takeOverTitle')}
      description={t('studio.takeOverText')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" className="bg-studio" onClick={go}>
            <Radio className="size-4" /> {t('studio.takeOver')}
          </Button>
        </>
      }
    >
      <div className="grid gap-2.5">
        {option(
          'end',
          t('studio.atEnd'),
          np && left != null ? (next ? t('studio.atEndText', { title: trackTitle(np.media), time: duration(left), next: trackTitle(next.media) }) : t('studio.atEndNoNext', { title: trackTitle(np.media), time: duration(left) })) : t('studio.atEndIdle'),
        )}
        {option('now', t('studio.now'), t('studio.nowText'), !np?.startedAt)}
        <p className="mt-1 flex items-start gap-2 text-[12.5px] text-muted">
          <MicOff className="mt-0.5 size-3.5 shrink-0" /> {t('studio.micNote')}
        </p>
      </div>
    </Dialog>
  );
}

/** Reasons studio mode ended that the banner translates; any other text is the encoder's own error. */
const LOST_REASONS = ['noBroadcast', 'broadcastLost', 'serverLost'];

/** The line under the top bar while studio mode runs, waits or has ended by itself. */
export function StudioBanner() {
  const { t } = useTranslation();
  const { station } = useSession();
  const { me } = useSession();
  const s = useStudio((v) => v);
  const now = useNow(500);
  const autodj = useAutoDj(s.phase === 'lost' ? station?.id : undefined);
  if (s.phase === 'off' || !station || s.stationId !== station.id) return null;
  const back = async () => {
    if (await ask(t('studio.backConfirm'))) void studio.stop();
  };
  const takeBack = () => {
    if (!autodj.data) return;
    studio.start(station, me, autodj.data, 'now', { notReady: t('studio.needsLive'), noOutput: t('studio.noOutput') }).catch((err) => toast.error((err as Error).message));
  };
  const tone = s.phase === 'lost' ? 'bg-offline/15 text-offline' : s.phase === 'on' || s.phase === 'stopping' ? 'bg-studio/15 text-ink' : 'bg-lucht/20 text-ink';
  return (
    <div className={clsx('flex items-center gap-3 border-b border-line px-5 py-2 text-[13px]', tone)} role="status">
      {s.phase === 'lost' ? <AlertTriangle className="size-4 shrink-0" /> : <i className={clsx('size-2.5 shrink-0 rounded-full', s.phase === 'on' ? 'onair-pulse bg-studio' : 'bg-lucht')} />}
      <span className="min-w-0 flex-1">
        {s.phase === 'on' && (
          <>
            <b>{t('studio.mode')}</b> · {t('studio.banner')}
          </>
        )}
        {s.phase === 'preparing' && t('studio.preparing')}
        {s.phase === 'stopping' && t('studio.stopping')}
        {s.phase === 'waiting' && t('studio.waiting', { title: trackTitle(s.first?.media) || '–', time: duration(Math.max(0, ((s.waitUntil ?? now) - now) / 1000)) })}
        {s.phase === 'lost' && (
          <>
            <b>{t('studio.lostTitle', { time: clock(s.lostAt ?? now) })}</b> {t('studio.lost')}
            {s.error && <span className="ml-1 opacity-80">({LOST_REASONS.includes(s.error) ? t(`studio.${s.error}`) : t('studio.encoderSaid', { error: s.error })})</span>}
          </>
        )}
      </span>
      {s.phase === 'on' && (
        <Button size="sm" variant="secondary" onClick={() => void back()}>
          {t('studio.back')}
        </Button>
      )}
      {s.phase === 'waiting' && (
        <Button size="sm" variant="secondary" onClick={() => studio.cancel()}>
          {t('common.cancel')}
        </Button>
      )}
      {s.phase === 'lost' && (
        <>
          <Button size="sm" variant="secondary" onClick={() => void studio.stop()}>
            {t('common.close')}
          </Button>
          <Button size="sm" variant="primary" disabled={!autodj.data} onClick={takeBack}>
            {t('studio.takeBack')}
          </Button>
        </>
      )}
    </div>
  );
}

/** The space bar switches the microphone in studio mode (not while typing). */
export function StudioHotkeys() {
  const phase = useStudio((s) => s.phase);
  useEffect(() => {
    if (phase !== 'on') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat || e.ctrlKey || e.altKey || e.metaKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName))) return;
      e.preventDefault();
      studio.mic();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [phase]);
  return null;
}

/** The big microphone button of studio mode. */
export function MicButton() {
  const { t } = useTranslation();
  const mic = useStudio((s) => s.mic);
  const level = useEngine((s) => s.info?.input);
  return (
    <button
      type="button"
      aria-pressed={mic}
      onClick={() => studio.mic()}
      title={t('studio.micHint')}
      className={clsx(
        'flex h-14 w-full items-center justify-center gap-3 rounded-md border-2 text-[15px] font-extrabold tracking-[0.1em] uppercase transition-colors',
        mic ? 'onair-pulse border-onair bg-onair text-white' : 'border-line bg-surface text-muted hover:border-studio hover:text-ink',
      )}
    >
      {mic ? <Mic className="size-5" /> : <MicOff className="size-5" />}
      <span>{mic ? t('studio.micOn') : t('studio.micOff')}</span>
      <span className="text-[10.5px] font-semibold tracking-normal normal-case opacity-80">
        {t('studio.micKey')}
        {level ? ` · ${level}` : ''}
      </span>
    </button>
  );
}

function Counter({ label, value, warn, intro }: { label: string; value: string; warn?: boolean; intro?: boolean }) {
  return (
    <div className={clsx(intro && 'rounded-[5px] bg-lucht/25 px-2 py-0.5 text-right')}>
      <div className="text-[9px] font-bold tracking-[0.08em] text-muted uppercase">{label}</div>
      <div className={clsx('display leading-none tabular', intro ? 'text-[20px]' : 'text-[30px]', warn && 'text-accent-text')}>{value}</div>
    </div>
  );
}

/**
 * Players A and B in studio mode: they play here, on this PC. The one on air counts down to its end; the other one has
 * the next track of the queue, loaded from the server and ready on this PC.
 */
export function StudioDecks({ data }: { data: AutoDj }) {
  const { t } = useTranslation();
  const s = useStudio((v) => v);
  const decks = useEngine((e) => e.decks);
  const canUpload = useCanUpload();
  const manual = !!data.playout?.manual;
  useEffect(() => studio.manual(manual), [manual]);
  const air = s.air;
  const onAir = air != null ? s.tracks[air] : null;
  const nextIdx = s.tracks.findIndex((tr, i) => tr && i !== air && !decks[i]?.playing);
  const blocked = !!onAir?.locked && !canUpload;
  const { station } = useSession();
  const [over, setOver] = useState<number | null>(null);
  const kinds = [DRAG, DRAG_MEDIA, ...(canUpload ? [DRAG_FILE] : [])];
  // A drop on the player on air plays the track now; on the other one it is next. Managers are asked before a locked
  // item of the hour clock gives way.
  const load = async (what: { itemId: string } | { mediaId: string }, now: boolean) => {
    try {
      await studio.load(what, { now });
    } catch (err) {
      if (canUpload && err instanceof ApiError && (err.status === 409 || err.status === 400) && /locked/i.test(err.message) && (await ask(`${err.message} ${t('studio.replaceLocked')}`))) {
        await studio.load(what, { now, force: true }).catch((e) => toast.error((e as Error).message));
      } else toast.error((err as Error).message);
    }
  };
  const drop = (i: number, isAir: boolean) => ({
    onDragOver: (e: DragEvent) => {
      if ((isAir && blocked) || !kinds.some((k) => e.dataTransfer.types.includes(k))) return;
      e.preventDefault();
      setOver(i);
    },
    onDragLeave: () => setOver(null),
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      setOver(null);
      const itemId = e.dataTransfer.getData(DRAG);
      const mediaId = e.dataTransfer.getData(DRAG_MEDIA);
      const file = e.dataTransfer.getData(DRAG_FILE);
      if (itemId) void load({ itemId }, isAir);
      else if (mediaId) void load({ mediaId }, isAir);
      else if (file && canUpload && station) void addLocalFile(station.id, file, 'q1', 'top', (v) => void load({ mediaId: v.mediaId }, isAir), t);
    },
  });

  const deck = (i: number) => {
    const track: StudioTrack | null = s.tracks[i] ?? null;
    const st = decks[i];
    const playing = !!st?.playing;
    const isAir = i === air && playing;
    const isNext = i === nextIdx;
    const length = st && st.end > 0 ? st.end - st.start : track ? (track.media.cueOut ?? track.media.durationSeconds ?? 0) - (track.media.cueIn ?? 0) : null;
    const remaining = st && playing && st.end > 0 ? Math.max(0, st.end - st.position) : null;
    const elapsed = st && playing ? st.position - (track?.media.cueIn ?? st.start) : 0;
    const intro = track && playing && track.media.cueIntro != null ? track.media.cueIntro - (track.media.cueIn ?? 0) - elapsed : null;
    const pct = st && playing && st.end > st.start ? Math.min(100, ((st.position - st.start) / (st.end - st.start)) * 100) : 0;
    const startsIn = isNext && air != null && decks[air]?.playing ? Math.max(0, (decks[air]!.nextAt || decks[air]!.end) - decks[air]!.position) : null;
    return (
      <div
        key={i}
        {...drop(i, isAir)}
        className={clsx(
          'relative flex min-w-0 flex-col gap-2 rounded-md border p-3',
          isAir ? 'border-studio/70 bg-studio/[0.08]' : 'border-line bg-surface',
          st?.fading && 'opacity-60',
          over === i && 'ring-2 ring-studio',
        )}
      >
        {over === i && (
          <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center rounded-md bg-studio/15 text-center text-xs font-extrabold tracking-[0.08em] text-ink uppercase">
            {isAir ? t('assist.dropToPlay') : t('decks.dropNext')}
          </div>
        )}
        <span className={clsx('absolute top-3 right-3 grid size-6 place-items-center rounded-[5px] text-[13px] font-extrabold text-nacht', i === 0 ? 'bg-lucht' : 'bg-online/70')}>{i === 0 ? 'A' : 'B'}</span>
        <div className="min-w-0 pr-8">
          <div className="flex flex-wrap items-center gap-1.5 text-[10px] font-bold tracking-[0.08em] text-muted uppercase">
            {isAir ? t('studio.playingHere') : isNext ? t('assist.cued') : t('studio.empty')}
            {track && (isAir ? <Badge tone="accent">{t('studio.local')}</Badge> : st?.ready ? <Badge tone="online">{t('studio.ready')}</Badge> : <Badge tone="warning">{t('studio.loading')}</Badge>)}
            {track?.locked && (
              <span className="inline-flex items-center gap-1 rounded-full bg-koraal/15 px-1.5 py-px text-accent-text normal-case" title={t('assist.lockedHint')}>
                <Lock className="size-2.5" /> {t('assist.locked')}
              </span>
            )}
          </div>
          <div className="display truncate text-[16px] leading-tight">{track ? track.media.title || track.media.path : s.fetching && !isAir ? t('studio.fetching') : t('assist.nothing')}</div>
          <div className="truncate text-[12px] text-muted">
            {track ? [track.media.artist, startsIn != null && !manual ? t('studio.startsIn', { time: duration(startsIn) }) : isNext && manual ? t('playout.pressPlay') : null].filter(Boolean).join(' · ') : ' '}
          </div>
        </div>
        <div className="flex items-end justify-between gap-2">
          {isAir ? <Counter label={t('assist.remainingLabel')} value={remaining != null ? `-${duration(remaining)}` : '–:––'} warn={remaining != null && remaining < 15} /> : <Counter label={t('playout.length')} value={duration(length)} />}
          {intro != null && intro > 0 && <Counter label={t('assist.intro')} value={String(Math.ceil(intro))} warn={intro < 5} intro />}
        </div>
        <div className="relative h-1.5 overflow-hidden rounded-full bg-meter">
          <div className={clsx('relative h-full', isAir ? 'bg-studio' : 'bg-koraal')} style={{ width: `${pct}%` }} />
        </div>
        <div className="flex gap-1.5">
          {isAir ? (
            <>
              {manual && (
                <Button variant="secondary" onClick={() => studio.stopTrack()} title={t('playout.stop')} aria-label={t('playout.stop')} className="h-9 flex-1 px-0">
                  <Square className="size-3.5 fill-current" />
                </Button>
              )}
              <Button
                variant="primary"
                onClick={() => studio.next()}
                disabled={nextIdx < 0 || !decks[nextIdx]?.ready || blocked}
                title={blocked ? t('assist.lockedHint') : t('assist.nextHint')}
                className="h-9 flex-[2] px-2"
              >
                <SkipForward className="size-4" /> {t('playout.next')}
              </Button>
            </>
          ) : (
            <Button
              variant={manual && air == null ? 'dark' : 'secondary'}
              onClick={() => studio.next()}
              disabled={!isNext || !st?.ready || (blocked && air != null)}
              title={t('decks.startNow')}
              className={clsx('h-9 flex-1 px-2', manual && air == null && isNext && 'onair-pulse')}
            >
              <Play className="size-4 fill-current" /> {manual && air == null ? t('playout.play') : t('decks.startNow')}
            </Button>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="grid gap-2.5">
      <div className="grid grid-cols-2 gap-2.5">{[deck(0), deck(1)]}</div>
      <MicButton />
      {s.error && s.phase === 'on' && <p className="text-[12px] text-warning">{s.error}</p>}
    </div>
  );
}
