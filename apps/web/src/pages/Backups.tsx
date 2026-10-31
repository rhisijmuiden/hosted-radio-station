import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  ArchiveRestore,
  CheckCircle2,
  ChevronDown,
  Cloud,
  Copy,
  DatabaseBackup,
  FolderOpen,
  HardDrive,
  KeyRound,
  Pencil,
  PlugZap,
  Server,
  ShieldCheck,
  Trash2,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Badge, Button, Card, CardHeader, Dialog, EmptyState, Field, Input, PageHeader, Select, Spinner, Switch, Table, Textarea } from '../components/ui';
import {
  api,
  ApiError,
  type BackupRetention,
  type BackupRun,
  type BackupRunDetail,
  type BackupSchedule,
  type BackupSettings,
  type BackupTarget,
  type BackupTargetType,
  type Snapshot,
} from '../lib/api';
import { formatBytes, formatDate, formatRelative } from '../lib/format';

const TYPES: BackupTargetType[] = ['sftp', 'ftps', 'ftp', 'onedrive', 'local'];
export const typeIcon: Record<BackupTargetType, LucideIcon> = { ftp: Server, ftps: Server, sftp: HardDrive, onedrive: Cloud, local: FolderOpen };
const MASK = '••••••••';

const defaultSchedule: BackupSchedule = { incremental: { enabled: true, everyHours: 24, at: '02:00' }, full: { enabled: true, weekday: 0, at: '03:00' } };
const defaultRetention: BackupRetention = { keepLast: 7, keepDaily: 14, keepWeekly: 8, keepMonthly: 12 };

function defaultConfig(type: BackupTargetType): Record<string, unknown> {
  switch (type) {
    case 'ftp':
      return { host: '', port: 21, username: '', password: '', path: 'hosted-radio-backup' };
    case 'ftps':
      return { host: '', port: 21, username: '', password: '', path: 'hosted-radio-backup', tlsMode: 'explicit', skipCertCheck: false };
    case 'sftp':
      return { host: '', port: 22, username: '', password: '', privateKey: '', keyPassphrase: '', hostKey: '', path: 'hosted-radio-backup' };
    case 'onedrive':
      return { path: 'Hosted Radio backup', token: '', tokenSource: 'device', clientId: '', driveId: '', driveType: '', account: '' };
    case 'local':
      return { path: '/mnt/backup/hosted-radio' };
  }
}

export function RunState({ run }: { run: Pick<BackupRun, 'state'> }) {
  const { t } = useTranslation();
  const tone = run.state === 'succeeded' ? 'online' : run.state === 'failed' ? 'offline' : run.state === 'running' ? 'accent' : 'neutral';
  return (
    <Badge tone={tone} dot>
      {t(`backups.states.${run.state}`)}
    </Badge>
  );
}

function Stat({ label, value, note, tone = 'muted' }: { label: string; value: ReactNode; note?: ReactNode; tone?: 'online' | 'muted' | 'warning' | 'offline' }) {
  return (
    <Card className="p-[18px]">
      <div className="text-xs text-muted">{label}</div>
      <div className="display mt-1.5 truncate text-[22px] leading-tight">{value}</div>
      {note && (
        <div className={clsx('mt-2 truncate text-xs', tone === 'online' && 'text-online', tone === 'warning' && 'text-warning', tone === 'offline' && 'text-offline', tone === 'muted' && 'text-muted')}>
          {note}
        </div>
      )}
    </Card>
  );
}

// Location dialog

/** Signing in to OneDrive somewhere else than the backups: its own endpoints, and a hint when the server has no Microsoft app. */
export interface OneDriveSignIn {
  base: string;
  hasApp: boolean;
  noAppHint: string;
}

/** The connection fields of a location (FTP, FTPS, SFTP, OneDrive or a folder); also used for recording uploads. */
export function ConfigFields({
  type,
  config,
  onChange,
  settings,
  onedrive,
}: {
  type: BackupTargetType;
  config: Record<string, unknown>;
  onChange: (c: Record<string, unknown>) => void;
  settings?: BackupSettings;
  onedrive?: OneDriveSignIn;
}) {
  const { t } = useTranslation();
  const v = (k: string) => (config[k] as string | number | boolean | undefined) ?? '';
  const set = (k: string, value: unknown) => onChange({ ...config, [k]: value });
  if (type === 'local') {
    return (
      <Field label={t('backups.folder')} hint={t('backups.localFolderHint')}>
        <Input required value={String(v('path'))} onChange={(e) => set('path', e.target.value)} placeholder="/mnt/backup/hosted-radio" />
      </Field>
    );
  }
  if (type === 'onedrive')
    return <OneDriveFields config={config} onChange={onChange} signIn={onedrive ?? { base: '/backups/onedrive', hasApp: !!settings?.onedriveClientId, noAppHint: t('backups.onedriveNeedsApp') }} />;
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-[1fr_110px]">
        <Field label={t('backups.host')}>
          <Input required value={String(v('host'))} onChange={(e) => set('host', e.target.value)} placeholder={type === 'sftp' ? 'u12345.your-storagebox.de' : 'ftp.example.com'} />
        </Field>
        <Field label={t('backups.port')}>
          <Input required type="number" min={1} max={65535} value={String(v('port'))} onChange={(e) => set('port', Number(e.target.value))} />
        </Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('backups.username')}>
          <Input required autoComplete="off" value={String(v('username'))} onChange={(e) => set('username', e.target.value)} />
        </Field>
        <Field label={t('backups.password')}>
          <Input type="password" autoComplete="new-password" value={String(v('password'))} onChange={(e) => set('password', e.target.value)} />
        </Field>
      </div>
      {type === 'ftps' && (
        <>
          <Field label={t('backups.tlsMode')}>
            <Select
              value={String(v('tlsMode'))}
              onChange={(e) => onChange({ ...config, tlsMode: e.target.value, port: e.target.value === 'implicit' ? 990 : 21 })}
            >
              <option value="explicit">{t('backups.tlsExplicit')}</option>
              <option value="implicit">{t('backups.tlsImplicit')}</option>
            </Select>
          </Field>
          <Switch checked={!!config.skipCertCheck} onChange={(x) => set('skipCertCheck', x)} label={t('backups.skipCert')} />
        </>
      )}
      {type === 'sftp' && (
        <>
          <Field label={t('backups.privateKey')} hint={t('backups.privateKeyHint')}>
            <Textarea value={String(v('privateKey'))} onChange={(e) => set('privateKey', e.target.value)} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" />
          </Field>
          {!!config.privateKey && (
            <Field label={t('backups.keyPassphrase')}>
              <Input type="password" autoComplete="new-password" value={String(v('keyPassphrase'))} onChange={(e) => set('keyPassphrase', e.target.value)} />
            </Field>
          )}
          <Field label={t('backups.hostKey')} hint={t('backups.hostKeyHint')}>
            <Input value={String(v('hostKey'))} onChange={(e) => set('hostKey', e.target.value)} placeholder="host ssh-ed25519 AAAA…" />
          </Field>
        </>
      )}
      <Field label={t('backups.folder')} hint={t('backups.folderHint')}>
        <Input required value={String(v('path'))} onChange={(e) => set('path', e.target.value)} />
      </Field>
    </div>
  );
}

function OneDriveFields({ config, onChange, signIn }: { config: Record<string, unknown>; onChange: (c: Record<string, unknown>) => void; signIn: OneDriveSignIn }) {
  const { t } = useTranslation();
  const [paste, setPaste] = useState(false);
  const [code, setCode] = useState<{ deviceCode: string; userCode: string; verificationUri: string; interval: number } | null>(null);
  const configRef = useRef(config);
  configRef.current = config;
  const { hasApp } = signIn;
  const connected = !!config.token && (config.token === MASK || String(config.token).includes('access_token'));

  const start = useMutation({
    mutationFn: () => api<{ deviceCode: string; userCode: string; verificationUri: string; interval: number }>(`${signIn.base}/device-code`, { method: 'POST' }),
    onSuccess: (res) => {
      setCode(res);
      window.open(res.verificationUri, '_blank', 'noopener');
    },
    onError: (err) => toast.error((err as Error).message),
  });

  useEffect(() => {
    if (!code) return;
    let stop = false;
    const poll = async () => {
      while (!stop) {
        await new Promise((r) => setTimeout(r, code.interval * 1000));
        if (stop) return;
        try {
          const res = await api<{ status: 'pending' | 'ok'; token?: string; clientId?: string; driveId?: string; driveType?: string; account?: string }>(
            `${signIn.base}/device-token`,
            { method: 'POST', body: { deviceCode: code.deviceCode } },
          );
          if (res.status === 'ok') {
            onChange({ ...configRef.current, token: res.token, tokenSource: 'device', clientId: res.clientId, driveId: res.driveId, driveType: res.driveType, account: res.account });
            setCode(null);
            toast.success(t('backups.onedriveDone'));
            return;
          }
        } catch (err) {
          toast.error((err as Error).message);
          setCode(null);
          return;
        }
      }
    };
    void poll();
    return () => {
      stop = true;
    };
  }, [code, onChange, t, signIn.base]);

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-md border border-line p-4">
        <div className="mb-1 text-[13px] font-semibold">{t('backups.onedriveAccount')}</div>
        <div className="mb-3 flex items-center gap-2 text-sm">
          {connected ? (
            <>
              <CheckCircle2 className="size-4 text-online" /> {t('backups.onedriveConnected', { account: String(config.account || 'OneDrive') })}
            </>
          ) : (
            <span className="text-muted">{t('backups.onedriveNotConnected')}</span>
          )}
        </div>
        {code ? (
          <div className="rounded-md bg-chip p-3 text-[13px]">
            <div>{t('backups.onedriveCode', { url: code.verificationUri })}</div>
            <div className="my-2 flex items-center gap-2">
              <span className="font-mono text-2xl font-bold tracking-[0.2em]">{code.userCode}</span>
              <Button type="button" size="sm" variant="ghost" onClick={() => void navigator.clipboard.writeText(code.userCode)}>
                <Copy className="size-4" />
              </Button>
            </div>
            <div className="flex items-center gap-2 text-muted">
              <Spinner className="size-4" /> {t('backups.onedriveWaiting')}
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            {hasApp && (
              <Button type="button" variant="dark" onClick={() => start.mutate()} loading={start.isPending}>
                <Cloud className="size-4" /> {t('backups.onedriveSignIn')}
              </Button>
            )}
            <Button type="button" size="sm" variant="ghost" onClick={() => setPaste((p) => !p)}>
              {t('backups.onedrivePaste')}
            </Button>
          </div>
        )}
        {!hasApp && !code && <p className="mt-2 text-xs text-muted">{signIn.noAppHint}</p>}
        {paste && (
          <Field label={t('backups.onedriveToken')} hint={t('backups.onedrivePasteHint')} className="mt-3">
            <Textarea
              placeholder='{"access_token":"…","refresh_token":"…","expiry":"…"}'
              onChange={(e) => onChange({ ...config, token: e.target.value.trim(), tokenSource: 'rclone', clientId: '', driveId: '', driveType: '', account: '' })}
            />
          </Field>
        )}
      </div>
      <Field label={t('backups.folder')} hint={t('backups.folderHint')}>
        <Input required value={String(config.path ?? '')} onChange={(e) => onChange({ ...config, path: e.target.value })} />
      </Field>
    </div>
  );
}

function ScheduleFields({ schedule, onChange }: { schedule: BackupSchedule; onChange: (s: BackupSchedule) => void }) {
  const { t } = useTranslation();
  const weekdays = t('backups.weekdays', { returnObjects: true }) as string[];
  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-md border border-line p-4">
        <Switch
          checked={schedule.incremental.enabled}
          onChange={(enabled) => onChange({ ...schedule, incremental: { ...schedule.incremental, enabled } })}
          label={t('backups.incremental')}
          description={t('backups.incrementalHint')}
        />
        {schedule.incremental.enabled && (
          <div className="mt-3 flex flex-wrap items-center gap-2 text-[13px]">
            {t('backups.every')}
            <Select
              className="h-9! w-28!"
              value={schedule.incremental.everyHours}
              onChange={(e) => onChange({ ...schedule, incremental: { ...schedule.incremental, everyHours: Number(e.target.value) } })}
            >
              {[1, 2, 3, 4, 6, 8, 12, 24].map((h) => (
                <option key={h} value={h}>
                  {t('backups.hours', { count: h })}
                </option>
              ))}
            </Select>
            {t('backups.startingAt')}
            <Input type="time" className="h-9! w-28!" value={schedule.incremental.at} onChange={(e) => onChange({ ...schedule, incremental: { ...schedule.incremental, at: e.target.value } })} />
          </div>
        )}
      </div>
      <div className="rounded-md border border-line p-4">
        <Switch checked={schedule.full.enabled} onChange={(enabled) => onChange({ ...schedule, full: { ...schedule.full, enabled } })} label={t('backups.full')} description={t('backups.fullHint')} />
        {schedule.full.enabled && (
          <div className="mt-3 flex flex-wrap items-center gap-2 text-[13px]">
            {t('backups.weekday')}
            <Select className="h-9! w-36!" value={schedule.full.weekday} onChange={(e) => onChange({ ...schedule, full: { ...schedule.full, weekday: Number(e.target.value) } })}>
              <option value={-1}>{t('backups.everyDay')}</option>
              {weekdays.map((d, i) => (
                <option key={d} value={i}>
                  {d}
                </option>
              ))}
            </Select>
            {t('backups.at')}
            <Input type="time" className="h-9! w-28!" value={schedule.full.at} onChange={(e) => onChange({ ...schedule, full: { ...schedule.full, at: e.target.value } })} />
          </div>
        )}
      </div>
    </div>
  );
}

function RetentionFields({ value, onChange }: { value: BackupRetention; onChange: (r: BackupRetention) => void }) {
  const { t } = useTranslation();
  const fields: [keyof BackupRetention, string][] = [
    ['keepLast', t('backups.keepLast')],
    ['keepDaily', t('backups.keepDaily')],
    ['keepWeekly', t('backups.keepWeekly')],
    ['keepMonthly', t('backups.keepMonthly')],
  ];
  return (
    <Field label={t('backups.retention')} hint={t('backups.retentionHint')}>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {fields.map(([k, label]) => (
          <label key={k} className="flex flex-col gap-1 text-xs text-muted">
            {label}
            <Input type="number" min={0} max={1000} value={value[k]} onChange={(e) => onChange({ ...value, [k]: Number(e.target.value) })} />
          </label>
        ))}
      </div>
    </Field>
  );
}

function TargetDialog({
  target,
  open,
  onClose,
  onCreated,
  settings,
}: {
  target: BackupTarget | null;
  open: boolean;
  onClose: () => void;
  onCreated: (name: string, key: string) => void;
  settings?: BackupSettings;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [type, setType] = useState<BackupTargetType>('sftp');
  const [config, setConfig] = useState<Record<string, unknown>>(defaultConfig('sftp'));
  const [schedule, setSchedule] = useState(defaultSchedule);
  const [retention, setRetention] = useState(defaultRetention);
  const [enabled, setEnabled] = useState(true);
  const [repoPassword, setRepoPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [tested, setTested] = useState<{ repository: string; message: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setTested(null);
    setRepoPassword('');
    if (target) {
      setName(target.name);
      setType(target.type);
      setConfig(target.config);
      setSchedule(target.schedule);
      setRetention(target.retention);
      setEnabled(target.enabled);
    } else {
      setName('');
      setType('sftp');
      setConfig(defaultConfig('sftp'));
      setSchedule(defaultSchedule);
      setRetention(defaultRetention);
      setEnabled(true);
    }
  }, [open, target]);

  const save = useMutation({
    mutationFn: () =>
      target
        ? api<BackupTarget>(`/backups/targets/${target.id}`, { method: 'PUT', body: { name, enabled, config, schedule, retention } })
        : api<BackupTarget & { recoveryKey: string }>('/backups/targets', {
            method: 'POST',
            body: { name, type, enabled, config, schedule, retention, repoPassword: repoPassword || undefined },
          }),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ['backup-targets'] });
      toast.success(t('common.saved'));
      onClose();
      if (!target && 'recoveryKey' in res && !repoPassword) onCreated(res.name, (res as { recoveryKey: string }).recoveryKey);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : String(err)),
  });
  const test = useMutation({
    mutationFn: () =>
      api<{ repository: string; message: string }>('/backups/test', {
        method: 'POST',
        body: { id: target?.id, type, config, repoPassword: repoPassword || undefined },
      }),
    onSuccess: (res) => {
      setError(null);
      setTested(res);
    },
    onError: (err) => {
      setTested(null);
      setError((err as Error).message);
    },
  });

  const changeType = (next: BackupTargetType) => {
    setType(next);
    setConfig(defaultConfig(next));
    setTested(null);
  };
  const onConfig = (c: Record<string, unknown>) => {
    setConfig(c);
    setTested(null);
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      wide
      title={target ? t('backups.editTarget') : t('backups.newTarget')}
      footer={
        <>
          <Button className="sm:mr-auto" onClick={() => test.mutate()} loading={test.isPending}>
            <PlugZap className="size-4" /> {t('backups.test')}
          </Button>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" type="submit" form="target-form" loading={save.isPending}>
            {target ? t('common.save') : t('backups.add')}
          </Button>
        </>
      }
    >
      <form
        id="target-form"
        className="flex flex-col gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Field label={t('backups.name')}>
          <Input required autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={t('backups.namePlaceholder')} />
        </Field>
        {!target && (
          <Field label={t('backups.type')} hint={t(`backups.typeHints.${type}`)}>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
              {TYPES.map((x) => {
                const Icon = typeIcon[x];
                return (
                  <button
                    key={x}
                    type="button"
                    onClick={() => changeType(x)}
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
        <ConfigFields type={type} config={config} onChange={onConfig} settings={settings} />
        {!target && (
          <Field label={t('backups.recoveryKeyExisting')} hint={t('backups.recoveryKeyExistingHint')}>
            <Input type="password" autoComplete="off" value={repoPassword} onChange={(e) => setRepoPassword(e.target.value)} />
          </Field>
        )}
        {tested && (
          <div className={clsx('flex gap-2.5 rounded-md px-3 py-2.5 text-[13px]', tested.repository === 'wrong_password' || tested.repository === 'existing' ? 'bg-warning/12' : 'bg-online/10')}>
            <CheckCircle2 className={clsx('mt-0.5 size-4 shrink-0', tested.repository === 'wrong_password' || tested.repository === 'existing' ? 'text-warning' : 'text-online')} />
            <div>
              <div className="font-semibold">{t('backups.testOk')}</div>
              <div className="text-muted">{t(`backups.repo.${tested.repository}`)}</div>
            </div>
          </div>
        )}
        {error && <p className="rounded-md bg-offline/10 px-3 py-2 text-[13px] break-words text-offline">{error}</p>}
        <div className="border-t border-line pt-5">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="display text-base">{t('backups.schedule')}</h3>
          </div>
          <div className="flex flex-col gap-4">
            <Switch checked={enabled} onChange={setEnabled} label={t('backups.enabled')} />
            {enabled && <ScheduleFields schedule={schedule} onChange={setSchedule} />}
            <RetentionFields value={retention} onChange={setRetention} />
          </div>
        </div>
      </form>
    </Dialog>
  );
}

function RecoveryKeyDialog({ value, onClose }: { value: { name: string; key: string } | null; onClose: () => void }) {
  const { t } = useTranslation();
  const [stored, setStored] = useState(false);
  useEffect(() => setStored(false), [value]);
  if (!value) return null;
  return (
    <Dialog
      open
      onClose={() => stored && onClose()}
      title={t('backups.keyTitle')}
      description={t('backups.keyText', { name: value.name })}
      footer={
        <Button variant="primary" disabled={!stored} onClick={onClose}>
          {t('common.done')}
        </Button>
      }
    >
      <div className="flex items-center gap-2 rounded-md border border-line bg-chip p-3">
        <KeyRound className="size-5 shrink-0 text-koraal" />
        <code className="min-w-0 flex-1 font-mono text-sm break-all">{value.key}</code>
        <Button size="sm" variant="ghost" onClick={() => void navigator.clipboard.writeText(value.key).then(() => toast.success(t('sso.copied')))}>
          <Copy className="size-4" />
        </Button>
      </div>
      <p className="mt-3 text-[13px] text-muted">{t('backups.recoveryKeyHint')}</p>
      <label className="mt-4 flex items-center gap-2 text-sm font-semibold">
        <input type="checkbox" checked={stored} onChange={(e) => setStored(e.target.checked)} className="size-4 accent-[var(--koraal)]" />
        {t('backups.keySaved')}
      </label>
    </Dialog>
  );
}

// Restore

function RestoreDialog({ target, onClose }: { target: BackupTarget | null; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [snapshot, setSnapshot] = useState<string | null>(null);
  const [parts, setParts] = useState({ database: true, files: true, config: true });
  const [confirmText, setConfirmText] = useState('');
  const [started, setStarted] = useState<string | null>(null);
  const snapshots = useQuery({
    queryKey: ['snapshots', target?.id],
    queryFn: () => api<Snapshot[]>(`/backups/targets/${target!.id}/snapshots`),
    enabled: !!target,
    retry: false,
  });
  useEffect(() => {
    setSnapshot(null);
    setConfirmText('');
    setStarted(null);
    setParts({ database: true, files: true, config: true });
  }, [target]);
  useEffect(() => {
    if (!snapshot && snapshots.data?.[0]) setSnapshot(snapshots.data[0].id);
  }, [snapshots.data, snapshot]);

  const restore = useMutation({
    mutationFn: () => api<BackupRun>(`/backups/targets/${target!.id}/restore`, { method: 'POST', body: { snapshotId: snapshot, parts, confirm: confirmText } }),
    onSuccess: (run) => {
      setStarted(run.id);
      toast.success(t('backups.restoreStarted'));
      void qc.invalidateQueries({ queryKey: ['backup-runs'] });
    },
    onError: (err) => toast.error((err as Error).message),
  });

  // While the database is restored the API restarts; wait for it to come back with the run finished.
  useEffect(() => {
    if (!started) return;
    const timer = setInterval(async () => {
      try {
        const run = await api<BackupRunDetail>(`/backups/runs/${started}`);
        if (run.state === 'succeeded' || run.state === 'failed') {
          clearInterval(timer);
          if (run.state === 'failed') toast.error(run.message ?? t('backups.states.failed'), { duration: 15_000 });
          window.location.href = parts.database ? '/login' : '/settings/backups';
        }
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          clearInterval(timer);
          window.location.href = '/login';
        }
      }
    }, 3000);
    return () => clearInterval(timer);
  }, [started, parts.database, t]);

  if (!target) return null;
  const partList: [keyof typeof parts, string, string][] = [
    ['database', t('backups.partDatabase'), t('backups.partDatabaseHint')],
    ['files', t('backups.partFiles'), t('backups.partFilesHint')],
    ['config', t('backups.partConfig'), t('backups.partConfigHint')],
  ];

  return (
    <Dialog
      open
      wide
      onClose={() => !started && onClose()}
      title={t('backups.restoreTitle', { name: target.name })}
      description={t('backups.restoreText')}
      footer={
        started ? undefined : (
          <>
            <Button onClick={onClose}>{t('common.cancel')}</Button>
            <Button
              variant="primary"
              loading={restore.isPending}
              disabled={!snapshot || confirmText !== 'RESTORE' || !Object.values(parts).some(Boolean)}
              onClick={() => restore.mutate()}
            >
              <ArchiveRestore className="size-4" /> {t('backups.restoreStart')}
            </Button>
          </>
        )
      }
    >
      {started ? (
        <div className="flex flex-col items-center gap-3 py-8 text-center">
          <Spinner className="size-8" />
          <p className="max-w-sm text-[13px] text-muted">{t('backups.restoreRunning')}</p>
        </div>
      ) : snapshots.isPending ? (
        <div className="flex items-center gap-2 py-6 text-[13px] text-muted">
          <Spinner className="size-4" /> {t('backups.loadingSnapshots')}
        </div>
      ) : snapshots.isError ? (
        <p className="rounded-md bg-offline/10 px-3 py-2 text-[13px] text-offline">{(snapshots.error as Error).message}</p>
      ) : !snapshots.data?.length ? (
        <p className="py-6 text-center text-[13px] text-muted">{t('backups.noSnapshots')}</p>
      ) : (
        <div className="flex flex-col gap-5">
          <div className="max-h-64 overflow-y-auto rounded-md border border-line">
            {snapshots.data.map((s) => (
              <label key={s.id} className={clsx('flex cursor-pointer items-center gap-3 border-b border-line px-3 py-2.5 last:border-b-0', snapshot === s.id ? 'bg-koraal/8' : 'hover:bg-hover')}>
                <input type="radio" name="snapshot" checked={snapshot === s.id} onChange={() => setSnapshot(s.id)} className="size-4 accent-[var(--koraal)]" />
                <span className="flex-1">
                  <span className="block text-sm font-semibold">{formatDate(s.time)}</span>
                  <span className="block font-mono text-xs text-muted">
                    {s.shortId} · {s.hostname}
                    {s.sizeBytes ? ` · ${formatBytes(s.sizeBytes)}` : ''}
                  </span>
                </span>
                <Badge tone={s.kind === 'full' ? 'accent' : 'neutral'}>{t(`backups.kinds.${s.kind}`)}</Badge>
              </label>
            ))}
          </div>
          <div>
            <div className="mb-2 text-[13px] font-semibold">{t('backups.restoreParts')}</div>
            <div className="grid gap-2 sm:grid-cols-3">
              {partList.map(([k, label, hint]) => (
                <label key={k} className={clsx('flex cursor-pointer gap-2.5 rounded-md border p-3', parts[k] ? 'border-koraal bg-koraal/8' : 'border-line')}>
                  <input type="checkbox" checked={parts[k]} onChange={(e) => setParts({ ...parts, [k]: e.target.checked })} className="mt-0.5 size-4 accent-[var(--koraal)]" />
                  <span>
                    <span className="block text-sm font-semibold">{label}</span>
                    <span className="block text-xs text-muted">{hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>
          <p className="rounded-md bg-warning/12 px-3 py-2 text-[13px]">{t('backups.restoreWarning')}</p>
          <Field label={t('backups.restoreConfirm')}>
            <Input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} placeholder="RESTORE" autoComplete="off" />
          </Field>
        </div>
      )}
    </Dialog>
  );
}

// Runs

function RunLogDialog({ runId, onClose }: { runId: string | null; onClose: () => void }) {
  const { t } = useTranslation();
  const run = useQuery({
    queryKey: ['backup-run', runId],
    queryFn: () => api<BackupRunDetail>(`/backups/runs/${runId}`),
    enabled: !!runId,
    refetchInterval: (q) => (q.state.data && (q.state.data.state === 'running' || q.state.data.state === 'queued') ? 2000 : false),
  });
  const pre = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (pre.current) pre.current.scrollTop = pre.current.scrollHeight;
  }, [run.data?.log]);
  if (!runId) return null;
  const r = run.data;
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={r ? `${t(`backups.kinds.${r.kind}`)} · ${r.targetName}` : t('backups.log')}
      description={r ? `${formatDate(r.startedAt ?? r.queuedAt)}${r.requestedBy ? ` · ${r.requestedBy}` : ''}` : undefined}
    >
      {!r ? (
        <Spinner />
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <RunState run={r} />
            <span className="text-[13px] text-muted">{r.message}</span>
          </div>
          <pre ref={pre} className="max-h-[50vh] overflow-auto rounded-md bg-nacht p-3 font-mono text-[11.5px] leading-relaxed text-white/85">
            {r.log || '…'}
          </pre>
        </>
      )}
    </Dialog>
  );
}

function duration(r: BackupRun) {
  if (!r.startedAt) return '—';
  const end = r.finishedAt ? new Date(r.finishedAt).getTime() : Date.now();
  const s = Math.max(0, Math.round((end - new Date(r.startedAt).getTime()) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

function RunsCard({ runs, onOpen }: { runs: BackupRun[] | undefined; onOpen: (id: string) => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const cancel = useMutation({
    mutationFn: (id: string) => api(`/backups/runs/${id}/cancel`, { method: 'POST' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['backup-runs'] }),
    onError: (err) => toast.error((err as Error).message),
  });
  return (
    <Card>
      <CardHeader title={t('backups.history')} />
      {!runs ? (
        <div className="grid place-items-center py-10">
          <Spinner />
        </div>
      ) : runs.length === 0 ? (
        <p className="px-5 py-8 text-center text-[13px] text-muted">{t('backups.historyEmpty')}</p>
      ) : (
        <Table head={[t('audit.time'), t('backups.locations'), t('backups.type'), t('fields.status'), '']}>
          {runs.map((r) => (
            <tr key={r.id} className="cursor-pointer hover:bg-hover/60" onClick={() => onOpen(r.id)}>
              <td className="text-[13px] whitespace-nowrap">
                <div>{formatDate(r.startedAt ?? r.queuedAt)}</div>
                <div className="text-xs text-muted">
                  {t(`backups.triggers.${r.trigger}`, { defaultValue: r.trigger })} · {duration(r)}
                </div>
              </td>
              <td className="max-w-48 truncate font-semibold">{r.targetName}</td>
              <td>
                <Badge tone={r.kind === 'full' ? 'accent' : r.kind === 'restore' ? 'warning' : 'neutral'}>{t(`backups.kinds.${r.kind}`)}</Badge>
              </td>
              <td className="max-w-80">
                <div className="flex flex-col gap-1">
                  <RunState run={r} />
                  {r.message && <span className="truncate text-xs text-muted">{r.message}</span>}
                </div>
              </td>
              <td className="text-right">
                {r.state === 'queued' && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={(e) => {
                      e.stopPropagation();
                      cancel.mutate(r.id);
                    }}
                  >
                    {t('backups.cancel')}
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
}

// Settings

function SettingsCard() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ['settings', 'backup'], queryFn: () => api<BackupSettings>('/settings/backup') });
  const [form, setForm] = useState<BackupSettings | null>(null);
  const [emails, setEmails] = useState('');
  useEffect(() => {
    if (!settings.data) return;
    setForm(settings.data);
    setEmails(settings.data.notifyEmails.join('\n'));
  }, [settings.data]);
  const save = useMutation({
    mutationFn: () =>
      api<BackupSettings>('/settings/backup', {
        method: 'PUT',
        body: { ...form!, notifyEmails: emails.split(/[\s,;]+/).map((e) => e.trim()).filter(Boolean) },
      }),
    onSuccess: (res) => {
      qc.setQueryData(['settings', 'backup'], res);
      toast.success(t('common.saved'));
    },
    onError: (err) => toast.error((err as Error).message),
  });
  if (!form) return null;
  return (
    <Card>
      <CardHeader title={t('backups.settings')} />
      <form
        className="flex flex-col gap-4 p-5"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Field label={t('backups.notify')}>
          <Select value={form.notifyOn} onChange={(e) => setForm({ ...form, notifyOn: e.target.value as BackupSettings['notifyOn'] })}>
            <option value="failure">{t('backups.notifyFailure')}</option>
            <option value="always">{t('backups.notifyAlways')}</option>
            <option value="never">{t('backups.notifyNever')}</option>
          </Select>
        </Field>
        <Field label={t('backups.notifyEmails')} hint={t('backups.notifyEmailsHint')}>
          <Textarea className="min-h-16 font-sans text-sm" value={emails} onChange={(e) => setEmails(e.target.value)} placeholder="beheer@example.com" />
        </Field>
        <Field label={t('backups.notifyLanguage')}>
          <Select value={form.notifyLanguage} onChange={(e) => setForm({ ...form, notifyLanguage: e.target.value as 'en' | 'nl' })}>
            <option value="en">English</option>
            <option value="nl">Nederlands</option>
          </Select>
        </Field>
        <Field label={t('backups.onedriveClientId')} hint={t('backups.onedriveClientIdHint')}>
          <Input value={form.onedriveClientId} onChange={(e) => setForm({ ...form, onedriveClientId: e.target.value })} placeholder="00000000-0000-0000-0000-000000000000" />
        </Field>
        <div className="flex justify-end">
          <Button type="submit" variant="dark" loading={save.isPending}>
            {t('common.save')}
          </Button>
        </div>
      </form>
    </Card>
  );
}

// Page

function BackupNowButton({ target }: { target: BackupTarget }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);
  const run = useMutation({
    mutationFn: (kind: 'full' | 'incremental') => api<BackupRun>(`/backups/targets/${target.id}/run`, { method: 'POST', body: { kind } }),
    onSuccess: () => {
      toast.success(t('backups.started'));
      void qc.invalidateQueries({ queryKey: ['backup-runs'] });
      void qc.invalidateQueries({ queryKey: ['backup-targets'] });
    },
    onError: (err) => toast.error((err as Error).message),
  });
  return (
    <div ref={ref} className="relative">
      <Button size="sm" variant="primary" loading={run.isPending} onClick={() => setOpen((o) => !o)}>
        <DatabaseBackup className="size-4" /> {t('backups.backupNow')} <ChevronDown className="size-3.5" />
      </Button>
      {open && (
        <div className="absolute right-0 z-20 mt-1 w-52 overflow-hidden rounded-md border border-line bg-raised py-1 shadow-lg">
          {(['incremental', 'full'] as const).map((k) => (
            <button
              key={k}
              className="block w-full px-3 py-2 text-left text-sm hover:bg-hover"
              onClick={() => {
                setOpen(false);
                run.mutate(k);
              }}
            >
              {k === 'full' ? t('backups.fullNow') : t('backups.incrementalNow')}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function TargetRow({ target, onEdit, onRestore, onOpenRun }: { target: BackupTarget; onEdit: () => void; onRestore: () => void; onOpenRun: (id: string) => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const Icon = typeIcon[target.type];
  const [key, setKey] = useState<string | null>(null);
  const del = useMutation({
    mutationFn: () => api(`/backups/targets/${target.id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['backup-targets'] });
      toast.success(t('backups.deleted'));
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const showKey = useMutation({
    mutationFn: () => api<{ recoveryKey: string }>(`/backups/targets/${target.id}/recovery-key`),
    onSuccess: (res) => setKey(res.recoveryKey),
    onError: (err) => toast.error((err as Error).message),
  });
  const next = [target.nextIncremental, target.nextFull].filter(Boolean).sort()[0] ?? null;
  const last = target.lastRun;
  return (
    <div className="flex flex-col gap-3 border-b border-line px-5 py-4 last:border-b-0">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="flex min-w-60 flex-1 items-center gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-[10px] bg-nacht text-white dark:bg-chip">
            <Icon className="size-5" />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold">{target.name}</span>
              <Badge>{t(`backups.types.${target.type}`)}</Badge>
              {!target.enabled && <Badge tone="warning">{t('backups.disabled')}</Badge>}
            </div>
            <div className="truncate font-mono text-xs text-muted">{target.description}</div>
            <div className="mt-0.5 text-xs text-muted">
              {next ? `${t('backups.nextBackup')}: ${formatRelative(next)}` : t('backups.notScheduled')}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {last ? (
            <button className="flex min-w-0 flex-col items-start gap-1 text-left" onClick={() => onOpenRun(last.id)}>
              <RunState run={last} />
              <span className="truncate text-xs text-muted">
                {t(`backups.kinds.${last.kind}`)} · {formatRelative(last.finishedAt ?? last.startedAt ?? last.queuedAt)}
              </span>
            </button>
          ) : (
            <span className="text-xs text-muted">{t('backups.never')}</span>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 sm:pl-13">
        <BackupNowButton target={target} />
        <Button size="sm" onClick={onRestore}>
          <ArchiveRestore className="size-4" /> {t('backups.restore')}
        </Button>
        <Button size="sm" variant="ghost" title={t('backups.showKey')} onClick={() => showKey.mutate()}>
          <KeyRound className="size-4" />
        </Button>
        <Button size="sm" variant="ghost" title={t('backups.editTarget')} onClick={onEdit}>
          <Pencil className="size-4" />
        </Button>
        <Button size="sm" variant="ghost" title={t('common.delete')} onClick={() => confirm(t('backups.deleteConfirm', { name: target.name })) && del.mutate()}>
          <Trash2 className="size-4 text-offline" />
        </Button>
      </div>
      <RecoveryKeyDialog value={key ? { name: target.name, key } : null} onClose={() => setKey(null)} />
    </div>
  );
}

export function BackupsPage() {
  const { t } = useTranslation();
  const [editing, setEditing] = useState<BackupTarget | null>(null);
  const [dialog, setDialog] = useState(false);
  const [restoring, setRestoring] = useState<BackupTarget | null>(null);
  const [newKey, setNewKey] = useState<{ name: string; key: string } | null>(null);
  const [openRun, setOpenRun] = useState<string | null>(null);
  const settings = useQuery({ queryKey: ['settings', 'backup'], queryFn: () => api<BackupSettings>('/settings/backup') });
  const runs = useQuery({
    queryKey: ['backup-runs'],
    queryFn: () => api<BackupRun[]>('/backups/runs?limit=25'),
    refetchInterval: (q) => (q.state.data?.some((r) => r.state === 'running' || r.state === 'queued') ? 3000 : 30_000),
  });
  const busy = runs.data?.find((r) => r.state === 'running') ?? runs.data?.find((r) => r.state === 'queued');
  const targets = useQuery({
    queryKey: ['backup-targets', busy?.id ?? null, busy?.state ?? null],
    queryFn: () => api<BackupTarget[]>('/backups/targets'),
  });

  const list = targets.data ?? [];
  const lastSuccess = list
    .map((x) => x.lastSuccess)
    .filter((r): r is BackupRun => !!r)
    .sort((a, b) => (b.finishedAt ?? '').localeCompare(a.finishedAt ?? ''))[0];
  const next = list
    .flatMap((x) => [x.nextFull, x.nextIncremental])
    .filter((d): d is string => !!d)
    .sort()[0];
  const ageHours = lastSuccess?.finishedAt ? (Date.now() - new Date(lastSuccess.finishedAt).getTime()) / 3600_000 : null;

  return (
    <>
      <PageHeader
        title={t('nav.backups')}
        description={t('backups.subtitle')}
        actions={
          <Button
            variant="primary"
            onClick={() => {
              setEditing(null);
              setDialog(true);
            }}
          >
            + {t('backups.newTarget')}
          </Button>
        }
      />
      <section className="mb-4 grid grid-cols-2 gap-4 xl:grid-cols-4">
        <Stat
          label={t('backups.lastBackup')}
          value={lastSuccess ? formatRelative(lastSuccess.finishedAt) : t('backups.never')}
          note={lastSuccess ? `${lastSuccess.targetName} · ${t(`backups.kinds.${lastSuccess.kind}`)}` : undefined}
          tone={ageHours === null ? 'muted' : ageHours > 48 ? 'warning' : 'online'}
        />
        <Stat label={t('backups.nextBackup')} value={next ? formatRelative(next) : '—'} note={next ? formatDate(next) : t('backups.notScheduled')} />
        <Stat
          label={t('backups.running')}
          value={busy ? t(`backups.states.${busy.state}`) : t('backups.nothingRunning')}
          note={busy ? `${busy.targetName} · ${busy.message ?? ''}` : undefined}
          tone={busy ? 'warning' : 'muted'}
        />
        <Stat label={t('backups.locations')} value={list.length} note={list.map((x) => t(`backups.types.${x.type}`)).join(', ') || undefined} />
      </section>

      <div className="grid gap-4 xl:grid-cols-[1.7fr_1fr]">
        <div className="flex min-w-0 flex-col gap-4">
          <Card>
            <CardHeader title={t('backups.locations')} />
            {targets.isPending ? (
              <div className="grid place-items-center py-10">
                <Spinner />
              </div>
            ) : list.length === 0 ? (
              <EmptyState
                icon={<DatabaseBackup className="size-6" />}
                title={t('backups.empty')}
                description={t('backups.emptyText')}
                action={
                  <Button variant="primary" onClick={() => setDialog(true)}>
                    + {t('backups.newTarget')}
                  </Button>
                }
              />
            ) : (
              list.map((x) => (
                <TargetRow
                  key={x.id}
                  target={x}
                  onEdit={() => {
                    setEditing(x);
                    setDialog(true);
                  }}
                  onRestore={() => setRestoring(x)}
                  onOpenRun={setOpenRun}
                />
              ))
            )}
          </Card>
          <RunsCard runs={runs.data} onOpen={setOpenRun} />
        </div>
        <div className="flex flex-col gap-4">
          <Card className="p-5">
            <div className="mb-2 flex items-center gap-2">
              <ShieldCheck className="size-5 text-koraal" />
              <h2 className="display text-base">{t('backups.howItWorks')}</h2>
            </div>
            <p className="text-[13px] leading-relaxed text-muted">{t('backups.howItWorksText')}</p>
          </Card>
          <SettingsCard />
        </div>
      </div>

      <TargetDialog target={editing} open={dialog} onClose={() => setDialog(false)} onCreated={(name, key) => setNewKey({ name, key })} settings={settings.data} />
      <RecoveryKeyDialog value={newKey} onClose={() => setNewKey(null)} />
      <RestoreDialog target={restoring} onClose={() => setRestoring(null)} />
      <RunLogDialog runId={openRun} onClose={() => setOpenRun(null)} />
    </>
  );
}
