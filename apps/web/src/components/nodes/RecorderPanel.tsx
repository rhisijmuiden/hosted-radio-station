import { useQuery } from '@tanstack/react-query';
import { Disc3, HardDrive } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { api, type NodeConfig, type NodeItem, type RecorderState, type StationListItem } from '../../lib/api';
import { formatBytes, formatRelative } from '../../lib/format';
import { Badge, Button, Card, CardHeader, Table } from '../ui';

export const recorderTone: Record<RecorderState, 'online' | 'warning' | 'offline' | 'neutral'> = { recording: 'online', starting: 'warning', waiting: 'warning', error: 'offline' };

/** How full the recorder's disk is, as a bar. */
export function DiskBar({ disk }: { disk: { totalBytes: number; freeBytes: number } }) {
  const { t } = useTranslation();
  const used = disk.totalBytes ? 1 - disk.freeBytes / disk.totalBytes : 0;
  return (
    <div>
      <div className="mb-1 flex justify-between text-[12px]">
        <span className="flex items-center gap-1.5 text-muted [&_svg]:size-3.5">
          <HardDrive /> {t('nodes.recorder.disk')}
        </span>
        <span className="font-semibold tabular-nums">{t('nodes.recorder.diskFree', { free: formatBytes(disk.freeBytes), total: formatBytes(disk.totalBytes) })}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-line/60">
        <div className={used > 0.9 ? 'h-full bg-offline' : used > 0.75 ? 'h-full bg-warning' : 'h-full bg-online'} style={{ width: `${Math.round(used * 100)}%` }} />
      </div>
    </div>
  );
}

/** Overview of a recorder node (phase 21): what it records per station right now, and its disk. */
export function RecorderOverview({ node }: { node: NodeItem }) {
  const { t } = useTranslation();
  const stations = useQuery({ queryKey: ['stations', 'all'], queryFn: () => api<StationListItem[]>('/stations') });
  const rec = node.status.recorder;
  const name = (id: string) => stations.data?.find((s) => s.id === id)?.name ?? id.slice(0, 8);
  return (
    <Card>
      <CardHeader title={t('nodes.recorder.title')} description={t('nodes.recorder.hint')} />
      {rec?.disk && (
        <div className="px-5 pb-3">
          <DiskBar disk={rec.disk} />
        </div>
      )}
      {!rec?.stations.length ? (
        <div className="px-5 py-8 text-center text-[13px] text-muted">{!node.status.online ? t('nodes.recorder.offline') : node.config.recordStations === 'all' || node.config.recordStations.length ? t('nodes.recorder.nothingYet') : t('nodes.recorder.noStations')}</div>
      ) : (
        <Table head={[t('nodes.recorder.station'), t('nodes.recorder.what'), t('fields.status'), t('nodes.recorder.since')]}>
          {rec.stations.map((s) => (
            <tr key={`${s.stationId}-${s.kind}`}>
              <td className="text-[13px] font-semibold">
                <Link to={`/stations/${s.stationId}?tab=recordings`} className="hover:underline">
                  {name(s.stationId)}
                </Link>
              </td>
              <td className="text-[13px]">{t(`nodes.recorder.kinds.${s.kind}`)}</td>
              <td title={s.message}>
                <Badge tone={recorderTone[s.state]} dot>
                  {t(`nodes.recorder.states.${s.state}`)}
                </Badge>
                {s.message && s.state !== 'recording' && <span className="ml-2 text-xs text-muted">{s.message}</span>}
              </td>
              <td className="text-[13px] text-muted">{formatRelative(s.since)}</td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
}

/** Settings of a recorder node: the stations it records. Each station sets its own bitrate and retention. */
export function RecorderSettingsCard({ node, value, onChange, stations, allLabel }: { node: NodeItem; value: NodeConfig; onChange: (patch: Partial<NodeConfig>) => void; stations: StationListItem[]; allLabel: string }) {
  const { t } = useTranslation();
  const selected = value.recordStations === 'all' ? null : new Set(value.recordStations);
  return (
    <Card>
      <CardHeader title={t('nodes.recorder.settings')} description={t('nodes.recorder.settingsHint')} />
      <div className="flex flex-col gap-3 p-5">
        <div className="flex gap-2">
          <Button size="sm" type="button" variant={selected ? 'secondary' : 'dark'} onClick={() => onChange({ recordStations: 'all' })}>
            {allLabel}
          </Button>
          <Button size="sm" type="button" variant={selected ? 'dark' : 'secondary'} onClick={() => onChange({ recordStations: selected ? [...selected] : [] })}>
            {t('nodes.fields.someStations')}
          </Button>
        </div>
        {selected && (
          <div className="grid max-h-64 gap-1 overflow-y-auto rounded-md border border-line p-2 sm:grid-cols-2">
            {stations.map((s) => (
              <label key={s.id} className="flex items-center gap-2 rounded px-2 py-1.5 text-[13px] hover:bg-hover">
                <input
                  type="checkbox"
                  className="accent-[var(--koraal)]"
                  checked={selected.has(s.id)}
                  onChange={(e) => onChange({ recordStations: e.target.checked ? [...selected, s.id] : [...selected].filter((x) => x !== s.id) })}
                />
                <Disc3 className="size-3.5 text-muted" />
                <span className="truncate">{s.name}</span>
                {!node.tenantId && <span className="truncate text-xs text-muted">{s.tenantName}</span>}
              </label>
            ))}
            {!stations.length && <p className="px-2 py-1 text-xs text-muted">{t('nodes.fields.noStations')}</p>}
          </div>
        )}
        <p className="text-xs text-muted">{t('nodes.recorder.perStation')}</p>
      </div>
    </Card>
  );
}
