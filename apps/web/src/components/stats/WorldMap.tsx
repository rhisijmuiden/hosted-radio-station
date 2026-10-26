import clsx from 'clsx';
import { geoNaturalEarth1, geoPath, type GeoPermissibleObjects } from 'd3-geo';
import { useEffect, useMemo, useRef, useState } from 'react';
import { feature } from 'topojson-client';
import type { Topology } from 'topojson-specification';
import type { Place } from '../../lib/api';

type CountryFeature = { type: 'Feature'; id: string; geometry: GeoPermissibleObjects };

let cache: Promise<CountryFeature[]> | null = null;
/** Natural Earth countries (1:110m), ids are ISO 3166 alpha-2 codes. Loaded once, only when a map is shown. */
function loadCountries() {
  cache ??= fetch('/maps/world-110m.json')
    .then((r) => r.json() as Promise<Topology>)
    .then((topo) => (feature(topo, topo.objects.countries!) as unknown as { features: CountryFeature[] }).features)
    .catch((err) => {
      cache = null;
      throw err;
    });
  return cache;
}

const EUROPE: GeoPermissibleObjects = {
  type: 'Feature',
  properties: {},
  geometry: { type: 'Polygon', coordinates: [[[-11, 35], [32, 35], [32, 70], [-11, 70], [-11, 35]]] },
} as GeoPermissibleObjects;

export interface MapTooltip {
  title: string;
  lines: string[];
}

/**
 * Where listeners are: countries shaded by listeners (one hue, light to dark) and a dot per city, sized by sessions.
 */
export function WorldMap({
  countries,
  places,
  countryTooltip,
  placeTooltip,
  labels,
  height = 380,
}: {
  countries: Map<string, number>;
  places: Place[];
  countryTooltip: (code: string, value: number) => MapTooltip;
  placeTooltip: (p: Place) => MapTooltip;
  labels: { world: string; europe: string; loading: string };
  height?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [shapes, setShapes] = useState<CountryFeature[] | null>(null);
  const [region, setRegion] = useState<'world' | 'europe'>('world');
  const [tip, setTip] = useState<(MapTooltip & { x: number; y: number }) | null>(null);

  useEffect(() => {
    void loadCountries().then(setShapes).catch(() => setShapes([]));
  }, []);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.floor(e!.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);

  const h = Math.min(height, Math.max(220, width * 0.55));
  const { path, project } = useMemo(() => {
    const projection = geoNaturalEarth1();
    const target = region === 'europe' ? EUROPE : ({ type: 'Sphere' } as GeoPermissibleObjects);
    projection.fitExtent(
      [
        [8, 8],
        [Math.max(16, width - 8), h - 8],
      ],
      target,
    );
    return { path: geoPath(projection), project: (lon: number, lat: number) => projection([lon, lat]) };
  }, [width, h, region]);

  const max = Math.max(1e-9, ...countries.values());
  const maxSessions = Math.max(1, ...places.map((p) => p.sessions));
  const shade = (v: number) => `color-mix(in srgb, var(--koraal) ${Math.round(18 + Math.sqrt(v / max) * 82)}%, var(--surface-raised))`;
  const show = (e: React.PointerEvent, t: MapTooltip) => {
    const box = ref.current!.getBoundingClientRect();
    setTip({ ...t, x: e.clientX - box.left, y: e.clientY - box.top });
  };

  return (
    <div ref={ref} className="relative w-full overflow-hidden" style={{ height: h }} onPointerLeave={() => setTip(null)}>
      <div className="absolute top-2 right-2 z-10 flex rounded-full border border-line bg-raised p-0.5 text-[11px] font-semibold">
        {(['world', 'europe'] as const).map((r) => (
          <button
            key={r}
            type="button"
            onClick={() => setRegion(r)}
            className={clsx('h-6 rounded-full px-2.5', region === r ? 'bg-[var(--nav-active-bg)] text-[var(--nav-active-ink)]' : 'text-muted hover:bg-hover')}
          >
            {labels[r]}
          </button>
        ))}
      </div>
      {!shapes && <div className="grid h-full place-items-center text-[13px] text-muted">{labels.loading}</div>}
      {shapes && width > 0 && (
        <svg width={width} height={h} className="block">
          <path d={path({ type: 'Sphere' } as GeoPermissibleObjects) ?? ''} fill="var(--surface)" />
          {shapes.map((f) => {
            const v = countries.get(f.id) ?? 0;
            return (
              <path
                key={f.id + (f.geometry as { type: string }).type}
                d={path(f as unknown as GeoPermissibleObjects) ?? ''}
                fill={v > 0 ? shade(v) : 'var(--chip)'}
                stroke="var(--surface-raised)"
                strokeWidth={0.6}
                onPointerMove={(e) => show(e, countryTooltip(f.id, v))}
                className="transition-[fill-opacity] hover:fill-opacity-80"
              />
            );
          })}
          {places.map((p) => {
            const xy = project(p.lon, p.lat);
            if (!xy) return null;
            const r = 2.5 + Math.sqrt(p.sessions / maxSessions) * 11;
            return (
              <circle
                key={`${p.country}-${p.city}-${p.lat}-${p.lon}`}
                cx={xy[0]}
                cy={xy[1]}
                r={r}
                fill="var(--nacht)"
                fillOpacity={0.55}
                stroke="var(--surface-raised)"
                strokeWidth={1.5}
                className="dark:fill-[var(--lucht)]"
                onPointerMove={(e) => show(e, placeTooltip(p))}
              />
            );
          })}
        </svg>
      )}
      {tip && (
        <div className="pointer-events-none absolute z-20 rounded-md border border-line bg-raised px-3 py-2 text-xs shadow-lg" style={{ left: Math.min(tip.x + 14, Math.max(0, width - 190)), top: Math.max(0, tip.y - 10) }}>
          <div className="font-semibold">{tip.title}</div>
          {tip.lines.map((l) => (
            <div key={l} className="text-muted">
              {l}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
