import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { GripVertical, ListPlus, Music2, Pause, Plus, Radio, RefreshCw, Search, SkipForward, X } from 'lucide-react';
import { useEffect, useState, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { api, ApiError, type AutodjSettings, type AutodjView, type MediaFile, type QueueName, type QueueRow, type StationDetail } from '../../lib/api';
import { formatSeconds } from '../../lib/format';
import { paint } from './Clocks';
import { Badge, Button, Card, CardHeader, Dialog, EmptyState, Field, Input, Select, Spinner, Switch } from '../ui';

export function useAutodj(stationId: string) {
  return useQuery({ queryKey: ['autodj', stationId], queryFn: () => api<AutodjView>(`/stations/${stationId}/autodj`), refetchInterval: 5000 });
}

/** Seconds since a moment, updated every second. */
function useElapsed(since: string | null) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!since) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [since]);
  return since ? Math.max(0, (now - new Date(since).getTime()) / 1000) : 0;
}

function OriginBadge({ row }: { row: QueueRow }) {
  const { t } = useTranslation();
  if (row.origin === 'request') return <Badge tone="accent">{t('autodj.origin.request')}</Badge>;
  if (row.origin === 'clock') return <Badge tone="accent">{row.label ?? t('autodj.origin.clock')}</Badge>;
  if (row.origin === 'manual') return <Badge tone="neutral">{row.addedBy ? t('autodj.origin.manualBy', { name: row.addedBy }) : t('autodj.origin.manual')}</Badge>;
  const name = row.label ?? row.playlistName;
  return name ? <span className="truncate text-[11px] text-muted">{name}</span> : null;
}

function NowPlaying({ station, view, canSkip }: { station: StationDetail; view: AutodjView; canSkip: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const np = view.nowPlaying;
  const elapsed = useElapsed(np?.startedAt ?? null);
  const duration = np?.media.durationSeconds ?? null;
  const pct = duration ? Math.min(100, (elapsed / duration) * 100) : 0;
  const skip = useMutation({
    mutationFn: (force?: boolean) => api(`/stations/${station.id}/autodj/skip`, { method: 'POST', body: force ? { force } : {} }),
    onSuccess: () => {
      toast.success(t('autodj.skipped'));
      setTimeout(() => void qc.invalidateQueries({ queryKey: ['autodj', station.id] }), 1500);
    },
    // A locked item of the format: managers may skip it after all.
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'locked') {
        if (confirm(err.message)) skip.mutate(true);
      } else toast.error((err as Error).message);
    },
  });
  const p = view.player;
  const state = !view.settings.enabled ? (
    <Badge tone="neutral">{t('autodj.state.off')}</Badge>
  ) : !p.expected ? (
    <Badge tone="warning">{t('autodj.state.stationOff')}</Badge>
  ) : p.paused ? (
    <Badge tone="accent" dot>
      {t('autodj.state.paused')}
    </Badge>
  ) : p.stuckSince ? (
    <Badge tone="warning" dot>
      {t('autodj.state.stuck')}
    </Badge>
  ) : p.connected ? (
    <Badge tone="online" dot>
      {t('autodj.state.playing')}
    </Badge>
  ) : (
    <Badge tone="warning" dot>
      {t('autodj.state.starting')}
    </Badge>
  );

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-col gap-5 p-5 sm:flex-row sm:items-center">
        <div className="grid size-20 shrink-0 place-items-center rounded-lg bg-nacht text-koraal dark:bg-chip">
          {p.paused ? <Pause className="size-8" /> : <Music2 className="size-8" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">{t('autodj.nowPlaying')}</span>
            {state}
            {np?.origin === 'clock' && <OriginBadge row={np} />}
            {view.schedule.enabled && (view.schedule.entry || view.schedule.clock) && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-chip px-2.5 py-0.5 text-[11px] font-semibold">
                <i className="size-2 rounded-full" style={{ background: view.schedule.clock ? paint(view.schedule.clock.color) : 'var(--koraal)' }} />
                {[view.schedule.entry?.name, view.schedule.clock?.name ?? t('autodj.queuesOnly')].filter(Boolean).join(' · ')}
              </span>
            )}
          </div>
          {np ? (
            <>
              <div className="display mt-1 truncate text-xl">{np.media.title}</div>
              <div className="truncate text-sm text-muted">{[np.media.artist, np.media.album].filter(Boolean).join(' · ') || '—'}</div>
              <div className="mt-3 flex items-center gap-3">
                <span className="w-10 text-right text-xs text-muted tabular-nums">{formatSeconds(elapsed)}</span>
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-chip">
                  <div className="h-full rounded-full bg-koraal transition-[width] duration-1000 ease-linear" style={{ width: `${pct}%` }} />
                </div>
                <span className="w-10 text-xs text-muted tabular-nums">{formatSeconds(duration)}</span>
              </div>
            </>
          ) : (
            <p className="mt-1 text-sm text-muted">{p.paused ? t('autodj.pausedHint') : t('autodj.nothingPlaying')}</p>
          )}
          {view.coveredMounts.length > 0 && view.mount && (
            <p className="mt-2 text-xs text-muted">
              <Radio className="mr-1 inline size-3.5" />
              {t('autodj.covers', { mount: view.mount.path, mounts: view.coveredMounts.join(', ') })}
            </p>
          )}
        </div>
        {canSkip && view.settings.enabled && (
          <Button variant="dark" disabled={!np || p.paused} loading={skip.isPending} onClick={() => skip.mutate()}>
            <SkipForward className="size-4" /> {t('autodj.skip')}
          </Button>
        )}
      </div>
    </Card>
  );
}

function AddTrackDialog({ station, open, onClose }: { station: StationDetail; open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [at, setAt] = useState<'top' | 'bottom'>('top');
  const results = useQuery({
    queryKey: ['library-search', station.id, q],
    queryFn: () => api<{ items: MediaFile[]; total: number }>(`/stations/${station.id}/library?${new URLSearchParams({ q, limit: '40', enabled: 'yes' })}`),
    enabled: open,
  });
  const add = useMutation({
    mutationFn: (mediaId: string) => api<AutodjView>(`/stations/${station.id}/autodj/queue`, { method: 'POST', body: { mediaId, at } }),
    onSuccess: (view, mediaId) => {
      qc.setQueryData(['autodj', station.id], view);
      const m = results.data?.items.find((i) => i.id === mediaId);
      toast.success(t('autodj.added', { title: m?.title ?? '' }));
    },
    onError: (err) => toast.error((err as Error).message),
  });
  return (
    <Dialog open={open} onClose={onClose} title={t('autodj.addTitle')} description={t('autodj.addHint')} wide>
      <div className="flex flex-col gap-3">
        <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
          <div className="relative">
            <Search className="pointer-events-none absolute top-3 left-3 size-4 text-muted" />
            <Input autoFocus className="pl-9" placeholder={t('library.search')} value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <Select value={at} onChange={(e) => setAt(e.target.value as 'top' | 'bottom')}>
            <option value="top">{t('autodj.atTop')}</option>
            <option value="bottom">{t('autodj.atBottom')}</option>
          </Select>
        </div>
        <ul className="max-h-[50vh] overflow-y-auto rounded-md border border-line">
          {results.isPending ? (
            <li className="grid place-items-center py-8">
              <Spinner />
            </li>
          ) : !results.data?.items.length ? (
            <li className="px-4 py-8 text-center text-sm text-muted">{t('library.noResults')}</li>
          ) : (
            results.data.items.map((m) => (
              <li key={m.id} className="flex items-center gap-3 border-b border-line px-3 py-2 last:border-b-0 hover:bg-hover">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold">{m.title}</div>
                  <div className="truncate text-xs text-muted">{m.artist || '—'}</div>
                </div>
                <span className="text-xs text-muted tabular-nums">{formatSeconds(m.durationSeconds)}</span>
                <Button size="sm" variant="secondary" loading={add.isPending && add.variables === m.id} onClick={() => add.mutate(m.id)}>
                  <Plus className="size-4" /> {t('autodj.addShort')}
                </Button>
              </li>
            ))
          )}
        </ul>
      </div>
    </Dialog>
  );
}

function QueueColumn({
  station,
  name,
  rows,
  weight,
  onAdd,
}: {
  station: StationDetail;
  name: QueueName;
  rows: QueueRow[];
  weight: string;
  onAdd: () => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [over, setOver] = useState<string | null>(null);
  const set = (view: AutodjView) => qc.setQueryData(['autodj', station.id], view);
  const onError = (err: unknown) => toast.error((err as Error).message);
  const move = useMutation({
    mutationFn: ({ id, beforeId }: { id: string; beforeId: string | null }) => api<AutodjView>(`/stations/${station.id}/autodj/queue/${id}`, { method: 'PATCH', body: { queue: name, beforeId } }),
    onSuccess: set,
    onError,
  });
  const remove = useMutation({ mutationFn: (id: string) => api<AutodjView>(`/stations/${station.id}/autodj/queue/${id}`, { method: 'DELETE' }), onSuccess: set, onError });
  const refresh = useMutation({
    mutationFn: () => api<AutodjView>(`/stations/${station.id}/autodj/queue/clear`, { method: 'POST', body: { queue: name, rotationOnly: true } }),
    onSuccess: (v) => {
      set(v);
      toast.success(t('autodj.refreshed'));
    },
    onError,
  });
  const drop = (e: DragEvent, beforeId: string | null) => {
    e.preventDefault();
    setOver(null);
    const id = e.dataTransfer.getData('text/x-hrs-queue');
    if (id && id !== beforeId) move.mutate({ id, beforeId });
  };

  return (
    <Card className="flex flex-col">
      <CardHeader
        title={
          <span className="inline-flex items-center gap-2.5">
            {t('autodj.queueTitle')}
          </span>
        }
        description={weight}
        actions={
          <>
            <Button size="sm" variant="ghost" title={t('autodj.refresh')} loading={refresh.isPending} onClick={() => refresh.mutate()}>
              <RefreshCw className="size-4" />
            </Button>
            <Button size="sm" variant="secondary" onClick={onAdd}>
              <ListPlus className="size-4" /> {t('autodj.add')}
            </Button>
          </>
        }
      />
      <ul
        className={clsx('flex min-h-40 flex-1 flex-col p-2', over === 'end' && 'bg-koraal/5')}
        onDragOver={(e) => {
          e.preventDefault();
          if (!over) setOver('end');
        }}
        onDragLeave={() => setOver(null)}
        onDrop={(e) => drop(e, null)}
      >
        {!rows.length && <li className="m-auto px-4 py-8 text-center text-[13px] text-muted">{t('autodj.emptyQueue')}</li>}
        {rows.map((r, i) => {
          const waiting = r.state === 'queued';
          return (
            <li
              key={r.id}
              draggable={waiting}
              onDragStart={(e) => {
                e.dataTransfer.setData('text/x-hrs-queue', r.id);
                e.dataTransfer.effectAllowed = 'move';
              }}
              onDragOver={(e) => {
                if (!waiting) return;
                e.preventDefault();
                e.stopPropagation();
                setOver(r.id);
              }}
              onDrop={(e) => {
                if (!waiting) return;
                e.stopPropagation();
                drop(e, r.id);
              }}
              className={clsx(
                'group flex items-center gap-2 rounded-md px-2 py-2 transition-colors',
                waiting ? 'cursor-grab hover:bg-hover active:cursor-grabbing' : 'bg-koraal/8',
                over === r.id && 'shadow-[inset_0_2px_0_0_var(--color-koraal)]',
              )}
            >
              <GripVertical className={clsx('size-4 shrink-0', waiting ? 'text-muted' : 'text-transparent')} />
              <span className="w-5 shrink-0 text-right text-xs text-muted tabular-nums">{i + 1}</span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[13px] font-semibold">{r.media.title}</span>
                  {r.state === 'cued' && <Badge tone="online">{t('autodj.next')}</Badge>}
                </div>
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-xs text-muted">{r.media.artist || '—'}</span>
                  <OriginBadge row={r} />
                </div>
              </div>
              <span className="text-xs text-muted tabular-nums">{formatSeconds(r.media.durationSeconds)}</span>
              {waiting && (
                <button className="rounded p-1 text-muted opacity-60 group-hover:opacity-100 hover:bg-chip hover:text-offline" title={t('common.remove')} onClick={() => remove.mutate(r.id)}>
                  <X className="size-4" />
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function SettingsCard({ station, view }: { station: StationDetail; view: AutodjView }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<AutodjSettings>(view.settings);
  useEffect(() => setDraft(view.settings), [view.settings]);
  const save = useMutation({
    mutationFn: (body: AutodjSettings) => api<AutodjView>(`/stations/${station.id}/autodj`, { method: 'PUT', body }),
    onSuccess: (v) => {
      qc.setQueryData(['autodj', station.id], v);
      toast.success(t('common.saved'));
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const sources = station.mounts.filter((m) => m.kind === 'source');
  const num = (v: string, min: number, max: number) => Math.min(max, Math.max(min, Number(v) || 0));
  const restart = draft.crossfadeSeconds !== view.settings.crossfadeSeconds || draft.normalize !== view.settings.normalize || draft.mountId !== view.settings.mountId;

  return (
    <Card>
      <CardHeader title={t('autodj.settings')} description={t('autodj.settingsHint')} />
      <div className="flex flex-col gap-5 p-5">
        <Switch checked={draft.enabled} onChange={(enabled) => setDraft({ ...draft, enabled })} label={t('autodj.enabled')} description={t('autodj.enabledHint')} />
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label={t('autodj.depth')} hint={t('autodj.depthHint')}>
            <Input type="number" min={1} max={50} value={draft.queueDepth} onChange={(e) => setDraft({ ...draft, queueDepth: num(e.target.value, 1, 50) })} />
          </Field>
          <Field label={t('autodj.artistSeparation')} hint={t('autodj.minutes')}>
            <Input type="number" min={0} max={1440} value={draft.artistSeparationMinutes} onChange={(e) => setDraft({ ...draft, artistSeparationMinutes: num(e.target.value, 0, 1440) })} />
          </Field>
          <Field label={t('autodj.trackSeparation')} hint={t('autodj.minutes')}>
            <Input type="number" min={0} max={10080} value={draft.trackSeparationMinutes} onChange={(e) => setDraft({ ...draft, trackSeparationMinutes: num(e.target.value, 0, 10080) })} />
          </Field>
        </div>
        <Switch checked={draft.fill.q1} onChange={(q1) => setDraft({ ...draft, fill: { ...draft.fill, q1 } })} label={t('autodj.fill')} description={t('autodj.fillHint')} />
        <div className="border-t border-line pt-4">
          <div className="mb-3 text-[13px] font-semibold">{t('autodj.sound')}</div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('autodj.crossfade', { seconds: draft.crossfadeSeconds })} hint={t('autodj.crossfadeHint')}>
              <input type="range" min={0} max={15} step={0.5} value={draft.crossfadeSeconds} onChange={(e) => setDraft({ ...draft, crossfadeSeconds: Number(e.target.value) })} className="accent-koraal" />
            </Field>
            <Field label={t('autodj.mount')} hint={t('autodj.mountHint')}>
              <Select value={draft.mountId ?? ''} onChange={(e) => setDraft({ ...draft, mountId: e.target.value || null })}>
                <option value="">—</option>
                {sources.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.path} ({m.format.toUpperCase()} {m.bitrateKbps} kbps)
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="mt-4 flex flex-col gap-4">
            <Switch checked={draft.normalize} onChange={(normalize) => setDraft({ ...draft, normalize })} label={t('autodj.normalize')} description={t('autodj.normalizeHint')} />
            <Switch checked={draft.pauseWhenLive} onChange={(pauseWhenLive) => setDraft({ ...draft, pauseWhenLive })} label={t('autodj.pauseWhenLive')} description={t('autodj.pauseWhenLiveHint')} />
          </div>
        </div>
        {draft.codePrefix !== undefined && (
          <div className="border-t border-line pt-4">
            <div className="mb-3 text-[13px] font-semibold">{t('autodj.library')}</div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t('autodj.codePrefix')} hint={t('autodj.codePrefixHint')}>
                <Input className="font-mono uppercase" maxLength={6} value={draft.codePrefix} onChange={(e) => setDraft({ ...draft, codePrefix: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) })} />
              </Field>
            </div>
            <div className="mt-4">
              <Switch checked={draft.analyse ?? true} onChange={(analyse) => setDraft({ ...draft, analyse })} label={t('autodj.analyse')} description={t('autodj.analyseHint')} />
            </div>
          </div>
        )}
        <div className="border-t border-line pt-4">
          <div className="mb-3 text-[13px] font-semibold">{t('autodj.requests')}</div>
          <div className="flex flex-col gap-4">
            <Switch
              checked={draft.requests.fromLibrary}
              onChange={(fromLibrary) => setDraft({ ...draft, requests: { ...draft.requests, fromLibrary } })}
              label={t('autodj.fromLibrary')}
              description={t('autodj.fromLibraryHint')}
            />
            <Switch
              checked={draft.requests.autoQueue}
              onChange={(autoQueue) => setDraft({ ...draft, requests: { ...draft.requests, autoQueue } })}
              label={t('autodj.autoQueue')}
              description={t('autodj.autoQueueHint')}
            />
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t('autodj.repeatMinutes')} hint={t('autodj.repeatMinutesHint')}>
                <Input type="number" min={0} max={1440} value={draft.requests.repeatMinutes} onChange={(e) => setDraft({ ...draft, requests: { ...draft.requests, repeatMinutes: num(e.target.value, 0, 1440) } })} />
              </Field>
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-3">
          {restart && <span className="text-xs text-muted">{t('autodj.restartNote')}</span>}
          <Button variant="dark" loading={save.isPending} onClick={() => save.mutate(draft)}>
            {t('common.save')}
          </Button>
        </div>
      </div>
    </Card>
  );
}

export function AutodjTab({ station, canEdit }: { station: StationDetail; canEdit: boolean }) {
  const { t } = useTranslation();
  const query = useAutodj(station.id);
  const [adding, setAdding] = useState(false);
  if (query.isPending) {
    return (
      <div className="grid place-items-center py-16">
        <Spinner />
      </div>
    );
  }
  const view = query.data;
  if (!view) return <Card className="p-8 text-center text-muted">{(query.error as Error)?.message}</Card>;
  return (
    <div className="flex flex-col gap-4">
      <NowPlaying station={station} view={view} canSkip />
      {view.library.tracks === 0 && (
        <Card>
          <EmptyState icon={<Music2 className="size-5" />} title={t('autodj.noMusic')} description={t('autodj.noMusicHint')} />
        </Card>
      )}
      <QueueColumn station={station} name="q1" rows={[...view.queues.q1, ...view.queues.q2]} weight={t('autodj.queueHint')} onAdd={() => setAdding(true)} />
      {canEdit && <SettingsCard station={station} view={view} />}
      <AddTrackDialog station={station} open={adding} onClose={() => setAdding(false)} />
    </div>
  );
}
