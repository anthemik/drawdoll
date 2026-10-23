import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Figure } from './figure';
import { DEG } from './math';

export interface FrameSize {
  w: number;
  h: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 35 mm-equivalent: focal length refers to a 36 mm film width on the frame's long side. */
export function tanHalfVFov(focal: number, aspect: number) {
  return 18 / focal / Math.max(aspect, 1);
}

export class Viewer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(30, 1, 0.01, 200);
  readonly controls: OrbitControls;
  readonly key = new THREE.DirectionalLight('#ffffff', 2.4);
  readonly hemi = new THREE.HemisphereLight('#f4f6ff', '#6b665f', 1.1);
  readonly ground: THREE.Mesh;
  readonly grid: THREE.GridHelper;
  readonly balanceGroup = new THREE.Group();
  /** Drag handles on hands, feet and hips; drawn on top and kept a constant size on screen. */
  readonly handles = new THREE.Group();
  readonly overlay: HTMLCanvasElement;
  readonly frameEl: HTMLDivElement;

  focal = 50;
  frame: FrameSize = { w: 2048, h: 2732 };
  rect: Rect = { x: 0, y: 0, w: 1, h: 1 };
  showHorizon = false;
  lightAz = -35;
  lightEl = 45;
  lineWeight = 1.5;
  private dirty = true;
  onRender?: () => void;

  constructor(private container: HTMLElement, private figure: Figure) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.setClearColor(0x000000, 0);
    container.appendChild(this.renderer.domElement);

    this.frameEl = document.createElement('div');
    this.frameEl.className = 'frame';
    container.appendChild(this.frameEl);
    this.overlay = document.createElement('canvas');
    this.overlay.className = 'overlay';
    container.appendChild(this.overlay);

    this.scene.add(this.hemi);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(2048, 2048);
    this.key.shadow.bias = -0.0004;
    this.key.shadow.normalBias = 0.025;
    this.scene.add(this.key, this.key.target);

    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.ShadowMaterial({ opacity: 0.22 }));
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.receiveShadow = true;
    this.scene.add(this.ground);
    this.grid = new THREE.GridHelper(6, 24, '#59606c', '#7d838d');
    (this.grid.material as THREE.Material).transparent = true;
    (this.grid.material as THREE.Material).opacity = 0.55;
    this.grid.position.y = 0.0005;
    this.scene.add(this.grid);
    this.scene.add(this.balanceGroup);
    this.scene.add(this.handles);
    this.scene.add(figure.group);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.15;
    this.controls.minDistance = 0.3;
    this.controls.maxDistance = 30;
    this.controls.addEventListener('change', () => this.invalidate());

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    const loop = () => {
      requestAnimationFrame(loop);
      this.controls.update();
      if (this.dirty) {
        this.dirty = false;
        this.render();
      }
    };
    loop();
  }

  invalidate() {
    this.dirty = true;
  }

  resize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h);
    const dpr = Math.min(window.devicePixelRatio, 2);
    this.overlay.width = Math.round(w * dpr);
    this.overlay.height = Math.round(h * dpr);
    this.overlay.style.width = `${w}px`;
    this.overlay.style.height = `${h}px`;
    this.updateProjection();
  }

  /** Fit the export frame inside the viewport and widen the viewport FOV so the frame shows exactly what will export. */
  updateProjection() {
    const vw = this.container.clientWidth;
    const vh = this.container.clientHeight;
    const ea = this.frame.w / this.frame.h;
    const m = Math.max(12, Math.min(vw, vh) * 0.04);
    const aw = vw - 2 * m;
    const ah = vh - 2 * m;
    let rw: number;
    let rh: number;
    if (aw / ah > ea) {
      rh = ah;
      rw = rh * ea;
    } else {
      rw = aw;
      rh = rw / ea;
    }
    this.rect = { x: (vw - rw) / 2, y: (vh - rh) / 2, w: rw, h: rh };
    Object.assign(this.frameEl.style, {
      left: `${this.rect.x}px`,
      top: `${this.rect.y}px`,
      width: `${rw}px`,
      height: `${rh}px`,
    });
    const tanV = tanHalfVFov(this.focal, ea) * (vh / rh);
    this.camera.fov = (2 * Math.atan(tanV)) / DEG;
    this.camera.aspect = vw / vh;
    this.camera.updateProjectionMatrix();
    this.invalidate();
  }

  setFocal(f: number, keepFraming: boolean) {
    if (keepFraming) {
      const off = this.camera.position.clone().sub(this.controls.target);
      off.multiplyScalar(f / this.focal);
      this.camera.position.copy(this.controls.target).add(off);
    }
    this.focal = f;
    this.updateProjection();
  }

  setFrame(size: FrameSize) {
    this.frame = size;
    this.updateProjection();
  }

  /** Orbit to a view direction: azimuth 0 = in front of the doll, elevation positive = above. */
  setView(az: number, el: number) {
    const dist = this.camera.position.distanceTo(this.controls.target);
    const a = az * DEG;
    const e = el * DEG;
    this.camera.position.set(
      this.controls.target.x + dist * Math.cos(e) * Math.sin(a),
      this.controls.target.y + dist * Math.sin(e),
      this.controls.target.z + dist * Math.cos(e) * Math.cos(a),
    );
    this.controls.update();
    this.invalidate();
  }

  /** Centre the doll in the export frame with a little breathing room, keeping the view direction. */
  frameFigure() {
    const box = new THREE.Box3();
    for (const m of this.figure.meshes) box.expandByObject(m);
    const c = box.getCenter(new THREE.Vector3());
    const ea = this.frame.w / this.frame.h;
    const tv = tanHalfVFov(this.focal, ea);
    const th = tv * ea;
    const back = this.camera.position.clone().sub(this.controls.target).normalize();
    if (back.lengthSq() < 0.5) back.set(0, 0, 1);
    const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), back);
    if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
    right.normalize();
    const up = new THREE.Vector3().crossVectors(back, right);
    // Distance at which every box corner fits inside the frame's view cone.
    let dist = 0;
    const p = new THREE.Vector3();
    for (let i = 0; i < 8; i++) {
      p.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).sub(c);
      const z = p.dot(back);
      dist = Math.max(dist, z + Math.abs(p.dot(right)) / th, z + Math.abs(p.dot(up)) / tv);
    }
    this.controls.target.copy(c);
    this.camera.position.copy(c).addScaledVector(back, dist * 1.08);
    this.controls.update();
    this.invalidate();
  }

  updateLight() {
    const H = this.figure.P?.H ?? 1.7;
    const a = this.lightAz * DEG;
    const e = this.lightEl * DEG;
    const target = new THREE.Vector3(0, H * 0.5, 0);
    this.key.target.position.copy(target);
    this.key.position.set(Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e)).multiplyScalar(H * 3).add(target);
    const cam = this.key.shadow.camera;
    const r = H * 1.3;
    cam.left = -r;
    cam.right = r;
    cam.top = r;
    cam.bottom = -r;
    cam.near = 0.1;
    cam.far = H * 7;
    cam.updateProjectionMatrix();
    this.invalidate();
  }

  /** Screen-space y of the horizon (eye level) for a camera, in [0,1] from the top, or null if out of view. */
  horizonY(camera: THREE.PerspectiveCamera): number | null {
    const fwd = new THREE.Vector3();
    camera.getWorldDirection(fwd);
    fwd.y = 0;
    if (fwd.lengthSq() < 1e-6) return null;
    // Project the horizontal direction itself (w = 0): its vanishing point lies on the horizon.
    camera.updateMatrixWorld();
    const v = new THREE.Vector4(fwd.x, 0, fwd.z, 0).applyMatrix4(camera.matrixWorldInverse).applyMatrix4(camera.projectionMatrix);
    if (v.w <= 1e-6) return null;
    return (1 - v.y / v.w) / 2;
  }

  render() {
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    const dpr = size.y / this.container.clientHeight;
    this.figure.outlineMat.uniforms.uResolution.value.copy(size);
    this.figure.outlineMat.uniforms.uThickness.value = (this.lineWeight * this.rect.h * dpr) / 1000;
    const pxToWorld = (2 * Math.tan((this.camera.fov * DEG) / 2)) / this.container.clientHeight;
    for (const m of this.handles.children) {
      m.scale.setScalar(this.camera.position.distanceTo(m.position) * pxToWorld * (m.userData.radiusPx ?? 10));
    }
    this.renderer.render(this.scene, this.camera);
    this.drawOverlay();
    this.onRender?.();
  }

  private drawOverlay() {
    const g = this.overlay.getContext('2d')!;
    g.clearRect(0, 0, this.overlay.width, this.overlay.height);
    if (!this.showHorizon) return;
    const y = this.horizonY(this.camera);
    if (y === null) return;
    const dpr = this.overlay.width / this.container.clientWidth;
    const py = y * this.overlay.height;
    if (py < this.rect.y * dpr || py > (this.rect.y + this.rect.h) * dpr) return;
    g.strokeStyle = 'rgba(255,80,60,0.85)';
    g.lineWidth = 1.5 * dpr;
    g.setLineDash([8 * dpr, 6 * dpr]);
    g.beginPath();
    g.moveTo(this.rect.x * dpr, py);
    g.lineTo((this.rect.x + this.rect.w) * dpr, py);
    g.stroke();
    g.setLineDash([]);
    g.fillStyle = 'rgba(255,80,60,0.95)';
    g.font = `${11 * dpr}px system-ui, sans-serif`;
    g.fillText('HORIZON', (this.rect.x + 6) * dpr, py - 5 * dpr);
  }

  /** The handle nearest a client position, within `maxPx` screen pixels. */
  handleAt(clientX: number, clientY: number, maxPx: number): THREE.Object3D | null {
    const r = this.renderer.domElement.getBoundingClientRect();
    let best: THREE.Object3D | null = null;
    let bestD = maxPx;
    for (const m of this.handles.children) {
      if (!m.visible) continue;
      const p = m.position.clone().project(this.camera);
      if (p.z > 1) continue;
      const d = Math.hypot(r.left + ((p.x + 1) / 2) * r.width - clientX, r.top + ((1 - p.y) / 2) * r.height - clientY);
      if (d < bestD) {
        bestD = d;
        best = m;
      }
    }
    return best;
  }

  /** World-space ray through a client position. */
  rayAt(clientX: number, clientY: number): THREE.Ray {
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    return ray.ray;
  }

  /** Raycast the doll at a client position, returning the control id hit. */
  pick(clientX: number, clientY: number): string | null {
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const hit = ray.intersectObjects(this.figure.meshes, false)[0];
    if (!hit) return null;
    const perVertex = hit.object.userData.vertexControl as string[] | undefined;
    if (perVertex && hit.face) return perVertex[hit.face.a];
    return hit.object.userData.control as string;
  }
}
