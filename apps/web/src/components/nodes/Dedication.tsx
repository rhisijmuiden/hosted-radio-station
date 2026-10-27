import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { NodeConfig, NodeDedication, NodeItem, NodeRole, NodeScope, StationListItem } from '../../lib/api';
import { Badge, Card, CardHeader, Field, Segmented, Select } from '../ui';

type Scoped = Pick<NodeItem, 'id' | 'tenantId'> & { roles: NodeRole[]; config: Pick<NodeConfig, 'dedication' | 'dedicatedTenantId' | 'dedicatedStationId'> };

/** Who a node serves with these settings; the same rules as the API (services/nodes/dedication.ts). */
export function scopeOf(n: Scoped): NodeScope {
  const c = n.config;
  const none: NodeScope = { kind: 'none', tenantId: null, stationId: null };
  if (c.dedication === 'station') return c.dedicatedStationId ? { kind: 'station', tenantId: null, stationId: c.dedicatedStationId } : none;
  if (n.tenantId) return { kind: 'customer', tenantId: n.tenantId, stationId: null };
  if (c.dedication === 'customer') return c.dedicatedTenantId ? { kind: 'customer', tenantId: c.dedicatedTenantId, stationId: null } : none;
  if ((c.dedication ?? 'auto') === 'auto' && n.roles.includes('station')) return { kind: 'placed', tenantId: null, stationId: null };
  return { kind: 'shared', tenantId: null, stationId: null };
}

/** The node may carry, show and serve this station. */
export function serves(n: Scoped, s: Pick<StationListItem, 'id' | 'tenantId' | 'nodeId'>): boolean {
  const sc = scopeOf(n);
  if (sc.kind === 'shared') return true;
  if (sc.kind === 'customer') return sc.tenantId === s.tenantId;
  if (sc.kind === 'station') return sc.stationId === s.id;
  if (sc.kind === 'placed') return s.nodeId === n.id;
  return false;
}

/** A short label for lists: Shared, or the customer or station it is dedicated to. */
export function ScopeBadge({ scope, stations }: { scope: NodeScope; stations?: StationListItem[] }) {
  const { t } = useTranslation();
  if (scope.kind === 'shared') return <Badge>{t('nodes.dedication.badge.shared')}</Badge>;
  const station = scope.stationId ? stations?.find((s) => s.id === scope.stationId)?.name : null;
  const customer = scope.tenantId ? stations?.find((s) => s.tenantId === scope.tenantId)?.tenantName : null;
  return <Badge tone="accent">{station ?? customer ?? t(`nodes.dedication.badge.${scope.kind === 'placed' ? 'placed' : 'dedicated'}`)}</Badge>;
}

/**
 * Shared or dedicated (1.1.1): a shared node carries stations of every customer; a dedicated node only those of one
 * customer or one station. Relay and ingest nodes of the platform are shared by default, a customer's own node and a
 * station node are dedicated.
 */
export function DedicationCard({
  node,
  roles,
  value,
  onChange,
  stations,
}: {
  node: NodeItem;
  roles: NodeRole[];
  value: NodeConfig;
  onChange: (patch: Partial<NodeConfig>) => void;
  stations: StationListItem[];
}) {
  const { t } = useTranslation();
  const own = !!node.tenantId;
  const customers = useMemo(() => [...new Map(stations.map((s) => [s.tenantId, s.tenantName])).entries()].sort((a, b) => a[1].localeCompare(b[1])), [stations]);
  const mine = own ? stations.filter((s) => s.tenantId === node.tenantId) : stations;
  const auto = scopeOf({ id: node.id, tenantId: node.tenantId, roles, config: { ...value, dedication: 'auto' } });
  const autoText = auto.kind === 'customer' ? t('nodes.dedication.autoOwn') : auto.kind === 'placed' ? t('nodes.dedication.autoPlaced') : t('nodes.dedication.autoShared');
  const options: { value: NodeDedication; label: string; description: string }[] = [
    { value: 'auto', label: t('nodes.dedication.auto'), description: autoText },
    ...(own ? [] : [{ value: 'shared' as const, label: t('nodes.dedication.shared'), description: t('nodes.dedication.sharedHint') }]),
    ...(own ? [] : [{ value: 'customer' as const, label: t('nodes.dedication.customer'), description: t('nodes.dedication.customerHint') }]),
    { value: 'station', label: t('nodes.dedication.station'), description: t('nodes.dedication.stationHint') },
  ];
  const mode = own && (value.dedication === 'shared' || value.dedication === 'customer') ? 'auto' : value.dedication;
  return (
    <Card>
      <CardHeader title={t('nodes.dedication.title')} description={t('nodes.dedication.hint')} />
      <div className="flex flex-col gap-4 p-5">
        <Segmented value={mode} onChange={(dedication) => onChange({ dedication })} options={options} />
        {mode === 'customer' && (
          <Field label={t('nodes.dedication.pickCustomer')}>
            <Select value={value.dedicatedTenantId ?? ''} onChange={(e) => onChange({ dedicatedTenantId: e.target.value || null })}>
              <option value="">{t('nodes.dedication.choose')}</option>
              {customers.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {mode === 'station' && (
          <Field label={t('nodes.dedication.pickStation')}>
            <Select value={value.dedicatedStationId ?? ''} onChange={(e) => onChange({ dedicatedStationId: e.target.value || null })}>
              <option value="">{t('nodes.dedication.choose')}</option>
              {mine.map((s) => (
                <option key={s.id} value={s.id}>
                  {own ? s.name : `${s.name} · ${s.tenantName}`}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <p className="text-xs text-muted">{t('nodes.dedication.routing')}</p>
      </div>
    </Card>
  );
}
