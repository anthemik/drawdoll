import * as THREE from 'three';
import { FigureParams } from './proportions';
import { DEG, clamp } from './math';

// The realistic body: MakeHuman's CC0 base mesh, shape targets and skin weights,
// converted by tools/build_realistic.py into public/realistic/body.{json,bin}.

interface Meta {
  vertexCount: number;
  bodyVertexCount: number;
  indexType: 'uint16' | 'uint32';
  deltaScale: number;
  targets: string[];
  bones: string[];
  joints: Record<string, number[]>;
  eyes: Record<'L' | 'R', number[]>;
  sections: Record<string, [number, number]>;
}

export interface RealisticAsset {
  meta: Meta;
  positions: Float32Array;
  indices: Uint16Array | Uint32Array;
  skinIndex: Uint8Array;
  skinWeight: Uint8Array;
  targets: Map<string, { idx: Uint16Array | Uint32Array; delta: Int16Array }>;
}

let pending: Promise<RealisticAsset> | null = null;

export function loadRealisticAsset(): Promise<RealisticAsset> {
  pending ??= (async () => {
    const [meta, bin] = await Promise.all([
      fetch('realistic/body.json').then((r) => r.json() as Promise<Meta>),
      fetch('realistic/body.bin').then((r) => r.arrayBuffer()),
    ]);
    const view = <T>(Ctor: new (b: ArrayBuffer, o: number, n: number) => T, name: string) => {
      const [offset, count] = meta.sections[name];
      return new Ctor(bin, offset, count);
    };
    const indexView = (name: string) => (meta.indexType === 'uint16' ? view(Uint16Array, name) : view(Uint32Array, name));
    const targets = new Map<string, { idx: Uint16Array | Uint32Array; delta: Int16Array }>();
    for (const t of meta.targets) targets.set(t, { idx: indexView(`${t}:idx`), delta: view(Int16Array, `${t}:delta`) });
    return {
      meta,
      positions: view(Float32Array, 'positions'),
      indices: indexView('indices'),
      skinIndex: view(Uint8Array, 'skinIndex'),
      skinWeight: view(Uint8Array, 'skinWeight'),
      targets,
    };
  })();
  pending.catch(() => (pending = null));
  return pending;
}

// ---------------------------------------------------------------- shape blending

/** MakeHuman's age slider: 0 = 1 year, 0.1875 = 11 years, 0.5 = 25 years. */
function mhAge(years: number) {
  if (years < 11) return (Math.max(1, years) - 1) / 10 * 0.1875;
  if (years < 25) return 0.1875 + ((years - 11) / 14) * 0.3125;
  return 0.5;
}

/** Our muscle/build sliders put "average" at 0.3; MakeHuman puts it at 0.5. */
const mhLevel = (x: number) => (x < 0.3 ? (x / 0.3) * 0.5 : 0.5 + ((x - 0.3) / 0.7) * 0.5);

function levelWeights(t: number): Record<string, number> {
  t = clamp(t, 0, 1);
  return t < 0.5 ? { min: 1 - 2 * t, average: 2 * t } : { average: 2 - 2 * t, max: 2 * t - 1 };
}

function ageWeights(v: number): Record<string, number> {
  if (v <= 0.1875) {
    const t = v / 0.1875;
    return { baby: 1 - t, child: t };
  }
  const t = clamp((v - 0.1875) / 0.3125, 0, 1);
  return { child: 1 - t, young: t };
}

/** How much of each shape target to apply, following MakeHuman's macro modifiers. */
export function targetWeights(fp: FigureParams): Map<string, number> {
  const sex: Record<string, number> = { female: 1 - fp.sex, male: fp.sex };
  const age = ageWeights(mhAge(fp.age));
  const muscle = levelWeights(mhLevel(fp.muscle));
  const weight = levelWeights(mhLevel(fp.build));
  const out = new Map<string, number>();
  for (const [s, ws] of Object.entries(sex)) {
    for (const [a, wa] of Object.entries(age)) {
      if (ws * wa === 0) continue;
      out.set(`race-${s}-${a}`, ws * wa);
      for (const [m, wm] of Object.entries(muscle)) {
        for (const [w, ww] of Object.entries(weight)) {
          const k = ws * wa * wm * ww;
          if (k > 0) out.set(`universal-${s}-${a}-${m}muscle-${w}weight`, k);
        }
      }
    }
  }
  return out;
}

/** Base mesh plus weighted shape targets, in MakeHuman units. */
export function morph(asset: RealisticAsset, fp: FigureParams): Float32Array {
  const pos = asset.positions.slice();
  const s = asset.meta.deltaScale;
  for (const [name, w] of targetWeights(fp)) {
    const t = asset.targets.get(name);
    if (!t) continue;
    const k = w * s;
    for (let n = 0; n < t.idx.length; n++) {
      const i = t.idx[n] * 3;
      pos[i] += t.delta[n * 3] * k;
      pos[i + 1] += t.delta[n * 3 + 1] * k;
      pos[i + 2] += t.delta[n * 3 + 2] * k;
    }
  }
  return pos;
}

/** Scale and place the morphed mesh: given stature, feet on y = 0, pelvis centred on x/z. */
export function placeMesh(asset: RealisticAsset, pos: Float32Array, stature: number) {
  const n = asset.meta.bodyVertexCount;
  let ymin = Infinity;
  let ymax = -Infinity;
  for (let i = 0; i < n; i++) {
    const y = pos[i * 3 + 1];
    if (y < ymin) ymin = y;
    if (y > ymax) ymax = y;
  }
  const scale = stature / (ymax - ymin);
  const pelvis = centre(asset, pos, asset.meta.joints.pelvis);
  for (let i = 0; i < pos.length; i += 3) {
    pos[i] = (pos[i] - pelvis.x) * scale;
    pos[i + 1] = (pos[i + 1] - ymin) * scale;
    pos[i + 2] = (pos[i + 2] - pelvis.z) * scale;
  }
}

function centre(asset: RealisticAsset, pos: Float32Array, verts: number[]) {
  const c = new THREE.Vector3();
  for (const i of verts) c.add(new THREE.Vector3(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]));
  return c.divideScalar(verts.length);
}

export function jointCentres(asset: RealisticAsset, pos: Float32Array): Record<string, THREE.Vector3> {
  const out: Record<string, THREE.Vector3> = {};
  for (const [name, verts] of Object.entries(asset.meta.joints)) out[name] = centre(asset, pos, verts);
  return out;
}

/** Centre and radius of an eyeball from its helper vertices. */
export function eyeball(asset: RealisticAsset, pos: Float32Array, side: 'L' | 'R') {
  const verts = asset.meta.eyes[side];
  const c = centre(asset, pos, verts);
  let r = 0;
  for (const i of verts) r = Math.max(r, c.distanceTo(new THREE.Vector3(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2])));
  return { centre: c, radius: r };
}

// ---------------------------------------------------------------- fitting the skeleton

export interface BoneFit {
  name: string;
  parent: string | null;
  /** Offset from the parent in the parent's rest frame (arms hanging, legs straight). */
  offset: THREE.Vector3;
  /** Rest rotation relative to the parent (identity except the thumb's natural angle). */
  rest: THREE.Quaternion;
  /** Rotation relative to the parent that reproduces the mesh's modelled A-pose. */
  bind: THREE.Quaternion;
}

/** Rotation whose local +Y axis points along `y` and local +Z as close as possible to `z`. */
function frame(y: THREE.Vector3, z: THREE.Vector3): THREE.Quaternion {
  const Y = y.clone().normalize();
  let Z = z.clone().addScaledVector(Y, -z.dot(Y));
  if (Z.lengthSq() < 1e-8) Z = new THREE.Vector3(0, 0, 1).addScaledVector(Y, -Y.z);
  Z.normalize();
  const X = new THREE.Vector3().crossVectors(Y, Z);
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(X, Y, Z));
}

/**
 * Fit DrawDoll's skeleton to the mesh's joint centres. Our rest pose has limbs
 * hanging along -Y with palms facing the body and thumbs forward; the mesh is
 * modelled in an A-pose. For each bone this finds its rest-frame offset and the
 * rotation that poses it like the mesh, so the skin can be bound in the A-pose
 * while every joint angle keeps the same meaning as on the mannequin.
 */
export function fitSkeleton(J: Record<string, THREE.Vector3>): BoneFit[] {
  const W = new Map<string, THREE.Quaternion>();
  const bones: BoneFit[] = [];
  const I = () => new THREE.Quaternion();
  const fwd = new THREE.Vector3(0, 0, 1);
  const add = (name: string, parent: string | null, offset: THREE.Vector3, world: THREE.Quaternion, rest = I()) => {
    const pw = parent ? W.get(parent)! : I();
    W.set(name, world);
    bones.push({ name, parent, offset, rest, bind: pw.clone().invert().multiply(world) });
  };
  /** Offset of a joint from its parent joint, in the parent's bind frame. */
  const rel = (parent: string, child: THREE.Vector3, parentPos: THREE.Vector3) =>
    child.clone().sub(parentPos).applyQuaternion(W.get(parent)!.clone().invert());
  const along = (a: THREE.Vector3, b: THREE.Vector3) => new THREE.Vector3(0, -a.distanceTo(b), 0);
  const dir = (a: THREE.Vector3, b: THREE.Vector3) => b.clone().sub(a).normalize();

  add('pelvis', null, J.pelvis.clone(), I());
  add('lumbar', 'pelvis', J.lumbar.clone().sub(J.pelvis), I());
  add('chest', 'lumbar', J.chest.clone().sub(J.lumbar), I());
  add('neck', 'chest', J.neck.clone().sub(J.chest), I());
  add('head', 'neck', J.head.clone().sub(J.neck), I());

  for (const s of ['L', 'R']) {
    const j = (n: string) => J[`${n}_${s}`];
    const b = (n: string) => `${n}_${s}`;

    // Arm. The upper arm's +Z is the direction the elbow bends the forearm toward;
    // the forearm and hand put the thumb side on +Z.
    add(b('clav'), 'chest', j('clav').clone().sub(J.chest), I());
    const dU = dir(j('shoulder'), j('elbow'));
    const dF = dir(j('elbow'), j('wrist'));
    const dH = dir(j('wrist'), j('f10'));
    const thumbSide = j('f00').clone().sub(j('f30'));
    add(b('shoulder'), b('clav'), j('shoulder').clone().sub(j('clav')), frame(dU.clone().negate(), dF.clone().addScaledVector(dU, -dF.dot(dU))));
    add(b('elbow'), b('shoulder'), along(j('shoulder'), j('elbow')), frame(dF.clone().negate(), thumbSide));
    add(b('wrist'), b('elbow'), along(j('elbow'), j('wrist')), frame(dH.clone().negate(), thumbSide));
    const handZ = new THREE.Vector3(0, 0, 1).applyQuaternion(W.get(b('wrist'))!);
    for (let i = 0; i < 4; i++) {
      const pts = [j(`f${i}0`), j(`f${i}1`), j(`f${i}2`), J[`f${i}tip_${s}`]];
      for (let k = 0; k < 3; k++) {
        const parent = k === 0 ? b('wrist') : b(`f${i}${k - 1}`);
        const offset = k === 0 ? rel(b('wrist'), pts[0], j('wrist')) : along(pts[k - 1], pts[k]);
        add(b(`f${i}${k}`), parent, offset, frame(dir(pts[k], pts[k + 1]).negate(), handZ));
      }
    }
    const thumb = [j('thumb0'), j('thumb1'), j('thumb2'), J[`thumbTip_${s}`]];
    const seg = [0, 1, 2].map((k) => dir(thumb[k], thumb[k + 1]));
    const sgnS = s === 'L' ? 1 : -1;
    for (let k = 0; k < 3; k++) {
      const parent = k === 0 ? b('wrist') : b(`thumb${k - 1}`);
      const offset = k === 0 ? rel(b('wrist'), thumb[0], j('wrist')) : along(thumb[k - 1], thumb[k]);
      // The thumb curls the way its modelled shape already bends (toward the index
      // finger and palm), not along the fingers' curl axis: the curl rotation turns
      // a bone's -Y toward its -sign·X, so put the bend direction there.
      const next = seg[Math.min(k + 1, 2)];
      const bend = next.clone().addScaledVector(seg[k], -next.dot(seg[k]));
      const Y = seg[k].clone().negate();
      const world =
        bend.lengthSq() > 1e-6
          ? frame(Y, bend.normalize().multiplyScalar(-sgnS).cross(Y))
          : frame(Y, handZ);
      // The thumb keeps its modelled curve at rest, with its base swung 25° away from
      // the palm: the modelled thumb reaches across the palm, which reads as jutting
      // into the thigh once the arm hangs. (Fingers rest straight; the curl slider
      // bends them.)
      const local = W.get(parent)!.clone().invert().multiply(world);
      const away = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), sgnS * 25 * DEG);
      const rest = k === 0 ? away.multiply(local) : local;
      add(b(`thumb${k}`), parent, offset, world, rest);
    }

    // Leg: knees point forward (+Z), the foot faces along its toes.
    add(b('hip'), 'pelvis', j('hip').clone().sub(J.pelvis), frame(dir(j('knee'), j('hip')), fwd));
    add(b('knee'), b('hip'), along(j('hip'), j('knee')), frame(dir(j('ankle'), j('knee')), fwd));
    const toes = j('toe').clone().sub(j('ankle'));
    toes.y = 0;
    add(b('ankle'), b('knee'), along(j('knee'), j('ankle')), frame(new THREE.Vector3(0, 1, 0), toes));
    add(b('toe'), b('ankle'), rel(b('ankle'), j('toe'), j('ankle')), W.get(b('ankle'))!.clone());
  }
  return bones;
}
