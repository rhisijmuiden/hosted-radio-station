import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Network } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { api, type PortPlan } from '../../lib/api';
import { useServerNames } from '../../lib/server';
import { Badge, Button, Card, Dialog, Table } from '../ui';

const range = (from: number, to: number) => `${from}–${to}`;

/**
 * Port plan (1.3): the ports per role, and the old ports from before it that servers and nodes still keep open. The
 * administrator switches the old ones off per server, or everywhere at once, once the firewalls let the new ones in.
 */
export function PortPlanCard() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const server = useServerNames();
  const [show, setShow] = useState<'ports' | 'off' | null>(null);
  const view = useQuery({ queryKey: ['nodes', 'port-plan'], queryFn: () => api<PortPlan>('/nodes/port-plan') });
  const save = useMutation({
    mutationFn: (body: { thisServer?: boolean; nodes?: { id: string; oldPorts: boolean }[] }) => api<PortPlan>('/nodes/port-plan', { method: 'PUT', body }),
    onSuccess: (res) => {
      qc.setQueryData(['nodes', 'port-plan'], res);
      void qc.invalidateQueries({ queryKey: ['nodes'] });
      toast.success(t('portPlan.saved'));
      setShow(null);
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const v = view.data;
  if (!v) return null;
  const p = v.ports;
  const withOld = v.nodes.filter((n) => n.oldPorts);
  const anyOld = v.thisServer || withOld.length > 0;
  const rows: [string, string][] = [
    [t('portPlan.roles.orchestrator'), t('portPlan.orchestratorPorts', { https: p.orchestrator.https, http: p.orchestrator.http })],
    [t('portPlan.roles.ingest'), t('portPlan.ingestPorts', { plain: p.ingest.plain, tls: p.ingest.tls, shoutcast: range(p.ingest.shoutcastFrom, p.ingest.shoutcastTo) })],
    [t('portPlan.roles.relay'), t('portPlan.relayPorts', { push: p.relay.push })],
    [t('portPlan.roles.station'), t('portPlan.stationPorts', { plain: p.stationNode.plain, tls: p.stationNode.tls, sftp: p.stationNode.sftp })],
    [t('portPlan.roles.other'), t('portPlan.otherPorts')],
  ];
  return (
    <>
      <Card className={clsx('mb-4 flex flex-wrap items-center gap-4 px-5 py-4', anyOld && 'border-warning/40')}>
        <span className="grid size-10 place-items-center rounded-md bg-chip text-accent-text [&_svg]:size-5">
          <Network />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <b className="text-sm">{t('portPlan.title')}</b>
            <Badge tone={anyOld ? 'warning' : 'online'}>{anyOld ? t('portPlan.badgeOld') : t('portPlan.badgeNew')}</Badge>
          </div>
          <p className="mt-0.5 text-[13px] text-muted">
            {anyOld ? t('portPlan.textOld', { count: withOld.length + (v.thisServer ? 1 : 0), old: `${v.old.plain}, ${v.old.tls}, ${v.old.push}` }) : t('portPlan.textNew')}
          </p>
        </div>
        <Button size="sm" onClick={() => setShow('ports')}>
          {t('portPlan.showPorts')}
        </Button>
        {anyOld && (
          <Button size="sm" variant="primary" onClick={() => setShow('off')}>
            {t('portPlan.switchOff')}
          </Button>
        )}
      </Card>

      <Dialog open={show === 'ports'} onClose={() => setShow(null)} wide title={t('portPlan.title')} description={t('portPlan.intro')} footer={<Button onClick={() => setShow(null)}>{t('common.close')}</Button>}>
        <div className="flex flex-col gap-3">
          <Table head={[t('portPlan.role'), t('portPlan.incoming')]}>
            {rows.map(([role, ports]) => (
              <tr key={role}>
                <td className="text-[13px] font-semibold whitespace-nowrap">{role}</td>
                <td className="font-mono text-[13px] tabular-nums">{ports}</td>
              </tr>
            ))}
          </Table>
          <p className="text-[13px] text-muted">{t('portPlan.override')}</p>
          <p className="text-[13px] text-muted">{t('portPlan.outbound')}</p>
        </div>
      </Dialog>

      <Dialog
        open={show === 'off'}
        onClose={() => setShow(null)}
        wide
        title={t('portPlan.offTitle')}
        description={t('portPlan.offText', { plain: v.old.plain, tls: v.old.tls, push: v.old.push, sftp: v.old.sftp })}
        footer={
          <>
            <Button onClick={() => setShow(null)}>{t('common.cancel')}</Button>
            <Button variant="primary" loading={save.isPending} onClick={() => save.mutate({ thisServer: false, nodes: withOld.map((n) => ({ id: n.id, oldPorts: false })) })}>
              {t('portPlan.offAll')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <p className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-[13px]">{t('portPlan.offCheck')}</p>
          <Table head={[t('portPlan.server'), '']}>
            {v.thisServer && (
              <tr>
                <td className="text-[13px]">
                  <b>{server?.name ?? t('topology.orchestrator')}</b>
                  <div className="text-xs text-muted">
                    {t('portPlan.thisServerOld', { plain: v.old.plain, tls: v.old.tls })}
                    {v.oldShoutcast > 0 && <> · {t('portPlan.shoutcastMove', { count: v.oldShoutcast, range: range(p.ingest.shoutcastFrom, p.ingest.shoutcastTo) })}</>}
                  </div>
                </td>
                <td className="text-right">
                  <Button size="sm" loading={save.isPending} onClick={() => save.mutate({ thisServer: false })}>
                    {t('portPlan.offOne')}
                  </Button>
                </td>
              </tr>
            )}
            {withOld.map((n) => (
              <tr key={n.id}>
                <td className="text-[13px]">
                  <Link to={`/nodes/${n.id}?tab=firewall`} className="font-semibold hover:underline">
                    {n.name}
                  </Link>
                  <div className="text-xs text-muted">{n.roles.map((r) => t(`nodes.roles.${r}`)).join(' · ')}</div>
                </td>
                <td className="text-right">
                  <Button size="sm" loading={save.isPending} onClick={() => save.mutate({ nodes: [{ id: n.id, oldPorts: false }] })}>
                    {t('portPlan.offOne')}
                  </Button>
                </td>
              </tr>
            ))}
          </Table>
        </div>
      </Dialog>
    </>
  );
}
