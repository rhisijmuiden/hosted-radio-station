import clsx from 'clsx';
import { Activity, Building2, Check, Cpu, Globe2, Headphones, Maximize2, Mic, Minus, Plus, Radio, RadioTower, Server, Users, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { Topology, TopologyCell, TopologyLink, TopologyNode, TopologyStation } from '../../lib/api';
import { formatMs, formatPct } from '../nodes/common';

export type FlatLayout = 'lr' | 'tb';

type Health = 'online' | 'degraded' | 'offline' | 'unpaired';
type Lane = 'studios' | 'ingest' | 'distribution' | 'audience';
const LANES: Lane[] = ['studios', 'ingest', 'distribution', 'audience'];

interface Card {
  key: string;
  /** What a click selects (a node, a studio or the orchestrator). */
  select: string | null;
  /** monitor: a monitoring node, in a band of its own opposite the orchestrator (phase 20). */
  lane: Lane | 'control' | 'monitor';
  icon: ReactNode;
  title: string;
  meta: string;
  health: Health | null;
  /** A short tag on the card: INGEST, RELAY, MAIN, BACKUP. */
  tag?: string;
  core?: boolean;
  audience?: boolean;
  own?: boolean;
  dim: boolean;
  /** A frame around cards that belong together: relays of one location ("loc:…"), or a station node with its FM/MPX
   * nodes ("studio:…"). */
  group?: string;
  /** What the monitoring node heard here: a badge on the card. */
  check?: 'ok' | 'failed' | null;
}
interface Edge {
  from: string;
  to: string;
  kind: 'stream' | 'control' | 'listen' | 'check';
  /** idle: a listener line without listeners; standby: a backup feed that waits. */
  state: 'ok' | 'degraded' | 'down' | 'idle' | 'standby';
  label: string | null;
  dim: boolean;
  /** Line width: bitrate × streams for audio, listeners for the audience. */
  width?: number;
}

const healthOf = (n: TopologyNode): Health => (!n.paired ? 'unpaired' : !n.online ? 'offline' : n.degraded ? 'degraded' : 'online');

const CARD_H = 54;
const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/** Thicker lines for more audio: a 128 kbps stream is about 3 px, five of them about 4.6 px. */
export const streamWidth = (l: Pick<TopologyLink, 'kbps' | 'streams'>) => 2 + Math.min(5, Math.log2(1 + (l.kbps ?? Math.max(1, l.streams) * 128) / 128));
const listenWidth = (n: number) => (n > 0 ? 1.5 + Math.min(5, Math.log2(1 + n) / 1.6) : 1.5);

/** 🇳🇱 for NL. */
export const flag = (cc: string | null) => (cc && /^[A-Z]{2}$/i.test(cc) ? String.fromCodePoint(...[...cc.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65)) : '🌐');

export function countryName(cc: string | null, lang: string) {
  if (!cc) return null;
  try {
    return new Intl.DisplayNames([lang], { type: 'region' }).of(cc.toUpperCase()) ?? cc;
  } catch {
    return cc;
  }
}

/** The name of a node, or of one of this server's own roles (named after the orchestrator, phase 18). */
export function nodeName(t: (k: string, o?: Record<string, unknown>) => string, n: TopologyNode, customer: boolean) {
  if (n.local) return n.name && !n.name.startsWith('local:') ? n.name : t(n.id === 'local:ingest' ? 'topology.local.ingest' : 'topology.local.relay');
  return customer && n.own ? t('topology.myNode', { name: n.name }) : n.name;
}

const cellState = (c: TopologyCell | undefined): Edge['state'] => (c === 'onAir' ? 'ok' : c === 'degraded' ? 'degraded' : c === 'standby' ? 'standby' : c === 'down' ? 'down' : 'idle');

/**
 * The topology as a flat signal flow: studios and encoders → ingest → relays → listeners, left to right or top to
 * bottom (the layers view, phase 18). Relays of the same location stand in one group; lines grow with bitrate and
 * streams. The orchestrator stands apart on a control bus of its own; it carries no audio. With `focus` it follows one
 * station: its main and backup ingest, the feed each relay plays and its listeners per relay and country, everything
 * else faded.
 */
export default function TopologyFlat({
  data,
  layout,
  dimmed,
  selected,
  showControl,
  showChecks,
  focus,
  onSelect,
}: {
  data: Topology;
  layout: FlatLayout;
  dimmed: Set<string>;
  selected: string | null;
  /** Draw every control line, not only those of the selected block. */
  showControl: boolean;
  /** Draw every check line of the monitoring nodes, not only those of the selected block. */
  showChecks: boolean;
  /** The station the per station view follows. */
  focus?: TopologyStation | null;
  onSelect: (id: string | null) => void;
}) {
  const { t, i18n } = useTranslation();
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
    // In the per station view only the servers on the station's path stay bright.
    const path = focus ? new Set([focus.ingest, focus.backup, focus.stationNode, ...focus.relays, ...Object.keys(focus.cells)].filter((x): x is string => !!x)) : null;
    const off = (id: string) => dimmed.has(id) || (!!path && !path.has(id));
    const feed = focus ? (focus.active === focus.backup && focus.backup ? t('topology.station.backup') : t('topology.station.main')) : '';
    const stationListeners = (nodeId: string) => (focus ? data.audience.filter((a) => a.stationId === focus.id && a.nodeId === nodeId).reduce((n, a) => n + a.listeners, 0) : 0);

    cards.push({
      key: 'main',
      select: 'main',
      lane: 'control',
      icon: <Cpu />,
      title: data.main.name || t('topology.main'),
      // The role and the version: the bus beside the card already says it carries no audio.
      meta: `${t('topology.orchestrator')} · v${data.main.version}`,
      health: 'online',
      core: true,
      dim: false,
      check: data.links.some((l) => l.kind === 'check' && l.to === 'main') ? (data.links.some((l) => l.kind === 'check' && l.to === 'main' && l.degraded) ? 'failed' : 'ok') : null,
    });
    // An FM/MPX node of a station on a station node stands in the studio, right beside that node.
    const homeOf = (fmId: string) => {
      const id = data.nodes.find((x) => x.id === fmId)?.home ?? data.stations.find((s) => s.cells[fmId] && s.stationNode)?.stationNode;
      return id ? data.nodes.find((x) => x.id === id && x.roles.includes('station')) : undefined;
    };
    const studioGroup = (n: TopologyNode) => `studio:${nodeName(t, n, customer)}`;
    // A live studio on a station node joins that node's group too.
    const studioHome = (studioId: string) => {
      const to = data.links.find((l) => l.kind === 'stream' && l.from === studioId)?.to;
      return data.nodes.find((x) => x.id === to && x.roles.includes('station'));
    };
    const homes = new Set([...data.nodes.filter((n) => n.roles.includes('fm') && !n.roles.includes('relay')).map((n) => homeOf(n.id)?.id), ...data.studios.map((s) => studioHome(s.id)?.id)].filter(Boolean));
    for (const s of data.studios) {
      if (focus && s.stationId !== focus.id) continue;
      const home = studioHome(s.id);
      add({ key: s.id, select: s.id, lane: 'studios', group: home ? studioGroup(home) : undefined, icon: <Mic />, title: t('topology.studioOf', { station: s.station }), meta: `${s.account} · ${s.via}`, health: 'online', dim: dimmed.has(s.id) });
    }
    // Relays of one location stand together.
    const ordered = [...data.nodes].sort((a, b) => (a.roles.includes('relay') && b.roles.includes('relay') ? (a.location || '~').localeCompare(b.location || '~') : 0));
    for (const n of ordered) {
      // A station node is the studio itself: it runs its stations and pushes to the relays like an ingest does.
      const stationNode = n.roles.includes('station');
      const ingest = n.roles.includes('source') || stationNode;
      const relay = n.roles.includes('relay');
      const fm = !relay && n.roles.includes('fm');
      const monitor = !ingest && !relay && !fm && n.roles.includes('monitor');
      const common = { select: n.id, title: nodeName(t, n, customer), health: healthOf(n), own: customer && n.own, dim: off(n.id), check: n.check };
      if (ingest) {
        const role = focus && focus.ingest === n.id ? 'main' : focus && focus.backup === n.id ? 'backup' : null;
        const text = role
          ? `${t(`topology.station.${role}`)} · ${focus!.active === n.id ? t('topology.onAir') : n.online ? t('routing.standby') : t('nodes.health.offline')}`
          : stationNode
            ? t('topology.stationsCount', { count: n.stations })
            : t('topology.encodersCount', { count: n.encoders });
        add({ ...common, key: `${n.id}#in`, lane: stationNode ? 'studios' : 'ingest', group: stationNode && homes.has(n.id) ? studioGroup(n) : undefined, icon: stationNode ? <Building2 /> : <Server />, tag: role ? t(`topology.station.${role}`).toUpperCase() : stationNode ? t('topology.tags.station') : t('topology.tags.ingest'), meta: meta(n, text) });
      }
      if (monitor) {
        const checks = new Set(data.links.filter((l) => l.kind === 'check' && l.from === n.id).map((l) => l.to)).size;
        add({ ...common, key: `${n.id}#out`, lane: 'monitor', icon: <Activity />, meta: meta(n, t('topology.checksCount', { count: checks })), dim: dimmed.has(n.id) });
      } else if (relay || !ingest) {
        const text = relay
          ? focus && path?.has(n.id)
            ? t('topology.station.plays', { feed, count: stationListeners(n.id) })
            : `${t('topology.listenersCount', { count: n.listeners })}${!n.local && n.online && n.rttMs != null ? ` · ${formatMs(n.rttMs)}` : ''}`
          : fm
            ? n.fmOnAir
              ? t('topology.fmOnAir')
              : t('topology.fmOff')
            : n.location || t('nodes.noRoles');
        const home = fm ? homeOf(n.id) : undefined;
        add({
          ...common,
          key: `${n.id}#out`,
          lane: home ? 'studios' : 'distribution',
          icon: relay ? <Radio /> : fm ? <RadioTower /> : <Server />,
          tag: relay ? t('topology.tags.relay') : fm ? 'FM' : undefined,
          meta: meta(n, text),
          group: home ? studioGroup(home) : relay && !focus && n.location ? `loc:${n.location}` : undefined,
        });
      }
      // Control only: the orchestrator steers the node, the audio does not pass it.
      if (n.paired) edges.push({ from: 'main', to: ingest ? `${n.id}#in` : `${n.id}#out`, kind: 'control', state: !n.online ? 'down' : n.degraded ? 'degraded' : 'ok', label: n.local ? null : latency(n), dim: off(n.id) });
      if (n.roles.includes('fm') && (!focus || focus.cells[n.id])) {
        add({
          key: `fm:${n.id}`,
          select: n.id,
          lane: 'audience',
          icon: <RadioTower />,
          title: t('topology.flat.fmListeners', { where: n.location || n.city || '' }).trim(),
          meta: n.fmOnAir ? t('topology.fmOnAir') : t('topology.fmOff'),
          health: null,
          audience: true,
          dim: off(n.id),
        });
        edges.push({ from: relay || !ingest ? `${n.id}#out` : `${n.id}#in`, to: `fm:${n.id}`, kind: 'listen', state: n.online && n.fmOnAir ? 'ok' : 'idle', label: null, dim: off(n.id) });
      }
    }

    // Listeners: per country over all relays, or (per station) per relay with the countries in it.
    const relayCards = data.nodes.filter((n) => n.roles.includes('relay') && keys.has(`${n.id}#out`));
    if (focus) {
      for (const n of relayCards) {
        if (!focus.relays.includes(n.id)) continue;
        const rows = data.audience.filter((a) => a.stationId === focus.id && a.nodeId === n.id).sort((a, b) => b.listeners - a.listeners);
        const total = rows.reduce((s, a) => s + a.listeners, 0);
        const countries = new Map<string, number>();
        for (const r of rows) countries.set(r.country ?? '', (countries.get(r.country ?? '') ?? 0) + r.listeners);
        const title = [...countries].slice(0, 4).map(([cc, v]) => `${flag(cc || null)} ${v}`).join('  ') || (n.local ? t('topology.flat.direct') : n.location || t('topology.flat.listeners'));
        add({ key: `aud:${n.id}`, select: n.id, lane: 'audience', icon: n.local ? <Headphones /> : <Users />, title, meta: t('topology.flat.now', { count: total }), health: null, audience: true, dim: false });
        edges.push({ from: `${n.id}#out`, to: `aud:${n.id}`, kind: 'listen', state: total > 0 ? 'ok' : 'idle', label: null, dim: false, width: listenWidth(total) });
      }
    } else {
      const byCountry = new Map<string, Map<string, number>>();
      for (const a of data.audience) {
        if (!keys.has(`${a.nodeId}#out`)) continue;
        const m = byCountry.get(a.country ?? '') ?? new Map<string, number>();
        m.set(a.nodeId, (m.get(a.nodeId) ?? 0) + a.listeners);
        byCountry.set(a.country ?? '', m);
      }
      const ranked = [...byCountry].map(([cc, m]) => ({ cc, m, total: [...m.values()].reduce((s, v) => s + v, 0) })).sort((a, b) => b.total - a.total);
      // Six countries at most; the rest (and unknown places) as "Other".
      const top = ranked.filter((r) => r.cc).slice(0, 6);
      const rest = ranked.filter((r) => !top.includes(r));
      const groups = [...top.map((r) => ({ key: r.cc, title: `${flag(r.cc)} ${countryName(r.cc, i18n.language)}`, m: r.m, total: r.total }))];
      if (rest.length) {
        const m = new Map<string, number>();
        for (const r of rest) for (const [id, v] of r.m) m.set(id, (m.get(id) ?? 0) + v);
        groups.push({ key: 'other', title: t('topology.flat.other'), m, total: rest.reduce((s, r) => s + r.total, 0) });
      }
      for (const g of groups) {
        add({ key: `cc:${g.key}`, select: null, lane: 'audience', icon: <Globe2 />, title: g.title, meta: t('topology.listenersCount', { count: g.total }), health: null, audience: true, dim: false });
        for (const [id, v] of g.m) edges.push({ from: `${id}#out`, to: `cc:${g.key}`, kind: 'listen', state: 'ok', label: null, dim: dimmed.has(id), width: listenWidth(v) });
      }
      // Relays with listeners the statistics have no place for yet still get their own audience card.
      for (const n of relayCards) {
        if (!n.online || n.listeners <= 0 || data.audience.some((a) => a.nodeId === n.id)) continue;
        add({ key: `aud:${n.id}`, select: n.id, lane: 'audience', icon: n.local ? <Headphones /> : <Users />, title: n.local ? t('topology.flat.direct') : n.location || n.city || t('topology.flat.listeners'), meta: t('topology.flat.now', { count: n.listeners }), health: null, audience: true, dim: dimmed.has(n.id) });
        edges.push({ from: `${n.id}#out`, to: `aud:${n.id}`, kind: 'listen', state: 'ok', label: null, dim: dimmed.has(n.id), width: listenWidth(n.listeners) });
      }
    }

    // Audio as the server reports it: studio → ingest, ingest → relay, thicker for more bitrate and streams.
    const card = (id: string, side: 'in' | 'out') => {
      if (id === 'main' || keys.has(id)) return id;
      const want = `${id}#${side}`;
      return keys.has(want) ? want : `${id}#${side === 'in' ? 'out' : 'in'}`;
    };
    if (focus) {
      const studios = new Set(data.studios.filter((s) => s.stationId === focus.id).map((s) => s.id));
      for (const l of data.links.filter((x) => x.kind === 'stream' && studios.has(x.from))) edges.push({ from: l.from, to: card(l.to, 'in'), kind: 'stream', state: 'ok', label: null, dim: false });
      // A station node that sends through its ingest(s): the studio's single upload to each of them.
      if (focus.stationNode)
        for (const id of [focus.ingest, focus.backup]) {
          if (!id || id === focus.stationNode || !data.links.some((x) => x.kind === 'stream' && x.from === focus.stationNode && x.to === id)) continue;
          edges.push({ from: card(focus.stationNode, 'in'), to: card(id, 'in'), kind: 'stream', state: cellState(focus.cells[id]), label: null, dim: false });
        }
      if (focus.active)
        for (const r of focus.relays) {
          const l = data.links.find((x) => x.kind === 'stream' && !x.standby && x.from === focus.active && x.to === r);
          edges.push({ from: card(focus.active, 'in'), to: card(r, 'out'), kind: 'stream', state: cellState(focus.cells[r]), label: null, dim: false, width: l ? streamWidth({ kbps: null, streams: 1 }) : undefined });
        }
      for (const l of data.links.filter((x) => x.standby && x.from === focus.backup && focus.relays.includes(x.to)))
        edges.push({ from: card(l.from, 'in'), to: card(l.to, 'out'), kind: 'stream', state: 'standby', label: null, dim: false });
      for (const l of data.links.filter((x) => x.kind === 'stream' && focus.cells[x.to] && focus.relays.includes(x.from) && data.nodes.find((n) => n.id === x.to)?.roles.includes('fm')))
        edges.push({ from: card(l.from, 'out'), to: card(l.to, 'out'), kind: 'stream', state: l.active ? 'ok' : 'down', label: null, dim: false });
    } else {
      for (const l of data.links.filter((x) => x.kind === 'stream')) {
        const from = card(l.from, 'in');
        const to = card(l.to, l.from.startsWith('studio:') ? 'in' : 'out');
        edges.push({ from, to, kind: 'stream', state: l.standby ? 'standby' : !l.active ? 'down' : l.degraded ? 'degraded' : 'ok', label: null, dim: dimmed.has(l.from) || dimmed.has(l.to), width: l.standby ? undefined : streamWidth(l) });
      }
    }
    // The monitoring nodes listen to the streams of the servers they check (phase 20).
    for (const l of data.links.filter((x) => x.kind === 'check')) {
      if (!keys.has(`${l.from}#out`)) continue;
      const to = card(l.to, 'out');
      if (!keys.has(to)) continue;
      edges.push({ from: `${l.from}#out`, to, kind: 'check', state: !l.active ? 'down' : l.degraded ? 'degraded' : 'ok', label: null, dim: off(l.to) });
    }
    // Cards of one studio group stand side by side: the FM/MPX nodes right after their station node.
    const sorted: Card[] = [];
    for (const c of cards) {
      if (sorted.includes(c)) continue;
      sorted.push(c);
      if (c.group?.startsWith('studio:')) sorted.push(...cards.filter((x) => x !== c && x.group === c.group && !sorted.includes(x)));
    }
    return { cards: sorted, edges };
  }, [data, dimmed, focus, t, i18n.language]);

  const lr = layout === 'lr';
  const perLane = LANES.map((l) => cards.filter((c) => c.lane === l));
  const monitors = cards.filter((c) => c.lane === 'monitor');
  const most = Math.max(...perLane.map((c) => c.length), 1);
  const n = LANES.length;
  // The orchestrator gets a band of its own: above the flow (left to right) or beside it (top to bottom).
  const BAND = lr ? 92 : 190;
  // The monitoring nodes get one opposite it: below the flow, or to the right of it.
  const MON = monitors.length ? (lr ? 96 : 200) : 0;
  // Location groups need a little room for their title.
  const grouped = cards.some((c) => c.group);
  const STEP = grouped ? 84 : 72;
  // The view fits the box; it only grows (and scrolls) when the cards would get too small. Room is kept at the bottom
  // for the legend and the zoom buttons.
  const W = lr ? Math.max(box.w, n * 186 + 48) : Math.max(box.w, BAND + MON + most * 158 + 48);
  const H = lr ? Math.max(box.h, BAND + MON + most * STEP + 150) : Math.max(box.h, n * 112 + 120);
  const cardW = lr ? clamp((W - 48) / n - 36, 150, 180) : clamp((W - BAND - MON - 48) / most - 18, 140, 172);
  const [start, end] = lr ? [cardW / 2 + 24, cardW / 2 + 24] : [76, 140];
  const along = (i: number) => start + (i * ((lr ? W : H) - start - end)) / (n - 1);
  const pos = new Map<string, { x: number; y: number }>();
  // The orchestrator in the top left corner; its control bus runs along the band, away from the audio.
  const mainPos = lr ? { x: cardW / 2 + 24, y: 46 } : { x: BAND / 2 + 4, y: 46 };
  pos.set('main', mainPos);
  const bus = lr ? `M${mainPos.x + cardW / 2} ${mainPos.y} H${W - 24}` : `M${mainPos.x} ${mainPos.y + CARD_H / 2} V${H - 24}`;
  const [from, to] = lr ? [BAND + 52, H - 92 - MON] : [BAND + 24, W - 24 - MON];
  perLane.forEach((list, i) => {
    const a = along(i);
    list.forEach((c, j) => {
      const b = from + ((j + 0.5) * (to - from)) / list.length;
      pos.set(c.key, lr ? { x: a, y: b } : { x: b, y: a });
    });
  });
  // Each monitoring node stands in a gap between two lanes, so its control line runs down that gap clear of the cards.
  const monV = lr ? H - 56 - MON / 2 : W - 16 - MON / 2;
  monitors.forEach((c, i) => {
    const u = along([1.5, 0.5, 2.5][i % 3]! + Math.floor(i / 3) * 0.25);
    pos.set(c.key, lr ? { x: u, y: monV } : { x: monV, y: u });
  });
  // A frame around the relays of each location.
  const groups: { name: string; x: number; y: number; w: number; h: number }[] = [];
  for (const c of perLane.flat()) {
    if (!c.group) continue;
    const p = pos.get(c.key)!;
    const g = groups.find((x) => x.name === c.group);
    const r = { x: p.x - cardW / 2 - 8, y: p.y - CARD_H / 2 - 22, w: cardW + 16, h: CARD_H + 30 };
    if (!g) groups.push({ name: c.group, ...r });
    else {
      const x2 = Math.max(g.x + g.w, r.x + r.w);
      const y2 = Math.max(g.y + g.h, r.y + r.h);
      g.x = Math.min(g.x, r.x);
      g.y = Math.min(g.y, r.y);
      g.w = x2 - g.x;
      g.h = y2 - g.y;
    }
  }

  const laneIndex = new Map(perLane.flatMap((list, i) => list.map((c) => [c.key, i] as const)));
  // A line over more than one lane passes each lane in between through the gap between two cards, never through one.
  // Worked out along the flow (u) and across it (v), so it serves both directions.
  const route = (fromKey: string, toKey: string, A: { x: number; y: number }, B: { x: number; y: number }, k: number) => {
    const halfU = lr ? cardW / 2 : CARD_H / 2;
    const uv = (p: { x: number; y: number }) => (lr ? [p.x, p.y] : [p.y, p.x]) as [number, number];
    const xy = (u: number, v: number) => (lr ? `${u} ${v}` : `${v} ${u}`);
    const [au, av] = uv(A);
    const [bu, bv] = uv(B);
    const ia = laneIndex.get(fromKey);
    const ib = laneIndex.get(toKey);
    // Stretches of the path: from a point leaving a lane to a point entering the next.
    const hops: [number, number][] = [[au + k * halfU, av]];
    if (ia != null && ib != null)
      for (let i = ia + k; i !== ib && Math.abs(ib - ia) > 1; i += k) {
        const list = perLane[i]!;
        if (!list.length) continue;
        const lu = along(i);
        const [pu, pv] = hops[hops.length - 1]!;
        const v = pv + ((lu - pu) / (bu - pu)) * (bv - pv);
        // Always through a gap, even when the straight line would miss the cards: the bends between lanes then stay in
        // the open space between them. The nearest boundary between two cards (or beyond the first or the last).
        const step = (to - from) / list.length;
        const gv = from + clamp(Math.round((v - from) / step), 0, list.length) * step;
        hops.push([lu - k * (halfU + 12), gv], [lu + k * (halfU + 12), gv]);
      }
    hops.push([bu - k * halfU, bv]);
    let d = `M${xy(hops[0]![0], hops[0]![1])}`;
    for (let i = 1; i < hops.length; i++) {
      const [pu, pv] = hops[i - 1]!;
      const [qu, qv] = hops[i]!;
      // Inside a lane the line runs straight through the gap; between lanes it bends.
      if (i % 2 === 0) d += ` L${xy(qu, qv)}`;
      else d += ` C${xy((pu + qu) / 2, pv)} ${xy((pu + qu) / 2, qv)} ${xy(qu, qv)}`;
    }
    return d;
  };

  const touches = (key: string) => !!selected && (key === selected || key.startsWith(`${selected}#`));
  const shown = (e: Edge) =>
    e.kind === 'check' ? showChecks || touches(e.from) || touches(e.to) : e.kind !== 'control' || showControl || selected === 'main' || (!!selected && e.to.startsWith(`${selected}#`));
  // Where a check line ends: the badge on the lower corner of the card, on the side away from the incoming audio.
  const badgeAt = (p: { x: number; y: number }) => (lr ? { x: p.x + cardW / 2, y: p.y + CARD_H / 2 - 8 } : { x: p.x + cardW / 2 - 8, y: p.y + CARD_H / 2 });
  // A check line: from the monitoring node into the gap after the card's lane, along it, and into the badge. Worked out
  // along the flow (u) and across it (v) like the audio.
  const checkPath = (A: { x: number; y: number }, B: { x: number; y: number }) => {
    const uv = (p: { x: number; y: number }) => (lr ? [p.x, p.y] : [p.y, p.x]) as [number, number];
    const xy = (u: number, v: number) => (lr ? `${u} ${v}` : `${v} ${u}`);
    const halfU = lr ? cardW / 2 : CARD_H / 2;
    const halfV = lr ? CARD_H / 2 : cardW / 2;
    const [au, av] = uv(A);
    const [eu, ev] = uv(badgeAt(B));
    const gu = uv(B)[0] + halfU + 14;
    const sv = av - halfV;
    return `M${xy(au, sv)} C${xy(au, sv - 34)} ${xy(gu, sv - 14)} ${xy(gu, sv - 48)} L${xy(gu, ev + 14)} Q${xy(gu, ev)} ${xy(eu, ev)}`;
  };
  const paths = edges.filter(shown).flatMap((e) => {
    const A = pos.get(e.from);
    const B = pos.get(e.to);
    if (!A || !B) return [];
    let d: string;
    if (e.kind === 'check') d = checkPath(A, B);
    else if (e.kind === 'control') {
      // Straight off the control bus into the top (or the left) of the node.
      d = lr ? `M${B.x} ${A.y} V${B.y - CARD_H / 2}` : `M${A.x} ${B.y} H${B.x - cardW / 2}`;
    } else
    {
      // A line back to an earlier lane (a relay feeding an FM node in the studio) leaves and enters on the near sides.
      const k = (lr ? B.x < A.x : B.y < A.y) ? -1 : 1;
      // Within one lane (a studio and its station node): a short straight line between the two cards.
      if (lr ? A.x === B.x : A.y === B.y)
        d = lr ? `M${A.x} ${A.y + (B.y > A.y ? 1 : -1) * (CARD_H / 2)} V${B.y - (B.y > A.y ? 1 : -1) * (CARD_H / 2)}` : `M${A.x + (B.x > A.x ? 1 : -1) * (cardW / 2)} ${A.y} H${B.x - (B.x > A.x ? 1 : -1) * (cardW / 2)}`;
      else d = route(e.from, e.to, A, B, k);
    }
    // A control pill sits just above its node, clear of the neighbouring cards.
    const mid = e.kind === 'control' ? { x: B.x, y: B.y - CARD_H / 2 - (lr ? 16 : 10) } : { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 };
    return [{ ...e, d, mid }];
  });
  // When the box is narrower than the flow (say, with the side panel open), the view zooms out to fit its width.
  const fit = box.w > 0 ? Math.min(1, box.w / W) : 1;
  const scale = zoom * fit;
  const isSel = (c: Card) => !!selected && c.select === selected && !c.audience;

  const tool = 'grid size-9 place-items-center rounded-md border border-line bg-raised text-muted shadow-sm hover:bg-hover hover:text-ink';
  return (
    <>
      <div ref={host} className="absolute inset-0 overflow-auto" onClick={(e) => e.target === e.currentTarget && onSelect(null)}>
        {box.w > 0 && (
          <div style={{ width: W * scale, height: H * scale }}>
            <div className="relative origin-top-left" style={{ width: W, height: H, transform: `scale(${scale})` }} onClick={(e) => e.target === e.currentTarget && onSelect(null)}>
              {LANES.map((l, i) => {
                const a = along(i);
                return lr ? (
                  <div key={l}>
                    <div className="topo-lane absolute" style={{ left: a - cardW / 2 - 12, width: cardW + 24, top: BAND + 40, bottom: 56 + MON }} />
                    <div className="topo-lane-title absolute -translate-x-1/2" style={{ left: a, top: BAND + 16 }}>
                      {t(`topology.flat.lanes.${l}`)}
                    </div>
                  </div>
                ) : (
                  <div key={l}>
                    <div className="topo-lane absolute" style={{ top: a - 40, height: 80, left: BAND + 16, right: 16 + MON }} />
                    <div className="topo-lane-title absolute" style={{ top: a - 56, left: BAND + 24 }}>
                      {t(`topology.flat.lanes.${l}`)}
                    </div>
                  </div>
                );
              })}
              {MON > 0 &&
                (lr ? (
                  <>
                    <div className="topo-lane monitor absolute" style={{ left: 16, right: 16, top: monV - MON / 2 + 4, height: MON - 8 }} />
                    <div className="topo-lane-title absolute" style={{ left: 28, top: monV - MON / 2 + 10 }}>
                      {t('topology.flat.lanes.monitor')}
                    </div>
                  </>
                ) : (
                  <>
                    <div className="topo-lane monitor absolute" style={{ top: 16, bottom: 16, left: monV - MON / 2 + 4, width: MON - 8 }} />
                    <div className="topo-lane-title absolute" style={{ top: 24, left: monV - MON / 2 + 14 }}>
                      {t('topology.flat.lanes.monitor')}
                    </div>
                  </>
                ))}
              {groups.map((g) => (
                <div key={g.name}>
                  <div className="topo-group pointer-events-none absolute" style={{ left: g.x, top: g.y, width: g.w, height: g.h }} />
                  <div className="topo-group-title pointer-events-none absolute" style={{ left: g.x + 8, top: g.y + 4 }}>
                    {g.name.startsWith('loc:') ? `📍 ${g.name.slice(4)}` : `🏢 ${g.name.slice(7)}`}
                  </div>
                </div>
              ))}
              <svg className="pointer-events-none absolute inset-0" width={W} height={H}>
                <path className="topo-edge control bus" d={bus} />
                {paths.map((p) => (
                  <g key={`${p.from}>${p.to}>${p.kind}>${p.state}`} opacity={p.dim ? 0.2 : 1}>
                    {p.kind === 'stream' && p.state !== 'standby' && <path className="topo-edge base" d={p.d} style={p.width ? { strokeWidth: p.width } : undefined} />}
                    <path className={clsx('topo-edge', p.kind, p.state)} d={p.d} style={p.width ? { strokeWidth: p.width } : undefined} />
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
                    className={clsx('topo-card absolute -translate-x-1/2 -translate-y-1/2', c.core && 'core', c.lane === 'monitor' && 'monitor', c.audience && 'audience', c.own && 'own', isSel(c) && 'selected', c.dim && 'opacity-30')}
                    style={{ left: p.x, top: p.y, width: cardW, height: CARD_H }}
                  >
                    <span className="topo-card-icon">{c.icon}</span>
                    <span className="min-w-0 flex-1 text-left">
                      <span className="flex items-center gap-1.5">
                        {/* The name goes first: a long tag (STATION NODE) gives way, so two nodes stay apart. */}
                        <b className="block max-w-full min-w-0 shrink-0 truncate text-[12px] leading-tight">{c.title}</b>
                        {c.tag && <i className="ml-auto min-w-0 truncate text-[8.5px] font-bold tracking-wide text-accent-text not-italic">{c.tag}</i>}
                      </span>
                      <small className="flex items-center gap-1.5 truncate text-[10.5px]">
                        {c.health && <span className={clsx('topo-dot shrink-0', c.health !== 'online' && c.health)} />}
                        <span className="truncate">{c.meta}</span>
                      </small>
                    </span>
                  </button>
                );
              })}
              {cards
                .filter((c) => c.check)
                .map((c) => {
                  const b = badgeAt(pos.get(c.key)!);
                  return (
                    <span
                      key={`b:${c.key}`}
                      title={t(c.check === 'ok' ? 'topology.checkOk' : 'topology.checkFailed')}
                      className={clsx('topo-badge pointer-events-none absolute -translate-x-1/2 -translate-y-1/2', c.check, c.dim && 'opacity-30')}
                      style={{ left: b.x, top: b.y }}
                    >
                      {c.check === 'ok' ? <Check /> : <X />}
                    </span>
                  );
                })}
              {paths
                .filter((p) => p.label)
                .map((p) => (
                  <span
                    key={`l:${p.from}>${p.to}>${p.kind}`}
                    className={clsx('topo-pill pointer-events-none absolute -translate-x-1/2 -translate-y-1/2', p.state === 'degraded' || p.state === 'down' ? p.state : undefined, p.dim && 'opacity-30')}
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
