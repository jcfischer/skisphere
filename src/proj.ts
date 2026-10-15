/**
 * proj.ts — the two sky projections the planetarium draws with.
 *
 * Both are azimuthal and centred on the observer's zenith, so the horizon is the
 * unit circle and a straight line through the centre keeps its compass bearing —
 * which is what makes a fisheye sky map readable.
 *
 *   stereographic  ("fisheye")  r = tan(z/2) / tan(45°)   — conformal, star pairs
 *                              near the zenith stay visually spread out
 *   equidistant                 r = z / 90°               — angular distance from
 *                              the zenith reads off the ruler
 *
 * `z` is zenith distance (90° − altitude); r is normalised so the horizon sits at r = 1
 * and is then scaled by the view radius in CSS pixels.
 */
import { D2R } from "./astro";

export type ProjectionMode = "stereographic" | "equidistant";

export interface View {
  /** centre of the visible hemisphere, CSS px */
  cx: number;
  cy: number;
  /** radius of the horizon circle, CSS px */
  radius: number;
  /** compass bearing placed at the top of the circle, degrees (0 = north up) */
  rotation: number;
  mode: ProjectionMode;
  /** true when the observer's feet point up: southern convention keeps north up but flips nothing else */
  flip?: boolean;
}

/** Normalised projection radius for an altitude, 1 at the horizon, 0 at the zenith. */
export function zenithRadius(altDeg: number, mode: ProjectionMode): number {
  const z = (90 - altDeg) * D2R;
  return mode === "equidistant" ? z / (Math.PI / 2) : Math.tan(z / 2);
}

/** Inverse of {@link zenithRadius}: altitude from a normalised radius. */
export function altitudeOfRadius(r: number, mode: ProjectionMode): number {
  if (mode === "equidistant") return 90 - r * 90;
  return 90 - 2 * Math.atan(r) / D2R;
}

export interface Placement {
  x: number;
  y: number;
  /** true when inside the horizon circle */
  inside: boolean;
  /** projected scale at this point: how much a small angle is stretched, px/deg */
  scale: number;
}

export function place(altDeg: number, azDeg: number, v: View): Placement {
  const r = zenithRadius(altDeg, v.mode) * v.radius;
  const theta = (azDeg - v.rotation) * D2R;
  const sin = Math.sin(theta);
  const cos = Math.cos(theta);
  // d(r)/d(z): how fast the projected radius grows with zenith distance, in px per radian
  const halfZ = ((90 - altDeg) * D2R) / 2;
  const drad =
    v.mode === "equidistant" ? v.radius / (Math.PI / 2) : v.radius / (2 * Math.cos(halfZ) ** 2);
  return {
    x: v.cx + r * sin,
    y: v.cy - r * cos,
    inside: r <= v.radius * 1.0005,
    scale: drad * D2R, // px per degree
  };
}

/** Altitude/azimuth at a screen point, for hit-testing and the "point at the sky" cursor. */
export function read(x: number, y: number, v: View): { alt: number; az: number } {
  const dx = x - v.cx;
  const dy = y - v.cy;
  const r = Math.hypot(dx, dy) / v.radius;
  const az = (Math.atan2(dx, -dy) / D2R + v.rotation + 360) % 360;
  return { alt: altitudeOfRadius(r, v.mode), az };
}

/** Sky degrees per pixel at the horizon, for the scale readout. */
export function horizonScale(v: View): number {
  return place(0, v.rotation, v).scale;
}

/**
 * Angular size → pixel size at a given altitude. Planets and the Moon are drawn to
 * scale when this exceeds a couple of pixels, otherwise as a fixed glyph.
 */
export function angularSize(arcmin: number, altDeg: number, v: View): number {
  return place(altDeg, 0, v).scale * (arcmin / 60);
}