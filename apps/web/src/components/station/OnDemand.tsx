import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleDot, FolderUp, ListMusic, Pencil, RefreshCw, Scissors, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { api, type OnDemandItem, type PublicPageSettings, type StationDetail } from '../../lib/api';
import { formatBytes, formatDate } from '../../lib/format';
import { Badge, Button, Card, CardHeader, Dialog, EmptyState, Field, Input, Spinner, Switch, Textarea } from '../ui';
import { usePublicPage } from './PublicPage';
import { parseClock } from './Recordings';

const length = (s: number | null) => {
  if (s == null) return '—';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`;
};

function OnDemandSettings({ station }: { station: StationDetail }) {
  const { t } = useTranslation();
  const { query, save } = usePublicPage(station.id);
  const [draft, setDraft] = useState<Pick<PublicPageSettings, 'onDemand' | 'recording'> | null>(null);
  useEffect(() => {
    if (query.data) setDraft({ onDemand: query.data.settings.onDemand, recording: query.data.settings.recording });
  }, [query.data]);
  if (!draft) return null;
  const rec = draft.recording;
  const setRec = (p: Partial<typeof rec>) => setDraft({ ...draft, recording: { ...rec, ...p } });
  return (
    <Card className="p-5">
      <h2 className="display text-base">{t('onDemand.settings')}</h2>
      <div className="mt-4 flex flex-col gap-4">
        <Switch checked={draft.onDemand.enabled} onChange={(enabled) => setDraft({ ...draft, onDemand: { enabled } })} label={t('onDemand.enabled')} description={t('onDemand.enabledHint')} />
        <div className="border-t border-line pt-4">
          <Switch checked={rec.enabled} onChange={(enabled) => setRec({ enabled })} label={t('onDemand.record')} description={t('onDemand.recordHint')} />
        </div>
        {rec.enabled && (
          <>
            <Switch checked={rec.autoPublish} onChange={(autoPublish) => setRec({ autoPublish })} label={t('onDemand.autoPublish')} description={t('onDemand.autoPublishHint')} />
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t('onDemand.minMinutes')} hint={t('onDemand.minMinutesHint')}>
                <Input type="number" min={0} max={120} value={rec.minMinutes} onChange={(e) => setRec({ minMinutes: Number(e.target.value) })} />
              </Field>
              <Field label={t('onDemand.keepDays')} hint={t('onDemand.keepDaysHint')}>
                <Input type="number" min={0} max={3650} value={rec.keepDays} onChange={(e) => setRec({ keepDays: Number(e.target.value) })} />
              </Field>
            </div>
          </>
        )}
        <div className="flex justify-end">
          <Button variant="dark" loading={save.isPending} onClick={() => save.mutate(draft)}>
            {t('common.save')}
          </Button>
        </div>
      </div>
    </Card>
  );
}

function EditDialog({ station, item, onClose }: { station: StationDetail; item: OnDemandItem; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [draft, setDraft] = useState({ title: item.title, host: item.host, description: item.description });
  const save = useMutation({
    mutationFn: () => api(`/stations/${station.id}/ondemand/${item.id}`, { method: 'PATCH', body: draft }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['station-ondemand', station.id] });
      toast.success(t('common.saved'));
      onClose();
    },
    onError: (err) => toast.error((err as Error).message),
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('onDemand.edit')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="dark" loading={save.isPending} onClick={() => save.mutate()}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label={t('onDemand.itemTitle')}>
          <Input value={draft.title} maxLength={200} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
        </Field>
        <Field label={t('onDemand.host')}>
          <Input value={draft.host} maxLength={100} onChange={(e) => setDraft({ ...draft, host: e.target.value })} />
        </Field>
        <Field label={t('stations.description')}>
          <Textarea className="font-sans text-sm" maxLength={2000} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
        </Field>
        <audio controls preload="none" src={item.previewUrl} className="mt-1 w-full" />
      </div>
    </Dialog>
  );
}

/**
 * Cut an item down to a start and an end (the talk before the show really began, the minutes after it), without
 * encoding again. The file is replaced, so it cannot be undone.
 */
function TrimDialog({ station, item, onClose }: { station: StationDetail; item: OnDemandItem; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const ref = useRef<HTMLAudioElement>(null);
  const total = item.durationSeconds ?? 0;
  const [from, setFrom] = useState('0:00');
  const [to, setTo] = useState(length(total));
  const a = parseClock(from);
  const b = parseClock(to);
  const valid = a !== null && b !== null && b - a >= 1 && a < total;
  const save = useMutation({
    mutationFn: () => api<OnDemandItem>(`/stations/${station.id}/ondemand/${item.id}/trim`, { method: 'POST', body: { from: a, to: Math.min(b!, total) } }),
    onSuccess: (row) => {
      void qc.invalidateQueries({ queryKey: ['station-ondemand', station.id] });
      toast.success(t('onDemand.trimmed', { length: length(row.durationSeconds) }));
      onClose();
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const mark = (set: (v: string) => void) => set(length(Math.floor(ref.current?.currentTime ?? 0)));
  const jump = (s: number | null) => {
    if (!ref.current || s === null) return;
    ref.current.currentTime = Math.max(0, s);
    void ref.current.play();
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('onDemand.trim')}
      description={t('onDemand.trimHint')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="dark" disabled={!valid} loading={save.isPending} onClick={() => confirm(t('onDemand.trimConfirm')) && save.mutate()}>
            <Scissors className="size-4" /> {t('onDemand.trimSave')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="text-sm font-semibold">{item.title}</div>
        <audio ref={ref} controls preload="metadata" src={item.previewUrl} className="w-full" />
        <div className="grid gap-3">
          {(
            [
              ['trimFrom', from, setFrom, a, () => jump(a)],
              ['trimTo', to, setTo, b, () => jump((b ?? 0) - 5)],
            ] as const
          ).map(([key, value, set, parsed, listen]) => (
            <Field key={key} label={t(`onDemand.${key}`)}>
              <div className="flex gap-1.5">
                <Input className="w-28! shrink-0 font-mono" value={value} aria-invalid={parsed === null} onChange={(e) => set(e.target.value)} />
                <Button size="sm" variant="ghost" onClick={() => mark(set)}>
                  {t('onDemand.trimMark')}
                </Button>
                <Button size="sm" variant="ghost" disabled={parsed === null} onClick={listen}>
                  {t('onDemand.trimListen')}
                </Button>
              </div>
            </Field>
          ))}
        </div>
        <p className="text-[13px] text-muted">
          {valid ? t('onDemand.trimResult', { length: length(Math.round(Math.min(b!, total) - a!)), total: length(total) }) : t('onDemand.trimInvalid')}
        </p>
      </div>
    </Dialog>
  );
}

export function OnDemandTab({ station, canEdit }: { station: StationDetail; canEdit: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<OnDemandItem | null>(null);
  const [trimming, setTrimming] = useState<OnDemandItem | null>(null);
  const list = useQuery({
    queryKey: ['station-ondemand', station.id],
    queryFn: () => api<{ items: OnDemandItem[] }>(`/stations/${station.id}/ondemand`),
    refetchInterval: (q) => (q.state.data?.items.some((i) => i.recording) ? 10_000 : 60_000),
  });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['station-ondemand', station.id] });
  const publish = useMutation({
    mutationFn: ({ id, published }: { id: string; published: boolean }) => api(`/stations/${station.id}/ondemand/${id}`, { method: 'PATCH', body: { published } }),
    onSuccess: refresh,
    onError: (err) => toast.error((err as Error).message),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/stations/${station.id}/ondemand/${id}`, { method: 'DELETE' }),
    onSuccess: refresh,
    onError: (err) => toast.error((err as Error).message),
  });
  const scan = useMutation({
    mutationFn: () => api(`/stations/${station.id}/ondemand/scan`, { method: 'POST' }),
    onSuccess: refresh,
  });
  const items = list.data?.items ?? [];

  return (
    <div className="grid items-start gap-4 xl:grid-cols-[1.6fr_1fr]">
      <Card>
        <CardHeader
          title={t('onDemand.title')}
          description={t('onDemand.subtitle')}
          actions={
            canEdit && (
              <Button size="sm" loading={scan.isPending} onClick={() => scan.mutate()}>
                <RefreshCw className="size-4" /> {t('onDemand.scan')}
              </Button>
            )
          }
        />
        {list.isPending ? (
          <div className="grid place-items-center py-10">
            <Spinner />
          </div>
        ) : !items.length ? (
          <EmptyState icon={<ListMusic className="size-5" />} title={t('onDemand.empty')} description={t('onDemand.emptyHint')} />
        ) : (
          <ul className="flex flex-col">
            {items.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center gap-3 border-t border-line px-5 py-3.5 first:border-t-0">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate font-semibold">{i.title}</span>
                    {i.recording ? (
                      <Badge tone="offline" dot>
                        {t('onDemand.recording')}
                      </Badge>
                    ) : i.publishedAt ? (
                      <Badge tone="online">{t('onDemand.published')}</Badge>
                    ) : (
                      <Badge>{t('onDemand.draft')}</Badge>
                    )}
                    <Badge tone="accent">{i.source === 'recording' ? t('onDemand.sourceRecording') : t('onDemand.sourceUpload')}</Badge>
                  </div>
                  <div className="mt-0.5 text-xs text-muted">
                    {[i.host, formatDate(i.recordedAt ?? i.createdAt), length(i.durationSeconds), formatBytes(i.sizeBytes), t('onDemand.plays', { count: i.plays })].filter(Boolean).join(' · ')}
                  </div>
                </div>
                {!i.recording && canEdit && (
                  <div className="flex items-center gap-1">
                    <Button size="sm" variant={i.publishedAt ? 'secondary' : 'primary'} loading={publish.isPending && publish.variables?.id === i.id} onClick={() => publish.mutate({ id: i.id, published: !i.publishedAt })}>
                      {i.publishedAt ? t('onDemand.unpublish') : t('onDemand.publish')}
                    </Button>
                    <Button size="sm" variant="ghost" title={t('common.edit')} onClick={() => setEditing(i)}>
                      <Pencil className="size-4" />
                    </Button>
                    {!!i.durationSeconds && (
                      <Button size="sm" variant="ghost" title={t('onDemand.trim')} onClick={() => setTrimming(i)}>
                        <Scissors className="size-4" />
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" title={t('common.delete')} onClick={() => confirm(t('onDemand.deleteConfirm', { title: i.title })) && remove.mutate(i.id)}>
                      <Trash2 className="size-4 text-offline" />
                    </Button>
                  </div>
                )}
                {i.recording && <CircleDot className="size-4 animate-pulse text-offline" />}
              </li>
            ))}
          </ul>
        )}
        <p className="flex gap-2 border-t border-line px-5 py-3 text-xs text-muted">
          <FolderUp className="size-4 shrink-0" />
          {t('onDemand.uploadHint', { slug: station.slug })}
        </p>
      </Card>
      {canEdit && <OnDemandSettings station={station} />}
      {editing && <EditDialog station={station} item={editing} onClose={() => setEditing(null)} />}
      {trimming && <TrimDialog station={station} item={trimming} onClose={() => setTrimming(null)} />}
    </div>
  );
}
