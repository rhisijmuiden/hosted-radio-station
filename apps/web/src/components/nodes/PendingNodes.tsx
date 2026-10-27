import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Inbox, X } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { api, ApiError, type NodeItem, type NodeRegistration, type NodeRole, type Tenant } from '../../lib/api';
import { formatDate } from '../../lib/format';
import { RolePicker } from '../../pages/Nodes';
import { Badge, Button, Card, CardHeader, Dialog, Field, Input, Select } from '../ui';

/**
 * Pending nodes (phase 16): machines that registered themselves with the bare node installer. Each shows the code that
 * is on the node's screen; the administrator compares it and accepts the node, which then gets its keys.
 */
export function PendingNodesCard() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const pending = useQuery({ queryKey: ['nodes', 'pending'], queryFn: () => api<NodeRegistration[]>('/nodes/pending'), refetchInterval: 5000 });
  const [accepting, setAccepting] = useState<NodeRegistration | null>(null);
  const reject = useMutation({
    mutationFn: (id: string) => api(`/nodes/pending/${id}/reject`, { method: 'POST' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['nodes', 'pending'] });
      toast.success(t('nodes.pending.rejected'));
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const list = pending.data ?? [];
  if (!list.length) return null;
  return (
    <>
      <Card className="mb-4 border-koraal/50">
        <CardHeader
          title={
            <span className="flex items-center gap-2">
              <Inbox className="size-4 text-koraal" /> {t('nodes.pending.title')} <Badge tone="accent">{list.length}</Badge>
            </span>
          }
          description={t('nodes.pending.subtitle')}
        />
        <ul className="divide-y divide-line">
          {list.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-x-5 gap-y-3 px-5 py-3">
              <div className="rounded-md border border-koraal/40 bg-koraal/8 px-3 py-1.5 text-center">
                <div className="text-[10px] tracking-[0.08em] text-muted uppercase">{t('nodes.pending.code')}</div>
                <div className="font-mono text-base font-bold tracking-[0.12em]">{r.code}</div>
              </div>
              <div className="min-w-0 flex-1">
                <div className="font-semibold">{r.hostname || '—'}</div>
                <div className="font-mono text-[12px] text-muted">{[r.ip, ...r.addresses.filter((a) => a !== r.ip)].filter(Boolean).join(' · ') || '—'}</div>
                <div className="text-xs text-muted">
                  {t('nodes.pending.registered', { when: formatDate(r.createdAt) })}
                  {r.version && ` · v${r.version}`}
                  {r.preferredRole && ` · ${t('nodes.pending.preferred', { role: t(`nodes.roles.${r.preferredRole}`) })}`}
                </div>
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="ghost" loading={reject.isPending && reject.variables === r.id} onClick={() => reject.mutate(r.id)}>
                  <X className="size-4" /> {t('nodes.pending.reject')}
                </Button>
                <Button size="sm" variant="primary" onClick={() => setAccepting(r)}>
                  <Check className="size-4" /> {t('nodes.pending.accept')}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </Card>
      <AcceptDialog registration={accepting} onClose={() => setAccepting(null)} />
    </>
  );
}

function AcceptDialog({ registration, onClose }: { registration: NodeRegistration | null; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const open = !!registration;
  const tenants = useQuery({ queryKey: ['tenants'], queryFn: () => api<Tenant[]>('/tenants'), enabled: open });
  const [name, setName] = useState('');
  const [location, setLocation] = useState('');
  const [tenantId, setTenantId] = useState('');
  const [roles, setRoles] = useState<NodeRole[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!registration) return;
    setName(registration.suggestedName);
    setLocation('');
    setTenantId('');
    setRoles(registration.preferredRole ? [registration.preferredRole] : []);
    setError(null);
  }, [registration]);

  const accept = useMutation({
    mutationFn: () => api<NodeItem>(`/nodes/pending/${registration!.id}/accept`, { method: 'POST', body: { name, location, tenantId: tenantId || null, roles } }),
    onSuccess: (node) => {
      void qc.invalidateQueries({ queryKey: ['nodes'] });
      toast.success(t('nodes.pending.accepted', { name: node.name }));
      onClose();
      navigate(`/nodes/${node.id}`);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : String(err)),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    accept.mutate();
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      wide
      title={t('nodes.pending.acceptTitle', { host: registration?.hostname || registration?.code })}
      description={t('nodes.pending.acceptHint')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" type="submit" form="accept-node" loading={accept.isPending}>
            {t('nodes.pending.acceptSubmit')}
          </Button>
        </>
      }
    >
      {registration && (
        <form id="accept-node" className="flex flex-col gap-4" onSubmit={submit}>
          <div className="rounded-lg border border-koraal/40 bg-koraal/8 px-4 py-3 text-center">
            <div className="text-[11px] tracking-[0.08em] text-muted uppercase">{t('nodes.pending.compare')}</div>
            <div className="display mt-1 font-mono text-2xl tracking-[0.12em]">{registration.code}</div>
            <div className="mt-1 font-mono text-xs text-muted">{[registration.hostname, registration.ip].filter(Boolean).join(' · ')}</div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('nodes.fields.name')} hint={t('nodes.fields.nameHint')}>
              <Input required autoFocus maxLength={40} value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label={t('nodes.fields.location')} hint={t('nodes.fields.locationHint')}>
              <Input maxLength={80} value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Amsterdam" />
            </Field>
          </div>
          <Field label={t('nodes.fields.owner')} hint={t('nodes.fields.ownerHint')}>
            <Select value={tenantId} onChange={(e) => setTenantId(e.target.value)}>
              <option value="">{t('nodes.platform')}</option>
              {(tenants.data ?? []).map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('nodes.fields.roles')} hint={t('nodes.pending.rolesHint')}>
            <RolePicker value={roles} onChange={setRoles} />
          </Field>
          {error && <p className="rounded-md bg-offline/10 px-3 py-2 text-[13px] text-offline">{error}</p>}
        </form>
      )}
    </Dialog>
  );
}
