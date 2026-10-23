// Dev-only helpers for inspecting renders (loaded by main.ts in `npm run dev` only).
// Renders are POSTed to the dev server's /__shot hook, which saves them to disk.
import * as THREE from 'three';
import type { App } from './app';
import { renderPNG } from './export';
import { PRESETS } from './presets';
import { FigureParams } from './proportions';
import { Pose } from './joints';

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
      app.s.params = { age: 25, sex: 0.5, height: 1, build: 0.3, muscle: 0.3, ...p };
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
    lows(...controls: string[]) {
      return Object.fromEntries(controls.map((c) => [c, +(app.figure.lowestPoint((x) => x === c) * 100).toFixed(1)]));
    },
    world(bone: string) {
      return app.figure.bones[bone].getWorldPosition(new THREE.Vector3());
    },
  };
  (window as unknown as { dev: typeof dev }).dev = dev;
}
