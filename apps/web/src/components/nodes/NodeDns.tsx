import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, RefreshCw, XCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { api, type NodeConfig, type NodeDns, type NodeItem } from '../../lib/api';
import { formatRelative } from '../../lib/format';
import { Button, Card, CardHeader, CopyField, Field, Input, Switch } from '../ui';

/**
 * A node's names (phase 15): its platform name from Cloudflare DNS, the public address that name gets, and an own
 * host name (e.g. studio.harder.fm) with its check. Part of the node's settings form.
 */
export function NodeDnsCard({ node, value: c, onChange: set }: { node: NodeItem; value: NodeConfig; onChange: (patch: Partial<NodeConfig>) => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const dns = useQuery({ queryKey: ['nodes', node.id, 'dns'], queryFn: () => api<NodeDns>(`/nodes/${node.id}/dns`), refetchInterval: 30_000 });
  const verify = useMutation({
    mutationFn: () => api<NodeDns>(`/nodes/${node.id}/dns/verify`, { method: 'POST' }),
    onSuccess: (res) => {
      qc.setQueryData(['nodes', node.id, 'dns'], res);
      if (res.check?.ok) toast.success(t('nodes.dns.ownOk', { host: res.ownHost }));
      else toast.error(t('domains.notYet'));
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const d = dns.data;
  const caddy = node.status.caddy;
  const enabled = !!d && d.problem !== 'off';
  return (
    <Card>
      <CardHeader title={t('nodes.dns.title')} description={t('nodes.dns.subtitle')} />
      <div className="flex flex-col gap-4 p-5">
        {d && d.platformName && (
          <div className="flex flex-col gap-1.5">
            <CopyField label={t('nodes.dns.platformName')} value={d.platformName} />
            <p className={`flex items-center gap-1.5 text-xs ${d.live ? 'text-online' : 'text-warning'}`}>
              {d.live ? <CheckCircle2 className="size-3.5" /> : <AlertTriangle className="size-3.5" />}
              {d.live
                ? t('nodes.dns.live', { ips: d.addresses.join(', ') })
                : d.problem === 'noAddress'
                  ? t('nodes.dns.noAddress')
                  : d.problem === 'nameTaken'
                    ? t('nodes.dns.nameTaken')
                    : d.active
                      ? t('nodes.dns.pending')
                      : t('nodes.dns.dryRun')}
            </p>
          </div>
        )}
        {d && !enabled && <p className="text-xs text-muted">{t('nodes.dns.off')}</p>}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('nodes.dns.dnsName')} hint={t('nodes.dns.dnsNameHint')}>
            <Input value={c.dnsName ?? ''} maxLength={63} placeholder={t('nodes.dns.fromName')} onChange={(e) => set({ dnsName: e.target.value.trim().toLowerCase() })} />
          </Field>
          <Field label={t('nodes.dns.publicAddress')} hint={t('nodes.dns.publicAddressHint', { ip: node.status.ip ?? '—' })}>
            <Input value={c.publicAddress ?? ''} placeholder={d?.addresses[0] ?? '203.0.113.10'} onChange={(e) => set({ publicAddress: e.target.value.trim() })} />
          </Field>
        </div>
        <Switch checked={c.dnsRecord ?? true} onChange={(dnsRecord) => set({ dnsRecord })} label={t('nodes.dns.dnsRecord')} description={t('nodes.dns.dnsRecordHint')} />
        <Field label={t('nodes.fields.publicHost')} hint={caddy === false ? t('nodes.fields.publicHostDirect') : d?.platformName ? t('nodes.dns.ownHostHint', { name: d.platformName }) : t('nodes.fields.publicHostHint')}>
          <Input value={c.publicHost} onChange={(e) => set({ publicHost: e.target.value.trim().toLowerCase() })} placeholder={d?.platformName ?? 'relay-ams.example.com'} />
        </Field>
        {d?.ownHost && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2">
            <div className="flex min-w-0 items-center gap-2 text-[13px]">
              {d.check?.ok ? <CheckCircle2 className="size-4 shrink-0 text-online" /> : <XCircle className="size-4 shrink-0 text-offline" />}
              <span className="truncate">
                <span className="font-mono">{d.ownHost}</span>{' '}
                <span className="text-muted">
                  {!d.check
                    ? t('domains.notChecked')
                    : d.check.ok
                      ? t('nodes.dns.ownUsed')
                      : d.check.error === 'not_found'
                        ? t('domains.errors.not_found')
                        : t('nodes.dns.ownWrong', { found: d.check.found.join(', '), target: d.platformName ?? '' })}
                  {d.check && ` · ${t('domains.checked', { when: formatRelative(d.check.at) })}`}
                </span>
              </span>
            </div>
            <Button size="sm" type="button" variant="secondary" loading={verify.isPending} onClick={() => verify.mutate()}>
              <RefreshCw className="size-4" /> {t('domains.verify')}
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}
