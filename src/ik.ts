import * as THREE from 'three';
import { Figure, Side, sgn } from './figure';
import { CONTROL_BY_ID, Limb, PIN_KEYS, Pose, applyFK, clampReach, pinKey, rot, supportFilter, swingTwist } from './joints';
import { DEG, clamp } from './math';

// Two-bone inverse kinematics for arms and legs. The solver never moves bones
// directly: it works out the same dof values the sliders use (pad direction,
// twist, elbow/knee bend, ankle angles) and writes them into the pose, so joint
// limits, undo and the panel all keep working unchanged.

interface LimbNames {
  root: string;
  mid: string;
  end: string;
  frame: string;
  upper: string;
  lower: string;
  effector: string;
}

export function limbNames(limb: Limb, side: Side): LimbNames {
  return limb === 'arm'
    ? { root: `shoulder_${side}`, mid: `elbow_${side}`, end: `wrist_${side}`, frame: 'chest', upper: `arm_${side}`, lower: `forearm_${side}`, effector: `hand_${side}` }
    : { root: `hip_${side}`, mid: `knee_${side}`, end: `ankle_${side}`, frame: 'pelvis', upper: `thigh_${side}`, lower: `shin_${side}`, effector: `foot_${side}` };
}

const worldPos = (o: THREE.Object3D) => o.getWorldPosition(new THREE.Vector3());
const worldQuat = (o: THREE.Object3D) => o.getWorldQuaternion(new THREE.Quaternion());

/** Component of `v` perpendicular to unit vector `u`, normalised (null if `v` is parallel to `u`). */
function perpendicular(v: THREE.Vector3, u: THREE.Vector3): THREE.Vector3 | null {
  const p = v.clone().addScaledVector(u, -v.dot(u));
  return p.lengthSq() < 1e-10 ? null : p.normalize();
}

export function endPosition(fig: Figure, limb: Limb, side: Side) {
  return worldPos(fig.bones[limbNames(limb, side).end]);
}

export function endQuaternion(fig: Figure, limb: Limb, side: Side) {
  return worldQuat(fig.bones[limbNames(limb, side).end]);
}

/** Direction the elbow/knee currently points, perpendicular to the root→end line. */
function currentPole(fig: Figure, limb: Limb, side: Side): THREE.Vector3 | null {
  const n = limbNames(limb, side);
  const S = worldPos(fig.bones[n.root]);
  const E = worldPos(fig.bones[n.mid]);
  const W = worldPos(fig.bones[n.end]);
  const u = W.clone().sub(S);
  if (u.lengthSq() < 1e-10) return null;
  return perpendicular(E.sub(S), u.normalize());
}

/**
 * Reference frame for the elbow/knee direction around the root→end axis:
 * angle 0 is elbow pointing down (arms) or knee pointing forward (legs),
 * positive angles swing it outward, away from the body.
 */
function swivelBasis(fig: Figure, limb: Limb, side: Side, u: THREE.Vector3) {
  const frame = worldQuat(fig.bones[limbNames(limb, side).frame]);
  const ref = (limb === 'arm' ? new THREE.Vector3(0, -1, 0) : new THREE.Vector3(0, 0, 1)).applyQuaternion(frame);
  const alt = (limb === 'arm' ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(0, -1, 0)).applyQuaternion(frame);
  const r = perpendicular(ref, u) ?? perpendicular(alt, u)!;
  const lateral = new THREE.Vector3(sgn(side), 0, 0).applyQuaternion(frame);
  const l = perpendicular(lateral.addScaledVector(r, -lateral.dot(r)), u) ?? new THREE.Vector3().crossVectors(u, r).normalize();
  return { r, l };
}

export function getSwivel(fig: Figure, limb: Limb, side: Side): number {
  const n = limbNames(limb, side);
  const u = worldPos(fig.bones[n.end]).sub(worldPos(fig.bones[n.root])).normalize();
  const p = currentPole(fig, limb, side);
  if (!p) return 0;
  const { r, l } = swivelBasis(fig, limb, side, u);
  return Math.atan2(p.dot(l), p.dot(r)) / DEG;
}

function poleFromSwivel(fig: Figure, limb: Limb, side: Side, target: THREE.Vector3, angle: number) {
  const S = worldPos(fig.bones[limbNames(limb, side).root]);
  const u = target.clone().sub(S).normalize();
  const { r, l } = swivelBasis(fig, limb, side, u);
  return r.multiplyScalar(Math.cos(angle * DEG)).addScaledVector(l, Math.sin(angle * DEG));
}

interface LimbSolution {
  fwd: number;
  out: number;
  twist: number;
  bend: number;
}

/**
 * Write the dofs that put the limb's end (wrist or ankle) at `target`, with the
 * elbow/knee bending toward `pole`. Joint limits are applied afterwards, so a
 * target out of reach leaves the limb stretched toward it as far as it can go.
 * If the requested elbow/knee direction would need more upper-bone twist than
 * the joint allows, the nearest direction that is anatomically possible is used.
 */
function solveLimb(fig: Figure, pose: Pose, limb: Limb, side: Side, target: THREE.Vector3, pole: THREE.Vector3 | null) {
  const n = limbNames(limb, side);
  const s = sgn(side);
  const S = worldPos(fig.bones[n.root]);
  const a = fig.bones[n.mid].position.length();
  const b = fig.bones[n.end].position.length();
  const toT = target.clone().sub(S);
  const u = toT.lengthSq() > 1e-10 ? toT.clone().normalize() : new THREE.Vector3(0, -1, 0);
  const d = clamp(toT.length(), Math.abs(a - b) + 1e-4, (a + b) * 0.9999);
  const W0 = S.clone().addScaledVector(u, d);
  const A = Math.acos(clamp((a * a + d * d - b * b) / (2 * a * d), -1, 1));
  const bend = 180 - Math.acos(clamp((a * a + b * b - d * d) / (2 * a * b), -1, 1)) / DEG;
  // Express segments in the limb's parent frame (chest or pelvis); bones have
  // identity rest rotations, so that frame is just the parent's world rotation.
  const toFrame = worldQuat(fig.bones[n.frame]).invert();
  const upper = pose[n.upper];
  const twistDof = CONTROL_BY_ID[n.upper].dofs.find((x) => x.id === 'twist')!;
  const bendDof = CONTROL_BY_ID[n.lower].dofs.find((x) => x.id === 'bend')!;

  const solveFor = (p: THREE.Vector3): LimbSolution => {
    const E = S.clone().addScaledVector(u, a * Math.cos(A)).addScaledVector(p, a * Math.sin(A));
    const W = S.clone().addScaledVector(u, d);
    const dU = E.clone().sub(S).normalize().applyQuaternion(toFrame);
    const dL = W.sub(E).normalize().applyQuaternion(toFrame);
    const elev = Math.acos(clamp(-dU.y, -1, 1)) / DEG;
    const horiz = Math.hypot(dU.x, dU.z);
    const phi = horiz > 1e-4 ? Math.atan2(s * dU.x, dU.z) : Math.atan2(upper.out, upper.fwd);
    const [fwd, out] = clampReach(CONTROL_BY_ID[n.upper].pad!, elev * Math.cos(phi), elev * Math.sin(phi));
    // Twist the upper bone so the hinge bends the lower bone toward dL.
    // Elbows flex toward the bone's local +Z, knees toward -Z.
    let twist = upper.twist;
    if (bend > 3) {
      const f = dL.applyQuaternion(swingTwist(fwd, out, 0, s).invert());
      const theta = limb === 'arm' ? Math.atan2(f.x, f.z) : Math.atan2(-f.x, -f.z);
      twist = (theta / DEG) * s;
    }
    return { fwd, out, twist, bend };
  };
  // Where the end really lands once the dofs are clamped to the joint limits.
  const frame = worldQuat(fig.bones[n.frame]);
  const down = new THREE.Vector3(0, -1, 0);
  const landing = (x: LimbSolution) => {
    const qU = frame.clone().multiply(swingTwist(x.fwd, x.out, clamp(x.twist, twistDof.min, twistDof.max), s));
    const hinge = clamp(x.bend, bendDof.min, bendDof.max) * (limb === 'arm' ? -1 : 1);
    const qL = qU.clone().multiply(rot(new THREE.Vector3(1, 0, 0), hinge));
    return S.clone().addScaledVector(down.clone().applyQuaternion(qU), a).addScaledVector(down.clone().applyQuaternion(qL), b);
  };
  const reachable = W0.clone();
  const miss = (x: LimbSolution) => landing(x).distanceTo(reachable);

  const p0 = (pole && perpendicular(pole, u)) ?? perpendicular(new THREE.Vector3(0, 0, limb === 'arm' ? -1 : 1), u) ?? new THREE.Vector3(1, 0, 0);
  let best = solveFor(p0);
  if (miss(best) > 0.002) {
    // The requested elbow/knee direction can't be reached within the joint limits:
    // try others around the root→end axis, preferring those close to the request.
    const ux = new THREE.Vector3().crossVectors(u, p0);
    let bestCost = miss(best);
    for (let k = 1; k < 24; k++) {
      const ang = (k <= 12 ? k : k - 24) * 15 * DEG;
      const cand = solveFor(p0.clone().multiplyScalar(Math.cos(ang)).addScaledVector(ux, Math.sin(ang)));
      const cost = miss(cand) + 0.004 * Math.abs(ang);
      if (cost < bestCost) {
        best = cand;
        bestCost = cost;
      }
    }
  }
  upper.fwd = best.fwd;
  upper.out = best.out;
  upper.twist = clamp(best.twist, twistDof.min, twistDof.max);
  pose[n.lower].bend = clamp(best.bend, bendDof.min, bendDof.max);
}

/**
 * Set the ankle so the foot keeps a world orientation, given the leg dofs already in
 * the pose. Returns the ankle angle that would need (before limits), in degrees.
 */
function orientFoot(fig: Figure, pose: Pose, side: Side, footQuat: THREE.Quaternion): number {
  const s = sgn(side);
  const th = pose[`thigh_${side}`];
  const shin = worldQuat(fig.bones.pelvis)
    .multiply(swingTwist(th.fwd, th.out, th.twist, s))
    .multiply(rot(new THREE.Vector3(1, 0, 0), pose[`shin_${side}`].bend));
  const local = shin.invert().multiply(footQuat);
  const e = new THREE.Euler().setFromQuaternion(local, 'XZY');
  const dofs = CONTROL_BY_ID[`foot_${side}`].dofs;
  const lim = (id: string, v: number) => {
    const d = dofs.find((x) => x.id === id)!;
    return clamp(v, d.min, d.max);
  };
  pose[`foot_${side}`].point = lim('point', e.x / DEG);
  pose[`foot_${side}`].roll = lim('roll', (-s * e.z) / DEG);
  return e.x / DEG;
}

function parsePin(key: string): [Limb, Side] {
  const [, limb, side] = key.split('_');
  return [limb as Limb, side as Side];
}

/** Solve one pinned or dragged hand/foot toward its stored target. */
function solvePin(fig: Figure, pose: Pose, key: string, floor = false) {
  const [limb, side] = parsePin(key);
  const pin = pose[key];
  const target = new THREE.Vector3(pin.x, pin.y, pin.z);
  let pole: THREE.Vector3 | null;
  if (pin.swivel !== undefined) pole = poleFromSwivel(fig, limb, side, target, pin.swivel);
  else if (pin.px !== undefined) {
    // An elbow/knee being dragged: bend toward the dragged point.
    pole = new THREE.Vector3(pin.px, pin.py, pin.pz).sub(worldPos(fig.bones[limbNames(limb, side).root]));
  } else pole = currentPole(fig, limb, side);
  if (limb === 'leg' && pin.qw !== undefined) {
    const q = new THREE.Quaternion(pin.qx, pin.qy, pin.qz, pin.qw);
    const planted = floor && pin.y <= fig.P.ankleY + 0.01 * fig.P.H;
    if (planted) plantFoot(fig, pose, side, target, q, pole);
    else {
      solveLimb(fig, pose, limb, side, target, pole);
      orientFoot(fig, pose, side, q);
    }
  } else solveLimb(fig, pose, limb, side, target, pole);
}

/**
 * A foot planted on the floor whose ankle can't flex far enough to stay flat
 * (deep squat, lunge) rolls up onto the ball of the foot: the heel lifts, the
 * ankle travels in an arc around the ball, and the toes bend back to stay down.
 * Search for the smallest heel lift the ankle can actually achieve.
 */
function plantFoot(fig: Figure, pose: Pose, side: Side, ankle: THREE.Vector3, flat: THREE.Quaternion, pole: THREE.Vector3 | null) {
  const P = fig.P;
  const toe = fig.bones[`toe_${side}`].position;
  const ball = new THREE.Vector3(toe.x, -P.ankleY, toe.z).applyQuaternion(flat).add(ankle);
  const axis = new THREE.Vector3(1, 0, 0).applyQuaternion(flat);
  const pointMin = CONTROL_BY_ID[`foot_${side}`].dofs.find((d) => d.id === 'point')!.min;
  let lift = 0;
  for (let step = 0; step <= 12; step++) {
    lift = step * 5;
    const r = new THREE.Quaternion().setFromAxisAngle(axis, lift * DEG);
    const a = ankle.clone().sub(ball).applyQuaternion(r).add(ball);
    solveLimb(fig, pose, 'leg', side, a, pole);
    if (orientFoot(fig, pose, side, r.multiply(flat.clone())) > pointMin + 0.5) break;
  }
  const toes = CONTROL_BY_ID[`foot_${side}`].dofs.find((d) => d.id === 'toes')!;
  // Toes stay flat on the floor whether or not the heel is up.
  pose[`foot_${side}`].toes = Math.max(toes.min, -lift);
}

/**
 * Pose the doll: forward kinematics, then pull pinned hands and feet onto their
 * targets. When the hips are held in place (feet planted, or mid-drag) and the
 * floor is on, the hips are kept as low as asked but never so low that the body
 * goes through the floor — lowering them all the way gives a seated or kneeling
 * pose instead of sinking.
 */
export function applyPose(fig: Figure, pose: Pose, autoGround: boolean) {
  const pins = PIN_KEYS.filter((k) => pose[k]);
  const floor = autoGround && !!pose.root?.fixed;
  if (pins.length === 0 && !floor) {
    applyFK(fig, pose, autoGround);
    if (autoGround) settleFreeHands(fig, pose, autoGround);
    return;
  }
  // Pinned hands are placed by the user and never push the hips up. Planted feet
  // normally sit exactly on the floor; they only count once the legs can't reach
  // them any more (hips pulled lower than the legs can fold).
  const base = supportFilter(pose);
  const pinnedHands = new Set(pins.filter((k) => k.startsWith('pin_arm')).map((k) => `hand${k.slice(-2)}`));
  const supports = (c: string) => base(c) && !pinnedHands.has(c);
  const tolerance = 0.004;

  const solveAll = (refresh: boolean) => {
    // Repeat to absorb the shoulder girdle moving with arm elevation.
    for (let pass = 0; pass < 2; pass++) {
      for (const key of pins) solvePin(fig, pose, key, autoGround);
      applyFK(fig, pose, autoGround, false);
    }
    if (refresh) fig.refreshBounds();
  };

  solveAll(!floor);
  if (floor) {
    // Find the lowest hip height at or above the requested one where nothing sinks.
    const wanted = pose.root.y;
    for (let i = 0; i < 6; i++) {
      const low = fig.lowestPoint(supports, 3) + tolerance;
      if (Math.abs(low) < 5e-4 || (low > 0 && pose.root.y <= wanted + 1e-6)) break;
      pose.root.y = Math.max(wanted, pose.root.y - low);
      solveAll(false);
    }
    fig.refreshBounds();
  }
  if (autoGround) settleFreeHands(fig, pose, autoGround);
}

/** Free-hanging hands that would pass through the floor rest on it instead, bending the arm. */
function settleFreeHands(fig: Figure, pose: Pose, autoGround: boolean) {
  for (const side of ['L', 'R'] as Side[]) {
    const key = pinKey('arm', side);
    if (pose[key]) continue;
    const low = fig.lowestPoint((c) => c === `hand_${side}` || c === `forearm_${side}`);
    if (low > -1e-4) continue;
    const p = endPosition(fig, 'arm', side);
    pose[key] = { x: p.x, y: p.y - low, z: p.z };
    solvePin(fig, pose, key);
    delete pose[key];
    applyFK(fig, pose, autoGround);
  }
}

const dofClamp = (control: string, id: string, v: number) => {
  const d = CONTROL_BY_ID[control].dofs.find((x) => x.id === id)!;
  return clamp(v, d.min, d.max);
};

/**
 * Swing the upper arm or thigh so the elbow/knee heads toward `target`. Arms keep
 * their elbow bend; legs keep the shin's direction in the world (it hangs as the
 * thigh lifts), so raising a knee bends it like a march step rather than a kick.
 */
export function aimLimb(fig: Figure, pose: Pose, limb: Limb, side: Side, target: THREE.Vector3) {
  const n = limbNames(limb, side);
  const s = sgn(side);
  const shinDir = limb === 'leg' ? worldPos(fig.bones[n.end]).sub(worldPos(fig.bones[n.mid])).normalize() : null;
  const dU = target.clone().sub(worldPos(fig.bones[n.root])).applyQuaternion(worldQuat(fig.bones[n.frame]).invert());
  if (dU.lengthSq() < 1e-10) return;
  dU.normalize();
  const upper = pose[n.upper];
  const elev = Math.acos(clamp(-dU.y, -1, 1)) / DEG;
  const horiz = Math.hypot(dU.x, dU.z);
  const phi = horiz > 1e-4 ? Math.atan2(s * dU.x, dU.z) : Math.atan2(upper.out, upper.fwd);
  [upper.fwd, upper.out] = clampReach(CONTROL_BY_ID[n.upper].pad!, elev * Math.cos(phi), elev * Math.sin(phi));
  if (shinDir) {
    // Knee flexion turns the shin from the thigh's -Y toward its -Z.
    const thigh = worldQuat(fig.bones[n.frame]).multiply(swingTwist(upper.fwd, upper.out, upper.twist, s));
    const f = shinDir.applyQuaternion(thigh.invert());
    pose[n.lower].bend = dofClamp(n.lower, 'bend', Math.atan2(-f.z, -f.y) / DEG);
  }
}

/** Where the head and chest drag handles sit, in their bones' local space. */
export function headHandleLocal(fig: Figure) {
  return new THREE.Vector3(0, 0.22 * fig.P.hh, 0.04 * fig.P.hh);
}
export function chestHandleLocal(fig: Figure) {
  return new THREE.Vector3(0, 0.62 * (fig.P.neckY - fig.P.chestY), 0);
}

/** Nod and tilt the head so its handle heads toward `target` (turn is left as is). */
export function aimHead(fig: Figure, pose: Pose, target: THREE.Vector3) {
  const P = fig.P;
  const d = target.clone().sub(worldPos(fig.bones.neck)).applyQuaternion(worldQuat(fig.bones.chest).invert());
  // Measure in the head's turned frame so dragging forward always nods.
  d.applyAxisAngle(new THREE.Vector3(0, 1, 0), pose.head.turn * DEG);
  const h = headHandleLocal(fig);
  const restAngle = Math.atan2(P.headZ - P.neckZ + h.z, P.headY - P.neckY + h.y);
  pose.head.nod = dofClamp('head', 'nod', (Math.atan2(d.z, d.y) - restAngle) / DEG);
  pose.head.tilt = dofClamp('head', 'tilt', Math.atan2(-d.x, Math.hypot(d.y, d.z)) / DEG);
}

/** Bend the spine (waist then chest) so the chest handle heads toward `target`. */
export function aimChest(fig: Figure, pose: Pose, target: THREE.Vector3) {
  const d = target.clone().sub(worldPos(fig.bones.lumbar)).applyQuaternion(worldQuat(fig.bones.pelvis).invert());
  d.applyAxisAngle(new THREE.Vector3(0, 1, 0), (pose.waist.twist + pose.chest.twist) * DEG);
  const split = (total: number, id: string) => {
    // The lower back takes a little over half; whatever one part can't take, the other does.
    const w = dofClamp('waist', id, total * 0.55);
    const c = dofClamp('chest', id, total - w);
    pose.waist[id] = dofClamp('waist', id, total - c);
    pose.chest[id] = c;
  };
  split(Math.atan2(d.z, d.y) / DEG, 'bend');
  split(Math.atan2(-d.x, Math.hypot(d.y, d.z)) / DEG, 'side');
}

/**
 * Run a spine edit while free (unpinned) arms keep pointing the same way in the
 * world, so bending forward leaves them hanging instead of swinging up behind.
 */
export function withArmsSteady(fig: Figure, pose: Pose, autoGround: boolean, edit: () => void) {
  const steady = (['L', 'R'] as Side[])
    .filter((side) => !pose[pinKey('arm', side)])
    .map((side) => {
      const n = limbNames('arm', side);
      return { side, dir: worldPos(fig.bones[n.mid]).sub(worldPos(fig.bones[n.root])) };
    });
  edit();
  applyPose(fig, pose, autoGround);
  for (const { side, dir } of steady) aimLimb(fig, pose, 'arm', side, worldPos(fig.bones[limbNames('arm', side).root]).add(dir));
}

/** The foot's orientation with toes and sole level, keeping only which way it faces. */
export function flatFoot(q: THREE.Quaternion) {
  const f = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
  return new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(f.x, f.z));
}

/** Store a hand's or foot's current world placement as its pin target. */
export function makePin(fig: Figure, limb: Limb, side: Side, swivel?: number) {
  const p = endPosition(fig, limb, side);
  const pin: Record<string, number> = { x: p.x, y: p.y, z: p.z };
  if (limb === 'leg') {
    const q = endQuaternion(fig, limb, side);
    Object.assign(pin, { qx: q.x, qy: q.y, qz: q.z, qw: q.w });
  }
  if (swivel !== undefined) pin.swivel = swivel;
  return pin;
}

/** Point the elbow/knee in a new direction while the hand/foot stays where it is. */
export function setSwivel(fig: Figure, pose: Pose, limb: Limb, side: Side, angle: number, autoGround: boolean) {
  const key = pinKey(limb, side);
  const had = pose[key];
  pose[key] = { ...(had ?? makePin(fig, limb, side)), swivel: angle };
  applyPose(fig, pose, autoGround);
  if (had) delete pose[key].swivel;
  else delete pose[key];
}

/** Turn the head toward a world point (e.g. the camera), within the neck's range. */
export function lookAt(fig: Figure, pose: Pose, point: THREE.Vector3) {
  const neck = fig.bones.neck;
  const from = worldPos(fig.bones.head);
  const dir = point.clone().sub(from).applyQuaternion(worldQuat(neck.parent!).invert());
  const turn = -Math.atan2(dir.x, dir.z) / DEG;
  const nod = -Math.atan2(dir.y, Math.hypot(dir.x, dir.z)) / DEG;
  const dofs = CONTROL_BY_ID.head.dofs;
  const lim = (id: string, v: number) => {
    const d = dofs.find((x) => x.id === id)!;
    return clamp(v, d.min, d.max);
  };
  pose.head.turn = lim('turn', turn);
  pose.head.nod = lim('nod', nod);
  pose.head.tilt = 0;
}
