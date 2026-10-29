import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Clock, Download, Music2, Newspaper, Save, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { api, type MediaFile, type StationDetail } from '../../lib/api';
import { formatDate, formatRelative, formatSeconds } from '../../lib/format';
import { Badge, Button, Card, CardHeader, Field, Input, Segmented, Select, Spinner, Switch, Textarea } from '../ui';
import { TrackPicker } from './Clocks';

type Source = 'url' | 'ftp' | 'ftps' | 'sftp';

export interface NewsSettings {
  enabled: boolean;
  name: string;
  source: Source;
  url: string;
  host: string;
  port: number;
  username: string;
  password: string;
  privateKey: string;
  hostKey: string;
  tlsMode: 'explicit' | 'implicit';
  skipCertCheck: boolean;
  path: string;
  leadMinutes: number;
  maxAgeMinutes: number;
  fallbackMediaId: string | null;
}
export interface NewsView {
  settings: NewsSettings;
  status: {
    mediaId: string | null;
    durationSeconds: number | null;
    fetchedAt: string | null;
    sourceAt: string | null;
    slot: string | null;
    lastAttemptAt: string | null;
    error: string | null;
  };
  slots: { at: string; fresh: boolean }[];
  fallback: { id: string; title: string; artist: string; durationSeconds: number | null } | null;
}

const num = (v: string, min: number, max: number) => Math.max(min, Math.min(max, Math.round(Number(v) || min)));
const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/**
 * The news bulletin of a Radio station: where the server fetches it (an address, FTP, FTPS or SFTP), when, how old it
 * may be and the spare jingle. Where the news plays comes from the News items in the hour clocks.
 */
export function NewsTab({ station, canEdit }: { station: StationDetail; canEdit: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const key = ['news', station.id];
  const view = useQuery({ queryKey: key, queryFn: () => api<NewsView>(`/stations/${station.id}/news`), refetchInterval: 30_000 });
  const [draft, setDraft] = useState<NewsSettings | null>(null);
  const [picking, setPicking] = useState(false);
  const [fallbackName, setFallbackName] = useState<string | null>(null);
  useEffect(() => {
    if (view.data && !draft) setDraft(view.data.settings);
  }, [view.data, draft]);
  const save = useMutation({
    mutationFn: (body: NewsSettings) => api<NewsView>(`/stations/${station.id}/news`, { method: 'PUT', body }),
    onSuccess: (v) => {
      qc.setQueryData(key, v);
      setDraft(v.settings);
      toast.success(t('common.saved'));
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const fetchNow = useMutation({
    mutationFn: () => api<NewsView>(`/stations/${station.id}/news/fetch`, { method: 'POST', body: {} }),
    onSuccess: (v) => {
      qc.setQueryData(key, v);
      if (v.status.error) toast.error(t('news.fetchFailed', { error: v.status.error }));
      else toast.success(t('news.fetched'));
    },
    onError: (err) => toast.error((err as Error).message),
  });
  if (!view.data || !draft) {
    return (
      <div className="grid place-items-center py-16">
        <Spinner />
      </div>
    );
  }
  const { status, slots } = view.data;
  const set = (patch: Partial<NewsSettings>) => setDraft({ ...draft, ...patch });
  const remote = draft.source !== 'url';
  const fallback = draft.fallbackMediaId ? (fallbackName ?? (view.data.fallback?.id === draft.fallbackMediaId ? view.data.fallback.title : '…')) : null;
  const dirty = JSON.stringify(draft) !== JSON.stringify(view.data.settings);

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
      <Card>
        <CardHeader
          title={t('news.title')}
          description={t('news.description')}
          actions={
            canEdit && (
              <Button variant="dark" size="sm" loading={save.isPending} disabled={!dirty} onClick={() => save.mutate(draft)}>
                <Save className="size-4" /> {t('common.save')}
              </Button>
            )
          }
        />
        <fieldset disabled={!canEdit} className="flex flex-col gap-5 px-5 pb-5">
          <Switch checked={draft.enabled} onChange={(enabled) => set({ enabled })} label={t('news.enabled')} description={t('news.enabledHint')} />
          <Field label={t('news.name')} hint={t('news.nameHint')}>
            <Input maxLength={40} value={draft.name} onChange={(e) => set({ name: e.target.value })} />
          </Field>
          <Field label={t('news.source')}>
            <Segmented<Source>
              cols={2}
              value={draft.source}
              onChange={(source) => set({ source, port: 0 })}
              options={[
                { value: 'url', label: t('news.sources.url'), description: t('news.sources.urlHint') },
                { value: 'ftp', label: 'FTP', description: t('news.sources.ftpHint') },
                { value: 'ftps', label: 'FTPS', description: t('news.sources.ftpsHint') },
                { value: 'sftp', label: 'SFTP', description: t('news.sources.sftpHint') },
              ]}
            />
          </Field>
          {!remote ? (
            <Field label={t('news.url')} hint={t('news.tokensHint')}>
              <Input className="font-mono text-[13px]" placeholder="https://news.example.com/latest.mp3" value={draft.url} onChange={(e) => set({ url: e.target.value })} />
            </Field>
          ) : (
            <>
              <div className="grid gap-4 sm:grid-cols-[1fr_120px]">
                <Field label={t('news.host')}>
                  <Input value={draft.host} placeholder="ftp.example.com" onChange={(e) => set({ host: e.target.value })} />
                </Field>
                <Field label={t('news.port')} hint={t('news.portHint')}>
                  <Input type="number" min={0} max={65535} value={draft.port || ''} placeholder={draft.source === 'sftp' ? '22' : draft.source === 'ftps' && draft.tlsMode === 'implicit' ? '990' : '21'} onChange={(e) => set({ port: e.target.value ? num(e.target.value, 0, 65535) : 0 })} />
                </Field>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={t('news.username')}>
                  <Input autoComplete="off" value={draft.username} onChange={(e) => set({ username: e.target.value })} />
                </Field>
                <Field label={t('news.password')}>
                  <Input type="password" autoComplete="new-password" value={draft.password} onChange={(e) => set({ password: e.target.value })} />
                </Field>
              </div>
              <Field label={t('news.path')} hint={t('news.tokensHint')}>
                <Input className="font-mono text-[13px]" placeholder="news/{YYYY}{MM}{DD}-{HH}00.mp3" value={draft.path} onChange={(e) => set({ path: e.target.value })} />
              </Field>
              {draft.source === 'ftps' && (
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label={t('news.tlsMode')}>
                    <Select value={draft.tlsMode} onChange={(e) => set({ tlsMode: e.target.value as NewsSettings['tlsMode'] })}>
                      <option value="explicit">{t('news.tlsExplicit')}</option>
                      <option value="implicit">{t('news.tlsImplicit')}</option>
                    </Select>
                  </Field>
                  <div className="pt-7">
                    <Switch checked={draft.skipCertCheck} onChange={(skipCertCheck) => set({ skipCertCheck })} label={t('news.skipCertCheck')} />
                  </div>
                </div>
              )}
              {draft.source === 'sftp' && (
                <>
                  <Field label={t('news.privateKey')} hint={t('news.privateKeyHint')}>
                    <Textarea rows={3} className="font-mono text-xs" value={draft.privateKey} onChange={(e) => set({ privateKey: e.target.value })} />
                  </Field>
                  <Field label={t('news.hostKey')} hint={t('news.hostKeyHint')}>
                    <Input className="font-mono text-xs" value={draft.hostKey} onChange={(e) => set({ hostKey: e.target.value })} />
                  </Field>
                </>
              )}
            </>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('news.lead')} hint={t('news.leadHint')}>
              <Input type="number" min={1} max={30} value={draft.leadMinutes} onChange={(e) => set({ leadMinutes: num(e.target.value, 1, 30) })} />
            </Field>
            <Field label={t('news.maxAge')} hint={t('news.maxAgeHint')}>
              <Input type="number" min={5} max={1440} value={draft.maxAgeMinutes} onChange={(e) => set({ maxAgeMinutes: num(e.target.value, 5, 1440) })} />
            </Field>
          </div>
          <Field label={t('news.fallback')} hint={t('news.fallbackHint')}>
            <div className="flex gap-2">
              <Button className="min-w-0 flex-1 justify-start" onClick={() => setPicking(true)}>
                <Music2 className="size-4" />
                <span className="truncate">{fallback ?? t('news.chooseFallback')}</span>
              </Button>
              {draft.fallbackMediaId && (
                <Button variant="ghost" title={t('common.remove')} onClick={() => set({ fallbackMediaId: null })}>
                  <X className="size-4" />
                </Button>
              )}
            </div>
          </Field>
        </fieldset>
      </Card>
      <div className="flex flex-col gap-5">
        <Card>
          <CardHeader
            title={t('news.bulletin')}
            actions={
              canEdit && (
                <Button size="sm" loading={fetchNow.isPending} disabled={dirty} title={dirty ? t('news.saveFirst') : undefined} onClick={() => fetchNow.mutate()}>
                  <Download className="size-4" /> {t('news.fetchNow')}
                </Button>
              )
            }
          />
          <div className="flex flex-col gap-3 px-5 pb-5 text-sm">
            {status.mediaId ? (
              <div className="flex items-start gap-3">
                <Newspaper className="mt-0.5 size-5 shrink-0 text-accent-text" />
                <div className="min-w-0">
                  <div className="font-semibold">
                    {status.slot ? t('news.forSlot', { time: time(status.slot) }) : t('news.onDisk')} · {formatSeconds(status.durationSeconds)}
                  </div>
                  <div className="text-xs text-muted">
                    {t('news.fetchedAt', { when: formatRelative(status.fetchedAt) })}
                    {status.sourceAt && ` · ${t('news.sourceAt', { when: formatDate(status.sourceAt) })}`}
                  </div>
                </div>
              </div>
            ) : (
              <p className="text-muted">{t('news.noBulletin')}</p>
            )}
            {status.error && (
              <div className="flex items-start gap-2 rounded-md bg-offline/10 p-3 text-[13px] text-offline">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                <span>
                  {t('news.lastError', { when: formatRelative(status.lastAttemptAt) })}: {status.error}
                </span>
              </div>
            )}
          </div>
        </Card>
        <Card>
          <CardHeader title={t('news.coming')} description={t('news.comingHint')} />
          <div className="flex flex-col px-5 pb-5">
            {!slots.length ? (
              <p className="text-sm text-muted">{t('news.noSlots')}</p>
            ) : (
              slots.map((s) => (
                <div key={s.at} className="flex items-center gap-3 border-b border-line py-2 text-sm last:border-b-0">
                  <Clock className="size-4 text-muted" />
                  <span className="w-14 font-semibold tabular-nums">{time(s.at)}</span>
                  {s.fresh ? (
                    <Badge tone="online">
                      <CheckCircle2 className="size-3" /> {t('news.ready')}
                    </Badge>
                  ) : view.data.fallback ? (
                    <Badge tone="warning">{t('news.spare')}</Badge>
                  ) : (
                    <Badge>{t('news.waiting')}</Badge>
                  )}
                </div>
              ))
            )}
          </div>
        </Card>
      </div>
      <TrackPicker
        station={station}
        open={picking}
        onClose={() => setPicking(false)}
        onPick={(m: MediaFile) => {
          set({ fallbackMediaId: m.id });
          setFallbackName(m.title);
          setPicking(false);
        }}
      />
    </div>
  );
}
