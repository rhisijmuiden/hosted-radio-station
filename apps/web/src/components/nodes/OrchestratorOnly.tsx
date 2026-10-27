import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Cpu, ShieldOff, Tag } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { api, type OrchestratorView } from '../../lib/api';
import { useServerNames } from '../../lib/server';
import { Badge, Button, Card, Dialog, Table } from '../ui';

/**
 * "Orchestrator only" (phase 18): a switch that turns off this server's own ingest and relay, so it carries no audio
 * at all. Before it goes on, the panel lists the stations that still use this server.
 */
export function OrchestratorOnlyCard() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const server = useServerNames();
  const [open, setOpen] = useState(false);
  const view = useQuery({ queryKey: ['nodes', 'orchestrator'], queryFn: () => api<OrchestratorView>('/nodes/orchestrator'), refetchInterval: open ? 5000 : 60_000 });
  const save = useMutation({
    mutationFn: (only: boolean) => api<OrchestratorView>('/nodes/orchestrator', { method: 'PUT', body: { only } }),
    onSuccess: (res) => {
      qc.setQueryData(['nodes', 'orchestrator'], res);
      void qc.invalidateQueries({ queryKey: ['system-info'] });
      void qc.invalidateQueries({ queryKey: ['topology'] });
      toast.success(res.only ? t('orchestratorOnly.on') : t('orchestratorOnly.off'));
      setOpen(false);
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const v = view.data;
  if (!v) return null;
  const blocked = v.stations.length > 0;
  return (
    <>
      <Card className={clsx('mb-4 flex flex-wrap items-center gap-4 px-5 py-4', v.only && 'border-lucht/60')}>
        <span className={clsx('grid size-10 place-items-center rounded-md [&_svg]:size-5', v.only ? 'bg-nacht text-koraal' : 'bg-chip text-accent-text')}>{v.only ? <ShieldOff /> : <Cpu />}</span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <b className="text-sm">{server?.name ?? t('topology.orchestrator')}</b>
            <Badge tone={v.only ? 'accent' : 'neutral'}>{v.only ? t('orchestratorOnly.badgeOn') : t('orchestratorOnly.badgeOff')}</Badge>
          </div>
          <p className="mt-0.5 text-[13px] text-muted">
            {v.only ? t('orchestratorOnly.textOn') : blocked ? t('orchestratorOnly.textBlocked', { count: v.stations.length }) : t('orchestratorOnly.textReady')}
          </p>
        </div>
        <Link to="/nodes/names">
          <Button size="sm">
            <Tag className="size-4" /> {t('names.button')}
          </Button>
        </Link>
        <Button size="sm" variant={v.only ? 'secondary' : 'primary'} onClick={() => setOpen(true)}>
          {v.only ? t('orchestratorOnly.switchOff') : t('orchestratorOnly.switchOn')}
        </Button>
      </Card>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        wide
        title={v.only ? t('orchestratorOnly.offTitle') : t('orchestratorOnly.onTitle')}
        description={v.only ? t('orchestratorOnly.offText') : t('orchestratorOnly.onText')}
        footer={
          <>
            <Button onClick={() => setOpen(false)}>{t('common.cancel')}</Button>
            <Button variant="primary" disabled={!v.only && blocked} loading={save.isPending} onClick={() => save.mutate(!v.only)}>
              {v.only ? t('orchestratorOnly.switchOff') : t('orchestratorOnly.switchOn')}
            </Button>
          </>
        }
      >
        {!v.only && (
          <div className="flex flex-col gap-3">
            <ul className="list-disc pl-5 text-[13px] text-muted">
              {(['ports', 'icecast', 'routing', 'fallback', 'listeners', 'uploads', 'web'] as const).map((k) => (
                <li key={k}>{t(`orchestratorOnly.effects.${k}`)}</li>
              ))}
            </ul>
            <div className="grid grid-cols-3 gap-2 text-center text-[12px]">
              {[
                [t('topology.ingestNodes'), v.ingestNodes],
                [t('nodes.tree.groups.station'), v.stationNodes],
                [t('nodes.tree.groups.relay'), v.relayNodes],
              ].map(([label, n]) => (
                <div key={String(label)} className="rounded-md border border-line px-2 py-2">
                  <div className="display text-lg tabular-nums">{n}</div>
                  <div className="text-muted">{label}</div>
                </div>
              ))}
            </div>
            {blocked ? (
              <>
                <p className="text-[13px] font-semibold text-warning">{t('orchestratorOnly.stillUsing', { count: v.stations.length })}</p>
                <Table head={[t('orchestratorOnly.station'), t('fields.customer'), t('orchestratorOnly.uses')]}>
                  {v.stations.map((s) => (
                    <tr key={s.id}>
                      <td>
                        <Link to={`/stations/${s.id}?tab=routing`} className="font-semibold hover:underline">
                          {s.name}
                        </Link>
                      </td>
                      <td className="text-[13px]">{s.tenantName}</td>
                      <td>
                        <div className="flex flex-wrap gap-1">
                          {s.uses.map((u) => (
                            <Badge key={u} tone="warning">
                              {t(`orchestratorOnly.use.${u}`)}
                            </Badge>
                          ))}
                        </div>
                      </td>
                    </tr>
                  ))}
                </Table>
              </>
            ) : (
              <p className="text-[13px] font-semibold text-online">{t('orchestratorOnly.ready')}</p>
            )}
          </div>
        )}
      </Dialog>
    </>
  );
}
