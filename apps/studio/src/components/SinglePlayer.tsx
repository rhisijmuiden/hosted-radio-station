import clsx from 'clsx';
import { Play, SkipForward, Square, X } from 'lucide-react';
import { useEffect, useRef, useState, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { extOf } from './Jingles';
import { DRAG_FILE, DRAG_MEDIA, DRAG_MEDIA_PATH } from './Library';
import { Card } from './ui';
import { getApiKey } from '../lib/api';
import { clearCartError, useEngine } from '../lib/engine';
import { duration } from '../lib/format';
import { call } from '../lib/native';
import { getSettings, updateSettings, useSettings, type SingleItem } from '../lib/settings';

/** The engine slot of the single player: the mixer ducks it under the microphone. */
export const SINGLE_SLOT = 145;

const baseName = (p: string) => p.split(/[\\/]/).pop()!.replace(/\.[a-z0-9]{1,5}$/i, '');
const setItems = (fn: (items: SingleItem[]) => SingleItem[]) => updateSettings((s) => ({ single: { ...s.single, items: fn(s.single.items) } }));

/** Puts the first track of the list in the engine: a file of this PC as it is, a library track downloaded first. */
function useLoadFirst(first: SingleItem | undefined, stationId: string) {
  const loaded = useRef<string | null>(null);
  useEffect(() => {
    const key = first?.id ?? null;
    if (loaded.current === key) return;
    loaded.current = key;
    // Emptied first, so the engine reports the slot unloaded until the new track is decoded.
    void call('clear_cart', { slot: SINGLE_SLOT });
    if (!first) return;
    clearCartError(SINGLE_SLOT);
    const path = first.path
      ? Promise.resolve(first.path)
      : call<string>('cache_file', { url: `${getSettings().server}/api/stations/${stationId}/library/${first.mediaId}/audio`, token: getApiKey() ?? '', name: `media-${first.mediaId}.${first.ext}` });
    path
      .then((p) => call('load_cart', { slot: SINGLE_SLOT, path: p, looped: false }))
      .catch((err) => {
        loaded.current = null;
        toast.error(`${first.title}: ${(err as Error).message ?? err}`);
      });
  }, [first, stationId]);
}

/**
 * The single player of the OmniPlayer layout: a player of its own on this PC with a short list, for a bed under a
 * talk or a track from a USB stick. Like the jingles it goes into the broadcast when live, and it ducks under the
 * microphone. After a track the next one waits, unless Auto is on.
 */
export function SinglePlayer({ stationId }: { stationId: string }) {
  const { t } = useTranslation();
  const { items, auto } = useSettings().single;
  const st = useEngine((s) => s.carts[SINGLE_SLOT]);
  const error = useEngine((s) => s.cartErrors[SINGLE_SLOT]);
  const duck = useSettings().audio.duckSingle !== false;
  const [over, setOver] = useState(false);
  const first = items[0];
  useLoadFirst(first, stationId);

  // A track that ends by itself leaves the list; with Auto the next one starts once it is loaded.
  const was = useRef(false);
  const stopped = useRef(false);
  const startNext = useRef(false);
  const unloaded = useRef(false);
  useEffect(() => {
    const playing = !!st?.playing;
    if (was.current && !playing) {
      if (!stopped.current) {
        startNext.current = getSettings().single.auto;
        unloaded.current = false;
        setItems((list) => list.slice(1));
      }
      stopped.current = false;
    }
    was.current = playing;
  }, [st?.playing]);
  // Start the next track once it is in the engine: after the slot was empty, so never the track that just ended.
  useEffect(() => {
    if (!startNext.current) return;
    if (!st?.loaded) unloaded.current = true;
    else if (unloaded.current && !st.playing && first) {
      startNext.current = false;
      unloaded.current = false;
      void call('play_cart', { slot: SINGLE_SLOT });
    }
  }, [st?.loaded, st?.playing, first]);

  const toggle = () => {
    if (st?.playing) stopped.current = true;
    void call('play_cart', { slot: SINGLE_SLOT });
  };
  const next = () => {
    if (st?.playing) {
      stopped.current = true;
      startNext.current = true;
      unloaded.current = false;
      void call('stop_cart', { slot: SINGLE_SLOT });
    }
    setItems((list) => list.slice(1));
  };
  const add = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    const file = e.dataTransfer.getData(DRAG_FILE);
    const mediaId = e.dataTransfer.getData(DRAG_MEDIA);
    const mediaPath = e.dataTransfer.getData(DRAG_MEDIA_PATH);
    const item: SingleItem | null = file
      ? { id: crypto.randomUUID(), title: baseName(file), path: file, ext: extOf(file) }
      : mediaId
        ? { id: crypto.randomUUID(), title: baseName(mediaPath || mediaId), mediaId, ext: extOf(mediaPath) }
        : null;
    if (item) setItems((list) => [...list, item].slice(0, 50));
  };
  const total = st?.loaded ? st.duration : null;
  const remaining = st?.playing && total != null ? total - st.position : total;
  const pct = st?.playing && total ? (st.position / total) * 100 : 0;

  return (
    <Card
      className={clsx('flex w-[210px] shrink-0 flex-col overflow-hidden', over && 'ring-2 ring-koraal')}
      onDragOver={(e) => {
        if (![DRAG_FILE, DRAG_MEDIA].some((k) => e.dataTransfer.types.includes(k))) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={add}
    >
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <span className="min-w-0 flex-1 truncate text-[10px] font-bold tracking-[0.08em] text-muted uppercase">{t('single.title')}</span>
        <label className="flex cursor-pointer items-center gap-1 text-[10.5px] font-semibold text-muted" title={t('single.autoHint')}>
          <input type="checkbox" checked={auto} onChange={(e) => updateSettings((s) => ({ single: { ...s.single, auto: e.target.checked } }))} className="accent-[var(--color-koraal)]" />
          {t('single.auto')}
        </label>
      </div>
      <div className="flex flex-col gap-1.5 p-2.5">
        <div className="min-w-0">
          <div className="text-[9px] font-bold tracking-[0.08em] text-muted uppercase">{st?.playing ? t('single.playing') : first ? t('single.ready') : t('single.empty')}</div>
          <div className="truncate text-[13px] font-bold">{first ? first.title : t('single.dropHere')}</div>
          {error && <div className="truncate text-[11px] text-offline">{error}</div>}
        </div>
        <div className={clsx('display text-[24px] leading-none tabular', st?.playing && remaining != null && remaining < 10 && 'text-accent-text')}>
          {remaining != null ? `${st?.playing ? '-' : ''}${duration(remaining)}` : '–:––'}
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-meter">
          <div className="h-full bg-[var(--color-warning)] transition-[width] duration-100 ease-linear" style={{ width: `${pct}%` }} />
        </div>
        <div className="flex gap-1.5">
          <button
            type="button"
            onClick={toggle}
            disabled={!st?.loaded}
            title={st?.playing ? t('single.stop') : t('single.play')}
            aria-label={st?.playing ? t('single.stop') : t('single.play')}
            className={clsx('grid h-8 flex-[2] place-items-center rounded-md disabled:opacity-40', st?.playing ? 'border border-line bg-raised' : 'bg-koraal text-nacht')}
          >
            {st?.playing ? <Square className="size-3.5 fill-current" /> : <Play className="size-4 fill-current" />}
          </button>
          <button type="button" onClick={next} disabled={!first} title={t('single.next')} aria-label={t('single.next')} className="grid h-8 flex-1 place-items-center rounded-md border border-line hover:bg-hover disabled:opacity-40">
            <SkipForward className="size-4" />
          </button>
        </div>
      </div>
      <ol className="min-h-0 flex-1 overflow-y-auto border-t border-line text-[12px]">
        {items.slice(1).map((item) => (
          <li key={item.id} className="group flex items-center gap-1 border-b border-line/60 px-2.5 py-1">
            <span className="min-w-0 flex-1 truncate">{item.title}</span>
            <button type="button" onClick={() => setItems((list) => list.filter((x) => x.id !== item.id))} aria-label={t('single.remove')} title={t('single.remove')} className="rounded p-0.5 text-muted opacity-0 group-hover:opacity-100 hover:text-offline">
              <X className="size-3" />
            </button>
          </li>
        ))}
        {items.length <= 1 && <li className="px-2.5 py-2 text-[11px] text-muted">{t('single.listHint')}</li>}
      </ol>
      <div className="border-t border-line px-2.5 py-1.5 text-[10.5px] text-muted">
        {t('single.output')}
        {duck && <> · {t('single.ducks')}</>}
      </div>
    </Card>
  );
}
