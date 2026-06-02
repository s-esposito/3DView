import * as THREE from "three";

/** Read a VS Code theme CSS variable as a THREE.Color, with a numeric fallback. */
export function themeColor(cssVar: string, fallback: number): THREE.Color {
  const v = getComputedStyle(document.body).getPropertyValue(cssVar).trim();
  try {
    return v ? new THREE.Color(v) : new THREE.Color(fallback);
  } catch {
    return new THREE.Color(fallback);
  }
}
