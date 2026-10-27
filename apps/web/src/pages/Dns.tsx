import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Cloud, PlugZap, RefreshCw, Save, Trash2 } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { Badge, Button, Card, CardHeader, Field, Input, PageHeader, Segmented, Spinner, Switch, Table } from '../components/ui';
import { api, type CloudflareSettings, type DnsState, type DnsTestResult, type NodeItem } from '../lib/api';
import { formatRelative } from '../lib/format';

const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

const stateTone = { ok: 'online', create: 'accent', update: 'warning', conflict: 'offline' } as const;

/** The records the platform wants, with their state in the zone, what it would remove, and what is in the way. */
function RecordsCard({ state, nodes, canRun }: { state: DnsState | undefined; nodes: NodeItem[]; canRun: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const run = useMutation({
    mutationFn: () => api<DnsState>('/dns/sync', { method: 'POST' }),
    onSuccess: (res) => {
      qc.setQueryData(['dns', 'state'], res);
      if (res.error) toast.error(res.error);
      else toast.success(t('dns.ran'));
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const nodeName = (id: string | null) => nodes.find((n) => n.id === id)?.name ?? null;
  return (
    <Card>
      <CardHeader
        title={t('dns.recordsTitle')}
        description={state?.mode === 'dryRun' ? t('dns.recordsDryRun') : t('dns.recordsSubtitle')}
        actions={
          canRun && (
            <Button size="sm" variant="secondary" loading={run.isPending} onClick={() => run.mutate()}>
              <RefreshCw className="size-4" /> {state?.mode === 'dryRun' ? t('dns.runDry') : t('dns.runNow')}
            </Button>
          )
        }
      />
      {!state ? (
        <div className="grid place-items-center py-10">
          <Spinner />
        </div>
      ) : (
        <div className="flex flex-col gap-4 p-5">
          <div className="flex flex-wrap items-center gap-2 text-[13px]">
            <Badge tone={state.mode === 'on' ? (state.error ? 'offline' : 'online') : state.mode === 'dryRun' ? 'warning' : 'neutral'} dot>
              {t(`dns.modes.${state.mode}`)}
            </Badge>
            {state.at && <span className="text-muted">{t('dns.lastRun', { when: formatRelative(state.at) })}</span>}
            {state.origin.addresses.length > 0 && (
              <span className="text-muted">
                · {t('dns.originIs', { ips: state.origin.addresses.join(', ') })} ({t(`dns.originSource.${state.origin.source}`)})
              </span>
            )}
          </div>
          {state.error && <p className="rounded-md bg-offline/10 px-3 py-2 text-[13px] text-offline">{state.error}</p>}
          {!!state.problems.length && (
            <ul className="flex flex-col gap-1.5">
              {state.problems.map((p, i) => (
                <li key={i} className="flex items-start gap-2 rounded-md bg-warning/10 px-3 py-2 text-[13px]">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
                  <span>
                    {t(`dns.problems.${p.kind}`, { name: p.name ?? '', node: nodeName(p.ref) ?? '' })}
                    {p.ref && nodeName(p.ref) && (
                      <>
                        {' '}
                        <Link className="font-semibold text-accent-text hover:underline" to={`/nodes/${p.ref}`}>
                          {t('dns.openNode')}
                        </Link>
                      </>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {state.mode !== 'off' && (
            <Table head={[t('dns.cols.name'), t('dns.cols.type'), t('dns.cols.content'), t('dns.cols.proxy'), t('dns.cols.purpose'), t('fields.status')]} empty={!state.records.length && !state.stale.length ? <p className="px-4 py-6 text-center text-[13px] text-muted">{t('dns.noRecords')}</p> : undefined}>
              {state.records.map((r) => (
                <tr key={`${r.name}-${r.type}-${r.content}`}>
                  <td className="font-mono text-[13px]">{r.name}</td>
                  <td className="font-mono text-[12px] text-muted">{r.type}</td>
                  <td className="max-w-56 truncate font-mono text-[13px]" title={r.content}>
                    {r.content}
                  </td>
                  <td>
                    <span className="inline-flex items-center gap-1 text-[12px]">
                      <Cloud className={`size-3.5 ${r.proxied ? 'text-koraal' : 'text-muted'}`} />
                      {r.proxied ? t('dns.proxied') : t('dns.dnsOnly')}
                    </span>
                  </td>
                  <td className="text-[12px] text-muted">{r.purpose === 'node' && r.ref ? (nodeName(r.ref) ?? t('dns.purpose.node')) : t(`dns.purpose.${r.purpose}`)}</td>
                  <td>
                    <Badge tone={stateTone[r.state]} dot>
                      {t(`dns.state.${r.state}`)}
                    </Badge>
                  </td>
                </tr>
              ))}
              {state.stale.map((r) => (
                <tr key={`stale-${r.name}-${r.type}-${r.content}`} className="opacity-70">
                  <td className="font-mono text-[13px] line-through">{r.name}</td>
                  <td className="font-mono text-[12px] text-muted">{r.type}</td>
                  <td className="font-mono text-[13px]">{r.content}</td>
                  <td />
                  <td />
                  <td>
                    <Badge tone="offline" dot>
                      {t('dns.state.delete')}
                    </Badge>
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </div>
      )}
    </Card>
  );
}

/** The last changes written to the zone (each one is also in the audit log). */
function ChangesCard({ state }: { state: DnsState | undefined }) {
  const { t } = useTranslation();
  if (!state?.lastChanges.length) return null;
  return (
    <Card>
      <CardHeader title={t('dns.changesTitle')} description={state.lastChangeAt ? t('dns.changesWhen', { when: formatRelative(state.lastChangeAt) }) : undefined} />
      <ul className="flex flex-col divide-y divide-line">
        {state.lastChanges
          .slice(-12)
          .reverse()
          .map((c, i) => (
            <li key={i} className="flex flex-wrap items-center gap-2 px-5 py-2 text-[13px]">
              <Badge tone={c.action === 'create' ? 'online' : c.action === 'update' ? 'warning' : 'offline'}>{t(`dns.actions.${c.action}`)}</Badge>
              <span className="font-mono">{c.name}</span>
              <span className="font-mono text-muted">
                {c.type} {c.content}
              </span>
              {c.before && <span className="text-xs text-muted">({t('dns.was', { before: c.before })})</span>}
            </li>
          ))}
      </ul>
    </Card>
  );
}

/**
 * Cloudflare DNS (phase 15): the platform domain's zone, kept up to date by the platform. Only the platform's own
 * domain is touched; customers point CNAME records at the targets made here.
 */
export function DnsPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ['dns', 'settings'], queryFn: () => api<CloudflareSettings>('/dns/settings') });
  const state = useQuery({ queryKey: ['dns', 'state'], queryFn: () => api<DnsState>('/dns/state'), refetchInterval: 15_000 });
  const nodes = useQuery({ queryKey: ['nodes', 'all'], queryFn: () => api<NodeItem[]>('/nodes') });
  const [draft, setDraft] = useState<CloudflareSettings | null>(null);
  const [origin, setOrigin] = useState('');
  const [test, setTest] = useState<DnsTestResult | null>(null);
  useEffect(() => {
    if (settings.data && !draft) {
      setDraft(settings.data);
      setOrigin(settings.data.originAddresses.join(', '));
    }
  }, [settings.data, draft]);

  const save = useMutation({
    mutationFn: (body: CloudflareSettings) => api<CloudflareSettings>('/dns/settings', { method: 'PUT', body }),
    onSuccess: (res) => {
      qc.setQueryData(['dns', 'settings'], res);
      setDraft(res);
      toast.success(t('dns.saved'));
      setTimeout(() => void qc.invalidateQueries({ queryKey: ['dns', 'state'] }), 2500);
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const runTest = useMutation({
    mutationFn: () => api<DnsTestResult>('/dns/test', { method: 'POST', body: { apiToken: draft!.apiToken, domain: draft!.domain || draft!.platformDomain } }),
    onSuccess: (res) => {
      setTest(res);
      if (res.ok) void qc.invalidateQueries({ queryKey: ['dns', 'settings'] });
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const purge = useMutation({
    mutationFn: () => api<DnsState>('/dns/purge', { method: 'POST', body: { confirm: true } }),
    onSuccess: (res) => {
      qc.setQueryData(['dns', 'state'], res);
      toast.success(t('dns.purged'));
    },
    onError: (err) => toast.error((err as Error).message),
  });

  if (!draft) {
    return (
      <div className="grid place-items-center py-20">
        <Spinner />
      </div>
    );
  }
  const set = (patch: Partial<CloudflareSettings>) => setDraft({ ...draft, ...patch });
  const base = draft.domain || draft.platformDomain || 'example.com';
  const labels = ['originLabel', 'streamLabel', 'srcLabel', 'nodeLabel'] as const;
  const labelsOk = labels.every((k) => LABEL_RE.test(draft[k])) && (draft.poolLabel === '' || LABEL_RE.test(draft.poolLabel));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate({
      ...draft,
      originAddresses: origin
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter(Boolean),
    });
  };
  const label = (k: (typeof labels)[number] | 'poolLabel', example: string, hint: string) => (
    <Field label={t(`dns.labels.${k}`)} hint={<span className="font-mono">{example}</span>}>
      <Input
        value={draft[k]}
        aria-invalid={!(draft[k] === '' && k === 'poolLabel') && !LABEL_RE.test(draft[k])}
        placeholder={k === 'poolLabel' ? t('dns.off') : undefined}
        title={hint}
        onChange={(e) => set({ [k]: e.target.value.trim().toLowerCase() } as Partial<CloudflareSettings>)}
      />
    </Field>
  );

  return (
    <>
      <PageHeader title={t('dns.title')} description={t('dns.subtitle')} />
      {settings.data?.mode !== 'off' && (
        <div className="mb-4">
          <RecordsCard state={state.data} nodes={nodes.data ?? []} canRun />
        </div>
      )}
      <div className="grid gap-4 xl:grid-cols-[1.1fr_1fr]">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <Card>
            <CardHeader title={t('dns.connectionTitle')} description={t('dns.connectionSubtitle')} />
            <div className="flex flex-col gap-4 p-5">
              <Segmented
                cols={3}
                value={draft.mode}
                onChange={(mode) => set({ mode })}
                options={(['off', 'dryRun', 'on'] as const).map((m) => ({ value: m, label: t(`dns.modes.${m}`), description: t(`dns.modeHints.${m}`) }))}
              />
              <Field label={t('dns.token')} hint={t('dns.tokenHint')}>
                <Input type="password" autoComplete="off" value={draft.apiToken} onChange={(e) => set({ apiToken: e.target.value.trim() })} placeholder={t('dns.tokenPlaceholder')} />
              </Field>
              <Field label={t('dns.domain')} hint={t('dns.domainHint')}>
                <Input value={draft.domain} onChange={(e) => set({ domain: e.target.value.trim().toLowerCase() })} placeholder={draft.platformDomain || 'onlineradio.example.com'} />
              </Field>
              <div className="flex flex-wrap items-center gap-3">
                <Button type="button" variant="secondary" loading={runTest.isPending} disabled={!draft.apiToken} onClick={() => runTest.mutate()}>
                  <PlugZap className="size-4" /> {t('dns.test')}
                </Button>
                {test &&
                  (test.ok ? (
                    <span className="inline-flex items-center gap-1.5 text-[13px] text-online">
                      <CheckCircle2 className="size-4" /> {t('dns.testOk', { zone: test.zoneName, count: test.records ?? 0 })}
                    </span>
                  ) : (
                    <span className="text-[13px] text-offline">{test.message}</span>
                  ))}
                {!test && draft.zoneName && <span className="text-[13px] text-muted">{t('dns.zoneIs', { zone: draft.zoneName })}</span>}
              </div>
            </div>
          </Card>
          <Card>
            <CardHeader title={t('dns.namesTitle')} description={t('dns.namesSubtitle')} />
            <div className="flex flex-col gap-4 p-5">
              <div className="grid gap-3 sm:grid-cols-2">
                {label('originLabel', `${draft.originLabel || 'origin'}.${base}`, '')}
                {label('poolLabel', draft.poolLabel ? `${draft.poolLabel}.${base}` : t('dns.noPool'), '')}
                {label('streamLabel', `<customer>.${draft.streamLabel || 'stream'}.${base}`, '')}
                {label('srcLabel', `<customer>.${draft.srcLabel || 'src'}.${base}`, '')}
                {label('nodeLabel', `<customer>-studio.${draft.nodeLabel || 'node'}.${base}`, '')}
                <Field label={t('dns.ttl')} hint={t('dns.ttlHint')}>
                  <Input type="number" min={60} max={86400} value={draft.ttl} onChange={(e) => set({ ttl: Number(e.target.value) })} />
                </Field>
              </div>
              <Switch checked={draft.nodeRecords} onChange={(nodeRecords) => set({ nodeRecords })} label={t('dns.nodeRecords')} description={t('dns.nodeRecordsHint', { example: `relay1.${base}` })} />
              <Switch checked={draft.customerTargets} onChange={(customerTargets) => set({ customerTargets })} label={t('dns.customerTargets')} description={t('dns.customerTargetsHint')} />
              <Field label={t('dns.originAddresses')} hint={t('dns.originAddressesHint')}>
                <Input value={origin} onChange={(e) => setOrigin(e.target.value)} placeholder={state.data?.origin.addresses.join(', ') || '203.0.113.10'} />
              </Field>
            </div>
          </Card>
          <Card>
            <CardHeader title={t('dns.proxyTitle')} description={t('dns.proxySubtitle')} />
            <div className="flex flex-col gap-4 p-5">
              <Switch checked={draft.panelRecord.manage} onChange={(manage) => set({ panelRecord: { ...draft.panelRecord, manage } })} label={t('dns.panelRecord', { domain: base })} description={t('dns.panelRecordHint')} />
              {draft.panelRecord.manage && (
                <Switch checked={draft.panelRecord.proxied} onChange={(proxied) => set({ panelRecord: { ...draft.panelRecord, proxied } })} label={t('dns.panelProxied')} description={t('dns.panelProxiedHint')} />
              )}
              <p className="rounded-md bg-chip/60 px-3 py-2 text-xs text-muted">{t('dns.streamsDnsOnly')}</p>
            </div>
          </Card>
          <div className="flex justify-end">
            <Button type="submit" variant="primary" loading={save.isPending} disabled={!labelsOk}>
              <Save className="size-4" /> {t('common.save')}
            </Button>
          </div>
        </form>
        <div className="flex flex-col gap-4">
          <Card className="p-5">
            <h2 className="display text-base">{t('dns.howTitle')}</h2>
            <ul className="mt-2 flex list-disc flex-col gap-1.5 pl-5 text-[13px] text-muted">
              <li>{t('dns.how1', { origin: `${draft.originLabel}.${base}` })}</li>
              <li>{t('dns.how2', { example: `relay1.${base}` })}</li>
              {draft.poolLabel && <li>{t('dns.how3', { pool: `${draft.poolLabel}.${base}`, ttl: draft.ttl })}</li>}
              <li>{t('dns.how4', { stream: `harderfm.${draft.streamLabel}.${base}`, src: `harderfm.${draft.srcLabel}.${base}` })}</li>
              <li>{t('dns.how5')}</li>
            </ul>
          </Card>
          <ChangesCard state={state.data} />
          {draft.mode !== 'on' && (
            <Card className="p-5">
              <h2 className="display text-base">{t('dns.purgeTitle')}</h2>
              <p className="mt-1 text-[13px] text-muted">{t('dns.purgeHint', { install: draft.install ?? '' })}</p>
              <Button className="mt-3" variant="secondary" loading={purge.isPending} disabled={!draft.apiToken} onClick={() => confirm(t('dns.purgeConfirm')) && purge.mutate()}>
                <Trash2 className="size-4 text-offline" /> {t('dns.purge')}
              </Button>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
