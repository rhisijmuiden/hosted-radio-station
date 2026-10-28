import clsx from 'clsx';
import { Minus, Pause, Play, Plus, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card } from './ui';
import type { AutoDj } from '../lib/api';
import { trackLength } from '../lib/cues';
import { useEngine } from '../lib/engine';
import { useLayout, type Countdown } from '../lib/layout';
import { useNow } from '../lib/now';
import { useStatus } from '../lib/queries';
import type { Block } from '../lib/timeline';

/** 1:02:03 or 02:03: the countdown reads like a clock. */
const hms = (seconds: number) => {
  const s = Math.max(0, Math.ceil(seconds));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
};

/** The DJ's own timer, for a talk or an interview: set its length, start, pause, reset. Its length is in the profile. */
function useTimer(length: number) {
  const [endAt, setEndAt] = useState<number | null>(null);
  const [left, setLeft] = useState<number | null>(null);
  const now = useNow(250);
  const running = endAt != null;
  const value = running ? Math.max(0, (endAt - now) / 1000) : (left ?? length);
  return {
    running,
    value,
    toggle: () => {
      if (running) {
        setLeft(value);
        setEndAt(null);
      } else setEndAt(Date.now() + (value > 0 ? value : length) * 1000);
    },
    reset: () => {
      setEndAt(null);
      setLeft(null);
    },
  };
}

/**
 * The dashboard of the OmniPlayer layout: a big clock, a big red countdown and a few tiles. The countdown counts to the
 * next fixed block, the end of the track on air or the DJ's own timer; the choice is kept in the DJ profile.
 */
export function Dashboard({ data, stationId, blocks }: { data: AutoDj; stationId: string; blocks: Block[] }) {
  const { t, i18n } = useTranslation();
  const now = useNow(250);
  const [layout, setLayout] = useLayout();
  const timer = useTimer(layout.timerSeconds);
  const status = useStatus(stationId);
  const live = useEngine((s) => s.broadcast.state) === 'live';
  const mode = layout.countdown;

  const block = blocks.find((b) => b.at > now);
  const np = data.playout?.holding ? null : data.nowPlaying;
  const total = np ? trackLength(np.media) : null;
  const trackLeft = np?.startedAt && total != null ? total - (now - new Date(np.startedAt).getTime()) / 1000 : null;
  const value = mode === 'block' ? (block ? (block.at - now) / 1000 : null) : mode === 'track' ? trackLeft : timer.value;
  const label =
    mode === 'block'
      ? block
        ? t('dashboard.toBlock', { label: block.items[0]?.label || t('rundown.fixed') })
        : t('dashboard.noBlock')
      : mode === 'track'
        ? t('dashboard.toTrackEnd')
        : timer.running
          ? t('dashboard.timerRunning')
          : t('dashboard.timer');
  const modes: { value: Countdown; label: string }[] = [
    { value: 'block', label: t('dashboard.block') },
    { value: 'track', label: t('dashboard.track') },
    { value: 'timer', label: t('dashboard.timer') },
  ];
  const nudge = (d: number) => setLayout({ timerSeconds: Math.min(5940, Math.max(10, layout.timerSeconds + d)) });

  return (
    <Card className="flex w-[300px] shrink-0 flex-col gap-2.5 p-3">
      <div className="rounded-md border border-line bg-surface py-2 text-center">
        <div className="display text-[38px] leading-none tabular">{new Date(now).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</div>
        <div className="mt-1 text-[10px] font-bold tracking-[0.08em] text-muted uppercase">{new Date(now).toLocaleDateString(i18n.language, { weekday: 'long', day: 'numeric', month: 'long' })}</div>
      </div>
      <div className="rounded-md border border-line bg-surface py-2 text-center">
        <div className={clsx('display text-[38px] leading-none tabular text-offline', value != null && value <= 0 && mode === 'timer' && 'onair-pulse')}>{value != null ? hms(value) : '––:––'}</div>
        <div className="mt-1 truncate px-2 text-[10px] font-bold tracking-[0.08em] text-muted uppercase">{label}</div>
      </div>
      <div role="group" aria-label={t('dashboard.countdown')} className="flex gap-1">
        {modes.map((m) => (
          <button
            key={m.value}
            type="button"
            aria-pressed={mode === m.value}
            onClick={() => setLayout({ countdown: m.value })}
            className={clsx(
              'flex-1 rounded-full border px-1.5 py-0.5 text-[11px] font-bold whitespace-nowrap transition-colors',
              mode === m.value ? 'border-koraal text-accent-text' : 'border-line text-muted hover:text-ink',
            )}
          >
            {m.label}
          </button>
        ))}
      </div>
      {mode === 'timer' && (
        <div className="flex gap-1">
          <button type="button" onClick={() => nudge(-30)} disabled={timer.running} title={t('dashboard.shorter')} aria-label={t('dashboard.shorter')} className="grid h-8 flex-1 place-items-center rounded-md border border-line hover:bg-hover disabled:opacity-40">
            <Minus className="size-3.5" />
          </button>
          <button type="button" onClick={timer.toggle} title={timer.running ? t('dashboard.pause') : t('dashboard.start')} aria-label={timer.running ? t('dashboard.pause') : t('dashboard.start')} className="grid h-8 flex-[2] place-items-center rounded-md bg-koraal text-nacht hover:brightness-95">
            {timer.running ? <Pause className="size-4 fill-current" /> : <Play className="size-4 fill-current" />}
          </button>
          <button type="button" onClick={timer.reset} title={t('dashboard.reset')} aria-label={t('dashboard.reset')} className="grid h-8 flex-1 place-items-center rounded-md border border-line hover:bg-hover">
            <RotateCcw className="size-3.5" />
          </button>
          <button type="button" onClick={() => nudge(30)} disabled={timer.running} title={t('dashboard.longer')} aria-label={t('dashboard.longer')} className="grid h-8 flex-1 place-items-center rounded-md border border-line hover:bg-hover disabled:opacity-40">
            <Plus className="size-3.5" />
          </button>
        </div>
      )}
      <div className="grid grid-cols-2 gap-1.5">
        <div className={clsx('rounded-md border px-2 py-1.5 text-center text-[11px] font-extrabold tracking-[0.06em] uppercase', live ? 'border-onair bg-onair text-white' : 'border-line text-muted')}>
          {live ? t('dashboard.onAir') : t('dashboard.offAir')}
        </div>
        <div className="rounded-md border border-line px-2 py-1.5 text-center text-[11px] font-bold text-muted">{t('dashboard.listeners', { count: status.data?.listeners ?? 0 })}</div>
      </div>
    </Card>
  );
}
