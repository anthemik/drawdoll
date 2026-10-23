import { BufferGeometry, Float32BufferAttribute } from 'three';

/**
 * One elliptical cross-section of a lofted body part, perpendicular to Y.
 * `zf` is the depth toward +Z (front), `zb` toward -Z (back), so a section
 * can bulge more in front than behind (belly, calf) without a seam.
 */
export interface Ring {
  y: number;
  x: number;
  zf: number;
  zb: number;
  xo?: number;
  zo?: number;
}

type FullRing = Required<Ring>;
const KEYS = ['y', 'x', 'zf', 'zb', 'xo', 'zo'] as const;

function catmull(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

/** Sweep smoothly-interpolated cross-sections into a closed, smooth-shaded mesh. */
export function loft(rings: Ring[], radial = 28, sub = 5): BufferGeometry {
  const rs: FullRing[] = rings.map((r) => ({ xo: 0, zo: 0, ...r }));
  const samples: FullRing[] = [];
  for (let i = 0; i < rs.length - 1; i++) {
    const p0 = rs[Math.max(0, i - 1)];
    const p1 = rs[i];
    const p2 = rs[i + 1];
    const p3 = rs[Math.min(rs.length - 1, i + 2)];
    for (let k = 0; k < sub; k++) {
      const t = k / sub;
      const o = {} as FullRing;
      for (const key of KEYS) o[key] = catmull(p0[key], p1[key], p2[key], p3[key], t);
      samples.push(o);
    }
  }
  samples.push(rs[rs.length - 1]);

  const pos: number[] = [];
  for (const s of samples) {
    const x = Math.max(s.x, 1e-5);
    const zf = Math.max(s.zf, 1e-5);
    const zb = Math.max(s.zb, 1e-5);
    for (let j = 0; j < radial; j++) {
      const a = (j / radial) * Math.PI * 2;
      const sn = Math.sin(a);
      pos.push(s.xo + x * Math.cos(a), s.y, s.zo + (sn >= 0 ? zf : zb) * sn);
    }
  }

  const n = samples.length;
  const idx: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < radial; j++) {
      const jn = (j + 1) % radial;
      const a = i * radial + j;
      const b = i * radial + jn;
      const c = (i + 1) * radial + j;
      const d = (i + 1) * radial + jn;
      idx.push(a, c, b, b, c, d);
    }
  }
  const first = samples[0];
  const last = samples[n - 1];
  const c0 = pos.length / 3;
  pos.push(first.xo, first.y, first.zo);
  const c1 = pos.length / 3;
  pos.push(last.xo, last.y, last.zo);
  for (let j = 0; j < radial; j++) {
    const jn = (j + 1) % radial;
    idx.push(c0, j, jn);
    idx.push(c1, (n - 1) * radial + jn, (n - 1) * radial + j);
  }

  // Rings may run up or down the axis; make sure faces point outward.
  let vol = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3;
    const b = idx[t + 1] * 3;
    const c = idx[t + 2] * 3;
    vol +=
      pos[a] * (pos[b + 1] * pos[c + 2] - pos[b + 2] * pos[c + 1]) -
      pos[a + 1] * (pos[b] * pos[c + 2] - pos[b + 2] * pos[c]) +
      pos[a + 2] * (pos[b] * pos[c + 1] - pos[b + 1] * pos[c]);
  }
  if (vol < 0) {
    for (let t = 0; t < idx.length; t += 3) {
      const tmp = idx[t + 1];
      idx[t + 1] = idx[t + 2];
      idx[t + 2] = tmp;
    }
  }

  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}
