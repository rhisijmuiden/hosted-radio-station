import clsx from 'clsx';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { Topology, TopologyCell, TopologyNode } from '../../lib/api';
import { formatMs } from '../nodes/common';
import { Badge } from '../ui';
import { nodeName } from './TopologyFlat';

const CELLS: TopologyCell[] = ['onAir', 'standby', 'degraded', 'down', 'idle'];

const roleOf = (n: TopologyNode) => (n.roles.includes('station') ? 'station' : n.roles.includes('source') ? 'source' : n.roles.includes('relay') ? 'relay' : n.roles.includes('fm') ? 'fm' : null);
const ORDER = { source: 0, station: 1, relay: 2, fm: 3 } as const;

/**
 * Matrix view (phase 18): servers × stations in one table, for large networks. A cell shows what that server does for
 * that station: on air, standby (backup ingest), degraded, down or idle (assigned, nothing playing).
 */
export default function TopologyMatrix({ data, customer, selected, onSelect }: { data: Topology; customer: boolean; selected: string | null; onSelect: (id: string | null) => void }) {
  const { t } = useTranslation();
  const rows = useMemo(
    () =>
      data.nodes
        .filter((n) => roleOf(n) && data.stations.some((s) => s.cells[n.id]))
        .sort((a, b) => ORDER[roleOf(a)!] - ORDER[roleOf(b)!] || Number(b.local) - Number(a.local) || a.name.localeCompare(b.name)),
    [data],
  );
  const stations = useMemo(() => [...data.stations].sort((a, b) => b.listeners - a.listeners || a.name.localeCompare(b.name)), [data]);
  if (!stations.length) return <p className="p-6 text-[13px] text-muted">{t('topology.matrix.empty')}</p>;
  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="border-separate border-spacing-0 text-left text-[13px]">
          <thead className="sticky top-0 z-10 bg-raised">
            <tr>
              <th className="sticky left-0 z-20 min-w-[220px] border-b border-line bg-raised px-4 py-2 text-[11px] font-semibold tracking-[0.06em] text-muted uppercase">{t('topology.matrix.server')}</th>
              <th className="border-b border-line px-3 py-2 text-[11px] font-semibold tracking-[0.06em] text-muted uppercase">{t('topology.matrix.health')}</th>
              {stations.map((s) => (
                <th key={s.id} className="h-32 min-w-11 border-b border-line px-1 align-bottom" title={`${s.name} · ${t('topology.listenersCount', { count: s.listeners })}`}>
                  <div className="mx-auto w-5 [writing-mode:vertical-rl] rotate-180 truncate text-[12px] font-semibold whitespace-nowrap">{s.name}</div>
                  <div className="mt-1 text-center text-[10px] font-normal text-muted tabular-nums">{s.listeners}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((n) => {
              const role = roleOf(n)!;
              const active = selected === n.id;
              return (
                <tr key={n.id} className={clsx('cursor-pointer hover:bg-hover', active && 'bg-chip')} onClick={() => onSelect(active ? null : n.id)}>
                  <td className={clsx('sticky left-0 border-b border-line px-4 py-2', active ? 'bg-chip' : 'bg-raised')}>
                    <div className="flex items-center gap-2">
                      <b className="truncate">{nodeName(t, n, customer)}</b>
                      <Badge>{role === 'fm' ? 'FM' : t(`topology.tags.${role === 'source' ? 'ingest' : role}`)}</Badge>
                    </div>
                    {(n.hostname || n.ip) && <div className="font-mono text-[11px] text-muted">{[n.hostname, n.ip].filter(Boolean).join(' · ')}</div>}
                  </td>
                  <td className="border-b border-line px-3 py-2 text-[12px] whitespace-nowrap text-muted tabular-nums">
                    <span className={clsx('mr-1.5 inline-block size-2 rounded-full', !n.online ? 'bg-offline' : n.degraded ? 'bg-warning' : 'bg-online')} />
                    {!n.online ? t('nodes.health.offline') : role === 'relay' || role === 'fm' ? t('topology.listenersCount', { count: n.listeners }) : n.local ? t('topology.encodersCount', { count: n.encoders }) : formatMs(n.rttMs)}
                  </td>
                  {stations.map((s) => {
                    const c = s.cells[n.id];
                    return (
                      <td key={s.id} className="border-b border-line px-1 py-2 text-center" title={c ? `${s.name} · ${t(`topology.cells.${c}`)}` : undefined}>
                        {c ? <i className={clsx('topo-cell', c)} /> : <span className="text-line">·</span>}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap gap-3 border-t border-line px-4 py-2.5 text-xs text-muted">
        {CELLS.map((c) => (
          <span key={c} className="flex items-center gap-1.5">
            <i className={clsx('topo-cell', c)} /> {t(`topology.cells.${c}`)}
          </span>
        ))}
      </div>
    </div>
  );
}
