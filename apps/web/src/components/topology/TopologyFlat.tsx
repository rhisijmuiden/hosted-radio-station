import clsx from 'clsx';
import { Building2, Cpu, Headphones, Maximize2, Mic, Minus, Plus, Radio, RadioTower, Server, Users } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { Topology, TopologyNode } from '../../lib/api';
import { formatMs, formatPct } from '../nodes/common';

export type FlatLayout = 'lr' | 'tb';

type Health = 'online' | 'degraded' | 'offline' | 'unpaired';
type Lane = 'studios' | 'ingest' | 'distribution' | 'audience';
const LANES: Lane[] = ['studios', 'ingest', 'distribution', 'audience'];

interface Card {
  key: string;
  /** What a click selects (a node, a studio or the orchestrator). */
  select: string | null;
  lane: Lane | 'control';
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

/** The name of a node, or of one of this server's own roles. */
export function nodeName(t: (k: string, o?: Record<string, unknown>) => string, n: TopologyNode, customer: boolean) {
  if (n.local) return t(n.id === 'local:ingest' ? 'topology.local.ingest' : 'topology.local.relay');
  return customer && n.own ? t('topology.myNode', { name: n.name }) : n.name;
}

/**
 * The topology as a flat signal flow: studios and encoders → ingest → relays → listeners, left to right or top to
 * bottom. The orchestrator stands apart in a corner, on a control bus of its own; it carries no audio. Its (dashed)
 * lines to the nodes only show when asked for, or for the selected block, so they never tangle with the audio.
 */
export default function TopologyFlat({
  data,
  layout,
  dimmed,
  selected,
  showControl,
  onSelect,
}: {
  data: Topology;
  layout: FlatLayout;
  dimmed: Set<string>;
  selected: string | null;
  /** Draw every control line, not only those of the selected block. */
  showControl: boolean;
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
    const meta = (n: TopologyNode, text: string) => (!n.paired ? t('nodes.health.unpaired') : !n.online ? t('nodes.health.offline') : text);
    const keys = new Set<string>();
    const add = (c: Card) => {
      cards.push(c);
      keys.add(c.key);
    };

    cards.push({
      key: 'main',
      select: 'main',
      lane: 'control',
      icon: <Cpu />,
      title: t('topology.main'),
      meta: `${t('topology.controlOnly')} · v${data.main.version}`,
      health: 'online',
      core: true,
      dim: false,
    });
    for (const s of data.studios) {
      add({ key: s.id, select: s.id, lane: 'studios', icon: <Mic />, title: t('topology.studioOf', { station: s.station }), meta: `${s.account} · ${s.via}`, health: 'online', dim: dimmed.has(s.id) });
    }
    for (const n of data.nodes) {
      // A station node runs its stations itself and pushes to the relays like an ingest does.
      const stationNode = n.roles.includes('station');
      const ingest = n.roles.includes('source') || stationNode;
      const relay = n.roles.includes('relay');
      const fm = !relay && n.roles.includes('fm');
      const common = { select: n.id, title: nodeName(t, n, customer), health: healthOf(n), own: customer && n.own, dim: dimmed.has(n.id) };
      if (ingest) add({ ...common, key: `${n.id}#in`, lane: 'ingest', icon: stationNode ? <Building2 /> : <Server />, meta: meta(n, stationNode ? t('topology.stationsCount', { count: n.stations }) : t('topology.encodersCount', { count: n.encoders })) });
      if (relay || !ingest)
        add({
          ...common,
          key: `${n.id}#out`,
          lane: 'distribution',
          icon: relay ? <Radio /> : fm ? <RadioTower /> : <Server />,
          meta: meta(n, relay ? t('topology.listenersCount', { count: n.listeners }) : fm ? (n.fmOnAir ? t('topology.fmOnAir') : t('topology.fmOff')) : n.location || t('nodes.noRoles')),
        });
      // Control only: the orchestrator steers the node, the audio does not pass it.
      if (n.paired && !n.local) edges.push({ from: 'main', to: ingest ? `${n.id}#in` : `${n.id}#out`, kind: 'control', state: !n.online ? 'down' : n.degraded ? 'degraded' : 'ok', label: latency(n), dim: dimmed.has(n.id) });
      if (n.local) edges.push({ from: 'main', to: ingest ? `${n.id}#in` : `${n.id}#out`, kind: 'control', state: n.online ? 'ok' : 'down', label: null, dim: dimmed.has(n.id) });
      if (n.roles.includes('fm')) {
        add({
          key: `fm:${n.id}`,
          select: n.id,
          lane: 'audience',
          icon: <RadioTower />,
          title: t('topology.flat.fmListeners', { where: n.location || n.city || '' }).trim(),
          meta: n.fmOnAir ? t('topology.fmOnAir') : t('topology.fmOff'),
          health: null,
          audience: true,
          dim: dimmed.has(n.id),
        });
        edges.push({ from: relay || !ingest ? `${n.id}#out` : `${n.id}#in`, to: `fm:${n.id}`, kind: 'listen', state: n.online && n.fmOnAir ? 'ok' : 'idle', label: null, dim: dimmed.has(n.id) });
      }
      if (relay) {
        const where = n.local ? t('topology.flat.direct') : n.location || n.city || n.country;
        add({
          key: `aud:${n.id}`,
          select: n.id,
          lane: 'audience',
          icon: n.local ? <Headphones /> : <Users />,
          title: where || t('topology.flat.listeners'),
          meta: t('topology.flat.now', { count: n.online ? n.listeners : 0 }),
          health: null,
          audience: true,
          dim: dimmed.has(n.id),
        });
        edges.push({ from: `${n.id}#out`, to: `aud:${n.id}`, kind: 'listen', state: n.online && n.listeners > 0 ? 'ok' : 'idle', label: null, dim: dimmed.has(n.id) });
      }
    }
    // Audio as the server reports it: studio → ingest, ingest → relay.
    const card = (id: string, side: 'in' | 'out') => {
      if (id === 'main' || keys.has(id)) return id;
      const want = `${id}#${side}`;
      return keys.has(want) ? want : `${id}#${side === 'in' ? 'out' : 'in'}`;
    };
    for (const l of data.links.filter((x) => x.kind === 'stream')) {
      const from = card(l.from, 'in');
      const to = card(l.to, l.from.startsWith('studio:') ? 'in' : 'out');
      edges.push({ from, to, kind: 'stream', state: !l.active ? 'down' : l.degraded ? 'degraded' : 'ok', label: null, dim: dimmed.has(l.from) || dimmed.has(l.to) });
    }
    return { cards, edges };
  }, [data, dimmed, t]);

  const lr = layout === 'lr';
  const perLane = LANES.map((l) => cards.filter((c) => c.lane === l));
  const most = Math.max(...perLane.map((c) => c.length), 1);
  const n = LANES.length;
  // The orchestrator gets a band of its own: above the flow (left to right) or beside it (top to bottom).
  const BAND = lr ? 92 : 190;
  // The view fits the box; it only grows (and scrolls) when the cards would get too small. Room is kept at the bottom
  // for the legend and the zoom buttons.
  const W = lr ? Math.max(box.w, n * 186 + 48) : Math.max(box.w, BAND + most * 158 + 48);
  const H = lr ? Math.max(box.h, BAND + most * 72 + 120) : Math.max(box.h, n * 112 + 120);
  const cardW = lr ? clamp((W - 48) / n - 36, 150, 180) : clamp((W - BAND - 48) / most - 18, 140, 172);
  const [start, end] = lr ? [cardW / 2 + 24, cardW / 2 + 24] : [76, 140];
  const along = (i: number) => start + (i * ((lr ? W : H) - start - end)) / (n - 1);
  const pos = new Map<string, { x: number; y: number }>();
  // The orchestrator in the top left corner; its control bus runs along the band, away from the audio.
  const mainPos = lr ? { x: cardW / 2 + 24, y: 46 } : { x: BAND / 2 + 4, y: 46 };
  pos.set('main', mainPos);
  const bus = lr ? `M${mainPos.x + cardW / 2} ${mainPos.y} H${W - 24}` : `M${mainPos.x} ${mainPos.y + CARD_H / 2} V${H - 24}`;
  perLane.forEach((list, i) => {
    const a = along(i);
    const [from, to] = lr ? [BAND + 52, H - 64] : [BAND + 24, W - 24];
    list.forEach((c, j) => {
      const b = from + ((j + 0.5) * (to - from)) / list.length;
      pos.set(c.key, lr ? { x: a, y: b } : { x: b, y: a });
    });
  });

  const shown = (e: Edge) => e.kind !== 'control' || showControl || selected === 'main' || (!!selected && e.to.startsWith(`${selected}#`));
  const paths = edges.filter(shown).flatMap((e) => {
    const A = pos.get(e.from);
    const B = pos.get(e.to);
    if (!A || !B) return [];
    let d: string;
    if (e.kind === 'control') {
      // Straight off the control bus into the top (or the left) of the node.
      d = lr ? `M${B.x} ${A.y} V${B.y - CARD_H / 2}` : `M${A.x} ${B.y} H${B.x - cardW / 2}`;
    } else
      d = lr
        ? `M${A.x + cardW / 2} ${A.y} C${(A.x + B.x) / 2} ${A.y} ${(A.x + B.x) / 2} ${B.y} ${B.x - cardW / 2} ${B.y}`
        : `M${A.x} ${A.y + CARD_H / 2} C${A.x} ${(A.y + B.y) / 2} ${B.x} ${(A.y + B.y) / 2} ${B.x} ${B.y - CARD_H / 2}`;
    const mid = e.kind === 'control' ? (lr ? { x: B.x, y: B.y - CARD_H / 2 - 16 } : { x: B.x - cardW / 2 - 34, y: B.y }) : { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 };
    return [{ ...e, d, mid }];
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
                        top: BAND + 40,
                        bottom: 56,
                      }}
                    />
                    <div className="topo-lane-title absolute -translate-x-1/2" style={{ left: a, top: BAND + 16 }}>
                      {t(`topology.flat.lanes.${l}`)}
                    </div>
                  </div>
                ) : (
                  <div key={l}>
                    <div className="topo-lane absolute" style={{ top: a - 40, height: 80, left: BAND + 16, right: 16 }} />
                    <div className="topo-lane-title absolute" style={{ top: a - 56, left: BAND + 24 }}>
                      {t(`topology.flat.lanes.${l}`)}
                    </div>
                  </div>
                );
              })}
              <svg className="pointer-events-none absolute inset-0" width={W} height={H}>
                <path className="topo-edge control bus" d={bus} />
                {paths.map((p) => (
                  <g key={`${p.from}>${p.to}>${p.kind}`} opacity={p.dim ? 0.25 : 1}>
                    {p.kind !== 'control' && <path className="topo-edge base" d={p.d} />}
                    <path className={clsx('topo-edge', p.kind, p.state)} d={p.d} />
                  </g>
                ))}
              </svg>
              <div className="topo-lane-title absolute" style={lr ? { left: mainPos.x + cardW / 2 + 16, top: mainPos.y - 22 } : { left: mainPos.x + 10, top: mainPos.y + CARD_H / 2 + 8, writingMode: 'vertical-rl' }}>
                {t('topology.controlBus')}
              </div>
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
                    key={`l:${p.from}>${p.to}>${p.kind}`}
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
