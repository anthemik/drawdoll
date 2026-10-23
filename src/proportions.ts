import { clamp, interp, lerp, smoothstep } from './math';

export interface FigureParams {
  /** Years, 2–25 (25 = adult). */
  age: number;
  /** 0 = female, 1 = male, 0.5 = neutral mannequin. */
  sex: number;
  /** Stature multiplier around the median for age/sex (0.85–1.15). */
  height: number;
  /** 0 = slim, 0.3 = average, 1 = heavy. */
  build: number;
  /** 0 = soft, 1 = very muscular. */
  muscle: number;
}

export const DEFAULT_PARAMS: FigureParams = { age: 25, sex: 0.5, height: 1, build: 0.3, muscle: 0.3 };

// Median stature (m) by age. Roughly CDC/WHO growth-chart medians.
const HEIGHT_F: [number, number][] = [
  [2, 0.86], [4, 1.01], [6, 1.15], [8, 1.27], [10, 1.38], [12, 1.51], [14, 1.6], [16, 1.62], [18, 1.63],
];
const HEIGHT_M: [number, number][] = [
  [2, 0.875], [4, 1.03], [6, 1.16], [8, 1.28], [10, 1.39], [12, 1.49], [14, 1.64], [16, 1.73], [18, 1.76],
];
// Stature measured in head heights (vertex to chin).
const HEADS: [number, number][] = [
  [2, 4.6], [3, 5.0], [5, 5.5], [7, 6.0], [10, 6.5], [13, 6.9], [16, 7.3], [19, 7.5],
];
// Hip joint centre height as a fraction of stature: children have short legs.
const LEG_FRAC: [number, number][] = [
  [2, 0.415], [4, 0.44], [6, 0.46], [9, 0.48], [13, 0.495], [18, 0.5],
];
// Shoulder joint to fingertip as a fraction of stature.
const ARM_FRAC: [number, number][] = [
  [2, 0.4], [6, 0.42], [12, 0.435], [18, 0.44],
];

/** Every dimension the mannequin builder needs, in metres, standing at rest with feet on y = 0. */
export interface Proportions {
  H: number;
  hh: number;
  headsTall: number;
  /** Childness 1 (toddler) → 0 (13+). */
  c: number;
  /** Puberty 0 → 1 (10.5–17 years). */
  p: number;
  fem: number;
  mas: number;
  fat: number;
  mu: number;

  headB: number;
  headL: number;
  rootY: number;
  hipY: number;
  lumbarY: number;
  chestY: number;
  shoulderY: number;
  neckY: number;
  neckZ: number;
  headY: number;
  headZ: number;
  ankleY: number;

  shW: number;
  hipJointHalf: number;
  ua: number;
  fa: number;
  hl: number;
  thigh: number;
  shank: number;
  footL: number;
  footW: number;
  handB: number;

  neckR: number;
  chestX: number;
  chestZ: number;
  waistX: number;
  waistZ: number;
  hipX: number;
  hipZ: number;
  armR: number;
  forearmR: number;
  wristR: number;
  thighR: number;
  kneeR: number;
  calfR: number;
  ankleR: number;
  breast: number;
  pec: number;
}

export function computeProportions(fp: FigureParams): Proportions {
  const age = clamp(fp.age, 2, 25);
  const m = clamp(fp.sex, 0, 1);
  const c = 1 - smoothstep(2, 13, age);
  const p = smoothstep(10.5, 17, age);
  // Sexual dimorphism only emerges through puberty.
  const dim = (m - 0.5) * 2 * p;
  const fem = p * smoothstep(0.55, 0, m);
  const mas = p * smoothstep(0.45, 1, m);
  const g = 0.85 + 0.5 * fp.build;
  const fat = Math.max(0, fp.build - 0.3) / 0.7;
  const mu = fp.muscle * (0.25 + 0.75 * p);

  const Hbase = lerp(interp(HEIGHT_F, age), interp(HEIGHT_M, age), m);
  const H = Hbase * fp.height;
  // Head size varies less than stature, so tall people are more heads tall.
  const hh = (Hbase / interp(HEADS, age)) * Math.pow(fp.height, 0.3);

  const hipY = interp(LEG_FRAC, age) * H;
  const shoulderY = H - hh * (1.2 + 0.16 * (1 - c));
  const T = shoulderY - hipY;
  const ankleY = H * lerp(0.045, 0.05, c);
  const A = interp(ARM_FRAC, age) * H;
  const L = hipY - ankleY;

  return {
    H, hh, headsTall: H / hh, c, p, fem, mas, fat, mu,

    headB: hh * (0.65 + 0.07 * c),
    headL: hh * (0.82 + 0.05 * c),
    rootY: hipY + 0.035 * H,
    hipY,
    lumbarY: hipY + 0.16 * T,
    chestY: hipY + 0.4 * T,
    shoulderY,
    neckY: shoulderY + 0.02 * H,
    neckZ: -0.022 * H,
    headY: H - 0.72 * hh,
    headZ: -0.004 * H,
    ankleY,

    shW: H * (lerp(0.104, 0.1, 1 - c) + 0.007 * dim + 0.004 * mu),
    hipJointHalf: H * (0.05 - 0.004 * dim),
    ua: A * 0.4227,
    fa: A * 0.3318,
    hl: A * 0.2455,
    thigh: L * 0.535,
    shank: L * 0.465,
    footL: H * 0.152,
    footW: H * 0.054,
    handB: H * 0.048,

    neckR: H * (interp([[2, 0.038], [10, 0.031], [18, 0.03]], age) + 0.004 * dim + 0.003 * mu) * Math.sqrt(g),
    chestX: H * (0.086 + 0.004 * c + 0.006 * dim + 0.006 * mu) * g,
    chestZ: H * (0.086 + 0.004 * c) * (0.66 + 0.18 * c) * g * (1 + 0.1 * mu),
    waistX: H * (0.072 + 0.004 * dim - 0.004 * fem + 0.012 * c) * g * (1 + 0.25 * fat),
    waistZ: H * (0.072 + 0.012 * c) * (0.76 + 0.12 * c + 0.12 * fat) * g,
    // Hips widen less with weight than the belly does.
    hipX: H * (0.104 - 0.008 * dim) * Math.pow(g, 0.6) * (1 + 0.08 * fat),
    hipZ: H * (0.104 - 0.006 * dim) * 0.72 * Math.pow(g, 0.7) * (1 + 0.1 * fat),
    armR: H * (0.025 + 0.0015 * dim + 0.006 * mu + 0.004 * c) * g,
    forearmR: H * (0.0225 + 0.0015 * dim + 0.004 * mu + 0.003 * c) * Math.pow(g, 0.8),
    wristR: H * (0.0152 + 0.0012 * dim + 0.002 * c),
    thighR: H * (0.05 + 0.003 * fem + 0.007 * mu + 0.004 * c) * g,
    kneeR: H * (0.03 + 0.003 * c) * Math.sqrt(g),
    calfR: H * (0.032 + 0.006 * mu + 0.003 * c) * Math.pow(g, 0.8),
    ankleR: H * (0.018 + 0.002 * c),
    breast: fem * H * 0.04 * (0.85 + 0.45 * fat),
    pec: clamp(0.4 * mas + 0.8 * mu * p, 0, 1),
  };
}

/** Real-world stature readout for the Body panel. */
export function describeHeight(P: Proportions): string {
  const cm = Math.round(P.H * 100);
  const inches = P.H / 0.0254;
  const ft = Math.floor(inches / 12);
  const inch = Math.round(inches - ft * 12);
  return `${cm} cm · ${ft}′${inch}″`;
}
