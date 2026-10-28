import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { AudioWaveform, Minus, Pause, Play, Plus, SkipBack, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { api, getApiKey, type Cues, type Media } from '../lib/api';
import { CUE_POINTS, type CueKey } from '../lib/cues';
import { call, type CueTrack, type PreviewState, type Waveform } from '../lib/native';
import { getSettings } from '../lib/settings';
import { useCanUpload, useSession } from '../lib/session';
import { Button, Dialog, Spinner } from './ui';

type CueTarget = Pick<Media, 'id' | 'title' | 'artist' | 'path' | 'durationSeconds'> & Cues;
type Values = Record<CueKey, number | null>;

/** Seconds shown in the zoomed view around the point being worked on. */
const ZOOM_SECONDS = 12;

const extOf = (path: string) => (/\.([a-z0-9]{1,5})$/i.exec(path)?.[1] ?? '').toLowerCase();
const valuesOf = (c: Cues): Values => ({ cueIn: c.cueIn ?? null, cueIntro: c.cueIntro ?? null, cueSegue: c.cueSegue ?? null, cueFadeOut: c.cueFadeOut ?? null, cueOut: c.cueOut ?? null });

/** m:ss.s */
export function fine(seconds: number | null) {
  if (seconds == null) return '–:––.–';
  const t = Math.max(0, seconds);
  const m = Math.floor(t / 60);
  return `${m}:${(t - m * 60).toFixed(1).padStart(4, '0')}`;
}

/** Managers edit cue points, on a server that stores them. */
export function useCanCue() {
  const { supports } = useSession();
  return useCanUpload() && supports('cues');
}

/** The button on a track row that opens the cue editor. */
export function CueButton({ onClick, set }: { onClick: () => void; set: boolean }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      title={t('cue.open')}
      aria-label={t('cue.open')}
      className={clsx('rounded p-1 hover:bg-hover', set ? 'text-accent-text' : 'text-muted hover:text-ink')}
    >
      <AudioWaveform className="size-3.5" />
    </button>
  );
}

export const hasCues = (c: Cues) => CUE_POINTS.some((p) => c[p.key] != null);

/**
 * The waveform between `from` and `to` seconds, with the cue points as coloured lines that can be dragged. A click
 * elsewhere moves the playhead there.
 */
function Wave({
  wave,
  from,
  to,
  values,
  position,
  height,
  onSeek,
  onMove,
  labels,
}: {
  wave: Waveform;
  from: number;
  to: number;
  values: Values;
  position: number;
  height: number;
  onSeek: (t: number) => void;
  onMove: (key: CueKey, t: number) => void;
  labels: boolean;
}) {
  const { t } = useTranslation();
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [drag, setDrag] = useState<CueKey | null>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(100, Math.round(e!.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const span = Math.max(0.001, to - from);
  const x = (s: number) => ((s - from) / span) * width;
  const timeAt = (clientX: number) => {
    const r = box.current!.getBoundingClientRect();
    return Math.min(wave.duration, Math.max(0, from + ((clientX - r.left) / r.width) * span));
  };
  // One bar per pixel: the loudest peak in its slice of time.
  const path = useMemo(() => {
    const mid = height / 2;
    let d = '';
    for (let px = 0; px < width; px++) {
      const a = Math.floor((from + (px / width) * span) * wave.perSecond);
      const b = Math.max(a + 1, Math.floor((from + ((px + 1) / width) * span) * wave.perSecond));
      let peak = 0;
      for (let i = Math.max(0, a); i < Math.min(b, wave.peaks.length); i++) peak = Math.max(peak, wave.peaks[i]!);
      const h = Math.max(0.5, (peak / 255) * (mid - 2));
      d += `M${px + 0.5} ${mid - h}V${mid + h}`;
    }
    return d;
  }, [wave, from, span, width, height]);
  const start = values.cueIn ?? 0;
  const end = values.cueOut ?? wave.duration;
  const shade = (a: number, b: number, cls: string, key: string) => {
    const l = Math.max(0, x(a));
    const r = Math.min(width, x(b));
    return r > l ? <div key={key} className={clsx('pointer-events-none absolute inset-y-0', cls)} style={{ left: l, width: r - l }} /> : null;
  };
  const down = (e: ReactPointerEvent<HTMLDivElement>, key: CueKey | null) => {
    e.preventDefault();
    if (key) {
      e.currentTarget.setPointerCapture(e.pointerId);
      setDrag(key);
    } else onSeek(timeAt(e.clientX));
  };
  return (
    <div ref={box} className="relative cursor-text overflow-hidden rounded-md bg-nacht select-none" style={{ height }} onPointerDown={(e) => down(e, null)}>
      <svg width={width} height={height} className="absolute inset-0" aria-hidden>
        <path d={path} stroke="var(--lucht)" strokeOpacity={0.85} strokeWidth={1} />
      </svg>
      {shade(from, start, 'bg-black/55', 'pre')}
      {shade(end, to, 'bg-black/55', 'post')}
      {values.cueIntro != null && shade(start, values.cueIntro, 'bg-lucht/15', 'intro')}
      {values.cueSegue != null && shade(values.cueSegue, end, 'bg-koraal/20', 'segue')}
      {CUE_POINTS.map((p) => {
        const v = values[p.key];
        if (v == null || v < from || v > to) return null;
        return (
          <div
            key={p.key}
            className={clsx('absolute inset-y-0 -ml-2 w-4 cursor-ew-resize', drag === p.key && 'z-10')}
            style={{ left: x(v) }}
            onPointerDown={(e) => {
              e.stopPropagation();
              down(e, p.key);
            }}
            onPointerMove={(e) => drag === p.key && onMove(p.key, timeAt(e.clientX))}
            onPointerUp={() => setDrag(null)}
            title={t(`cue.${p.key}`)}
          >
            <div className="absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2" style={{ background: p.color }} />
            {labels && (
              <div className="absolute top-0 left-1/2 rounded-b px-1 text-[9px] font-extrabold whitespace-nowrap text-nacht uppercase" style={{ background: p.color }}>
                {t(`cue.short.${p.key}`)}
              </div>
            )}
          </div>
        );
      })}
      {position >= from && position <= to && <div className="pointer-events-none absolute inset-y-0 w-px bg-white" style={{ left: x(position) }} />}
    </div>
  );
}

/**
 * The cue editor: the waveform of a library track with its five cue points, stored on the server so the AutoDJ and
 * every studio use them. The track is heard on the preview output (off air).
 */
export function CueEditor({ stationId, track, onClose }: { stationId: string; track: CueTarget; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const name = [track.artist, track.title || track.path].filter(Boolean).join(' – ');
  const loaded = useQuery({
    queryKey: ['cue', track.id],
    queryFn: () =>
      call<CueTrack>('cue_open', {
        url: `${getSettings().server}/api/stations/${stationId}/library/${track.id}/audio`,
        token: getApiKey() ?? '',
        name,
        ext: extOf(track.path),
      }),
    retry: false,
    gcTime: 0,
    staleTime: Infinity,
  });
  const preview = useQuery({
    queryKey: ['preview'],
    queryFn: () => call<PreviewState>('preview_state'),
    enabled: loaded.isSuccess,
    refetchInterval: 100,
  });
  const [values, setValues] = useState<Values>(() => valuesOf(track));
  const [focus, setFocus] = useState<CueKey | null>(null);
  const wave = loaded.data?.waveform;
  const position = preview.data?.position ?? 0;
  const playing = !!preview.data?.playing;
  const length = wave?.duration || track.durationSeconds || 0;

  const run = async (cmd: string, args?: Record<string, unknown>) => {
    try {
      qc.setQueryData(['preview'], await call<PreviewState>(cmd, args));
    } catch (err) {
      toast.error(String((err as Error).message ?? err));
    }
  };
  const seek = (s: number) => void run('preview_seek', { seconds: Math.max(0, Math.min(length, s)) });
  const playFrom = async (s: number) => {
    await run('preview_seek', { seconds: Math.max(0, Math.min(length, s)) });
    if (!playing) await run('preview_toggle');
  };
  const set = (key: CueKey, v: number | null) => {
    setValues((c) => ({ ...c, [key]: v == null ? null : Math.round(Math.max(0, Math.min(length, v)) * 100) / 100 }));
    setFocus(key);
  };

  // Space plays and pauses; 1–5 put a cue point on the playhead.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === ' ') {
        e.preventDefault();
        void run('preview_toggle');
      }
      const n = Number(e.key);
      if (n >= 1 && n <= CUE_POINTS.length) set(CUE_POINTS[n - 1]!.key, position);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  // Listening stops when the editor closes.
  const close = () => {
    void call('preview_stop').then(() => qc.setQueryData(['preview'], undefined));
    onClose();
  };

  const save = useMutation({
    mutationFn: () => api<Media>(`/stations/${stationId}/library/${track.id}`, { method: 'PATCH', body: { cues: values } }),
    onSuccess: () => {
      toast.success(t('cue.saved'));
      void qc.invalidateQueries({ queryKey: ['autodj', stationId] });
      void qc.invalidateQueries({ queryKey: ['library', stationId] });
      void qc.invalidateQueries({ queryKey: ['rundown', stationId] });
      close();
    },
    onError: (err) => toast.error((err as Error).message),
  });

  // The zoomed view follows the point being worked on, or the playhead.
  const centre = focus && values[focus] != null ? values[focus]! : position;
  const zFrom = Math.max(0, Math.min(length - ZOOM_SECONDS, centre - ZOOM_SECONDS / 2));
  const zTo = Math.min(length, zFrom + ZOOM_SECONDS);
  const changed = CUE_POINTS.some((p) => values[p.key] !== (track[p.key] ?? null));

  return (
    <Dialog
      open
      onClose={close}
      width="sm:max-w-5xl"
      title={t('cue.title')}
      description={name}
      footer={
        <>
          <Button variant="ghost" className="mr-auto" onClick={() => setValues(valuesOf({}))} disabled={!CUE_POINTS.some((p) => values[p.key] != null)}>
            {t('cue.clearAll')}
          </Button>
          <Button variant="secondary" onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!changed || !wave}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      {loaded.isPending ? (
        <div className="grid h-64 place-items-center gap-2 text-[13px] text-muted">
          <div className="grid justify-items-center gap-2">
            <Spinner />
            {t('cue.loading')}
          </div>
        </div>
      ) : loaded.isError || !wave ? (
        <p className="py-10 text-center text-[13px] text-offline">{String((loaded.error as Error)?.message ?? loaded.error)}</p>
      ) : (
        <div className="grid gap-3">
          <Wave wave={wave} from={0} to={length} values={values} position={position} height={84} onSeek={seek} onMove={set} labels={false} />
          <Wave wave={wave} from={zFrom} to={zTo} values={values} position={position} height={150} onSeek={seek} onMove={set} labels />
          <div className="flex items-center gap-2">
            <Button variant="dark" className="size-10 px-0" onClick={() => void run('preview_toggle')} aria-label={playing ? t('library.pause') : t('playout.play')}>
              {playing ? <Pause className="size-4 fill-current" /> : <Play className="size-4 fill-current" />}
            </Button>
            <Button variant="secondary" size="sm" onClick={() => void playFrom(values.cueIn ?? 0)}>
              <SkipBack className="size-3.5" /> {t('cue.fromStart')}
            </Button>
            {values.cueSegue != null && (
              <Button variant="secondary" size="sm" onClick={() => void playFrom(values.cueSegue! - 6)}>
                {t('cue.hearSegue')}
              </Button>
            )}
            <span className="ml-auto font-mono text-[13px] tabular">
              {fine(position)} <span className="text-muted">/ {fine(length)}</span>
            </span>
          </div>
          <div className="divide-y divide-line rounded-md border border-line">
            {CUE_POINTS.map((p, n) => {
              const v = values[p.key];
              return (
                <div key={p.key} className={clsx('flex items-center gap-3 px-3 py-2', focus === p.key && 'bg-chip/60')}>
                  <span className="size-3 shrink-0 rounded-full" style={{ background: p.color }} />
                  <button type="button" className="min-w-0 flex-1 text-left" onClick={() => (v != null ? (setFocus(p.key), seek(v)) : undefined)}>
                    <div className="text-[13px] font-semibold">
                      {t(`cue.${p.key}`)} <span className="ml-1 rounded bg-chip px-1 font-mono text-[10px] text-muted">{n + 1}</span>
                    </div>
                    <div className="truncate text-[11px] text-muted">{t(`cue.help.${p.key}`)}</div>
                  </button>
                  <span className={clsx('w-16 text-right font-mono text-[13px] tabular', v == null && 'text-muted')}>{fine(v)}</span>
                  <div className="flex items-center gap-1">
                    <button type="button" disabled={v == null} onClick={() => set(p.key, v! - 0.1)} className="rounded p-1 text-muted hover:bg-hover hover:text-ink disabled:opacity-30" aria-label={t('cue.earlier')} title={t('cue.earlier')}>
                      <Minus className="size-3.5" />
                    </button>
                    <button type="button" disabled={v == null} onClick={() => set(p.key, v! + 0.1)} className="rounded p-1 text-muted hover:bg-hover hover:text-ink disabled:opacity-30" aria-label={t('cue.later')} title={t('cue.later')}>
                      <Plus className="size-3.5" />
                    </button>
                    <button type="button" disabled={v == null} onClick={() => void playFrom(p.key === 'cueIn' || p.key === 'cueIntro' ? v! : v! - 4)} className="rounded p-1 text-muted hover:bg-hover hover:text-ink disabled:opacity-30" aria-label={t('cue.listen')} title={t('cue.listen')}>
                      <Play className="size-3.5" />
                    </button>
                    <Button size="sm" variant="secondary" onClick={() => set(p.key, position)}>
                      {t('cue.setHere')}
                    </Button>
                    <button type="button" disabled={v == null} onClick={() => set(p.key, null)} className="rounded p-1 text-muted hover:bg-hover hover:text-offline disabled:opacity-30" aria-label={t('cue.remove')} title={t('cue.remove')}>
                      <X className="size-3.5" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
          <p className="text-[11px] text-muted">{t('cue.keys')}</p>
        </div>
      )}
    </Dialog>
  );
}
