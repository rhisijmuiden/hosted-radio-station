import clsx from 'clsx';
import { Activity, Building2, Cpu, Radio, RadioTower, Server, ServerOff } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import type { NodeItem, NodeRole } from '../../lib/api';
import { useSystemInfo } from '../InfoDialog';
import { Card } from '../ui';
import { nodeHealth, type NodeHealth } from './common';

type Group = NodeRole | 'none';
// In the order the audio flows: what takes it in, what carries it, what puts it on air; then what watches it all.
const GROUPS: Group[] = ['source', 'station', 'relay', 'fm', 'monitor', 'none'];
const ICONS: Record<Group, ReactNode> = { source: <Server />, station: <Building2 />, relay: <Radio />, fm: <RadioTower />, monitor: <Activity />, none: <ServerOff /> };
const DOT: Record<NodeHealth, string> = { online: 'bg-online', degraded: 'bg-warning', offline: 'bg-offline', unpaired: 'bg-muted/50' };

/**
 * The network at a glance: the orchestrator on top, the nodes below it grouped by role. The orchestrator only steers
 * them (dashed lines); it carries no audio.
 */
export function NodeHierarchy({ nodes, warnMs }: { nodes: NodeItem[]; warnMs: number }) {
  const { t } = useTranslation();
  const info = useSystemInfo().data;
  const groups = GROUPS.map((g) => ({ g, list: nodes.filter((n) => (g === 'none' ? !n.roles.length : n.roles.includes(g))) })).filter((x) => x.list.length);
  if (!groups.length) return null;
  const online = nodes.filter((n) => n.status.online).length;
  const cols = { 1: 'lg:grid-cols-1', 2: 'lg:grid-cols-2', 3: 'lg:grid-cols-3', 4: 'lg:grid-cols-4', 5: 'lg:grid-cols-5', 6: 'lg:grid-cols-6' }[groups.length];

  return (
    <Card className="mb-4 p-5">
      <div className="flex flex-col items-center">
        <div className="flex items-center gap-3 rounded-lg border border-lucht/60 bg-lucht/8 px-4 py-2.5 shadow-sm">
          <span className="grid size-9 place-items-center rounded-md bg-nacht text-koraal [&_svg]:size-4.5">
            <Cpu />
          </span>
          <span className="min-w-0">
            <b className="block text-sm">{info?.server.name ?? t('topology.main')}</b>
            <small className="block text-[11.5px] text-muted">
              {t('topology.orchestrator')} · {info?.server.orchestratorOnly ? t('orchestratorOnly.badgeOn') : t('topology.controlOnly')}
              {info ? ` · v${info.version}` : ''} · {t('nodes.tree.online', { up: online, total: nodes.filter((n) => n.paired).length })}
            </small>
          </span>
        </div>
        {/* Control lines: dashed, so they never read as audio. */}
        <span className="h-5 border-l-2 border-dashed border-lucht/70" />
      </div>
      <div className={clsx('relative grid gap-3 sm:grid-cols-2', cols)}>
        {groups.length > 1 && (
          <span
            className="absolute top-0 hidden border-t-2 border-dashed border-lucht/70 lg:block"
            style={{ left: `${50 / groups.length}%`, right: `${50 / groups.length}%` }}
          />
        )}
        {groups.map(({ g, list }) => {
          const up = list.filter((n) => n.status.online).length;
          return (
            <div key={g} className="flex min-w-0 flex-col items-stretch">
              <span className="mx-auto hidden h-4 border-l-2 border-dashed border-lucht/70 lg:block" />
              <div className="flex min-w-0 flex-col gap-1.5 rounded-lg border border-line bg-surface/60 p-2.5">
                <div className="flex items-center gap-2 px-1 pb-1">
                  <span className="text-accent-text [&_svg]:size-4">{ICONS[g]}</span>
                  <b className="min-w-0 flex-1 truncate text-[13px]">{g === 'none' ? t('nodes.noRoles') : t(`nodes.tree.groups.${g}`)}</b>
                  <small className={clsx('text-[11.5px] tabular-nums', up < list.length ? 'text-warning' : 'text-muted')}>
                    {up}/{list.length}
                  </small>
                </div>
                {list.map((n) => {
                  const health = nodeHealth(n, warnMs);
                  return (
                    <Link key={n.id} to={`/nodes/${n.id}`} className="flex min-w-0 items-center gap-2 rounded-md border border-line bg-raised px-2.5 py-1.5 transition-colors hover:bg-hover" title={t(`nodes.health.${health}`)}>
                      <span className={clsx('size-2 shrink-0 rounded-full', DOT[health])} />
                      <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold">{n.name}</span>
                      {n.location && <span className="max-w-[45%] truncate text-[11px] text-muted">{n.location}</span>}
                    </Link>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      <p className="mt-3 text-center text-[11.5px] text-muted">{t('topology.orchestratorHint')}</p>
    </Card>
  );
}
