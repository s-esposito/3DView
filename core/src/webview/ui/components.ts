// Small, stateless DOM builders shared by the control panel and popup. They only
// produce elements with class names; all styling lives in styles.ts.

/** Adaptive number formatting for slider readouts. */
function fmtNum(v: number): string {
  if (v === 0) {
    return "0";
  }
  const a = Math.abs(v);
  const decimals = a < 0.1 ? 4 : a < 10 ? 2 : 1;
  return v.toFixed(decimals);
}

export function section(title: string, children: HTMLElement[]): HTMLElement {
  const sec = document.createElement("div");
  sec.className = "viewer-section";
  const heading = document.createElement("div");
  heading.className = "viewer-section-title";
  heading.textContent = title;
  sec.append(heading, ...children);
  return sec;
}

/**
 * A sub-menu: a section whose title (a button with a chevron) folds its rows away.
 * The open state is the caller's to keep across panel re-renders; a click flips it
 * in place and reports the new state, so no re-render is needed.
 */
export function subsection(
  title: string,
  open: boolean,
  onToggle: (open: boolean) => void,
  children: HTMLElement[]
): HTMLElement {
  const sec = document.createElement("div");
  sec.className = open ? "viewer-section viewer-subsection" : "viewer-section viewer-subsection collapsed";
  const heading = document.createElement("button");
  heading.type = "button";
  heading.className = "viewer-section-title viewer-subsection-title";
  heading.setAttribute("aria-expanded", String(open));
  const chevron = document.createElement("span");
  chevron.className = "viewer-chevron";
  chevron.textContent = "▾";
  chevron.setAttribute("aria-hidden", "true");
  const label = document.createElement("span");
  label.textContent = title;
  heading.append(chevron, label);
  const body = document.createElement("div");
  body.className = "viewer-subsection-body";
  body.append(...children);
  heading.addEventListener("click", () => {
    const nowOpen = !sec.classList.toggle("collapsed");
    heading.setAttribute("aria-expanded", String(nowOpen));
    onToggle(nowOpen);
  });
  sec.append(heading, body);
  return sec;
}

export function hint(text: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "viewer-hint";
  el.textContent = text;
  return el;
}

export function checkbox(
  label: string,
  checked: boolean,
  onChange: (checked: boolean) => void
): HTMLElement {
  const wrap = document.createElement("label");
  wrap.className = "viewer-row";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = checked;
  input.addEventListener("change", () => onChange(input.checked));
  const span = document.createElement("span");
  span.textContent = label;
  wrap.append(input, span);
  return wrap;
}

export function slider(
  label: string,
  min: number,
  max: number,
  step: number,
  value: number,
  onInput: (v: number) => void
): HTMLElement {
  // One row: caption · track · readout. A whole-number step reads as an integer
  // ("24", not "24.0"); anything finer keeps the adaptive precision.
  const fmt = Number.isInteger(step) ? (v: number) => String(Math.round(v)) : fmtNum;
  const wrap = document.createElement("div");
  wrap.className = "viewer-slider";
  const caption = document.createElement("span");
  caption.className = "viewer-slider-label";
  caption.textContent = label;
  caption.title = label; // the column can ellipsize a long caption
  const val = document.createElement("span");
  val.className = "viewer-slider-val";
  val.textContent = fmt(value);
  const input = document.createElement("input");
  input.type = "range";
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  input.addEventListener("input", () => {
    const v = Number(input.value);
    val.textContent = fmt(v);
    onInput(v);
  });
  input.setAttribute("aria-label", label);
  wrap.append(caption, input, val);
  return wrap;
}

/**
 * A label + native color swatch. Works in numbers (0xRRGGBB) so the Viewer's
 * contract stays numeric; the hex-string conversion the `<input type=color>`
 * needs is encapsulated here. Fires live while the user drags the picker.
 */
export function colorRow(
  label: string,
  value: number,
  onInput: (value: number) => void
): HTMLElement {
  const wrap = document.createElement("label");
  wrap.className = "viewer-colorrow";
  const caption = document.createElement("span");
  caption.textContent = label;
  const input = document.createElement("input");
  input.type = "color";
  input.className = "viewer-color";
  input.value = numToHex(value);
  input.setAttribute("aria-label", label);
  input.addEventListener("input", () => onInput(hexToNum(input.value)));
  wrap.append(caption, input);
  return wrap;
}

/** 0xRRGGBB → "#rrggbb" for a color input. */
function numToHex(n: number): string {
  return "#" + (n & 0xffffff).toString(16).padStart(6, "0");
}

/** "#rrggbb" → 0xRRGGBB. */
function hexToNum(s: string): number {
  return parseInt(s.replace(/^#/, ""), 16) || 0;
}

/** A full-width button; `quiet` drops the accent fill, for secondary actions. */
export function button(label: string, onClick: () => void, quiet = false): HTMLButtonElement {
  const el = document.createElement("button");
  el.className = quiet ? "viewer-btn quiet" : "viewer-btn";
  el.textContent = label;
  el.addEventListener("click", onClick);
  return el;
}

/**
 * A row of mutually exclusive text options (a small radio group). Updates its own
 * pressed state in place — like the theme switcher — so picking one doesn't need a
 * panel re-render.
 */
export function choiceRow<T extends string>(
  options: Array<{ label: string; value: T; title?: string }>,
  value: T,
  onChange: (value: T) => void
): HTMLElement {
  const row = document.createElement("div");
  row.className = "viewer-scale-row";
  row.setAttribute("role", "radiogroup");
  const buttons: HTMLButtonElement[] = [];
  for (const opt of options) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = opt.value === value ? "viewer-scale-btn selected" : "viewer-scale-btn";
    btn.textContent = opt.label;
    btn.setAttribute("role", "radio");
    btn.setAttribute("aria-checked", String(opt.value === value));
    if (opt.title) {
      btn.title = opt.title;
    }
    btn.addEventListener("click", () => {
      if (btn.classList.contains("selected")) {
        return;
      }
      for (const other of buttons) {
        other.classList.toggle("selected", other === btn);
        other.setAttribute("aria-checked", String(other === btn));
      }
      onChange(opt.value);
    });
    buttons.push(btn);
    row.append(btn);
  }
  return row;
}

/** A compact icon/symbol button (e.g. "+" or "✕"). */
export function iconButton(
  symbol: string,
  title: string,
  onClick: () => void
): HTMLButtonElement {
  const el = document.createElement("button");
  el.className = "viewer-iconbtn";
  el.textContent = symbol;
  el.title = title;
  el.addEventListener("click", onClick);
  return el;
}

/** An icon button that opens a small popup menu; closes on outside click. */
export function menuButton(
  symbol: string,
  title: string,
  entries: Array<{ label: string; onClick: () => void }>
): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "viewer-menuwrap";
  const menu = document.createElement("div");
  menu.className = "viewer-menu";
  menu.style.display = "none";

  const close = () => {
    menu.style.display = "none";
    document.removeEventListener("click", close);
  };
  for (const entry of entries) {
    const item = document.createElement("button");
    item.className = "viewer-menu-item";
    item.textContent = entry.label;
    item.addEventListener("click", (e) => {
      e.stopPropagation();
      close();
      entry.onClick();
    });
    menu.appendChild(item);
  }

  const trigger = iconButton(symbol, title, () => {});
  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    const opening = menu.style.display === "none";
    menu.style.display = opening ? "block" : "none";
    if (opening) {
      // Defer so this same click doesn't immediately close it.
      setTimeout(() => document.addEventListener("click", close), 0);
    }
  });

  wrap.append(trigger, menu);
  return wrap;
}

/**
 * A labelled X/Y/Z number row (the Blender transform-field layout). Reports the
 * whole triple on every edit, and never re-renders itself — the caller keeps the
 * inputs so typing is never interrupted.
 */
export function vectorRow(
  label: string,
  values: [number, number, number],
  step: number,
  onInput: (values: [number, number, number]) => void
): HTMLElement {
  const row = document.createElement("div");
  row.className = "viewer-xform-row";
  const caption = document.createElement("span");
  caption.className = "viewer-xform-label";
  caption.textContent = label;
  row.append(caption);

  const current: [number, number, number] = [...values];
  (["X", "Y", "Z"] as const).forEach((axis, i) => {
    const input = document.createElement("input");
    input.type = "number";
    input.className = "viewer-xform-num";
    input.step = String(step);
    input.value = fmtField(values[i]);
    input.title = `${label} ${axis}`;
    input.setAttribute("aria-label", `${label} ${axis}`);
    input.addEventListener("input", () => {
      const v = Number(input.value);
      if (!Number.isFinite(v)) {
        return; // mid-edit ("-", "1e") — wait for a complete number
      }
      current[i] = v;
      onInput([...current]);
    });
    row.append(input);
  });
  return row;
}

/** Editable-field formatting: enough precision to round-trip what the user typed
 *  (unlike `fmtNum`, which rounds hard for read-only readouts), no trailing zeros. */
function fmtField(v: number): string {
  return String(Number(v.toFixed(4)));
}

/** A label/value row used by the info popup. */
export function keyValue(label: string, value: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "viewer-kv";
  const k = document.createElement("span");
  k.className = "k";
  k.textContent = label;
  const v = document.createElement("span");
  v.className = "v";
  v.textContent = value;
  el.append(k, v);
  return el;
}
