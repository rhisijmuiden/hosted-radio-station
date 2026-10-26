import { useMutation, useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { CheckCircle2, Download, Info, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, type StudioRelease, type StudioReleases } from '../lib/api';
import { compareVersions } from '../lib/format';
import { call, onUpdateProgress } from '../lib/native';
import { useSession } from '../lib/session';
import { updateSettings, useSettings } from '../lib/settings';
import { Badge, Button, Dialog, Fact } from './ui';

/** What the chosen channel offers compared to this version: an update, a switch to another build, or nothing. */
function offer(current: string, channel: 'production' | 'test', releases: StudioReleases | undefined): StudioRelease | null {
  const r = releases?.[channel];
  if (!r) return null;
  if (channel === 'production') return compareVersions(r.version, current) !== 0 && (compareVersions(r.version, current) > 0 || current.includes('-test.')) ? r : null;
  return compareVersions(r.version, current) > 0 ? r : null;
}

export function useUpdateCheck() {
  const settings = useSettings();
  const { me } = useSession();
  return useQuery({
    queryKey: ['studio-releases', settings.server],
    queryFn: () => api<StudioReleases>('/studio/releases', { auth: false }),
    enabled: !!settings.server && !!me,
    staleTime: 10 * 60_000,
    refetchInterval: 60 * 60_000,
  });
}

export function InfoDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const { app, me } = useSession();
  const settings = useSettings();
  const releases = useUpdateCheck();
  const current = app?.version ?? '0.0.0';
  const available = offer(current, settings.channel, releases.data);
  const [progress, setProgress] = useState<{ received: number; total: number | null } | null>(null);
  useEffect(() => {
    let un = () => {};
    void onUpdateProgress(setProgress).then((u) => (un = u));
    return () => un();
  }, []);
  const install = useMutation({
    mutationFn: (r: StudioRelease) => call('install_update', { url: r.installerUrl, sha256: r.sha256 ?? '', version: r.version }),
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('info.title')}
      description={t('info.subtitle')}
      footer={<Button onClick={onClose}>{t('common.close')}</Button>}
    >
      <div className="mb-5 flex items-center gap-4">
        <img src="/brand/rhis-icon.svg" alt="" className="size-12" />
        <div>
          <div className="display text-lg">RHIS Studio</div>
          <div className="text-[13px] text-muted">
            {t('info.version')} <b className="text-ink">v{current}</b> {current.includes('-test.') && <Badge tone="warning">{t('channel.test')}</Badge>}
          </div>
        </div>
      </div>
      <div className="mb-5 grid grid-cols-2 gap-4">
        <Fact label={t('info.computer')}>{app?.hostname ?? '–'}</Fact>
        <Fact label={t('info.server')}>{settings.server.replace(/^https?:\/\//, '') || '–'}</Fact>
        <Fact label={t('info.signedInAs')}>{me ? me.user.name : '–'}</Fact>
        <Fact label={t('info.asio')}>{app?.asio ? t('info.asioYes') : t('info.asioNo')}</Fact>
      </div>

      <div className="mb-2 text-[13px] font-semibold">{t('info.channel')}</div>
      <div className="mb-4 grid grid-cols-2 gap-2">
        {(['production', 'test'] as const).map((c) => (
          <button
            key={c}
            onClick={() => updateSettings({ channel: c })}
            className={clsx('rounded-md border p-3 text-left transition-colors', settings.channel === c ? 'border-koraal bg-koraal/8 ring-1 ring-koraal' : 'border-line hover:bg-hover')}
          >
            <div className="text-sm font-semibold">{t(`channel.${c}`)}</div>
            <div className="mt-0.5 text-xs text-muted">{releases.data?.[c] ? `v${releases.data[c]!.version}` : t('info.noBuild')}</div>
          </button>
        ))}
      </div>

      <div className="rounded-md border border-line p-4">
        {releases.isFetching ? (
          <p className="text-[13px] text-muted">{t('info.checking')}</p>
        ) : releases.data?.error ? (
          <p className="text-[13px] text-warning">{t('info.checkFailed', { error: releases.data.error })}</p>
        ) : !releases.data?.[settings.channel] ? (
          <p className="text-[13px] text-muted">{t('info.noBuildText')}</p>
        ) : available ? (
          <>
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="text-sm font-semibold">{t(compareVersions(available.version, current) > 0 ? 'info.updateAvailable' : 'info.switchAvailable', { version: available.version })}</div>
              <Badge tone="accent">v{available.version}</Badge>
            </div>
            {available.notes && <p className="mb-3 line-clamp-4 text-xs whitespace-pre-line text-muted">{available.notes}</p>}
            {progress && install.isPending && (
              <div className="mb-3 h-2 overflow-hidden rounded-full bg-meter">
                <div className="h-full bg-koraal transition-all" style={{ width: `${progress.total ? (progress.received / progress.total) * 100 : 30}%` }} />
              </div>
            )}
            {install.isError && <p className="mb-3 text-xs text-offline">{(install.error as Error).message ?? String(install.error)}</p>}
            <Button variant="primary" loading={install.isPending} disabled={!available.installerUrl} onClick={() => install.mutate(available)}>
              <Download className="size-4" /> {install.isPending ? t('info.installing') : t('info.install')}
            </Button>
          </>
        ) : (
          <p className="flex items-center gap-2 text-[13px]">
            <CheckCircle2 className="size-4 text-online" /> {t('info.upToDate')}
          </p>
        )}
        <div className="mt-3 flex justify-end">
          <Button size="sm" variant="ghost" onClick={() => void releases.refetch()} loading={releases.isFetching}>
            <RefreshCw className="size-3.5" /> {t('info.check')}
          </Button>
        </div>
      </div>
      <p className="mt-4 text-center text-[11px] text-muted">© RHIS · Powered by RHIS</p>
    </Dialog>
  );
}

export function InfoButton() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const { app } = useSession();
  const settings = useSettings();
  const releases = useUpdateCheck();
  const hasUpdate = !!app && !!offer(app.version, settings.channel, releases.data);
  return (
    <>
      <button onClick={() => setOpen(true)} className="relative flex items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-[11px] font-semibold text-muted hover:bg-hover hover:text-ink">
        <Info className="size-3.5" /> {t('info.button')} {app && <span className="font-normal">v{app.version}</span>}
        {hasUpdate && <span className="absolute -top-0.5 -right-0.5 size-2.5 rounded-full bg-koraal ring-2 ring-raised" title={t('info.updateBadge')} />}
      </button>
      <InfoDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}
