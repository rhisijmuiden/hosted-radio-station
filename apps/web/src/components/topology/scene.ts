import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { CSS2DObject, CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';

export type SceneKind = 'main' | 'relay' | 'source' | 'station' | 'fm' | 'node' | 'studio' | 'country' | 'monitor';
export type SceneHealth = 'online' | 'degraded' | 'offline' | 'unpaired';

export interface SceneNode {
  id: string;
  kind: SceneKind;
  label: string;
  meta: string;
  health: SceneHealth;
  listeners: number;
  /** Ingest and station nodes: how busy they are, 0–1. Sets the height of their tower. */
  load?: number;
  /** Shown faintly: filtered out, or not part of the customer's own setup. */
  dim: boolean;
  /** Customer's own node: highlighted edge. */
  own?: boolean;
  /** FM/MPX node: the station node it stands beside, in the studio. */
  home?: string;
  /** What the monitoring node heard here: a light on the tower (phase 20). */
  check?: 'ok' | 'failed' | null;
}

export interface SceneLink {
  from: string;
  to: string;
  /** check: a monitoring node listening to the streams of a server. */
  kind: 'control' | 'stream' | 'check';
  state: 'ok' | 'degraded' | 'down';
  /** Shown halfway, e.g. "12 ms". */
  label: string | null;
  dim: boolean;
  /** Line thickness, from bitrate and number of streams. */
  width?: number;
  /** The backup path: dashed and quiet until it takes over. */
  standby?: boolean;
}

export interface SceneData {
  nodes: SceneNode[];
  links: SceneLink[];
  /** Titles of the four lanes on the floor. */
  lanes?: Record<Lane, string> & { monitor?: string };
}

export interface ScenePalette {
  koraal: string;
  lucht: string;
  ink: string;
  muted: string;
  line: string;
  tile: string;
  coreTile: string;
  online: string;
  warning: string;
  offline: string;
  /** The monitoring node, and its check lines (a darker green on a light floor). */
  monitor: string;
  monitorLine: string;
  dark: boolean;
}

export type Lane = 'studios' | 'ingest' | 'relays' | 'listeners';
const LANES: Lane[] = ['studios', 'ingest', 'relays', 'listeners'];
/** Where each lane runs across the floor. */
const LANE_X: Record<Lane, number> = { studios: -16, ingest: -6, relays: 4, listeners: 14 };
const LANE_W = 7.4;
const GAP = 5.6;
const FOOT = 1.9;
/** Height the orchestrator's ring hovers at. */
const RING_Y = 9;
/** How far in front of the lanes the monitoring nodes stand, opposite the orchestrator. */
const MONITOR_GAP = 5.5;
/** Height the check lines arc to between a monitoring node and the server it listens to. */
const CHECK_ARC = 3.2;

const laneOf = (k: SceneKind): Lane | null =>
  k === 'studio' || k === 'station' ? 'studios' : k === 'source' ? 'ingest' : k === 'relay' || k === 'node' ? 'relays' : k === 'fm' || k === 'country' ? 'listeners' : null;

/** Lucide-style icons (24×24 strokes) drawn on the top of each tower. */
const ICONS: Record<SceneKind, string> = {
  main: '<circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4M5 5l3 3M16 16l3 3M5 19l3-3M16 8l3-3"/>',
  relay: '<circle cx="12" cy="12" r="2"/><path d="M8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7M5.6 5.6a9 9 0 0 0 0 12.8M18.4 5.6a9 9 0 0 1 0 12.8"/>',
  source: '<rect x="4" y="4" width="16" height="7" rx="2"/><rect x="4" y="13" width="16" height="7" rx="2"/><path d="M8 7.5h.01M8 16.5h.01"/>',
  node: '<rect x="4" y="4" width="16" height="7" rx="2"/><rect x="4" y="13" width="16" height="7" rx="2"/><path d="M8 7.5h.01M8 16.5h.01"/>',
  station: '<circle cx="12" cy="11" r="2"/><path d="M8.5 7a6 6 0 0 0 0 8M15.5 7a6 6 0 0 1 0 8M9 21l3-8 3 8"/>',
  fm: '<path d="M4.9 16.1C1 12.2 1 5.8 4.9 1.9M7.8 4.7a6.14 6.14 0 0 0-.8 7.5M16.2 4.8c2 2 2.26 5.11.8 7.47M19.1 1.9a9.96 9.96 0 0 1 0 14.1"/><circle cx="12" cy="9" r="2"/><path d="M9.5 18h5M8 22l4-11 4 11"/>',
  studio: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v4"/>',
  country: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  monitor: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
};

interface Placed {
  node: SceneNode;
  pos: THREE.Vector3;
  /** Footprint and height of the tower. */
  w: number;
  h: number;
  /** The station node whose studio group this tower stands in. */
  group?: string;
}

/**
 * The skyline: the layers view laid on a floor. Four lanes run left to right (studios, ingest, relays, listeners) and
 * every server is a tower in its lane; its height shows listeners (relays, FM, countries) or load (ingests). The
 * orchestrator hovers above the middle as a ring: it carries no audio. Monitoring nodes stand in front of the lanes,
 * opposite it, on a strip of their own.
 */
export function layout(data: SceneData): Map<string, Placed> {
  const out = new Map<string, Placed>();
  const reach = Math.max(1, ...data.nodes.filter((n) => n.kind === 'relay' || n.kind === 'fm' || n.kind === 'country').map((n) => n.listeners));
  const height = (n: SceneNode) =>
    n.kind === 'studio'
      ? 0.18
      : n.kind === 'source' || n.kind === 'station'
        ? 0.5 + 3.2 * Math.min(1, Math.max(0, n.load ?? 0))
        : n.kind === 'node' || n.kind === 'monitor'
          ? 0.4
          : 0.5 + 5.5 * Math.sqrt(Math.max(0, n.listeners) / reach);
  const put = (n: SceneNode, x: number, z: number) => out.set(n.id, { node: n, pos: new THREE.Vector3(x, 0, z), w: n.kind === 'studio' ? 1.6 : FOOT, h: height(n) });
  const column = (list: SceneNode[], lane: Lane) => list.forEach((n, i) => put(n, LANE_X[lane], (i - (list.length - 1) / 2) * GAP));
  column(data.nodes.filter((n) => laneOf(n.kind) === 'ingest'), 'ingest');
  column(data.nodes.filter((n) => laneOf(n.kind) === 'relays'), 'relays');
  column(data.nodes.filter((n) => laneOf(n.kind) === 'listeners' && !n.home), 'listeners');
  // The studios lane, front to back: each station node with its FM/MPX nodes and its live studios right beside it
  // (one group), then the other live studios.
  const target = (s: SceneNode) => data.links.find((l) => l.from === s.id)?.to;
  const studios = data.nodes.filter((n) => n.kind === 'studio');
  const rows: { main: SceneNode; side: SceneNode[] }[] = data.nodes
    .filter((n) => n.kind === 'station')
    .map((n) => ({ main: n, side: [...data.nodes.filter((x) => x.home === n.id), ...studios.filter((s) => target(s) === n.id)] }));
  const placed = new Set(rows.flatMap((r) => r.side));
  for (const s of studios) if (!placed.has(s)) rows.push({ main: s, side: [] });
  // A group stands close together along the lane (labels sit side by side on screen, so not across it).
  const items = rows.flatMap((r) => [r.main, ...r.side].map((n, j) => ({ n, group: r.side.length ? r.main.id : undefined, first: j === 0 })));
  const gaps = items.map((x, i): number => (i === 0 ? 0 : x.first ? 4.6 : 3));
  const total = gaps.reduce((a, b) => a + b, 0);
  let z = -total / 2;
  items.forEach((x, i) => {
    z += gaps[i]!;
    put(x.n, LANE_X.studios, z);
    out.get(x.n.id)!.group = x.group;
  });
  const monitors = data.nodes.filter((n) => n.kind === 'monitor');
  if (monitors.length) {
    const front = Math.max(0, ...[...out.values()].map((x) => x.pos.z)) + MONITOR_GAP;
    const mid = (LANE_X.ingest + LANE_X.relays) / 2;
    monitors.forEach((n, i) => put(n, mid + (i - (monitors.length - 1) / 2) * GAP, front));
  }
  const main = data.nodes.find((n) => n.kind === 'main');
  if (main) out.set(main.id, { node: main, pos: new THREE.Vector3((LANE_X.ingest + LANE_X.relays) / 2, RING_Y, Math.min(0, ...[...out.values()].map((x) => x.pos.z)) - 3), w: 3.2, h: 0 });
  return out;
}

function svgIcon(kind: SceneKind, color: string) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${ICONS[kind]}</svg>`;
}

function radialTexture(inner: string, alpha: number) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  const col = new THREE.Color(inner);
  const rgba = (a: number) => `rgba(${Math.round(col.r * 255)},${Math.round(col.g * 255)},${Math.round(col.b * 255)},${a})`;
  grad.addColorStop(0, rgba(alpha));
  grad.addColorStop(1, rgba(0));
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);

interface Flow {
  curve: THREE.Curve<THREE.Vector3>;
  dots: THREE.Mesh[];
  speed: number;
  /** Control links ping there and back. */
  pingPong: boolean;
}

interface Pulse {
  mesh: THREE.Mesh;
  phase: number;
}

/**
 * The live topology as a WebGL skyline: towers per server on four lanes, light trails with moving dots over the floor
 * for audio, a hovering ring for the orchestrator with faint control lines, and HTML labels that follow the camera.
 * Drag to rotate, scroll to zoom.
 */
export class TopologyScene {
  private renderer: THREE.WebGLRenderer;
  private labels: CSS2DRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private content = new THREE.Group();
  private flows: Flow[] = [];
  private pulses: Pulse[] = [];
  private ring: THREE.Object3D | null = null;
  private pickables: THREE.Mesh[] = [];
  private labelEls = new Map<string, HTMLElement>();
  private pillEls = new Map<string, HTMLElement>();
  private textures = new Map<string, THREE.Texture>();
  private placed = new Map<string, Placed>();
  private data: SceneData = { nodes: [], links: [] };
  private structure = '';
  private selected: string | null = null;
  private frame = 0;
  private clock = new THREE.Clock();
  private ro: ResizeObserver;
  private down: { x: number; y: number } | null = null;
  private raycaster = new THREE.Raycaster();
  private reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  private fitted = false;
  /** Every control line, or only those of the selected block. */
  private control = true;
  /** Every check line of the monitoring nodes, or only those of the selected block. */
  private checks = true;

  constructor(
    private readonly host: HTMLElement,
    private palette: ScenePalette,
    private readonly onSelect: (id: string | null) => void,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.domElement.style.display = 'block';
    host.appendChild(this.renderer.domElement);
    this.labels = new CSS2DRenderer();
    Object.assign(this.labels.domElement.style, { position: 'absolute', inset: '0', pointerEvents: 'none' });
    host.appendChild(this.labels.domElement);

    this.camera = new THREE.PerspectiveCamera(34, 1, 0.5, 400);
    this.camera.position.set(-6, 26, 34);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = 1.32;
    this.controls.minDistance = 10;
    this.controls.maxDistance = 140;
    this.controls.target.set(0, 0, 0);

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x445066, 1.5));
    const sun = new THREE.DirectionalLight(0xffffff, 1.7);
    sun.position.set(-10, 22, 14);
    this.scene.add(sun);
    this.scene.add(this.content);

    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', this.onDown);
    el.addEventListener('pointerup', this.onUp);
    el.addEventListener('pointermove', this.onMove);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.resize();
    this.loop();
  }

  dispose() {
    cancelAnimationFrame(this.frame);
    this.ro.disconnect();
    const el = this.renderer.domElement;
    el.removeEventListener('pointerdown', this.onDown);
    el.removeEventListener('pointerup', this.onUp);
    el.removeEventListener('pointermove', this.onMove);
    this.clear();
    for (const t of this.textures.values()) t.dispose();
    this.controls.dispose();
    this.renderer.dispose();
    el.remove();
    this.labels.domElement.remove();
  }

  setPalette(p: ScenePalette) {
    this.palette = p;
    for (const t of this.textures.values()) t.dispose();
    this.textures.clear();
    this.structure = '';
    this.setData(this.data);
  }

  setSelected(id: string | null) {
    if (id === this.selected) return;
    this.selected = id;
    this.structure = '';
    this.setData(this.data);
  }

  /** Draw the control line to every node, not only to the selected one. */
  setControl(on: boolean) {
    if (on === this.control) return;
    this.control = on;
    this.structure = '';
    this.setData(this.data);
  }

  /** Draw the check line of the monitoring nodes to every server, not only to the selected one. */
  setChecks(on: boolean) {
    if (on === this.checks) return;
    this.checks = on;
    this.structure = '';
    this.setData(this.data);
  }

  /** Server labels on or off; the label of the selected block always stays. */
  setLabels(on: boolean) {
    this.labels.domElement.classList.toggle('topo-labels-off', !on);
  }

  setData(data: SceneData) {
    this.data = data;
    const bucket = (n: number) => (n <= 0 ? 0 : Math.ceil(Math.log2(1 + n) * 2));
    const key = JSON.stringify([
      data.nodes.map((n) => [n.id, n.kind, n.health, n.dim, n.own, n.check, bucket(n.listeners), Math.round((n.load ?? 0) * 10)]),
      data.links.map((l) => [l.from, l.to, l.kind, l.state, l.dim, l.standby, Math.round((l.width ?? 0) * 2)]),
      data.lanes,
      this.selected,
    ]);
    if (key === this.structure) {
      // Same shape: only the words change.
      for (const n of data.nodes) {
        const el = this.labelEls.get(n.id);
        if (el) el.innerHTML = this.labelHtml(n);
      }
      for (const l of data.links) {
        const el = this.pillEls.get(`${l.from}>${l.to}>${l.kind}`);
        if (el && l.label) el.textContent = l.label;
      }
      return;
    }
    this.structure = key;
    this.build();
  }

  zoom(factor: number) {
    const offset = this.camera.position.clone().sub(this.controls.target);
    const len = THREE.MathUtils.clamp(offset.length() * factor, this.controls.minDistance, this.controls.maxDistance);
    this.camera.position.copy(this.controls.target).add(offset.setLength(len));
  }

  reset() {
    this.fitted = false;
    this.fit();
  }

  // Building

  private clear() {
    // Labels are HTML on top of the canvas: take them out by hand, or the old ones stay behind where they last stood
    // (three only removes the element of a label that is removed itself, not one inside a removed group).
    this.content.traverse((o) => {
      if (o instanceof CSS2DObject) o.element.remove();
    });
    this.content.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else mat?.dispose();
    });
    this.content.clear();
    this.flows = [];
    this.pulses = [];
    this.ring = null;
    this.pickables = [];
    this.labelEls.clear();
    this.pillEls.clear();
  }

  private texture(key: string, make: () => THREE.Texture) {
    let t = this.textures.get(key);
    if (!t) {
      t = make();
      this.textures.set(key, t);
    }
    return t;
  }

  /** The top of a tower: filled with its health colour, the icon on it and an edge when it is selected or yours. */
  private topTexture(kind: SceneKind, fill: string, color: string, edge: string | null, edgeWidth: number) {
    return this.texture(`top:${kind}:${fill}:${color}:${edge}:${edgeWidth}`, () => {
      const c = document.createElement('canvas');
      c.width = c.height = 256;
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 4;
      const g = c.getContext('2d')!;
      g.fillStyle = fill;
      g.beginPath();
      g.roundRect(0, 0, 256, 256, 26);
      g.fill();
      const img = new Image();
      img.onload = () => {
        g.globalAlpha = 0.55;
        g.drawImage(img, 78, 78, 100, 100);
        g.globalAlpha = 1;
        if (edge) {
          g.strokeStyle = edge;
          g.lineWidth = edgeWidth;
          g.beginPath();
          g.roundRect(edgeWidth / 2 + 2, edgeWidth / 2 + 2, 252 - edgeWidth, 252 - edgeWidth, 26);
          g.stroke();
        }
        tex.needsUpdate = true;
      };
      img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgIcon(kind, color))}`;
      return tex;
    });
  }

  private build() {
    this.clear();
    const p = this.palette;
    this.placed = layout(this.data);
    const healthColor = { online: p.online, degraded: p.warning, offline: p.offline, unpaired: p.muted };
    const towers = [...this.placed.values()].filter((x) => x.node.kind !== 'main' && x.node.kind !== 'monitor');
    const depth = Math.max(14, ...towers.map((x) => Math.abs(x.pos.z) * 2 + GAP * 1.6));

    // Floor: a faint grid, with a plate and a title per lane.
    const span = Math.ceil(Math.max(52, depth + 16) / 2) * 2;
    const grid = new THREE.GridHelper(span, span / 2, p.line, p.line);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = p.dark ? 0.4 : 0.65;
    grid.position.y = -0.02;
    this.content.add(grid);
    for (const lane of LANES) {
      const plate = new THREE.Mesh(new THREE.PlaneGeometry(LANE_W, depth), new THREE.MeshBasicMaterial({ color: p.lucht, transparent: true, opacity: p.dark ? 0.06 : 0.1, depthWrite: false }));
      plate.rotation.x = -Math.PI / 2;
      plate.position.set(LANE_X[lane], 0, 0);
      this.content.add(plate);
      if (this.data.lanes) {
        const title = document.createElement('div');
        title.className = 'topo-lane-title';
        title.textContent = this.data.lanes[lane];
        const obj = new CSS2DObject(title);
        // At the far end of each lane, clear of the legend and the zoom buttons.
        obj.position.set(LANE_X[lane], 0, -depth / 2 - 0.8);
        this.content.add(obj);
      }
    }
    // A studio group: a station node with its FM/MPX nodes and live studios, on a plate of its own.
    const groups = new Map<string, Placed[]>();
    for (const x of this.placed.values()) if (x.group) groups.set(x.group, [...(groups.get(x.group) ?? []), x]);
    for (const list of groups.values()) {
      const zs = list.map((x) => x.pos.z);
      const len = Math.max(...zs) - Math.min(...zs) + 2.8;
      const plate = new THREE.Mesh(new RoundedBoxGeometry(LANE_W - 1.6, 0.04, len, 2, 0.02), new THREE.MeshBasicMaterial({ color: p.lucht, transparent: true, opacity: p.dark ? 0.12 : 0.2, depthWrite: false }));
      plate.position.set(LANE_X.studios, 0.02, (Math.max(...zs) + Math.min(...zs)) / 2);
      this.content.add(plate);
    }
    // The monitoring strip, in front of the lanes.
    const monitors = [...this.placed.values()].filter((x) => x.node.kind === 'monitor');
    if (monitors.length) {
      const xs = monitors.map((x) => x.pos.x);
      const strip = new THREE.Mesh(
        new THREE.PlaneGeometry(Math.max(...xs) - Math.min(...xs) + LANE_W, 4.2),
        new THREE.MeshBasicMaterial({ color: p.monitor, transparent: true, opacity: p.dark ? 0.07 : 0.12, depthWrite: false }),
      );
      strip.rotation.x = -Math.PI / 2;
      strip.position.set((Math.max(...xs) + Math.min(...xs)) / 2, 0.005, monitors[0]!.pos.z);
      this.content.add(strip);
      if (this.data.lanes?.monitor) {
        const title = document.createElement('div');
        title.className = 'topo-lane-title';
        title.textContent = this.data.lanes.monitor;
        const obj = new CSS2DObject(title);
        // On the side of the strip that faces the lanes, clear of the legend.
        obj.position.set(Math.min(...xs) - LANE_W / 2 + 0.4, 0, monitors[0]!.pos.z - 2.1);
        obj.center.set(0, 1);
        this.content.add(obj);
      }
    }
    const shadowTex = this.texture('shadow', () => radialTexture('#000000', p.dark ? 0.5 : 0.22));

    for (const placed of this.placed.values()) {
      const { node, pos, w, h } = placed;
      if (node.kind === 'main') {
        this.addRing(placed);
        continue;
      }
      const g = new THREE.Group();
      g.position.copy(pos);
      const faded = node.dim || node.health === 'offline' || node.health === 'unpaired';
      const opacity = node.dim ? 0.25 : faded ? 0.6 : 1;

      const shadow = new THREE.Mesh(new THREE.PlaneGeometry(w * 2.2, w * 2.2), new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false, opacity }));
      shadow.rotation.x = -Math.PI / 2;
      shadow.position.y = 0.005;
      g.add(shadow);

      const box = new THREE.Mesh(
        new RoundedBoxGeometry(w, h, w, 3, Math.min(0.12, h / 2.2)),
        new THREE.MeshStandardMaterial({
          color: node.kind === 'studio' ? p.lucht : node.kind === 'monitor' ? p.monitor : p.dark ? p.coreTile : p.tile,
          roughness: 0.6,
          metalness: 0.08,
          transparent: opacity < 1,
          opacity,
          emissive: node.id === this.selected ? p.koraal : '#000000',
          emissiveIntensity: node.id === this.selected ? 0.12 : 0,
        }),
      );
      box.position.y = h / 2;
      box.userData.id = node.id;
      g.add(box);
      if (!node.dim) this.pickables.push(box);

      // The top shows health; countries are listeners, in the brand colour; a monitoring node that works is green.
      const fill = node.kind === 'studio' ? p.lucht : node.kind === 'country' ? p.koraal : node.kind === 'monitor' && node.health === 'online' ? p.monitor : healthColor[node.health];
      const edge = node.id === this.selected || node.own ? p.ink : null;
      const top = new THREE.Mesh(
        new THREE.PlaneGeometry(w - 0.04, w - 0.04),
        new THREE.MeshBasicMaterial({ map: this.topTexture(node.kind, fill, '#0b1530', edge, node.id === this.selected ? 12 : 6), transparent: true, opacity, depthWrite: false }),
      );
      top.rotation.x = -Math.PI / 2;
      top.position.y = h + 0.012;
      g.add(top);

      if (node.id === this.selected && !node.dim) {
        for (const phase of [0, 0.5]) {
          const ring = new THREE.Mesh(new THREE.RingGeometry(w * 0.78, w * 0.78 + 0.07, 72), new THREE.MeshBasicMaterial({ color: p.koraal, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false }));
          ring.rotation.x = -Math.PI / 2;
          ring.position.y = 0.02;
          g.add(ring);
          this.pulses.push({ mesh: ring, phase });
        }
      }

      // A server a monitoring node checks: a light on its corner, green while every check plays, red when one fails.
      if (node.check) {
        const color = node.check === 'ok' ? p.monitor : p.offline;
        const light = new THREE.Mesh(new THREE.SphereGeometry(0.2, 16, 12), new THREE.MeshBasicMaterial({ color, transparent: opacity < 1, opacity }));
        light.position.set(w / 2, h + 0.22, w / 2);
        const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.texture(`halo:${color}`, () => radialTexture(color, 0.9)), transparent: true, depthWrite: false, opacity: (p.dark ? 0.9 : 0.6) * opacity }));
        halo.scale.setScalar(1.1);
        light.add(halo);
        g.add(light);
      }

      g.add(this.label(node, new THREE.Vector3(0, h + 0.35, 0)));
      this.content.add(g);
    }

    for (const l of this.data.links) this.addLink(l);
    if (!this.fitted) this.fit();
  }

  private label(node: SceneNode, at: THREE.Vector3) {
    const el = document.createElement('div');
    // With nothing selected the side panel shows the orchestrator, so its label counts as the selected one.
    el.className = node.id === this.selected || (!this.selected && node.kind === 'main') ? 'topo-label selected' : 'topo-label';
    el.style.opacity = node.dim ? '0.45' : '1';
    el.innerHTML = this.labelHtml(node);
    el.dataset.id = node.id;
    const obj = new CSS2DObject(el);
    obj.center.set(0.5, 1);
    obj.position.copy(at);
    this.labelEls.set(node.id, el);
    return obj;
  }

  private labelHtml(n: SceneNode) {
    return `<b>${esc(n.label)}</b><small>${n.kind === 'country' || n.kind === 'studio' ? '' : `<i class="topo-dot ${n.health}"></i>`}${esc(n.meta)}</small>`;
  }

  /** The orchestrator: a ring hovering over the floor, with a glow below it. */
  private addRing({ node, pos, w }: Placed) {
    const p = this.palette;
    const g = new THREE.Group();
    g.position.copy(pos);
    const torus = new THREE.Mesh(
      new THREE.TorusGeometry(w / 2, 0.28, 18, 64),
      new THREE.MeshStandardMaterial({ color: p.koraal, roughness: 0.4, metalness: 0.15, emissive: p.koraal, emissiveIntensity: node.id === this.selected ? 0.45 : 0.2, transparent: node.dim, opacity: node.dim ? 0.3 : 1 }),
    );
    torus.rotation.x = -Math.PI / 2;
    torus.userData.id = node.id;
    g.add(torus);
    // A clear disc inside the ring, so a click in the middle selects it too.
    const disc = new THREE.Mesh(new THREE.CircleGeometry(w / 2, 32), new THREE.MeshBasicMaterial({ visible: false }));
    disc.rotation.x = -Math.PI / 2;
    disc.userData.id = node.id;
    g.add(disc);
    this.pickables.push(torus, disc);
    g.add(this.label(node, new THREE.Vector3(0, 1.1, 0)));
    this.content.add(g);
    this.ring = torus;
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(10, 10), new THREE.MeshBasicMaterial({ map: this.texture(`glow:${p.koraal}`, () => radialTexture(p.koraal, p.dark ? 0.16 : 0.09)), transparent: true, depthWrite: false }));
    glow.rotation.x = -Math.PI / 2;
    glow.position.set(pos.x, 0.01, pos.z);
    this.content.add(glow);
  }

  private addLink(l: SceneLink) {
    const a = this.placed.get(l.from);
    const b = this.placed.get(l.to);
    if (!a || !b) return;
    const p = this.palette;
    if (l.kind === 'check') return this.addCheck(l, a, b);
    const color = l.state === 'degraded' ? p.warning : l.state === 'down' ? p.offline : l.kind === 'stream' ? (l.standby ? p.lucht : p.koraal) : p.lucht;
    if (l.kind === 'control') {
      // From the ring straight down to the top of the tower: faint and dashed, so it never reads as audio.
      const ringSide = a.node.kind === 'main' ? a : b;
      const other = ringSide === a ? b : a;
      const start = ringSide.pos.clone().setY(ringSide.pos.y - 0.25);
      const end = other.pos.clone().setY(other.h + 0.05);
      const curve = new THREE.LineCurve3(start, end);
      const focus = this.selected === l.from || this.selected === l.to;
      if (!this.control && !focus) return;
      const opacity = l.dim ? 0.06 : l.state === 'down' ? 0.2 : focus ? 0.75 : 0.5;
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([start, end]), new THREE.LineDashedMaterial({ color: l.state === 'down' ? p.muted : color, dashSize: 0.35, gapSize: 0.25, transparent: true, opacity, depthWrite: false }));
      line.computeLineDistances();
      this.content.add(line);
      if (focus && l.state !== 'down' && !l.dim) this.addDots(curve, 1, 0.09, color, 0.3, true);
      if (l.label && focus && !l.dim) this.addPill(l, curve.getPointAt(0.85));
      return;
    }
    // Audio: a light trail over the floor, from the facing side of one tower to the facing side of the other, around
    // every tower in between.
    const k = b.pos.x < a.pos.x ? -1 : 1;
    const start = a.pos.clone().setY(0.12).add(new THREE.Vector3((k * a.w) / 2, 0, 0));
    const end = b.pos.clone().setY(0.12).sub(new THREE.Vector3((k * b.w) / 2, 0, 0));
    const curve = this.route(start, end, [a, b]);
    const radius = 0.02 + (l.width ?? 2.5) * 0.012;
    const opacity = l.dim ? 0.1 : l.state === 'down' ? 0.25 : l.standby ? 0.35 : 0.8;
    if (l.standby) {
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(curve.getPoints(40)), new THREE.LineDashedMaterial({ color, dashSize: 0.4, gapSize: 0.3, transparent: true, opacity, depthWrite: false }));
      line.computeLineDistances();
      this.content.add(line);
    } else {
      const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 48, radius, 6, false), new THREE.MeshBasicMaterial({ color: l.state === 'down' ? p.muted : color, transparent: true, opacity, depthWrite: false }));
      this.content.add(tube);
      // A soft glow along the floor under the trail.
      const glow = new THREE.Mesh(new THREE.TubeGeometry(curve, 48, radius * 3.2, 6, false), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: l.dim ? 0.03 : p.dark ? 0.12 : 0.08, depthWrite: false, blending: p.dark ? THREE.AdditiveBlending : THREE.NormalBlending }));
      this.content.add(glow);
      if (l.state !== 'down' && !l.dim) this.addDots(curve, 4, 0.11, color, 0.32, false);
    }
    if (l.label && !l.dim) this.addPill(l, curve.getPointAt(0.5).setY(0.6));
  }

  /**
   * A check line: an arc from the top of the server to the monitoring node, dashed in its green (red when a check there
   * fails), with dots that carry the sound to the monitor.
   */
  private addCheck(l: SceneLink, monitor: Placed, server: Placed) {
    const p = this.palette;
    const focus = this.selected === l.from || this.selected === l.to;
    if (!this.checks && !focus) return;
    const color = l.state === 'degraded' ? p.offline : l.state === 'down' ? p.muted : p.monitorLine;
    const start = server.pos.clone().setY(server.h + 0.1);
    const end = monitor.pos.clone().setY(monitor.h + 0.1);
    const mid = start.clone().lerp(end, 0.5).setY(Math.max(start.y, end.y) + CHECK_ARC);
    const curve = new THREE.QuadraticBezierCurve3(start, mid, end);
    const opacity = l.dim ? 0.08 : l.state === 'down' ? 0.25 : focus ? 0.95 : 0.7;
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(curve.getPoints(48)), new THREE.LineDashedMaterial({ color, dashSize: 0.3, gapSize: 0.22, transparent: true, opacity, depthWrite: false }));
    line.computeLineDistances();
    this.content.add(line);
    // A soft glow along the arc, so a thin line still reads from far away.
    const glow = new THREE.Mesh(new THREE.TubeGeometry(curve, 48, 0.05, 6, false), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: l.dim ? 0.03 : p.dark ? 0.22 : 0.16, depthWrite: false, blending: p.dark ? THREE.AdditiveBlending : THREE.NormalBlending }));
    this.content.add(glow);
    if (l.state !== 'down' && !l.dim) this.addDots(curve, 2, 0.09, color, 0.22, false);
  }

  /**
   * The path of a trail over the floor. A straight arc when nothing stands in the way; otherwise it passes each tower in
   * between through the gap beside it (towers in a lane stand GAP apart, so halfway is free).
   */
  private route(start: THREE.Vector3, end: THREE.Vector3, skip: Placed[]): THREE.Curve<THREE.Vector3> {
    const k = end.x < start.x ? -1 : 1;
    const towers = [...this.placed.values()]
      .filter((x) => x.node.kind !== 'main' && !skip.includes(x) && (x.pos.x - start.x) * k > 0 && (end.x - x.pos.x) * k > 0)
      .sort((x, y) => (x.pos.x - y.pos.x) * k);
    const points = [start];
    for (const o of towers) {
      const from = points[points.length - 1]!;
      const z = from.z + ((o.pos.x - from.x) / (end.x - from.x)) * (end.z - from.z);
      if (Math.abs(z - o.pos.z) >= o.w / 2 + 0.6) continue;
      const side = Math.sign(z - o.pos.z) || Math.sign(end.z - o.pos.z) || 1;
      const gz = o.pos.z + side * Math.max(GAP / 2, o.w / 2 + 1);
      const reach = o.w / 2 + 0.5;
      points.push(new THREE.Vector3(o.pos.x - k * reach, 0.3, gz), new THREE.Vector3(o.pos.x + k * reach, 0.3, gz));
    }
    if (points.length === 1) {
      const mid = start.clone().lerp(end, 0.5).setY(0.12 + 0.25 + start.distanceTo(end) * 0.02);
      return new THREE.QuadraticBezierCurve3(start, mid, end);
    }
    points.push(end);
    return new THREE.CatmullRomCurve3(points, false, 'centripetal');
  }

  private addDots(curve: THREE.Curve<THREE.Vector3>, n: number, size: number, color: string, speed: number, pingPong: boolean) {
    const p = this.palette;
    const dots: THREE.Mesh[] = [];
    for (let i = 0; i < n; i++) {
      const dot = new THREE.Mesh(new THREE.SphereGeometry(size, 12, 10), new THREE.MeshBasicMaterial({ color: '#ffffff' }));
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.texture(`halo:${color}`, () => radialTexture(color, 0.9)), transparent: true, depthWrite: false, blending: p.dark ? THREE.AdditiveBlending : THREE.NormalBlending, opacity: p.dark ? 0.9 : 0.6 }));
      halo.scale.setScalar(0.8);
      dot.add(halo);
      this.content.add(dot);
      dots.push(dot);
    }
    this.flows.push({ curve, dots, speed: speed * (this.reduced ? 0.3 : 1), pingPong });
  }

  private addPill(l: SceneLink, at: THREE.Vector3) {
    const pill = document.createElement('span');
    pill.className = `topo-pill ${l.state}`;
    pill.textContent = l.label;
    const obj = new CSS2DObject(pill);
    obj.position.copy(at);
    this.content.add(obj);
    this.pillEls.set(`${l.from}>${l.to}>${l.kind}`, pill);
  }

  // Camera

  private fit() {
    const pts = [...this.placed.values()].map((x) => x.pos.clone().setY(Math.min(x.pos.y, 4)));
    if (!pts.length) return;
    pts.push(new THREE.Vector3(LANE_X.studios - LANE_W / 2, 0, 0), new THREE.Vector3(LANE_X.listeners + LANE_W / 2, 0, 0));
    const box = new THREE.Box3().setFromPoints(pts).expandByScalar(1);
    const center = box.getCenter(new THREE.Vector3());
    const radius = box.getSize(new THREE.Vector3()).length() / 2;
    const aspect = Math.max(0.6, this.camera.aspect);
    const dist = (radius / Math.tan((this.camera.fov * Math.PI) / 360)) * (aspect < 1.2 ? 1.2 / aspect : 0.8);
    this.controls.target.copy(center).setY(0.5);
    const dir = new THREE.Vector3(-0.1, 0.82, 0.56).normalize();
    this.camera.position.copy(center).add(dir.multiplyScalar(THREE.MathUtils.clamp(dist, 18, 130)));
    this.controls.update();
    this.fitted = true;
  }

  private resize() {
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.labels.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // Interaction

  private pick(e: PointerEvent) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const v = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(v, this.camera);
    return (this.raycaster.intersectObjects(this.pickables, false)[0]?.object.userData.id as string | undefined) ?? null;
  }

  private onDown = (e: PointerEvent) => {
    this.down = { x: e.clientX, y: e.clientY };
  };

  private onUp = (e: PointerEvent) => {
    if (!this.down) return;
    const moved = Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y);
    this.down = null;
    if (moved < 5) this.onSelect(this.pick(e));
  };

  private onMove = (e: PointerEvent) => {
    if (e.buttons) return;
    this.renderer.domElement.style.cursor = this.pick(e) ? 'pointer' : 'grab';
  };

  // Animation

  private loop = () => {
    this.frame = requestAnimationFrame(this.loop);
    const t = this.clock.getElapsedTime();
    for (const f of this.flows) {
      f.dots.forEach((d, i) => {
        let u = (t * f.speed + i / f.dots.length) % 1;
        if (f.pingPong) u = u < 0.5 ? u * 2 : 2 - u * 2;
        d.position.copy(f.curve.getPointAt(u));
      });
    }
    for (const p of this.pulses) {
      const u = this.reduced ? 0.3 : (t / 2.4 + p.phase) % 1;
      p.mesh.scale.setScalar(0.85 + u * 0.9);
      (p.mesh.material as THREE.MeshBasicMaterial).opacity = 0.55 * (1 - u);
    }
    // The ring bobs gently, as if it hovers.
    if (this.ring && !this.reduced) this.ring.position.y = Math.sin(t * 1.1) * 0.12;
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);
  };
}
