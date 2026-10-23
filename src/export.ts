import * as THREE from 'three';
import { Viewer, tanHalfVFov } from './viewer';
import { DEG } from './math';
import { Figure } from './figure';

export type Background = 'transparent' | 'white' | 'gray';

export interface ExportOptions {
  background: Background;
  horizon: boolean;
  shadow: boolean;
  grid: boolean;
}

/** Largest canvas iPad Safari will reliably allocate. */
const MAX_PIXELS = 16_000_000;

export function exportSize(viewer: Viewer) {
  let { w, h } = viewer.frame;
  const maxTex = viewer.renderer.capabilities.maxTextureSize;
  const k = Math.min(1, Math.sqrt(MAX_PIXELS / (w * h)), maxTex / w, maxTex / h);
  w = Math.max(1, Math.floor(w * k));
  h = Math.max(1, Math.floor(h * k));
  return { w, h, scaled: k < 1 };
}

/**
 * Render exactly what is inside the viewport frame at full export resolution.
 * Temporarily resizes the shared renderer (no second GL context, which iPad
 * memory limits punish), copies the pixels out, then restores everything.
 */
export function renderPNG(viewer: Viewer, figure: Figure, opts: ExportOptions): Promise<Blob> {
  const { w, h } = exportSize(viewer);
  const r = viewer.renderer;
  const prevRatio = r.getPixelRatio();
  const prevSize = r.getSize(new THREE.Vector2());

  const cam = viewer.camera.clone();
  cam.aspect = w / h;
  cam.fov = (2 * Math.atan(tanHalfVFov(viewer.focal, w / h))) / DEG;
  cam.updateProjectionMatrix();

  const gridVis = viewer.grid.visible;
  const groundVis = viewer.ground.visible;
  const balVis = viewer.balanceGroup.visible;
  const handlesVis = viewer.handles.visible;
  viewer.handles.visible = false;
  viewer.grid.visible = opts.grid;
  viewer.ground.visible = opts.shadow;
  viewer.balanceGroup.visible = false;
  const hl = figure.highlighted;
  figure.setHighlight(null);

  r.setPixelRatio(1);
  r.setSize(w, h, false);
  figure.outlineMat.uniforms.uResolution.value.set(w, h);
  figure.outlineMat.uniforms.uThickness.value = (viewer.lineWeight * h) / 1000;
  r.render(viewer.scene, cam);

  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const g = out.getContext('2d')!;
  if (opts.background !== 'transparent') {
    g.fillStyle = opts.background === 'white' ? '#ffffff' : '#a9adb3';
    g.fillRect(0, 0, w, h);
  }
  g.drawImage(r.domElement, 0, 0, w, h, 0, 0, w, h);

  if (opts.horizon) {
    const y = viewer.horizonY(cam);
    if (y !== null && y >= 0 && y <= 1) {
      const lw = Math.max(1, h / 900);
      g.strokeStyle = 'rgba(230,60,40,0.9)';
      g.lineWidth = lw;
      g.setLineDash([lw * 10, lw * 7]);
      g.beginPath();
      g.moveTo(0, y * h);
      g.lineTo(w, y * h);
      g.stroke();
    }
  }

  r.setPixelRatio(prevRatio);
  r.setSize(prevSize.x, prevSize.y, false);
  viewer.grid.visible = gridVis;
  viewer.ground.visible = groundVis;
  viewer.balanceGroup.visible = balVis;
  viewer.handles.visible = handlesVis;
  figure.setHighlight(hl);
  viewer.invalidate();

  return new Promise((resolve, reject) => {
    out.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encoding failed'))), 'image/png');
  });
}

export function fileName() {
  const t = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `drawdoll-${t.getFullYear()}${p(t.getMonth() + 1)}${p(t.getDate())}-${p(t.getHours())}${p(t.getMinutes())}${p(t.getSeconds())}.png`;
}
