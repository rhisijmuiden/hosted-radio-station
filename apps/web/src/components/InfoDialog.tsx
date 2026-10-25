import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { CheckCircle2, CircleAlert, Download, FlaskConical, RefreshCw, ShieldCheck } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { api, ApiError, type Channel, type JobStatus, type SystemInfo, type UpdateCheck } from '../lib/api';
import { isAdmin, useMe } from '../lib/auth';
import { formatDate, shortCommit } from '../lib/format';
import { Badge, Button, Dialog, Segmented } from './ui';

export function useSystemInfo() {
  return useQuery({ queryKey: ['system-info'], queryFn: () => api<SystemInfo>('/system/info'), staleTime: 5 * 60_000 });
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-line py-2.5 last:border-b-0">
      <span className="text-muted">{label}</span>
      <span className="text-right font-medium">{children}</span>
    </div>
  );
}

/** Version details, update check, one-click update and the production/test switch. Used in the Info dialog and on the Updates page. */
export function UpdatePanel() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const admin = isAdmin(useMe().data);
  const info = useSystemInfo();
  const [channel, setChannel] = useState<Channel | null>(null);
  const [check, setCheck] = useState<UpdateCheck | null>(null);
  const [watching, setWatching] = useState(false);
  const logRef = useRef<HTMLPreElement>(null);

  const selected = channel ?? info.data?.channel ?? 'main';
  const lastCheck = check ?? (info.data?.lastCheck?.channel === selected ? info.data.lastCheck : null);

  const checkMutation = useMutation({
    mutationFn: (ch: Channel) => api<UpdateCheck>('/system/update/check', { method: 'POST', body: { channel: ch } }),
    onSuccess: (res) => {
      setCheck(res);
      qc.setQueryData<SystemInfo>(['system-info'], (old) => (old ? { ...old, lastCheck: res } : old));
    },
    onError: (err) => toast.error((err as Error).message),
  });

  // Check automatically once the dialog opens (and when the channel changes).
  useEffect(() => {
    if (admin && info.data) checkMutation.mutate(selected);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [admin, selected, !!info.data]);

  const status = useQuery({
    queryKey: ['update-status'],
    queryFn: () => api<JobStatus>('/system/update/status'),
    enabled: admin,
    refetchInterval: watching ? 2000 : false,
    retry: true,
  });

  const updateMutation = useMutation({
    mutationFn: () => api<{ id: string }>('/system/update', { method: 'POST', body: { channel: selected } }),
    onSuccess: () => {
      setWatching(true);
      void qc.invalidateQueries({ queryKey: ['update-status'] });
    },
    onError: (err) => toast.error(err instanceof ApiError && err.code === 'helpers_missing' ? t('info.helpersMissing') : (err as Error).message),
  });

  const job = status.data;
  const busy = job?.state === 'queued' || job?.state === 'running';
  useEffect(() => {
    if (busy) setWatching(true);
    if (watching && job && (job.state === 'succeeded' || job.state === 'failed')) {
      setWatching(false);
      if (job.state === 'succeeded') {
        toast.success(t('info.updated'));
        setTimeout(() => window.location.reload(), 1500);
      }
    }
  }, [busy, job, watching, t]);
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [job?.log]);

  if (!info.data) return null;
  const d = info.data;
  const switching = d.branch !== selected && d.branch !== null;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-4">
        <img src="/brand/rhis-icon.svg" alt="" className="size-14 rounded-lg" />
        <div>
          <div className="display text-lg">{d.name}</div>
          <div className="text-muted">
            {t('info.version')} {d.version}
            {d.branch && (
              <>
                {' · '}
                <Badge tone={d.branch === 'test' ? 'warning' : d.branch === 'main' ? 'online' : 'neutral'}>
                  {d.branch === 'test' ? t('info.channelTest') : d.branch === 'main' ? t('info.channelMain') : d.branch}
                </Badge>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="rounded-md border border-line px-4">
        <Row label={t('info.commit')}>
          <code className="text-xs">{shortCommit(d.commit)}</code>
        </Row>
        <Row label={t('info.released')}>{formatDate(d.commitDate)}</Row>
        <Row label="Node.js">{d.node}</Row>
      </div>

      {admin && (
        <>
          <div>
            <div className="mb-2 text-[13px] font-semibold">{t('info.channel')}</div>
            <Segmented
              value={selected}
              onChange={(v) => {
                setChannel(v);
                setCheck(null);
              }}
              options={[
                { value: 'main', label: <span className="inline-flex items-center gap-1.5"><ShieldCheck className="size-4 text-online" />{t('info.channelMain')}</span>, description: t('info.channelMainHint') },
                { value: 'test', label: <span className="inline-flex items-center gap-1.5"><FlaskConical className="size-4 text-warning" />{t('info.channelTest')}</span>, description: t('info.channelTestHint') },
              ]}
            />
          </div>

          <div
            className={clsx(
              'flex items-start gap-3 rounded-md border p-3',
              lastCheck?.error ? 'border-offline/40 bg-offline/8' : lastCheck?.updateAvailable ? 'border-warning/40 bg-warning/8' : 'border-line',
            )}
          >
            {lastCheck?.error ? (
              <CircleAlert className="mt-0.5 size-5 shrink-0 text-offline" />
            ) : lastCheck?.updateAvailable ? (
              <Download className="mt-0.5 size-5 shrink-0 text-warning" />
            ) : (
              <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-online" />
            )}
            <div className="min-w-0 flex-1 text-[13px]">
              {checkMutation.isPending && !lastCheck ? (
                t('info.checking')
              ) : lastCheck?.error ? (
                <>
                  <div className="font-semibold">{t('info.checkFailed')}</div>
                  <div className="break-words text-muted">{lastCheck.error}</div>
                </>
              ) : lastCheck?.updateAvailable ? (
                <>
                  <div className="font-semibold">{switching ? t('info.switchAvailable', { channel: selected === 'test' ? t('info.channelTest') : t('info.channelMain') }) : t('info.updateAvailable')}</div>
                  <div className="text-muted">
                    {shortCommit(lastCheck.currentCommit)} → {shortCommit(lastCheck.latestCommit)}
                  </div>
                </>
              ) : lastCheck ? (
                <>
                  <div className="font-semibold">{t('info.upToDate')}</div>
                  <div className="text-muted">{t('info.checkedAt', { time: formatDate(lastCheck.checkedAt) })}</div>
                </>
              ) : (
                t('info.notChecked')
              )}
            </div>
            <Button size="sm" variant="ghost" onClick={() => checkMutation.mutate(selected)} loading={checkMutation.isPending} title={t('info.check')}>
              {!checkMutation.isPending && <RefreshCw className="size-4" />}
              <span className="hidden sm:inline">{t('info.check')}</span>
            </Button>
          </div>

          {!d.helpers && <p className="text-xs text-muted">{t('info.helpersMissing')}</p>}

          {(busy || (job && job.state !== 'idle' && job.log)) && (
            <div>
              <div className="mb-2 flex items-center justify-between text-[13px]">
                <span className="font-semibold">{t('info.progress')}</span>
                <Badge tone={job?.state === 'failed' ? 'offline' : job?.state === 'succeeded' ? 'online' : 'warning'} dot>
                  {t(`info.state.${job?.state ?? 'idle'}`)}
                </Badge>
              </div>
              {job?.message && <p className="mb-2 text-[13px] text-muted">{job.message}</p>}
              <pre ref={logRef} className="max-h-48 overflow-auto rounded-md bg-nacht p-3 font-mono text-[11px] leading-relaxed text-white/85">
                {job?.log || '…'}
              </pre>
            </div>
          )}

          <div className="flex justify-end">
            <Button
              variant="primary"
              onClick={() => updateMutation.mutate()}
              loading={updateMutation.isPending || busy}
              disabled={!d.helpers || (!lastCheck?.updateAvailable && !switching)}
            >
              <Download className="size-4" />
              {busy ? t('info.updating') : switching ? t('info.switchTo', { channel: selected === 'test' ? t('info.channelTest') : t('info.channelMain') }) : t('info.updateNow')}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

export function InfoButton() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const info = useSystemInfo();
  const qc = useQueryClient();
  const admin = isAdmin(useMe().data);
  const update = info.data?.lastCheck?.updateAvailable;

  // Administrators get a quiet check on load, so the dot turns orange when an update is waiting.
  useEffect(() => {
    if (!admin || !info.data || info.data.lastCheck) return;
    api<UpdateCheck>('/system/update/check', { method: 'POST', body: {} })
      .then((res) => qc.setQueryData<SystemInfo>(['system-info'], (old) => (old ? { ...old, lastCheck: res } : old)))
      .catch(() => undefined);
  }, [admin, info.data, qc]);
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-xs whitespace-nowrap hover:bg-hover"
        title={update ? t('info.updateAvailable') : t('info.title')}
      >
        <i className={clsx('inline-block size-[7px] rounded-full', update ? 'bg-warning' : 'bg-online')} />
        {t('info.button')} · v{info.data?.version ?? '…'}
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title={t('info.title')}>
        <UpdatePanel />
      </Dialog>
    </>
  );
}
