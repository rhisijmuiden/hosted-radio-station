import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Shield, ShieldAlert, ShieldCheck, ShieldOff } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { api, type NodeFirewallState, type NodeItem } from '../../lib/api';
import { formatRelative } from '../../lib/format';
import { Badge, Card, CardHeader, Switch } from '../ui';

const TONE: Record<NodeFirewallState, 'online' | 'warning' | 'offline' | 'neutral'> = {
  off: 'neutral',
  running: 'neutral',
  pending: 'warning',
  active: 'online',
  foreign: 'warning',
  rolledBack: 'offline',
  failed: 'offline',
  unsupported: 'offline',
};

const ICON: Record<NodeFirewallState, ReactNode> = {
  off: <ShieldOff className="size-4" />,
  running: <Shield className="size-4" />,
  pending: <Shield className="size-4" />,
  active: <ShieldCheck className="size-4" />,
  foreign: <ShieldAlert className="size-4" />,
  rolledBack: <ShieldAlert className="size-4" />,
  failed: <ShieldAlert className="size-4" />,
  unsupported: <ShieldOff className="size-4" />,
};

/**
 * The node's own firewall (security hardening for external nodes): on or off, what the node reports, and the choice to
 * take over when the server already has firewall rules of something else.
 */
export function NodeFirewallCard({ node, canEdit }: { node: NodeItem; canEdit: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const fw = node.config.firewall ?? { enabled: false, takeOver: false, extraPorts: [] };
  const st = node.status.firewall ?? null;
  const supported = !!node.status.features?.includes('firewall');
  const save = useMutation({
    mutationFn: (firewall: Partial<typeof fw>) => api<NodeItem>(`/nodes/${node.id}`, { method: 'PATCH', body: { config: { firewall } } }),
    onSuccess: (res) => {
      qc.setQueryData(['nodes', node.id], res);
      void qc.invalidateQueries({ queryKey: ['nodes'] });
      toast.success(t('nodes.detail.saved'));
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const state = st?.state && st.state in TONE ? (st.state as NodeFirewallState) : null;
  const foreign = st?.foreign ?? [];
  return (
    <Card>
      <CardHeader
        title={t('firewall.node.title')}
        description={t('firewall.node.subtitle')}
        actions={
          state && (
            <Badge tone={TONE[state]}>
              <span className="inline-flex items-center gap-1">
                {ICON[state]} {t(`firewall.node.state.${state}`)}
              </span>
            </Badge>
          )
        }
      />
      <div className="flex flex-col gap-4 p-5">
        {!supported && <p className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-[13px]">{t('firewall.node.update')}</p>}
        <Switch
          checked={fw.enabled}
          disabled={!canEdit || !supported || save.isPending}
          onChange={(enabled) => save.mutate({ enabled })}
          label={t('firewall.node.enabled')}
          description={t('firewall.node.enabledHint')}
        />
        {(foreign.length > 0 || fw.takeOver) && (
          <div className="flex flex-col gap-3 rounded-md border border-warning/40 bg-warning/10 px-3 py-3">
            {foreign.length > 0 && (
              <div className="flex gap-2 text-[13px]">
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
                <div>
                  <p className="font-semibold">{t('firewall.node.foreign')}</p>
                  <ul className="mt-1 list-disc pl-4 font-mono text-xs">
                    {foreign.map((f) => (
                      <li key={f}>{f}</li>
                    ))}
                  </ul>
                </div>
              </div>
            )}
            <Switch
              checked={fw.takeOver}
              disabled={!canEdit || !supported || save.isPending}
              onChange={(takeOver) => save.mutate({ takeOver })}
              label={t('firewall.node.takeOver')}
              description={t('firewall.node.takeOverHint')}
            />
          </div>
        )}
        {st?.message && (
          <p className="text-[13px] text-muted">
            {t(`firewall.node.message.${state ?? 'off'}`, { defaultValue: st.message })}
            {st.at && ` · ${formatRelative(st.at)}`}
          </p>
        )}
        {state && state !== 'off' && st?.ports && (
          <div className="flex flex-col gap-1 text-[13px]">
            <div className="font-semibold">{t('firewall.node.letIn')}</div>
            <div className="flex flex-wrap gap-1">
              {st.ports.ssh.map((p) => (
                <Badge key={`ssh-${p}`}>SSH {p}</Badge>
              ))}
              {st.ports.tcp.map((p) => (
                <Badge key={`tcp-${p}`}>{p.replace('-', '–')} TCP</Badge>
              ))}
              {st.ports.udp.map((p) => (
                <Badge key={`udp-${p}`}>{p.replace('-', '–')} UDP</Badge>
              ))}
            </div>
            <p className="text-xs text-muted">{t('firewall.node.always')}</p>
          </div>
        )}
      </div>
    </Card>
  );
}
