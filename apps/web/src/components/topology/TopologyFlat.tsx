import clsx from 'clsx';
import { Cpu, Headphones, Maximize2, Mic, Minus, Plus, Radio, Server, Users } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { Topology, TopologyNode } from '../../lib/api';
import { formatMs, formatPct } from '../nodes/common';

export type FlatLayout = 'lr' | 'tb';

type Health = 'online' | 'degraded' | 'offline' | 'unpaired';
type Lane = 'studios' | 'ingest' | 'core' | 'distribution' | 'audience';
const LANES: Lane[] = ['studios', 'ingest', 'core', 'distribution', 'audience'];

interface Card {
  key: string;
  /** What a click selects (a node, a studio or the main server). */
  select: string | null;
  lane: Lane;
  icon: ReactNode;
  title: string;
  meta: string;
  health: Health | null;
  core?: boolean;
  audience?: boolean;
  own?: boolean;
  dim: boolean;
}
interface Edge {
  from: string;
  to: string;
  kind: 'stream' | 'control' | 'listen';
  /** idle: a listener line without listeners. */
  state: 'ok' | 'degraded' | 'down' | 'idle';
  label: string | null;
  dim: boolean;
}

const healthOf = (n: TopologyNode): Health => (!n.paired ? 'unpaired' : !n.online ? 'offline' : n.degraded ? 'degraded' : 'online');

const CARD_H = 54;
const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/**
 * The topology as a flat signal flow: studios and encoders → ingest → main server → distribution → listeners, left
 * to right or top to bottom, with the latency and packet loss of each node on its line.
 */
export default function TopologyFlat({
  data,
  layout,
  dimmed,
  selected,
  onSelect,
}: {
  data: Topology;
  layout: FlatLayout;
  dimmed: Set<string>;
  selected: string | null;
  onSelect: (id: string | null) => void;
}) {
  const { t } = useTranslation();
  const host = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [zoom, setZoom] = useState(1);
  useEffect(() => {
    if (!host.current) return;
    const ro = new ResizeObserver(([e]) => setBox({ w: e!.contentRect.width, h: e!.contentRect.height }));
    ro.observe(host.current);
    return () => ro.disconnect();
  }, []);

  const { cards, edges } = useMemo(() => {
    const cards: Card[] = [];
    const edges: Edge[] = [];
    const customer = data.view === 'customer';
    const latency = (n: TopologyNode) => (n.online && n.rttMs != null ? `${formatMs(n.rttMs)} · ${formatPct(n.loss ?? 0)}` : null);
    const state = (n: TopologyNode): Edge['state'] => (!n.online ? 'down' : n.degraded ? 'degraded' : 'ok');
    const streams = new Set(data.links.filter((l) => l.kind === 'stream' && l.active).map((l) => `${l.from}>${l.to}`));
    const name = (n: TopologyNode) => (customer && n.own ? t('topology.myNode', { name: n.name }) : n.name);
    const meta = (n: TopologyNode, text: string) => (!n.paired ? t('nodes.health.unpaired') : !n.online ? t('nodes.health.offline') : text);

    for (const s of data.studios) {
      const viaNode = s.nodeId ? data.nodes.find((n) => n.id === s.nodeId && n.roles.includes('source')) : undefined;
      cards.push({
        key: s.id,
        select: s.id,
        lane: 'studios',
        icon: <Mic />,
        title: t('topology.studioOf', { station: s.station }),
        meta: `${s.account} · ${s.via}`,
        health: 'online',
        dim: dimmed.has(s.id),
      });
      edges.push({
        from: s.id,
        to: viaNode ? `${viaNode.id}#in` : 'main',
        kind: 'stream',
        state: 'ok',
        label: null,
        dim: dimmed.has(s.id),
      });
    }
    for (const n of data.nodes.filter((x) => x.roles.includes('source'))) {
      const key = `${n.id}#in`;
      cards.push({
        key,
        select: n.id,
        lane: 'ingest',
        icon: <Server />,
        title: name(n),
        meta: meta(n, t('topology.encodersCount', { count: n.encoders })),
        health: healthOf(n),
        own: customer && n.own,
        dim: dimmed.has(n.id),
      });
      edges.push({
        from: key,
        to: 'main',
        kind: streams.has(`${n.id}>main`) ? 'stream' : 'control',
        state: state(n),
        label: latency(n),
        dim: dimmed.has(n.id),
      });
    }
    cards.push({
      key: 'main',
      select: 'main',
      lane: 'core',
      icon: <Cpu />,
      title: t('topology.main'),
      meta: `${t('topology.orchestrator')} · v${data.main.version}`,
      health: 'online',
      core: true,
      dim: false,
    });
    for (const n of data.nodes.filter((x) => x.roles.includes('relay') || !x.roles.includes('source'))) {
      const key = `${n.id}#out`;
      const relay = n.roles.includes('relay');
      cards.push({
        key,
        select: n.id,
        lane: 'distribution',
        icon: relay ? <Radio /> : <Server />,
        title: name(n),
        meta: meta(n, relay ? t('topology.listenersCount', { count: n.listeners }) : n.location || t('nodes.noRoles')),
        health: healthOf(n),
        own: customer && n.own,
        dim: dimmed.has(n.id),
      });
      edges.push({
        from: 'main',
        to: key,
        kind: streams.has(`main>${n.id}`) ? 'stream' : 'control',
        state: state(n),
        label: latency(n),
        dim: dimmed.has(n.id),
      });
      if (relay) {
        const where = n.location || n.city || n.country;
        cards.push({
          key: `aud:${n.id}`,
          select: n.id,
          lane: 'audience',
          icon: <Users />,
          title: where || t('topology.flat.listeners'),
          meta: t('topology.flat.now', { count: n.online ? n.listeners : 0 }),
          health: null,
          audience: true,
          dim: dimmed.has(n.id),
        });
        edges.push({
          from: key,
          to: `aud:${n.id}`,
          kind: 'listen',
          state: n.online && n.listeners > 0 ? 'ok' : 'idle',
          label: null,
          dim: dimmed.has(n.id),
        });
      }
    }
    cards.push({
      key: 'aud:main',
      select: 'main',
      lane: 'audience',
      icon: <Headphones />,
      title: t('topology.flat.direct'),
      meta: t('topology.flat.now', { count: data.main.listeners }),
      health: null,
      audience: true,
      dim: false,
    });
    edges.push({
      from: 'main',
      to: 'aud:main',
      kind: 'listen',
      state: data.main.listeners > 0 ? 'ok' : 'idle',
      label: null,
      dim: false,
    });
    return { cards, edges };
  }, [data, dimmed, t]);

  const lr = layout === 'lr';
  const perLane = LANES.map((l) => cards.filter((c) => c.lane === l));
  const most = Math.max(...perLane.map((c) => c.length), 1);
  // The view fits the box; it only grows (and scrolls) when the cards would get too small. Room is kept at the bottom
  // for the legend and the zoom buttons.
  const W = lr ? Math.max(box.w, 5 * 186 + 48) : Math.max(box.w, most * 158 + 48);
  const H = lr ? Math.max(box.h, most * 72 + 120) : Math.max(box.h, 5 * 112 + 120);
  const cardW = lr ? clamp((W - 48) / 5 - 36, 150, 180) : clamp((W - 48) / most - 18, 140, 172);
  const [start, end] = lr ? [cardW / 2 + 24, cardW / 2 + 24] : [76, 140];
  const along = (i: number) => start + (i * ((lr ? W : H) - start - end)) / (LANES.length - 1);
  const pos = new Map<string, { x: number; y: number }>();
  perLane.forEach((list, i) => {
    const a = along(i);
    const [from, to] = lr ? [52, H - 64] : [24, W - 24];
    list.forEach((c, j) => {
      const b = from + ((j + 0.5) * (to - from)) / list.length;
      pos.set(c.key, lr ? { x: a, y: b } : { x: b, y: a });
    });
  });

  const paths = edges.flatMap((e) => {
    const A = pos.get(e.from);
    const B = pos.get(e.to);
    if (!A || !B) return [];
    const d = lr
      ? `M${A.x + cardW / 2} ${A.y} C${(A.x + B.x) / 2} ${A.y} ${(A.x + B.x) / 2} ${B.y} ${B.x - cardW / 2} ${B.y}`
      : `M${A.x} ${A.y + CARD_H / 2} C${A.x} ${(A.y + B.y) / 2} ${B.x} ${(A.y + B.y) / 2} ${B.x} ${B.y - CARD_H / 2}`;
    return [{ ...e, d, mid: { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 } }];
  });
  const isSel = (c: Card) => !!selected && c.select === selected && !c.audience;

  const tool = 'grid size-9 place-items-center rounded-md border border-line bg-raised text-muted shadow-sm hover:bg-hover hover:text-ink';
  return (
    <>
      <div ref={host} className="absolute inset-0 overflow-auto" onClick={(e) => e.target === e.currentTarget && onSelect(null)}>
        {box.w > 0 && (
          <div style={{ width: W * zoom, height: H * zoom }}>
            <div className="relative origin-top-left" style={{ width: W, height: H, transform: `scale(${zoom})` }} onClick={(e) => e.target === e.currentTarget && onSelect(null)}>
              {LANES.map((l, i) => {
                const a = along(i);
                return lr ? (
                  <div key={l}>
                    <div
                      className="topo-lane absolute"
                      style={{
                        left: a - cardW / 2 - 12,
                        width: cardW + 24,
                        top: 40,
                        bottom: 56,
                      }}
                    />
                    <div className="topo-lane-title absolute -translate-x-1/2" style={{ left: a, top: 16 }}>
                      {t(`topology.flat.lanes.${l}`)}
                    </div>
                  </div>
                ) : (
                  <div key={l}>
                    <div className="topo-lane absolute" style={{ top: a - 40, height: 80, left: 16, right: 16 }} />
                    <div className="topo-lane-title absolute" style={{ top: a - 56, left: 24 }}>
                      {t(`topology.flat.lanes.${l}`)}
                    </div>
                  </div>
                );
              })}
              <svg className="pointer-events-none absolute inset-0" width={W} height={H}>
                {paths.map((p) => (
                  <g key={`${p.from}>${p.to}`} opacity={p.dim ? 0.25 : 1}>
                    <path className="topo-edge base" d={p.d} />
                    <path className={clsx('topo-edge', p.kind, p.state)} d={p.d} />
                  </g>
                ))}
              </svg>
              {cards.map((c) => {
                const p = pos.get(c.key)!;
                return (
                  <button
                    key={c.key}
                    type="button"
                    title={`${c.title} · ${c.meta}`}
                    onClick={() => onSelect(c.select)}
                    className={clsx('topo-card absolute -translate-x-1/2 -translate-y-1/2', c.core && 'core', c.audience && 'audience', c.own && 'own', isSel(c) && 'selected', c.dim && 'opacity-35')}
                    style={{
                      left: p.x,
                      top: p.y,
                      width: cardW,
                      height: CARD_H,
                    }}
                  >
                    <span className="topo-card-icon">{c.icon}</span>
                    <span className="min-w-0 text-left">
                      <b className="block truncate text-[12px] leading-tight">{c.title}</b>
                      <small className="flex items-center gap-1.5 truncate text-[10.5px]">
                        {c.health && <span className={clsx('topo-dot shrink-0', c.health !== 'online' && c.health)} />}
                        <span className="truncate">{c.meta}</span>
                      </small>
                    </span>
                  </button>
                );
              })}
              {paths
                .filter((p) => p.label)
                .map((p) => (
                  <span
                    key={`l:${p.from}>${p.to}`}
                    className={clsx(
                      'topo-pill pointer-events-none absolute -translate-x-1/2 -translate-y-1/2',
                      p.state === 'degraded' || p.state === 'down' ? p.state : undefined,
                      p.dim && 'opacity-30',
                    )}
                    style={{ left: p.mid.x, top: p.mid.y }}
                  >
                    {p.label}
                  </span>
                ))}
            </div>
          </div>
        )}
      </div>
      <div className="absolute right-3 bottom-3 flex gap-1.5">
        <button type="button" className={tool} title={t('topology.zoomIn')} onClick={() => setZoom((z) => Math.min(2, z * 1.2))}>
          <Plus className="size-4" />
        </button>
        <button type="button" className={tool} title={t('topology.zoomOut')} onClick={() => setZoom((z) => Math.max(0.4, z / 1.2))}>
          <Minus className="size-4" />
        </button>
        <button type="button" className={tool} title={t('topology.reset')} onClick={() => setZoom(1)}>
          <Maximize2 className="size-4" />
        </button>
      </div>
    </>
  );
}
