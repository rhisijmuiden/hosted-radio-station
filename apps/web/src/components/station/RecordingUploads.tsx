import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { CheckCircle2, CloudUpload, Pencil, PlugZap, RotateCw, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { api, ApiError, type RecordingDestination, type RecordingDestinationType, type StationDetail } from '../../lib/api';
import { formatRelative } from '../../lib/format';
import { ConfigFields, typeIcon } from '../../pages/Backups';
import { Badge, Button, Card, CardHeader, Dialog, EmptyState, Field, Input, Spinner, Switch } from '../ui';

const TYPES: RecordingDestinationType[] = ['sftp', 'ftps', 'ftp', 'onedrive'];
type Kind = 'log' | 'show';

function defaultConfig(type: RecordingDestinationType): Record<string, unknown> {
  switch (type) {
    case 'ftp':
      return { host: '', port: 21, username: '', password: '', path: 'recordings' };
    case 'ftps':
      return { host: '', port: 21, username: '', password: '', path: 'recordings', tlsMode: 'explicit', skipCertCheck: false };
    case 'sftp':
      return { host: '', port: 22, username: '', password: '', privateKey: '', keyPassphrase: '', hostKey: '', path: 'recordings' };
    case 'onedrive':
      return { path: 'Radio recordings', token: '', tokenSource: 'device', clientId: '', driveId: '', driveType: '', account: '' };
  }
}

function DestinationDialog({ station, dest, open, onClose, hasApp }: { station: StationDetail; dest: RecordingDestination | null; open: boolean; onClose: () => void; hasApp: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [type, setType] = useState<RecordingDestinationType>('sftp');
  const [config, setConfig] = useState<Record<string, unknown>>(defaultConfig('sftp'));
  const [kinds, setKinds] = useState<Kind[]>(['log', 'show']);
  const [enabled, setEnabled] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tested, setTested] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setTested(null);
    setName(dest?.name ?? '');
    setType(dest?.type ?? 'sftp');
    setConfig(dest?.config ?? defaultConfig('sftp'));
    setKinds(dest?.kinds ?? ['log', 'show']);
    setEnabled(dest?.enabled ?? true);
  }, [open, dest]);

  const base = `/stations/${station.id}/recording`;
  const save = useMutation({
    mutationFn: () => api(dest ? `${base}/destinations/${dest.id}` : `${base}/destinations`, { method: dest ? 'PUT' : 'POST', body: { name, type, config, kinds, enabled } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['recording-destinations', station.id] });
      toast.success(t('common.saved'));
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : String(err)),
  });
  const test = useMutation({
    mutationFn: () => api<{ message: string }>(`${base}/destinations/test`, { method: 'POST', body: { did: dest?.id, type, config } }),
    onSuccess: (res) => {
      setError(null);
      setTested(res.message);
    },
    onError: (err) => {
      setTested(null);
      setError((err as Error).message);
    },
  });
  const onConfig = (c: Record<string, unknown>) => {
    setConfig(c);
    setTested(null);
  };
  const toggle = (k: Kind, on: boolean) => setKinds(on ? [...new Set([...kinds, k])] : kinds.filter((x) => x !== k));

  return (
    <Dialog
      open={open}
      onClose={onClose}
      wide
      title={dest ? t('recordings.editDestination') : t('recordings.newDestination')}
      description={t('recordings.destinationHint')}
      footer={
        <>
          <Button className="sm:mr-auto" onClick={() => test.mutate()} loading={test.isPending}>
            <PlugZap className="size-4" /> {t('recordings.test')}
          </Button>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" type="submit" form="destination-form" loading={save.isPending} disabled={!kinds.length}>
            {dest ? t('common.save') : t('recordings.addDestination')}
          </Button>
        </>
      }
    >
      <form
        id="destination-form"
        className="flex flex-col gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Field label={t('recordings.destinationName')}>
          <Input required autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={t('recordings.destinationNamePlaceholder')} />
        </Field>
        {!dest && (
          <Field label={t('backups.type')} hint={t(`backups.typeHints.${type}`)}>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {TYPES.map((x) => {
                const Icon = typeIcon[x];
                return (
                  <button
                    key={x}
                    type="button"
                    onClick={() => {
                      setType(x);
                      setConfig(defaultConfig(x));
                      setTested(null);
                    }}
                    className={clsx(
                      'flex flex-col items-center gap-1.5 rounded-md border px-2 py-3 text-[13px] font-semibold transition-colors',
                      type === x ? 'border-koraal bg-koraal/8 ring-1 ring-koraal' : 'border-line hover:bg-hover',
                    )}
                  >
                    <Icon className={clsx('size-5', type === x ? 'text-koraal' : 'text-muted')} />
                    {t(`backups.types.${x}`)}
                  </button>
                );
              })}
            </div>
          </Field>
        )}
        <ConfigFields type={type} config={config} onChange={onConfig} onedrive={{ base: `${base}/onedrive`, hasApp, noAppHint: t('recordings.onedriveNoApp') }} />
        <Field label={t('recordings.what')} hint={t('recordings.layoutHint', { slug: station.slug })}>
          <div className="flex flex-col gap-2">
            <Switch checked={kinds.includes('log')} onChange={(on) => toggle('log', on)} label={t('recordings.kindLog')} />
            <Switch checked={kinds.includes('show')} onChange={(on) => toggle('show', on)} label={t('recordings.kindShow')} />
          </div>
        </Field>
        <Switch checked={enabled} onChange={setEnabled} label={t('recordings.destinationEnabled')} description={t('recordings.destinationEnabledHint')} />
        {tested && (
          <div className="flex gap-2.5 rounded-md bg-online/10 px-3 py-2.5 text-[13px]">
            <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-online" />
            <div>
              <div className="font-semibold">{t('recordings.testOk')}</div>
              <div className="text-muted">{tested}</div>
            </div>
          </div>
        )}
        {error && <p className="rounded-md bg-offline/10 px-3 py-2 text-[13px] break-words text-offline">{error}</p>}
      </form>
    </Dialog>
  );
}

/** Upload destinations of the station's recordings (phase 21 step 3), with how the uploads go. */
export function RecordingUploads({ station, canEdit }: { station: StationDetail; canEdit: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<RecordingDestination | null>(null);
  const [open, setOpen] = useState(false);
  const list = useQuery({
    queryKey: ['recording-destinations', station.id],
    queryFn: () => api<{ destinations: RecordingDestination[]; onedriveSignIn: boolean }>(`/stations/${station.id}/recording/destinations`),
    refetchInterval: 30_000,
  });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['recording-destinations', station.id] });
  const del = useMutation({
    mutationFn: (d: RecordingDestination) => api(`/stations/${station.id}/recording/destinations/${d.id}`, { method: 'DELETE' }),
    onSuccess: refresh,
    onError: (err) => toast.error((err as Error).message),
  });
  const retry = useMutation({
    mutationFn: (d: RecordingDestination) => api(`/stations/${station.id}/recording/destinations/${d.id}/retry`, { method: 'POST' }),
    onSuccess: () => {
      toast.success(t('recordings.retrying'));
      setTimeout(refresh, 5000);
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const dests = list.data?.destinations ?? [];
  return (
    <Card>
      <CardHeader
        title={t('recordings.uploads')}
        description={t('recordings.uploadsHint')}
        actions={
          canEdit && (
            <Button
              size="sm"
              variant="dark"
              onClick={() => {
                setEditing(null);
                setOpen(true);
              }}
            >
              <CloudUpload className="size-4" /> {t('recordings.addDestination')}
            </Button>
          )
        }
      />
      {list.isPending ? (
        <div className="grid place-items-center py-8">
          <Spinner />
        </div>
      ) : !dests.length ? (
        <EmptyState icon={<CloudUpload />} title={t('recordings.noDestinations')} description={t('recordings.noDestinationsHint')} />
      ) : (
        <div className="flex flex-col gap-2 px-5 pb-5">
          {dests.map((d) => {
            const Icon = typeIcon[d.type];
            return (
              <div key={d.id} className="flex flex-col gap-2 rounded-md border border-line px-4 py-3">
                <div className="flex flex-wrap items-center gap-2 text-[13px]">
                  <Icon className="size-4 text-muted" />
                  <b>{d.name}</b>
                  <span className="truncate text-muted">{d.description}</span>
                  {d.kinds.map((k) => (
                    <Badge key={k}>{t(k === 'log' ? 'recordings.kindLogShort' : 'recordings.kindShowShort')}</Badge>
                  ))}
                  <span className="ml-auto flex items-center gap-1">
                    {!d.enabled ? (
                      <Badge>{t('recordings.paused')}</Badge>
                    ) : d.failing ? (
                      <Badge tone="warning" dot>
                        {t('recordings.failing', { count: d.failing })}
                      </Badge>
                    ) : (
                      <Badge tone="online" dot>
                        {t('recordings.uploaded', { count: d.uploaded })}
                      </Badge>
                    )}
                    {canEdit && (
                      <>
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={t('common.edit')}
                          onClick={() => {
                            setEditing(d);
                            setOpen(true);
                          }}
                        >
                          <Pencil className="size-4" />
                        </Button>
                        <Button size="sm" variant="ghost" aria-label={t('common.delete')} onClick={() => confirm(t('recordings.deleteDestination', { name: d.name })) && del.mutate(d)}>
                          <Trash2 className="size-4" />
                        </Button>
                      </>
                    )}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                  {d.lastUploadAt ? <span>{t('recordings.lastUpload', { when: formatRelative(d.lastUploadAt) })}</span> : <span>{t('recordings.nothingUploaded')}</span>}
                  {d.failing > 0 && d.nextTryAt && <span>{t('recordings.nextTry', { when: formatRelative(d.nextTryAt) })}</span>}
                </div>
                {d.failing > 0 && d.lastError && (
                  <div className="flex flex-wrap items-center gap-2 rounded-md bg-warning/10 px-3 py-2 text-xs break-words">
                    <span className="min-w-0 flex-1">{d.lastError}</span>
                    {canEdit && (
                      <Button size="sm" variant="ghost" loading={retry.isPending} onClick={() => retry.mutate(d)}>
                        <RotateCw className="size-4" /> {t('recordings.retry')}
                      </Button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      <DestinationDialog station={station} dest={editing} open={open} onClose={() => setOpen(false)} hasApp={!!list.data?.onedriveSignIn} />
    </Card>
  );
}
