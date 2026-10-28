import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ChevronLeft, ChevronRight, Pencil, Repeat, Square } from 'lucide-react';
import { useState, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { base, EditDialog, extOf, JINGLE_SLOT, uploadJingle, useLoadJingles, type Jingle } from './Jingles';
import { DRAG_FILE, DRAG_MEDIA, DRAG_MEDIA_PATH } from './Library';
import { Card } from './ui';
import { api, getApiKey } from '../lib/api';
import { useEngine } from '../lib/engine';
import { duration } from '../lib/format';
import { call, pickAudioFile } from '../lib/native';
import { getSettings } from '../lib/settings';

/** Seven buttons on a page, as in OmniPlayer. */
const PER_PAGE = 7;
/** The engine slots of the station carts, after the cart wall and the DJ's jingles. */
export const STATION_CART_SLOT = 96;
const STATION_CARTS = 49;
const MY_PAGES = Math.ceil(48 / PER_PAGE);
const cartsBase = (stationId: string) => `/studio/stations/${stationId}/carts`;

interface GridProps {
  title: string;
  footer: string;
  /** Colour of the bar under the grid: coral for the DJ's own, sky for the station. */
  tone: 'own' | 'station';
  items: Jingle[];
  slotBase: number;
  pages: number;
  page: number;
  onPage: (p: number) => void;
  /** Own jingles: empty buttons take a file, buttons can be edited. */
  onEmpty?: (position: number) => void;
  onDrop?: (position: number, e: DragEvent) => void;
  onEdit?: (j: Jingle) => void;
  busy?: number | null;
}

/** A column of seven buttons with their length, a progress bar while playing, and pages. */
function Grid({ title, footer, tone, items, slotBase, pages, page, onPage, onEmpty, onDrop, onEdit, busy }: GridProps) {
  const { t } = useTranslation();
  const states = useEngine((s) => s.carts);
  const errors = useEngine((s) => s.cartErrors);
  const [over, setOver] = useState<number | null>(null);
  const anyPlaying = items.some((j) => states[slotBase + j.position]?.playing);
  const accepts = (e: DragEvent) => !!onDrop && (e.dataTransfer.types.includes(DRAG_FILE) || e.dataTransfer.types.includes(DRAG_MEDIA));
  return (
    <Card className="flex w-[180px] shrink-0 flex-col overflow-hidden">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <span className="min-w-0 flex-1 truncate text-[10px] font-bold tracking-[0.08em] text-muted uppercase">{title}</span>
        <button
          type="button"
          disabled={!anyPlaying}
          onClick={() => items.forEach((j) => void call('stop_cart', { slot: slotBase + j.position }))}
          title={t('carts.stopAll')}
          aria-label={t('carts.stopAll')}
          className="rounded p-0.5 text-offline disabled:opacity-30"
        >
          <Square className="size-3 fill-current" />
        </button>
      </div>
      <div className="flex flex-1 flex-col gap-1 p-2">
        {Array.from({ length: PER_PAGE }, (_, i) => {
          const position = page * PER_PAGE + i;
          const j = items.find((x) => x.position === position);
          const st = states[slotBase + position];
          const drop = {
            onDragOver: (e: DragEvent) => {
              if (!accepts(e)) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = 'copy';
              setOver(position);
            },
            onDragLeave: () => setOver((o) => (o === position ? null : o)),
            onDrop: (e: DragEvent) => {
              e.preventDefault();
              setOver(null);
              onDrop?.(position, e);
            },
          };
          if (!j) {
            return (
              <button
                key={position}
                type="button"
                {...drop}
                disabled={!onEmpty || busy === position}
                onClick={() => onEmpty?.(position)}
                className={clsx(
                  'grid min-h-[34px] grid-cols-[16px_1fr] items-center gap-1.5 rounded-[6px] border border-dashed pr-2 text-left text-[11px] text-muted enabled:hover:border-koraal enabled:hover:text-ink',
                  over === position ? 'border-koraal bg-koraal/10' : 'border-line',
                )}
              >
                <span className="text-right text-[11px] font-extrabold">{i + 1}</span>
                <span className="truncate">{busy === position ? t('jingles.saving') : onEmpty ? t('grids.empty') : ''}</span>
              </button>
            );
          }
          const pct = st?.playing && st.duration ? (st.position / st.duration) * 100 : 0;
          const time = st?.loaded ? (st.playing ? `-${duration(st.duration - st.position)}` : duration(st.duration)) : errors[slotBase + position] ? '!' : '…';
          return (
            <div
              key={position}
              {...drop}
              className={clsx('group relative min-h-[34px] overflow-hidden rounded-[6px] border', over === position ? 'border-koraal' : 'border-line', st?.playing ? 'bg-raised' : 'bg-surface')}
              style={st?.playing ? { background: `color-mix(in srgb, ${j.color} 22%, var(--color-raised))` } : undefined}
            >
              <button type="button" onClick={() => void call('play_cart', { slot: slotBase + position })} title={errors[slotBase + position] ?? t('carts.playHint')} className="grid h-full w-full grid-cols-[16px_1fr_auto] items-center gap-1.5 py-1 pr-2 text-left">
                <span className="absolute inset-y-0 left-0 w-1" style={{ background: j.color }} />
                <span className="text-right text-[11px] font-extrabold text-muted">{i + 1}</span>
                <span className="truncate text-[12px] leading-tight font-bold">{j.label}</span>
                <span className={clsx('flex items-center gap-0.5 text-[11px] font-bold tabular', st?.playing ? 'text-accent-text' : 'text-accent-text/80')}>
                  {j.looped && <Repeat className="size-2.5" />}
                  {time}
                </span>
                <span className="absolute inset-x-0 bottom-0 h-[3px] origin-left transition-[width] duration-100 ease-linear" style={{ width: `${pct}%`, background: j.color }} />
              </button>
              {onEdit && (
                <button
                  type="button"
                  onClick={() => onEdit(j)}
                  className="absolute top-1/2 right-1 -translate-y-1/2 rounded bg-raised/90 p-1 text-muted opacity-0 transition-opacity group-hover:opacity-100 hover:text-ink"
                  title={t('common.edit')}
                  aria-label={t('common.edit')}
                >
                  <Pencil className="size-3" />
                </button>
              )}
            </div>
          );
        })}
      </div>
      <div className="flex items-center gap-1 px-2 pb-1.5 text-[10.5px] text-muted">
        <button type="button" disabled={page === 0} onClick={() => onPage(page - 1)} aria-label={t('grids.previous')} className="rounded p-0.5 hover:text-ink disabled:opacity-30">
          <ChevronLeft className="size-3.5" />
        </button>
        <span className="tabular">{t('grids.page', { n: page + 1, of: pages })}</span>
        <button type="button" disabled={page >= pages - 1} onClick={() => onPage(page + 1)} aria-label={t('grids.next')} className="rounded p-0.5 hover:text-ink disabled:opacity-30">
          <ChevronRight className="size-3.5" />
        </button>
        <span className="ml-auto truncate">{footer}</span>
      </div>
      <div className={clsx('h-1.5', tone === 'own' ? 'bg-koraal' : 'bg-lucht')} />
    </Card>
  );
}

/** Grid 1: the DJ's own jingles from the profile, the same buttons as in Classic, seven on a page here. */
export function JingleGrid({ stationId }: { stationId: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const jingles = useQuery({ queryKey: ['jingles', stationId], queryFn: () => api<Jingle[]>(base(stationId)) });
  useLoadJingles(stationId, jingles.data);
  const [page, setPage] = useState(0);
  const [editing, setEditing] = useState<Jingle | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const list = jingles.data ?? [];
  const used = list.length ? Math.floor(Math.max(...list.map((j) => j.position)) / PER_PAGE) + 1 : 1;
  const pages = Math.min(MY_PAGES, Math.max(used + 1, page + 1));
  const put = async (position: number, getPath: () => Promise<string | null>) => {
    setBusy(position);
    try {
      const path = await getPath();
      if (!path) return;
      await uploadJingle(stationId, position, path);
      await qc.invalidateQueries({ queryKey: ['jingles', stationId] });
    } catch (err) {
      toast.error((err as Error).message ?? String(err));
    } finally {
      setBusy(null);
    }
  };
  const drop = (position: number, e: DragEvent) => {
    const file = e.dataTransfer.getData(DRAG_FILE);
    const media = e.dataTransfer.getData(DRAG_MEDIA);
    const mediaPath = e.dataTransfer.getData(DRAG_MEDIA_PATH);
    if (file) void put(position, async () => file);
    else if (media) {
      void put(position, () =>
        call<string>('cache_file', { url: `${getSettings().server}/api/stations/${stationId}/library/${media}/audio`, token: getApiKey() ?? '', name: `media-${media}.${extOf(mediaPath)}` }),
      );
    }
  };
  return (
    <>
      <Grid
        title={t('grids.mine')}
        footer={t('grids.mineFooter')}
        tone="own"
        items={list}
        slotBase={JINGLE_SLOT}
        pages={pages}
        page={page}
        onPage={setPage}
        busy={busy}
        onEmpty={(position) => void put(position, () => pickAudioFile(t('carts.chooseFile')))}
        onDrop={drop}
        onEdit={setEditing}
      />
      <EditDialog stationId={stationId} jingle={editing} onClose={() => setEditing(null)} />
    </>
  );
}

/** Grid 2: the station carts a manager fills in the panel, the same for every DJ of the station. */
export function StationCartGrid({ stationId }: { stationId: string }) {
  const { t } = useTranslation();
  const carts = useQuery({ queryKey: ['station-carts', stationId], queryFn: () => api<Jingle[]>(cartsBase(stationId)), staleTime: 60_000, refetchInterval: 5 * 60_000 });
  useLoadJingles(stationId, carts.data, STATION_CART_SLOT, cartsBase);
  const [page, setPage] = useState(0);
  const list = carts.data ?? [];
  const used = list.length ? Math.floor(Math.max(...list.map((j) => j.position)) / PER_PAGE) + 1 : 1;
  return <Grid title={t('grids.station')} footer={t('grids.stationFooter')} tone="station" items={list} slotBase={STATION_CART_SLOT} pages={Math.min(Math.ceil(STATION_CARTS / PER_PAGE), used)} page={page} onPage={setPage} />;
}

