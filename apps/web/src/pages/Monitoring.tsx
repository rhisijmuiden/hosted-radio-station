import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { AlertTriangle, BellRing, CheckCircle2, Eye, Mail, MessageCircle, Save, Search, Send, Webhook, Wrench, X, XCircle } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { Badge, Button, Card, CardHeader, EmptyState, Field, Input, PageHeader, Segmented, Select, Spinner, Switch, Table } from '../components/ui';
import { api, type Alert, type AlertDelivery, type AlertSettings, type Maintenance, type NodeItem, type StationListItem, type TelegramChat } from '../lib/api';
import { formatDate, formatRelative } from '../lib/format';

/** "4 min", "1 h 12 min", "2 d 3 h" between two moments. */
function span(from: string, to: string | null) {
  const m = Math.max(1, Math.round(((to ? new Date(to).getTime() : Date.now()) - new Date(from).getTime()) / 60_000));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h${m % 60 ? ` ${m % 60} min` : ''}`;
  return `${Math.floor(h / 24)} d${h % 24 ? ` ${h % 24} h` : ''}`;
}

function useAlertTitle() {
  const { t } = useTranslation();
  return (a: Pick<Alert, 'kind' | 'params'>) => t(`monitoring.kinds.${a.kind}`, { ...a.params, interpolation: { escapeValue: false } });
}

function SeverityIcon({ alert, className }: { alert: Pick<Alert, 'severity' | 'resolvedAt'>; className?: string }) {
  if (alert.resolvedAt) return <CheckCircle2 className={clsx('size-5 text-online', className)} />;
  return alert.severity === 'critical' ? <XCircle className={clsx('size-5 text-offline', className)} /> : <AlertTriangle className={clsx('size-5 text-warning', className)} />;
}

/** Where an alert is about, as a link. */
function Subject({ alert }: { alert: Alert }) {
  const { t } = useTranslation();
  if (alert.stationId) return <Link className="font-semibold text-accent-text hover:underline" to={`/stations/${alert.stationId}`}>{t('monitoring.openStation')}</Link>;
  if (alert.nodeId && (alert.kind === 'port_closed' || alert.kind === 'old_port_open'))
    return <Link className="font-semibold text-accent-text hover:underline" to={`/nodes/${alert.nodeId}?tab=firewall`}>{t('firewall.title')}</Link>;
  if (alert.nodeId) return <Link className="font-semibold text-accent-text hover:underline" to={`/nodes/${alert.nodeId}`}>{t('monitoring.openNode')}</Link>;
  if (alert.kind === 'dns_error' || alert.kind === 'dns_wrong') return <Link className="font-semibold text-accent-text hover:underline" to="/settings/dns">{t('nav.dns')}</Link>;
  if (alert.kind === 'updates_paused') return <Link className="font-semibold text-accent-text hover:underline" to="/nodes">{t('monitoring.openUpdates')}</Link>;
  return null;
}

function OpenAlerts({ alerts }: { alerts: Alert[] | undefined }) {
  const { t, i18n } = useTranslation();
  const title = useAlertTitle();
  const qc = useQueryClient();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['alerts'] });
  };
  const ack = useMutation({ mutationFn: (id: string) => api<Alert>(`/alerts/${id}/acknowledge`, { method: 'POST' }), onSuccess: refresh, onError: (err) => toast.error((err as Error).message) });
  const mute = useMutation({
    mutationFn: (a: Alert) => api<Maintenance[]>('/alerts/maintenance', { method: 'POST', body: a.stationId && a.kind !== 'feed_lost' ? { kind: 'station', id: a.stationId, minutes: 60 } : { kind: 'node', id: a.nodeId, minutes: 60 } }),
    onSuccess: () => {
      toast.success(t('monitoring.mutedHour'));
      refresh();
    },
    onError: (err) => toast.error((err as Error).message),
  });
  return (
    <Card>
      <CardHeader title={t('monitoring.openTitle')} description={t('monitoring.openSubtitle')} />
      {!alerts ? (
        <div className="grid place-items-center py-10">
          <Spinner />
        </div>
      ) : !alerts.length ? (
        <EmptyState icon={<CheckCircle2 className="size-6 text-online" />} title={t('monitoring.allGood')} description={t('monitoring.allGoodHint')} />
      ) : (
        <ul className="flex flex-col divide-y divide-line">
          {alerts.map((a) => (
            <li key={a.id} className="flex flex-wrap items-start gap-3 px-5 py-3.5">
              <SeverityIcon alert={a} className="mt-0.5 shrink-0" />
              <div className="min-w-0 flex-1 basis-60">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{title(a)}</span>
                  <Badge tone={a.severity === 'critical' ? 'offline' : 'warning'}>{t(`monitoring.severity.${a.severity}`)}</Badge>
                  {a.acknowledgedAt && (
                    <Badge tone="neutral">
                      <Eye className="size-3" /> {t('monitoring.seenBy', { who: a.acknowledgedBy ?? '' })}
                    </Badge>
                  )}
                </div>
                {a.message && <p className="mt-0.5 text-[13px] break-words text-muted">{a.message}</p>}
                <p className="mt-1 text-xs text-muted">
                  {t('monitoring.since', { time: new Date(a.openedAt).toLocaleTimeString(i18n.language, { hour: '2-digit', minute: '2-digit' }), duration: span(a.openedAt, null) })}
                  {!a.notified && <> · {t('monitoring.notSent')}</>} · <Subject alert={a} />
                </p>
              </div>
              <div className="flex flex-wrap gap-2 pl-8 sm:pl-0">
                {!a.acknowledgedAt && (
                  <Button size="sm" variant="secondary" loading={ack.isPending && ack.variables === a.id} onClick={() => ack.mutate(a.id)}>
                    <Eye className="size-4" /> {t('monitoring.acknowledge')}
                  </Button>
                )}
                {(a.nodeId || a.stationId) && (
                  <Button size="sm" variant="ghost" title={t('monitoring.muteHint')} loading={mute.isPending && mute.variables?.id === a.id} onClick={() => mute.mutate(a)}>
                    <Wrench className="size-4" /> {t('monitoring.muteHour')}
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

const DURATIONS = [60, 240, 1440, 0] as const;

function MaintenanceCard({ maintenance, nodes, stations }: { maintenance: Maintenance[]; nodes: NodeItem[]; stations: StationListItem[] }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [target, setTarget] = useState('');
  const [minutes, setMinutes] = useState<number>(60);
  const done = () => {
    void qc.invalidateQueries({ queryKey: ['alerts'] });
  };
  const add = useMutation({
    mutationFn: () => {
      const [kind, id] = target.split(':');
      return api<Maintenance[]>('/alerts/maintenance', { method: 'POST', body: { kind, id, minutes: minutes || null } });
    },
    onSuccess: () => {
      setTarget('');
      done();
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const end = useMutation({ mutationFn: (m: Maintenance) => api<Maintenance[]>(`/alerts/maintenance/${m.kind}/${m.id}`, { method: 'DELETE' }), onSuccess: done, onError: (err) => toast.error((err as Error).message) });
  const name = (m: Maintenance) => (m.kind === 'node' ? nodes.find((n) => n.id === m.id)?.name : stations.find((s) => s.id === m.id)?.name) ?? m.id.slice(0, 8);
  const active = maintenance.filter((m) => !m.until || new Date(m.until).getTime() > Date.now());
  return (
    <Card>
      <CardHeader title={t('monitoring.maintenanceTitle')} description={t('monitoring.maintenanceSubtitle')} />
      <div className="flex flex-col gap-4 p-5">
        {active.length > 0 && (
          <ul className="flex flex-col gap-2">
            {active.map((m) => (
              <li key={`${m.kind}:${m.id}`} className="flex items-center gap-3 rounded-md bg-chip/60 px-3 py-2 text-[13px]">
                <Wrench className="size-4 shrink-0 text-muted" />
                <span className="min-w-0 flex-1">
                  <span className="font-semibold">{name(m)}</span>{' '}
                  <span className="text-muted">
                    · {m.until ? t('monitoring.until', { when: formatDate(m.until) }) : t('monitoring.untilEnded')}
                    {m.by && <> · {m.by}</>}
                  </span>
                </span>
                <Button size="sm" variant="ghost" loading={end.isPending && end.variables?.id === m.id} onClick={() => end.mutate(m)}>
                  <X className="size-4" /> {t('monitoring.end')}
                </Button>
              </li>
            ))}
          </ul>
        )}
        <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto]">
          <Select value={target} onChange={(e) => setTarget(e.target.value)} aria-label={t('monitoring.what')}>
            <option value="">{t('monitoring.pick')}</option>
            <optgroup label={t('nav.nodes')}>
              {nodes
                .filter((n) => n.paired)
                .map((n) => (
                  <option key={n.id} value={`node:${n.id}`}>
                    {n.name}
                  </option>
                ))}
            </optgroup>
            <optgroup label={t('nav.stations')}>
              {stations.map((s) => (
                <option key={s.id} value={`station:${s.id}`}>
                  {s.name}
                </option>
              ))}
            </optgroup>
          </Select>
          <Select value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} aria-label={t('monitoring.howLong')}>
            {DURATIONS.map((d) => (
              <option key={d} value={d}>
                {t(`monitoring.durations.${d}`)}
              </option>
            ))}
          </Select>
          <Button variant="secondary" disabled={!target} loading={add.isPending} onClick={() => add.mutate()}>
            <Wrench className="size-4" /> {t('monitoring.start')}
          </Button>
        </div>
      </div>
    </Card>
  );
}

function History({ alerts }: { alerts: Alert[] | undefined }) {
  const { t } = useTranslation();
  const title = useAlertTitle();
  return (
    <Card>
      <CardHeader title={t('monitoring.historyTitle')} description={t('monitoring.historySubtitle')} />
      <Table head={[t('monitoring.cols.problem'), t('monitoring.cols.started'), t('monitoring.cols.duration')]} empty={alerts && !alerts.length ? <p className="px-4 py-6 text-center text-[13px] text-muted">{t('monitoring.noHistory')}</p> : undefined}>
        {(alerts ?? []).map((a) => (
          <tr key={a.id}>
            <td>
              <span className="flex items-center gap-2">
                {a.severity === 'critical' ? <XCircle className="size-4 shrink-0 text-offline" /> : <AlertTriangle className="size-4 shrink-0 text-warning" />}
                <span className="min-w-0">
                  <span className="block truncate font-semibold">{title(a)}</span>
                  {a.message && <span className="block truncate text-xs text-muted">{a.message}</span>}
                </span>
              </span>
            </td>
            <td className="text-[13px] whitespace-nowrap text-muted">{formatDate(a.openedAt)}</td>
            <td className="font-mono text-[13px] whitespace-nowrap">{span(a.openedAt, a.resolvedAt)}</td>
          </tr>
        ))}
      </Table>
    </Card>
  );
}

function DeliveryLine({ results }: { results: AlertDelivery[] }) {
  const { t } = useTranslation();
  if (!results.length) return null;
  return (
    <ul className="flex flex-col gap-1">
      {results.map((r) => (
        <li key={r.channel} className={clsx('flex items-start gap-1.5 text-xs', r.ok ? 'text-online' : 'text-offline')}>
          {r.ok ? <CheckCircle2 className="mt-px size-3.5 shrink-0" /> : <XCircle className="mt-px size-3.5 shrink-0" />}
          <span>
            {t(`monitoring.channels.${r.channel}`)}: {r.ok ? t('monitoring.delivered') : r.error}
            {r.at && <span className="text-muted"> · {formatRelative(r.at)}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

function SettingsForm({ settings, stations }: { settings: AlertSettings; stations: StationListItem[] }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [draft, setDraft] = useState(settings);
  const [emails, setEmails] = useState(settings.email.to.join(', '));
  const [chats, setChats] = useState<TelegramChat[] | null>(null);
  const [tested, setTested] = useState<AlertDelivery[]>([]);
  useEffect(() => {
    setDraft((d) => ({ ...d, mailReady: settings.mailReady, lastDelivery: settings.lastDelivery, maintenance: settings.maintenance }));
  }, [settings]);
  const set = (patch: Partial<AlertSettings>) => setDraft({ ...draft, ...patch });
  const body = (): AlertSettings => ({ ...draft, email: { ...draft.email, to: emails.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean) } });

  const save = useMutation({
    mutationFn: () => api<AlertSettings>('/alerts/settings', { method: 'PUT', body: body() }),
    onSuccess: (res) => {
      qc.setQueryData(['alerts', 'settings'], res);
      setDraft(res);
      setEmails(res.email.to.join(', '));
      toast.success(t('monitoring.saved'));
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const test = useMutation({
    mutationFn: async () => {
      const res = await api<AlertSettings>('/alerts/settings', { method: 'PUT', body: body() });
      qc.setQueryData(['alerts', 'settings'], res);
      setDraft(res);
      return api<AlertDelivery[]>('/alerts/test', { method: 'POST' });
    },
    onSuccess: (res) => setTested(res),
    onError: (err) => toast.error((err as Error).message),
  });
  const findChats = useMutation({
    mutationFn: () => api<TelegramChat[]>('/alerts/telegram/chats', { method: 'POST', body: { botToken: draft.telegram.botToken } }),
    onSuccess: (res) => {
      setChats(res);
      if (res.length === 1) set({ telegram: { ...draft.telegram, chatId: res[0]!.id } });
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };
  const quiet = new Set(draft.quietStations);

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <Card>
        <CardHeader title={t('monitoring.channelsTitle')} description={t('monitoring.channelsSubtitle')} />
        <div className="flex flex-col gap-5 p-5">
          <div className="flex flex-col gap-3">
            <Switch
              checked={draft.telegram.enabled}
              onChange={(enabled) => set({ telegram: { ...draft.telegram, enabled } })}
              label={
                <span className="inline-flex items-center gap-1.5">
                  <MessageCircle className="size-4 text-koraal" /> Telegram
                </span>
              }
              description={t('monitoring.telegramHint')}
            />
            {draft.telegram.enabled && (
              <>
                <ol className="flex list-decimal flex-col gap-1 rounded-md bg-chip/60 py-2 pr-3 pl-8 text-xs text-muted">
                  <li>{t('monitoring.telegramStep1')}</li>
                  <li>{t('monitoring.telegramStep2')}</li>
                  <li>{t('monitoring.telegramStep3')}</li>
                </ol>
                <Field label={t('monitoring.botToken')}>
                  <Input type="password" autoComplete="off" value={draft.telegram.botToken} placeholder="123456789:AA…" onChange={(e) => set({ telegram: { ...draft.telegram, botToken: e.target.value.trim() } })} />
                </Field>
                <Field label={t('monitoring.chatId')} hint={t('monitoring.chatIdHint')}>
                  <div className="flex gap-2">
                    <Input value={draft.telegram.chatId} placeholder="123456789" onChange={(e) => set({ telegram: { ...draft.telegram, chatId: e.target.value.trim() } })} />
                    <Button type="button" variant="secondary" loading={findChats.isPending} disabled={!draft.telegram.botToken} onClick={() => findChats.mutate()}>
                      <Search className="size-4" /> {t('monitoring.findChat')}
                    </Button>
                  </div>
                </Field>
                {chats &&
                  (chats.length ? (
                    <div className="flex flex-wrap gap-2">
                      {chats.map((c) => (
                        <button
                          key={c.id}
                          type="button"
                          onClick={() => set({ telegram: { ...draft.telegram, chatId: c.id } })}
                          className={clsx('rounded-full border px-3 py-1 text-[13px]', draft.telegram.chatId === c.id ? 'border-koraal bg-koraal/10' : 'border-line hover:bg-hover')}
                        >
                          {c.name} <span className="font-mono text-xs text-muted">{c.id}</span>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-warning">{t('monitoring.noChats')}</p>
                  ))}
              </>
            )}
          </div>
          <div className="flex flex-col gap-3 border-t border-line pt-4">
            <Switch
              checked={draft.email.enabled}
              onChange={(enabled) => set({ email: { ...draft.email, enabled } })}
              label={
                <span className="inline-flex items-center gap-1.5">
                  <Mail className="size-4 text-koraal" /> {t('monitoring.channels.email')}
                </span>
              }
              description={t('monitoring.emailHint')}
            />
            {draft.email.enabled && (
              <>
                <Field label={t('monitoring.recipients')} hint={t('monitoring.recipientsHint')}>
                  <Input value={emails} placeholder="reinder@example.com" onChange={(e) => setEmails(e.target.value)} />
                </Field>
                {!settings.mailReady && (
                  <p className="rounded-md bg-warning/10 px-3 py-2 text-xs text-warning">
                    {t('monitoring.mailNotReady')}{' '}
                    <Link className="font-semibold underline" to="/settings/mail">
                      {t('nav.mail')}
                    </Link>
                  </p>
                )}
              </>
            )}
          </div>
          <p className="flex items-start gap-2 border-t border-line pt-4 text-xs text-muted">
            <Webhook className="mt-px size-4 shrink-0" />
            <span>
              {t('monitoring.webhookHint')}{' '}
              <Link className="font-semibold text-accent-text hover:underline" to="/settings/webhooks">
                {t('nav.webhooks')}
              </Link>
            </span>
          </p>
          <div className="flex flex-col gap-2">
            <div>
              <Button type="button" variant="secondary" loading={test.isPending} disabled={!draft.telegram.enabled && !draft.email.enabled} onClick={() => test.mutate()}>
                <Send className="size-4" /> {t('monitoring.sendTest')}
              </Button>
            </div>
            <DeliveryLine results={tested.length ? tested : settings.lastDelivery} />
          </div>
        </div>
      </Card>
      <Card>
        <CardHeader title={t('monitoring.rulesTitle')} description={t('monitoring.rulesSubtitle')} />
        <div className="flex flex-col gap-4 p-5">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('monitoring.grace')} hint={t('monitoring.graceHint')}>
              <Input type="number" min={15} max={3600} value={draft.graceSeconds} onChange={(e) => set({ graceSeconds: Number(e.target.value) })} />
            </Field>
            <Field label={t('monitoring.recover')} hint={t('monitoring.recoverHint')}>
              <Input type="number" min={15} max={3600} value={draft.recoverSeconds} onChange={(e) => set({ recoverSeconds: Number(e.target.value) })} />
            </Field>
          </div>
          <Segmented
            value={draft.minSeverity}
            onChange={(minSeverity) => set({ minSeverity })}
            options={(['warning', 'critical'] as const).map((s) => ({ value: s, label: t(`monitoring.minSeverity.${s}`), description: t(`monitoring.minSeverityHint.${s}`) }))}
          />
          <Switch checked={draft.notifyRecovery} onChange={(notifyRecovery) => set({ notifyRecovery })} label={t('monitoring.notifyRecovery')} description={t('monitoring.notifyRecoveryHint')} />
          <Field label={t('monitoring.language')}>
            <Select value={draft.language} onChange={(e) => set({ language: e.target.value as AlertSettings['language'] })}>
              <option value="en">English</option>
              <option value="nl">Nederlands</option>
            </Select>
          </Field>
        </div>
      </Card>
      {stations.length > 0 && (
        <Card>
          <CardHeader title={t('monitoring.stationsTitle')} description={t('monitoring.stationsSubtitle')} />
          <div className="flex flex-col gap-3 p-5">
            {stations.map((s) => (
              <Switch
                key={s.id}
                checked={!quiet.has(s.id)}
                onChange={(on) => set({ quietStations: on ? draft.quietStations.filter((id) => id !== s.id) : [...draft.quietStations, s.id] })}
                label={s.name}
                description={quiet.has(s.id) ? t('monitoring.stationQuiet') : t('monitoring.stationWatched')}
              />
            ))}
          </div>
        </Card>
      )}
      <div className="flex justify-end">
        <Button type="submit" variant="primary" loading={save.isPending}>
          <Save className="size-4" /> {t('common.save')}
        </Button>
      </div>
    </form>
  );
}

/**
 * Monitoring (phase 20): what is wrong now, maintenance, the history, and where alerts go. The orchestrator checks
 * every 15 seconds; a problem becomes an alert after the wait time and is solved after it has been gone for a while.
 */
export function MonitoringPage() {
  const { t } = useTranslation();
  const open = useQuery({ queryKey: ['alerts', 'open'], queryFn: () => api<Alert[]>('/alerts?state=open'), refetchInterval: 15_000 });
  const history = useQuery({ queryKey: ['alerts', 'resolved'], queryFn: () => api<Alert[]>('/alerts?state=resolved&limit=50'), refetchInterval: 60_000 });
  const settings = useQuery({ queryKey: ['alerts', 'settings'], queryFn: () => api<AlertSettings>('/alerts/settings'), refetchInterval: 30_000 });
  const nodes = useQuery({ queryKey: ['nodes', 'all'], queryFn: () => api<NodeItem[]>('/nodes') });
  const stations = useQuery({ queryKey: ['stations', 'all'], queryFn: () => api<StationListItem[]>('/stations') });
  const critical = open.data?.filter((a) => a.severity === 'critical').length ?? 0;
  const channels = settings.data ? [settings.data.telegram.enabled && 'Telegram', settings.data.email.enabled && t('monitoring.channels.email')].filter(Boolean) : [];

  return (
    <>
      <PageHeader title={t('monitoring.title')} description={t('monitoring.subtitle')} />
      <Card className={clsx('mb-4 flex flex-wrap items-center gap-4 p-5', open.data?.length && (critical ? 'border-offline/50' : 'border-warning/50'))}>
        <span className={clsx('grid size-11 place-items-center rounded-full', !open.data?.length ? 'bg-online/15 text-online' : critical ? 'bg-offline/15 text-offline' : 'bg-warning/15 text-warning')}>
          {!open.data?.length ? <CheckCircle2 className="size-6" /> : <BellRing className="size-6" />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="display text-lg">{!open.data ? '…' : !open.data.length ? t('monitoring.statusOk') : t('monitoring.statusProblems', { count: open.data.length })}</div>
          <div className="text-[13px] text-muted">{channels.length ? t('monitoring.goesTo', { channels: channels.join(', ') }) : t('monitoring.noChannels')}</div>
        </div>
      </Card>
      <div className="grid gap-4 xl:grid-cols-[1.25fr_1fr]">
        <div className="flex min-w-0 flex-col gap-4">
          <OpenAlerts alerts={open.data} />
          <MaintenanceCard maintenance={settings.data?.maintenance ?? []} nodes={nodes.data ?? []} stations={stations.data ?? []} />
          <History alerts={history.data} />
        </div>
        <div className="min-w-0">
          {settings.data ? (
            <SettingsForm settings={settings.data} stations={stations.data ?? []} />
          ) : (
            <div className="grid place-items-center py-20">
              <Spinner />
            </div>
          )}
        </div>
      </div>
    </>
  );
}
