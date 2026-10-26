import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Download, Laptop, MonitorSmartphone, Trash2, XCircle } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { Badge, Button, Card, CardHeader, EmptyState, Fact, Field, Input, PageHeader, Spinner, Table } from '../components/ui';
import { api, ApiError, type StudioDevice, type StudioLink, type StudioRelease, type StudioReleases } from '../lib/api';
import { formatDate } from '../lib/format';

const megabytes = (n: number | null) => (n ? `${(n / 1024 / 1024).toFixed(1)} MB` : '');

function ReleaseCard({ channel, release }: { channel: 'production' | 'test'; release: StudioRelease | null }) {
  const { t } = useTranslation();
  return (
    <Card className="flex flex-col p-5">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="display text-base">{t(`studio.channel.${channel}`)}</h3>
        <Badge tone={channel === 'production' ? 'online' : 'warning'}>{release ? `v${release.version}` : t('studio.noRelease')}</Badge>
      </div>
      <p className="mb-4 text-[13px] text-muted">{t(`studio.channelHint.${channel}`)}</p>
      <div className="flex-1" />
      {release?.installerUrl ? (
        <div className="flex flex-wrap items-center gap-3">
          <a href={release.installerUrl}>
            <Button variant={channel === 'production' ? 'primary' : 'secondary'}>
              <Download className="size-4" /> {t('studio.download')}
            </Button>
          </a>
          <span className="text-xs text-muted">
            {formatDate(release.publishedAt, false)} · {megabytes(release.size)}
          </span>
        </div>
      ) : (
        <p className="text-[13px] text-muted">{t('studio.noReleaseText')}</p>
      )}
    </Card>
  );
}

/** Download page for the Windows studio client and the list of linked studio PCs. */
export function StudioPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [code, setCode] = useState('');
  const releases = useQuery({ queryKey: ['studio-releases'], queryFn: () => api<StudioReleases>('/studio/releases'), staleTime: 300_000 });
  const devices = useQuery({ queryKey: ['studio-devices'], queryFn: () => api<StudioDevice[]>('/studio/devices') });
  const unlink = useMutation({
    mutationFn: (id: string) => api(`/studio/devices/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['studio-devices'] });
      toast.success(t('studio.unlinked'));
    },
    onError: (err) => toast.error((err as Error).message),
  });

  return (
    <>
      <PageHeader title={t('nav.studio')} description={t('studio.subtitle')} />
      <div className="grid gap-4 md:grid-cols-2">
        {releases.isPending ? (
          <Card className="grid place-items-center py-12 md:col-span-2">
            <Spinner />
          </Card>
        ) : (
          <>
            <ReleaseCard channel="production" release={releases.data?.production ?? null} />
            <ReleaseCard channel="test" release={releases.data?.test ?? null} />
          </>
        )}
      </div>
      {releases.data?.error && <p className="mt-2 text-xs text-warning">{t('studio.releaseError', { error: releases.data.error })}</p>}

      <Card className="mt-4">
        <CardHeader title={t('studio.features')} />
        <ul className="grid gap-3 px-5 py-4 text-[13px] sm:grid-cols-2">
          {(['assist', 'live', 'carts', 'update'] as const).map((k) => (
            <li key={k} className="flex gap-2">
              <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-online" />
              <span>
                <b>{t(`studio.feature.${k}`)}</b> <span className="text-muted">{t(`studio.feature.${k}Text`)}</span>
              </span>
            </li>
          ))}
        </ul>
      </Card>

      <Card className="mt-4">
        <CardHeader
          title={t('studio.devices')}
          description={t('studio.devicesText')}
          actions={
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (code.trim()) navigate(`/link?code=${encodeURIComponent(code.trim())}`);
              }}
            >
              <Input className="h-8 w-36 font-mono uppercase" placeholder="ABCD-EFGH" value={code} onChange={(e) => setCode(e.target.value)} aria-label={t('studio.code')} />
              <Button size="sm" type="submit">
                {t('studio.enterCode')}
              </Button>
            </form>
          }
        />
        {devices.isPending ? (
          <div className="grid place-items-center py-10">
            <Spinner />
          </div>
        ) : !devices.data?.length ? (
          <EmptyState icon={<Laptop className="size-6" />} title={t('studio.noDevices')} description={t('studio.noDevicesText')} />
        ) : (
          <Table head={[t('studio.device'), t('studio.version'), t('studio.linkedAt'), t('apiKeys.lastUsed'), '']}>
            {devices.data.map((d) => (
              <tr key={d.id}>
                <td className="font-semibold">{d.deviceName}</td>
                <td className="text-muted">{d.clientVersion ? `v${d.clientVersion}` : '–'}</td>
                <td className="whitespace-nowrap text-muted">{formatDate(d.createdAt)}</td>
                <td className="whitespace-nowrap text-muted">{d.lastUsedAt ? formatDate(d.lastUsedAt) : t('apiKeys.neverUsed')}</td>
                <td className="text-right">
                  <Button size="sm" variant="ghost" title={t('studio.unlink')} onClick={() => confirm(t('studio.unlinkConfirm', { name: d.deviceName })) && unlink.mutate(d.id)}>
                    <Trash2 className="size-4 text-offline" />
                  </Button>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}

/** Opened by the studio client: the user checks the code and links the PC to their account. */
export function StudioLinkPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const code = (params.get('code') ?? '').toUpperCase();
  const link = useQuery({ queryKey: ['studio-link', code], queryFn: () => api<StudioLink>(`/studio/link/${encodeURIComponent(code)}`), enabled: !!code, retry: false });
  const decide = useMutation({
    mutationFn: (decision: 'approve' | 'deny') => api<StudioLink>(`/studio/link/${encodeURIComponent(code)}/${decision}`, { method: 'POST' }),
    onSuccess: (row) => {
      qc.setQueryData(['studio-link', code], row);
      void qc.invalidateQueries({ queryKey: ['studio-devices'] });
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const l = link.data;

  return (
    <>
      <PageHeader title={t('studio.linkTitle')} description={t('studio.linkSubtitle')} />
      <Card className="mx-auto max-w-xl p-6">
        {!code ? (
          <Field label={t('studio.code')}>
            <p className="text-[13px] text-muted">{t('studio.noCode')}</p>
          </Field>
        ) : link.isPending ? (
          <div className="grid place-items-center py-10">
            <Spinner />
          </div>
        ) : link.isError || !l ? (
          <EmptyState
            icon={<XCircle className="size-6" />}
            title={t('studio.linkNotFound')}
            description={link.error instanceof ApiError && link.error.status === 404 ? t('studio.linkNotFoundText') : (link.error as Error)?.message}
          />
        ) : (
          <>
            <div className="mb-5 flex items-center gap-4">
              <div className="grid size-12 place-items-center rounded-full bg-chip text-accent-text">
                <MonitorSmartphone className="size-6" />
              </div>
              <div className="min-w-0">
                <div className="display truncate text-lg">{l.deviceName}</div>
                <div className="font-mono text-xl tracking-[0.2em] text-accent-text">{l.code}</div>
              </div>
            </div>
            <div className="mb-5 grid grid-cols-2 gap-4">
              <Fact label={t('studio.version')}>{l.clientVersion ? `v${l.clientVersion}` : '–'}</Fact>
              <Fact label={t('studio.ip')}>{l.ip ?? '–'}</Fact>
              <Fact label={t('studio.requested')}>{formatDate(l.createdAt)}</Fact>
              <Fact label={t('studio.state')}>
                <Badge tone={l.state === 'pending' ? 'warning' : l.state === 'approved' || l.state === 'used' ? 'online' : 'offline'}>{t(`studio.states.${l.state}`)}</Badge>
              </Fact>
            </div>
            {l.state === 'pending' ? (
              <>
                <p className="mb-4 text-[13px] text-muted">{t('studio.linkCheck')}</p>
                <div className="flex flex-wrap justify-end gap-2">
                  <Button variant="danger" loading={decide.isPending && decide.variables === 'deny'} onClick={() => decide.mutate('deny')}>
                    {t('studio.deny')}
                  </Button>
                  <Button variant="primary" loading={decide.isPending && decide.variables === 'approve'} onClick={() => decide.mutate('approve')}>
                    {t('studio.approve')}
                  </Button>
                </div>
              </>
            ) : (
              <p className="rounded-md bg-chip px-3 py-2 text-[13px]">{t(`studio.after.${l.state}`)}</p>
            )}
          </>
        )}
      </Card>
    </>
  );
}
