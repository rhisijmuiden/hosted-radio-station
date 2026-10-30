import { useQuery } from '@tanstack/react-query';
import { Download, FileSpreadsheet, Mic } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, type RightsPlay, type StationDetail } from '../../lib/api';
import { Badge, Card, CardHeader, EmptyState, Field, Input, Spinner, Table } from '../ui';

const two = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
const mmss = (s: number) => `${Math.floor(s / 60)}:${two(s % 60)}`;

/** Quick periods: last month, this month, last quarter, last year (in the browser's calendar). */
function presets(now = new Date()) {
  const y = now.getFullYear();
  const m = now.getMonth();
  const q = Math.floor(m / 3);
  return {
    lastMonth: [new Date(y, m - 1, 1), new Date(y, m, 0)],
    thisMonth: [new Date(y, m, 1), now],
    lastQuarter: [new Date(y, q * 3 - 3, 1), new Date(y, q * 3, 0)],
    lastYear: [new Date(y - 1, 0, 1), new Date(y - 1, 11, 31)],
  } as const;
}

/**
 * Music reports for the collecting societies (phase 21 step 5): every play of a period for Buma/Stemra, and the plays
 * per recording for SENA, as CSV. A preview shows what is in it and how many plays miss an ISRC or composer.
 */
export function ReportsTab({ station }: { station: StationDetail }) {
  const { t } = useTranslation();
  const p = presets();
  const [from, setFrom] = useState(ymd(p.lastMonth[0]));
  const [to, setTo] = useState(ymd(p.lastMonth[1]));
  const [minSeconds, setMinSeconds] = useState(30);
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) && to >= from;
  const query = `from=${from}&to=${to}&minSeconds=${minSeconds}`;
  const plays = useQuery({
    queryKey: ['rights-plays', station.id, query],
    queryFn: () => api<{ items: RightsPlay[] }>(`/stations/${station.id}/reports/plays?${query}`),
    enabled: valid,
    staleTime: 60_000,
  });
  const items = plays.data?.items ?? [];
  const noIsrc = items.filter((i) => !i.isrc).length;
  const noComposer = items.filter((i) => !i.composer).length;
  const live = items.filter((i) => i.source === 'live').length;
  const hours = Math.round(items.reduce((n, i) => n + i.listenerHours, 0) * 10) / 10;
  const href = (kind: 'plays' | 'tracks') => `/api/stations/${station.id}/reports/${kind}.csv?${query}`;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader title={t('reports.title')} description={t('reports.subtitle')} />
        <div className="flex flex-col gap-4 px-5 py-4">
          <div className="flex flex-wrap gap-2">
            {(Object.keys(p) as (keyof typeof p)[]).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => {
                  setFrom(ymd(p[k][0]));
                  setTo(ymd(p[k][1]));
                }}
                className="rounded-md border border-line px-3 py-1.5 text-[13px] font-semibold hover:bg-hover"
              >
                {t(`reports.${k}`)}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <Field label={t('reports.from')}>
              <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </Field>
            <Field label={t('reports.to')}>
              <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-invalid={!valid} />
            </Field>
            <Field label={t('reports.minSeconds')} hint={t('reports.minSecondsHint')}>
              <Input type="number" min={0} max={600} className="w-28!" value={minSeconds} onChange={(e) => setMinSeconds(Math.max(0, Math.min(600, Number(e.target.value) || 0)))} />
            </Field>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            {(['plays', 'tracks'] as const).map((kind) => (
              <a
                key={kind}
                href={valid ? href(kind) : undefined}
                aria-disabled={!valid}
                className={`flex items-start gap-3 rounded-md border border-line p-4 hover:bg-hover ${valid ? '' : 'pointer-events-none opacity-50'}`}
              >
                <FileSpreadsheet className="mt-0.5 size-5 shrink-0 text-accent-text" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-bold">{t(`reports.${kind}`)}</span>
                  <span className="mt-0.5 block text-xs text-muted">{t(`reports.${kind}Hint`)}</span>
                </span>
                <Download className="size-4 shrink-0 text-muted" />
              </a>
            ))}
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader
          title={t('reports.preview')}
          description={
            plays.data
              ? t('reports.summary', { plays: items.length, live, hours })
              : undefined
          }
          actions={
            plays.data && items.length > 0 ? (
              <span className="flex flex-wrap gap-1.5">
                <Badge tone={noIsrc ? 'warning' : 'online'}>{t('reports.noIsrc', { count: noIsrc })}</Badge>
                <Badge tone={noComposer ? 'warning' : 'online'}>{t('reports.noComposer', { count: noComposer })}</Badge>
              </span>
            ) : undefined
          }
        />
        {!valid ? (
          <p className="px-5 py-4 text-[13px] text-offline">{t('reports.invalid')}</p>
        ) : plays.isPending ? (
          <div className="grid place-items-center py-10">
            <Spinner />
          </div>
        ) : plays.isError ? (
          <p className="px-5 py-4 text-[13px] text-offline">{(plays.error as Error).message}</p>
        ) : !items.length ? (
          <EmptyState icon={<FileSpreadsheet />} title={t('reports.empty')} description={t('reports.emptyHint')} />
        ) : (
          <>
            <Table head={[t('reports.when'), t('reports.artist'), t('reports.track'), t('reports.composer'), 'ISRC', t('reports.duration'), t('reports.listeners')]}>
              {items.slice(-100).reverse().map((i) => (
                <tr key={`${i.startedAt}-${i.mount}`}>
                  <td className="text-[13px] whitespace-nowrap tabular-nums">
                    {i.date} {i.time.slice(0, 5)}
                  </td>
                  <td className="text-[13px]">{i.artist || '—'}</td>
                  <td className="text-[13px]">
                    <span className="flex items-center gap-1.5">
                      {i.title}
                      {i.source === 'live' && (
                        <Badge tone="accent">
                          <Mic className="size-3" /> {i.dj}
                        </Badge>
                      )}
                    </span>
                  </td>
                  <td className="text-[13px] text-muted">{i.composer || '—'}</td>
                  <td className="font-mono text-xs">{i.isrc || '—'}</td>
                  <td className="text-[13px] tabular-nums">{mmss(i.durationSeconds)}</td>
                  <td className="text-[13px] tabular-nums">{i.avgListeners}</td>
                </tr>
              ))}
            </Table>
            {items.length > 100 && <p className="border-t border-line px-5 py-3 text-xs text-muted">{t('reports.previewLimit', { count: items.length })}</p>}
          </>
        )}
      </Card>
    </div>
  );
}
