import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Inbox, ThumbsUp, Undo2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { api, type PublicPageSettings, type RequestStatus, type SongRequest, type StationDetail } from '../../lib/api';
import { formatRelative } from '../../lib/format';
import { Badge, Button, Card, CardHeader, EmptyState, Field, Input, Spinner, Switch, Tabs } from '../ui';
import { usePublicPage } from './PublicPage';

const tone: Record<RequestStatus, 'warning' | 'accent' | 'online' | 'neutral'> = { pending: 'warning', accepted: 'accent', played: 'online', rejected: 'neutral' };

/** Number of new requests, for the tab label. */
export function usePendingRequests(stationId: string) {
  return useQuery({
    queryKey: ['station-requests', stationId, 'open'],
    queryFn: () => api<{ items: SongRequest[]; pending: number }>(`/stations/${stationId}/requests?status=open`),
    refetchInterval: 10_000,
    enabled: !!stationId,
  });
}

function RequestSettings({ stationId }: { stationId: string }) {
  const { t } = useTranslation();
  const { query, save } = usePublicPage(stationId);
  const [draft, setDraft] = useState<PublicPageSettings['requests'] | null>(null);
  useEffect(() => {
    if (query.data) setDraft(query.data.settings.requests);
  }, [query.data]);
  if (!draft) return null;
  return (
    <Card className="p-5">
      <h2 className="display text-base">{t('requests.settings')}</h2>
      <div className="mt-4 flex flex-col gap-4">
        <Switch checked={draft.enabled} onChange={(enabled) => setDraft({ ...draft, enabled })} label={t('requests.enabled')} description={t('requests.enabledHint')} />
        <Switch checked={draft.onlyWhenLive} onChange={(onlyWhenLive) => setDraft({ ...draft, onlyWhenLive })} label={t('requests.onlyWhenLive')} description={t('requests.onlyWhenLiveHint')} />
        <Field label={t('requests.perHour')} hint={t('requests.perHourHint')}>
          <Input type="number" min={1} max={30} value={draft.perHour} onChange={(e) => setDraft({ ...draft, perHour: Number(e.target.value) })} />
        </Field>
        <Field label={t('requests.message')} hint={t('requests.messageHint')}>
          <Input maxLength={300} value={draft.message} onChange={(e) => setDraft({ ...draft, message: e.target.value })} />
        </Field>
        <div className="flex justify-end">
          <Button variant="dark" loading={save.isPending} onClick={() => save.mutate({ requests: draft })}>
            {t('common.save')}
          </Button>
        </div>
      </div>
    </Card>
  );
}

export function RequestsTab({ station, canEdit }: { station: StationDetail; canEdit: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [view, setView] = useState<'open' | 'handled'>('open');
  const list = useQuery({
    queryKey: ['station-requests', station.id, view],
    queryFn: () => api<{ items: SongRequest[]; pending: number }>(`/stations/${station.id}/requests?status=${view}`),
    refetchInterval: 10_000,
  });
  const update = useMutation({
    mutationFn: ({ id, status }: { id: string; status: RequestStatus }) => api(`/stations/${station.id}/requests/${id}`, { method: 'PATCH', body: { status } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['station-requests', station.id] }),
    onError: (err) => toast.error((err as Error).message),
  });
  const clear = useMutation({
    mutationFn: () => api<{ removed: number }>(`/stations/${station.id}/requests`, { method: 'DELETE' }),
    onSuccess: (r) => {
      toast.success(t('requests.cleared', { count: r.removed }));
      void qc.invalidateQueries({ queryKey: ['station-requests', station.id] });
    },
  });
  const items = list.data?.items ?? [];

  return (
    <div className="grid items-start gap-4 xl:grid-cols-[1.6fr_1fr]">
      <Card>
        <CardHeader
          title={t('requests.title')}
          description={t('requests.subtitle')}
          actions={
            view === 'handled' && items.length > 0 ? (
              <Button size="sm" variant="ghost" loading={clear.isPending} onClick={() => confirm(t('requests.clearConfirm')) && clear.mutate()}>
                {t('requests.clear')}
              </Button>
            ) : undefined
          }
        />
        <div className="px-5 pt-3">
          <Tabs
            value={view}
            onChange={setView}
            tabs={[
              { value: 'open', label: `${t('requests.open')}${list.data && view === 'open' ? ` (${items.length})` : ''}` },
              { value: 'handled', label: t('requests.handled') },
            ]}
          />
        </div>
        {list.isPending ? (
          <div className="grid place-items-center py-10">
            <Spinner />
          </div>
        ) : !items.length ? (
          <EmptyState icon={<Inbox className="size-5" />} title={view === 'open' ? t('requests.empty') : t('requests.emptyHandled')} description={view === 'open' ? t('requests.emptyHint') : undefined} />
        ) : (
          <ul className="flex flex-col pb-2">
            {items.map((r) => (
              <li key={r.id} className="flex flex-wrap items-start gap-3 border-t border-line px-5 py-3.5 first:border-t-0">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">{r.title}</span>
                    <span className="text-muted">{r.artist}</span>
                    <Badge tone={tone[r.status]}>{t(`requests.status.${r.status}`)}</Badge>
                    {r.mediaId && <Badge tone="neutral">{t('requests.fromLibrary')}</Badge>}
                  </div>
                  {r.message && <p className="mt-1 text-[13px]">“{r.message}”</p>}
                  <div className="mt-1 text-xs text-muted">
                    {r.requesterName || t('requests.anonymous')} · {formatRelative(r.createdAt)}
                    {r.handledBy && ` · ${t('requests.handledBy', { name: r.handledBy })}`}
                  </div>
                </div>
                <div className="flex gap-1">
                  {r.status === 'pending' && (
                    <Button size="sm" variant="ghost" title={t('requests.accept')} onClick={() => update.mutate({ id: r.id, status: 'accepted' })}>
                      <ThumbsUp className="size-4" />
                    </Button>
                  )}
                  {(r.status === 'pending' || r.status === 'accepted') && (
                    <>
                      <Button size="sm" variant="secondary" onClick={() => update.mutate({ id: r.id, status: 'played' })}>
                        <Check className="size-4 text-online" /> {t('requests.played')}
                      </Button>
                      <Button size="sm" variant="ghost" title={t('requests.reject')} onClick={() => update.mutate({ id: r.id, status: 'rejected' })}>
                        <X className="size-4 text-offline" />
                      </Button>
                    </>
                  )}
                  {(r.status === 'played' || r.status === 'rejected') && (
                    <Button size="sm" variant="ghost" title={t('requests.reopen')} onClick={() => update.mutate({ id: r.id, status: 'pending' })}>
                      <Undo2 className="size-4" />
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {canEdit && <RequestSettings stationId={station.id} />}
    </div>
  );
}
