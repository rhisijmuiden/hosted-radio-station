import { useMutation, useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { Building2, CheckCircle2, Globe, Home, Mail, MinusCircle, MonitorSmartphone, Server, ShieldCheck, Upload, XCircle } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { api, type ConnectionEndpoint, type FirewallPort, type NodeFirewall, type NodeItem, type PortService, type StationConnection, type StationDetail } from '../../lib/api';
import { formatRelative } from '../../lib/format';
import { Badge, Button, Card, CardHeader, CopyField, Spinner, Table } from '../ui';

/** "8010" or "50000–50100". */
export const portText = (p: { port: number; to?: number }) => (p.to ? `${p.port}–${p.to}` : String(p.port));

const ROLE_ICON: Record<ConnectionEndpoint['role'], ReactNode> = {
  stationNode: <Building2 />,
  ingest: <Server />,
  backupIngest: <Server />,
  uploads: <Upload />,
};

function PortRows({ ports }: { ports: { service: PortService; port: number; to?: number; tls?: boolean }[] }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col divide-y divide-line rounded-md border border-line">
      {ports.map((p) => (
        <div key={`${p.service}-${p.port}`} className="flex items-center gap-3 px-3 py-2 text-[13px]">
          <span className="w-28 shrink-0 font-mono font-semibold tabular-nums">{portText(p)}</span>
          <span className="min-w-0 flex-1 text-muted">{t(`connection.ports.${p.service}`)}</span>
          {p.tls && <Badge tone="online">TLS</Badge>}
        </div>
      ))}
    </div>
  );
}

function EndpointCard({ e }: { e: ConnectionEndpoint }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface/60 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="grid size-8 place-items-center rounded-md bg-chip text-accent-text [&_svg]:size-4">{ROLE_ICON[e.role]}</span>
        <div className="min-w-0 flex-1">
          <div className="text-[11px] tracking-[0.08em] text-muted uppercase">{t(`connection.roles.${e.role}`)}</div>
          <b className="block truncate text-sm">{e.name}</b>
        </div>
        {e.node && (
          <Badge tone={e.online ? 'online' : 'offline'} dot>
            {t(e.online ? 'nodes.health.online' : 'nodes.health.offline')}
          </Badge>
        )}
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {e.external && <CopyField label={<span className="inline-flex items-center gap-1"><Globe className="size-3" /> {t('connection.external')}</span>} value={e.external} />}
        {e.internal && <CopyField label={<span className="inline-flex items-center gap-1"><Home className="size-3" /> {t('connection.internal')}</span>} value={e.internal} />}
      </div>
      {!!e.ports.length && <PortRows ports={e.ports} />}
      {e.role === 'stationNode' && e.internal && <p className="text-xs text-muted">{t('connection.internalHint')}</p>}
    </div>
  );
}

/**
 * The station's connection page (phase 18): where RHIS Studio, encoders and uploads connect, as the orchestrator hands
 * it out from the routing. With a station node its external and internal address; otherwise the ingest node(s).
 */
export function ConnectionTab({ station }: { station: StationDetail }) {
  const { t } = useTranslation();
  const conn = useQuery({ queryKey: ['station', station.id, 'connection'], queryFn: () => api<StationConnection>(`/stations/${station.id}/connection`), refetchInterval: 30_000 });
  const email = useMutation({
    mutationFn: () => api<{ to: string }>(`/stations/${station.id}/connection/email`, { method: 'POST' }),
    onSuccess: (r) => toast.success(t('connection.emailed', { to: r.to })),
    onError: (err) => toast.error((err as Error).message),
  });
  const c = conn.data;
  const source = station.connection.mounts.find((m) => station.mounts.find((x) => x.id === m.id)?.kind === 'source');
  return (
    <div className="grid items-start gap-4 xl:grid-cols-[1.4fr_1fr]">
      <Card>
        <CardHeader
          title={t('connection.pageTitle')}
          description={t('connection.pageSubtitle')}
          actions={
            <Button size="sm" loading={email.isPending} onClick={() => email.mutate()}>
              <Mail className="size-4" /> {t('connection.email')}
            </Button>
          }
        />
        <div className="flex flex-col gap-3 p-5">
          {!c ? (
            <div className="grid place-items-center py-10">
              <Spinner />
            </div>
          ) : !c.endpoints.length ? (
            <p className="text-[13px] text-muted">{t('connection.none')}</p>
          ) : (
            c.endpoints.map((e) => <EndpointCard key={`${e.role}-${e.node?.id ?? 'here'}`} e={e} />)
          )}
          {c?.orchestratorOnly && <p className="text-xs text-muted">{t('connection.orchestratorOnly', { name: c.orchestrator })}</p>}
        </div>
      </Card>
      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader title={t('connection.studioTitle')} description={t('connection.studioHint')} />
          <div className="flex flex-col gap-2 p-5">
            <CopyField label={<span className="inline-flex items-center gap-1"><MonitorSmartphone className="size-3" /> {t('connection.panel')}</span>} value={c?.panelUrl ?? station.connection.panelUrl} />
            {source && <CopyField label={t('connection.mount')} value={source.encoderMount} />}
            <p className="text-xs text-muted">{t('connection.credentials')}</p>
          </div>
        </Card>
        <Card className="p-5">
          <p className="text-[13px] text-muted">{t('connection.follows')}</p>
        </Card>
      </div>
    </div>
  );
}

const FOR_ORDER: FirewallPort['for'][number][] = ['studio', 'encoders', 'uploads', 'listeners', 'ingests'];

/**
 * Firewall checklist of a node (phase 18): which ports to open or forward to it, and a check from outside per port.
 * The connections to the orchestrator and the relays go outwards, so they need nothing.
 */
export function FirewallTab({ node }: { node: NodeItem }) {
  const { t } = useTranslation();
  const fw = useQuery({ queryKey: ['nodes', node.id, 'firewall'], queryFn: () => api<NodeFirewall>(`/nodes/${node.id}/firewall`) });
  const check = useMutation({
    mutationFn: () => api<NodeFirewall>(`/nodes/${node.id}/firewall/check`, { method: 'POST' }),
    onSuccess: (r) => {
      fw.refetch();
      const bad = r.ports.filter((p) => r.checks[portKey(p)] && !r.checks[portKey(p)]!.ok && r.checks[portKey(p)]!.message !== 'idle').length;
      if (bad) toast.warning(t('firewall.someClosed', { count: bad }));
      else toast.success(t('firewall.allOpen'));
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const email = useMutation({
    mutationFn: () => api<{ to: string }>(`/nodes/${node.id}/firewall/email`, { method: 'POST' }),
    onSuccess: (r) => toast.success(t('connection.emailed', { to: r.to })),
    onError: (err) => toast.error((err as Error).message),
  });
  const data = check.data ?? fw.data;
  if (!data)
    return (
      <div className="grid place-items-center py-16">
        <Spinner />
      </div>
    );
  return (
    <div className="grid items-start gap-4 xl:grid-cols-[1.5fr_1fr]">
      <Card>
        <CardHeader
          title={t('firewall.title')}
          description={data.selfHosted ? t('firewall.subtitleSelf') : t('firewall.subtitle')}
          actions={
            <>
              <Button size="sm" loading={email.isPending} onClick={() => email.mutate()}>
                <Mail className="size-4" /> {t('connection.email')}
              </Button>
              <Button size="sm" variant="primary" loading={check.isPending} disabled={!data.external || !data.ports.length} onClick={() => check.mutate()}>
                <ShieldCheck className="size-4" /> {t('firewall.check')}
              </Button>
            </>
          }
        />
        {!data.ports.length ? (
          <p className="p-5 text-[13px] text-muted">{t('firewall.nothing')}</p>
        ) : (
          <Table head={[t('firewall.port'), t('firewall.for'), t('firewall.outside')]}>
            {data.ports.map((p) => {
              const res = data.checks[portKey(p)];
              return (
                <tr key={portKey(p)}>
                  <td className="font-mono text-[13px] font-semibold whitespace-nowrap tabular-nums">
                    {portText(p)} <span className="font-sans text-xs font-normal text-muted">TCP</span>
                  </td>
                  <td className="text-[13px]">
                    {t(`connection.ports.${p.service}`)}
                    {p.station && <span className="text-muted"> · {p.station}</span>}
                    <div className="mt-0.5 flex flex-wrap gap-1">
                      {FOR_ORDER.filter((f) => p.for.includes(f)).map((f) => (
                        <Badge key={f}>{t(`firewall.forWho.${f}`)}</Badge>
                      ))}
                    </div>
                  </td>
                  <td className="text-[13px] whitespace-nowrap">
                    {!res ? (
                      <span className="text-muted">{t('firewall.notChecked')}</span>
                    ) : (
                      <span className={clsx('inline-flex items-center gap-1.5 font-semibold', res.ok ? 'text-online' : res.message === 'idle' ? 'text-muted' : 'text-offline')} title={formatRelative(res.at)}>
                        {res.ok ? <CheckCircle2 className="size-4" /> : res.message === 'idle' ? <MinusCircle className="size-4" /> : <XCircle className="size-4" />}
                        {res.ok ? t('firewall.open', { ms: res.ms ?? 0 }) : t(`firewall.closed.${res.message ?? 'other'}`, { defaultValue: res.message ?? '' })}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </Table>
        )}
      </Card>
      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader title={t('firewall.addresses')} />
          <div className="flex flex-col gap-2 p-5">
            <CopyField label={t('connection.external')} value={data.external ?? '—'} />
            {data.internal && <CopyField label={t('connection.internal')} value={data.internal} />}
            <p className="text-xs text-muted">{t('firewall.forwardHint', { internal: data.internal ?? t('firewall.theNode') })}</p>
          </div>
        </Card>
        <Card className="p-5">
          <p className="text-[13px] text-muted">{t('firewall.outbound')}</p>
        </Card>
      </div>
    </div>
  );
}

const portKey = (p: { port: number; to?: number }) => (p.to ? `${p.port}-${p.to}` : String(p.port));
