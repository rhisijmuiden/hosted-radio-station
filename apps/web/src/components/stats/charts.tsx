import clsx from 'clsx';
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';

/** Width of an element, kept up to date. */
function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.floor(e!.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

/** Round axis steps: 1, 2, 5 × 10ⁿ. */
function niceTicks(max: number, count = 4) {
  if (max <= 0) return [0, 1];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const ticks: number[] = [];
  for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(Math.round(v * 1000) / 1000);
  if (ticks.at(-1)! < max) ticks.push(ticks.at(-1)! + step);
  return ticks;
}

const fmt = (n: number) => new Intl.NumberFormat(undefined, { maximumFractionDigits: n < 10 ? 1 : 0 }).format(n);

export interface SeriesPoint {
  t: string;
  value: number;
  /** Optional second value, drawn as a thin dashed line (e.g. the peak). */
  value2?: number;
}

/**
 * Listeners over time: a filled area for the main value and an optional dashed line for the second one, with a
 * crosshair and tooltip on hover.
 */
export function AreaChart({
  points,
  height = 220,
  label,
  label2,
  formatTime,
  formatTooltipTime,
  empty,
}: {
  points: SeriesPoint[];
  height?: number;
  label: string;
  label2?: string;
  formatTime: (t: string) => string;
  formatTooltipTime?: (t: string) => string;
  empty?: ReactNode;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const gradient = useId();
  const pad = { l: 40, r: 12, t: 12, b: 26 };
  const w = Math.max(0, width - pad.l - pad.r);
  const h = height - pad.t - pad.b;
  const max = Math.max(1, ...points.map((p) => Math.max(p.value, p.value2 ?? 0)));
  const ticks = niceTicks(max);
  const top = ticks.at(-1)!;
  const x = (i: number) => pad.l + (points.length <= 1 ? w / 2 : (i / (points.length - 1)) * w);
  const y = (v: number) => pad.t + h - (v / top) * h;
  const line = (get: (p: SeriesPoint) => number) => points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(get(p)).toFixed(1)}`).join('');
  const area = points.length ? `${line((p) => p.value)}L${x(points.length - 1).toFixed(1)},${y(0)}L${x(0).toFixed(1)},${y(0)}Z` : '';
  const xTicks = useMemo(() => {
    const n = Math.min(points.length, Math.max(2, Math.floor(w / 110)));
    if (n < 2) return points.map((_, i) => i);
    return Array.from({ length: n }, (_, k) => Math.round((k / (n - 1)) * (points.length - 1)));
  }, [points, w]);

  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const rel = (e.clientX - box.left) / Math.max(1, box.width);
    setHover(Math.max(0, Math.min(points.length - 1, Math.round(rel * (points.length - 1)))));
  };
  const hp = hover != null ? points[hover] : null;

  return (
    <div ref={ref} className="relative w-full" style={{ height }}>
      {width > 0 && points.length > 0 && (
        <svg width={width} height={height} className="block" role="img" aria-label={label}>
          <defs>
            <linearGradient id={gradient} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="var(--koraal)" stopOpacity="0.32" />
              <stop offset="100%" stopColor="var(--koraal)" stopOpacity="0.02" />
            </linearGradient>
          </defs>
          {ticks.map((v) => (
            <g key={v}>
              <line x1={pad.l} x2={pad.l + w} y1={y(v)} y2={y(v)} stroke="var(--line)" strokeDasharray={v === 0 ? undefined : '2 4'} />
              <text x={pad.l - 8} y={y(v)} dy="0.32em" textAnchor="end" className="fill-[var(--ink-muted)] text-[11px] tabular-nums">
                {fmt(v)}
              </text>
            </g>
          ))}
          {xTicks.map((i) => (
            <text key={i} x={x(i)} y={height - 6} textAnchor={i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle'} className="fill-[var(--ink-muted)] text-[11px]">
              {formatTime(points[i]!.t)}
            </text>
          ))}
          <path d={area} fill={`url(#${gradient})`} />
          <path d={line((p) => p.value)} fill="none" stroke="var(--koraal)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          {label2 && <path d={line((p) => p.value2 ?? 0)} fill="none" stroke="var(--ink-muted)" strokeWidth={1.5} strokeDasharray="4 4" strokeLinejoin="round" />}
          {hp && (
            <g pointerEvents="none">
              <line x1={x(hover!)} x2={x(hover!)} y1={pad.t} y2={pad.t + h} stroke="var(--ink-muted)" strokeOpacity={0.5} />
              <circle cx={x(hover!)} cy={y(hp.value)} r={4.5} fill="var(--koraal)" stroke="var(--surface-raised)" strokeWidth={2} />
            </g>
          )}
          <rect x={pad.l} y={pad.t} width={w} height={h} fill="transparent" onPointerMove={onMove} onPointerLeave={() => setHover(null)} />
        </svg>
      )}
      {width > 0 && points.length === 0 && <div className="grid h-full place-items-center text-[13px] text-muted">{empty}</div>}
      {hp && (
        <div
          className="pointer-events-none absolute top-1 z-10 min-w-36 rounded-md border border-line bg-raised px-3 py-2 text-xs shadow-lg"
          style={{ left: Math.min(Math.max(0, x(hover!) + 12), Math.max(0, width - 160)) }}
        >
          <div className="mb-1 text-muted">{(formatTooltipTime ?? formatTime)(hp.t)}</div>
          <div className="flex items-center justify-between gap-4">
            <span className="flex items-center gap-1.5">
              <i className="inline-block h-0.5 w-3 rounded bg-koraal" /> {label}
            </span>
            <b className="tabular-nums">{fmt(hp.value)}</b>
          </div>
          {label2 && (
            <div className="flex items-center justify-between gap-4">
              <span className="flex items-center gap-1.5">
                <i className="inline-block w-3 border-t-[1.5px] border-dashed border-muted" /> {label2}
              </span>
              <b className="tabular-nums">{fmt(hp.value2 ?? 0)}</b>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Legend for the area chart. */
export function ChartLegend({ label, label2 }: { label: string; label2?: string }) {
  return (
    <div className="flex flex-wrap items-center gap-4 text-xs text-muted">
      <span className="flex items-center gap-1.5">
        <i className="inline-block h-0.5 w-4 rounded bg-koraal" /> {label}
      </span>
      {label2 && (
        <span className="flex items-center gap-1.5">
          <i className="inline-block w-4 border-t-[1.5px] border-dashed border-muted" /> {label2}
        </span>
      )}
    </div>
  );
}

/** A tiny line of the last hour, for the live view. */
export function Sparkline({ values, height = 48 }: { values: number[]; height?: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const max = Math.max(1, ...values);
  const x = (i: number) => (values.length <= 1 ? width : (i / (values.length - 1)) * width);
  const y = (v: number) => 3 + (height - 6) * (1 - v / max);
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  return (
    <div ref={ref} style={{ height }} aria-hidden>
      {width > 0 && values.length > 1 && (
        <svg width={width} height={height} className="block">
          <path d={`${d}L${width},${height}L0,${height}Z`} fill="var(--koraal)" fillOpacity={0.12} />
          <path d={d} fill="none" stroke="var(--koraal)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        </svg>
      )}
    </div>
  );
}

export interface BarRow {
  key: string;
  label: ReactNode;
  value: number;
  /** Shown next to the value, e.g. "12 sessions". */
  detail?: ReactNode;
  icon?: ReactNode;
}

/** Horizontal bars, biggest first, with the value as text. */
export function BarList({ rows, format = fmt, max: maxRows = 10, empty, onSelect }: { rows: BarRow[]; format?: (n: number) => string; max?: number; empty?: ReactNode; onSelect?: (key: string) => void }) {
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, maxRows);
  const max = Math.max(1e-9, ...rows.map((r) => r.value));
  if (!rows.length) return <div className="px-5 py-8 text-center text-[13px] text-muted">{empty}</div>;
  return (
    <div className="flex flex-col gap-1 px-3 py-3">
      {shown.map((r) => (
        <button
          key={r.key}
          type="button"
          disabled={!onSelect}
          onClick={() => onSelect?.(r.key)}
          className={clsx('group relative flex items-center gap-3 rounded-sm px-2 py-1.5 text-left', onSelect && 'hover:bg-hover')}
          title={typeof r.label === 'string' ? r.label : undefined}
        >
          <span className="absolute inset-y-1 left-0 rounded-sm bg-koraal/15" style={{ width: `${Math.max(1.5, (r.value / max) * 100)}%` }} aria-hidden />
          <span className="relative flex min-w-0 flex-1 items-center gap-2 text-[13px]">
            {r.icon}
            <span className="truncate">{r.label}</span>
          </span>
          {r.detail && <span className="relative hidden text-[11px] text-muted sm:inline">{r.detail}</span>}
          <span className="relative w-20 whitespace-nowrap text-right text-[13px] font-semibold tabular-nums">{format(r.value)}</span>
        </button>
      ))}
      {rows.length > maxRows && (
        <button type="button" onClick={() => setAll((a) => !a)} className="mt-1 self-start rounded-sm px-2 py-1 text-xs font-semibold text-accent-text hover:underline">
          {all ? '−' : `+ ${rows.length - maxRows}`}
        </button>
      )}
    </div>
  );
}

/** Vertical bars with a label under each, e.g. listening-time bands. */
export function ColumnChart({ columns, height = 160, format = fmt }: { columns: { key: string; label: string; value: number }[]; height?: number; format?: (n: number) => string }) {
  const max = Math.max(1, ...columns.map((c) => c.value));
  const [hover, setHover] = useState<string | null>(null);
  return (
    <div className="flex items-end gap-2 px-5 pt-4 pb-3" style={{ height: height + 40 }}>
      {columns.map((c) => (
        <div key={c.key} className="flex min-w-0 flex-1 flex-col items-center gap-1.5" onPointerEnter={() => setHover(c.key)} onPointerLeave={() => setHover(null)}>
          <span className={clsx('text-[11px] font-semibold tabular-nums transition-opacity', hover === c.key || columns.length <= 8 ? 'opacity-100' : 'opacity-0')}>{format(c.value)}</span>
          <div className="flex w-full items-end" style={{ height }}>
            <div className={clsx('w-full rounded-t-[4px] bg-koraal transition-opacity', hover && hover !== c.key && 'opacity-60')} style={{ height: `${Math.max(c.value ? 2 : 0, (c.value / max) * 100)}%` }} />
          </div>
          <span className="w-full truncate text-center text-[11px] text-muted">{c.label}</span>
        </div>
      ))}
    </div>
  );
}

/** Weekday × hour grid, darker = more listeners. */
export function Heatmap({ cells, weekdays, format = fmt }: { cells: { weekday: number; hour: number; avg: number }[]; weekdays: string[]; format?: (n: number) => string }) {
  const max = Math.max(1e-9, ...cells.map((c) => c.avg));
  const by = new Map(cells.map((c) => [`${c.weekday}:${c.hour}`, c.avg]));
  const [hover, setHover] = useState<{ d: number; h: number } | null>(null);
  return (
    <div className="overflow-x-auto px-5 py-4">
      <div className="grid min-w-[560px] gap-[3px]" style={{ gridTemplateColumns: `36px repeat(24, minmax(0, 1fr))` }}>
        <span />
        {Array.from({ length: 24 }, (_, h) => (
          <span key={h} className="text-center text-[10px] text-muted">
            {h % 3 === 0 ? String(h).padStart(2, '0') : ''}
          </span>
        ))}
        {weekdays.map((name, i) => (
          <div key={name} className="contents">
            <span className="self-center text-[11px] text-muted">{name}</span>
            {Array.from({ length: 24 }, (_, h) => {
              const v = by.get(`${i + 1}:${h}`) ?? 0;
              const active = hover?.d === i + 1 && hover.h === h;
              return (
                <div
                  key={h}
                  onPointerEnter={() => setHover({ d: i + 1, h })}
                  onPointerLeave={() => setHover(null)}
                  className={clsx('relative aspect-square rounded-[3px]', active && 'ring-2 ring-ink')}
                  style={{ background: v > 0 ? `color-mix(in srgb, var(--koraal) ${Math.round(12 + (v / max) * 88)}%, var(--surface-raised))` : 'var(--chip)' }}
                  title={`${name} ${String(h).padStart(2, '0')}:00 · ${format(v)}`}
                />
              );
            })}
          </div>
        ))}
      </div>
      <div className="mt-3 flex items-center justify-end gap-2 text-[11px] text-muted">
        {format(0)}
        <span className="h-2 w-28 rounded-full" style={{ background: 'linear-gradient(to right, color-mix(in srgb, var(--koraal) 12%, var(--surface-raised)), var(--koraal))' }} />
        {format(max)}
      </div>
    </div>
  );
}
