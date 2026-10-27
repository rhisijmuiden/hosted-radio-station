import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Save } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { RoleBadges } from '../components/nodes/common';
import { Badge, Button, Card, CardHeader, Input, PageHeader, Spinner } from '../components/ui';
import { api, type ServerNames } from '../lib/api';

/** Letters, digits, spaces and . _ - ·, at most 40 characters (the same rule as the server). */
const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._·-]*$/u;
const valid = (v: string, optional: boolean) => (optional && v.trim() === '') || (v.trim().length <= 40 && NAME_RE.test(v.trim()));

function Row({ badges, children, host }: { badges: React.ReactNode; children: React.ReactNode; host: React.ReactNode }) {
  return (
    <div className="grid items-center gap-2 border-t border-line py-3 first:border-t-0 sm:grid-cols-[200px_1fr_190px] sm:gap-4">
      <div className="flex flex-wrap gap-1.5">{badges}</div>
      <div>{children}</div>
      <div className="text-xs text-muted">{host}</div>
    </div>
  );
}

/**
 * Names (phase 18): one name per server, used everywhere: topology, node list, routing, statistics and e-mails. This
 * server and its own roles are named after it unless named here; a node's role is a badge, never part of its name.
 */
export function ServerNamesPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const names = useQuery({ queryKey: ['nodes', 'names'], queryFn: () => api<ServerNames>('/nodes/names') });
  const [draft, setDraft] = useState<{ orchestrator: string; ingest: string; relay: string; nodes: Record<string, string> } | null>(null);
  useEffect(() => {
    if (names.data && !draft) setDraft({ orchestrator: names.data.orchestrator.name, ingest: names.data.ingest.name, relay: names.data.relay.name, nodes: Object.fromEntries(names.data.nodes.map((n) => [n.id, n.name])) });
  }, [names.data, draft]);
  const save = useMutation({
    mutationFn: () =>
      api<ServerNames>('/nodes/names', {
        method: 'PUT',
        body: {
          orchestrator: draft!.orchestrator.trim(),
          ingest: draft!.ingest.trim(),
          relay: draft!.relay.trim(),
          nodes: Object.entries(draft!.nodes).map(([id, name]) => ({ id, name: name.trim() })),
        },
      }),
    onSuccess: (res) => {
      qc.setQueryData(['nodes', 'names'], res);
      void qc.invalidateQueries({ queryKey: ['nodes'] });
      void qc.invalidateQueries({ queryKey: ['topology'] });
      void qc.invalidateQueries({ queryKey: ['system-info'] });
      toast.success(t('names.saved'));
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const d = names.data;
  if (!d || !draft)
    return (
      <div className="grid place-items-center py-20">
        <Spinner />
      </div>
    );
  // What this server's roles are called while their own field is empty.
  const orch = draft.orchestrator.trim() || d.orchestrator.default;
  const all = [orch, draft.ingest.trim() || `${orch} · ingest`, draft.relay.trim() || `${orch} · relay`, ...Object.values(draft.nodes).map((n) => n.trim())].map((n) => n.toLowerCase());
  const dup = (v: string) => all.filter((x) => x === v.trim().toLowerCase()).length > 1;
  const ok = valid(draft.orchestrator, true) && valid(draft.ingest, true) && valid(draft.relay, true) && Object.values(draft.nodes).every((n) => valid(n, false)) && new Set(all).size === all.length;
  const field = (value: string, onChange: (v: string) => void, placeholder?: string, optional = false) => (
    <Input value={value} placeholder={placeholder} maxLength={40} aria-invalid={!valid(value, optional) || (!!value.trim() && dup(value))} className={!valid(value, optional) || (!!value.trim() && dup(value)) ? 'border-offline' : undefined} onChange={(e) => onChange(e.target.value)} />
  );

  return (
    <>
      <Link to="/nodes" className="mb-3 inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-ink">
        <ArrowLeft className="size-4" /> {t('nav.nodes')}
      </Link>
      <PageHeader
        title={t('names.title')}
        description={t('names.subtitle')}
        actions={
          <Button variant="primary" disabled={!ok} loading={save.isPending} onClick={() => save.mutate()}>
            <Save className="size-4" /> {t('names.save')}
          </Button>
        }
      />
      <Card className="mb-4">
        <CardHeader title={t('names.thisServer')} description={t('names.thisServerHint')} />
        <div className="px-5 py-2">
          <Row badges={<Badge tone="accent">{t('topology.orchestrator')}</Badge>} host={<span className="font-mono">{d.orchestrator.host}</span>}>
            {field(draft.orchestrator, (orchestrator) => setDraft({ ...draft, orchestrator }), d.orchestrator.default, true)}
          </Row>
          <Row badges={<Badge>{t('names.localIngest')}</Badge>} host={t('names.defaultIs', { name: `${orch} · ingest` })}>
            {field(draft.ingest, (ingest) => setDraft({ ...draft, ingest }), `${orch} · ingest`, true)}
          </Row>
          <Row badges={<Badge>{t('names.localRelay')}</Badge>} host={t('names.defaultIs', { name: `${orch} · relay` })}>
            {field(draft.relay, (relay) => setDraft({ ...draft, relay }), `${orch} · relay`, true)}
          </Row>
        </div>
      </Card>
      <Card>
        <CardHeader title={t('names.nodes')} description={t('names.nodesHint')} />
        <div className="px-5 py-2">
          {!d.nodes.length && <p className="py-4 text-[13px] text-muted">{t('nodes.empty')}</p>}
          {d.nodes.map((n) => (
            <Row
              key={n.id}
              badges={<RoleBadges roles={n.roles} />}
              host={
                <>
                  <span className="font-mono">{[n.hostname, n.ip].filter(Boolean).join(' · ') || '—'}</span>
                  {n.tenantName && <span className="block">{n.tenantName}</span>}
                </>
              }
            >
              {field(draft.nodes[n.id] ?? '', (v) => setDraft({ ...draft, nodes: { ...draft.nodes, [n.id]: v } }))}
            </Row>
          ))}
        </div>
        <p className="border-t border-line px-5 py-3 text-xs text-muted">{t('names.rules')}</p>
      </Card>
    </>
  );
}
