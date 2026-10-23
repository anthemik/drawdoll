import * as THREE from 'three';
import { Figure, Side, SIDES, sgn } from './figure';
import { DEG, clamp, interp, smoothstep } from './math';

export type Unit = 'deg' | 'pct' | 'len';

export interface Dof {
  id: string;
  label: string;
  min: number;
  max: number;
  def: number;
  lo: string;
  hi: string;
  unit?: Unit;
}

export type PadKind = 'shoulder' | 'hip';

export interface ControlDef {
  id: string;
  base: string;
  label: string;
  side?: Side;
  dofs: Dof[];
  /** Ball joints get a direction pad driving the `fwd` and `out` dofs. */
  pad?: PadKind;
}

export type Pose = Record<string, Record<string, number>>;

const d = (id: string, label: string, min: number, max: number, lo: string, hi: string, def = 0, unit?: Unit): Dof => ({
  id, label, min, max, def, lo, hi, unit,
});

const CENTER: Omit<ControlDef, 'id'>[] = [
  {
    base: 'body',
    label: 'Whole body',
    dofs: [
      d('turn', 'Turn', -180, 180, 'Left', 'Right'),
      d('lean', 'Lean', -90, 90, 'Back', 'Forward'),
      d('tilt', 'Tilt', -90, 90, 'Left', 'Right'),
      d('lift', 'Lift off floor', 0, 0.6, 'Floor', 'Up', 0, 'len'),
    ],
  },
  {
    base: 'waist',
    label: 'Waist',
    dofs: [
      d('bend', 'Bend', -30, 60, 'Back', 'Forward'),
      d('side', 'Side bend', -30, 30, 'Left', 'Right'),
      d('twist', 'Twist', -35, 35, 'Left', 'Right'),
    ],
  },
  {
    base: 'chest',
    label: 'Chest',
    dofs: [
      d('bend', 'Bend', -25, 40, 'Back', 'Forward'),
      d('side', 'Side bend', -25, 25, 'Left', 'Right'),
      d('twist', 'Twist', -40, 40, 'Left', 'Right'),
    ],
  },
  {
    base: 'head',
    label: 'Head & neck',
    dofs: [
      d('nod', 'Nod', -60, 70, 'Up', 'Down'),
      d('tilt', 'Tilt', -45, 45, 'Left', 'Right'),
      d('turn', 'Turn', -80, 80, 'Left', 'Right'),
    ],
  },
];

const SIDED: Omit<ControlDef, 'id'>[] = [
  {
    base: 'shoulder',
    label: 'Shoulder',
    dofs: [d('shrug', 'Shrug', -10, 40, 'Down', 'Up'), d('reach', 'Reach', -20, 25, 'Back', 'Forward')],
  },
  {
    base: 'arm',
    label: 'Upper arm',
    pad: 'shoulder',
    dofs: [
      d('fwd', 'Raise forward', -70, 180, 'Back', 'Forward'),
      d('out', 'Raise sideways', -45, 180, 'In', 'Out', 8),
      d('twist', 'Twist', -70, 90, 'In', 'Out'),
    ],
  },
  {
    base: 'forearm',
    label: 'Forearm',
    dofs: [d('bend', 'Elbow', -5, 150, 'Straight', 'Bent', 12), d('turn', 'Turn palm', -85, 85, 'Palm down', 'Palm up')],
  },
  {
    base: 'hand',
    label: 'Hand',
    dofs: [
      d('bend', 'Wrist bend', -70, 80, 'Back', 'Palm'),
      d('tilt', 'Wrist tilt', -35, 20, 'Pinky', 'Thumb'),
      d('curl', 'Fingers', -15, 100, 'Open', 'Fist', 25, 'pct'),
      d('spread', 'Spread', 0, 100, 'Together', 'Spread', 15, 'pct'),
      d('thumbOut', 'Thumb out', 0, 100, 'In', 'Out', 30, 'pct'),
      d('thumbCurl', 'Thumb curl', 0, 100, 'Straight', 'Curled', 15, 'pct'),
    ],
  },
  {
    base: 'thigh',
    label: 'Thigh',
    pad: 'hip',
    dofs: [
      d('fwd', 'Raise forward', -30, 130, 'Back', 'Forward'),
      d('out', 'Raise sideways', -30, 90, 'In', 'Out'),
      d('twist', 'Twist', -40, 45, 'In', 'Out'),
    ],
  },
  { base: 'shin', label: 'Knee', dofs: [d('bend', 'Knee', -5, 150, 'Straight', 'Bent')] },
  {
    base: 'foot',
    label: 'Foot',
    dofs: [
      d('point', 'Point', -25, 50, 'Toes up', 'Point'),
      d('roll', 'Roll', -20, 35, 'Out', 'In'),
      d('toes', 'Toes', -60, 40, 'Up', 'Curl'),
    ],
  },
];

export const CONTROLS: ControlDef[] = [
  ...CENTER.map((c) => ({ ...c, id: c.base })),
  ...SIDES.flatMap((side) =>
    SIDED.map((c) => ({ ...c, id: `${c.base}_${side}`, side, label: `${side === 'L' ? 'Left' : 'Right'} ${c.label.toLowerCase()}` })),
  ),
];
export const CONTROL_BY_ID: Record<string, ControlDef> = Object.fromEntries(CONTROLS.map((c) => [c.id, c]));

/** Center-line dofs whose sign flips when a pose is mirrored left↔right. */
const MIRROR_NEGATE: Record<string, string[]> = {
  body: ['turn', 'tilt'],
  waist: ['side', 'twist'],
  chest: ['side', 'twist'],
  head: ['tilt', 'turn'],
};

export function defaultPose(): Pose {
  const pose: Pose = {};
  for (const c of CONTROLS) pose[c.id] = Object.fromEntries(c.dofs.map((dof) => [dof.id, dof.def]));
  return pose;
}

/** Fill in any dofs missing from a partial pose (presets, saved poses). */
export function completePose(partial: Pose): Pose {
  const pose = defaultPose();
  for (const id in partial) if (pose[id]) Object.assign(pose[id], partial[id]);
  return pose;
}

export function mirrorPose(pose: Pose): Pose {
  const out: Pose = {};
  for (const c of CONTROLS) {
    if (c.side) {
      const other = `${c.base}_${c.side === 'L' ? 'R' : 'L'}`;
      out[c.id] = { ...pose[other] };
    } else {
      out[c.id] = { ...pose[c.id] };
      for (const k of MIRROR_NEGATE[c.id] ?? []) out[c.id][k] = -out[c.id][k];
    }
  }
  return out;
}

// ---------------------------------------------------------------- ball-joint reach

// Maximum elevation (degrees away from hanging straight down) for each direction
// of travel: 0 = forward, 90 = out to the side, ±180 = back, -90 = across the body.
const REACH: Record<PadKind, [number, number][]> = {
  shoulder: [
    [-180, 50], [-135, 45], [-100, 40], [-75, 90], [-50, 160], [-25, 180], [0, 180],
    [90, 180], [120, 160], [150, 95], [180, 50],
  ],
  hip: [
    [-180, 25], [-135, 20], [-90, 28], [-60, 60], [-30, 110], [0, 130], [30, 120],
    [60, 80], [90, 55], [120, 40], [150, 30], [180, 25],
  ],
};

export function maxReach(kind: PadKind, azimuthDeg: number): number {
  return interp(REACH[kind], azimuthDeg);
}

export function insideReach(kind: PadKind, fwd: number, out: number): boolean {
  const e = Math.hypot(fwd, out);
  return e <= maxReach(kind, Math.atan2(out, fwd) / DEG) + 1e-6;
}

/** Pull a pad point back onto the reachable region along the line to the centre. */
export function clampReach(kind: PadKind, fwd: number, out: number): [number, number] {
  const e = Math.hypot(fwd, out);
  if (e < 1e-6) return [0, 0];
  const lim = maxReach(kind, Math.atan2(out, fwd) / DEG);
  if (e <= lim) return [fwd, out];
  return [(fwd * lim) / e, (out * lim) / e];
}

/**
 * Slider edits move one axis only, so clamp along that axis rather than radially;
 * otherwise dragging "Raise forward" would also nudge "Raise sideways".
 */
export function clampReachAxis(kind: PadKind, fwd: number, out: number, axis: 'fwd' | 'out', prevFwd: number, prevOut: number) {
  if (insideReach(kind, fwd, out)) return [fwd, out];
  const fixedOk = axis === 'fwd' ? insideReach(kind, prevFwd, out) : insideReach(kind, fwd, prevOut);
  if (!fixedOk) return clampReach(kind, fwd, out);
  let a = axis === 'fwd' ? prevFwd : prevOut;
  let b = axis === 'fwd' ? fwd : out;
  for (let i = 0; i < 24; i++) {
    const m = (a + b) / 2;
    const ok = axis === 'fwd' ? insideReach(kind, m, out) : insideReach(kind, fwd, m);
    if (ok) a = m;
    else b = m;
  }
  return axis === 'fwd' ? [a, out] : [fwd, a];
}

// ---------------------------------------------------------------- applying a pose

const X = new THREE.Vector3(1, 0, 0);
const Y = new THREE.Vector3(0, 1, 0);
const Z = new THREE.Vector3(0, 0, 1);
const rot = (axis: THREE.Vector3, deg: number) => new THREE.Quaternion().setFromAxisAngle(axis, deg * DEG);
/** Intrinsic yaw (Y), then pitch (X), then roll (Z). */
const ypr = (yaw: number, pitch: number, roll: number) => rot(Y, yaw).multiply(rot(X, pitch)).multiply(rot(Z, roll));

/**
 * Point a limb that hangs along -Y in a direction given as pad coordinates:
 * the swing is the shortest arc from straight down, then twist about the bone.
 */
function swingTwist(fwd: number, out: number, twist: number, s: number): THREE.Quaternion {
  const e = Math.hypot(fwd, out);
  const phi = Math.atan2(out, fwd);
  const h = new THREE.Vector3(s * Math.sin(phi), 0, Math.cos(phi));
  const axis = new THREE.Vector3(-h.z, 0, h.x).normalize();
  return new THREE.Quaternion().setFromAxisAngle(axis, e * DEG).multiply(rot(Y, s * twist));
}

function setBone(fig: Figure, name: string, q: THREE.Quaternion) {
  const b = fig.bones[name];
  if (b) b.quaternion.copy(fig.rest[name]).multiply(q);
}

export function applyPose(fig: Figure, pose: Pose, autoGround: boolean) {
  const get = (id: string) => pose[id] ?? {};
  const body = get('body');
  setBone(fig, 'pelvis', ypr(-(body.turn ?? 0), body.lean ?? 0, body.tilt ?? 0));

  const w = get('waist');
  setBone(fig, 'lumbar', ypr(-(w.twist ?? 0), w.bend ?? 0, w.side ?? 0));
  const c = get('chest');
  setBone(fig, 'chest', ypr(-(c.twist ?? 0), c.bend ?? 0, c.side ?? 0));

  // The neck carries most of a head turn; the skull adds the last part of a nod.
  const h = get('head');
  const nod = h.nod ?? 0;
  const tilt = h.tilt ?? 0;
  const turn = h.turn ?? 0;
  setBone(fig, 'neck', ypr(-turn * 0.75, nod * 0.55, tilt * 0.7));
  setBone(fig, 'head', ypr(-turn * 0.25, nod * 0.45, tilt * 0.3));

  for (const side of SIDES) {
    const s = sgn(side);
    const S = (n: string) => `${n}_${side}`;
    const g = (base: string) => get(S(base));

    // Shoulder girdle: the user's shrug plus scapulohumeral rhythm — the
    // collarbone rises as the arm goes overhead and protracts as it reaches forward.
    const arm = g('arm');
    const fwd = arm.fwd ?? 0;
    const out = arm.out ?? 0;
    const elev = Math.hypot(fwd, out);
    const sh = g('shoulder');
    const autoShrug = 22 * smoothstep(40, 180, elev);
    const autoReach = 14 * clamp(fwd / 120, 0, 1) * smoothstep(20, 90, elev) - 10 * clamp(-fwd / 60, 0, 1);
    const clavQ = rot(Y, -s * ((sh.reach ?? 0) + autoReach)).multiply(rot(Z, s * ((sh.shrug ?? 0) + autoShrug)));
    setBone(fig, S('clav'), clavQ);
    // Keep the arm pointing where the pad says, regardless of how the clavicle moved.
    setBone(fig, S('shoulder'), clavQ.clone().invert().multiply(swingTwist(fwd, out, arm.twist ?? 0, s)));

    const fa = g('forearm');
    setBone(fig, S('elbow'), rot(X, -(fa.bend ?? 0)).multiply(rot(Y, s * (fa.turn ?? 0))));

    const hd = g('hand');
    setBone(fig, S('wrist'), rot(Z, -s * (hd.bend ?? 0)).multiply(rot(X, -(hd.tilt ?? 0))));
    const curl = (hd.curl ?? 0) / 100;
    const spread = (hd.spread ?? 0) / 100;
    const knuckle = [90, 100, 75];
    for (let i = 0; i < 4; i++) {
      // Fingers fan out from the middle; the little finger curls a touch more.
      const fan = (1.2 - i * 0.8) * spread * 9 - (i === 3 ? 4 * spread : 0);
      const extra = 1 + i * 0.04;
      for (let k = 0; k < 3; k++) {
        const q = rot(Z, -s * curl * knuckle[k] * extra);
        if (k === 0) q.multiply(rot(X, -fan));
        setBone(fig, S(`f${i}${k}`), q);
      }
    }
    const tOut = (hd.thumbOut ?? 0) / 100;
    const tCurl = (hd.thumbCurl ?? 0) / 100;
    setBone(fig, S('thumb0'), rot(X, -tOut * 45 + 10).multiply(rot(Z, -s * (tCurl * 35 - tOut * 10))));
    setBone(fig, S('thumb1'), rot(Z, -s * tCurl * 45));
    setBone(fig, S('thumb2'), rot(Z, -s * tCurl * 60));

    const th = g('thigh');
    setBone(fig, S('hip'), swingTwist(th.fwd ?? 0, th.out ?? 0, th.twist ?? 0, s));
    setBone(fig, S('knee'), rot(X, g('shin').bend ?? 0));
    const ft = g('foot');
    setBone(fig, S('ankle'), rot(X, ft.point ?? 0).multiply(rot(Z, -s * (ft.roll ?? 0))));
    setBone(fig, S('toe'), rot(X, ft.toes ?? 0));
  }

  const root = fig.bones.pelvis;
  root.position.y = fig.P.rootY;
  fig.group.updateMatrixWorld(true);
  if (autoGround) {
    root.position.y -= fig.lowestPoint();
  }
  root.position.y += (body.lift ?? 0) * fig.P.H;
  fig.group.updateMatrixWorld(true);
  fig.refreshBounds();
}
