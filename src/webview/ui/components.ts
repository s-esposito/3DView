// Small, stateless DOM builders shared by the control panel and popup. They only
// produce elements with class names; all styling lives in styles.ts.

/** Adaptive number formatting for slider readouts. */
export function fmtNum(v: number): string {
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
  const wrap = document.createElement("div");
  wrap.className = "viewer-slider";
  const head = document.createElement("div");
  head.className = "viewer-slider-head";
  const caption = document.createElement("span");
  caption.textContent = label;
  const val = document.createElement("span");
  val.className = "viewer-slider-val";
  val.textContent = fmtNum(value);
  head.append(caption, val);
  const input = document.createElement("input");
  input.type = "range";
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  input.addEventListener("input", () => {
    const v = Number(input.value);
    val.textContent = fmtNum(v);
    onInput(v);
  });
  wrap.append(head, input);
  return wrap;
}

export function button(label: string, onClick: () => void): HTMLButtonElement {
  const el = document.createElement("button");
  el.className = "viewer-btn";
  el.textContent = label;
  el.addEventListener("click", onClick);
  return el;
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
