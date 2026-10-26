import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { ArrowDownRight, ArrowUpRight, Download, Globe2, Headphones, Laptop, Monitor, Radio, Smartphone, Speaker, Tablet, Tv, Car, Bot, HelpCircle } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import { api, type BreakdownRow, type ListenerSession, type Place, type StatsLive, type StatsProgramme, type StatsReport } from '../../lib/api';
import { formatDate, formatRelative } from '../../lib/format';
import { Badge, Button, Card, CardHeader, Input, Select, Spinner, Table, Tabs } from '../ui';
import { AreaChart, BarList, ChartLegend, ColumnChart, Heatmap, Sparkline, type BarRow } from './charts';
import { WorldMap } from './WorldMap';

export type StatsTab = 'live' | 'overview' | 'audience' | 'technology' | 'programme' | 'listeners';
type Preset = 'today' | '24h' | '7d' | '30d' | '90d' | '12m' | 'custom';
const PRESETS: Preset[] = ['today', '24h', '7d', '30d', '90d', '12m', 'custom'];

export interface StatsScope {
  stationId?: string;
  tenantId?: string;
}

const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

/** Start and end of a preset, computed when the data is fetched (so "last 24 hours" keeps moving). */
function rangeOf(preset: Preset, customFrom: string, customTo: string) {
  const now = new Date();
  const to = new Date(Math.ceil((now.getTime() + 1) / 60_000) * 60_000);
  const day = 86400_000;
  switch (preset) {
    case 'today': {
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      return { from: start, to };
    }
    case '24h':
      return { from: new Date(to.getTime() - day), to };
    case '7d':
      return { from: new Date(to.getTime() - 7 * day), to };
    case '30d':
      return { from: new Date(to.getTime() - 30 * day), to };
    case '90d':
      return { from: new Date(to.getTime() - 90 * day), to };
    case '12m':
      return { from: new Date(to.getTime() - 365 * day), to };
    case 'custom': {
      const from = customFrom ? new Date(`${customFrom}T00:00:00`) : new Date(to.getTime() - 7 * day);
      const end = customTo ? new Date(new Date(`${customTo}T00:00:00`).getTime() + day) : to;
      return { from, to: end > from ? end : new Date(from.getTime() + day) };
    }
  }
}

function query(scope: StatsScope, extra: Record<string, string | undefined> = {}) {
  const q = new URLSearchParams();
  if (scope.stationId) q.set('stationId', scope.stationId);
  else if (scope.tenantId) q.set('tenantId', scope.tenantId);
  for (const [k, v] of Object.entries(extra)) if (v) q.set(k, v);
  return q.toString();
}

function useFormat() {
  const { t, i18n } = useTranslation();
  return useMemo(() => {
    const lang = i18n.language;
    const regions = new Intl.DisplayNames([lang], { type: 'region' });
    const n0 = new Intl.NumberFormat(lang, { maximumFractionDigits: 0 });
    const n1 = new Intl.NumberFormat(lang, { maximumFractionDigits: 1 });
    const country = (code: string | null | undefined) => {
      if (!code) return t('stats.unknownPlace');
      try {
        return regions.of(code) ?? code;
      } catch {
        return code;
      }
    };
    const flag = (code: string | null | undefined) =>
      code && /^[A-Z]{2}$/.test(code) ? String.fromCodePoint(...[...code].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65)) : '🌐';
    const duration = (s: number) => {
      if (s < 60) return `${Math.round(s)}s`;
      const m = Math.round(s / 60);
      if (m < 60) return `${m} min`;
      return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
    };
    return { country, flag, duration, n0: (v: number) => n0.format(v), n1: (v: number) => n1.format(v), lang };
  }, [i18n.language, t]);
}

const deviceIcons: Record<string, typeof Laptop> = { desktop: Monitor, mobile: Smartphone, tablet: Tablet, speaker: Speaker, tv: Tv, car: Car, bot: Bot, other: HelpCircle };

function Kpi({ label, value, note, delta, tone }: { label: ReactNode; value: ReactNode; note?: ReactNode; delta?: number | null; tone?: 'live' }) {
  const { t } = useTranslation();
  return (
    <Card className="p-[18px]">
      <div className="flex items-center gap-2 text-xs text-muted">
        {tone === 'live' && <i className="size-2 animate-pulse rounded-full bg-online" />}
        {label}
      </div>
      <div className="display mt-1.5 text-[30px] leading-none tabular-nums">{value}</div>
      <div className="mt-2 flex min-h-4 flex-wrap items-center gap-x-2 text-xs text-muted">
        {delta != null && Number.isFinite(delta) && (
          <span className={clsx('inline-flex items-center gap-0.5 font-semibold', delta >= 0 ? 'text-online' : 'text-offline')} title={t('stats.vsPrevious')}>
            {delta >= 0 ? <ArrowUpRight className="size-3.5" /> : <ArrowDownRight className="size-3.5" />}
            {Math.abs(Math.round(delta))}%
          </span>
        )}
        {note}
      </div>
    </Card>
  );
}

const change = (now: number, before: number) => (before > 0 ? ((now - before) / before) * 100 : null);

function CsvButton({ scope, period, kind, mount }: { scope: StatsScope; period: { from: Date; to: Date }; kind: string; mount?: string }) {
  const { t } = useTranslation();
  const href = `/api/stats/export.csv?${query(scope, { kind, from: period.from.toISOString(), to: period.to.toISOString(), tz, mount })}`;
  return (
    <a href={href} download className="inline-flex size-8 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-ink" title={t('stats.downloadCsv')}>
      <Download className="size-4" />
    </a>
  );
}

function BreakdownCard({
  title,
  description,
  rows,
  label,
  icon,
  kind,
  scope,
  period,
  mount,
  onSelect,
  metric,
}: {
  title: ReactNode;
  description?: ReactNode;
  rows: BreakdownRow[];
  label: (key: string) => ReactNode;
  icon?: (key: string) => ReactNode;
  kind: string;
  scope: StatsScope;
  period: { from: Date; to: Date };
  mount?: string;
  onSelect?: (key: string) => void;
  metric: 'hours' | 'listeners';
}) {
  const { t } = useTranslation();
  const f = useFormat();
  const bars: BarRow[] = rows.map((r) => ({
    key: r.key,
    label: label(r.key),
    icon: icon?.(r.key),
    value: metric === 'hours' ? r.hours : r.listeners || r.sessions,
    detail: t('stats.sessionsCount', { count: r.sessions }),
  }));
  return (
    <Card>
      <CardHeader title={title} description={description} actions={<CsvButton scope={scope} period={period} kind={kind} mount={mount} />} />
      <BarList rows={bars} format={metric === 'hours' ? (v) => `${v >= 1000 ? f.n0(v) : f.n1(v)} h` : f.n0} empty={t('stats.noData')} onSelect={onSelect} />
    </Card>
  );
}

function deviceLabel(t: (k: string) => string, key: string) {
  return t(`stats.devices.${key}`) || key;
}

// Live

function LiveTab({ scope }: { scope: StatsScope }) {
  const { t } = useTranslation();
  const f = useFormat();
  const live = useQuery({ queryKey: ['stats', 'live', scope], queryFn: () => api<StatsLive>(`/stats/live?${query(scope)}`), refetchInterval: 5000 });
  const d = live.data;
  if (live.isPending) return <Loading />;
  if (!d) return null;
  const countries = new Map(d.countries.map((c) => [c.key, c.listeners]));
  const onAir = d.stations.filter((s) => s.onAir).length;
  return (
    <div className="flex flex-col gap-4">
      <section className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        <Kpi tone="live" label={t('stats.listenersNow')} value={f.n0(d.total)} note={t('stats.liveRefresh')} />
        <Kpi label={t('stats.stationsOnAir')} value={`${onAir} / ${d.stations.length}`} />
        <Kpi label={t('stats.countriesNow')} value={f.n0(d.countries.filter((c) => c.key).length)} />
        <Card className="p-[18px]">
          <div className="text-xs text-muted">{t('stats.lastHour')}</div>
          <Sparkline values={d.trend.map((p) => p.listeners)} height={56} />
        </Card>
      </section>
      <div className="grid gap-4 lg:grid-cols-[1.7fr_1fr]">
        <Card>
          <CardHeader title={t('stats.mapNow')} description={t('stats.mapNowHint')} />
          <WorldMap
            countries={countries}
            places={d.places}
            labels={{ world: t('stats.world'), europe: t('stats.europe'), loading: t('stats.loadingMap') }}
            countryTooltip={(code, v) => ({ title: `${f.flag(code)} ${f.country(code)}`, lines: [t('stats.listenersCount', { count: v })] })}
            placeTooltip={(p) => ({ title: `${f.flag(p.country)} ${p.city ?? f.country(p.country)}`, lines: [t('stats.listenersCount', { count: p.sessions })] })}
          />
        </Card>
        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader title={t('nav.stations')} />
            <BarList
              rows={d.stations.map((s) => ({ key: s.id, label: s.name, value: s.listeners, icon: <i className={clsx('size-2 shrink-0 rounded-full', s.onAir ? 'bg-online' : 'bg-line')} /> }))}
              format={f.n0}
              empty={t('stats.noStations')}
            />
          </Card>
          <Card>
            <CardHeader title={t('stats.countries')} />
            <BarList rows={d.countries.map((c) => ({ key: c.key || '-', label: f.country(c.key), icon: <span>{f.flag(c.key)}</span>, value: c.listeners }))} format={f.n0} max={6} empty={t('stats.nobodyListening')} />
          </Card>
        </div>
      </div>
      <div className="grid gap-4 lg:grid-cols-[1fr_1.7fr]">
        <Card>
          <CardHeader title={t('stats.deviceTitle')} />
          <BarList
            rows={d.devices.map((x) => {
              const Icon = deviceIcons[x.key] ?? HelpCircle;
              return { key: x.key, label: deviceLabel(t, x.key), icon: <Icon className="size-4 text-muted" />, value: x.listeners };
            })}
            format={f.n0}
            empty={t('stats.nobodyListening')}
          />
        </Card>
        <Card>
          <CardHeader title={t('stats.recentListeners')} description={t('stats.recentListenersHint')} />
          <SessionTable rows={d.recent} live />
        </Card>
      </div>
    </div>
  );
}

function Loading() {
  return (
    <div className="grid place-items-center py-16">
      <Spinner />
    </div>
  );
}

function SessionTable({ rows, live, showStation = true }: { rows: ListenerSession[]; live?: boolean; showStation?: boolean }) {
  const { t } = useTranslation();
  const f = useFormat();
  if (!rows.length) return <div className="px-5 py-8 text-center text-[13px] text-muted">{live ? t('stats.nobodyListening') : t('stats.noData')}</div>;
  return (
    <Table head={[t('stats.place'), t('stats.player'), showStation ? t('stats.stationMount') : t('mounts.path'), live ? t('stats.listening') : t('stats.started'), live ? '' : t('stats.duration')]}>
      {rows.map((s) => {
        const Icon = deviceIcons[s.device ?? 'other'] ?? HelpCircle;
        return (
          <tr key={s.id}>
            <td>
              <div className="flex items-center gap-2">
                <span className="text-base leading-none">{f.flag(s.country)}</span>
                <div className="min-w-0">
                  <div className="truncate text-[13px] font-semibold">{s.city ? `${s.city}${s.region && s.region !== s.city ? `, ${s.region}` : ''}` : f.country(s.country)}</div>
                  <div className="truncate text-[11px] text-muted" title={s.ip ?? undefined}>
                    {[s.city ? f.country(s.country) : null, s.network, s.ip].filter(Boolean).join(' · ') || '—'}
                  </div>
                </div>
              </div>
            </td>
            <td>
              <div className="flex items-center gap-2 text-[13px]" title={s.userAgent ?? undefined}>
                <Icon className="size-4 shrink-0 text-muted" />
                <span className="truncate">{s.player ?? '—'}</span>
              </div>
              <div className="text-[11px] text-muted">{[s.os && s.os !== 'Unknown' ? s.os : null, s.referrer].filter(Boolean).join(' · ')}</div>
            </td>
            <td className="text-[13px]">
              {showStation && <div className="truncate font-semibold">{s.stationName}</div>}
              <div className="truncate font-mono text-[11px] text-muted">
                {s.mount}
                {s.via === 'external' && <Badge tone="neutral">{t('stats.external')}</Badge>}
              </div>
            </td>
            <td className="text-[13px] whitespace-nowrap">{live ? f.duration(s.durationSeconds) : formatDate(s.startedAt)}</td>
            <td className="text-[13px] whitespace-nowrap tabular-nums">{live ? '' : s.endedAt ? f.duration(s.durationSeconds) : <Badge tone="online" dot>{t('stats.stillListening')}</Badge>}</td>
          </tr>
        );
      })}
    </Table>
  );
}

// Reports

function useReport(scope: StatsScope, period: { from: Date; to: Date }, key: unknown[], mount: string | undefined, enabled: boolean) {
  return useQuery({
    enabled,
    queryKey: ['stats', 'report', scope, ...key, mount],
    queryFn: () => api<StatsReport>(`/stats/report?${query(scope, { from: period.from.toISOString(), to: period.to.toISOString(), tz, mount })}`),
    refetchInterval: 60_000,
    placeholderData: (prev) => prev,
  });
}

function timeFormatter(lang: string, bucket: string) {
  const short = bucket === '1d' || bucket === '1w' ? { day: 'numeric', month: 'short' } : bucket === '3h' || bucket === '1h' ? { day: 'numeric', month: 'short', hour: '2-digit' } : { hour: '2-digit', minute: '2-digit' };
  const long = bucket === '1d' || bucket === '1w' ? { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' } : { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' };
  const a = new Intl.DateTimeFormat(lang, short as Intl.DateTimeFormatOptions);
  const b = new Intl.DateTimeFormat(lang, long as Intl.DateTimeFormatOptions);
  return { short: (t: string) => a.format(new Date(t)), long: (t: string) => b.format(new Date(t)) };
}

function OverviewTab({ report, scope, period, mount }: { report: StatsReport; scope: StatsScope; period: { from: Date; to: Date }; mount?: string }) {
  const { t } = useTranslation();
  const f = useFormat();
  const k = report.kpis;
  const p = report.previous;
  const fmtTime = timeFormatter(f.lang, report.timeseries.bucket);
  const weekdays = useMemo(() => {
    const d = new Intl.DateTimeFormat(f.lang, { weekday: 'short' });
    return Array.from({ length: 7 }, (_, i) => d.format(new Date(Date.UTC(2024, 0, 1 + i))));
  }, [f.lang]);
  const short = (sec: number) => (sec < 3600 ? `${sec / 60}m` : `${sec / 3600}h`);
  const bands = report.durations.map((d) => ({
    key: String(d.fromSeconds),
    label: d.toSeconds == null ? `${short(d.fromSeconds)}+` : d.fromSeconds === 0 ? `< ${short(d.toSeconds)}` : `${short(d.fromSeconds).replace(/[a-z]+$/, d.fromSeconds < 3600 === d.toSeconds < 3600 ? '' : '$&')}–${short(d.toSeconds)}`,
    value: d.sessions,
  }));
  return (
    <div className="flex flex-col gap-4">
      <section className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        <Kpi label={t('stats.listeningHours')} value={f.n0(k.listeningHours)} delta={change(k.listeningHours, p.listeningHours)} note={t('stats.listeningHoursHint')} />
        <Kpi label={t('stats.avgListeners')} value={f.n1(k.avgListeners)} delta={change(k.avgListeners, p.avgListeners)} note={k.peakAt ? t('stats.peakNote', { peak: f.n0(k.peakListeners), when: formatDate(k.peakAt) }) : undefined} />
        <Kpi label={t('stats.uniqueListeners')} value={f.n0(k.uniqueListeners)} delta={change(k.uniqueListeners, p.uniqueListeners)} note={t('stats.sessionsCount', { count: k.sessions })} />
        <Kpi label={t('stats.avgSession')} value={f.duration(k.avgSessionSeconds)} delta={change(k.avgSessionSeconds, p.avgSessionSeconds)} note={t('stats.countriesCount', { count: k.countries })} />
      </section>
      <Card>
        <CardHeader title={t('stats.overTime')} description={<ChartLegend label={t('stats.average')} label2={t('stats.peak')} />} actions={<CsvButton scope={scope} period={period} kind="timeseries" mount={mount} />} />
        <div className="px-3 py-4">
          <AreaChart
            points={report.timeseries.points.map((x) => ({ t: x.t, value: x.avg, value2: x.peak }))}
            label={t('stats.average')}
            label2={t('stats.peak')}
            formatTime={fmtTime.short}
            formatTooltipTime={fmtTime.long}
            empty={t('stats.noData')}
            height={260}
          />
        </div>
      </Card>
      <div className="grid gap-4 lg:grid-cols-[1.5fr_1fr]">
        <Card className="min-w-0">
          <CardHeader title={t('stats.whenTitle')} description={t('stats.whenHint', { tz })} />
          <Heatmap cells={report.heatmap} weekdays={weekdays} format={f.n1} />
        </Card>
        <Card className="min-w-0">
          <CardHeader title={t('stats.durationTitle')} description={t('stats.durationHint')} />
          <ColumnChart columns={bands} format={f.n0} />
        </Card>
      </div>
    </div>
  );
}

function AudienceTab({ report, scope, period, mount, onCountry }: { report: StatsReport; scope: StatsScope; period: { from: Date; to: Date }; mount?: string; onCountry: (c: string) => void }) {
  const { t } = useTranslation();
  const f = useFormat();
  const countries = new Map(report.countries.map((c) => [c.key, c.hours]));
  const place = (key: string) => {
    const [c, name] = key.split('|');
    return name ? `${name}, ${f.country(c)}` : f.country(c);
  };
  const common = { scope, period, mount, metric: 'hours' as const };
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader title={t('stats.mapTitle')} description={t('stats.mapHint')} />
        <WorldMap
          countries={countries}
          places={report.places}
          labels={{ world: t('stats.world'), europe: t('stats.europe'), loading: t('stats.loadingMap') }}
          countryTooltip={(code, v) => ({ title: `${f.flag(code)} ${f.country(code)}`, lines: [`${f.n1(v)} ${t('stats.hoursShort')}`] })}
          placeTooltip={(p: Place) => ({
            title: `${f.flag(p.country)} ${p.city ?? f.country(p.country)}`,
            lines: [t('stats.sessionsCount', { count: p.sessions }), t('stats.uniqueCount', { count: p.listeners }), `${f.n1(p.hours)} ${t('stats.hoursShort')}`],
          })}
        />
        <p className="border-t border-line px-5 py-2 text-[11px] text-muted">
          {t('stats.geoAttribution')}{' '}
          <a className="underline" href="https://db-ip.com" target="_blank" rel="noreferrer">
            DB-IP
          </a>
        </p>
      </Card>
      <div className="grid gap-4 lg:grid-cols-3">
        <BreakdownCard {...common} title={t('stats.countries')} rows={report.countries} kind="countries" label={(k) => f.country(k)} icon={(k) => <span>{f.flag(k)}</span>} onSelect={(k) => k && onCountry(k)} />
        <BreakdownCard {...common} title={t('stats.regions')} rows={report.regions} kind="regions" label={place} icon={(k) => <span>{f.flag(k.split('|')[0])}</span>} />
        <BreakdownCard {...common} title={t('stats.cities')} rows={report.cities} kind="cities" label={place} icon={(k) => <span>{f.flag(k.split('|')[0])}</span>} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <BreakdownCard {...common} title={t('stats.networks')} description={t('stats.networksHint')} rows={report.networks} kind="networks" label={(k) => k || t('stats.unknown')} icon={() => <Globe2 className="size-4 text-muted" />} />
        <BreakdownCard {...common} title={t('stats.referrers')} description={t('stats.referrersHint')} rows={report.referrers} kind="referrers" label={(k) => k || t('stats.direct')} />
      </div>
    </div>
  );
}

function TechnologyTab({ report, scope, period, mount, mountLabel }: { report: StatsReport; scope: StatsScope; period: { from: Date; to: Date }; mount?: string; mountLabel: (k: string) => string }) {
  const { t } = useTranslation();
  const common = { scope, period, mount, metric: 'hours' as const };
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <BreakdownCard
        {...common}
        title={t('stats.deviceTitle')}
        rows={report.devices}
        kind="devices"
        label={(k) => deviceLabel(t, k)}
        icon={(k) => {
          const Icon = deviceIcons[k] ?? HelpCircle;
          return <Icon className="size-4 text-muted" />;
        }}
      />
      <BreakdownCard {...common} title={t('stats.players')} description={t('stats.playersHint')} rows={report.players} kind="players" label={(k) => k} icon={() => <Headphones className="size-4 text-muted" />} />
      <BreakdownCard {...common} title={t('stats.systems')} rows={report.os} kind="os" label={(k) => (k === 'Unknown' ? t('stats.unknown') : k)} icon={() => <Laptop className="size-4 text-muted" />} />
      <BreakdownCard {...common} title={t('stats.mounts')} description={t('stats.mountsHint')} rows={report.mounts} kind="mounts" label={mountLabel} icon={() => <Radio className="size-4 text-muted" />} />
    </div>
  );
}

function ProgrammeTab({ scope, period, periodKey }: { scope: StatsScope; period: { from: Date; to: Date }; periodKey: unknown[] }) {
  const { t } = useTranslation();
  const f = useFormat();
  const prog = useQuery({
    queryKey: ['stats', 'programme', scope, ...periodKey],
    queryFn: () => api<StatsProgramme>(`/stats/programme?${query(scope, { from: period.from.toISOString(), to: period.to.toISOString(), tz })}`),
    refetchInterval: 60_000,
  });
  if (prog.isPending) return <Loading />;
  const d = prog.data;
  if (!d) return null;
  const changeCell = (v: number) => (
    <span className={clsx('font-semibold tabular-nums', v > 0 ? 'text-online' : v < 0 ? 'text-offline' : 'text-muted')}>
      {v > 0 ? '+' : ''}
      {f.n1(v)}
    </span>
  );
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader title={t('stats.songsTitle')} description={t('stats.songsHint')} actions={<CsvButton scope={scope} period={period} kind="songs" />} />
        {d.songs.length ? (
          <Table head={[t('stats.title'), t('stats.plays'), t('stats.avgListenersShort'), t('stats.peak'), t('stats.changeDuring'), t('stats.lastPlayed')]}>
            {d.songs.map((s) => (
              <tr key={s.title}>
                <td className="max-w-80 truncate text-[13px] font-semibold" title={s.title}>
                  {s.title}
                </td>
                <td className="tabular-nums">{s.plays}</td>
                <td className="tabular-nums">{f.n1(s.avgListeners)}</td>
                <td className="tabular-nums">{f.n1(s.avgPeak)}</td>
                <td>{changeCell(s.avgChange)}</td>
                <td className="text-[13px] whitespace-nowrap text-muted">{formatRelative(s.lastPlayed)}</td>
              </tr>
            ))}
          </Table>
        ) : (
          <div className="px-5 py-8 text-center text-[13px] text-muted">{t('stats.noSongs')}</div>
        )}
      </Card>
      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title={t('stats.broadcastsTitle')} description={t('stats.broadcastsHint')} actions={<CsvButton scope={scope} period={period} kind="broadcasts" />} />
          {d.broadcasts.length ? (
            <Table head={[t('stats.dj'), t('stats.started'), t('stats.duration'), t('stats.avgListenersShort'), t('stats.peak')]}>
              {d.broadcasts.map((b) => (
                <tr key={b.id}>
                  <td>
                    <div className="text-[13px] font-semibold">{b.accountName}</div>
                    <div className="font-mono text-[11px] text-muted">
                      {b.stationName} · {b.mount}
                    </div>
                  </td>
                  <td className="text-[13px] whitespace-nowrap">{formatDate(b.startedAt)}</td>
                  <td className="text-[13px] whitespace-nowrap">
                    {b.endedAt ? f.duration((new Date(b.endedAt).getTime() - new Date(b.startedAt).getTime()) / 1000) : <Badge tone="online" dot>{t('stats.onAirNow')}</Badge>}
                  </td>
                  <td className="tabular-nums">{f.n1(b.avgListeners)}</td>
                  <td className="tabular-nums">{b.peakListeners}</td>
                </tr>
              ))}
            </Table>
          ) : (
            <div className="px-5 py-8 text-center text-[13px] text-muted">{t('stats.noBroadcasts')}</div>
          )}
        </Card>
        <Card>
          <CardHeader title={t('stats.playsTitle')} />
          {d.plays.length ? (
            <Table head={[t('stats.time'), t('stats.title'), t('stats.listenersShort')]}>
              {d.plays.map((p) => (
                <tr key={p.id}>
                  <td className="text-[13px] whitespace-nowrap text-muted">{formatDate(p.startedAt)}</td>
                  <td className="max-w-72">
                    <div className="truncate text-[13px] font-semibold" title={p.title}>
                      {p.title}
                    </div>
                    <div className="truncate font-mono text-[11px] text-muted">
                      {p.stationName} · {p.mount}
                    </div>
                  </td>
                  <td className="text-[13px] whitespace-nowrap tabular-nums">
                    {p.listenersStart} → {p.listenersEnd ?? '…'} {p.listenersEnd != null && changeCell(p.listenersEnd - p.listenersStart)}
                  </td>
                </tr>
              ))}
            </Table>
          ) : (
            <div className="px-5 py-8 text-center text-[13px] text-muted">{t('stats.noSongs')}</div>
          )}
        </Card>
      </div>
    </div>
  );
}

function ListenersTab({ scope, period, periodKey, mount, country, onCountry, showStation }: { scope: StatsScope; period: { from: Date; to: Date }; periodKey: unknown[]; mount?: string; country?: string; onCountry: (c: string | undefined) => void; showStation: boolean }) {
  const { t } = useTranslation();
  const f = useFormat();
  const list = useInfiniteQuery({
    queryKey: ['stats', 'sessions', scope, ...periodKey, mount, country],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api<ListenerSession[]>(`/stats/sessions?${query(scope, { from: period.from.toISOString(), to: period.to.toISOString(), tz, mount, country, before: pageParam, limit: '100' })}`),
    getNextPageParam: (last) => (last.length === 100 ? last.at(-1)!.startedAt : undefined),
  });
  const rows = list.data?.pages.flat() ?? [];
  return (
    <Card>
      <CardHeader
        title={t('stats.sessionsTitle')}
        description={t('stats.sessionsHint')}
        actions={
          <>
            {country && (
              <Button size="sm" variant="secondary" onClick={() => onCountry(undefined)}>
                {f.flag(country)} {f.country(country)} ✕
              </Button>
            )}
            <CsvButton scope={scope} period={period} kind="sessions" mount={mount} />
          </>
        }
      />
      {list.isPending ? <Loading /> : <SessionTable rows={rows} showStation={showStation} />}
      {list.hasNextPage && (
        <div className="border-t border-line px-5 py-3">
          <Button size="sm" loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
            {t('stats.loadMore')}
          </Button>
        </div>
      )}
    </Card>
  );
}

/**
 * Listener statistics for a scope (one station, a customer, or everything you may see): live view and reports for a
 * period. Tab, period and filters live in the address, so a report can be shared as a link.
 */
export function StatisticsView({ scope, mounts = [], outputs = [], showStation = true, toolbar }: { scope: StatsScope; mounts?: string[]; outputs?: { id: string; name: string }[]; showStation?: boolean; toolbar?: ReactNode }) {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('stats') as StatsTab | null) ?? 'live';
  const preset = (PRESETS.includes(params.get('period') as Preset) ? params.get('period') : '7d') as Preset;
  const customFrom = params.get('from') ?? '';
  const customTo = params.get('to') ?? '';
  const mount = params.get('mount') ?? undefined;
  const country = params.get('country') ?? undefined;
  const set = (patch: Record<string, string | undefined>) =>
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        for (const [k, v] of Object.entries(patch)) {
          if (v) next.set(k, v);
          else next.delete(k);
        }
        return next;
      },
      { replace: true },
    );
  // The period is fixed when its choice changes; the minute timer below moves it along.
  const [tick, setTick] = useState(0);
  const period = useMemo(() => rangeOf(preset, customFrom, customTo), [preset, customFrom, customTo, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  const periodKey = [preset, customFrom, customTo, tick];
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 5 * 60_000);
    return () => clearInterval(id);
  }, []);
  const report = useReport(scope, period, periodKey, mount, ['overview', 'audience', 'technology'].includes(tab));
  const mountLabel = (k: string) => (k.startsWith('output:') ? (outputs.find((o) => `output:${o.id}` === k)?.name ?? t('stats.external')) : k);

  const tabs: { value: StatsTab; label: string }[] = [
    { value: 'live', label: t('stats.tabs.live') },
    { value: 'overview', label: t('stats.tabs.overview') },
    { value: 'audience', label: t('stats.tabs.audience') },
    { value: 'technology', label: t('stats.tabs.technology') },
    { value: 'programme', label: t('stats.tabs.programme') },
    { value: 'listeners', label: t('stats.tabs.listeners') },
  ];

  return (
    <div>
      <Tabs value={tab} onChange={(v) => set({ stats: v === 'live' ? undefined : v })} tabs={tabs} />
      {tab !== 'live' && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          {toolbar}
          <div className="flex flex-wrap rounded-md border border-line bg-raised p-0.5">
            {PRESETS.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => set({ period: p === '7d' ? undefined : p })}
                className={clsx('h-8 rounded-[7px] px-3 text-[13px] font-semibold', preset === p ? 'bg-[var(--nav-active-bg)] text-[var(--nav-active-ink)]' : 'text-muted hover:bg-hover')}
              >
                {t(`stats.presets.${p}`)}
              </button>
            ))}
          </div>
          {preset === 'custom' && (
            <div className="flex items-center gap-2">
              <Input type="date" className="h-9 w-40" value={customFrom} onChange={(e) => set({ from: e.target.value })} aria-label={t('stats.from')} />
              <span className="text-muted">–</span>
              <Input type="date" className="h-9 w-40" value={customTo} onChange={(e) => set({ to: e.target.value })} aria-label={t('stats.to')} />
            </div>
          )}
          {(mounts.length > 1 || outputs.length > 0) && (
            <div className="w-full sm:w-56">
            <Select className="h-9" value={mount ?? ''} onChange={(e) => set({ mount: e.target.value || undefined })} aria-label={t('stats.mountFilter')}>
              <option value="">{t('stats.allMounts')}</option>
              {mounts.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
              {outputs.map((o) => (
                <option key={o.id} value={`output:${o.id}`}>
                  {o.name}
                </option>
              ))}
            </Select>
            </div>
          )}
          {report.isFetching && <Spinner className="size-4" />}
        </div>
      )}
      {tab === 'live' && (
        <>
          {toolbar && <div className="mb-4 flex flex-wrap items-center gap-2">{toolbar}</div>}
          <LiveTab scope={scope} />
        </>
      )}
      {['overview', 'audience', 'technology'].includes(tab) && (report.isPending ? <Loading /> : report.isError ? <ErrorCard error={report.error} /> : null)}
      {tab === 'overview' && report.data && <OverviewTab report={report.data} scope={scope} period={period} mount={mount} />}
      {tab === 'audience' && report.data && <AudienceTab report={report.data} scope={scope} period={period} mount={mount} onCountry={(c) => set({ stats: 'listeners', country: c })} />}
      {tab === 'technology' && report.data && <TechnologyTab report={report.data} scope={scope} period={period} mount={mount} mountLabel={mountLabel} />}
      {tab === 'programme' && <ProgrammeTab scope={scope} period={period} periodKey={periodKey} />}
      {tab === 'listeners' && <ListenersTab scope={scope} period={period} periodKey={periodKey} mount={mount} country={country} onCountry={(c) => set({ country: c })} showStation={showStation} />}
    </div>
  );
}

function ErrorCard({ error }: { error: unknown }) {
  return <Card className="p-6 text-center text-[13px] text-offline">{(error as Error).message}</Card>;
}
