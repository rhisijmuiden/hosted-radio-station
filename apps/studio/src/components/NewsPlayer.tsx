import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { Lock, Newspaper, Play, Square } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Card } from './ui';
import { api, getApiKey, type NewsView } from '../lib/api';
import { clearCartError, useEngine } from '../lib/engine';
import { duration } from '../lib/format';
import { call } from '../lib/native';
import { useNow } from '../lib/now';
import { useCanUpload } from '../lib/session';
import { getSettings, updateSettings, useSettings } from '../lib/settings';

/** The engine slot of the news player; unlike the single player it never ducks under the microphone. */
export const NEWS_SLOT = 146;
/** A news time stays the current one this long, so a late start is still possible. */
const GRACE_MS = 2 * 60_000;
/** Auto starts the bulletin only this close after the news time, never much later. */
const AUTO_WINDOW_MS = 60_000;
const clock = (ms: number) => new Date(ms).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });

export const useNews = (stationId: string, enabled = true) =>
  useQuery({ queryKey: ['news', stationId], queryFn: () => api<NewsView>(`/stations/${stationId}/news`), enabled, refetchInterval: 30_000 });

interface Pick {
  key: string;
  title: string;
  url: string;
  name: string;
  spare: boolean;
}

/** What plays at the news time: the bulletin when it is fresh for that time, otherwise the spare jingle. */
function choose(stationId: string, v: NewsView, fresh: boolean): Pick | null {
  const base = `${getSettings().server}/api/stations/${stationId}/library`;
  if (fresh && v.status.mediaId) {
    const stamp = v.status.fetchedAt ? new Date(v.status.fetchedAt).getTime() : 0;
    // A new fetch keeps the same track id, so the time of the fetch is in the cached name.
    return { key: `${v.status.mediaId}-${stamp}`, title: v.settings.name, url: `${base}/${v.status.mediaId}/audio`, name: `news-${stamp}${v.status.ext ?? '.mp3'}`, spare: false };
  }
  if (v.fallback) return { key: v.fallback.id, title: v.fallback.title, url: `${base}/${v.fallback.id}/audio`, name: `media-${v.fallback.id}${v.fallback.ext}`, spare: true };
  return null;
}

/**
 * The news player of the OmniPlayer layout. Off the air the AutoDJ plays the news from the hour clocks; while this PC
 * is live it plays the bulletin itself, at the news time with Auto. The news is a fixed block: only managers can stop it.
 */
export function NewsPlayer({ stationId }: { stationId: string }) {
  const { t } = useTranslation();
  const news = useNews(stationId);
  const now = useNow();
  const { auto } = useSettings().news;
  const manager = useCanUpload();
  const live = useEngine((s) => s.broadcast.state === 'live');
  const st = useEngine((s) => s.carts[NEWS_SLOT]);
  const error = useEngine((s) => s.cartErrors[NEWS_SLOT]);
  const v = news.data;
  const slot = v?.slots.find((s) => new Date(s.at).getTime() > now - GRACE_MS) ?? null;
  const at = slot ? new Date(slot.at).getTime() : null;
  const pick = v && slot ? choose(stationId, v, slot.fresh) : null;

  // Loaded only while live, and again when the bulletin changes; never swapped while it plays.
  const loaded = useRef<string | null>(null);
  const playing = !!st?.playing;
  useEffect(() => {
    const key = live && pick ? pick.key : null;
    if (loaded.current === key || playing) return;
    loaded.current = key;
    void call('clear_cart', { slot: NEWS_SLOT });
    if (!key || !pick) return;
    clearCartError(NEWS_SLOT);
    call<string>('cache_file', { url: pick.url, token: getApiKey() ?? '', name: pick.name })
      .then((p) => call('load_cart', { slot: NEWS_SLOT, path: p, looped: false }))
      .catch((err) => {
        loaded.current = null;
        toast.error(`${pick.title}: ${(err as Error).message ?? err}`);
      });
  }, [live, pick, playing]);

  // Auto: once per news time, right at it.
  const started = useRef<number | null>(null);
  useEffect(() => {
    if (!live || !auto || at == null || !st?.loaded || playing || started.current === at) return;
    if (now >= at && now - at < AUTO_WINDOW_MS) {
      started.current = at;
      void call('play_cart', { slot: NEWS_SLOT });
    }
  }, [live, auto, at, now, st?.loaded, playing]);

  const start = () => {
    if (at != null) started.current = at;
    void call('play_cart', { slot: NEWS_SLOT });
  };
  const stop = () => void call('stop_cart', { slot: NEWS_SLOT });

  const total = st?.loaded ? st.duration : null;
  const pct = playing && total ? (st!.position / total) * 100 : 0;
  const big = playing && total != null ? `-${duration(total - st!.position)}` : at != null && at > now ? `-${duration((at - now) / 1000)}` : '–:––';
  const state = !v?.settings.enabled && !v?.fallback ? 'off' : !slot ? 'none' : slot.fresh && v?.status.mediaId ? 'ready' : v?.fallback ? 'spare' : 'waiting';

  return (
    <Card className="flex w-[210px] shrink-0 flex-col overflow-hidden">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <Newspaper className="size-3.5 text-[#B79CFF]" />
        <span className="min-w-0 flex-1 truncate text-[10px] font-bold tracking-[0.08em] text-muted uppercase">{t('news.title')}</span>
        <label className="flex cursor-pointer items-center gap-1 text-[10.5px] font-semibold text-muted" title={t('news.autoHint')}>
          <input type="checkbox" checked={auto} onChange={(e) => updateSettings(() => ({ news: { auto: e.target.checked } }))} className="accent-[var(--color-koraal)]" />
          {t('news.auto')}
        </label>
      </div>
      <div className="flex flex-col gap-1.5 p-2.5">
        <div className="min-w-0">
          <div className="text-[9px] font-bold tracking-[0.08em] text-muted uppercase">{playing ? t('news.playing') : at != null ? t('news.next', { time: clock(at) }) : t('news.noSlot')}</div>
          <div className="truncate text-[13px] font-bold">{pick ? pick.title : v?.settings.name ?? '…'}</div>
          {error && <div className="truncate text-[11px] text-offline">{error}</div>}
        </div>
        <div className={clsx('display text-[24px] leading-none tabular', !playing && at != null && at - now < 30_000 && at > now && 'text-accent-text')}>{big}</div>
        <div className="h-1.5 overflow-hidden rounded-full bg-meter">
          <div className="h-full bg-[#B79CFF] transition-[width] duration-100 ease-linear" style={{ width: `${pct}%` }} />
        </div>
        {live ? (
          <div className="flex gap-1.5">
            {playing ? (
              <button
                type="button"
                onClick={stop}
                disabled={!manager}
                title={manager ? t('news.stop') : t('news.locked')}
                aria-label={t('news.stop')}
                className="flex h-8 flex-1 items-center justify-center gap-1.5 rounded-md border border-line bg-raised text-[12px] font-semibold disabled:opacity-60"
              >
                {manager ? <Square className="size-3.5 fill-current" /> : <Lock className="size-3.5" />}
                {manager ? t('news.stop') : t('news.locked')}
              </button>
            ) : (
              <button
                type="button"
                onClick={start}
                disabled={!st?.loaded}
                title={t('news.play')}
                aria-label={t('news.play')}
                className="flex h-8 flex-1 items-center justify-center gap-1.5 rounded-md bg-koraal text-[12px] font-bold text-nacht disabled:opacity-40"
              >
                <Play className="size-4 fill-current" /> {t('news.play')}
              </button>
            )}
          </div>
        ) : (
          <p className="text-[11px] leading-snug text-muted">{t('news.byAutodj')}</p>
        )}
      </div>
      <div className="mt-auto border-t border-line px-2.5 py-1.5 text-[10.5px]">
        <span className={clsx('font-semibold', state === 'ready' ? 'text-online' : state === 'spare' ? 'text-[var(--color-warning)]' : 'text-muted')}>{t(`news.state.${state}`)}</span>
        {v?.status.fetchedAt && state === 'ready' && <span className="text-muted"> · {t('news.fetchedAt', { time: clock(new Date(v.status.fetchedAt).getTime()) })}</span>}
      </div>
    </Card>
  );
}
