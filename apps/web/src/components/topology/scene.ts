import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { CSS2DObject, CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';

export type SceneKind = 'main' | 'relay' | 'source' | 'station' | 'node' | 'studio';
export type SceneHealth = 'online' | 'degraded' | 'offline' | 'unpaired';

export interface SceneNode {
  id: string;
  kind: SceneKind;
  label: string;
  meta: string;
  health: SceneHealth;
  listeners: number;
  /** Shown faintly: filtered out, or not part of the customer's own setup. */
  dim: boolean;
  /** Customer's own node: highlighted edge. */
  own?: boolean;
}

export interface SceneLink {
  from: string;
  to: string;
  kind: 'control' | 'stream';
  state: 'ok' | 'degraded' | 'down';
  /** Shown halfway, e.g. "12 ms". */
  label: string | null;
  dim: boolean;
}

export interface SceneData {
  nodes: SceneNode[];
  links: SceneLink[];
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
  dark: boolean;
}

/** Lucide-style icons (24×24 strokes) drawn on the top of each block. */
const ICONS: Record<SceneKind, string> = {
  main: '<circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4M5 5l3 3M16 16l3 3M5 19l3-3M16 8l3-3"/>',
  relay: '<circle cx="12" cy="12" r="2"/><path d="M8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7M5.6 5.6a9 9 0 0 0 0 12.8M18.4 5.6a9 9 0 0 1 0 12.8"/>',
  source: '<rect x="4" y="4" width="16" height="7" rx="2"/><rect x="4" y="13" width="16" height="7" rx="2"/><path d="M8 7.5h.01M8 16.5h.01"/>',
  node: '<rect x="4" y="4" width="16" height="7" rx="2"/><rect x="4" y="13" width="16" height="7" rx="2"/><path d="M8 7.5h.01M8 16.5h.01"/>',
  station: '<circle cx="12" cy="11" r="2"/><path d="M8.5 7a6 6 0 0 0 0 8M15.5 7a6 6 0 0 1 0 8M9 21l3-8 3 8"/>',
  studio: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v4"/>',
};

const SIZE: Record<SceneKind, { w: number; h: number }> = {
  main: { w: 3, h: 2.2 },
  relay: { w: 2.2, h: 1.1 },
  source: { w: 2.2, h: 1.3 },
  station: { w: 2.4, h: 1.5 },
  node: { w: 2.2, h: 0.9 },
  studio: { w: 1.8, h: 0.5 },
};

interface Placed {
  node: SceneNode;
  pos: THREE.Vector3;
  size: { w: number; h: number };
}

/** Where every block goes: this server in the middle, relays fanned out to the right, sources left, studios further left. */
export function layout(data: SceneData): Map<string, Placed> {
  const out = new Map<string, Placed>();
  const put = (n: SceneNode, x: number, z: number) => out.set(n.id, { node: n, pos: new THREE.Vector3(x, 0, z), size: SIZE[n.kind] });
  const main = data.nodes.find((n) => n.kind === 'main');
  if (main) put(main, 0, 0);
  const fan = (list: SceneNode[], center: number, spread: number, radius: number) => {
    const r = radius + Math.max(0, list.length - 5) * 0.9;
    list.forEach((n, i) => {
      const a = list.length === 1 ? center : center - spread / 2 + (spread * i) / (list.length - 1);
      put(n, Math.cos(a) * r, Math.sin(a) * r);
    });
  };
  const deg = Math.PI / 180;
  fan(data.nodes.filter((n) => n.kind === 'relay'), 0, Math.min(150, 40 + data.nodes.filter((n) => n.kind === 'relay').length * 22) * deg, 10);
  fan(data.nodes.filter((n) => n.kind === 'source'), Math.PI, Math.min(120, 30 + data.nodes.filter((n) => n.kind === 'source').length * 25) * deg, 7.5);
  // Station nodes sit below this server: their streams run from there to the relays.
  fan(data.nodes.filter((n) => n.kind === 'station'), Math.PI / 2, Math.min(100, 30 + data.nodes.filter((n) => n.kind === 'station').length * 25) * deg, 8.5);
  const idle = data.nodes.filter((n) => n.kind === 'node');
  idle.forEach((n, i) => put(n, (i - (idle.length - 1) / 2) * 3.4, 9 + (main ? 0 : 0)));
  // Studios connected to this server sit in a column on the left; studios on a node sit beside that node.
  const perTarget = new Map<string, number>();
  for (const s of data.nodes.filter((n) => n.kind === 'studio')) {
    const link = data.links.find((l) => l.from === s.id);
    const target = link ? out.get(link.to) : undefined;
    const key = target && target.node.kind !== 'main' ? target.node.id : 'main';
    const k = perTarget.get(key) ?? 0;
    perTarget.set(key, k + 1);
    if (key === 'main' || !target) {
      put(s, -13.5, (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 2.6);
    } else {
      // Beside the node, away from this server, so the labels do not overlap.
      put(s, target.pos.x + (target.pos.x >= 0 ? 5.5 : -5.5), target.pos.z - 1 + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 2.6);
    }
  }
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
  curve: THREE.QuadraticBezierCurve3;
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
 * The live topology as a WebGL scene: blocks per server, arcs with moving dots for streams and the control channel,
 * listener clouds around relays and HTML labels that follow the camera. Drag to rotate, scroll to zoom.
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
  private clouds: THREE.Points[] = [];
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
    this.camera.position.set(10, 26, 30);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = 1.32;
    this.controls.minDistance = 10;
    this.controls.maxDistance = 120;
    this.controls.target.set(0, 0, 1);

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x445066, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(-8, 20, 12);
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

  setData(data: SceneData) {
    this.data = data;
    const bucket = (n: number) => (n <= 0 ? 0 : Math.ceil(Math.log2(1 + n)));
    const key = JSON.stringify([
      data.nodes.map((n) => [n.id, n.kind, n.health, n.dim, n.own, bucket(n.listeners)]),
      data.links.map((l) => [l.from, l.to, l.kind, l.state, l.dim]),
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
    this.clouds = [];
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

  private iconTexture(kind: SceneKind, color: string, edge: string | null, edgeWidth: number) {
    return this.texture(`icon:${kind}:${color}:${edge}:${edgeWidth}`, () => {
      const c = document.createElement('canvas');
      c.width = c.height = 256;
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 4;
      const img = new Image();
      img.onload = () => {
        const g = c.getContext('2d')!;
        g.drawImage(img, 68, 68, 120, 120);
        if (edge) {
          g.strokeStyle = edge;
          g.lineWidth = edgeWidth;
          g.beginPath();
          g.roundRect(edgeWidth / 2 + 2, edgeWidth / 2 + 2, 252 - edgeWidth, 252 - edgeWidth, 30);
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

    // Ground: a soft grid and a warm glow under this server.
    const extent = Math.max(30, ...[...this.placed.values()].map((x) => Math.hypot(x.pos.x, x.pos.z) * 2 + 10));
    const grid = new THREE.GridHelper(Math.ceil(extent / 2) * 2, Math.ceil(extent / 2), p.line, p.line);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = p.dark ? 0.55 : 0.8;
    grid.position.y = -0.01;
    this.content.add(grid);
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(26, 26), new THREE.MeshBasicMaterial({ map: this.texture(`glow:${p.koraal}`, () => radialTexture(p.koraal, p.dark ? 0.2 : 0.11)), transparent: true, depthWrite: false }));
    glow.rotation.x = -Math.PI / 2;
    this.content.add(glow);
    const shadowTex = this.texture('shadow', () => radialTexture('#000000', p.dark ? 0.55 : 0.28));

    for (const { node, pos, size } of this.placed.values()) {
      const g = new THREE.Group();
      g.position.copy(pos);
      const faded = node.dim || node.health === 'offline' || node.health === 'unpaired';
      const opacity = node.dim ? 0.28 : faded ? 0.6 : 1;

      const shadow = new THREE.Mesh(new THREE.PlaneGeometry(size.w * 2, size.w * 2), new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false, opacity }));
      shadow.rotation.x = -Math.PI / 2;
      shadow.position.y = 0.005;
      g.add(shadow);

      const tile = node.kind === 'main' ? p.coreTile : p.tile;
      const box = new THREE.Mesh(
        new RoundedBoxGeometry(size.w, size.h, size.w, 4, 0.18),
        new THREE.MeshStandardMaterial({
          color: tile,
          roughness: 0.55,
          metalness: 0.08,
          transparent: opacity < 1,
          opacity,
          emissive: node.health === 'degraded' ? p.warning : node.id === this.selected ? p.koraal : '#000000',
          emissiveIntensity: node.health === 'degraded' ? 0.1 : node.id === this.selected ? 0.12 : 0,
        }),
      );
      box.position.y = size.h / 2;
      box.userData.id = node.id;
      g.add(box);
      if (!node.dim) this.pickables.push(box);

      // The top: icon, with an edge in the brand colour for this server, the customer's own nodes and the selection.
      const edge = node.id === this.selected || node.kind === 'main' || node.own ? p.koraal : null;
      const icon = new THREE.Mesh(
        new THREE.PlaneGeometry(size.w - 0.06, size.w - 0.06),
        new THREE.MeshBasicMaterial({ map: this.iconTexture(node.kind, node.kind === 'main' ? p.koraal : p.ink, edge, node.id === this.selected ? 10 : 5), transparent: true, opacity, depthWrite: false }),
      );
      icon.rotation.x = -Math.PI / 2;
      icon.position.y = size.h + 0.02;
      g.add(icon);

      // Status light on the front corner.
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.13, 16, 12), new THREE.MeshBasicMaterial({ color: healthColor[node.health], transparent: node.dim, opacity: node.dim ? 0.3 : 1 }));
      lamp.position.set(size.w / 2 - 0.3, size.h + 0.12, size.w / 2 - 0.3);
      g.add(lamp);

      if ((node.kind === 'main' || node.id === this.selected) && !node.dim) {
        for (const phase of [0, 0.5]) {
          const ring = new THREE.Mesh(new THREE.RingGeometry(size.w * 0.72, size.w * 0.72 + 0.07, 72), new THREE.MeshBasicMaterial({ color: p.koraal, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false }));
          ring.rotation.x = -Math.PI / 2;
          ring.position.y = 0.02;
          g.add(ring);
          this.pulses.push({ mesh: ring, phase });
        }
      }

      if (node.listeners > 0 && !node.dim && node.health !== 'offline') this.addCloud(g, node, pos);

      const label = document.createElement('div');
      label.className = 'topo-label';
      label.style.opacity = node.dim ? '0.45' : '1';
      label.innerHTML = this.labelHtml(node);
      label.dataset.id = node.id;
      const obj = new CSS2DObject(label);
      obj.center.set(0.5, 0);
      obj.position.set(0, 0, size.w / 2 + 0.55);
      g.add(obj);
      this.labelEls.set(node.id, label);

      this.content.add(g);
    }

    for (const l of this.data.links) this.addLink(l);
    if (!this.fitted) this.fit();
  }

  private labelHtml(n: SceneNode) {
    return `<b>${esc(n.label)}</b><small><i class="topo-dot ${n.health}"></i>${esc(n.meta)}</small>`;
  }

  private addCloud(g: THREE.Group, node: SceneNode, pos: THREE.Vector3) {
    const count = Math.min(90, Math.round(5 * Math.log2(1 + node.listeners)) + 3);
    const out = Math.atan2(pos.z, pos.x || 0.0001);
    const pts = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const a = (node.kind === 'main' ? Math.random() * Math.PI * 2 : out + (Math.random() - 0.5) * 2.4);
      const r = 1.9 + Math.random() * (node.kind === 'main' ? 3 : 2.2);
      pts[i * 3] = Math.cos(a) * r;
      pts[i * 3 + 1] = 0.15 + Math.random() * 0.25;
      pts[i * 3 + 2] = Math.sin(a) * r;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pts, 3));
    const dot = this.texture(`dot:${this.palette.lucht}`, () => radialTexture(this.palette.lucht, 1));
    const cloud = new THREE.Points(geo, new THREE.PointsMaterial({ size: 0.55, map: dot, color: this.palette.lucht, transparent: true, depthWrite: false, blending: this.palette.dark ? THREE.AdditiveBlending : THREE.NormalBlending }));
    g.add(cloud);
    this.clouds.push(cloud);
  }

  private addLink(l: SceneLink) {
    const a = this.placed.get(l.from);
    const b = this.placed.get(l.to);
    if (!a || !b) return;
    const p = this.palette;
    const start = a.pos.clone().setY(a.size.h * 0.6);
    const end = b.pos.clone().setY(b.size.h * 0.6);
    // Control and stream between the same two blocks bend to different sides.
    const lift = 1.2 + start.distanceTo(end) * 0.12;
    const mid = start.clone().lerp(end, 0.5).setY(Math.max(start.y, end.y) + lift);
    const side = new THREE.Vector3(end.z - start.z, 0, start.x - end.x).normalize().multiplyScalar(l.kind === 'control' ? 0.6 : -0.6);
    mid.add(side);
    const curve = new THREE.QuadraticBezierCurve3(start, mid, end);
    const color = l.state === 'degraded' ? p.warning : l.state === 'down' ? p.offline : l.kind === 'stream' ? p.koraal : p.lucht;
    const tube = new THREE.Mesh(
      new THREE.TubeGeometry(curve, 48, l.kind === 'stream' ? 0.05 : 0.03, 6, false),
      new THREE.MeshBasicMaterial({ color: l.state === 'down' ? p.muted : color, transparent: true, opacity: l.dim ? 0.12 : l.state === 'down' ? 0.25 : l.kind === 'stream' ? 0.4 : 0.32, depthWrite: false }),
    );
    this.content.add(tube);
    if (l.state !== 'down' && !l.dim) {
      const n = l.kind === 'stream' ? 4 : 1;
      const dots: THREE.Mesh[] = [];
      for (let i = 0; i < n; i++) {
        const dot = new THREE.Mesh(new THREE.SphereGeometry(l.kind === 'stream' ? 0.13 : 0.1, 12, 10), new THREE.MeshBasicMaterial({ color }));
        const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.texture(`halo:${color}`, () => radialTexture(color, 0.9)), transparent: true, depthWrite: false, blending: p.dark ? THREE.AdditiveBlending : THREE.NormalBlending, opacity: p.dark ? 0.9 : 0.6 }));
        halo.scale.setScalar(0.9);
        dot.add(halo);
        this.content.add(dot);
        dots.push(dot);
      }
      this.flows.push({ curve, dots, speed: (l.kind === 'stream' ? 0.35 : 0.25) * (this.reduced ? 0.3 : 1), pingPong: l.kind === 'control' });
    }
    if (l.label && !l.dim) {
      const pill = document.createElement('span');
      pill.className = `topo-pill ${l.state}`;
      pill.textContent = l.label;
      const obj = new CSS2DObject(pill);
      obj.position.copy(curve.getPointAt(0.5));
      this.content.add(obj);
      this.pillEls.set(`${l.from}>${l.to}>${l.kind}`, pill);
    }
  }

  // Camera

  private fit() {
    const pts = [...this.placed.values()].map((x) => x.pos);
    if (!pts.length) return;
    const box = new THREE.Box3().setFromPoints(pts).expandByScalar(4);
    const center = box.getCenter(new THREE.Vector3());
    const radius = box.getSize(new THREE.Vector3()).length() / 2;
    const aspect = Math.max(0.6, this.camera.aspect);
    const dist = (radius / Math.tan((this.camera.fov * Math.PI) / 360)) * (aspect < 1.2 ? 1.35 / aspect : 0.95);
    this.controls.target.copy(center).setY(0);
    const dir = new THREE.Vector3(0.18, 0.78, 0.6).normalize();
    this.camera.position.copy(center).add(dir.multiplyScalar(THREE.MathUtils.clamp(dist, 16, 110)));
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
      const u = this.reduced ? 0.3 : ((t / 2.4 + p.phase) % 1);
      p.mesh.scale.setScalar(0.85 + u * 0.9);
      (p.mesh.material as THREE.MeshBasicMaterial).opacity = 0.55 * (1 - u);
    }
    if (!this.reduced) for (const c of this.clouds) c.rotation.y = Math.sin(t * 0.15) * 0.08;
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);
  };
}
