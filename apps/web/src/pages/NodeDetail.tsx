import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { AlertTriangle, ArrowLeft, ArrowUpCircle, CheckCircle2, KeyRound, Link2Off, Radio, Trash2, XCircle } from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { formatBps, formatMs, formatPct, formatUptime, HealthBadge, nodeHealth, PairingPanel, RoleBadges } from '../components/nodes/common';
import { FmOnAir, FmSettingsCards } from '../components/nodes/FmPanel';
import { AreaChart, ChartLegend } from '../components/stats/charts';
import { Badge, Button, Card, CardHeader, Dialog, EmptyState, Fact, Field, Input, PageHeader, Spinner, Switch, Table, Tabs } from '../components/ui';
import i18n from '../i18n';
import { api, type NodeEvent, type NodeItem, type NodeMetric, type NodePairing, type NodeProbe, type NodeRole, type StationListItem } from '../lib/api';
import { isAdmin, useMe } from '../lib/auth';
import { formatDate, formatRelative, shortCommit } from '../lib/format';
import { RolePicker } from './Nodes';

type Tab = 'overview' | 'probes' | 'events' | 'settings';
const PERIODS = [1, 24, 24 * 7, 24 * 30] as const;

const timeFormat = (hours: number) => (iso: string) =>
  new Intl.DateTimeFormat(i18n.language, hours > 48 ? { day: 'numeric', month: 'short' } : { hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
const tooltipFormat = (iso: string) => new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));

function Kpi({ label, value, note, tone }: { label: string; value: ReactNode; note?: ReactNode; tone?: 'warning' | 'online' | 'offline' }) {
  return (
    <Card className="px-4 py-3">
      <div className="text-[11.5px] text-muted">{label}</div>
      <div className="display text-xl tabular-nums">{value}</div>
      {note && <div className={clsx('mt-0.5 text-[11px] font-semibold', tone === 'warning' ? 'text-warning' : tone === 'offline' ? 'text-offline' : tone === 'online' ? 'text-online' : 'text-muted')}>{note}</div>}
    </Card>
  );
}

function ChartCard({ title, children, legend }: { title: string; children: ReactNode; legend?: ReactNode }) {
  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-2 px-5 pt-4">
        <h3 className="text-sm font-semibold">{title}</h3>
        {legend}
      </div>
      <div className="px-3 pt-2 pb-3">{children}</div>
    </Card>
  );
}

function Charts({ node }: { node: NodeItem }) {
  const { t } = useTranslation();
  const [hours, setHours] = useState<number>(24);
  const metrics = useQuery({ queryKey: ['nodes', node.id, 'metrics', hours], queryFn: () => api<NodeMetric[]>(`/nodes/${node.id}/metrics?hours=${hours}`), refetchInterval: 60_000 });
  const rows = metrics.data ?? [];
  const fmt = timeFormat(hours);
  const common = { formatTime: fmt, formatTooltipTime: tooltipFormat, empty: t('nodes.detail.noMetrics'), height: 200 };
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="display text-base">{t('nodes.detail.health')}</h2>
        <div className="flex rounded-md border border-line bg-raised p-0.5">
          {PERIODS.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setHours(p)}
              className={clsx('h-8 rounded-[7px] px-3 text-[13px] font-semibold', hours === p ? 'bg-[var(--nav-active-bg)] text-[var(--nav-active-ink)]' : 'text-muted hover:bg-hover')}
            >
              {t(`nodes.detail.periods.${p}`)}
            </button>
          ))}
        </div>
      </div>
      {metrics.isPending ? (
        <div className="grid place-items-center py-10">
          <Spinner />
        </div>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          <ChartCard title={t('nodes.detail.latencyChart')} legend={<ChartLegend label={t('nodes.detail.average')} label2={t('nodes.detail.highest')} />}>
            <AreaChart {...common} points={rows.map((r) => ({ t: r.at, value: r.rttAvg ?? 0, value2: r.rttMax ?? 0 }))} label={t('nodes.detail.average')} label2={t('nodes.detail.highest')} />
          </ChartCard>
          <ChartCard title={t('nodes.detail.lossChart')}>
            <AreaChart {...common} points={rows.map((r) => ({ t: r.at, value: r.pings ? Math.round((r.lost / r.pings) * 1000) / 10 : 0 }))} label={t('nodes.detail.lossPct')} />
          </ChartCard>
          <ChartCard title={t('nodes.detail.listenersChart')}>
            <AreaChart {...common} points={rows.map((r) => ({ t: r.at, value: r.listeners ?? 0 }))} label={t('nodes.cols.listeners')} />
          </ChartCard>
          <ChartCard title={t('nodes.detail.trafficChart')} legend={<ChartLegend label={t('nodes.detail.outgoing')} label2={t('nodes.detail.incoming')} />}>
            <AreaChart
              {...common}
              points={rows.map((r) => ({ t: r.at, value: Math.round(((r.txBps ?? 0) * 8) / 10_000) / 100, value2: Math.round(((r.rxBps ?? 0) * 8) / 10_000) / 100 }))}
              label={t('nodes.detail.outgoingMbps')}
              label2={t('nodes.detail.incomingMbps')}
            />
          </ChartCard>
          <ChartCard title={t('nodes.detail.loadChart')} legend={<ChartLegend label={t('nodes.detail.cpu')} label2={t('nodes.detail.memory')} />}>
            <AreaChart {...common} points={rows.map((r) => ({ t: r.at, value: Math.round((r.cpu ?? 0) * 100), value2: Math.round((r.memory ?? 0) * 100) }))} label={t('nodes.detail.cpu')} label2={t('nodes.detail.memory')} />
          </ChartCard>
        </div>
      )}
    </div>
  );
}

const relayTone = { connected: 'online', connecting: 'warning', idle: 'neutral', error: 'offline' } as const;

/** Stations a station node runs or is taking over (phase 12). */
function NodeStations({ node }: { node: NodeItem }) {
  const { t } = useTranslation();
  const stations = useQuery({ queryKey: ['stations', 'all'], queryFn: () => api<StationListItem[]>('/stations'), refetchInterval: 10_000 });
  const mine = (stations.data ?? []).filter((s) => s.nodeId === node.id || s.nodeMove?.nodeId === node.id);
  return (
    <Card>
      <CardHeader title={t('nodes.detail.stationsTitle')} description={t('nodes.detail.stationsHint')} />
      {!mine.length ? (
        <div className="px-5 py-8 text-center text-[13px] text-muted">{t('nodes.detail.noNodeStations')}</div>
      ) : (
        <Table head={[t('nav.stations'), t('fields.status'), t('nodes.detail.lastReport'), t('nodes.cols.listeners')]}>
          {mine.map((s) => {
            const m = s.nodeMove;
            const pct = m && m.bytes ? Math.round((m.bytesDone / m.bytes) * 100) : null;
            return (
              <tr key={s.id}>
                <td>
                  <Link to={`/stations/${s.id}`} className="font-semibold hover:underline">
                    {s.name}
                  </Link>
                  <div className="text-xs text-muted">{s.tenantName}</div>
                </td>
                <td>
                  {m ? (
                    <Badge tone={m.state === 'failed' ? 'offline' : 'accent'} dot>
                      {m.state === 'failed' ? t('nodes.detail.moveFailed') : m.direction === 'to_node' ? t('nodes.detail.movingHere', { pct: pct ?? 0 }) : t('nodes.detail.movingAway', { pct: pct ?? 0 })}
                    </Badge>
                  ) : (
                    <Badge tone={s.nodeOnline ? 'online' : 'warning'} dot>
                      {s.nodeOnline ? t('nodes.detail.runsHere') : t('nodes.detail.runsHereOffline')}
                    </Badge>
                  )}
                  {m?.message && <div className="mt-1 text-xs text-muted">{m.message}</div>}
                </td>
                <td className="text-[13px] text-muted">{s.nodeSeenAt ? formatRelative(s.nodeSeenAt) : '—'}</td>
                <td className="text-[13px] tabular-nums">{s.listeners ?? '—'}</td>
              </tr>
            );
          })}
        </Table>
      )}
    </Card>
  );
}

function Overview({ node, warnMs }: { node: NodeItem; warnMs: number }) {
  const { t } = useTranslation();
  const s = node.status;
  const relays = s.relays ?? [];
  return (
    <div className="flex flex-col gap-4">
      {!!s.problems?.length && (
        <Card className="border-warning/50">
          <div className="flex gap-3 px-5 py-4">
            <AlertTriangle className="mt-0.5 size-5 shrink-0 text-warning" />
            <div>
              <div className="text-sm font-semibold">{t('nodes.detail.problems')}</div>
              <ul className="mt-1 list-disc pl-4 text-[13px] text-muted">
                {s.problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </div>
          </div>
        </Card>
      )}
      {/* An FM node is about what it has on air: that comes first. */}
      {node.roles.includes('fm') && <FmOnAir node={node} />}
      <div className="grid gap-4 xl:grid-cols-[1.4fr_1fr]">
        <Card>
          <CardHeader title={t('nodes.detail.machine')} />
          <div className="grid grid-cols-2 gap-x-6 gap-y-4 p-5 sm:grid-cols-3">
            <Fact label={t('nodes.detail.hostname')}>{s.hostname || '—'}</Fact>
            <Fact label={t('nodes.detail.connectsFrom')}>{s.ip || '—'}</Fact>
            <Fact label={t('nodes.detail.place')}>{[s.city, s.country].filter(Boolean).join(', ') || '—'}</Fact>
            <Fact label={t('nodes.detail.version')}>
              {s.version ? `v${s.version}` : '—'} <span className="font-mono text-xs text-muted">{shortCommit(s.commit)}</span>
            </Fact>
            <Fact label={t('nodes.detail.cores')}>{s.cores ?? '—'}</Fact>
            <Fact label={t('nodes.detail.uptime')}>{formatUptime(s.uptime)}</Fact>
            <Fact label={t('nodes.detail.webServer')}>{s.caddy == null ? '—' : s.caddy ? t('nodes.detail.caddy') : t('nodes.detail.direct')}</Fact>
            <Fact label={t('nodes.detail.lastSeen')}>{s.online ? t('nodes.detail.now') : formatRelative(node.lastSeenAt)}</Fact>
            <Fact label={t('nodes.detail.icmp')}>{s.icmp ? `${formatMs(s.icmp.rttMs)} · ${formatPct(s.icmp.loss, 0)}` : '—'}</Fact>
            {node.listenBase && (
              <div className="col-span-2 sm:col-span-3">
                <Fact label={t('nodes.detail.listenBase')}>
                  <span className="font-mono text-[13px]">{node.listenBase}</span>
                </Fact>
              </div>
            )}
            {!!node.ingestHosts.length && (
              <div className="col-span-2 sm:col-span-3">
                <Fact label={t('nodes.detail.ingestHosts')}>
                  <span className="font-mono text-[13px]">{node.ingestHosts.join(', ')}</span>
                </Fact>
              </div>
            )}
          </div>
        </Card>
        <Card>
          <CardHeader title={t('nodes.detail.connection')} description={t('nodes.detail.connectionHint')} />
          <div className="flex flex-col divide-y divide-line px-5 text-[13px]">
            {[
              [t('nodes.detail.latency'), formatMs(s.online ? s.rttMs : null), s.online && (s.rttMs ?? 0) > warnMs],
              [t('nodes.detail.loss5m'), s.online ? formatPct(s.loss ?? 0, 1) : '—', (s.loss ?? 0) > 0.05],
              [t('nodes.detail.timeouts24h'), String(s.timeouts24h ?? 0), (s.timeouts24h ?? 0) > 0],
              [t('nodes.detail.encoders'), String(s.encoders ?? 0), false],
              [t('nodes.detail.update'), s.update ? `${t(`nodes.updateState.${s.update.state}`)}${s.update.message ? ` · ${s.update.message}` : ''}` : '—', s.update?.state === 'failed'],
            ].map(([label, value, warn]) => (
              <div key={String(label)} className="flex justify-between gap-4 py-2.5">
                <span className="text-muted">{label}</span>
                <span className={clsx('text-right font-semibold', warn && 'text-warning')}>{value}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>
      {node.roles.includes('relay') && (
        <Card>
          <CardHeader title={t('nodes.detail.relayed')} description={t('nodes.detail.relayedHint')} />
          {!relays.length ? (
            <div className="px-5 py-8 text-center text-[13px] text-muted">{s.online ? t('nodes.detail.noRelays') : t('nodes.detail.offlineRelays')}</div>
          ) : (
            <Table head={[t('nodes.detail.mount'), t('fields.status'), t('nodes.detail.bitrate'), t('nodes.cols.listeners')]}>
              {relays.map((r) => (
                <tr key={r.key}>
                  <td className="font-mono text-[13px]">/{r.key}</td>
                  <td title={r.message}>
                    <Badge tone={relayTone[r.state]} dot>
                      {t(`nodes.relayState.${r.state}`)}
                    </Badge>
                    {r.message && r.state !== 'connected' && <span className="ml-2 text-xs text-muted">{r.message}</span>}
                  </td>
                  <td className="text-[13px] tabular-nums">{r.bitrateKbps ? `${r.bitrateKbps} kbps` : '—'}</td>
                  <td className="text-[13px] tabular-nums">{r.listeners ?? 0}</td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      )}
      {node.roles.includes('station') && <NodeStations node={node} />}
      <Charts node={node} />
    </div>
  );
}

function Probes({ node }: { node: NodeItem }) {
  const { t } = useTranslation();
  const probes = useQuery({ queryKey: ['nodes', node.id, 'probes'], queryFn: () => api<NodeProbe[]>(`/nodes/${node.id}/probes`), refetchInterval: 30_000 });
  return (
    <Card>
      <CardHeader title={t('nodes.probes.title')} description={t('nodes.probes.subtitle')} />
      {probes.isPending ? (
        <div className="grid place-items-center py-10">
          <Spinner />
        </div>
      ) : !probes.data?.length ? (
        <EmptyState icon={<Radio className="size-5" />} title={t('nodes.probes.empty')} description={node.config.probe ? t('nodes.probes.emptyText') : t('nodes.probes.off')} />
      ) : (
        <Table head={[t('nodes.probes.station'), t('nodes.probes.checked'), t('fields.status'), t('nodes.probes.ttfb'), t('nodes.probes.uptime'), t('nodes.probes.when')]}>
          {probes.data.map((p) => (
            <tr key={p.target}>
              <td>
                <div className="text-[13px] font-semibold">{p.stationName}</div>
                <div className="max-w-xs truncate font-mono text-[11px] text-muted" title={p.url}>
                  {p.url}
                </div>
              </td>
              <td className="text-[13px]">{p.where === 'main' ? t('nodes.probes.main') : p.whereName}</td>
              <td title={p.message ?? undefined}>
                {p.ok ? (
                  <span className="inline-flex items-center gap-1 text-[13px] font-semibold text-online">
                    <CheckCircle2 className="size-4" /> {t('nodes.probes.ok')}
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-[13px] font-semibold text-offline">
                    <XCircle className="size-4" /> {p.httpStatus ? `HTTP ${p.httpStatus}` : (p.message ?? t('nodes.probes.down'))}
                  </span>
                )}
              </td>
              <td className="text-[13px] tabular-nums">{formatMs(p.ttfbMs)}</td>
              <td className={clsx('text-[13px] tabular-nums', p.uptime24h != null && p.uptime24h < 0.99 && 'font-semibold text-warning')}>{formatPct(p.uptime24h, 2)}</td>
              <td className="text-xs text-muted">{formatRelative(p.checkedAt)}</td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
}

const levelTone = { info: 'neutral', warning: 'warning', error: 'offline' } as const;

export function eventText(t: (k: string, o?: Record<string, unknown>) => string, e: Pick<NodeEvent, 'kind' | 'details'>) {
  const d = Object.fromEntries(Object.entries(e.details).map(([k, v]) => [k, v ?? '—']));
  return t(`nodes.events.${e.kind}`, { ...d, defaultValue: e.kind.replace(/_/g, ' ') });
}

function Events({ node }: { node: NodeItem }) {
  const { t } = useTranslation();
  const events = useQuery({ queryKey: ['nodes', node.id, 'events'], queryFn: () => api<NodeEvent[]>(`/nodes/${node.id}/events?limit=200`), refetchInterval: 15_000 });
  return (
    <Card>
      <CardHeader title={t('nodes.events.title')} description={t('nodes.events.subtitle')} />
      {events.isPending ? (
        <div className="grid place-items-center py-10">
          <Spinner />
        </div>
      ) : (
        <Table head={[t('nodes.events.time'), t('nodes.events.what'), t('nodes.events.level')]}>
          {(events.data ?? []).map((e) => (
            <tr key={e.id}>
              <td className="text-xs whitespace-nowrap text-muted">{formatDate(e.at)}</td>
              <td className="text-[13px]">{eventText(t, e)}</td>
              <td>
                <Badge tone={levelTone[e.level] ?? 'neutral'}>{t(`nodes.events.levels.${e.level}`, { defaultValue: e.level })}</Badge>
              </td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
}

function SettingsForm({ node }: { node: NodeItem }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const stations = useQuery({ queryKey: ['stations', 'all'], queryFn: () => api<StationListItem[]>('/stations') });
  const [name, setName] = useState(node.name);
  const [location, setLocation] = useState(node.location);
  const [roles, setRoles] = useState<NodeRole[]>(node.roles);
  const [c, setC] = useState(node.config);
  useEffect(() => {
    setName(node.name);
    setLocation(node.location);
    setRoles(node.roles);
    setC(node.config);
    // Only when another node is opened; refetches every few seconds would undo the edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.id]);
  const pick = useMemo(() => (stations.data ?? []).filter((s) => !node.tenantId || s.tenantId === node.tenantId), [stations.data, node.tenantId]);
  const save = useMutation({
    mutationFn: () => api<NodeItem>(`/nodes/${node.id}`, { method: 'PATCH', body: { name, location, roles, config: c } }),
    onSuccess: (res) => {
      qc.setQueryData(['nodes', node.id], res);
      void qc.invalidateQueries({ queryKey: ['nodes'] });
      toast.success(t('nodes.detail.saved'));
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };
  const set = (patch: Partial<typeof c>) => setC({ ...c, ...patch });
  const port = (v: string) => (v.trim() ? Number(v) : null);
  const selected = c.relayStations === 'all' ? null : new Set(c.relayStations);
  const caddy = node.status.caddy;

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <Card>
        <CardHeader title={t('nodes.detail.general')} />
        <div className="flex flex-col gap-4 p-5">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('nodes.fields.name')}>
              <Input required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label={t('nodes.fields.location')} hint={t('nodes.fields.locationHint')}>
              <Input maxLength={80} value={location} onChange={(e) => setLocation(e.target.value)} />
            </Field>
          </div>
          <Field label={t('nodes.fields.roles')} hint={t('nodes.fields.rolesHint')}>
            <RolePicker value={roles} onChange={setRoles} />
          </Field>
          <Switch checked={c.probe} onChange={(probe) => set({ probe })} label={t('nodes.fields.probe')} description={t('nodes.fields.probeHint')} />
        </div>
      </Card>
      {roles.includes('relay') && (
        <Card>
          <CardHeader title={t('nodes.detail.relaySettings')} description={t('nodes.detail.relaySettingsHint')} />
          <div className="flex flex-col gap-4 p-5">
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label={t('nodes.fields.publicHost')} hint={caddy === false ? t('nodes.fields.publicHostDirect') : t('nodes.fields.publicHostHint')} className="sm:col-span-2">
                <Input value={c.publicHost} onChange={(e) => set({ publicHost: e.target.value.trim().toLowerCase() })} placeholder="relay-ams.example.com" />
              </Field>
              <Field label={t('nodes.fields.listenPort')} hint={t('nodes.fields.listenPortHint', { port: caddy ? 80 : 8000 })}>
                <Input type="number" min={1} max={65535} value={c.listenPort ?? ''} placeholder={caddy ? '80' : '8000'} onChange={(e) => set({ listenPort: port(e.target.value) })} />
              </Field>
              <Field label={t('nodes.fields.maxListeners')} hint={t('nodes.fields.maxListenersHint')}>
                <Input type="number" min={0} value={c.maxListeners} onChange={(e) => set({ maxListeners: Number(e.target.value) })} />
              </Field>
              <Field label={t('nodes.fields.pushPort')} hint={t('nodes.fields.pushPortHint')}>
                <Input type="number" min={1024} max={65535} value={c.pushPort ?? ''} placeholder="8001" onChange={(e) => set({ pushPort: port(e.target.value) ?? 8001 })} />
              </Field>
            </div>
            <div>
              <div className="mb-2 text-[13px] font-semibold">{t('nodes.fields.relayStations')}</div>
              <div className="mb-2 flex gap-2">
                <Button size="sm" type="button" variant={selected ? 'secondary' : 'dark'} onClick={() => set({ relayStations: 'all' })}>
                  {node.tenantId ? t('nodes.fields.allOwnStations') : t('nodes.fields.allStations')}
                </Button>
                <Button size="sm" type="button" variant={selected ? 'dark' : 'secondary'} onClick={() => set({ relayStations: selected ? [...selected] : [] })}>
                  {t('nodes.fields.someStations')}
                </Button>
              </div>
              {selected && (
                <div className="grid max-h-64 gap-1 overflow-y-auto rounded-md border border-line p-2 sm:grid-cols-2">
                  {pick.map((s) => (
                    <label key={s.id} className="flex items-center gap-2 rounded px-2 py-1.5 text-[13px] hover:bg-hover">
                      <input
                        type="checkbox"
                        className="accent-[var(--koraal)]"
                        checked={selected.has(s.id)}
                        onChange={(e) => set({ relayStations: e.target.checked ? [...selected, s.id] : [...selected].filter((x) => x !== s.id) })}
                      />
                      <span className="truncate">{s.name}</span>
                      {!node.tenantId && <span className="truncate text-xs text-muted">{s.tenantName}</span>}
                    </label>
                  ))}
                  {!pick.length && <p className="px-2 py-1 text-xs text-muted">{t('nodes.fields.noStations')}</p>}
                </div>
              )}
            </div>
          </div>
        </Card>
      )}
      {roles.includes('fm') && <FmSettingsCards node={node} value={c.fm} onChange={(fm) => set({ fm })} stations={pick} />}
      {roles.includes('source') && (
        <Card>
          <CardHeader title={t('nodes.detail.sourceSettings')} description={t('nodes.detail.sourceSettingsHint')} />
          <div className="grid gap-3 p-5 sm:grid-cols-2">
            <Field label={t('nodes.fields.sourceTlsPort')} hint={t('nodes.fields.sourceTlsPortHint')}>
              <Input type="number" min={1024} max={65535} value={c.sourceTlsPort ?? ''} placeholder={t('nodes.fields.off')} onChange={(e) => set({ sourceTlsPort: port(e.target.value) })} />
            </Field>
            <Field label={t('nodes.fields.sourcePlainPort')} hint={t('nodes.fields.sourcePlainPortHint')}>
              <Input type="number" min={1024} max={65535} value={c.sourcePlainPort ?? ''} placeholder={t('nodes.fields.off')} onChange={(e) => set({ sourcePlainPort: port(e.target.value) })} />
            </Field>
            <p className="text-xs text-muted sm:col-span-2">{t('nodes.detail.sourceDns')}</p>
          </div>
        </Card>
      )}
      {roles.includes('station') && (
        <Card>
          <CardHeader title={t('nodes.detail.stationSettings')} description={t('nodes.detail.stationSettingsHint')} />
          <div className="grid gap-3 p-5 sm:grid-cols-2">
            <Field label={t('nodes.fields.lanAddress')} hint={t('nodes.fields.lanAddressHint')}>
              <Input value={c.lanAddress ?? ''} placeholder="192.168.1.20" onChange={(e) => set({ lanAddress: e.target.value.trim() })} />
            </Field>
            <p className="text-xs text-muted sm:col-span-2">{t('nodes.detail.stationInstall')}</p>
          </div>
        </Card>
      )}
      <div className="flex justify-end">
        <Button variant="primary" type="submit" loading={save.isPending}>
          {t('common.save')}
        </Button>
      </div>
    </form>
  );
}

export function NodeDetailPage() {
  const { id = '' } = useParams();
  const { t } = useTranslation();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const me = useMe().data!;
  const admin = isAdmin(me);
  const [tab, setTab] = useState<Tab>('overview');
  const [pairing, setPairing] = useState<NodePairing | null>(null);
  const node = useQuery({ queryKey: ['nodes', id], queryFn: () => api<NodeItem>(`/nodes/${id}`), refetchInterval: 5000 });
  const settings = useQuery({ queryKey: ['nodes', 'settings'], queryFn: () => api<{ latencyWarnMs: number }>('/nodes/settings'), enabled: admin });
  const warnMs = settings.data?.latencyWarnMs ?? 150;
  const n = node.data;
  const canEdit = !!n && (admin || (!!n.tenantId && me.memberships.some((m) => m.tenantId === n.tenantId && m.role === 'owner')));
  const refresh = () => void qc.invalidateQueries({ queryKey: ['nodes'] });

  const newCode = useMutation({
    mutationFn: () => api<NodePairing>(`/nodes/${id}/pairing`, { method: 'POST' }),
    onSuccess: (p) => {
      setPairing(p);
      refresh();
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const unpair = useMutation({
    mutationFn: () => api<NodeItem>(`/nodes/${id}/unpair`, { method: 'POST' }),
    onSuccess: () => {
      toast.success(t('nodes.detail.unpaired'));
      refresh();
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const update = useMutation({
    mutationFn: () => api(`/nodes/${id}/update`, { method: 'POST' }),
    onSuccess: () => {
      toast.success(t('nodes.detail.updateStarted'));
      refresh();
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const remove = useMutation({
    mutationFn: () => api(`/nodes/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.success(t('nodes.detail.deleted'));
      void qc.invalidateQueries({ queryKey: ['nodes'] });
      navigate('/nodes');
    },
    onError: (err) => toast.error((err as Error).message),
  });

  if (node.isPending) {
    return (
      <div className="grid place-items-center py-20">
        <Spinner />
      </div>
    );
  }
  if (!n) {
    return <EmptyState icon={<XCircle className="size-5" />} title={t('nodes.detail.notFound')} action={<Link to="/nodes"><Button>{t('nodes.detail.back')}</Button></Link>} />;
  }
  const s = n.status;
  const health = nodeHealth(n, warnMs);

  return (
    <>
      <Link to="/nodes" className="mb-3 inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-ink">
        <ArrowLeft className="size-4" /> {admin ? t('nav.nodes') : t('nav.myNodes')}
      </Link>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-3">
            {n.name}
            <HealthBadge health={health} />
          </span>
        }
        description={
          <span className="flex flex-wrap items-center gap-2">
            <RoleBadges roles={n.roles} />
            {n.location && <span>{n.location}</span>}
            {admin && <span>· {n.tenantName ?? t('nodes.platform')}</span>}
          </span>
        }
        actions={
          canEdit && (
            <>
              {n.paired && n.updateAvailable && (
                <Button variant="primary" disabled={!s.online} loading={update.isPending || s.update?.state === 'running'} onClick={() => update.mutate()}>
                  <ArrowUpCircle className="size-4" /> {t('nodes.detail.updateNow')}
                </Button>
              )}
              <Button onClick={() => newCode.mutate()} loading={newCode.isPending}>
                <KeyRound className="size-4" /> {n.paired ? t('nodes.detail.repair') : t('nodes.detail.newCode')}
              </Button>
              {n.paired && (
                <Button variant="danger" loading={unpair.isPending} onClick={() => confirm(t('nodes.detail.unpairConfirm', { name: n.name })) && unpair.mutate()}>
                  <Link2Off className="size-4" /> {t('nodes.detail.unpair')}
                </Button>
              )}
              <Button variant="danger" loading={remove.isPending} onClick={() => confirm(t('nodes.detail.deleteConfirm', { name: n.name })) && remove.mutate()}>
                <Trash2 className="size-4" />
              </Button>
            </>
          )
        }
      />

      {!n.paired && (
        <Card className="mb-4">
          <CardHeader title={t('nodes.detail.notPaired')} description={n.pairingExpiresAt ? t('nodes.detail.codeOpen', { when: formatDate(n.pairingExpiresAt) }) : t('nodes.detail.codeExpired')} />
          <div className="p-5">
            {pairing ? (
              <PairingPanel pairing={pairing} />
            ) : (
              <div className="flex flex-wrap items-center gap-3">
                <p className="flex-1 text-[13px] text-muted">{t('nodes.detail.notPairedHint')}</p>
                {canEdit && (
                  <Button variant="primary" loading={newCode.isPending} onClick={() => newCode.mutate()}>
                    <KeyRound className="size-4" /> {t('nodes.detail.newCode')}
                  </Button>
                )}
              </div>
            )}
          </div>
        </Card>
      )}

      {n.paired && (
        <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
          <Kpi
            label={t('nodes.detail.latency')}
            value={s.online ? formatMs(s.rttMs) : '—'}
            note={s.online ? ((s.rttMs ?? 0) > warnMs ? t('nodes.detail.slow') : t('nodes.detail.stable')) : t('nodes.health.offline')}
            tone={!s.online ? 'offline' : (s.rttMs ?? 0) > warnMs ? 'warning' : 'online'}
          />
          <Kpi
            label={t('nodes.detail.timeouts24h')}
            value={s.timeouts24h ?? 0}
            note={`${t('nodes.detail.loss')}: ${formatPct(s.online ? (s.loss ?? 0) : null)}`}
            tone={(s.timeouts24h ?? 0) > 0 || (s.loss ?? 0) > 0.05 ? 'warning' : 'online'}
          />
          <Kpi label={t('nodes.cols.listeners')} value={s.online ? (s.listeners ?? 0).toLocaleString() : '—'} note={`${t('nodes.detail.outgoing')}: ${s.online ? formatBps(s.txBps) : '—'}`} />
          <Kpi
            label={t('nodes.detail.cpu')}
            value={s.online && s.cpu != null ? `${Math.round(s.cpu * 100)}%` : '—'}
            note={`${t('nodes.detail.memory')}: ${s.online && s.memory != null ? `${Math.round(s.memory * 100)}%` : '—'}`}
            tone={(s.cpu ?? 0) > 0.85 ? 'warning' : undefined}
          />
        </div>
      )}

      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'overview', label: t('nodes.detail.tabs.overview') },
          { value: 'probes', label: t('nodes.detail.tabs.probes') },
          { value: 'events', label: t('nodes.detail.tabs.events') },
          ...(canEdit ? [{ value: 'settings' as const, label: t('nodes.detail.tabs.settings') }] : []),
        ]}
      />
      {tab === 'overview' && <Overview node={n} warnMs={warnMs} />}
      {tab === 'probes' && <Probes node={n} />}
      {tab === 'events' && <Events node={n} />}
      {tab === 'settings' && canEdit && <SettingsForm node={n} />}

      <Dialog open={!!pairing && n.paired} onClose={() => setPairing(null)} wide title={t('nodes.detail.repairTitle')} description={t('nodes.detail.repairHint')}>
        {pairing && <PairingPanel pairing={pairing} />}
      </Dialog>
    </>
  );
}
