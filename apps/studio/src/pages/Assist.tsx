import { useMutation, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ArrowUpToLine, CalendarClock, Eraser, GripVertical, ListMusic, Music2, Play, SkipForward, Square, Trash2 } from 'lucide-react';
import { useEffect, useState, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { addLocalFile, DRAG_FILE, DRAG_MEDIA, LibraryPanel, useCanUpload, type QueueName } from '../components/Library';
import { JingleBar } from '../components/Jingles';
import { Badge, Button, Card, EmptyState, Spinner } from '../components/ui';
import { api, type AutoDj } from '../lib/api';
import { duration } from '../lib/format';
import { useAutoDj } from '../lib/queries';
import { useSession } from '../lib/session';

const DRAG = 'application/x-hrs-item';

function useQueueActions(stationId: string) {
  const qc = useQueryClient();
  const { t } = useTranslation();
  const done = (data: AutoDj) => qc.setQueryData(['autodj', stationId], data);
  const fail = (err: unknown) => toast.error((err as Error).message);
  return {
    add: useMutation({
      mutationFn: (v: { mediaId: string; queue: QueueName; at: 'top' | 'bottom' }) => api<AutoDj>(`/stations/${stationId}/autodj/queue`, { method: 'POST', body: v }),
      onSuccess: (d) => {
        done(d);
        toast.success(t('assist.added'));
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
    playNow: useMutation({
      mutationFn: (v: { itemId: string } | { mediaId: string }) => api<AutoDj>(`/stations/${stationId}/autodj/play-now`, { method: 'POST', body: v }),
      onSuccess: (d) => {
        done(d);
        toast.success(t('assist.playingNow'));
        setTimeout(() => void qc.invalidateQueries({ queryKey: ['autodj', stationId] }), 1500);
      },
      onError: fail,
    }),
    player: useMutation({
      mutationFn: (command: 'play' | 'stop') => api(`/stations/${stationId}/autodj/${command}`, { method: 'POST' }),
      onSuccess: () => setTimeout(() => void qc.invalidateQueries({ queryKey: ['autodj', stationId] }), 800),
      onError: fail,
    }),
    mode: useMutation({
      mutationFn: (manual: boolean) => api<AutoDj>(`/stations/${stationId}/autodj/mode`, { method: 'POST', body: { manual } }),
      onSuccess: (d) => {
        done(d);
        toast.success(d.playout.manual ? t('playout.manualOn') : t('playout.autoOn'));
      },
      onError: fail,
    }),
  };
}

/** Auto: the player plays on from track to track. Manual: it stops after each track until Play. */
function ModeSwitch({ data, stationId }: { data: AutoDj; stationId: string }) {
  const { t } = useTranslation();
  const { supports } = useSession();
  const a = useQueueActions(stationId);
  const manual = !!data.playout?.manual;
  const can = supports('playout');
  return (
    <div role="group" aria-label={t('playout.label')} title={can ? undefined : t('server.needsUpdate')} className="flex rounded-md border border-line bg-surface p-0.5">
      {([false, true] as const).map((m) => (
        <button
          key={String(m)}
          type="button"
          disabled={!can || a.mode.isPending}
          aria-pressed={manual === m}
          onClick={() => manual !== m && a.mode.mutate(m)}
          className={clsx(
            'h-8 rounded-[7px] px-3.5 text-[13px] font-bold transition-colors disabled:cursor-not-allowed',
            manual === m ? 'bg-koraal text-nacht' : 'text-muted hover:text-ink',
          )}
        >
          {m ? t('playout.manual') : t('playout.auto')}
        </button>
      ))}
    </div>
  );
}

/** Re-renders every second: the autodj poll returns the same object while a track plays, so the clock must tick on its own. */
function useNow() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

function NowPlaying({ data, stationId }: { data: AutoDj; stationId: string }) {
  const { t } = useTranslation();
  const a = useQueueActions(stationId);
  const manual = !!data.playout?.manual;
  const holding = manual && !!data.playout?.holding;
  const np = data.nowPlaying;
  const now = useNow();
  const elapsed = np?.startedAt ? (now - new Date(np.startedAt).getTime()) / 1000 : 0;
  const total = np?.media.durationSeconds ?? null;
  const pct = total && !holding ? Math.min(100, (elapsed / total) * 100) : 0;
  const remaining = total && !holding ? Math.max(0, total - elapsed) : null;
  const next = queueOf(data).find((r) => r.state === 'cued') ?? queueOf(data)[0];
  // A track dropped on the player plays now: from a queue, the library, or this PC (uploaded first).
  const { supports } = useSession();
  const canUpload = useCanUpload();
  const [over, setOver] = useState(false);
  const accepts = (e: DragEvent) => supports('play-now') && [DRAG, DRAG_MEDIA, ...(canUpload ? [DRAG_FILE] : [])].some((k) => e.dataTransfer.types.includes(k));
  const drop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    const itemId = e.dataTransfer.getData(DRAG);
    const mediaId = e.dataTransfer.getData(DRAG_MEDIA);
    const file = e.dataTransfer.getData(DRAG_FILE);
    if (itemId) a.playNow.mutate({ itemId });
    else if (mediaId) a.playNow.mutate({ mediaId });
    else if (file && canUpload) void addLocalFile(stationId, file, 'q1', 'top', (v) => a.playNow.mutate({ mediaId: v.mediaId }), t);
  };
  return (
    <Card
      className={clsx('relative overflow-hidden', over && 'ring-2 ring-koraal')}
      onDragOver={(e) => {
        if (!accepts(e)) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={drop}
    >
      {over && (
        <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center bg-koraal/15 text-sm font-extrabold tracking-[0.08em] text-accent-text uppercase">
          {t('assist.dropToPlay')}
        </div>
      )}
      <div className="flex items-center gap-5 p-5">
        <div className="grid size-16 shrink-0 place-items-center rounded-md bg-nacht text-koraal">
          <Music2 className="size-7" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">{holding ? t('playout.waiting') : t('assist.nowPlaying')}</div>
          <div className="display truncate text-xl">{holding ? (next ? next.media.title || next.media.path : t('assist.nothing')) : np ? np.media.title || np.media.path : t('assist.nothing')}</div>
          <div className="truncate text-[13px] text-muted">
            {holding
              ? next
                ? [next.media.artist, t('playout.pressPlay')].filter(Boolean).join(' · ')
                : ''
              : np
                ? [np.media.artist, np.media.album].filter(Boolean).join(' · ')
                : !data.player.connected && data.player.expected
                  ? t('assist.playerOffline')
                  : ''}
          </div>
        </div>
        <div className="text-right">
          {holding ? (
            <>
              <div className="display text-[32px] leading-none tabular">{next ? duration(next.media.durationSeconds) : '–:––'}</div>
              <div className="mt-1 text-[11px] text-muted">{t('playout.length')}</div>
            </>
          ) : (
            <>
              <div className={clsx('display text-[32px] leading-none tabular', remaining != null && remaining < 15 && 'text-accent-text')}>{remaining != null ? `-${duration(remaining)}` : '–:––'}</div>
              <div className="mt-1 text-[11px] text-muted">{t('assist.remainingLabel')}</div>
            </>
          )}
        </div>
        <div className="flex items-center gap-2 border-l border-line pl-4">
          {manual && (
            <>
              <Button
                variant="primary"
                onClick={() => a.player.mutate('play')}
                disabled={a.player.isPending}
                title={holding ? t('playout.play') : t('playout.playAfter')}
                aria-label={t('playout.play')}
                className={clsx('size-14 px-0', holding && 'onair-pulse')}
              >
                <Play className="size-6 fill-current" />
              </Button>
              <Button variant="secondary" onClick={() => a.player.mutate('stop')} disabled={a.player.isPending || holding || !np} title={t('playout.stop')} aria-label={t('playout.stop')} className="size-12 px-0">
                <Square className="size-4 fill-current" />
              </Button>
            </>
          )}
          <Button variant="dark" onClick={() => a.skip.mutate()} loading={a.skip.isPending} disabled={(!np && !holding) || data.edition !== 'station'} className="h-12 px-5">
            <SkipForward className="size-5" /> {manual ? t('playout.next') : t('assist.skip')}
          </Button>
        </div>
      </div>
      <div className="h-1.5 bg-meter">
        <div className="h-full bg-koraal transition-[width] duration-1000 ease-linear" style={{ width: `${pct}%` }} />
      </div>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 px-5 py-2.5 text-xs text-muted">
        <ModeSwitch data={data} stationId={stationId} />
        <span className="text-[13px]">{manual ? (holding ? t('playout.holdingText') : t('playout.manualText')) : t('playout.autoText')}</span>
        {!holding && (
          <span>
            {t('assist.next')}: <b className="text-ink">{next ? `${next.media.artist ? `${next.media.artist} – ` : ''}${next.media.title}` : '–'}</b>
          </span>
        )}
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

/** The one queue (server 1.3); rows an older server still has in Q2 come after Q1. */
const queueOf = (data: AutoDj) => [...data.queues.q1, ...(data.queues.q2 ?? [])];

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

/** The playlist: what plays after the current track, with the time each track starts. */
function PlaylistCard({ data, stationId }: { data: AutoDj; stationId: string }) {
  const { t } = useTranslation();
  const a = useQueueActions(stationId);
  const canUpload = useCanUpload();
  const now = useNow();
  const [over, setOver] = useState<string | 'end' | null>(null);
  const rows = queueOf(data);
  const total = rows.reduce((n, r) => n + (r.media.durationSeconds ?? 0), 0);
  // Start times: after the playing track, each track after the one before, overlapping by the crossfade.
  const np = data.nowPlaying;
  const fade = data.settings.crossfadeSeconds ?? 0;
  const holding = !!data.playout?.manual && !!data.playout?.holding;
  let at = np?.startedAt && np.media.durationSeconds && !holding ? Math.max(now, new Date(np.startedAt).getTime() + (np.media.durationSeconds - fade) * 1000) : now;
  const starts = rows.map((r) => {
    const start = at;
    at += Math.max(0, (r.media.durationSeconds ?? 0) - fade) * 1000;
    return start;
  });

  const drop = (e: DragEvent, beforeId: string | null) => {
    e.preventDefault();
    setOver(null);
    const itemId = e.dataTransfer.getData(DRAG);
    const mediaId = e.dataTransfer.getData(DRAG_MEDIA);
    const file = e.dataTransfer.getData(DRAG_FILE);
    const at = beforeId && beforeId === rows[0]?.id ? 'top' : 'bottom';
    if (itemId) a.move.mutate({ itemId, queue: 'q1', beforeId });
    else if (mediaId) a.add.mutate({ mediaId, queue: 'q1', at });
    else if (file && canUpload) void addLocalFile(stationId, file, 'q1', at, (v) => a.add.mutate(v), t);
  };
  const allow = (e: DragEvent, id: string | 'end') => {
    if ([DRAG, DRAG_MEDIA, DRAG_FILE].some((k) => e.dataTransfer.types.includes(k))) {
      e.preventDefault();
      setOver(id);
    }
  };

  return (
    <Card className="flex min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
        <div className="flex min-w-0 items-baseline gap-3">
          <h2 className="display text-[17px]">{t('assist.playlist')}</h2>
          <span className="text-xs whitespace-nowrap text-muted tabular">
            {t('assist.tracks', { count: rows.length })} · {duration(total)}
          </span>
        </div>
        <Button size="sm" variant="ghost" title={t('assist.clear')} onClick={() => confirm(t('assist.clearConfirm')) && a.clear.mutate('q1')}>
          <Eraser className="size-4" />
        </Button>
      </div>
      <div className="grid grid-cols-[20px_64px_minmax(0,1fr)_52px_72px] items-center gap-2 bg-surface px-2 py-1.5 text-[10px] font-bold tracking-[0.06em] text-muted uppercase">
        <span />
        <span>{t('assist.start')}</span>
        <span>{t('assist.title')}</span>
        <span className="text-right">{t('assist.length')}</span>
        <span />
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
            className={clsx(
              'group grid grid-cols-[20px_64px_minmax(0,1fr)_52px_72px] items-center gap-2 border-b border-line px-2 py-2',
              over === r.id && 'border-t-2 border-t-koraal',
              r.state !== 'queued' && 'bg-chip/50',
            )}
          >
            <GripVertical className={clsx('size-4', r.state === 'queued' ? 'cursor-grab text-muted' : 'text-transparent')} />
            <span className="text-[13px] font-semibold tabular">{clock(starts[i]!)}</span>
            <div className="min-w-0">
              <div className="truncate text-[13px] font-semibold">{r.label ? `${r.label}: ` : ''}{r.media.title || r.media.path}</div>
              <div className="flex items-center gap-1.5 truncate text-[11px] text-muted">
                {r.media.artist}
                {r.requestId && <Badge tone="accent">{t('assist.request')}</Badge>}
                {r.origin === 'manual' && r.addedBy && <span>· {r.addedBy}</span>}
                {r.origin !== 'manual' && r.playlistName && <span>· {r.playlistName}</span>}
                {r.state === 'cued' && <Badge tone="online">{t('assist.cued')}</Badge>}
              </div>
            </div>
            <span className="text-right text-xs text-muted tabular">{duration(r.media.durationSeconds)}</span>
            {r.state === 'queued' ? (
              <div className="flex justify-end opacity-0 transition-opacity group-hover:opacity-100">
                <button className="rounded p-1 text-muted hover:bg-hover hover:text-ink" title={t('assist.toTop')} onClick={() => rows[0]!.id !== r.id && a.move.mutate({ itemId: r.id, queue: 'q1', beforeId: rows[0]!.id })}>
                  <ArrowUpToLine className="size-3.5" />
                </button>
                <button className="rounded p-1 text-muted hover:bg-hover hover:text-offline" title={t('assist.remove')} onClick={() => a.remove.mutate(r.id)}>
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            ) : (
              <span />
            )}
          </div>
        ))}
        <div className={clsx('h-8', over === 'end' && 'border-t-2 border-koraal')} />
      </div>
    </Card>
  );
}

export function AssistPage() {
  const { t } = useTranslation();
  const { station, supports } = useSession();
  const autodj = useAutoDj(station?.id);
  const queueActions = useQueueActions(station?.id ?? '');
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
    <div className="grid h-full min-h-[600px] grid-cols-[minmax(0,1fr)_minmax(300px,360px)] gap-4">
      <div className="flex min-h-0 flex-col gap-4">
        <NowPlaying data={data} stationId={station.id} />
        {supports('jingles') && <JingleBar stationId={station.id} />}
        <PlaylistCard data={data} stationId={station.id} />
      </div>
      <LibraryPanel stationId={station.id} add={(v) => queueActions.add.mutate(v)} />
    </div>
  );
}
