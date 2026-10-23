import * as THREE from 'three';
import { loft, Ring } from './loft';
import { Proportions } from './proportions';
import { lerp, smoothstep } from './math';
import { RealisticAsset, eyeball, fitSkeleton, jointCentres, morph, placeMesh } from './realistic';

export type Side = 'L' | 'R';
export const SIDES: Side[] = ['L', 'R'];
/** The doll faces +Z, so its own left is +X. */
export const sgn = (side: Side) => (side === 'L' ? 1 : -1);

export type RenderStyle = 'shaded' | 'toon' | 'lines';

/** The pose control a bone's skin belongs to (for tapping and highlighting). */
export function controlOfBone(bone: string): string {
  const m = bone.match(/^(.*)_([LR])$/);
  if (!m) return { pelvis: 'body', lumbar: 'waist', chest: 'chest' }[bone] ?? 'head';
  const [, base, side] = m;
  const map: Record<string, string> = { clav: 'shoulder', shoulder: 'arm', elbow: 'forearm', hip: 'thigh', knee: 'shin', ankle: 'foot', toe: 'foot' };
  return `${map[base] ?? 'hand'}_${side}`;
}

const BASE_COLOR = new THREE.Color('#d9d2c9');
const HIGHLIGHT = new THREE.Color('#4f7cff');

function ellipsoid(rx: number, ry: number, rz: number, x = 0, y = 0, z = 0, seg = 24): THREE.BufferGeometry {
  return new THREE.SphereGeometry(1, seg, Math.round(seg * 0.66)).scale(rx, ry, rz).translate(x, y, z);
}

/** Capsule spanning y = 0 down to y = -len, with rounded ends overlapping its neighbours. */
function phalanx(r: number, len: number): THREE.BufferGeometry {
  return new THREE.CapsuleGeometry(r, len, 4, 10).translate(0, -len / 2, 0);
}

/** Loft built along -Y then turned so it runs forward along +Z (feet). */
function forwardLoft(rows: { u: number; w: number; top: number; bottom: number; xo?: number }[]): THREE.BufferGeometry {
  const rings: Ring[] = rows.map((r) => ({
    y: -r.u,
    x: r.w,
    zo: (r.top + r.bottom) / 2,
    zf: (r.top - r.bottom) / 2,
    zb: (r.top - r.bottom) / 2,
    xo: r.xo ?? 0,
  }));
  return loft(rings, 24, 5).rotateX(-Math.PI / 2);
}

const outlineVert = /* glsl */ `
#include <common>
#include <skinning_pars_vertex>
uniform float uThickness;
uniform vec2 uResolution;
void main() {
  #include <beginnormal_vertex>
  #include <skinbase_vertex>
  #include <skinnormal_vertex>
  #include <begin_vertex>
  #include <skinning_vertex>
  vec4 clip = projectionMatrix * modelViewMatrix * vec4(transformed, 1.0);
  vec3 n = normalize(normalMatrix * objectNormal);
  vec2 dir = (projectionMatrix * vec4(n, 0.0)).xy;
  float len = length(dir);
  if (len > 1e-5) clip.xy += dir / len * uThickness / uResolution * 2.0 * clip.w;
  gl_Position = clip;
}`;
const outlineFrag = /* glsl */ `
uniform vec3 uColor;
void main() { gl_FragColor = vec4(uColor, 1.0); }`;

interface Segment {
  from: string;
  to: string | THREE.Vector3;
  at: number;
  mass: number;
}

export class Figure {
  readonly group = new THREE.Group();
  bones: Record<string, THREE.Object3D> = {};
  rest: Record<string, THREE.Quaternion> = {};
  meshes: THREE.Mesh[] = [];
  private skinned: THREE.SkinnedMesh[] = [];
  /** When set, build the realistic MakeHuman body instead of the mannequin. */
  realistic: RealisticAsset | null = null;
  /** Half-width of the hips, which the top of each thigh fills out to. */
  private hipOuter = 0;
  guides: THREE.Mesh[] = [];
  P!: Proportions;

  style: RenderStyle = 'shaded';
  outline = true;
  readonly outlineMat = new THREE.ShaderMaterial({
    uniforms: {
      uThickness: { value: 2 },
      uResolution: { value: new THREE.Vector2(1000, 1000) },
      uColor: { value: new THREE.Color('#1d1d22') },
    },
    vertexShader: outlineVert,
    fragmentShader: outlineFrag,
    side: THREE.BackSide,
  });
  readonly guideMat = new THREE.MeshBasicMaterial({ color: '#5b6170' });
  private materials = new Map<string, THREE.Material>();
  highlighted: string | null = null;
  private toonRamp: THREE.DataTexture;
  private segments: Segment[] = [];
  private contacts: { bone: string; p: THREE.Vector3 }[] = [];

  constructor() {
    const ramp = new Uint8Array([90, 90, 90, 255, 170, 170, 170, 255, 255, 255, 255, 255]);
    this.toonRamp = new THREE.DataTexture(ramp, 3, 1, THREE.RGBAFormat);
    this.toonRamp.minFilter = THREE.NearestFilter;
    this.toonRamp.magFilter = THREE.NearestFilter;
    this.toonRamp.needsUpdate = true;
  }

  // ---------------------------------------------------------------- materials

  private makeMaterial(): THREE.Material {
    switch (this.style) {
      case 'toon':
        return new THREE.MeshToonMaterial({ color: BASE_COLOR, gradientMap: this.toonRamp });
      case 'lines':
        return new THREE.MeshBasicMaterial({ color: '#ffffff' });
      default:
        return new THREE.MeshStandardMaterial({ color: BASE_COLOR, roughness: 0.82, metalness: 0 });
    }
  }

  private mat(control: string): THREE.Material {
    let m = this.materials.get(control);
    if (!m) {
      m = this.makeMaterial();
      this.materials.set(control, m);
    }
    return m;
  }

  setStyle(style: RenderStyle) {
    this.style = style;
    for (const m of this.materials.values()) m.dispose();
    this.materials.clear();
    for (const mesh of this.meshes) {
      const groups = mesh.userData.groupControls as string[] | undefined;
      mesh.material = groups ? groups.map((c) => this.mat(c)) : this.mat(mesh.userData.control);
    }
    const hl = this.highlighted;
    this.highlighted = null;
    this.setHighlight(hl);
  }

  setHighlight(control: string | null) {
    const paint = (id: string, on: boolean) => {
      const m = this.materials.get(id);
      if (!m) return;
      if (m instanceof THREE.MeshBasicMaterial) {
        m.color.set(on ? '#dbe4ff' : '#ffffff');
      } else if (m instanceof THREE.MeshStandardMaterial || m instanceof THREE.MeshToonMaterial) {
        m.emissive.copy(HIGHLIGHT);
        m.emissiveIntensity = on ? 0.35 : 0;
      }
    };
    if (this.highlighted) paint(this.highlighted, false);
    this.highlighted = control;
    if (control) paint(control, true);
  }

  setOutline(on: boolean) {
    this.outline = on;
    for (const mesh of this.meshes) for (const c of mesh.children) c.visible = on;
  }

  setGuidesVisible(on: boolean) {
    for (const g of this.guides) g.visible = on;
  }

  // ---------------------------------------------------------------- building

  private bone(name: string, parent: THREE.Object3D, x: number, y: number, z: number, rest?: THREE.Quaternion) {
    const b = new THREE.Bone();
    b.name = name;
    b.position.set(x, y, z);
    parent.add(b);
    this.bones[name] = b;
    this.rest[name] = rest ?? new THREE.Quaternion();
    b.quaternion.copy(this.rest[name]);
    return b;
  }

  /** Add a body mesh to a bone. Small surface details skip the outline so they don't draw stray contour lines. */
  private part(bone: THREE.Object3D, geo: THREE.BufferGeometry, control: string, outline = true) {
    const mesh = new THREE.Mesh(geo, this.mat(control));
    mesh.userData.control = control;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    if (outline) {
      const hull = new THREE.Mesh(geo, this.outlineMat);
      hull.visible = this.outline;
      hull.raycast = () => {};
      mesh.add(hull);
    }
    bone.add(mesh);
    this.meshes.push(mesh);
    return mesh;
  }

  private clear() {
    for (const mesh of this.meshes) mesh.geometry.dispose();
    for (const g of this.guides) g.geometry.dispose();
    this.meshes = [];
    this.skinned = [];
    this.guides = [];
    this.bones = {};
    this.rest = {};
    this.segments = [];
    this.contacts = [];
    this.group.clear();
  }

  build(P: Proportions) {
    this.clear();
    this.P = P;
    if (this.realistic) {
      this.buildRealistic(P, this.realistic);
      return;
    }

    // ---- skeleton -------------------------------------------------------
    const root = this.bone('pelvis', this.group, 0, P.rootY, 0);
    const lumbar = this.bone('lumbar', root, 0, P.lumbarY - P.rootY, 0);
    const chest = this.bone('chest', lumbar, 0, P.chestY - P.lumbarY, 0);
    const neck = this.bone('neck', chest, 0, P.neckY - P.chestY, P.neckZ);
    const head = this.bone('head', neck, 0, P.headY - P.neckY, P.headZ - P.neckZ);

    const hy = P.hipY - P.rootY;
    const sY = P.shoulderY - P.chestY;

    const headMesh = this.buildHead(head);

    // ---- arms ---------------------------------------------------------------
    for (const side of SIDES) this.buildArm(side, chest, sY);

    // ---- legs ---------------------------------------------------------------
    this.hipOuter = this.hipWidth();
    for (const side of SIDES) this.buildLeg(side, root, hy);

    // ---- torso: one skinned surface from crotch to skull --------------------
    // Built last because its lower edge is also skinned to the hip bones.
    this.buildTrunk();

    this.buildGuides(headMesh);
    this.buildBalanceModel();
    this.group.updateMatrixWorld(true);
  }

  /**
   * Pelvis, belly, ribcage and neck as a single lofted surface skinned to the spine
   * bones. Bending blends smoothly across each joint, so there are no rigid pieces
   * whose edges poke out of the back or form ledges at the waist.
   */
  /** Half-width of the hips: wide enough to sheath the tops of the thighs. */
  private hipWidth() {
    const P = this.P;
    return Math.max(P.hipX, P.hipJointHalf + P.thighR * 1.12);
  }

  private buildTrunk() {
    const P = this.P;
    const { H } = P;
    const hipX = this.hipOuter;
    // Deep enough in front to carry the belly.
    const belly = P.waistZ * (1.05 + 0.35 * P.fat + 0.12 * P.c);
    const upperBelly = lerp(belly, P.waistZ, 0.6);
    // Heavy builds can have a waist wider than the lower ribs; never let the ribcage pinch in.
    const ribX = Math.max(P.chestX * 0.96, P.waistX * 1.04);
    // A heavy belly fills out toward the ribcage instead of sitting as a recessed band.
    const bellyX = lerp(P.waistX, Math.max(P.waistX, ribX * 0.98), P.fat);
    const tc = P.neckY - P.chestY;
    const waistY = P.lumbarY + (P.chestY - P.lumbarY) * 0.45;
    const nTop = P.headY - P.neckY;
    // Trapezius: from the flat top of the shoulder it rises in a concave curve into
    // the side of the neck (shallow near the shoulder, steep near the neck).
    const trap = (t: number, dy: number): Ring => ({
      y: P.shoulderY + dy * H,
      x: lerp(P.shW * 0.84, P.neckR, t),
      zf: lerp(P.chestZ * 0.5, P.neckR, t),
      zb: lerp(P.chestZ * 0.8, P.neckR * 1.1, t),
      zo: lerp(-0.12 * P.chestZ, P.neckZ, t),
    });

    const rings: Ring[] = [
      // Below the hip joints the pelvis tucks inside the tops of the thighs and the
      // buttocks round under in an arc rather than tapering to a wedge.
      { y: P.hipY - 0.058 * H, x: P.hipJointHalf * 0.55, zf: P.hipZ * 0.2, zb: P.hipZ * 0.3 },
      { y: P.hipY - 0.05 * H, x: hipX * 0.5, zf: P.hipZ * 0.42, zb: P.hipZ * 0.62 },
      { y: P.hipY - 0.038 * H, x: hipX * 0.72, zf: P.hipZ * 0.6, zb: P.hipZ * 0.82 },
      { y: P.hipY - 0.022 * H, x: hipX * 0.9, zf: P.hipZ * 0.74, zb: P.hipZ * 0.93 },
      { y: P.hipY, x: hipX, zf: P.hipZ * 0.85, zb: P.hipZ * 0.98 },
      {
        y: P.hipY + 0.05 * H,
        x: lerp(hipX, bellyX, 0.35),
        zf: Math.max(P.hipZ * 0.85, lerp(P.hipZ * 0.85, belly, 0.6)),
        zb: lerp(P.hipZ * 0.98, P.waistZ * 0.9, 0.4),
      },
      { y: waistY, x: bellyX, zf: belly, zb: P.waistZ * 0.85 },
      { y: P.chestY - 0.01 * H, x: Math.max(bellyX, P.waistX * 1.02), zf: Math.max(P.waistZ * 0.98, upperBelly), zb: P.waistZ * 0.88 },
      { y: P.chestY + 0.3 * tc, x: ribX, zf: Math.max(P.chestZ, upperBelly * 0.98), zb: P.chestZ * 0.95 },
      { y: P.chestY + 0.6 * tc, x: P.chestX, zf: P.chestZ * 1.08, zb: P.chestZ },
      { y: P.chestY + 0.8 * tc, x: P.chestX * 1.02, zf: P.chestZ, zb: P.chestZ },
      { y: P.shoulderY - 0.01 * H, x: P.shW * 0.9, zf: P.chestZ * 0.68, zb: P.chestZ * 0.9, zo: -0.08 * P.chestZ },
      trap(0, 0.002),
      trap(0.4, 0.009),
      trap(0.72, 0.018),
      { y: P.neckY + 0.012 * H, x: P.neckR * 1.12, zf: P.neckR, zb: P.neckR * 1.06, zo: P.neckZ },
      { y: P.neckY + nTop * 0.45, x: P.neckR, zf: P.neckR * 0.95, zb: P.neckR, zo: lerp(P.neckZ, P.headZ, 0.45) },
      { y: P.headY, x: P.neckR * 0.95, zf: P.neckR * 0.9, zb: P.neckR, zo: P.headZ },
      { y: P.headY + 0.03 * H, x: P.neckR * 0.6, zf: P.neckR * 0.6, zb: P.neckR * 0.6, zo: P.headZ },
    ];
    const geo = loft(rings, 64, 8);
    this.sculptChest(geo, tc, P.chestY);
    this.sculptGlutes(geo, hipX);

    // Skin weights: a smooth partition of unity between consecutive spine bones.
    // The neck blend starts above the shoulder line so head turns don't drag the
    // tops of the shoulders around.
    const bones = ['pelvis', 'lumbar', 'chest', 'neck', 'head', 'hip_L', 'hip_R'];
    const boneControl = ['body', 'waist', 'chest', 'head', 'head', 'body', 'body'];
    const joints: [number, number][] = [
      [P.lumbarY, 0.04 * H],
      [P.chestY, 0.04 * H],
      [P.neckY + 0.012 * H, 0.016 * H],
      [P.headY, 0.015 * H],
    ];
    const pos = geo.getAttribute('position');
    const skinIndex = new Uint16Array(pos.count * 4);
    const skinWeight = new Float32Array(pos.count * 4);
    const dominant = new Uint8Array(pos.count);
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i);
      const r = joints.map(([j, w]) => smoothstep(j - w, j + w, y));
      const w = [1 - r[0], r[0] - r[1], r[1] - r[2], r[2] - r[3], r[3], 0, 0].map((v) => Math.max(0, v));
      // Below the hip joints the skin partly follows the thighs, so the buttocks and
      // groin roll with a bending hip instead of leaving a wedge behind it.
      const hipW = 0.42 * smoothstep(P.hipY + 0.01 * H, P.hipY - 0.055 * H, y);
      if (hipW > 0) {
        const left = smoothstep(-0.3 * hipX, 0.3 * hipX, pos.getX(i));
        w[0] *= 1 - hipW;
        w[5] = hipW * left;
        w[6] = hipW * (1 - left);
      }
      const order = [0, 1, 2, 3, 4, 5, 6].sort((a, b) => w[b] - w[a]).slice(0, 4);
      const total = order.reduce((t, k) => t + w[k], 0);
      order.forEach((k, n) => {
        skinIndex[i * 4 + n] = k;
        skinWeight[i * 4 + n] = w[k] / total;
      });
      dominant[i] = order[0];
    }
    geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndex, 4));
    geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeight, 4));

    this.addSkinned(geo, bones, boneControl, dominant);
  }

  /**
   * Add a skinned mesh bound to the named bones in their current pose. Triangles
   * are grouped by the pose control of their dominant bone, so tapping and
   * highlighting still work per body region on a single continuous surface.
   */
  private addSkinned(geo: THREE.BufferGeometry, bones: string[], boneControl: string[], dominant: ArrayLike<number>) {
    const controls = [...new Set(boneControl)];
    const index = geo.getIndex()!.array;
    const buckets: number[][] = controls.map(() => []);
    for (let t = 0; t < index.length; t += 3) {
      const c = boneControl[dominant[index[t]]];
      buckets[controls.indexOf(c)].push(index[t], index[t + 1], index[t + 2]);
    }
    geo.setIndex(buckets.flat());
    geo.clearGroups();
    let start = 0;
    buckets.forEach((b, k) => {
      geo.addGroup(start, b.length, k);
      start += b.length;
    });

    this.group.updateMatrixWorld(true);
    const skeleton = new THREE.Skeleton(bones.map((n) => this.bones[n] as THREE.Bone));
    const mesh = new THREE.SkinnedMesh(
      geo,
      controls.map((c) => this.mat(c)),
    );
    mesh.userData.control = boneControl[0];
    mesh.userData.groupControls = controls;
    mesh.userData.vertexControl = Array.from(dominant, (d) => boneControl[d]);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    this.group.add(mesh);
    mesh.bind(skeleton);
    const hull = new THREE.SkinnedMesh(geo, this.outlineMat);
    hull.visible = this.outline;
    hull.frustumCulled = false;
    hull.raycast = () => {};
    mesh.add(hull);
    hull.bind(skeleton, mesh.bindMatrix);
    this.meshes.push(mesh);
    this.skinned.push(mesh, hull);
    return mesh;
  }

  /**
   * The realistic body: morph MakeHuman's mesh to the body sliders, fit our
   * skeleton to its joints, and bind the skin with the bones posed like the
   * modelled A-pose. Afterwards the bones return to our rest pose, so every
   * pose, preset and drag works exactly as on the mannequin.
   */
  private buildRealistic(P: Proportions, asset: RealisticAsset) {
    const pos = morph(asset, P.params);
    placeMesh(asset, pos, P.H);
    const J = jointCentres(asset, pos);
    // Measured joint heights replace the mannequin's estimates; drag handles, the
    // floor rules and the balance model read them.
    const mid = (a: THREE.Vector3, b: THREE.Vector3) => (a.y + b.y) / 2;
    Object.assign(P, {
      rootY: J.pelvis.y,
      hipY: mid(J.hip_L, J.hip_R),
      lumbarY: J.lumbar.y,
      chestY: J.chest.y,
      neckY: J.neck.y,
      headY: J.head.y,
      shoulderY: mid(J.shoulder_L, J.shoulder_R) + 0.022 * P.H,
      ankleY: mid(J.ankle_L, J.ankle_R),
      hipJointHalf: (J.hip_L.x - J.hip_R.x) / 2,
      ua: J.shoulder_L.distanceTo(J.elbow_L),
      fa: J.elbow_L.distanceTo(J.wrist_L),
      thigh: J.hip_L.distanceTo(J.knee_L),
      shank: J.knee_L.distanceTo(J.ankle_L),
    });

    const fits = fitSkeleton(J);
    for (const f of fits) this.bone(f.name, f.parent ? this.bones[f.parent] : this.group, f.offset.x, f.offset.y, f.offset.z, f.rest);

    const n = asset.meta.bodyVertexCount;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos.slice(0, n * 3), 3));
    geo.setIndex(new THREE.BufferAttribute(asset.indices.slice(), 1));
    geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(Uint16Array.from(asset.skinIndex.subarray(0, n * 4)), 4));
    geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(Float32Array.from(asset.skinWeight.subarray(0, n * 4), (w) => w / 255), 4));
    geo.computeVertexNormals();
    const dominant = new Uint8Array(n);
    for (let i = 0; i < n; i++) dominant[i] = asset.skinIndex[i * 4];

    // Bind with the bones posed like the mesh, then return them to rest.
    for (const f of fits) this.bones[f.name].quaternion.copy(f.bind);
    this.addSkinned(geo, asset.meta.bones, asset.meta.bones.map(controlOfBone), dominant);
    for (const f of fits) this.bones[f.name].quaternion.copy(this.rest[f.name]);

    // MakeHuman's eyes are separate meshes; simple eyeballs stand in for them.
    for (const side of ['L', 'R'] as const) {
      const eye = eyeball(asset, pos, side);
      const c = eye.centre.sub(J.head);
      this.part(this.bones.head, ellipsoid(eye.radius, eye.radius, eye.radius, c.x, c.y, c.z, 20), 'head', false);
    }
    this.buildBalanceModel();
    this.group.updateMatrixWorld(true);
  }

  /** Buttocks shaped into the back of the pelvis, with a cleft and a fold underneath. */
  private sculptGlutes(geo: THREE.BufferGeometry, hipX: number) {
    const P = this.P;
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    const amp = P.hipZ * (0.15 + 0.06 * P.fem + 0.06 * P.mu + 0.04 * P.fat);
    const cy = P.hipY;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      if (z >= 0 || y > P.hipY + 0.1 * P.H) continue;
      let g = 0;
      for (const s of [1, -1]) {
        const dx = (x - s * hipX * 0.42) / (hipX * 0.46);
        const dy = (y - cy) / (y < cy ? 0.04 * P.H : 0.065 * P.H);
        const r2 = dx * dx + dy * dy;
        g = Math.max(g, amp * Math.exp(-r2 * (0.6 + 0.4 * r2)));
      }
      pos.setZ(i, z - g * smoothstep(0, P.hipZ * 0.5, -z));
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
  }

  /**
   * Push the front of the ribcage out into breasts and pectorals. Both are part of the
   * chest surface and scale continuously with the body sliders, so they grow and fade
   * smoothly instead of popping in as separate shapes.
   */
  private sculptChest(geo: THREE.BufferGeometry, tc: number, chestY: number) {
    const P = this.P;
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    const b = P.breast;
    const pecA = P.chestZ * 0.16 * P.pec;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i) - chestY;
      const z = pos.getZ(i);
      if (z <= 0 || y < -0.3 * tc || y > 1.2 * tc) continue;
      let breast = 0;
      let pec = 0;
      for (const s of [1, -1]) {
        if (b > 0) {
          // Footprint is sized to the ribcage, not the bust, so small sizes are a gentle
          // swell rather than a point. Rounder below the nipple line, longer slope above.
          const dx = (x - s * P.chestX * 0.46) / (P.chestX * 0.52);
          const dy = (y - 0.52 * tc) / (y < 0.52 * tc ? P.chestX * 0.4 : P.chestX * 0.68);
          breast = Math.max(breast, b * 0.85 * Math.exp(-1.3 * (dx * dx + dy * dy)));
        }
        // Broad flat plate with a crisp lower edge; max() keeps a groove at the sternum.
        const dx = (x - s * P.chestX * 0.4) / (P.chestX * 0.5);
        const dy = (y - 0.7 * tc) / (y < 0.7 * tc ? 0.13 * tc : 0.28 * tc);
        const r2 = dx * dx + dy * dy;
        pec = Math.max(pec, pecA * Math.exp(-r2 * r2));
      }
      pos.setZ(i, z + (breast + pec) * smoothstep(0, P.chestZ * 0.6, z));
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
  }

  private buildHead(head: THREE.Object3D): THREE.Mesh {
    const P = this.P;
    const h = P.hh;
    const B = P.headB / 2;
    const L = P.headL;
    const chin = P.H - P.hh - P.headY;
    // Children have a larger cranium and a smaller, lower face.
    const k = 1 - 0.18 * P.c;
    const fy = (t: number) => (t <= 0.55 ? t * k : 0.55 * k + ((t - 0.55) * (1 - 0.55 * k)) / 0.45);
    const jaw = 1 + 0.08 * (P.mas - P.fem) - 0.06 * P.c;
    // [height from chin, half-width, front, back] as fractions of head height/breadth/length.
    const rows: [number, number, number, number][] = [
      [0.0, 0.12, 0.4, 0.2],
      [0.06, 0.32 * jaw, 0.44, -0.04],
      [0.15, 0.58 * jaw, 0.47, -0.2],
      [0.3, 0.74, 0.5, -0.36],
      [0.45, 0.9, 0.52, -0.46],
      [0.55, 0.97, 0.52, -0.49],
      [0.7, 1.0, 0.5, -0.5],
      [0.85, 0.9, 0.4, -0.47],
      [0.95, 0.58, 0.22, -0.33],
      [1.0, 0.1, 0.04, -0.08],
    ];
    const shift = 0.06 * L;
    const rings: Ring[] = rows.map(([t, w, f, b]) => ({
      y: chin + fy(t) * h,
      x: w * B,
      zo: ((f + b) / 2) * L + shift,
      zf: ((f - b) / 2) * L,
      zb: ((f - b) / 2) * L,
    }));
    const mesh = this.part(head, loft(rings, 32, 6), 'head');
    // Nose and ears give the head a readable facing direction.
    const noseY = chin + fy(0.39) * h;
    this.part(head, ellipsoid(0.15 * B, 0.09 * h, 0.06 * L, 0, noseY, 0.5 * L + shift + 0.012 * L, 16), 'head', false);
    for (const s of [1, -1]) {
      this.part(head, ellipsoid(0.07 * B, 0.13 * h, 0.08 * L, s * B * 0.98, chin + fy(0.45) * h, -0.04 * L + shift, 16), 'head');
    }
    return mesh;
  }

  /** Thin tubes traced on the head surface: centre line and eye line, for drawing construction. */
  private buildGuides(headMesh: THREE.Mesh) {
    const P = this.P;
    const ray = new THREE.Raycaster();
    const temp = new THREE.Mesh(headMesh.geometry);
    temp.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromBufferAttribute(headMesh.geometry.getAttribute('position') as THREE.BufferAttribute);
    const ctr = box.getCenter(new THREE.Vector3());
    const hit = (origin: THREE.Vector3, target: THREE.Vector3) => {
      ray.set(origin, target.clone().sub(origin).normalize());
      const r = ray.intersectObject(temp, false)[0];
      return r ? r.point.clone().addScaledVector(origin.clone().sub(target).normalize(), 0.0015 * P.H) : null;
    };
    const k = 1 - 0.18 * P.c;
    const eyeY = P.H - P.hh - P.headY + 0.5 * k * P.hh;
    const far = P.hh * 2;

    const eye: THREE.Vector3[] = [];
    for (let a = -95; a <= 95; a += 5) {
      const r = (a * Math.PI) / 180;
      const p = hit(new THREE.Vector3(Math.sin(r) * far, eyeY, ctr.z + Math.cos(r) * far), new THREE.Vector3(0, eyeY, ctr.z));
      if (p) eye.push(p);
    }
    const mid: THREE.Vector3[] = [];
    for (let a = -100; a <= 80; a += 5) {
      const r = (a * Math.PI) / 180;
      const p = hit(new THREE.Vector3(0, ctr.y + Math.sin(r) * far, ctr.z + Math.cos(r) * far), ctr);
      if (p) mid.push(p);
    }
    const tubeR = 0.0035 * P.hh;
    for (const pts of [eye, mid]) {
      if (pts.length < 3) continue;
      const geo = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), pts.length * 3, tubeR, 6, false);
      const g = new THREE.Mesh(geo, this.guideMat);
      g.userData.control = 'head';
      headMesh.parent!.add(g);
      this.guides.push(g);
    }
  }

  private buildArm(side: Side, chest: THREE.Object3D, sY: number) {
    const P = this.P;
    const { H } = P;
    const s = sgn(side);
    const S = (n: string) => `${n}_${side}`;
    // The shoulder joint sits about 2% of height below the top of the shoulder (acromion).
    const clav = this.bone(S('clav'), chest, s * 0.012 * H, sY - 0.012 * H, P.chestZ * 0.6);
    const sh = this.bone(S('shoulder'), clav, s * (P.shW - 0.012 * H), -0.01 * H, -P.chestZ * 0.6 - 0.004 * H);
    const elbow = this.bone(S('elbow'), sh, 0, -P.ua, 0);
    const wrist = this.bone(S('wrist'), elbow, 0, -P.fa, 0);
    const r = P.armR;
    const fr = P.forearmR;
    const wr = P.wristR;

    // Deltoid cap: rides on the humerus, its top level with the top of the shoulder.
    // It is the tap target for the shoulder girdle.
    this.part(sh, ellipsoid(r * 1.15, r * 1.28, r * 1.2, s * 0.006 * H, -0.007 * H, 0), S('shoulder'));
    this.part(
      sh,
      loft([
        // The top end stays tucked inside the deltoid cap.
        { y: -0.004 * H, x: r * 0.62, zf: r * 0.62, zb: r * 0.62 },
        { y: -0.15 * P.ua, x: r * 1.08, zf: r * 1.05, zb: r * 1.05 },
        { y: -0.45 * P.ua, x: r * 0.95, zf: r * (1.05 + 0.1 * P.mu), zb: r * 0.95 },
        { y: -0.8 * P.ua, x: r * 0.84, zf: r * 0.8, zb: r * 0.86 },
        { y: -P.ua, x: r * 0.74, zf: r * 0.7, zb: r * 0.8 },
        { y: -P.ua - 0.01 * H, x: r * 0.5, zf: r * 0.45, zb: r * 0.5 },
      ]),
      S('arm'),
    );
    this.part(elbow, ellipsoid(r * 0.74, r * 0.74, r * 0.76), S('forearm'));
    this.part(
      elbow,
      loft([
        { y: 0.01 * H, x: fr * 0.8, zf: fr * 0.85, zb: fr * 0.9 },
        { y: -0.2 * P.fa, x: fr, zf: fr * 1.05, zb: fr },
        { y: -0.6 * P.fa, x: lerp(fr, wr, 0.6) * 0.85, zf: lerp(fr, wr * 1.15, 0.6), zb: lerp(fr, wr * 1.15, 0.6) },
        { y: -P.fa, x: wr * 0.7, zf: wr * 1.15, zb: wr * 1.15 },
        { y: -P.fa - 0.008 * H, x: wr * 0.5, zf: wr * 0.8, zb: wr * 0.8 },
      ]),
      S('forearm'),
    );
    this.part(wrist, ellipsoid(wr * 0.72, wr * 0.85, wr * 1.05), S('hand'));
    this.buildHand(side, wrist);
  }

  private buildHand(side: Side, wrist: THREE.Object3D) {
    const P = this.P;
    const s = sgn(side);
    const S = (n: string) => `${n}_${side}`;
    const hb = P.handB;
    const palmL = 0.45 * P.hl;
    const tx = 0.16 * hb;
    const ctl = S('hand');
    this.part(
      wrist,
      loft([
        { y: 0.004 * P.H, x: tx * 0.85, zf: hb * 0.36, zb: hb * 0.36 },
        { y: -0.35 * palmL, x: tx, zf: hb * 0.5, zb: hb * 0.46 },
        { y: -0.85 * palmL, x: tx * 0.95, zf: hb * 0.52, zb: hb * 0.48 },
        { y: -palmL, x: tx * 0.75, zf: hb * 0.46, zb: hb * 0.42 },
      ]),
      ctl,
    );

    // Fingers: index (thumb side, +Z) to little.
    const mid = 0.55 * P.hl;
    const lens = [0.92, 1, 0.95, 0.76].map((f) => f * mid);
    const zs = [0.36, 0.12, -0.12, -0.35].map((f) => f * hb);
    const ys = [-0.92, -0.95, -0.92, -0.85].map((f) => f * palmL);
    const rads = [0.1, 0.104, 0.098, 0.085].map((f) => f * hb);
    const split = [0.45, 0.3, 0.25];
    for (let i = 0; i < 4; i++) {
      let parent: THREE.Object3D = wrist;
      let y = ys[i];
      let z = zs[i];
      for (let k = 0; k < 3; k++) {
        const b = this.bone(S(`f${i}${k}`), parent, 0, y, z);
        const len = lens[i] * split[k];
        this.part(b, phalanx(rads[i] * (1 - 0.08 * k), len - rads[i] * 0.6), ctl);
        parent = b;
        y = -len;
        z = 0;
      }
    }

    // Thumb: base at the palm's thumb side near the wrist, angled forward.
    const rest = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.42, 0, -s * 0.28, 'XYZ'));
    let parent = this.bone(S('thumb0'), wrist, -s * tx * 0.25, -0.06 * palmL, 0.24 * hb, rest);
    const tl = [0.25, 0.17, 0.13].map((f) => f * P.hl);
    const tr = [0.19, 0.115, 0.1].map((f) => f * hb);
    this.part(parent, phalanx(tr[0], tl[0]), ctl);
    for (let k = 1; k < 3; k++) {
      parent = this.bone(S(`thumb${k}`), parent, 0, -tl[k - 1], 0);
      this.part(parent, phalanx(tr[k], tl[k] - tr[k] * 0.6), ctl);
    }
  }

  private buildLeg(side: Side, root: THREE.Object3D, hy: number) {
    const P = this.P;
    const { H } = P;
    const s = sgn(side);
    const S = (n: string) => `${n}_${side}`;
    const hip = this.bone(S('hip'), root, s * P.hipJointHalf, hy, 0);
    // Joints sit exactly on each bone's axis so the leg IK solves without residual error.
    const knee = this.bone(S('knee'), hip, 0, -P.thigh, 0);
    const ankle = this.bone(S('ankle'), knee, 0, -P.shank, 0);
    const a = P.ankleY;
    const fl = P.footL;
    const fw = P.footW;
    const toe = this.bone(S('toe'), ankle, -s * 0.06 * fw, -a * 0.72, 0.47 * fl);
    const tr = P.thighR;
    const kr = P.kneeR;
    const cr = P.calfR;
    const ar = P.ankleR;

    // Where the pelvis is wider than the thigh (wide or heavy hips), the upper thigh fills
    // out to meet it instead of the hips flaring over the legs like a skirt.
    const fill = Math.max(0, this.hipOuter * 0.98 - P.hipJointHalf - tr * 1.05);
    // Heavy builds carry the extra mass at the back and outside of the upper thigh.
    const full = 1 + 0.25 * P.fat;
    this.part(
      hip,
      loft([
        // The top end stays tucked inside the hips, which narrow above the hip joint.
        { y: 0.065 * H, x: tr * 0.35, zf: tr * 0.35, zb: tr * 0.4 },
        { y: 0.04 * H, x: tr * 0.68 + fill * 0.3, zf: tr * 0.65, zb: tr * 0.72, xo: s * (tr * 0.06 + fill * 0.3) },
        { y: -0.05 * P.thigh, x: tr * (1 + 0.1 * P.fat) + fill * 0.5, zf: tr * 0.95, zb: tr * full, xo: s * (tr * 0.18 + fill * 0.5) },
        { y: -0.35 * P.thigh, x: tr * 0.9 + fill * 0.15, zf: tr * 0.92, zb: tr * 0.88 * (1 + 0.12 * P.fat), xo: s * (tr * 0.08 + fill * 0.15) },
        { y: -0.75 * P.thigh, x: tr * 0.7, zf: tr * 0.72, zb: tr * 0.62 },
        { y: -P.thigh, x: kr, zf: kr * 0.95, zb: kr * 0.9 },
        { y: -P.thigh - 0.012 * H, x: kr * 0.7, zf: kr * 0.6, zb: kr * 0.6 },
      ]),
      S('thigh'),
    );
    this.part(knee, ellipsoid(kr * 0.96, kr * 0.96, kr * 0.96), S('shin'));
    this.part(knee, ellipsoid(kr * 0.55, kr * 0.65, kr * 0.35, 0, 0.004 * H, kr * 0.72, 16), S('shin'), false);
    this.part(
      knee,
      loft([
        { y: 0.015 * H, x: kr * 0.9, zf: kr * 0.85, zb: kr * 0.85 },
        { y: -0.25 * P.shank, x: cr * 0.9, zf: cr * 0.72, zb: cr * 1.15, zo: -cr * 0.1 },
        { y: -0.45 * P.shank, x: cr * 0.82, zf: cr * 0.66, zb: cr * 0.95, zo: -cr * 0.05 },
        { y: -0.8 * P.shank, x: ar * 1.05, zf: ar * 0.9, zb: ar },
        { y: -P.shank, x: ar, zf: ar * 0.9, zb: ar * 0.95 },
        { y: -P.shank - 0.01 * H, x: ar * 0.6, zf: ar * 0.5, zb: ar * 0.5 },
      ]),
      S('shin'),
    );
    this.part(ankle, ellipsoid(ar * 1.05, ar * 0.95, ar * 0.95), S('foot'));
    const xm = -s * 0.05 * fw;
    this.part(
      ankle,
      forwardLoft([
        { u: -0.255 * fl, w: 0.14 * fw, top: -0.6 * a, bottom: -0.92 * a },
        { u: -0.2 * fl, w: 0.32 * fw, top: 0.1 * a, bottom: -a },
        { u: -0.05 * fl, w: 0.36 * fw, top: 0.25 * a, bottom: -a },
        { u: 0.15 * fl, w: 0.42 * fw, top: 0.0, bottom: -a, xo: xm * 0.5 },
        { u: 0.35 * fl, w: 0.48 * fw, top: -0.42 * a, bottom: -a, xo: xm },
        { u: 0.48 * fl, w: 0.5 * fw, top: -0.55 * a, bottom: -a, xo: xm },
        { u: 0.52 * fl, w: 0.4 * fw, top: -0.6 * a, bottom: -0.95 * a, xo: xm },
      ]),
      S('foot'),
    );
    const ta = a * 0.28; // toe joint height above the floor
    this.part(
      toe,
      forwardLoft([
        { u: -0.03 * fl, w: 0.46 * fw, top: ta * 0.6, bottom: -ta },
        { u: 0.08 * fl, w: 0.5 * fw, top: ta * 0.5, bottom: -ta, xo: -s * 0.02 * fw },
        { u: 0.2 * fl, w: 0.44 * fw, top: ta * 0.25, bottom: -ta, xo: -s * 0.05 * fw },
        { u: 0.27 * fl, w: 0.3 * fw, top: 0, bottom: -ta * 0.9, xo: -s * 0.1 * fw },
        { u: 0.29 * fl, w: 0.15 * fw, top: -ta * 0.3, bottom: -ta * 0.7, xo: -s * 0.12 * fw },
      ]),
      S('foot'),
    );
  }

  // ---------------------------------------------------------------- balance

  private buildBalanceModel() {
    const P = this.P;
    const head = 0.081 + 0.06 * P.c;
    const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
    this.segments = [
      { from: 'head', to: V(0, 0.2 * P.hh, 0.03 * P.hh), at: 1, mass: head },
      { from: 'chest', to: 'neck', at: 0.5, mass: 0.216 },
      { from: 'lumbar', to: 'chest', at: 0.5, mass: 0.139 },
      { from: 'pelvis', to: 'lumbar', at: 0.3, mass: 0.142 },
    ];
    this.contacts = [];
    for (const side of SIDES) {
      const S = (n: string) => `${n}_${side}`;
      this.segments.push(
        { from: S('shoulder'), to: S('elbow'), at: 0.44, mass: 0.028 },
        { from: S('elbow'), to: S('wrist'), at: 0.43, mass: 0.016 },
        { from: S('wrist'), to: S('f10'), at: 0.5, mass: 0.006 },
        { from: S('hip'), to: S('knee'), at: 0.43, mass: 0.1 },
        { from: S('knee'), to: S('ankle'), at: 0.43, mass: 0.0465 },
        { from: S('ankle'), to: S('toe'), at: 0.5, mass: 0.0145 },
      );
      const a = P.ankleY;
      const fl = P.footL;
      const fw = P.footW;
      const s = sgn(side);
      this.contacts.push(
        { bone: S('ankle'), p: V(0.25 * fw, -a, -0.2 * fl) },
        { bone: S('ankle'), p: V(-0.25 * fw, -a, -0.2 * fl) },
        { bone: S('ankle'), p: V(0.45 * fw - s * 0.05 * fw, -a, 0.45 * fl) },
        { bone: S('ankle'), p: V(-0.45 * fw - s * 0.05 * fw, -a, 0.45 * fl) },
        { bone: S('toe'), p: V(-s * 0.1 * fw, -0.28 * a, 0.28 * fl) },
        { bone: S('knee'), p: V(0, 0, P.kneeR * 1.05) },
        // Front of the shin and top of the foot, for kneeling and sitting on the heels.
        { bone: S('knee'), p: V(0, -0.5 * P.shank, P.calfR * 0.7) },
        { bone: S('ankle'), p: V(0, -0.2 * a, 0.3 * fl) },
        { bone: S('f12'), p: V(0, -0.15 * P.hl, 0) },
        { bone: S('elbow'), p: V(0, 0, -P.armR * 0.8) },
      );
    }
    this.contacts.push(
      { bone: 'pelvis', p: V(P.hipX * 0.42, P.hipY - P.rootY - 0.05 * P.H, -P.hipZ * 0.5) },
      { bone: 'pelvis', p: V(-P.hipX * 0.42, P.hipY - P.rootY - 0.05 * P.H, -P.hipZ * 0.5) },
    );
    const total = this.segments.reduce((t, sg) => t + sg.mass, 0);
    for (const sg of this.segments) sg.mass /= total;
  }

  /** Whole-body centre of mass and the floor contact points, in world space. */
  balance(floorY: number, tolerance: number) {
    const com = new THREE.Vector3();
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    for (const sg of this.segments) {
      this.bones[sg.from].getWorldPosition(a);
      if (typeof sg.to === 'string') this.bones[sg.to].getWorldPosition(b);
      else b.copy(sg.to).applyMatrix4(this.bones[sg.from].matrixWorld);
      com.addScaledVector(a.lerp(b, sg.at), sg.mass);
    }
    const touching: THREE.Vector3[] = [];
    for (const c of this.contacts) {
      const w = c.p.clone().applyMatrix4(this.bones[c.bone].matrixWorld);
      if (w.y < floorY + tolerance) touching.push(w);
    }
    return { com, touching };
  }

  /**
   * Where the body touches the floor: floor-plane (x, z) positions of surface
   * vertices within `tolerance` of y = 0. Sampled every `stride` vertices.
   */
  floorContacts(tolerance: number, stride = 3): THREE.Vector2[] {
    const out: THREE.Vector2[] = [];
    const v = new THREE.Vector3();
    for (const mesh of this.meshes) {
      const pos = mesh.geometry.getAttribute('position');
      const skinned = mesh instanceof THREE.SkinnedMesh ? mesh : null;
      if (!skinned) {
        if (!mesh.geometry.boundingSphere) mesh.geometry.computeBoundingSphere();
        const sphere = mesh.geometry.boundingSphere!;
        if (v.copy(sphere.center).applyMatrix4(mesh.matrixWorld).y - sphere.radius > tolerance) continue;
      }
      for (let i = 0; i < pos.count; i += stride) {
        v.fromBufferAttribute(pos, i);
        if (skinned) skinned.applyBoneTransform(i, v);
        v.applyMatrix4(mesh.matrixWorld);
        if (v.y < tolerance) out.push(new THREE.Vector2(v.x, v.z));
      }
    }
    return out;
  }

  /** Skinned meshes cache their posed bounds; refresh after every pose change (picking, framing). */
  refreshBounds() {
    // Outline hulls share their mesh's geometry and skeleton, so copy instead of recomputing.
    for (const m of this.skinned) {
      if (m.parent instanceof THREE.SkinnedMesh && m.parent.geometry === m.geometry) continue;
      m.computeBoundingBox();
      m.computeBoundingSphere();
      for (const c of m.children) {
        if (c instanceof THREE.SkinnedMesh) {
          c.boundingBox = m.boundingBox!.clone();
          c.boundingSphere = m.boundingSphere!.clone();
        }
      }
    }
  }

  /**
   * Lowest point of the body surface in world space (for standing it on the floor),
   * optionally for some controls only. Rigid parts are visited lowest-first by
   * bounding sphere and skipped once they can't beat the current minimum.
   */
  lowestPoint(only?: (control: string) => boolean, stride = 2): number {
    let min = Infinity;
    const v = new THREE.Vector3();
    const rigid: { mesh: THREE.Mesh; bottom: number }[] = [];
    for (const mesh of this.meshes) {
      const perVertex = mesh.userData.vertexControl as string[] | undefined;
      if (only && !perVertex && !only(mesh.userData.control)) continue;
      const pos = mesh.geometry.getAttribute('position');
      if (mesh instanceof THREE.SkinnedMesh) {
        for (let i = 0; i < pos.count; i += stride) {
          if (only && perVertex && !only(perVertex[i])) continue;
          v.fromBufferAttribute(pos, i);
          mesh.applyBoneTransform(i, v);
          v.applyMatrix4(mesh.matrixWorld);
          if (v.y < min) min = v.y;
        }
        continue;
      }
      if (!mesh.geometry.boundingSphere) mesh.geometry.computeBoundingSphere();
      const sphere = mesh.geometry.boundingSphere!;
      rigid.push({ mesh, bottom: v.copy(sphere.center).applyMatrix4(mesh.matrixWorld).y - sphere.radius });
    }
    rigid.sort((a, b) => a.bottom - b.bottom);
    for (const { mesh, bottom } of rigid) {
      if (bottom >= min) break;
      const pos = mesh.geometry.getAttribute('position');
      for (let i = 0; i < pos.count; i += stride) {
        v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
        if (v.y < min) min = v.y;
      }
    }
    return min;
  }
}
