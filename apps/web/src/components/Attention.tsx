import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { ArrowRight, CheckCircle2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { api, type BackupTarget, type NodeRegistration, type StationListItem, type Topology } from '../lib/api';
import { isAdmin, useMe } from '../lib/auth';
import { useSystemInfo } from './InfoDialog';
import { stationTabHref } from './station/menu';
import { Card, CardHeader } from './ui';

interface Item {
  key: string;
  tone: 'offline' | 'warning' | 'muted';
  text: string;
  to: string;
  action: string;
}

const order = { offline: 0, warning: 1, muted: 2 };

/**
 * "Needs attention" at the top of the dashboard (phase 19): what someone has to look at now, each one click away.
 * Admins see the whole platform; customers see their own stations and nodes.
 */
export function AttentionCard() {
  const { t } = useTranslation();
  const me = useMe().data!;
  const admin = isAdmin(me);
  const notDj = admin || me.memberships.some((m) => m.role !== 'dj');
  const pending = useQuery({ queryKey: ['nodes', 'pending'], queryFn: () => api<NodeRegistration[]>('/nodes/pending'), enabled: admin, refetchInterval: 30_000 });
  const backups = useQuery({ queryKey: ['backup-targets'], queryFn: () => api<BackupTarget[]>('/backups/targets'), enabled: admin });
  const stations = useQuery({ queryKey: ['stations', 'all'], queryFn: () => api<StationListItem[]>('/stations'), refetchInterval: 15_000 });
  const topo = useQuery({ queryKey: ['topology', undefined], queryFn: () => api<Topology>('/nodes/topology'), enabled: notDj, refetchInterval: 15_000 });
  const info = useSystemInfo();

  const items: Item[] = [];
  if (pending.data?.length) items.push({ key: 'pending', tone: 'offline', text: t('attention.pendingNodes', { count: pending.data.length }), to: '/nodes', action: t('nav.nodes') });
  for (const n of topo.data?.nodes ?? []) {
    if (n.local || !n.paired || (!admin && !n.own)) continue;
    if (!n.online) items.push({ key: `node:${n.id}`, tone: 'offline', text: t('attention.nodeOffline', { name: n.name }), to: `/nodes/${n.id}`, action: t('attention.open') });
    else if (n.degraded) items.push({ key: `node:${n.id}`, tone: 'warning', text: t('attention.nodeDegraded', { name: n.name }), to: `/nodes/${n.id}`, action: t('attention.open') });
  }
  for (const s of topo.data?.stations ?? []) {
    if (!s.relays.length) {
      items.push({ key: `route:${s.id}`, tone: 'offline', text: t('attention.noRelays', { station: s.name }), to: stationTabHref(s.id, 'routing'), action: t('delivery.title') });
      continue;
    }
    const bad = s.relays.filter((id) => s.cells[id] === 'down' || s.cells[id] === 'degraded');
    if (!bad.length) continue;
    const names = bad.map((id) => topo.data!.nodes.find((n) => n.id === id)?.name ?? id).join(', ');
    items.push({ key: `route:${s.id}`, tone: bad.length === s.relays.length ? 'offline' : 'warning', text: t('attention.routeProblem', { station: s.name, relays: names }), to: stationTabHref(s.id, 'routing'), action: t('delivery.title') });
  }
  for (const s of stations.data ?? []) {
    // A Radio station plays its AutoDJ around the clock, so silence there is a problem. A Distribution station is
    // only on air while someone broadcasts.
    if (s.enabled && s.edition === 'station' && !s.onAir) items.push({ key: `air:${s.id}`, tone: 'warning', text: t('attention.offAir', { station: s.name }), to: `/stations/${s.id}`, action: t('attention.open') });
  }
  for (const b of backups.data ?? []) if (b.lastRun?.state === 'failed') items.push({ key: `backup:${b.id}`, tone: 'warning', text: t('attention.backupFailed', { name: b.name }), to: '/settings/backups', action: t('nav.backups') });
  if (admin && info.data?.lastCheck?.updateAvailable) items.push({ key: 'update', tone: 'muted', text: t('attention.update'), to: '/settings/updates', action: t('nav.updates') });
  items.sort((a, b) => order[a.tone] - order[b.tone]);

  const loading = stations.isPending || (notDj && topo.isPending);
  return (
    <Card className="mb-4">
      <CardHeader title={t('attention.title')} actions={!loading && !!items.length && <span className="text-xs text-muted">{t('attention.count', { count: items.length })}</span>} />
      {loading ? (
        <p className="px-5 py-4 text-[13px] text-muted">…</p>
      ) : !items.length ? (
        <p className="flex items-center gap-2 px-5 py-4 text-[13px] text-muted">
          <CheckCircle2 className="size-4 text-online" /> {t('attention.allGood')}
        </p>
      ) : (
        <ul>
          {items.slice(0, 8).map((i) => (
            <li key={i.key} className="border-t border-line first:border-t-0">
              <Link to={i.to} className="flex items-center gap-3 px-5 py-2.5 hover:bg-hover">
                <span className={clsx('size-2 shrink-0 rounded-full', i.tone === 'offline' ? 'bg-offline' : i.tone === 'warning' ? 'bg-warning' : 'bg-muted')} />
                <span className="min-w-0 flex-1 text-[13.5px]">{i.text}</span>
                <span className="hidden shrink-0 items-center gap-1 text-xs text-muted sm:inline-flex">
                  {i.action} <ArrowRight className="size-3.5" />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
