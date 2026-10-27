import { useMutation, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ArrowLeftRight, ArrowUpToLine, CalendarClock, Eraser, GripVertical, ListMusic, Minus, Music2, Play, Plus, SkipForward, Square, Trash2 } from 'lucide-react';
import { useEffect, useState, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { addLocalFile, DRAG_FILE, DRAG_MEDIA, LibraryPanel, useCanUpload, type QueueName } from '../components/Library';
import { Badge, Button, Card, EmptyState, Spinner } from '../components/ui';
import { api, type AutoDj, type QueueRow, type QueueRule } from '../lib/api';
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
    rule: useMutation({
      mutationFn: (rule: QueueRule) => api<AutoDj>(`/stations/${stationId}/queue-rule`, { method: 'PUT', body: rule }),
      onSuccess: done,
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
  const next = [...data.queues.q1, ...data.queues.q2].find((r) => r.state === 'cued') ?? data.queues.q1[0] ?? data.queues.q2[0];
  return (
    <Card className="overflow-hidden">
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

function QueueColumn({ name, rows, stationId, otherName }: { name: QueueName; rows: QueueRow[]; stationId: string; otherName: QueueName }) {
  const { t } = useTranslation();
  const a = useQueueActions(stationId);
  const canUpload = useCanUpload();
  const [over, setOver] = useState<string | 'end' | null>(null);
  const total = rows.reduce((n, r) => n + (r.media.durationSeconds ?? 0), 0);

  const drop = (e: DragEvent, beforeId: string | null) => {
    e.preventDefault();
    setOver(null);
    const itemId = e.dataTransfer.getData(DRAG);
    const mediaId = e.dataTransfer.getData(DRAG_MEDIA);
    const file = e.dataTransfer.getData(DRAG_FILE);
    const at = beforeId && beforeId === rows[0]?.id ? 'top' : 'bottom';
    if (itemId) a.move.mutate({ itemId, queue: name, beforeId });
    else if (mediaId) a.add.mutate({ mediaId, queue: name, at });
    else if (file && canUpload) void addLocalFile(stationId, file, name, at, (v) => a.add.mutate(v), t);
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
        <div className="flex min-w-0 items-center gap-2">
          <span className={clsx('shrink-0 rounded-md px-2 py-0.5 text-xs font-extrabold', name === 'q1' ? 'bg-nacht text-white dark:bg-koraal dark:text-nacht' : 'bg-lucht text-nacht')}>{name.toUpperCase()}</span>
          <span className="truncate text-[13px] font-semibold">{t(`assist.${name}`)}</span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="text-xs whitespace-nowrap text-muted tabular" title={t('assist.tracks', { count: rows.length })}>
            {rows.length} · {duration(total)}
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

/** Which queue leads the rule: the one that plays first or most. */
const leadOf = (r: QueueRule): 'q1' | 'q2' => (r.mode === 'q2_first' || (r.mode === 'ratio' && r.q2 > r.q1) ? 'q2' : 'q1');

/** Between the queues: how the AutoDJ takes turns between Q1 and Q2, and from which queue the next track comes. */
function TakeTurns({ data, stationId }: { data: AutoDj; stationId: string }) {
  const { t } = useTranslation();
  const { supports } = useSession();
  const a = useQueueActions(stationId);
  const rule = data.settings.rule;
  const lead = leadOf(rule);
  const other = lead === 'q1' ? 'q2' : 'q1';
  const can = supports('queue-rule') && !a.rule.isPending;
  const many = Math.max(rule.q1, rule.q2);
  const few = Math.min(rule.q1, rule.q2);
  const ratio = (n: number, l: 'q1' | 'q2' = lead): QueueRule => (l === 'q1' ? { mode: 'ratio', q1: n, q2: 1 } : { mode: 'ratio', q1: 1, q2: n });
  const flip = () =>
    a.rule.mutate(
      rule.mode === 'ratio' ? { ...rule, q1: rule.q2, q2: rule.q1 } : rule.mode === 'alternate' ? rule : { ...rule, mode: rule.mode === 'q1_first' ? 'q2_first' : 'q1_first' },
    );
  const cued = [...data.queues.q1, ...data.queues.q2].find((r) => r.state === 'cued');
  const options = [
    { key: 'ratio', label: rule.mode === 'ratio' ? `${many} : ${few}` : '3 : 1', on: rule.mode === 'ratio', pick: () => a.rule.mutate(ratio(3)) },
    { key: 'alternate', label: t('turns.alternate'), on: rule.mode === 'alternate', pick: () => a.rule.mutate({ ...rule, mode: 'alternate' }) },
    {
      key: 'first',
      label: t('turns.first', { queue: lead.toUpperCase() }),
      on: rule.mode === 'q1_first' || rule.mode === 'q2_first',
      pick: () => a.rule.mutate({ ...rule, mode: lead === 'q1' ? 'q1_first' : 'q2_first' }),
    },
  ];
  return (
    <div role="group" aria-label={t('turns.label')} title={supports('queue-rule') ? undefined : t('server.needsUpdate')} className="flex flex-col justify-center gap-2">
      <div className="text-center text-[10px] font-extrabold tracking-[0.08em] text-muted uppercase">{t('turns.label')}</div>
      <button
        type="button"
        onClick={flip}
        disabled={!can || rule.mode === 'alternate'}
        title={t('turns.flip')}
        className="h-10 rounded-md border border-line bg-raised text-[13px] font-extrabold hover:bg-hover disabled:cursor-not-allowed disabled:opacity-55"
      >
        {lead.toUpperCase()} → {other.toUpperCase()}
      </button>
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          disabled={!can}
          aria-pressed={o.on}
          onClick={() => !o.on && o.pick()}
          className={clsx(
            'h-8 rounded-md border text-xs font-bold transition-colors disabled:cursor-not-allowed',
            o.on ? 'border-koraal bg-koraal text-nacht' : 'border-line bg-raised text-muted hover:text-ink',
          )}
        >
          {o.label}
        </button>
      ))}
      {rule.mode === 'ratio' && (
        <div className="flex items-center justify-between gap-1">
          <button type="button" disabled={!can || many <= 1} onClick={() => a.rule.mutate(ratio(many - 1))} aria-label={t('turns.fewer', { queue: lead.toUpperCase() })} className="grid size-7 place-items-center rounded-md border border-line text-muted hover:text-ink disabled:opacity-40">
            <Minus className="size-3.5" />
          </button>
          <span className="text-[11px] text-muted tabular">{lead.toUpperCase()}</span>
          <button type="button" disabled={!can || many >= 20} onClick={() => a.rule.mutate(ratio(many + 1))} aria-label={t('turns.more', { queue: lead.toUpperCase() })} className="grid size-7 place-items-center rounded-md border border-line text-muted hover:text-ink disabled:opacity-40">
            <Plus className="size-3.5" />
          </button>
        </div>
      )}
      <div className="mt-1 text-center text-[11px] leading-tight text-muted">
        {t('turns.nextFrom')}
        <br />
        <b className="text-ink">{cued ? cued.queue.toUpperCase() : '–'}</b>
      </div>
    </div>
  );
}

export function AssistPage() {
  const { t } = useTranslation();
  const { station } = useSession();
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
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_112px_minmax(0,1fr)] gap-3">
          <QueueColumn name="q1" otherName="q2" rows={data.queues.q1} stationId={station.id} />
          <TakeTurns data={data} stationId={station.id} />
          <QueueColumn name="q2" otherName="q1" rows={data.queues.q2} stationId={station.id} />
        </div>
      </div>
      <LibraryPanel stationId={station.id} add={(v) => queueActions.add.mutate(v)} />
    </div>
  );
}
