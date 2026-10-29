import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ArrowLeftRight, ListMusic, Lock, Music2, Newspaper, Scissors, Shuffle, X } from 'lucide-react';
import { useState, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Spinner } from './ui';
import { api, type LogPlan, type LogRow } from '../lib/api';
import { camelot, duration } from '../lib/format';

const DRAG_ROW = 'application/x-hrs-log';
const HOUR = 3_600_000;
const HOURS = 3;
/** Times in the station's time zone, as the hour clocks run. */
const clock = (iso: string, timeZone: string, seconds = true) =>
  new Date(iso).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit', timeZone, ...(seconds ? { second: '2-digit' } : {}) });

export const logKey = (stationId: string) => ['log', stationId, HOURS];
const url = (stationId: string, path = '') => `/stations/${stationId}/autodj/log${path}?hours=${HOURS}`;

/** Places a library track on a row of the log (the library's + while the log editor waits for a track). */
export function usePlaceInLog(stationId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: { itemId: string; mediaId: string }) => api<LogPlan>(url(stationId, `/${b.itemId}`), { method: 'PUT', body: { mediaId: b.mediaId } }),
    onSuccess: (v) => qc.setQueryData(logKey(stationId), v),
    onError: (err) => toast.error((err as Error).message),
  });
}

/**
 * The log editor in the library dock of the OmniPlayer layout: the coming hours as the AutoDJ plays them. Drag a track
 * onto another to swap them; the arrows place a track from the library, the dice pick another one. Locked parts of the
 * format and what the player loaded stay as they are.
 */
export function LogEditor({ stationId, onPlace }: { stationId: string; onPlace: (row: LogRow, time: string) => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const log = useQuery({ queryKey: logKey(stationId), queryFn: () => api<LogPlan>(url(stationId)), refetchInterval: 30_000 });
  const [over, setOver] = useState<string | null>(null);
  const done = { onSuccess: (v: LogPlan) => qc.setQueryData(logKey(stationId), v), onError: (err: Error) => toast.error(err.message) };
  const swap = useMutation({ mutationFn: (b: { a: string; b: string }) => api<LogPlan>(url(stationId, '/swap'), { method: 'POST', body: b }), ...done });
  const remove = useMutation({ mutationFn: (itemId: string) => api<LogPlan>(url(stationId, `/${itemId}`), { method: 'DELETE' }), ...done });
  if (!log.data) {
    return <div className="grid flex-1 place-items-center p-6 text-[12px] text-muted">{log.isPending ? <Spinner /> : (log.error as Error)?.message}</div>;
  }
  const plan = log.data;
  const first = new Date(plan.hours[0]?.hour ?? 0).getTime();
  const drop = (e: DragEvent, r: LogRow) => {
    e.preventDefault();
    setOver(null);
    const from = e.dataTransfer.getData(DRAG_ROW);
    if (from && r.itemId && from !== r.itemId) swap.mutate({ a: from, b: r.itemId });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        {plan.hours.map((h, i) => {
          const start = new Date(h.hour).getTime();
          const rows = plan.rows.filter((r) => {
            const at = new Date(r.at).getTime();
            return (at >= start || (i === 0 && at < first)) && at < start + HOUR;
          });
          return (
            <section key={h.hour}>
              <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-line bg-surface px-3 py-1.5 text-[11.5px]">
                <span className="font-bold tabular">{clock(h.hour, plan.timezone, false)}</span>
                {h.clock && <span className="size-2 rounded-full" style={{ background: h.clock.color }} />}
                <span className="truncate text-muted">{[h.clock?.name, h.show?.name].filter(Boolean).join(' · ')}</span>
              </div>
              {rows.map((r) => (
                <div
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
                    'group flex items-center gap-2 border-b border-line/60 px-3 py-1 text-[12px]',
                    r.editable && 'cursor-grab hover:bg-hover active:cursor-grabbing',
                    r.state === 'playing' && 'bg-[color-mix(in_srgb,var(--color-koraal)_10%,transparent)]',
                    r.locked && 'bg-hover/60',
                    over === r.key && 'ring-2 ring-koraal ring-inset',
                  )}
                >
                  <span className={clsx('w-[54px] shrink-0 tabular', r.state === 'planned' ? 'text-muted' : 'font-bold')}>{clock(r.at, plan.timezone)}</span>
                  <Icon row={r} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-semibold">
                      {r.media?.title ?? '—'}
                      <span className="font-normal text-muted"> · {r.media?.artist || '—'}</span>
                    </div>
                    {(r.label || r.state !== 'planned') && (
                      <div className="truncate text-[10.5px] text-muted">
                        {r.state === 'playing' ? t('logEditor.onAir') : r.state === 'cued' ? t('logEditor.cued') : r.state === 'loaded' ? t('logEditor.loaded') : null}
                        {r.state !== 'planned' && r.label ? ' · ' : ''}
                        {r.label}
                      </div>
                    )}
                  </div>
                  <span className="hidden w-[62px] shrink-0 font-mono text-[10.5px] text-muted @[560px]:block">{r.media?.code ?? ''}</span>
                  <span className="hidden w-12 shrink-0 text-right text-[11px] text-muted tabular @[480px]:block">
                    {r.media?.bpm ? Math.round(r.media.bpm) : ''} <span className="font-semibold text-accent-text">{camelot(r.media?.musicKey)}</span>
                  </span>
                  <span className="flex w-11 shrink-0 items-center justify-end gap-0.5 text-[11px] text-muted tabular" title={r.cut ? t('logEditor.cut') : undefined}>
                    {r.cut && <Scissors className="size-3 text-[var(--color-warning)]" />}
                    {duration(r.seconds)}
                  </span>
                  <span className="flex w-[46px] shrink-0 justify-end">
                    {r.editable ? (
                      <>
                        <button type="button" title={t('logEditor.place')} aria-label={t('logEditor.place')} onClick={() => onPlace(r, clock(r.at, plan.timezone))} className="rounded p-0.5 text-muted opacity-50 group-hover:opacity-100 hover:text-ink">
                          <ArrowLeftRight className="size-3.5" />
                        </button>
                        <button
                          type="button"
                          title={r.source === 'queue' ? t('logEditor.remove') : t('logEditor.repick')}
                          aria-label={r.source === 'queue' ? t('logEditor.remove') : t('logEditor.repick')}
                          onClick={() => remove.mutate(r.itemId!)}
                          className="rounded p-0.5 text-muted opacity-50 group-hover:opacity-100 hover:text-offline"
                        >
                          {r.source === 'queue' ? <X className="size-3.5" /> : <Shuffle className="size-3.5" />}
                        </button>
                      </>
                    ) : (
                      r.locked && <Lock className="m-0.5 size-3.5 text-muted" aria-label={t('logEditor.locked')} />
                    )}
                  </span>
                </div>
              ))}
            </section>
          );
        })}
      </div>
      <div className="border-t border-line px-3 py-2 text-[11px] text-muted">{plan.scheduled ? t('logEditor.hint') : t('logEditor.noClocks')}</div>
    </div>
  );
}

function Icon({ row }: { row: LogRow }) {
  const { t } = useTranslation();
  const I = row.source === 'news' ? Newspaper : row.source === 'queue' ? ListMusic : Music2;
  return (
    <span title={t(`logEditor.sources.${row.source}`)} className={clsx('grid size-5 shrink-0 place-items-center rounded', row.source === 'queue' ? 'text-muted' : 'bg-hover', row.hard && 'ring-1 ring-koraal')}>
      <I className="size-3" />
    </span>
  );
}
