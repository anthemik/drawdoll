type Attrs = Record<string, string | number | boolean | EventListener | undefined>;

/** Tiny DOM builder: h('div', { class: 'x', onclick: fn }, 'text', child). */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = String(v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

export interface SliderOpts {
  label: string;
  min: number;
  max: number;
  step?: number;
  value: number;
  def?: number;
  lo?: string;
  hi?: string;
  format?: (v: number) => string;
  onInput: (v: number) => void;
  onCommit?: (v: number) => void;
}

export interface Slider {
  el: HTMLElement;
  set(v: number): void;
}

/** Labelled range slider. Tapping the value readout resets it to its default. */
export function slider(o: SliderOpts): Slider {
  const fmt = o.format ?? ((v: number) => `${Math.round(v)}°`);
  const input = h('input', { type: 'range', min: o.min, max: o.max, step: o.step ?? 1, value: o.value });
  const readout = h('button', { class: 'readout', title: o.def !== undefined ? 'Tap to reset' : undefined }, fmt(o.value));
  const fill = () => {
    const t = ((Number(input.value) - o.min) / (o.max - o.min)) * 100;
    input.style.setProperty('--fill', `${t}%`);
  };
  input.addEventListener('input', () => {
    const v = Number(input.value);
    readout.textContent = fmt(v);
    fill();
    o.onInput(v);
  });
  input.addEventListener('change', () => o.onCommit?.(Number(input.value)));
  readout.addEventListener('click', () => {
    if (o.def === undefined) return;
    input.value = String(o.def);
    readout.textContent = fmt(o.def);
    fill();
    o.onInput(o.def);
    o.onCommit?.(o.def);
  });
  fill();
  const el = h(
    'div',
    { class: 'slider' },
    h('div', { class: 'slider-head' }, h('span', { class: 'slider-label' }, o.label), readout),
    input,
    o.lo || o.hi ? h('div', { class: 'slider-ends' }, h('span', {}, o.lo ?? ''), h('span', {}, o.hi ?? '')) : null,
  );
  return {
    el,
    set(v: number) {
      input.value = String(v);
      readout.textContent = fmt(v);
      fill();
    },
  };
}

export function toggle(label: string, value: boolean, onChange: (v: boolean) => void): HTMLElement {
  const input = h('input', { type: 'checkbox' });
  input.checked = value;
  input.addEventListener('change', () => onChange(input.checked));
  return h('label', { class: 'toggle' }, h('span', {}, label), input, h('span', { class: 'switch' }));
}

export function segmented<T extends string>(options: { value: T; label: string }[], value: T, onChange: (v: T) => void) {
  const el = h('div', { class: 'segmented' });
  const buttons = options.map((o) => {
    const b = h('button', { class: o.value === value ? 'on' : '' }, o.label);
    b.addEventListener('click', () => {
      for (const x of buttons) x.classList.remove('on');
      b.classList.add('on');
      onChange(o.value);
    });
    el.append(b);
    return b;
  });
  return el;
}

export function section(title: string, ...children: (Node | null | false)[]) {
  return h('section', { class: 'group' }, h('h3', {}, title), ...children);
}
