import { Side } from './figure';
import { PadKind, clampReach, maxReach } from './joints';

/**
 * Direction pad for ball joints (shoulder, hip). It is a map of every way the
 * limb can point: the centre is hanging straight down, the rim is straight up,
 * up the pad is forward. Out is drawn on the doll's own side as seen from the
 * front, so the right arm's "Out" is on the left of the pad.
 */
export class SwingPad {
  readonly el: HTMLCanvasElement;
  private fwd = 0;
  private out = 0;
  private dragging = false;

  constructor(
    private kind: PadKind,
    private side: Side,
    private onChange: (fwd: number, out: number, commit: boolean) => void,
  ) {
    this.el = document.createElement('canvas');
    this.el.className = 'pad';
    this.el.addEventListener('pointerdown', (e) => {
      this.dragging = true;
      this.el.setPointerCapture(e.pointerId);
      this.handle(e, false);
    });
    this.el.addEventListener('pointermove', (e) => {
      if (this.dragging) this.handle(e, false);
    });
    const end = (e: PointerEvent) => {
      if (!this.dragging) return;
      this.dragging = false;
      this.handle(e, true);
    };
    this.el.addEventListener('pointerup', end);
    this.el.addEventListener('pointercancel', end);
    new ResizeObserver(() => this.draw()).observe(this.el);
  }

  set(fwd: number, out: number) {
    this.fwd = fwd;
    this.out = out;
    this.draw();
  }

  private get outSign() {
    return this.side === 'L' ? 1 : -1;
  }

  private geom() {
    const w = this.el.clientWidth;
    const h = this.el.clientHeight;
    const R = Math.min(w, h) / 2 - 22;
    return { w, h, cx: w / 2, cy: h / 2, R };
  }

  private handle(e: PointerEvent, commit: boolean) {
    const rect = this.el.getBoundingClientRect();
    const { cx, cy, R } = this.geom();
    const px = e.clientX - rect.left - cx;
    const py = e.clientY - rect.top - cy;
    const [fwd, out] = clampReach(this.kind, (-py / R) * 180, ((px * this.outSign) / R) * 180);
    this.fwd = Math.round(fwd);
    this.out = Math.round(out);
    this.draw();
    this.onChange(this.fwd, this.out, commit);
  }

  private toScreen(fwd: number, out: number) {
    const { cx, cy, R } = this.geom();
    return [cx + ((out * this.outSign) / 180) * R, cy - (fwd / 180) * R];
  }

  draw() {
    const dpr = window.devicePixelRatio || 1;
    const { w, h, cx, cy, R } = this.geom();
    if (w === 0) return;
    if (this.el.width !== Math.round(w * dpr)) {
      this.el.width = Math.round(w * dpr);
      this.el.height = Math.round(h * dpr);
    }
    const g = this.el.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const css = getComputedStyle(this.el);
    const fg = css.getPropertyValue('--pad-fg').trim() || '#ccc';
    const dim = css.getPropertyValue('--pad-dim').trim() || '#555';
    const region = css.getPropertyValue('--pad-region').trim() || 'rgba(80,120,255,0.18)';
    const accent = css.getPropertyValue('--accent').trim() || '#4f7cff';

    // Elevation rings at 45° steps; the outer ring is straight up.
    g.strokeStyle = dim;
    g.lineWidth = 1;
    for (let k = 1; k <= 4; k++) {
      g.beginPath();
      g.arc(cx, cy, (R * k) / 4, 0, Math.PI * 2);
      g.stroke();
    }
    g.beginPath();
    g.moveTo(cx - R, cy);
    g.lineTo(cx + R, cy);
    g.moveTo(cx, cy - R);
    g.lineTo(cx, cy + R);
    g.stroke();

    // Reachable region.
    g.beginPath();
    for (let a = -180; a <= 180; a += 3) {
      const e = maxReach(this.kind, a);
      const r = a * (Math.PI / 180);
      const [x, y] = this.toScreen(e * Math.cos(r), e * Math.sin(r));
      if (a === -180) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.closePath();
    g.fillStyle = region;
    g.fill();
    g.strokeStyle = accent;
    g.globalAlpha = 0.6;
    g.stroke();
    g.globalAlpha = 1;

    g.fillStyle = fg;
    g.font = '600 11px system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('FORWARD', cx, cy - R - 11);
    g.fillText('BACK', cx, cy + R + 11);
    const outX = cx + this.outSign * (R + 4);
    const inX = cx - this.outSign * (R + 4);
    g.save();
    g.translate(outX, cy);
    g.rotate((this.outSign * Math.PI) / 2);
    g.fillText('OUT', 0, -8);
    g.restore();
    g.save();
    g.translate(inX, cy);
    g.rotate((-this.outSign * Math.PI) / 2);
    g.fillText('IN', 0, -8);
    g.restore();
    g.fillStyle = dim;
    g.font = '10px system-ui, sans-serif';
    g.fillText('down', cx + 14, cy + 8);
    g.fillText('level', cx + 14, cy - R / 2 + 8);

    // Current direction.
    const [x, y] = this.toScreen(this.fwd, this.out);
    g.strokeStyle = accent;
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(cx, cy);
    g.lineTo(x, y);
    g.stroke();
    g.fillStyle = accent;
    g.beginPath();
    g.arc(x, y, 9, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#fff';
    g.beginPath();
    g.arc(x, y, 3.5, 0, Math.PI * 2);
    g.fill();
  }
}
