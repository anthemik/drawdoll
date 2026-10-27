import * as THREE from 'three';
import { Figure, SIDES, Side } from './figure';
import { CONTROL_BY_ID, Pose, pinKey } from './joints';
import { applyPose, keepHipsOverFeet, makePin } from './ik';

// Gravity: after an edit, keep the doll's centre of mass over what it is standing,
// kneeling or sitting on. Compensation follows the order people use: shift the
// hips over the feet, then counter-lean the trunk, then take a step.

export function hull(points: THREE.Vector2[]): THREE.Vector2[] {
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

function segmentDistance(p: THREE.Vector2, a: THREE.Vector2, b: THREE.Vector2) {
  const ab = b.clone().sub(a);
  const t = ab.lengthSq() > 0 ? THREE.MathUtils.clamp(p.clone().sub(a).dot(ab) / ab.lengthSq(), 0, 1) : 0;
  return a.clone().addScaledVector(ab, t).distanceTo(p);
}

function nearestOnHull(poly: THREE.Vector2[], p: THREE.Vector2) {
  let best = poly[0].clone();
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const ab = poly[(i + 1) % poly.length].clone().sub(a);
    const t = ab.lengthSq() > 0 ? THREE.MathUtils.clamp(p.clone().sub(a).dot(ab) / ab.lengthSq(), 0, 1) : 0;
    const q = a.clone().addScaledVector(ab, t);
    if (q.distanceTo(p) < best.distanceTo(p)) best = q;
  }
  return best;
}

/** Distance from a point to a convex polygon: negative inside (depth), positive outside. */
export function signedDistance(poly: THREE.Vector2[], p: THREE.Vector2): number {
  if (poly.length === 0) return Infinity;
  if (poly.length === 1) return poly[0].distanceTo(p);
  if (poly.length === 2) return segmentDistance(p, poly[0], poly[1]);
  let inside = true;
  let edge = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    if ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x) < 0) inside = false;
    edge = Math.min(edge, segmentDistance(p, a, b));
  }
  return inside ? -edge : edge;
}

export interface Balance {
  /** Centre of mass projected on the floor (x, z). */
  com: THREE.Vector2;
  /** Support polygon: what touches the floor. */
  support: THREE.Vector2[];
  /** How far the centre of mass is outside the support (negative = inside by that much). */
  outside: number;
  /** Anything touching the floor at all (false = airborne). */
  grounded: boolean;
}

export function measureBalance(fig: Figure): Balance {
  const { com } = fig.balance(0, 0);
  // What actually touches the floor, read from the body's surface (soles, knees,
  // shins, buttocks, hands), so it's right for either body and any pose.
  const touching = fig.floorContacts(0.012 * fig.P.H, 7);
  const support = hull(touching);
  const c = new THREE.Vector2(com.x, com.z);
  return { com: c, support, outside: signedDistance(support, c), grounded: touching.length > 0 };
}

const clone = (p: Pose): Pose => JSON.parse(JSON.stringify(p));

function centroid(poly: THREE.Vector2[]) {
  return poly.reduce((c, p) => c.add(p), new THREE.Vector2()).divideScalar(poly.length);
}

/**
 * Work out a balanced version of `pose`, or null when it already balances (or is
 * airborne). `edited` is the control the user just changed; compensation avoids
 * undoing that edit and leans on other parts of the body first.
 */
export function findBalance(fig: Figure, pose: Pose, autoGround: boolean, edited: string | null): Pose | null {
  const H = fig.P.H;
  const margin = 0.012 * H;
  applyPose(fig, pose, autoGround, false);
  const start = measureBalance(fig);
  // An airborne pose (a jump, levitation) is left as posed.
  if (!start.grounded || start.support.length === 0 || start.outside <= 0) return null;

  let work = clone(pose);
  // 1. A whole body tipped over (lean/tilt) lands back toward upright, just far
  //    enough to stand: find the smallest reduction that balances.
  const lean = work.body.lean;
  const tilt = work.body.tilt;
  if (Math.abs(lean) + Math.abs(tilt) > 1) {
    const at = (k: number) => {
      work.body.lean = lean * k;
      work.body.tilt = tilt * k;
      applyPose(fig, work, autoGround, false);
      return measureBalance(fig);
    };
    if (at(0).outside <= -margin) {
      let lo = 0;
      let hi = 1;
      for (let i = 0; i < 7; i++) {
        const mid = (lo + hi) / 2;
        if (at(mid).outside <= -margin) lo = mid;
        else hi = mid;
      }
      at(lo);
      applyPose(fig, work, autoGround);
      return work;
    }
    at(1);
  }

  // 2. Otherwise plant the grounded feet and hold the hips in place, so moving the
  //    hips bends the legs rather than sliding the whole doll.
  work = clone(pose);
  const tempPins: string[] = [];
  const planted = SIDES.filter((side) => footOnFloor(fig, side));
  for (const side of planted) {
    const key = pinKey('leg', side);
    if (!work[key]) {
      work[key] = makePin(fig, 'leg', side);
      tempPins.push(key);
    }
  }
  const wasFixed = !!work.root.fixed;
  if (!wasFixed) {
    const r = fig.bones.pelvis.getWorldPosition(new THREE.Vector3());
    r.y -= (work.body.lift ?? 0) * H;
    work.root = { x: r.x, y: r.y, z: r.z, fixed: 1 };
  }
  const feetReached = () =>
    tempPins.every((key) => {
      const pin = work[key];
      const side = key.slice(-1) as Side;
      return fig.bones[`ankle_${side}`].getWorldPosition(new THREE.Vector3()).distanceTo(new THREE.Vector3(pin.x, pin.y, pin.z)) < 0.012 * H;
    });
  // While searching, skip the floor pass (it's the expensive part); the final
  // pose is re-applied with it.
  const evaluate = () => {
    applyPose(fig, work, false, false);
    return measureBalance(fig);
  };

  // What may move to restore balance, and how much each costs per unit. The hips
  // are cheapest (shift the weight over the feet), then the trunk. A spine bend
  // the user just made costs more, so it's kept where possible.
  interface Var {
    get(): number;
    set(v: number): void;
    weight: number;
    probe: number;
    /** Largest change per round, so the linear estimate can't overshoot. */
    cap: number;
    min: number;
    max: number;
  }
  const dofVar = (ctl: string, dof: string, scale: number): Var => {
    const d = CONTROL_BY_ID[ctl].dofs.find((x) => x.id === dof)!;
    return {
      get: () => work[ctl][dof],
      set: (v) => (work[ctl][dof] = v),
      weight: (ctl === edited ? 10 : 1) / scale ** 2,
      probe: 3,
      cap: 10,
      min: d.min,
      max: d.max,
    };
  };
  const hipLimit = 0.1 * H;
  const r0 = { x: work.root.x, z: work.root.z };
  const rootVar = (k: 'x' | 'z'): Var => ({
    get: () => work.root[k],
    set: (v) => (work.root[k] = v),
    weight: 1 / (0.035 * H) ** 2,
    probe: 0.01 * H,
    cap: 0.03 * H,
    min: r0[k] - hipLimit,
    max: r0[k] + hipLimit,
  });
  const vars: Var[] = [
    rootVar('x'),
    rootVar('z'),
    dofVar('waist', 'bend', 10),
    dofVar('waist', 'side', 10),
    dofVar('chest', 'bend', 10),
    dofVar('chest', 'side', 10),
  ];

  /**
   * Weighted least-change correction: estimate how each variable moves the centre
   * of mass, then take the smallest weighted step that moves it the required
   * distance toward the middle of the support. A few rounds absorb nonlinearity.
   */
  const correct = (rounds: number) => {
    let m = evaluate();
    for (let round = 0; round < rounds && m.outside > -margin; round++) {
      const need = centroid(m.support).sub(m.com);
      if (need.lengthSq() < 1e-10) break;
      need.setLength(m.outside + margin);
      const cols = vars.map((v) => {
        const old = v.get();
        const h = old + v.probe <= v.max ? v.probe : -v.probe;
        v.set(old + h);
        const moved = evaluate().com.sub(m.com).divideScalar(h);
        v.set(old);
        return moved;
      });
      // Δ = W⁻¹Jᵀ (J W⁻¹ Jᵀ + λI)⁻¹ need, with J the 2×n effect matrix.
      let a = 1e-9;
      let b = 0;
      let d = 1e-9;
      cols.forEach((c, i) => {
        const wi = 1 / vars[i].weight;
        a += wi * c.x * c.x;
        b += wi * c.x * c.y;
        d += wi * c.y * c.y;
      });
      const det = a * d - b * b;
      const ux = (d * need.x - b * need.y) / det;
      const uy = (a * need.y - b * need.x) / det;
      const before = vars.map((v) => v.get());
      vars.forEach((v, i) => {
        const delta = THREE.MathUtils.clamp((cols[i].x * ux + cols[i].y * uy) / v.weight, -v.cap, v.cap);
        v.set(THREE.MathUtils.clamp(v.get() + delta, v.min, v.max));
      });
      m = evaluate();
      if (!feetReached()) {
        // The legs can't follow: take half the step and stop here.
        vars.forEach((v, i) => v.set((before[i] + v.get()) / 2));
        m = evaluate();
        break;
      }
    }
    return m;
  };
  let m = correct(6);

  // Step: one foot steps to just beyond the centre of mass in the direction of
  // the fall (a stride of at most ~45% of height). Each foot keeps to its own
  // side, so a sideways fall is caught by the leading foot stepping out rather
  // than the legs crossing; the shorter of the two strides wins. Only with both
  // feet down: on one leg, moving the standing foot would be a hop.
  if (m.outside > -margin && tempPins.length === 2) {
    const fall = m.com.clone().sub(centroid(m.support)).normalize();
    const lat3 = new THREE.Vector3(1, 0, 0).applyQuaternion(fig.bones.pelvis.getWorldQuaternion(new THREE.Quaternion()));
    const lat = new THREE.Vector2(lat3.x, lat3.z).normalize();
    const steps = tempPins.map((key) => {
      const other = work[tempPins.find((k) => k !== key)!];
      const from = new THREE.Vector2(work[key].x, work[key].z);
      const to = m.com.clone().addScaledVector(fall, 0.05 * H);
      const side = key.endsWith('L') ? 1 : -1;
      const apart = to.clone().sub(new THREE.Vector2(other.x, other.z)).dot(lat) * side;
      if (apart < 0.08 * H) to.addScaledVector(lat, (0.08 * H - apart) * side);
      const stride = to.sub(from);
      if (stride.length() > 0.45 * H) stride.setLength(0.45 * H);
      return { key, from, stride };
    });
    const step = steps.sort((p, q) => p.stride.length() - q.stride.length())[0];
    const pin = work[step.key];
    pin.x = step.from.x + step.stride.x;
    pin.z = step.from.y + step.stride.y;
    m = correct(3);
  }

  // Settle onto the floor with the feet still planted, then release them.
  applyPose(fig, work, autoGround, false);

  for (const key of tempPins) delete work[key];
  if (!wasFixed) work.root.fixed = 0;
  applyPose(fig, work, autoGround);
  return work;
}

/**
 * Move the hips (the pose's fixed root) so the weight is over what's on the floor:
 * `onto` puts the weight over that foot (it must be on the floor); without
 * it the hips move only as far as needed to bring the weight inside the support.
 * Planted feet must be pinned so they stay put. Leaves the figure posed.
 */
export function shiftWeight(fig: Figure, pose: Pose, onto?: Side) {
  const H = fig.P.H;
  const margin = 0.02 * H;
  for (let i = 0; i < 6; i++) {
    keepHipsOverFeet(fig, pose);
    applyPose(fig, pose, false, false);
    const { com: c3 } = fig.balance(0, 0);
    const com = new THREE.Vector2(c3.x, c3.z);
    let need: THREE.Vector2;
    if (onto) {
      // Over the foot's midline, a little ahead of the ankle, as people balance on
      // one leg: weight already in that range stays where it is fore and aft.
      const ankle = fig.bones[`ankle_${onto}`];
      const a3 = ankle.getWorldPosition(new THREE.Vector3());
      const f3 = new THREE.Vector3(0, 0, 1).applyQuaternion(ankle.getWorldQuaternion(new THREE.Quaternion()));
      const a = new THREE.Vector2(a3.x, a3.z);
      const fwd = new THREE.Vector2(f3.x, f3.z).normalize();
      const along = THREE.MathUtils.clamp(com.clone().sub(a).dot(fwd), 0.01 * H, 0.05 * H);
      need = a.addScaledVector(fwd, along).sub(com);
      if (need.length() < 0.003 * H) break;
    } else {
      const touching = fig.floorContacts(0.012 * H, 7);
      if (touching.length === 0) break;
      const support = hull(touching);
      if (signedDistance(support, com) <= -margin * 0.5) break;
      // The shortest way in: to the nearest edge of the support, then a margin inside.
      const edge = nearestOnHull(support, com);
      need = edge.clone().sub(com).add(centroid(support).sub(edge).setLength(margin));
    }
    pose.root.x += need.x;
    pose.root.z += need.y;
  }
  keepHipsOverFeet(fig, pose);
  applyPose(fig, pose, false, false);
}

/** Is this foot resting on the floor (a contact point near it within a couple of cm)? */
export function footOnFloor(fig: Figure, side: Side) {
  const { touching } = fig.balance(0, 0.012 * fig.P.H);
  const ankle = fig.bones[`ankle_${side}`].getWorldPosition(new THREE.Vector3());
  return touching.some((p) => p.distanceTo(ankle) < fig.P.footL);
}

/** Blend two poses (dofs and hip position) for the landing animation. */
export function blendPose(a: Pose, b: Pose, t: number): Pose {
  const out = clone(b);
  for (const [id, dofs] of Object.entries(b)) {
    if (!a[id]) continue;
    for (const k of Object.keys(dofs)) {
      if (typeof a[id][k] === 'number' && typeof b[id][k] === 'number') out[id][k] = a[id][k] + (b[id][k] - a[id][k]) * t;
    }
  }
  return out;
}
