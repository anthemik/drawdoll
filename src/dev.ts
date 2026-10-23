// Dev-only helpers for inspecting renders (loaded by main.ts in `npm run dev` only).
// Renders are POSTed to the dev server's /__shot hook, which saves them to disk.
import * as THREE from 'three';
import type { App } from './app';
import { renderPNG } from './export';
import { PRESETS } from './presets';
import { DEFAULT_PARAMS, FigureParams } from './proportions';
import { CONTROL_BY_ID, Pose, completePose, defaultPose } from './joints';
import { applyPose } from './ik';

export function installDevTools(app: App) {
  const v = app.viewer;
  const post = async (name: string, bg: 'gray' | 'white' = 'gray', shadow = false) => {
    const blob = await renderPNG(v, app.figure, { background: bg, horizon: false, shadow, grid: false });
    await fetch(`/__shot?name=${name}`, { method: 'POST', body: blob });
    return name;
  };
  const dev = {
    app,
    presets: PRESETS,
    /** Set body params on top of the defaults and rebuild. */
    body(p: Partial<FigureParams> = {}) {
      app.s.params = { ...DEFAULT_PARAMS, ...p };
      app.rebuild();
    },
    pose(p: Pose | number = {}) {
      app.loadPose(typeof p === 'number' ? PRESETS[p].pose : p);
    },
    /** Whole figure, framed, from an orbit angle. */
    async full(name: string, az: number, el = 5, w = 600, h = 800) {
      v.setFrame({ w, h });
      v.setView(az, el);
      v.frameFigure();
      return post(name, 'white', true);
    },
    /** Close-up centred on a bone. */
    async close(name: string, bone: string, az: number, el: number, dist: number, dy = 0) {
      v.setFrame({ w: 600, h: 600 });
      const p = app.figure.bones[bone].getWorldPosition(new THREE.Vector3());
      p.y += dy;
      v.controls.target.copy(p);
      const a = THREE.MathUtils.degToRad(az);
      const e = THREE.MathUtils.degToRad(el);
      v.camera.position.set(p.x + dist * Math.cos(e) * Math.sin(a), p.y + dist * Math.sin(e), p.z + dist * Math.cos(e) * Math.cos(a));
      v.controls.update();
      return post(name);
    },
    /** Simulate dragging a handle (by id) to a world point, as a finger would. */
    drag(handleId: string, to: THREE.Vector3, steps = 6) {
      const m = v.handles.children.find((h) => h.userData.handle.id === handleId)!;
      const el = v.renderer.domElement.parentElement!;
      const r = v.renderer.domElement.getBoundingClientRect();
      const screen = (p: THREE.Vector3) => {
        const q = p.clone().project(v.camera);
        return [r.left + ((q.x + 1) / 2) * r.width, r.top + ((1 - q.y) / 2) * r.height];
      };
      const fire = (type: string, [x, y]: number[]) =>
        el.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, pointerId: 77, isPrimary: true, bubbles: true, pointerType: 'mouse' }));
      const from = m.position.clone();
      fire('pointerdown', screen(from));
      for (let i = 1; i <= steps; i++) fire('pointermove', screen(from.clone().lerp(to, i / steps)));
      fire('pointerup', screen(to));
    },
    /**
     * Authoring: nudge the listed dofs until each support rests on the floor
     * ("foot_L:flat" also keeps that sole level). Returns the settled pose.
     */
    settle(pose: Pose, supports: string[], free: [string, string][], iterations = 6) {
      const f = app.figure;
      let p = completePose(JSON.parse(JSON.stringify(pose)));
      const start = JSON.parse(JSON.stringify(p));
      const cost = (q: Pose) => {
        applyPose(f, q, true);
        let c = 0;
        for (const sup of supports) {
          const [control, flag] = sup.split(':');
          c += (f.lowestPoint((x) => x === control, 5) * 100) ** 2;
          if (flag === 'flat') {
            const q4 = f.bones[`ankle${control.slice(-2)}`].getWorldQuaternion(new THREE.Quaternion());
            c += 400 * (new THREE.Vector3(0, 0, 1).applyQuaternion(q4).y ** 2 + new THREE.Vector3(1, 0, 0).applyQuaternion(q4).y ** 2);
          }
        }
        for (const [ctl, dof] of free) c += 0.002 * (q[ctl][dof] - start[ctl][dof]) ** 2;
        return c;
      };
      let best = cost(p);
      for (const step of [8, 3, 1].slice(0, iterations)) {
        for (let rep = 0; rep < 4; rep++) {
          let improved = false;
          for (const [ctl, dof] of free) {
            const d = CONTROL_BY_ID[ctl].dofs.find((x) => x.id === dof)!;
            for (const dir of [1, -1]) {
              const q = JSON.parse(JSON.stringify(p));
              q[ctl][dof] = THREE.MathUtils.clamp(q[ctl][dof] + dir * step, d.min, d.max);
              const c = cost(q);
              if (c < best - 1e-6) {
                best = c;
                p = q;
                improved = true;
              }
            }
          }
          if (!improved) break;
        }
      }
      app.s.pose = p;
      app.poseChanged();
      return { pose: p, cost: +best.toFixed(3) };
    },
    /** Authoring: put a hand's wrist at a point given in a bone's local frame (metres). */
    handTo(side: 'L' | 'R', bone: string, local: [number, number, number]) {
      const t = app.figure.bones[bone].localToWorld(new THREE.Vector3(...local));
      const pose = app.s.pose;
      pose[`pin_arm_${side}`] = { x: t.x, y: t.y, z: t.z };
      app.poseChanged();
      delete pose[`pin_arm_${side}`];
      app.poseChanged();
    },
    /** Authoring: the current pose as compact preset data (only dofs that differ from rest, rounded). */
    exportPose() {
      const base = defaultPose();
      const out: Pose = {};
      for (const [id, dofs] of Object.entries(app.s.pose)) {
        if (!CONTROL_BY_ID[id]) continue;
        for (const [k, v] of Object.entries(dofs)) {
          const r = Math.round(v);
          if (r !== Math.round(base[id][k])) (out[id] ??= {})[k] = r;
        }
      }
      return JSON.stringify(out);
    },
    lows(...controls: string[]) {
      return Object.fromEntries(controls.map((c) => [c, +(app.figure.lowestPoint((x) => x === c) * 100).toFixed(1)]));
    },
    world(bone: string) {
      return app.figure.bones[bone].getWorldPosition(new THREE.Vector3());
    },
  };
  (window as unknown as { dev: typeof dev }).dev = dev;
}
