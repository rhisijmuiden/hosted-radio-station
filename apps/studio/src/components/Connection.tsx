import { Globe, Network, Server } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useStationDetail } from '../lib/queries';
import { useLink, viaLabel, type Ingest, type LinkMode } from '../lib/link';
import { useSession } from '../lib/session';
import { updateSettings, useSettings } from '../lib/settings';
import { Badge, Card, CardHeader, Field, Input, Select, Switch } from './ui';

function Address({ icon, label, to, state, inUse }: { icon: ReactNode; label: string; to: Ingest | null; state?: ReactNode; inUse: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-3 rounded-md border border-line px-3 py-2.5">
      <span className="text-muted">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="text-[11px] tracking-[0.06em] text-muted uppercase">{label}</div>
        <div className="truncate font-mono text-[13px]">{to ? `${to.host}:${to.port}` : t('link.unknown')}</div>
      </div>
      {to && (to.tls ? <Badge tone="online">TLS</Badge> : <Badge>{t('live.plain')}</Badge>)}
      {state}
      {inUse && <Badge tone="accent">{t('link.inUse')}</Badge>}
    </div>
  );
}

/**
 * Settings › Connection (phase 17 step 7): where Go Live connects. For a station on a station node it shows the node's
 * studio network and internet address, whether the studio network answers, and takes a manual address.
 */
export function ConnectionCard() {
  const { t } = useTranslation();
  const { station } = useSession();
  const { live } = useSettings();
  const detail = useStationDetail(station?.id);
  const { links, reachable, picked, mode } = useLink(detail.data);
  const setLive = (patch: Partial<typeof live>) => updateSettings((s) => ({ live: { ...s.live, ...patch } }));
  const setManual = (patch: Partial<typeof live.manual>) => setLive({ manual: { ...live.manual, ...patch } });
  const onNode = !!links?.node;

  return (
    <Card>
      <CardHeader title={t('link.title')} description={onNode ? t('link.textNode', { node: links.node!.name }) : t('link.textMain')} />
      <div className="flex flex-col gap-3 px-5 py-4">
        {onNode ? (
          <>
            <Address
              icon={<Network className="size-4" />}
              label={t('link.via.internal')}
              to={links.internal}
              inUse={picked?.via === 'internal'}
              state={links.internal && (reachable === undefined ? <Badge>{t('link.checking')}</Badge> : reachable ? <Badge tone="online" dot>{t('link.reachable')}</Badge> : <Badge tone="warning" dot>{t('link.unreachable')}</Badge>)}
            />
            <Address icon={<Globe className="size-4" />} label={t('link.via.external')} to={links.external} inUse={picked?.via === 'external'} />
          </>
        ) : (
          <Address icon={<Server className="size-4" />} label={t('link.via.main')} to={links?.main ?? null} inUse={picked?.via === 'main'} />
        )}
        <Field label={t('link.mode')} hint={t(`link.modeHint.${mode}`)}>
          <Select value={mode} onChange={(e) => setLive({ link: e.target.value as LinkMode })}>
            {(onNode ? (['auto', 'internal', 'external', 'manual'] as const) : (['auto', 'manual'] as const)).map((m) => (
              <option key={m} value={m}>
                {t(`link.modes.${m}`)}
              </option>
            ))}
          </Select>
        </Field>
        {mode === 'manual' && (
          <div className="grid grid-cols-[1fr_120px] gap-3">
            <Field label={t('link.host')}>
              <Input value={live.manual.host} onChange={(e) => setManual({ host: e.target.value })} placeholder="10.0.0.20" className="font-mono" />
            </Field>
            <Field label={t('link.port')}>
              <Input type="number" min={1} max={65535} value={live.manual.port} onChange={(e) => setManual({ port: Number(e.target.value) })} className="font-mono" />
            </Field>
            <div className="col-span-2">
              <Switch checked={live.manual.tls} onChange={(v) => setManual({ tls: v })} label={t('link.tls')} description={t('link.tlsHint')} />
            </div>
          </div>
        )}
        <p className="text-[13px] text-muted">
          {picked ? t('link.now', { via: viaLabel(t, picked.via, mode), address: `${picked.to.host}:${picked.to.port}` }) : t('link.none')}
        </p>
      </div>
    </Card>
  );
}
