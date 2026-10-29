import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Plus, Shield, ShieldAlert, ShieldCheck, ShieldOff, Trash2 } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { api, type NodeFirewallConfig, type NodeFirewallState, type NodeItem } from '../../lib/api';
import { formatRelative } from '../../lib/format';
import { Badge, Button, Card, CardHeader, Input, Select, Switch } from '../ui';

type ExtraPort = NodeFirewallConfig['extraPorts'][number];
const portNumber = (v: string) => (v.trim() ? Math.max(0, Math.min(65535, Math.round(Number(v)) || 0)) : null);

/** Extra ports the firewall lets in on top of the ports of the node's roles, saved together. */
function ExtraPorts({ value, disabled, saving, onSave }: { value: ExtraPort[]; disabled: boolean; saving: boolean; onSave: (v: ExtraPort[]) => void }) {
  const { t } = useTranslation();
  const [rows, setRows] = useState(value);
  // The node is fetched again every few seconds: only a saved change replaces what is being edited.
  const saved = JSON.stringify(value);
  useEffect(() => setRows(JSON.parse(saved) as ExtraPort[]), [saved]);
  const changed = JSON.stringify(rows) !== saved;
  const valid = rows.every((r) => r.port >= 1 && (r.to === null || r.to >= r.port));
  const set = (i: number, patch: Partial<ExtraPort>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="flex flex-col gap-2">
      <div>
        <div className="text-sm font-semibold">{t('firewall.node.extra')}</div>
        <div className="text-xs text-muted">{t('firewall.node.extraHint')}</div>
      </div>
      {rows.map((r, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2">
          <Input className="w-28" type="number" min={1} max={65535} aria-label={t('firewall.port')} value={r.port || ''} disabled={disabled} onChange={(e) => set(i, { port: portNumber(e.target.value) ?? 0 })} />
          <span className="text-muted">–</span>
          <Input className="w-28" type="number" min={1} max={65535} aria-label={t('firewall.node.to')} placeholder={t('firewall.node.to')} value={r.to ?? ''} disabled={disabled} onChange={(e) => set(i, { to: portNumber(e.target.value) })} />
          <Select className="w-24" aria-label={t('firewall.node.proto')} value={r.proto} disabled={disabled} onChange={(e) => set(i, { proto: e.target.value as ExtraPort['proto'] })}>
            <option value="tcp">TCP</option>
            <option value="udp">UDP</option>
          </Select>
          <Button size="sm" variant="ghost" type="button" aria-label={t('firewall.node.remove')} disabled={disabled} onClick={() => setRows(rows.filter((_, j) => j !== i))}>
            <Trash2 className="size-4" />
          </Button>
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" type="button" disabled={disabled || rows.length >= 50} onClick={() => setRows([...rows, { port: 0, to: null, proto: 'tcp' }])}>
          <Plus className="size-4" /> {t('firewall.node.add')}
        </Button>
        {changed && (
          <Button size="sm" type="button" variant="primary" loading={saving} disabled={disabled || !valid} onClick={() => onSave(rows)}>
            {t('firewall.node.saveExtra')}
          </Button>
        )}
      </div>
    </div>
  );
}

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
        <ExtraPorts value={fw.extraPorts} disabled={!canEdit || !supported} saving={save.isPending} onSave={(extraPorts) => save.mutate({ extraPorts })} />
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
