import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ArrowLeftRight, GripVertical, ListMusic, Lock, Music2, Newspaper, RefreshCw, Scissors, Shuffle, X } from 'lucide-react';
import { useState, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { api, type MediaFile, type StationDetail } from '../../lib/api';
import { camelot, formatSeconds } from '../../lib/format';
import { Badge, Button, Card, CardHeader, EmptyState, Select, Spinner } from '../ui';
import { TrackPicker } from './Clocks';

export interface LogRow {
  key: string;
  at: string;
  state: 'playing' | 'cued' | 'loaded' | 'planned';
  source: 'queue' | 'playlist' | 'item' | 'track' | 'news';
  itemId: string | null;
  editable: boolean;
  locked: boolean;
  hard: boolean;
  cut: boolean;
  origin: string | null;
  addedBy: string | null;
  label: string | null;
  media: { id: string; title: string; artist: string; durationSeconds: number | null; code: string | null; bpm: number | null; musicKey: string } | null;
  seconds: number | null;
}
export interface LogPlan {
  timezone: string;
  scheduled: boolean;
  until: string;
  hours: { hour: string; clock: { id: string; name: string; color: string } | null; show: { id: string; name: string; live: boolean } | null }[];
  rows: LogRow[];
}

const DRAG_ROW = 'text/x-hrs-log';
const HOUR = 3_600_000;

/**
 * The log editor: the coming hours as the AutoDJ will play them, hour by hour. Drag a track onto another to swap them,
 * or place another track from the library; locked parts of the format and what the player loaded stay as they are.
 */
export function LogTab({ station }: { station: StationDetail }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [hours, setHours] = useState(3);
  const key = ['log', station.id, hours];
  const url = (path = '') => `/stations/${station.id}/autodj/log${path}?hours=${hours}`;
  const log = useQuery({ queryKey: key, queryFn: () => api<LogPlan>(url()), refetchInterval: 30_000 });
  const [over, setOver] = useState<string | null>(null);
  const [placing, setPlacing] = useState<LogRow | null>(null);
  const done = { onSuccess: (v: LogPlan) => qc.setQueryData(key, v), onError: (err: Error) => toast.error(err.message) };
  const swap = useMutation({ mutationFn: (b: { a: string; b: string }) => api<LogPlan>(url('/swap'), { method: 'POST', body: b }), ...done });
  const place = useMutation({ mutationFn: (b: { itemId: string; mediaId: string }) => api<LogPlan>(url(`/${b.itemId}`), { method: 'PUT', body: { mediaId: b.mediaId } }), ...done });
  const remove = useMutation({ mutationFn: (itemId: string) => api<LogPlan>(url(`/${itemId}`), { method: 'DELETE' }), ...done });

  if (log.isPending) {
    return (
      <div className="grid place-items-center py-16">
        <Spinner />
      </div>
    );
  }
  if (!log.data) return <EmptyState icon={<ListMusic className="size-6" />} title={t('log.loadFailed')} description={(log.error as Error)?.message} />;
  const plan = log.data;
  const byHour = plan.hours.map((h) => {
    const start = new Date(h.hour).getTime();
    return { ...h, rows: plan.rows.filter((r) => new Date(r.at).getTime() >= start && new Date(r.at).getTime() < start + HOUR) };
  });
  // Rows before the first hour (the track on air started in the hour before) go with the first hour.
  const early = plan.rows.filter((r) => new Date(r.at).getTime() < new Date(plan.hours[0]?.hour ?? 0).getTime());
  if (byHour[0]) byHour[0].rows = [...early, ...byHour[0].rows];
  const drop = (e: DragEvent, r: LogRow) => {
    e.preventDefault();
    setOver(null);
    const from = e.dataTransfer.getData(DRAG_ROW);
    if (from && r.itemId && from !== r.itemId) swap.mutate({ a: from, b: r.itemId });
  };

  return (
    <Card>
      <CardHeader
        title={t('log.title')}
        description={plan.scheduled ? t('log.description') : t('log.noClocks')}
        actions={
          <>
            <Select className="h-8 w-auto text-[13px]" value={hours} onChange={(e) => setHours(Number(e.target.value))} aria-label={t('log.hours')}>
              {[1, 2, 3, 6].map((h) => (
                <option key={h} value={h}>
                  {t('log.nextHours', { count: h })}
                </option>
              ))}
            </Select>
            <Button size="sm" variant="ghost" title={t('log.refresh')} loading={log.isFetching} onClick={() => void log.refetch()}>
              <RefreshCw className="size-4" />
            </Button>
          </>
        }
      />
      <div className="flex flex-col pb-2">
        {byHour.map((h) => (
          <section key={h.hour}>
            <div className="sticky top-0 z-10 flex items-center gap-2.5 border-y border-line bg-raised px-5 py-2 text-[13px]">
              <span className="font-bold tabular-nums">{time(h.hour, false, plan.timezone)}</span>
              {h.clock && (
                <span className="inline-flex items-center gap-1.5 text-muted">
                  <span className="size-2.5 rounded-full" style={{ background: h.clock.color }} />
                  {h.clock.name}
                </span>
              )}
              {h.show && <span className="truncate font-semibold">{h.show.name}</span>}
              {h.show?.live && <Badge tone="accent">{t('log.liveShow')}</Badge>}
            </div>
            <ul className="px-3 py-1">
              {!h.rows.length && <li className="px-2 py-3 text-[13px] text-muted">{t('log.emptyHour')}</li>}
              {h.rows.map((r) => (
                <li
                  key={r.key}
                  draggable={r.editable}
                  onDragStart={(e) => {
                    e.dataTransfer.setData(DRAG_ROW, r.itemId!);
                    e.dataTransfer.effectAllowed = 'move';
                  }}
                  onDragOver={(e) => {
                    if (!r.editable || !e.dataTransfer.types.includes(DRAG_ROW)) return;
                    e.preventDefault();
                    setOver(r.key);
                  }}
                  onDragLeave={() => setOver((o) => (o === r.key ? null : o))}
                  onDrop={(e) => drop(e, r)}
                  className={clsx(
                    'group flex items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors',
                    r.editable ? 'cursor-grab hover:bg-hover active:cursor-grabbing' : '',
                    r.state === 'playing' && 'bg-koraal/8',
                    r.locked && 'bg-chip/60',
                    over === r.key && 'ring-2 ring-koraal',
                  )}
                >
                  <GripVertical className={clsx('size-4 shrink-0', r.editable ? 'text-muted' : 'text-transparent')} />
                  <span className={clsx('w-[62px] shrink-0 text-[12.5px] tabular-nums', r.state === 'planned' ? 'text-muted' : 'font-semibold')}>{time(r.at, true, plan.timezone)}</span>
                  <SourceIcon row={r} />
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-[13px] font-semibold">{r.media?.title ?? '—'}</span>
                      {r.state === 'playing' && <Badge tone="accent">{t('log.onAir')}</Badge>}
                      {r.state === 'cued' && <Badge tone="online">{t('log.cued')}</Badge>}
                      {r.state === 'loaded' && <Badge>{t('log.loaded')}</Badge>}
                    </div>
                    <div className="flex min-w-0 items-center gap-2 text-xs text-muted">
                      <span className="truncate">{r.media?.artist || '—'}</span>
                      {r.label && <span className="shrink-0 rounded bg-chip px-1.5 py-px text-[11px] font-semibold">{r.label}</span>}
                      {r.origin === 'request' && <span className="shrink-0">{t('log.request')}</span>}
                      {r.origin === 'manual' && r.addedBy && <span className="shrink-0">{r.addedBy}</span>}
                    </div>
                  </div>
                  <span className="hidden w-20 shrink-0 font-mono text-[11.5px] text-muted md:block">{r.media?.code ?? ''}</span>
                  <span className="hidden w-16 shrink-0 text-right text-[12px] text-muted tabular-nums lg:block">
                    {r.media?.bpm ? Math.round(r.media.bpm) : ''} {r.media?.musicKey && <span className="font-semibold text-accent-text">{camelot(r.media.musicKey)}</span>}
                  </span>
                  <span className="flex w-14 shrink-0 items-center justify-end gap-1 text-[12px] text-muted tabular-nums" title={r.cut ? t('log.cut') : undefined}>
                    {r.cut && <Scissors className="size-3 text-[var(--color-warning)]" />}
                    {formatSeconds(r.seconds)}
                  </span>
                  <span className="flex w-[60px] shrink-0 justify-end gap-0.5">
                    {r.editable ? (
                      <>
                        <button type="button" className="rounded p-1 text-muted opacity-60 group-hover:opacity-100 hover:bg-chip hover:text-ink" title={t('log.place')} onClick={() => setPlacing(r)}>
                          <ArrowLeftRight className="size-4" />
                        </button>
                        <button
                          type="button"
                          className="rounded p-1 text-muted opacity-60 group-hover:opacity-100 hover:bg-chip hover:text-offline"
                          title={r.source === 'queue' ? t('log.remove') : t('log.repick')}
                          onClick={() => remove.mutate(r.itemId!)}
                        >
                          {r.source === 'queue' ? <X className="size-4" /> : <Shuffle className="size-4" />}
                        </button>
                      </>
                    ) : (
                      r.locked && <Lock className="m-1 size-4 text-muted" aria-label={t('log.locked')} />
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))}
        <p className="px-5 pt-3 text-xs text-muted">{t('log.hint')}</p>
      </div>
      <TrackPicker
        station={station}
        open={!!placing}
        onClose={() => setPlacing(null)}
        onPick={(m: MediaFile) => {
          if (placing?.itemId) place.mutate({ itemId: placing.itemId, mediaId: m.id });
          setPlacing(null);
        }}
      />
    </Card>
  );
}

/** Times in the station's time zone, as the hour clocks run. */
const time = (iso: string, seconds: boolean, timeZone: string) =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone, ...(seconds ? { second: '2-digit' } : {}) });

function SourceIcon({ row }: { row: LogRow }) {
  const { t } = useTranslation();
  const Icon = row.source === 'news' ? Newspaper : row.source === 'queue' ? ListMusic : Music2;
  return (
    <span title={t(`log.sources.${row.source}`)} className={clsx('grid size-6 shrink-0 place-items-center rounded', row.source === 'queue' ? 'text-muted' : 'bg-chip text-ink', row.hard && 'ring-1 ring-koraal')}>
      <Icon className="size-3.5" />
    </span>
  );
}
