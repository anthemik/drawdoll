import * as THREE from 'three';
import { Figure, RenderStyle, Side } from './figure';
import { DEFAULT_PARAMS, FigureParams, computeProportions, describeHeight } from './proportions';
import {
  CONTROLS,
  CONTROL_BY_ID,
  ControlDef,
  Dof,
  Limb,
  PIN_KEYS,
  Pose,
  clampReachAxis,
  completePose,
  defaultPose,
  mirrorPose,
  pinKey,
} from './joints';
import { applyPose, getSwivel, lookAt, makePin, setSwivel } from './ik';
import { SwingPad } from './pad';
import { FrameSize, Viewer } from './viewer';
import { Background, ExportOptions, exportSize, fileName, renderPNG } from './export';
import { PRESETS } from './presets';
import { h, section, segmented, slider, toggle } from './ui-kit';

const STORE_KEY = 'drawdoll.v1';

const FRAMES: { id: string; label: string; w: number; h: number }[] = [
  { id: 'ipad13', label: 'iPad 13″ (2048 × 2732)', w: 2048, h: 2732 },
  { id: 'ipad11', label: 'iPad 11″ (1668 × 2388)', w: 1668, h: 2388 },
  { id: 'ipadmini', label: 'iPad mini (1488 × 2266)', w: 1488, h: 2266 },
  { id: 'a4', label: 'A4 @ 300 dpi (2480 × 3508)', w: 2480, h: 3508 },
  { id: 'letter', label: 'Letter @ 300 dpi (2550 × 3300)', w: 2550, h: 3300 },
  { id: 'square', label: 'Square (2048 × 2048)', w: 2048, h: 2048 },
  { id: '4k', label: '4K (2160 × 3840)', w: 2160, h: 3840 },
  { id: 'px256', label: 'Pixel art (256 × 256)', w: 256, h: 256 },
  { id: 'px128', label: 'Pixel art (128 × 128)', w: 128, h: 128 },
  { id: 'custom', label: 'Custom…', w: 0, h: 0 },
];

const VIEWS: { label: string; az: number; el: number }[] = [
  { label: 'Front', az: 0, el: 0 },
  { label: '¾ Front', az: 35, el: 8 },
  { label: 'Side', az: 90, el: 0 },
  { label: '¾ Back', az: 145, el: 8 },
  { label: 'Back', az: 180, el: 0 },
  { label: 'High', az: 30, el: 40 },
  { label: 'Top', az: 0, el: 88 },
  { label: 'Low', az: 25, el: -25 },
];

const AGES: { label: string; age: number }[] = [
  { label: 'Toddler', age: 2.5 },
  { label: 'Child', age: 7 },
  { label: 'Preteen', age: 11 },
  { label: 'Teen', age: 15 },
  { label: 'Adult', age: 25 },
];

interface Settings {
  params: FigureParams;
  pose: Pose;
  focal: number;
  keepFraming: boolean;
  frameId: string;
  frame: FrameSize;
  style: RenderStyle;
  outline: boolean;
  lineWeight: number;
  guides: boolean;
  lightAz: number;
  lightEl: number;
  grid: boolean;
  horizon: boolean;
  balance: boolean;
  autoGround: boolean;
  handles: boolean;
  exp: ExportOptions;
  camera?: { pos: number[]; target: number[] };
  saved: { name: string; pose: Pose }[];
}

function defaults(): Settings {
  return {
    params: { ...DEFAULT_PARAMS },
    pose: defaultPose(),
    focal: 50,
    keepFraming: true,
    frameId: 'ipad13',
    frame: { w: 2048, h: 2732 },
    style: 'shaded',
    outline: true,
    lineWeight: 1.5,
    guides: true,
    lightAz: -35,
    lightEl: 45,
    grid: true,
    horizon: false,
    balance: false,
    autoGround: true,
    handles: true,
    exp: { background: 'transparent', horizon: false, shadow: true, grid: false },
    saved: [],
  };
}

function load(): Settings {
  const base = defaults();
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return base;
    const s = JSON.parse(raw) as Partial<Settings>;
    return {
      ...base,
      ...s,
      params: { ...base.params, ...s.params },
      pose: completePose(s.pose ?? {}),
      exp: { ...base.exp, ...s.exp },
      saved: s.saved ?? [],
    };
  } catch {
    return base;
  }
}

type Snapshot = string;
type Tab = 'pose' | 'figure' | 'camera' | 'look';

/** Draggable points: hands and feet move their limb by IK, hips move the whole body. */
const HANDLES: { id: string; control: string; limb?: Limb; side?: Side }[] = [
  { id: 'hips', control: 'body' },
  { id: 'hand_L', control: 'hand_L', limb: 'arm', side: 'L' },
  { id: 'hand_R', control: 'hand_R', limb: 'arm', side: 'R' },
  { id: 'foot_L', control: 'foot_L', limb: 'leg', side: 'L' },
  { id: 'foot_R', control: 'foot_R', limb: 'leg', side: 'R' },
];
const LIMB_OF: Record<string, [Limb, Side]> = {
  arm_L: ['arm', 'L'], forearm_L: ['arm', 'L'], hand_L: ['arm', 'L'],
  arm_R: ['arm', 'R'], forearm_R: ['arm', 'R'], hand_R: ['arm', 'R'],
  thigh_L: ['leg', 'L'], shin_L: ['leg', 'L'], foot_L: ['leg', 'L'],
  thigh_R: ['leg', 'R'], shin_R: ['leg', 'R'], foot_R: ['leg', 'R'],
};
/** Dofs a pin controls; their sliders are locked while the hand/foot is pinned. */
const PINNED_DOFS: Record<string, string[]> = {
  arm: ['fwd', 'out', 'twist'],
  forearm: ['bend'],
  thigh: ['fwd', 'out', 'twist'],
  shin: ['bend'],
  foot: ['point', 'roll'],
};

interface Drag {
  handle: (typeof HANDLES)[number];
  pointerId: number;
  plane: THREE.Plane;
  offset: THREE.Vector3;
  startX: number;
  startY: number;
  moved: boolean;
  /** Pins that exist only for the duration of the drag. */
  tempPins: string[];
  rootWasFixed: boolean;
}

export class App {
  s: Settings = load();
  figure = new Figure();
  viewer: Viewer;
  selected: string | null = null;
  tab: Tab = 'pose';
  private undo: Snapshot[] = [];
  private redo: Snapshot[] = [];
  private panelBody: HTMLElement;
  private tabButtons = new Map<Tab, HTMLButtonElement>();
  private chip: HTMLElement;
  private undoBtn: HTMLButtonElement;
  private redoBtn: HTMLButtonElement;
  private rebuildQueued = false;
  private saveTimer = 0;
  private lastH = 0;
  private drag: Drag | null = null;

  constructor(root: HTMLElement) {
    const viewport = h('div', { class: 'viewport' });
    this.chip = h('div', { class: 'chip hidden' });
    viewport.append(this.chip);
    this.undoBtn = h('button', { class: 'icon', title: 'Undo (⌘Z)', onclick: () => this.undoStep() }, '↶');
    this.redoBtn = h('button', { class: 'icon', title: 'Redo (⇧⌘Z)', onclick: () => this.redoStep() }, '↷');
    const topbar = h(
      'header',
      { class: 'topbar' },
      h('div', { class: 'brand' }, 'DrawDoll'),
      h(
        'div',
        { class: 'actions' },
        this.undoBtn,
        this.redoBtn,
        h('button', { title: 'Swap the pose left ↔ right', onclick: () => this.mirror() }, 'Mirror'),
        h('button', { title: 'Back to a relaxed stand (body shape is kept)', onclick: () => this.resetPose() }, 'Reset pose'),
        h('button', { title: 'Fit the doll in the frame', onclick: () => this.viewer.frameFigure() }, 'Frame'),
        h('button', { class: 'primary', onclick: () => this.openExport() }, 'Export PNG'),
      ),
    );
    const tabs = h('nav', { class: 'tabs' });
    for (const [id, label] of [
      ['pose', 'Pose'],
      ['figure', 'Body'],
      ['camera', 'Camera'],
      ['look', 'Look'],
    ] as [Tab, string][]) {
      const b = h('button', { onclick: () => this.showTab(id) }, label);
      this.tabButtons.set(id, b);
      tabs.append(b);
    }
    this.panelBody = h('div', { class: 'panel-body' });
    const panel = h('aside', { class: 'panel' }, tabs, this.panelBody);
    root.append(topbar, viewport, panel);

    this.viewer = new Viewer(viewport, this.figure);
    this.viewer.onRender = () => this.positionChip();
    this.createHandles();
    this.applySettingsToViewer();
    this.rebuild();
    if (this.s.camera) {
      this.viewer.camera.position.fromArray(this.s.camera.pos);
      this.viewer.controls.target.fromArray(this.s.camera.target);
      this.viewer.controls.update();
    } else {
      this.viewer.controls.target.set(0, this.figure.P.H * 0.52, 0);
      this.viewer.camera.position.set(0, this.figure.P.H * 0.55, 4);
      this.viewer.setView(30, 6);
      this.viewer.frameFigure();
    }
    this.viewer.controls.addEventListener('end', () => this.saveSoon());

    this.installPicking();
    this.installDragging(viewport);
    this.installKeys();
    this.showTab('pose');
    this.updateHistoryButtons();
  }

  // ---------------------------------------------------------------- state

  private snapshot(): Snapshot {
    return JSON.stringify({ params: this.s.params, pose: this.s.pose });
  }

  private last: Snapshot = '';

  /** Call after a finished edit (slider released, pad lifted, preset chosen). */
  commit() {
    const snap = this.snapshot();
    if (snap === this.last) return;
    if (this.last) this.undo.push(this.last);
    if (this.undo.length > 200) this.undo.shift();
    this.redo = [];
    this.last = snap;
    this.updateHistoryButtons();
    this.saveSoon();
  }

  private restore(snap: Snapshot) {
    const { params, pose } = JSON.parse(snap);
    const paramsChanged = JSON.stringify(params) !== JSON.stringify(this.s.params);
    this.s.params = params;
    this.s.pose = completePose(pose);
    this.last = snap;
    if (paramsChanged) this.rebuild();
    else this.poseChanged();
    this.renderTab();
    this.updateHistoryButtons();
    this.saveSoon();
  }

  undoStep() {
    const prev = this.undo.pop();
    if (!prev) return;
    this.redo.push(this.snapshot());
    this.restore(prev);
  }

  redoStep() {
    const next = this.redo.pop();
    if (!next) return;
    this.undo.push(this.snapshot());
    this.restore(next);
  }

  private updateHistoryButtons() {
    this.undoBtn.disabled = this.undo.length === 0;
    this.redoBtn.disabled = this.redo.length === 0;
  }

  private saveSoon() {
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      const v = this.viewer;
      this.s.camera = { pos: v.camera.position.toArray(), target: v.controls.target.toArray() };
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify(this.s));
      } catch {
        // Storage can be unavailable (private browsing); the app works without it.
      }
    }, 400);
  }

  private applySettingsToViewer() {
    const v = this.viewer;
    v.focal = this.s.focal;
    v.frame = { ...this.s.frame };
    v.lightAz = this.s.lightAz;
    v.lightEl = this.s.lightEl;
    v.lineWeight = this.s.lineWeight;
    v.showHorizon = this.s.horizon;
    v.grid.visible = this.s.grid;
    v.balanceGroup.visible = this.s.balance;
    v.handles.visible = this.s.handles;
    this.figure.style = this.s.style;
    this.figure.setOutline(this.s.outline);
    v.updateProjection();
  }

  /** Rebuild the doll's geometry after body parameters change. */
  rebuild() {
    const P = computeProportions(this.s.params);
    // Pinned targets and a fixed hip position are in world units; scale them with the
    // body so a pinned pose survives changing age or height.
    if (this.lastH && P.H !== this.lastH) {
      const k = P.H / this.lastH;
      const pose = this.s.pose;
      for (const key of ['root', ...PIN_KEYS]) {
        const v = pose[key];
        if (!v) continue;
        v.x *= k;
        v.y *= k;
        v.z *= k;
      }
    }
    this.lastH = P.H;
    this.figure.build(P);
    this.figure.setGuidesVisible(this.s.guides);
    this.figure.setHighlight(this.selected);
    this.viewer.updateLight();
    this.poseChanged();
    if (!this.last) this.last = this.snapshot();
  }

  private rebuildSoon() {
    if (this.rebuildQueued) return;
    this.rebuildQueued = true;
    requestAnimationFrame(() => {
      this.rebuildQueued = false;
      this.rebuild();
    });
  }

  poseChanged() {
    applyPose(this.figure, this.s.pose, this.s.autoGround);
    this.updateBalance();
    this.updateHandles();
    this.viewer.invalidate();
  }

  // ---------------------------------------------------------------- pins

  isPinned(limb: Limb, side: Side) {
    return !!this.s.pose[pinKey(limb, side)];
  }

  hasPins() {
    return PIN_KEYS.some((k) => this.s.pose[k]);
  }

  /** Planted feet hold the hips where they are; with no feet pinned the doll stands on the floor. */
  private syncRoot() {
    const pose = this.s.pose;
    const feetPinned = this.isPinned('leg', 'L') || this.isPinned('leg', 'R');
    if (feetPinned && !pose.root.fixed) this.fixRoot();
    if (!feetPinned) pose.root.fixed = 0;
  }

  private fixRoot() {
    const p = this.figure.bones.pelvis.getWorldPosition(new THREE.Vector3());
    p.y -= (this.s.pose.body.lift ?? 0) * this.figure.P.H;
    this.s.pose.root = { x: p.x, y: p.y, z: p.z, fixed: 1 };
  }

  setPinned(limb: Limb, side: Side, on: boolean) {
    const key = pinKey(limb, side);
    if (on) this.s.pose[key] = makePin(this.figure, limb, side);
    else delete this.s.pose[key];
    this.syncRoot();
    this.poseChanged();
    this.commit();
    this.renderTab();
  }

  unpinAll() {
    for (const k of PIN_KEYS) delete this.s.pose[k];
    this.syncRoot();
    this.poseChanged();
    this.commit();
    this.renderTab();
  }

  // ---------------------------------------------------------------- handles

  private createHandles() {
    const geo = new THREE.SphereGeometry(1, 20, 14);
    for (const hd of HANDLES) {
      const m = new THREE.Mesh(
        geo,
        new THREE.MeshBasicMaterial({ color: '#4f7cff', transparent: true, opacity: 0.85, depthTest: false }),
      );
      m.renderOrder = 20;
      m.userData.handle = hd;
      m.userData.radiusPx = hd.id === 'hips' ? 11 : 9;
      this.viewer.handles.add(m);
    }
  }

  private updateHandles() {
    for (const m of this.viewer.handles.children as THREE.Mesh[]) {
      const hd = m.userData.handle as (typeof HANDLES)[number];
      const bone = hd.id === 'hips' ? 'pelvis' : hd.limb === 'arm' ? `wrist_${hd.side}` : `ankle_${hd.side}`;
      this.figure.bones[bone].getWorldPosition(m.position);
      const pinned = hd.limb ? this.isPinned(hd.limb, hd.side!) : false;
      const active = this.drag?.handle.id === hd.id;
      (m.material as THREE.MeshBasicMaterial).color.set(active ? '#ffffff' : pinned ? '#ff8a3d' : hd.id === 'hips' ? '#2fbf71' : '#4f7cff');
    }
  }

  /**
   * Drag a handle across a plane facing the camera. Hands and feet get a temporary
   * pin that follows the finger; moving the hips plants both feet first, so the
   * knees bend to crouch or lunge instead of the whole doll sliding.
   */
  private installDragging(viewport: HTMLElement) {
    viewport.addEventListener(
      'pointerdown',
      (e) => {
        if (!this.s.handles || this.drag || !e.isPrimary) return;
        const m = this.viewer.handleAt(e.clientX, e.clientY, e.pointerType === 'touch' ? 30 : 18);
        if (!m) return;
        e.stopPropagation();
        e.preventDefault();
        viewport.setPointerCapture(e.pointerId);
        const handle = m.userData.handle as (typeof HANDLES)[number];
        const pose = this.s.pose;
        const normal = this.viewer.camera.getWorldDirection(new THREE.Vector3());
        const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, m.position);
        const hit = this.viewer.rayAt(e.clientX, e.clientY).intersectPlane(plane, new THREE.Vector3()) ?? m.position.clone();
        const tempPins: string[] = [];
        const rootWasFixed = !!pose.root.fixed;
        if (!rootWasFixed) this.fixRoot();
        if (handle.limb) {
          const key = pinKey(handle.limb, handle.side!);
          if (!pose[key]) {
            pose[key] = makePin(this.figure, handle.limb, handle.side!);
            tempPins.push(key);
          }
        } else {
          for (const side of ['L', 'R'] as Side[]) {
            const key = pinKey('leg', side);
            if (!pose[key]) {
              pose[key] = makePin(this.figure, 'leg', side);
              tempPins.push(key);
            }
          }
        }
        this.drag = {
          handle,
          pointerId: e.pointerId,
          plane,
          offset: m.position.clone().sub(hit),
          startX: e.clientX,
          startY: e.clientY,
          moved: false,
          tempPins,
          rootWasFixed,
        };
        this.updateHandles();
        this.viewer.invalidate();
      },
      { capture: true },
    );
    viewport.addEventListener('pointermove', (e) => {
      const d = this.drag;
      if (!d || e.pointerId !== d.pointerId) return;
      if (!d.moved && Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 4) return;
      d.moved = true;
      const hit = this.viewer.rayAt(e.clientX, e.clientY).intersectPlane(d.plane, new THREE.Vector3());
      if (!hit) return;
      const target = hit.add(d.offset);
      const pose = this.s.pose;
      if (d.handle.limb) {
        Object.assign(pose[pinKey(d.handle.limb, d.handle.side!)], { x: target.x, y: target.y, z: target.z });
      } else {
        target.y -= (pose.body.lift ?? 0) * this.figure.P.H;
        Object.assign(pose.root, { x: target.x, y: target.y, z: target.z });
      }
      this.poseChanged();
    });
    const end = (e: PointerEvent) => {
      const d = this.drag;
      if (!d || e.pointerId !== d.pointerId) return;
      this.drag = null;
      const pose = this.s.pose;
      for (const key of d.tempPins) delete pose[key];
      if (!d.rootWasFixed) pose.root.fixed = 0;
      this.syncRoot();
      this.poseChanged();
      if (d.moved) {
        this.commit();
        if (this.tab === 'pose') this.renderTab();
      } else {
        this.select(d.handle.control);
      }
    };
    viewport.addEventListener('pointerup', end);
    viewport.addEventListener('pointercancel', end);
  }

  // ---------------------------------------------------------------- actions

  select(id: string | null) {
    this.selected = id;
    this.figure.setHighlight(id);
    this.viewer.invalidate();
    if (id && this.tab !== 'pose') this.showTab('pose');
    else if (this.tab === 'pose') this.renderTab();
  }

  mirror() {
    this.s.pose = mirrorPose(this.s.pose);
    if (this.selected && CONTROL_BY_ID[this.selected].side) {
      const c = CONTROL_BY_ID[this.selected];
      this.selected = `${c.base}_${c.side === 'L' ? 'R' : 'L'}`;
      this.figure.setHighlight(this.selected);
    }
    this.poseChanged();
    this.commit();
    this.renderTab();
  }

  resetPose() {
    this.s.pose = defaultPose();
    this.poseChanged();
    this.commit();
    this.renderTab();
  }

  resetBody() {
    this.s.params = { ...DEFAULT_PARAMS };
    this.rebuild();
    this.commit();
    this.renderTab();
  }

  loadPose(pose: Pose) {
    this.s.pose = completePose(JSON.parse(JSON.stringify(pose)));
    this.poseChanged();
    this.commit();
    this.renderTab();
  }

  // ---------------------------------------------------------------- picking

  private installPicking() {
    const canvas = this.viewer.renderer.domElement;
    const active = new Map<number, { x: number; y: number; t: number }>();
    let multi = false;
    canvas.addEventListener('pointerdown', (e) => {
      active.set(e.pointerId, { x: e.clientX, y: e.clientY, t: performance.now() });
      if (active.size > 1) multi = true;
    });
    const up = (e: PointerEvent) => {
      const start = active.get(e.pointerId);
      active.delete(e.pointerId);
      if (!start) return;
      const wasMulti = multi;
      if (active.size === 0) multi = false;
      if (wasMulti) return;
      const moved = Math.hypot(e.clientX - start.x, e.clientY - start.y);
      if (moved > 7 || performance.now() - start.t > 500) return;
      const id = this.viewer.pick(e.clientX, e.clientY);
      this.select(id);
    };
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', (e) => active.delete(e.pointerId));
  }

  private installKeys() {
    window.addEventListener('keydown', (e) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' && (target as HTMLInputElement).type !== 'range') return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) this.redoStep();
        else this.undoStep();
      } else if (e.key === 'Escape') {
        this.select(null);
      }
    });
  }

  private positionChip() {
    if (!this.selected) {
      this.chip.classList.add('hidden');
      return;
    }
    this.chip.classList.remove('hidden');
    this.chip.textContent = CONTROL_BY_ID[this.selected].label;
  }

  // ---------------------------------------------------------------- balance

  private updateBalance() {
    const g = this.viewer.balanceGroup;
    for (const c of g.children) {
      const m = c as THREE.Mesh;
      m.geometry.dispose();
    }
    g.clear();
    if (!this.s.balance) return;
    const P = this.figure.P;
    const { com, touching } = this.figure.balance(0, 0.02 * P.H);
    const pts = hull(touching.map((p) => new THREE.Vector2(p.x, p.z)));
    const c2 = new THREE.Vector2(com.x, com.z);
    const stable = insideHull(pts, c2, 0.01 * P.H);
    const color = stable ? '#2fbf71' : '#ff7a2f';
    if (pts.length >= 2) {
      const ring = pts.map((p) => new THREE.Vector3(p.x, 0.002, p.y));
      ring.push(ring[0].clone());
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(ring), new THREE.LineBasicMaterial({ color }));
      g.add(line);
    }
    const dot = new THREE.Mesh(
      new THREE.CircleGeometry(0.018 * P.H, 24).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.9 }),
    );
    dot.position.set(com.x, 0.003, com.z);
    dot.renderOrder = 10;
    g.add(dot);
    const stem = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(com.x, 0.003, com.z), com.clone()]),
      new THREE.LineDashedMaterial({ color, dashSize: 0.02, gapSize: 0.015, depthTest: false, transparent: true }),
    );
    stem.computeLineDistances();
    stem.renderOrder = 10;
    g.add(stem);
  }

  // ---------------------------------------------------------------- panels

  showTab(tab: Tab) {
    this.tab = tab;
    for (const [id, b] of this.tabButtons) b.classList.toggle('on', id === tab);
    this.renderTab();
  }

  renderTab() {
    this.panelBody.replaceChildren();
    const body = this.panelBody;
    if (this.tab === 'pose') body.append(...this.poseTab());
    if (this.tab === 'figure') body.append(...this.figureTab());
    if (this.tab === 'camera') body.append(...this.cameraTab());
    if (this.tab === 'look') body.append(...this.lookTab());
  }

  private partPicker() {
    const sel = h('select', { class: 'part-select' });
    sel.append(h('option', { value: '' }, 'Tap a body part, or choose…'));
    const groups: [string, (c: ControlDef) => boolean][] = [
      ['Center', (c) => !c.side],
      ['Left side', (c) => c.side === 'L'],
      ['Right side', (c) => c.side === 'R'],
    ];
    for (const [label, test] of groups) {
      const og = h('optgroup', { label });
      for (const c of CONTROLS.filter(test)) og.append(h('option', { value: c.id }, c.label));
      sel.append(og);
    }
    sel.value = this.selected ?? '';
    sel.addEventListener('change', () => this.select(sel.value || null));
    return sel;
  }

  private formatDof(dof: Dof) {
    if (dof.unit === 'pct') return (v: number) => `${Math.round(v)}%`;
    if (dof.unit === 'len') return (v: number) => `${Math.round(v * this.figure.P.H * 100)} cm`;
    return (v: number) => `${Math.round(v)}°`;
  }

  private poseTab(): Node[] {
    const out: Node[] = [this.partPicker()];
    const id = this.selected;
    if (!id) {
      out.push(
        h(
          'p',
          { class: 'hint' },
          'Tap any part of the doll to pose it. Drag empty space to orbit, pinch to zoom, two fingers to pan. Left and right are the doll’s own.',
        ),
      );
    } else {
      const c = CONTROL_BY_ID[id];
      const values = this.s.pose[id];
      const limbOf = LIMB_OF[id];
      const pinned = limbOf ? this.isPinned(limbOf[0], limbOf[1]) : false;
      const locked = (dofId: string) => pinned && (PINNED_DOFS[c.base] ?? []).includes(dofId);
      const header = h(
        'div',
        { class: 'part-actions' },
        h(
          'button',
          {
            onclick: () => {
              this.s.pose[id] = Object.fromEntries(c.dofs.map((d) => [d.id, d.def]));
              this.poseChanged();
              this.commit();
              this.renderTab();
            },
          },
          'Reset part',
        ),
        c.side
          ? h(
              'button',
              {
                onclick: () => {
                  const other = `${c.base}_${c.side === 'L' ? 'R' : 'L'}`;
                  this.s.pose[other] = { ...values };
                  this.poseChanged();
                  this.commit();
                },
              },
              `Copy to ${c.side === 'L' ? 'right' : 'left'}`,
            )
          : null,
      );
      out.push(header);
      out.push(...this.ikControls(c, pinned));
      if (pinned && c.base !== 'hand' && c.base !== 'foot') {
        out.push(h('p', { class: 'hint' }, `This limb is pinned. Drag its ${limbOf[0] === 'arm' ? 'hand' : 'foot'} to move it, or unpin it to use these sliders.`));
      }

      const sliders = new Map<string, ReturnType<typeof slider>>();
      let pad: SwingPad | null = null;
      if (c.pad) {
        pad = new SwingPad(c.pad, c.side!, (fwd, outv, done) => {
          values.fwd = fwd;
          values.out = outv;
          sliders.get('fwd')?.set(fwd);
          sliders.get('out')?.set(outv);
          this.poseChanged();
          if (done) this.commit();
        });
        out.push(
          h(
            'div',
            { class: locked('fwd') ? 'pad-wrap disabled' : 'pad-wrap' },
            pad.el,
            h('p', { class: 'pad-caption' }, 'Drag to aim the limb. Centre = hanging down · rim = straight up.'),
          ),
        );
        requestAnimationFrame(() => pad!.set(values.fwd, values.out));
      }
      for (const dof of c.dofs) {
        if (dof.id === 'lift' && !this.s.autoGround) continue;
        const sl = slider({
          label: dof.label,
          min: dof.min,
          max: dof.max,
          step: dof.unit === 'len' ? 0.005 : 1,
          value: values[dof.id],
          def: dof.def,
          lo: dof.lo,
          hi: dof.hi,
          format: this.formatDof(dof),
          disabled: locked(dof.id),
          onInput: (v) => {
            if (c.pad && (dof.id === 'fwd' || dof.id === 'out')) {
              const nf = dof.id === 'fwd' ? v : values.fwd;
              const no = dof.id === 'out' ? v : values.out;
              const [f, o] = clampReachAxis(c.pad, nf, no, dof.id, values.fwd, values.out);
              values.fwd = Math.round(f);
              values.out = Math.round(o);
              if (Math.round(v) !== values[dof.id]) sl.set(values[dof.id]);
              pad?.set(values.fwd, values.out);
            } else {
              values[dof.id] = v;
            }
            this.poseChanged();
          },
          onCommit: () => this.commit(),
        });
        sliders.set(dof.id, sl);
        out.push(sl.el);
      }
    }

    const presetGrid = h('div', { class: 'chips' });
    for (const p of PRESETS) presetGrid.append(h('button', { onclick: () => this.loadPose(p.pose) }, p.name));
    const savedList = h('div', { class: 'saved' });
    this.s.saved.forEach((p, i) => {
      savedList.append(
        h(
          'div',
          { class: 'saved-row' },
          h('button', { class: 'saved-name', onclick: () => this.loadPose(p.pose) }, p.name),
          h(
            'button',
            {
              class: 'icon',
              title: 'Delete',
              onclick: () => {
                this.s.saved.splice(i, 1);
                this.saveSoon();
                this.renderTab();
              },
            },
            '×',
          ),
        ),
      );
    });
    out.push(
      section(
        'Poses',
        presetGrid,
        savedList,
        h(
          'button',
          {
            class: 'wide',
            onclick: () => {
              const name = prompt('Name this pose', `Pose ${this.s.saved.length + 1}`);
              if (!name) return;
              this.s.saved.push({ name, pose: JSON.parse(JSON.stringify(this.s.pose)) });
              this.saveSoon();
              this.renderTab();
            },
          },
          'Save current pose',
        ),
      ),
    );
    return out;
  }

  /** Pin toggle and elbow/knee direction for hands and feet; quick actions for body and head. */
  private ikControls(c: ControlDef, pinned: boolean): Node[] {
    if (c.base === 'hand' || c.base === 'foot') {
      const limb: Limb = c.base === 'hand' ? 'arm' : 'leg';
      const side = c.side!;
      const swivel = slider({
        label: limb === 'arm' ? 'Elbow points' : 'Knee points',
        min: -120,
        max: 120,
        value: Math.round(getSwivel(this.figure, limb, side)),
        lo: 'Inward',
        hi: 'Outward',
        onInput: (v) => {
          setSwivel(this.figure, this.s.pose, limb, side, v, this.s.autoGround);
          this.poseChanged();
        },
        onCommit: () => this.commit(),
      });
      return [
        toggle(
          limb === 'arm' ? 'Pin hand in place' : 'Pin foot in place',
          pinned,
          (on) => this.setPinned(limb, side, on),
        ),
        swivel.el,
        h(
          'p',
          { class: 'hint' },
          limb === 'arm'
            ? 'Drag the blue dot on the wrist to place the hand. A pinned hand stays put while you move the body.'
            : 'Drag the blue dot on the ankle to place the foot. Pinned feet stay planted when you lean, twist or move the hips.',
        ),
      ];
    }
    if (c.id === 'body') {
      const nodes: Node[] = [
        h('p', { class: 'hint' }, 'Drag the green dot on the hips to crouch, lunge or shift weight: the feet stay planted and the knees bend.'),
      ];
      if (this.hasPins()) nodes.push(h('button', { class: 'wide', onclick: () => this.unpinAll() }, 'Unpin all hands and feet'));
      return nodes;
    }
    if (c.id === 'head') {
      return [
        h(
          'button',
          {
            class: 'wide',
            onclick: () => {
              lookAt(this.figure, this.s.pose, this.viewer.camera.position);
              this.poseChanged();
              this.commit();
              this.renderTab();
            },
          },
          'Look at camera',
        ),
      ];
    }
    return [];
  }

  private figureTab(): Node[] {
    const p = this.s.params;
    const info = h('div', { class: 'info' });
    const refreshInfo = () => {
      const P = computeProportions(p);
      info.textContent = `${describeHeight(P)} · ${P.headsTall.toFixed(1)} heads tall`;
    };
    refreshInfo();
    const change = (k: keyof FigureParams) => (v: number) => {
      p[k] = v;
      refreshInfo();
      this.rebuildSoon();
    };
    const commit = () => this.commit();
    const age = slider({
      label: 'Age',
      min: 2,
      max: 25,
      step: 0.5,
      value: p.age,
      def: DEFAULT_PARAMS.age,
      lo: '2',
      hi: 'Adult',
      format: (v) => (v >= 20 ? 'Adult' : `${v % 1 ? v.toFixed(1) : v} yrs`),
      onInput: change('age'),
      onCommit: commit,
    });
    const ages = h('div', { class: 'chips' });
    for (const a of AGES) {
      ages.append(
        h(
          'button',
          {
            onclick: () => {
              p.age = a.age;
              age.set(a.age);
              refreshInfo();
              this.rebuild();
              this.commit();
            },
          },
          a.label,
        ),
      );
    }
    const pct = (v: number) => `${Math.round(v * 100)}%`;
    return [
      section(
        'Body',
        info,
        age.el,
        ages,
        slider({
          label: 'Sex',
          min: 0,
          max: 1,
          step: 0.01,
          value: p.sex,
          def: DEFAULT_PARAMS.sex,
          lo: 'Female',
          hi: 'Male',
          format: (v) => (Math.abs(v - 0.5) < 0.03 ? 'Neutral' : v < 0.5 ? `F ${pct(1 - v)}` : `M ${pct(v)}`),
          onInput: change('sex'),
          onCommit: commit,
        }).el,
        slider({
          label: 'Height',
          min: 0.85,
          max: 1.15,
          step: 0.01,
          value: p.height,
          def: 1,
          lo: 'Short',
          hi: 'Tall',
          format: (v) => (Math.abs(v - 1) < 0.005 ? 'Average' : `${v > 1 ? '+' : ''}${Math.round((v - 1) * 100)}%`),
          onInput: change('height'),
          onCommit: commit,
        }).el,
        slider({
          label: 'Build',
          min: 0,
          max: 1,
          step: 0.01,
          value: p.build,
          def: DEFAULT_PARAMS.build,
          lo: 'Slim',
          hi: 'Heavy',
          format: pct,
          onInput: change('build'),
          onCommit: commit,
        }).el,
        slider({
          label: 'Muscle',
          min: 0,
          max: 1,
          step: 0.01,
          value: p.muscle,
          def: DEFAULT_PARAMS.muscle,
          lo: 'Soft',
          hi: 'Muscular',
          format: pct,
          onInput: change('muscle'),
          onCommit: commit,
        }).el,
        h('button', { class: 'wide', onclick: () => this.resetBody() }, 'Reset body'),
        h(
          'p',
          { class: 'hint' },
          'Proportions follow growth-chart medians: toddlers are about 4½ heads tall with short legs, adults about 7½.',
        ),
      ),
    ];
  }

  private cameraTab(): Node[] {
    const v = this.viewer;
    // Log scale so the wide end isn't cramped.
    const toF = (t: number) => Math.round(14 * Math.pow(200 / 14, t));
    const toT = (f: number) => Math.log(f / 14) / Math.log(200 / 14);
    const focal = slider({
      label: 'Lens',
      min: 0,
      max: 1,
      step: 0.001,
      value: toT(this.s.focal),
      def: toT(50),
      lo: 'Wide (14 mm)',
      hi: 'Tele (200 mm)',
      format: (t) => `${toF(t)} mm`,
      onInput: (t) => {
        this.s.focal = toF(t);
        v.setFocal(this.s.focal, this.s.keepFraming);
      },
      onCommit: () => this.saveSoon(),
    });
    const lenses = h('div', { class: 'chips' });
    for (const f of [24, 35, 50, 85, 135]) {
      lenses.append(
        h(
          'button',
          {
            onclick: () => {
              this.s.focal = f;
              v.setFocal(f, this.s.keepFraming);
              focal.set(toT(f));
              this.saveSoon();
            },
          },
          `${f}`,
        ),
      );
    }
    const views = h('div', { class: 'chips' });
    for (const vw of VIEWS) views.append(h('button', { onclick: () => v.setView(vw.az, vw.el) }, vw.label));

    const sel = h('select', {});
    for (const f of FRAMES) sel.append(h('option', { value: f.id }, f.label));
    sel.value = this.s.frameId;
    const wIn = h('input', { type: 'number', min: 16, max: 8192, value: this.s.frame.w, inputmode: 'numeric' });
    const hIn = h('input', { type: 'number', min: 16, max: 8192, value: this.s.frame.h, inputmode: 'numeric' });
    const applyFrame = (w: number, hh: number) => {
      this.s.frame = { w, h: hh };
      wIn.value = String(w);
      hIn.value = String(hh);
      v.setFrame(this.s.frame);
      this.saveSoon();
    };
    sel.addEventListener('change', () => {
      this.s.frameId = sel.value;
      const f = FRAMES.find((x) => x.id === sel.value)!;
      if (f.w) {
        const landscape = this.s.frame.w > this.s.frame.h;
        const [a, b] = [Math.min(f.w, f.h), Math.max(f.w, f.h)];
        applyFrame(landscape ? b : a, landscape ? a : b);
      }
    });
    const custom = () => {
      const w = Math.max(16, Math.min(8192, Math.round(Number(wIn.value) || 16)));
      const hh = Math.max(16, Math.min(8192, Math.round(Number(hIn.value) || 16)));
      this.s.frameId = 'custom';
      sel.value = 'custom';
      applyFrame(w, hh);
    };
    wIn.addEventListener('change', custom);
    hIn.addEventListener('change', custom);

    return [
      section(
        'Lens',
        focal.el,
        lenses,
        toggle('Keep doll the same size when changing lens', this.s.keepFraming, (b) => {
          this.s.keepFraming = b;
          this.saveSoon();
        }),
        h('p', { class: 'hint' }, 'Wide lenses exaggerate perspective (big near hands, tiny far feet). 50–85 mm looks natural.'),
      ),
      section('View', views, h('button', { class: 'wide', onclick: () => v.frameFigure() }, 'Fit doll in frame')),
      section(
        'Canvas size',
        sel,
        h(
          'div',
          { class: 'size-row' },
          wIn,
          h('span', {}, '×'),
          hIn,
          h('button', { title: 'Swap portrait / landscape', onclick: () => applyFrame(this.s.frame.h, this.s.frame.w) }, '⇄'),
        ),
        h('p', { class: 'hint' }, 'Match your Procreate or Pixquare canvas so the export drops in 1:1.'),
      ),
      section(
        'Guides',
        toggle('Horizon line (eye level)', this.s.horizon, (b) => {
          this.s.horizon = b;
          v.showHorizon = b;
          v.invalidate();
          this.saveSoon();
        }),
        toggle('Floor grid', this.s.grid, (b) => {
          this.s.grid = b;
          v.grid.visible = b;
          v.invalidate();
          this.saveSoon();
        }),
        toggle('Balance (centre of mass)', this.s.balance, (b) => {
          this.s.balance = b;
          v.balanceGroup.visible = b;
          this.updateBalance();
          v.invalidate();
          this.saveSoon();
        }),
        toggle('Drag handles on hands, feet and hips', this.s.handles, (b) => {
          this.s.handles = b;
          v.handles.visible = b;
          v.invalidate();
          this.saveSoon();
        }),
        toggle('Keep feet on the floor', this.s.autoGround, (b) => {
          this.s.autoGround = b;
          this.poseChanged();
          this.saveSoon();
        }),
      ),
    ];
  }

  private lookTab(): Node[] {
    const v = this.viewer;
    const f = this.figure;
    return [
      section(
        'Style',
        segmented<RenderStyle>(
          [
            { value: 'shaded', label: 'Shaded' },
            { value: 'toon', label: 'Toon' },
            { value: 'lines', label: 'Line art' },
          ],
          this.s.style,
          (st) => {
            this.s.style = st;
            f.setStyle(st);
            v.invalidate();
            this.saveSoon();
          },
        ),
        toggle('Outlines', this.s.outline, (b) => {
          this.s.outline = b;
          f.setOutline(b);
          v.invalidate();
          this.saveSoon();
        }),
        slider({
          label: 'Line weight',
          min: 0.5,
          max: 5,
          step: 0.1,
          value: this.s.lineWeight,
          def: 1.5,
          lo: 'Fine',
          hi: 'Bold',
          format: (x) => x.toFixed(1),
          onInput: (x) => {
            this.s.lineWeight = x;
            v.lineWeight = x;
            v.invalidate();
          },
          onCommit: () => this.saveSoon(),
        }).el,
        toggle('Face guide lines', this.s.guides, (b) => {
          this.s.guides = b;
          f.setGuidesVisible(b);
          v.invalidate();
          this.saveSoon();
        }),
      ),
      section(
        'Light',
        slider({
          label: 'Direction',
          min: -180,
          max: 180,
          value: this.s.lightAz,
          def: -35,
          lo: 'Behind',
          hi: 'Behind',
          onInput: (x) => {
            this.s.lightAz = x;
            v.lightAz = x;
            v.updateLight();
          },
          onCommit: () => this.saveSoon(),
        }).el,
        slider({
          label: 'Height',
          min: 5,
          max: 90,
          value: this.s.lightEl,
          def: 45,
          lo: 'Low',
          hi: 'Overhead',
          onInput: (x) => {
            this.s.lightEl = x;
            v.lightEl = x;
            v.updateLight();
          },
          onCommit: () => this.saveSoon(),
        }).el,
      ),
    ];
  }

  // ---------------------------------------------------------------- export

  private openExport() {
    const e = this.s.exp;
    const img = h('img', { class: 'preview', alt: 'Export preview', draggable: 'true' });
    const status = h('p', { class: 'hint' });
    let blob: Blob | null = null;
    let url = '';
    const regenerate = async () => {
      status.textContent = 'Rendering…';
      blob = await renderPNG(this.viewer, this.figure, e);
      if (url) URL.revokeObjectURL(url);
      url = URL.createObjectURL(blob);
      img.src = url;
      const { w, h: hh, scaled } = exportSize(this.viewer);
      status.textContent = `${w} × ${hh} px · ${(blob.size / 1024 / 1024).toFixed(1)} MB${scaled ? ' (reduced to fit device limits)' : ''}`;
      this.saveSoon();
    };
    const close = () => {
      if (url) URL.revokeObjectURL(url);
      dialog.remove();
    };
    const name = fileName();
    const file = () => new File([blob!], name, { type: 'image/png' });
    // Share and Copy need a secure context (HTTPS or localhost); over plain LAN http only Download works.
    const canShare = typeof navigator.canShare === 'function';
    const canCopy = typeof ClipboardItem !== 'undefined' && !!navigator.clipboard?.write;
    const share = h(
      'button',
      {
        class: 'primary',
        onclick: async () => {
          if (!blob) return;
          try {
            await navigator.share({ files: [file()] });
          } catch (err) {
            if ((err as Error).name !== 'AbortError') status.textContent = 'Sharing failed — try Copy or Download.';
          }
        },
      },
      'Share…',
    );
    const copy = h(
      'button',
      {
        onclick: () => {
          if (!blob) return;
          navigator.clipboard
            .write([new ClipboardItem({ 'image/png': Promise.resolve(blob) })])
            .then(() => (status.textContent = 'Copied. In Procreate: three-finger swipe down → Paste. It lands as a new layer.'))
            .catch(() => (status.textContent = 'Copy is not allowed here — use Share or Download.'));
        },
      },
      'Copy',
    );
    const download = h(
      'button',
      {
        onclick: () => {
          if (!url) return;
          const a = h('a', { href: url, download: name });
          document.body.append(a);
          a.click();
          a.remove();
        },
      },
      'Download',
    );
    const dialog = h(
      'div',
      { class: 'modal', onclick: (ev: Event) => ev.target === dialog && close() },
      h(
        'div',
        { class: 'sheet' },
        h('div', { class: 'sheet-head' }, h('h2', {}, 'Export PNG'), h('button', { class: 'icon', onclick: close }, '×')),
        h('div', { class: 'preview-wrap' }, img),
        status,
        segmented<Background>(
          [
            { value: 'transparent', label: 'Transparent' },
            { value: 'white', label: 'White' },
            { value: 'gray', label: 'Gray' },
          ],
          e.background,
          (b) => {
            e.background = b;
            regenerate();
          },
        ),
        toggle('Floor shadow', e.shadow, (b) => {
          e.shadow = b;
          regenerate();
        }),
        toggle('Floor grid', e.grid, (b) => {
          e.grid = b;
          regenerate();
        }),
        toggle('Horizon line', e.horizon, (b) => {
          e.horizon = b;
          regenerate();
        }),
        h('div', { class: 'sheet-actions' }, canShare ? share : null, canCopy ? copy : null, download),
        h(
          'p',
          { class: 'hint' },
          'On iPad you can also drag the preview straight onto a Procreate canvas in Split View, or Share → Save Image, then Insert a photo.',
        ),
      ),
    );
    document.body.append(dialog);
    regenerate();
  }
}

// ---------------------------------------------------------------- geometry helpers

function hull(points: THREE.Vector2[]): THREE.Vector2[] {
  const p = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (p.length < 3) return p;
  const cross = (o: THREE.Vector2, a: THREE.Vector2, b: THREE.Vector2) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: THREE.Vector2[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: THREE.Vector2[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

function insideHull(poly: THREE.Vector2[], p: THREE.Vector2, tol: number): boolean {
  if (poly.length === 0) return false;
  if (poly.length < 3) {
    const a = poly[0];
    const b = poly[poly.length - 1];
    const ab = b.clone().sub(a);
    const t = ab.lengthSq() > 0 ? Math.max(0, Math.min(1, p.clone().sub(a).dot(ab) / ab.lengthSq())) : 0;
    return a.clone().addScaledVector(ab, t).distanceTo(p) < tol;
  }
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const edge = b.clone().sub(a);
    const cross = edge.x * (p.y - a.y) - edge.y * (p.x - a.x);
    if (cross < -tol * edge.length()) return false;
  }
  return true;
}
