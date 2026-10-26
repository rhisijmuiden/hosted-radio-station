import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ArrowLeftRight, ArrowUpToLine, CalendarClock, Eraser, GripVertical, ListMusic, Music2, Search, SkipForward, Trash2, X } from 'lucide-react';
import { useState, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Badge, Button, Card, EmptyState, Input, Spinner } from '../components/ui';
import { api, type AutoDj, type Media, type QueueRow } from '../lib/api';
import { duration } from '../lib/format';
import { useAutoDj } from '../lib/queries';
import { useSession } from '../lib/session';

type QueueName = 'q1' | 'q2';
const DRAG = 'application/x-hrs-item';
const DRAG_MEDIA = 'application/x-hrs-media';

function useQueueActions(stationId: string) {
  const qc = useQueryClient();
  const { t } = useTranslation();
  const done = (data: AutoDj) => qc.setQueryData(['autodj', stationId], data);
  const fail = (err: unknown) => toast.error((err as Error).message);
  return {
    add: useMutation({
      mutationFn: (v: { mediaId: string; queue: QueueName; at: 'top' | 'bottom' }) => api<AutoDj>(`/stations/${stationId}/autodj/queue`, { method: 'POST', body: v }),
      onSuccess: (d, v) => {
        done(d);
        toast.success(t('assist.added', { queue: v.queue.toUpperCase() }));
      },
      onError: fail,
    }),
    move: useMutation({
      mutationFn: (v: { itemId: string; queue: QueueName; beforeId: string | null }) =>
        api<AutoDj>(`/stations/${stationId}/autodj/queue/${v.itemId}`, { method: 'PATCH', body: { queue: v.queue, beforeId: v.beforeId } }),
      onSuccess: done,
      onError: fail,
    }),
    remove: useMutation({
      mutationFn: (itemId: string) => api<AutoDj>(`/stations/${stationId}/autodj/queue/${itemId}`, { method: 'DELETE' }),
      onSuccess: done,
      onError: fail,
    }),
    clear: useMutation({
      mutationFn: (queue: QueueName) => api<AutoDj>(`/stations/${stationId}/autodj/queue/clear`, { method: 'POST', body: { queue, rotationOnly: true } }),
      onSuccess: done,
      onError: fail,
    }),
    skip: useMutation({
      mutationFn: () => api(`/stations/${stationId}/autodj/skip`, { method: 'POST' }),
      onSuccess: () => {
        toast.success(t('assist.skipped'));
        setTimeout(() => void qc.invalidateQueries({ queryKey: ['autodj', stationId] }), 800);
      },
      onError: fail,
    }),
  };
}

function NowPlaying({ data, onSkip, skipping }: { data: AutoDj; onSkip: () => void; skipping: boolean }) {
  const { t } = useTranslation();
  const np = data.nowPlaying;
  const elapsed = np?.startedAt ? (Date.now() - new Date(np.startedAt).getTime()) / 1000 : 0;
  const total = np?.media.durationSeconds ?? null;
  const pct = total ? Math.min(100, (elapsed / total) * 100) : 0;
  const remaining = total ? total - elapsed : null;
  const next = data.queues.q1[0] ?? data.queues.q2[0];
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center gap-5 p-5">
        <div className="grid size-16 shrink-0 place-items-center rounded-md bg-nacht text-koraal">
          <Music2 className="size-7" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">{t('assist.nowPlaying')}</div>
          <div className="display truncate text-xl">{np ? np.media.title || np.media.path : t('assist.nothing')}</div>
          <div className="truncate text-[13px] text-muted">{np ? [np.media.artist, np.media.album].filter(Boolean).join(' · ') : !data.player.connected && data.player.expected ? t('assist.playerOffline') : ''}</div>
        </div>
        <div className="text-right">
          <div className={clsx('display text-[32px] leading-none tabular', remaining != null && remaining < 15 && 'text-accent-text')}>{remaining != null ? `-${duration(remaining)}` : '–:––'}</div>
          <div className="mt-1 text-[11px] text-muted">{t('assist.remainingLabel')}</div>
        </div>
        <Button variant="dark" onClick={onSkip} loading={skipping} disabled={!np || data.edition !== 'station'} className="h-12 px-5">
          <SkipForward className="size-5" /> {t('assist.skip')}
        </Button>
      </div>
      <div className="h-1.5 bg-meter">
        <div className="h-full bg-koraal transition-[width] duration-1000 ease-linear" style={{ width: `${pct}%` }} />
      </div>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 px-5 py-2.5 text-xs text-muted">
        <span>
          {t('assist.next')}: <b className="text-ink">{next ? `${next.media.artist ? `${next.media.artist} – ` : ''}${next.media.title}` : '–'}</b>
        </span>
        {data.schedule.enabled && (
          <span className="flex items-center gap-1.5">
            <CalendarClock className="size-3.5" />
            {data.schedule.entry ? data.schedule.entry.name : t('assist.noShow')}
            {data.schedule.clock && (
              <span className="flex items-center gap-1">
                · <i className="size-2 rounded-full" style={{ background: data.schedule.clock.color }} /> {data.schedule.clock.name}
              </span>
            )}
          </span>
        )}
        {data.player.paused && <Badge tone="warning">{t('assist.paused')}</Badge>}
      </div>
    </Card>
  );
}

function QueueColumn({ name, rows, stationId, otherName }: { name: QueueName; rows: QueueRow[]; stationId: string; otherName: QueueName }) {
  const { t } = useTranslation();
  const a = useQueueActions(stationId);
  const [over, setOver] = useState<string | 'end' | null>(null);
  const total = rows.reduce((n, r) => n + (r.media.durationSeconds ?? 0), 0);

  const drop = (e: DragEvent, beforeId: string | null) => {
    e.preventDefault();
    setOver(null);
    const itemId = e.dataTransfer.getData(DRAG);
    const mediaId = e.dataTransfer.getData(DRAG_MEDIA);
    if (itemId) a.move.mutate({ itemId, queue: name, beforeId });
    else if (mediaId) a.add.mutate({ mediaId, queue: name, at: beforeId === rows[0]?.id ? 'top' : 'bottom' });
  };
  const allow = (e: DragEvent, id: string | 'end') => {
    if (e.dataTransfer.types.includes(DRAG) || e.dataTransfer.types.includes(DRAG_MEDIA)) {
      e.preventDefault();
      setOver(id);
    }
  };

  return (
    <Card className="flex min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
        <div className="flex items-center gap-2">
          <span className={clsx('rounded-md px-2 py-0.5 text-xs font-extrabold', name === 'q1' ? 'bg-nacht text-white dark:bg-koraal dark:text-nacht' : 'bg-lucht text-nacht')}>{name.toUpperCase()}</span>
          <span className="text-[13px] font-semibold">{t(`assist.${name}`)}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted tabular">
            {t('assist.tracks', { count: rows.length })} · {duration(total)}
          </span>
          <Button size="sm" variant="ghost" title={t('assist.clear')} onClick={() => confirm(t('assist.clearConfirm', { queue: name.toUpperCase() })) && a.clear.mutate(name)}>
            <Eraser className="size-4" />
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto" onDragOver={(e) => allow(e, 'end')} onDragLeave={() => setOver(null)} onDrop={(e) => drop(e, null)}>
        {rows.length === 0 && <p className="px-4 py-10 text-center text-[13px] text-muted">{t('assist.emptyQueue')}</p>}
        {rows.map((r, i) => (
          <div
            key={r.id}
            draggable={r.state === 'queued'}
            onDragStart={(e) => {
              e.dataTransfer.setData(DRAG, r.id);
              e.dataTransfer.effectAllowed = 'move';
            }}
            onDragOver={(e) => {
              e.stopPropagation();
              allow(e, r.id);
            }}
            onDrop={(e) => {
              e.stopPropagation();
              drop(e, r.id);
            }}
            className={clsx('group flex items-center gap-2 border-b border-line px-2 py-2', over === r.id && 'border-t-2 border-t-koraal', r.state !== 'queued' && 'bg-chip/50')}
          >
            <GripVertical className={clsx('size-4 shrink-0', r.state === 'queued' ? 'cursor-grab text-muted' : 'text-transparent')} />
            <span className="w-5 text-right text-[11px] text-muted tabular">{i + 1}</span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-semibold">{r.label ? `${r.label}: ` : ''}{r.media.title || r.media.path}</div>
              <div className="flex items-center gap-1.5 truncate text-[11px] text-muted">
                {r.media.artist}
                {r.requestId && <Badge tone="accent">{t('assist.request')}</Badge>}
                {r.origin === 'manual' && r.addedBy && <span>· {r.addedBy}</span>}
                {r.origin !== 'manual' && r.playlistName && <span>· {r.playlistName}</span>}
                {r.state === 'cued' && <Badge tone="online">{t('assist.cued')}</Badge>}
              </div>
            </div>
            <span className="text-xs text-muted tabular">{duration(r.media.durationSeconds)}</span>
            {r.state === 'queued' && (
              <div className="flex opacity-0 transition-opacity group-hover:opacity-100">
                <button className="rounded p-1 text-muted hover:bg-hover hover:text-ink" title={t('assist.toTop')} onClick={() => rows[0]!.id !== r.id && a.move.mutate({ itemId: r.id, queue: name, beforeId: rows[0]!.id })}>
                  <ArrowUpToLine className="size-3.5" />
                </button>
                <button className="rounded p-1 text-muted hover:bg-hover hover:text-ink" title={t('assist.toOther', { queue: otherName.toUpperCase() })} onClick={() => a.move.mutate({ itemId: r.id, queue: otherName, beforeId: null })}>
                  <ArrowLeftRight className="size-3.5" />
                </button>
                <button className="rounded p-1 text-muted hover:bg-hover hover:text-offline" title={t('assist.remove')} onClick={() => a.remove.mutate(r.id)}>
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            )}
          </div>
        ))}
        <div className={clsx('h-8', over === 'end' && 'border-t-2 border-koraal')} />
      </div>
    </Card>
  );
}

function LibraryPanel({ stationId }: { stationId: string }) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const a = useQueueActions(stationId);
  const search = useQuery({
    queryKey: ['library', stationId, q],
    queryFn: () => api<{ items: Media[]; total: number }>(`/stations/${stationId}/library?enabled=yes&limit=60&sort=artist&q=${encodeURIComponent(q)}`),
    placeholderData: (prev) => prev,
  });
  return (
    <Card className="flex min-h-0 flex-col">
      <div className="border-b border-line p-3">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" />
          <Input className="pl-9" placeholder={t('assist.search')} value={q} onChange={(e) => setQ(e.target.value)} />
          {q && (
            <button className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-1 text-muted hover:text-ink" onClick={() => setQ('')} aria-label={t('common.clear')}>
              <X className="size-4" />
            </button>
          )}
        </div>
        <div className="mt-1.5 text-[11px] text-muted">{search.data ? t('assist.found', { count: search.data.total }) : ' '}</div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {search.isPending ? (
          <div className="grid place-items-center py-10">
            <Spinner />
          </div>
        ) : !search.data?.items.length ? (
          <EmptyState icon={<ListMusic className="size-6" />} title={t('assist.noTracks')} />
        ) : (
          search.data.items.map((m) => (
            <div
              key={m.id}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(DRAG_MEDIA, m.id);
                e.dataTransfer.effectAllowed = 'copy';
              }}
              className="group flex cursor-grab items-center gap-2 border-b border-line px-3 py-2 hover:bg-hover"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-semibold">{m.title || m.path}</div>
                <div className="truncate text-[11px] text-muted">{m.artist}</div>
              </div>
              <span className="text-xs text-muted tabular">{duration(m.durationSeconds)}</span>
              <div className="flex gap-1">
                {(['q1', 'q2'] as const).map((qn) => (
                  <button
                    key={qn}
                    onClick={(e) => a.add.mutate({ mediaId: m.id, queue: qn, at: e.shiftKey ? 'top' : 'bottom' })}
                    title={t('assist.addTo', { queue: qn.toUpperCase() })}
                    className="rounded border border-line px-1.5 py-0.5 text-[10px] font-bold text-muted hover:border-koraal hover:text-ink"
                  >
                    {qn.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>
          ))
        )}
      </div>
      <div className="border-t border-line px-3 py-2 text-[11px] text-muted">{t('assist.libraryHint')}</div>
    </Card>
  );
}

export function AssistPage() {
  const { t } = useTranslation();
  const { station } = useSession();
  const autodj = useAutoDj(station?.id);
  const actions = useQueueActions(station?.id ?? '');
  if (!station) return <EmptyState icon={<ListMusic className="size-6" />} title={t('station.none')} description={t('station.noneText')} />;
  if (autodj.isPending) {
    return (
      <div className="grid place-items-center py-20">
        <Spinner />
      </div>
    );
  }
  const data = autodj.data;
  if (!data) return <EmptyState icon={<ListMusic className="size-6" />} title={t('assist.loadFailed')} description={(autodj.error as Error)?.message} />;
  if (data.edition !== 'station') {
    return (
      <Card>
        <EmptyState icon={<ListMusic className="size-6" />} title={t('assist.distributionTitle')} description={t('assist.distributionText')} />
      </Card>
    );
  }
  return (
    <div className="flex h-full min-h-[560px] flex-col gap-4">
      <NowPlaying data={data} onSkip={() => actions.skip.mutate()} skipping={actions.skip.isPending} />
      <div className="grid min-h-0 flex-1 grid-cols-[1fr_1fr_minmax(300px,0.9fr)] gap-4">
        <QueueColumn name="q1" otherName="q2" rows={data.queues.q1} stationId={station.id} />
        <QueueColumn name="q2" otherName="q1" rows={data.queues.q2} stationId={station.id} />
        <LibraryPanel stationId={station.id} />
      </div>
    </div>
  );
}
