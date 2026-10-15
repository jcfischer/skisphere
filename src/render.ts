/**
 * render.ts — canvas painting for the planetarium.
 *
 * Draw order is chosen so that faint things sit under bright things:
 *   sky wash → twilight glow → ground → Milky Way → boundaries → stick figures →
 *   reference circles → deep-sky markers → stars → planet/Sun/Moon → labels → selection
 *
 * Everything visible is driven by altitude/azimuth from {@link ./skyview}, projected by
 * {@link ./proj}; nothing here knows about right ascension.
 */
import { Body, Ecliptic, GeoVector } from "astronomy-engine";
import { norm360, D2R, R2D } from "./astro";
import { place, type View, type Placement } from "./proj";
import { apparentAlt, type SkyState } from "./skyview";
import { constellations, starNameIdx, starNames, starPositions, dsoMeta, dsoData } from "./data/sky.generated";

export interface Layers {
  milkyWay: boolean;
  bounds: boolean;
  lines: boolean;
  constellationLabels: boolean;
  stars: boolean;
  starNames: boolean;
  dsos: boolean;
  bodies: boolean;
  bodyLabels: boolean;
  ecliptic: boolean;
  equator: boolean;
  grid: boolean;
  refraction: boolean;
  twinkle: boolean;
}

export const DEFAULT_LAYERS: Layers = {
  milkyWay: true,
  bounds: false,
  lines: true,
  constellationLabels: true,
  stars: true,
  starNames: true,
  dsos: true,
  bodies: true,
  bodyLabels: true,
  ecliptic: false,
  equator: false,
  grid: false,
  refraction: true,
  twinkle: false,
};

export type Selection =
  | { kind: "star"; index: number }
  | { kind: "dso"; index: number }
  | { kind: "body"; name: string }
  | { kind: "constellation"; index: number }
  | null;

export interface DrawOptions {
  layers: Layers;
  /** include stars fainter than this magnitude */
  magLimit: number;
  /** label stars brighter than this magnitude */
  labelLimit: number;
  selection?: Selection;
  hover?: Selection;
  /** ms timestamp used for twinkle; pass 0 to freeze */
  clock?: number;
}

const BODY_COLOR: Record<string, { color: string; symbol: string }> = {
  Sun: { color: "#ffd75e", symbol: "☉" },
  Moon: { color: "#f3f1e7", symbol: "☽" },
  Mercury: { color: "#c8b8a6", symbol: "☿" },
  Venus: { color: "#f6e6c8", symbol: "♀" },
  Mars: { color: "#e8735a", symbol: "♂" },
  Jupiter: { color: "#e3c9a0", symbol: "♃" },
  Saturn: { color: "#e6d8a8", symbol: "♄" },
  Uranus: { color: "#9fd8d8", symbol: "♅" },
  Neptune: { color: "#7fa8e8", symbol: "♆" },
  Pluto: { color: "#c3b39c", symbol: "♇" },
};

/** B−V → RGB, linear interpolation through anchor points of the visual colour index. */
const BV_ANCHORS: [number, [number, number, number]][] = [
  [-0.35, [150, 170, 255]],
  [-0.1, [190, 205, 255]],
  [0.0, [242, 244, 255]],
  [0.3, [255, 248, 240]],
  [0.6, [255, 236, 210]],
  [1.0, [255, 214, 168]],
  [1.5, [255, 186, 122]],
  [2.2, [255, 152, 92]],
  [3.2, [255, 124, 74]],
];

/** Solar colour for a star with no usable colour index. */
const BV_FALLBACK = 0.6;

/**
 * Colour for a Johnson B−V index, interpolated between anchor colours.
 *
 * The index is clamped into the anchor table first: a few catalogue stars (carbon stars and
 * long-period variables) sit redder than the reddest anchor, and interpolating *past* the
 * table produced channel values over 255 — an invalid CSS colour, which a canvas answers
 * by quietly keeping the previous fillStyle.
 */
export function bvColor(bv: number): string {
  const first = BV_ANCHORS[0]!;
  const last = BV_ANCHORS[BV_ANCHORS.length - 1]!;
  const index = Number.isFinite(bv) ? Math.max(first[0], Math.min(last[0], bv)) : BV_FALLBACK;
  let a = first;
  let b = last;
  for (let i = 0; i < BV_ANCHORS.length - 1; i++) {
    if (index >= BV_ANCHORS[i]![0] && index <= BV_ANCHORS[i + 1]![0]) {
      a = BV_ANCHORS[i]!;
      b = BV_ANCHORS[i + 1]!;
      break;
    }
  }
  const t = b[0] === a[0] ? 0 : (index - a[0]) / (b[0] - a[0]);
  const mix = (i: 0 | 1 | 2) => Math.round(a[1][i]! + (b[1][i]! - a[1][i]!) * t);
  return `rgb(${mix(0)},${mix(1)},${mix(2)})`;
}

const STAR_COLOR_CACHE = new Map<number, string>();
function starColor(bv: number): string {
  const key = Math.round(bv * 20);
  let c = STAR_COLOR_CACHE.get(key);
  if (!c) {
    c = bvColor(key / 20);
    STAR_COLOR_CACHE.set(key, c);
  }
  return c;
}

/** Glyph radius for a magnitude: Vega ≈ 2.8 px, Sirius ≈ 8 px, a 6th-mag speck ≈ 0.6 px. */
export function starRadius(mag: number): number {
  return Math.min(11, Math.max(0.35, 0.4 + 2.4 * Math.pow(10, -0.2 * mag)));
}

/** 0 at astronomical twilight's end, 1 in full daylight. Drives every fade in the scene. */
export function darknessFromSun(sunAlt: number): number {
  if (sunAlt > -0.833) return 0;
  if (sunAlt > -6) return (0 - sunAlt - 0.833) / 5.167 * 0.25;
  if (sunAlt > -12) return 0.25 + (-sunAlt - 6) / 6 * 0.35;
  if (sunAlt > -18) return 0.6 + (-sunAlt - 12) / 6 * 0.4;
  return 1;
}

interface SkyPalette {
  zenith: string;
  horizon: string;
  ground: string;
  groundEdge: string;
  starAlpha: number;
  lineAlpha: number;
  glowAlpha: number;
}

export interface SkyPaletteShape extends SkyPalette {}

export function palette(sunAlt: number, darkness: number): SkyPaletteShape {
  const lerp = (a: number[], b: number[], t: number) => a.map((v, i) => Math.round(v + (b[i]! - v) * t));
  const rgb = (c: number[]) => `rgb(${c[0]},${c[1]},${c[2]})`;
  const nightZenith = [4, 7, 18];
  const nightHorizon = [14, 20, 40];
  const astroHorizon = [24, 32, 62];
  const nauticalHorizon = [46, 62, 104];
  const civilHorizon = [104, 132, 178];
  const dayHorizon = [168, 202, 234];
  const dayZenith = [88, 140, 208];
  let horizon: number[];
  let zenith: number[];
  if (sunAlt > -0.833) {
    const t = Math.min(1, (sunAlt + 6) / 6);
    horizon = lerp(civilHorizon, dayHorizon, t);
    zenith = lerp([70, 104, 160], dayZenith, t);
  } else if (sunAlt > -6) {
    const t = (-sunAlt - 0.833) / 5.167;
    horizon = lerp(nauticalHorizon, civilHorizon, t);
    zenith = lerp([28, 40, 78], [70, 104, 160], t);
  } else if (sunAlt > -12) {
    const t = (-sunAlt - 6) / 6;
    horizon = lerp(astroHorizon, nauticalHorizon, t);
    zenith = lerp([12, 18, 46], [28, 40, 78], t);
  } else if (sunAlt > -18) {
    const t = (-sunAlt - 12) / 6;
    horizon = lerp(nightHorizon, astroHorizon, t);
    zenith = lerp(nightZenith, [12, 18, 46], t);
  } else {
    horizon = nightHorizon;
    zenith = nightZenith;
  }
  return {
    zenith: rgb(zenith),
    horizon: rgb(horizon),
    ground: rgb(lerp([6, 8, 12], [34, 30, 26], 1 - darkness * 0.8)),
    groundEdge: rgb(lerp([16, 18, 24], [120, 108, 86], 1 - darkness)),
    starAlpha: darkness,
    lineAlpha: 0.25 + 0.55 * darkness,
    glowAlpha: sunAlt > -12 ? Math.max(0, 0.55 * (1 - darkness)) : 0,
  };
}

function drawSkyWash(ctx: CanvasRenderingContext2D, view: View, pal: SkyPalette) {
  const outer = Math.max(1, view.radius * 1.05);
  const g = ctx.createRadialGradient(view.cx, view.cy, 0, view.cx, view.cy, outer);
  g.addColorStop(0, pal.zenith);
  g.addColorStop(0.75, pal.zenith);
  g.addColorStop(1, pal.horizon);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
}

/** Brightening around the Sun's azimuth: the twilight band and the daytime dome. */
function drawTwilightGlow(ctx: CanvasRenderingContext2D, view: View, sky: SkyState, pal: SkyPalette) {
  if (pal.glowAlpha <= 0.01) return;
  const sun = place(apparentAlt(sky.sun.alt), sky.sun.az, view);
  const r = Math.max(1, view.radius * 1.15);
  const g = ctx.createRadialGradient(sun.x, sun.y, 0, sun.x, sun.y, r);
  const strength = pal.glowAlpha;
  g.addColorStop(0, `rgba(255, 190, 120, ${(0.55 * strength).toFixed(3)})`);
  g.addColorStop(0.35, `rgba(220, 150, 110, ${(0.22 * strength).toFixed(3)})`);
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
}

function clipToHorizon(ctx: CanvasRenderingContext2D, view: View) {
  ctx.beginPath();
  ctx.arc(view.cx, view.cy, view.radius, 0, Math.PI * 2);
  ctx.clip();
}

function drawGround(ctx: CanvasRenderingContext2D, view: View, pal: SkyPalette, dpr: number) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.arc(view.cx, view.cy, view.radius, 0, Math.PI * 2, true);
  ctx.fillStyle = pal.ground;
  ctx.fill("evenodd");
  ctx.restore();
  ctx.beginPath();
  ctx.arc(view.cx, view.cy, view.radius, 0, Math.PI * 2);
  ctx.strokeStyle = pal.groundEdge;
  ctx.lineWidth = 1.4 * dpr;
  ctx.stroke();
}

function pathForSky(
  ctx: CanvasRenderingContext2D,
  altaz: Float32Array,
  index: Int32Array,
  view: View,
  refract: boolean,
  skip: (tag: number) => boolean = () => false,
) {
  for (let p = 0; p < index.length; p += 3) {
    const start = index[p]!;
    const count = index[p + 1]!;
    const tag = index[p + 2]!;
    if (skip(tag)) continue;
    ctx.beginPath();
    let open = false;
    for (let i = 0; i < count; i++) {
      const alt = altaz[(start + i) * 2]!;
      const az = altaz[(start + i) * 2 + 1]!;
      if (alt < -3) {
        open = false;
        continue;
      }
      const pt = place(refract ? apparentAlt(alt) : alt, az, view);
      if (!open) {
        ctx.moveTo(pt.x, pt.y);
        open = true;
      } else ctx.lineTo(pt.x, pt.y);
    }
    ctx.stroke();
  }
}

function drawMilkyWay(ctx: CanvasRenderingContext2D, sky: SkyState, view: View, refract: boolean, stats: SceneStats) {
  const alpha = [0, 0.05, 0.07, 0.1, 0.14, 0.2];
  const { altaz, index } = sky.milkyWay;
  ctx.save();
  ctx.fillStyle = `rgba(198, 214, 255, ${1})`;
  for (let p = 0; p < index.length; p += 3) {
    const start = index[p]!;
    const count = index[p + 1]!;
    const level = -index[p + 2]! - 1;
    ctx.globalAlpha = alpha[level] ?? 0.05;
    ctx.beginPath();
    let open = false;
    for (let i = 0; i < count; i++) {
      const alt = altaz[(start + i) * 2]!;
      const az = altaz[(start + i) * 2 + 1]!;
      if (alt < -6) {
        open = false;
        continue;
      }
      const pt = place(refract ? apparentAlt(alt) : alt, az, view);
      if (!open) {
        ctx.moveTo(pt.x, pt.y);
        open = true;
      } else ctx.lineTo(pt.x, pt.y);
    }
    ctx.closePath();
    ctx.fill();
    stats.milkyWayPolygons++;
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

const DSO_GLYPH: Record<string, (ctx: CanvasRenderingContext2D, x: number, y: number, s: number) => void> = {
  gc: (c, x, y, s) => {
    c.beginPath();
    c.arc(x, y, s * 0.7, 0, Math.PI * 2);
    c.stroke();
    c.beginPath();
    c.moveTo(x - s * 0.35, y);
    c.lineTo(x + s * 0.35, y);
    c.moveTo(x, y - s * 0.35);
    c.lineTo(x, y + s * 0.35);
    c.stroke();
  },
  oc: (c, x, y, s) => {
    c.beginPath();
    c.moveTo(x - s, y + s * 0.6);
    c.lineTo(x + s, y + s * 0.6);
    c.lineTo(x, y - s * 0.8);
    c.closePath();
    c.stroke();
  },
  snr: (c, x, y, s) => {
    c.beginPath();
    c.arc(x, y, s * 0.8, 0, Math.PI * 2);
    c.moveTo(x - s * 1.2, y);
    c.lineTo(x + s * 1.2, y);
    c.stroke();
  },
  pn: (c, x, y, s) => {
    c.beginPath();
    c.moveTo(x - s, y);
    c.lineTo(x + s, y);
    c.moveTo(x - s * 0.6, y - s * 0.6);
    c.lineTo(x + s * 0.6, y - s * 0.6);
    c.moveTo(x - s * 0.6, y + s * 0.6);
    c.lineTo(x + s * 0.6, y + s * 0.6);
    c.stroke();
  },
  g: (c, x, y, s) => {
    c.beginPath();
    c.ellipse(x, y, s, s * 0.45, -0.5, 0, Math.PI * 2);
    c.stroke();
  },
};

const DSO_DEFAULT = (c: CanvasRenderingContext2D, x: number, y: number, s: number) => {
  c.beginPath();
  c.rect(x - s * 0.7, y - s * 0.7, s * 1.4, s * 1.4);
  c.stroke();
};

function drawPaths(
  ctx: CanvasRenderingContext2D,
  sky: SkyState,
  view: View,
  layers: Layers,
  refract: boolean,
  stats: SceneStats,
) {
  const countPaths = (index: Int32Array, key: "figurePaths" | "boundaryPaths") => {
    for (let p = 0; p < index.length; p += 3) stats[key]++;
  };
  if (layers.bounds) {
    countPaths(sky.bounds.index, "boundaryPaths");
    ctx.strokeStyle = "rgba(150, 170, 210, 0.28)";
    ctx.lineWidth = 0.7;
    ctx.setLineDash([3, 4]);
    pathForSky(ctx, sky.bounds.altaz, sky.bounds.index, view, refract);
    ctx.setLineDash([]);
  }
  if (layers.lines) {
    countPaths(sky.lines.index, "figurePaths");
    ctx.lineCap = "round";
    ctx.strokeStyle = "rgba(120, 170, 235, 0.85)";
    ctx.lineWidth = 1.15;
    pathForSky(ctx, sky.lines.altaz, sky.lines.index, view, refract);
  }
  if (layers.ecliptic) {
    stats.referenceCircles++;
    ctx.strokeStyle = "rgba(235, 190, 90, 0.5)";
    ctx.lineWidth = 0.9;
    ctx.setLineDash([7, 5]);
    strokeReferenceCircle(ctx, sky, view, "ecliptic");
    ctx.setLineDash([]);
  }
  if (layers.equator) {
    stats.referenceCircles++;
    ctx.strokeStyle = "rgba(90, 210, 160, 0.45)";
    ctx.lineWidth = 0.9;
    ctx.setLineDash([4, 6]);
    strokeReferenceCircle(ctx, sky, view, "equator");
    ctx.setLineDash([]);
  }
}

/** Draw the ecliptic or the celestial equator as a sampled of-date polyline. */
function strokeReferenceCircle(ctx: CanvasRenderingContext2D, sky: SkyState, view: View, which: "ecliptic" | "equator") {
  const eps = sky.frame.angles.eps * D2R;
  ctx.beginPath();
  let open = false;
  for (let deg = 0; deg <= 360; deg += 1.5) {
    let ra: number;
    let dec: number;
    if (which === "equator") {
      ra = deg;
      dec = 0;
    } else {
      // ecliptic longitude λ -> equatorial of date, using the true obliquity
      const l = deg * D2R;
      const x = Math.cos(l);
      const y = Math.cos(eps) * Math.sin(l);
      const z = Math.sin(eps) * Math.sin(l);
      ra = norm360(Math.atan2(y, x) * R2D);
      dec = Math.asin(Math.max(-1, Math.min(1, z))) * R2D;
    }
    const h = horizontalOfDate(ra, dec, sky.lat, sky.lst);
    if (h.alt < -4) {
      open = false;
      continue;
    }
    const p = place(h.alt, h.az, view);
    if (!open) {
      ctx.moveTo(p.x, p.y);
      open = true;
    } else ctx.lineTo(p.x, p.y);
  }
  ctx.stroke();
}

function horizontalOfDate(ra: number, dec: number, lat: number, lst: number) {
  const H = (((lst - ra + 540) % 360) - 180) * D2R;
  const phi = lat * D2R;
  const d = dec * D2R;
  const alt = Math.asin(Math.sin(phi) * Math.sin(d) + Math.cos(phi) * Math.cos(d) * Math.cos(H)) * R2D;
  const az = norm360(Math.atan2(-Math.cos(d) * Math.sin(H), Math.sin(d) * Math.cos(phi) - Math.cos(d) * Math.cos(H) * Math.sin(phi)) * R2D);
  return { alt, az };
}

function drawGrid(ctx: CanvasRenderingContext2D, view: View, stats: SceneStats) {
  ctx.save();
  stats.gridLines += 30 + 2;
  ctx.strokeStyle = "rgba(170, 190, 220, 0.22)";
  ctx.fillStyle = "rgba(170, 190, 220, 0.6)";
  ctx.lineWidth = 0.7;
  ctx.font = "10px ui-sans-serif, system-ui, sans-serif";
  for (const alt of [30, 60]) {
    ctx.beginPath();
    let open = false;
    for (let az = 0; az <= 360; az += 3) {
      const p = place(alt, az, view);
      if (!open) {
        ctx.moveTo(p.x, p.y);
        open = true;
      } else ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
    const label = place(alt, view.rotation, view);
    ctx.fillText(`${alt}°`, label.x + 3, label.y - 2);
  }
  for (let az = 0; az < 360; az += 10) {
    ctx.beginPath();
    const a = place(0, az, view);
    const z = place(89.9, az, view);
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(z.x, z.y);
    ctx.stroke();
  }
  ctx.restore();
}

/** Moon disc with the terminator, oriented so the lit limb points at the Sun. */
function drawMoonDisc(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, phase: number, sunX: number, sunY: number) {
  const angle = Math.atan2(sunY - y, sunX - x);
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle + Math.PI / 2);
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(40, 42, 52, 0.9)";
  ctx.fill();
  const k = Math.max(0, Math.min(1, phase));
  const offset = 1 - 2 * k; // -1 full, +1 new
  ctx.beginPath();
  ctx.arc(0, 0, r, -Math.PI / 2, Math.PI / 2, false);
  ctx.ellipse(0, 0, r * Math.abs(offset), r, 0, Math.PI / 2, -Math.PI / 2, offset > 0);
  ctx.closePath();
  ctx.fillStyle = "#f6f3e6";
  ctx.fill();
  ctx.restore();
}

interface LabelBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

function fits(boxes: LabelBox[], b: LabelBox): boolean {
  for (const o of boxes) {
    if (b.x < o.x + o.w && b.x + b.w > o.x && b.y < o.y + o.h && b.y + b.h > o.y) return false;
  }
  return true;
}

export interface SceneContext {
  ctx: CanvasRenderingContext2D;
  view: View;
  sky: SkyState;
  options: DrawOptions;
  dpr: number;
}

/** What one frame actually painted. The checks assert on these instead of guessing from pixels. */
export interface SceneStats {
  starsDrawn: number;
  starLabelsDrawn: number;
  dsosDrawn: number;
  bodiesDrawn: number;
  constellationLabelsDrawn: number;
  figurePaths: number;
  boundaryPaths: number;
  milkyWayPolygons: number;
  referenceCircles: number;
  gridLines: number;
  /** 0 = daylight, 1 = astronomical night */
  darkness: number;
}

export function drawScene({ ctx, view, sky, options, dpr }: SceneContext): SceneStats {
  const { layers } = options;
  const darkness = darknessFromSun(sky.sun.alt);
  const pal = palette(sky.sun.alt, darkness);
  const stats: SceneStats = {
    starsDrawn: 0,
    starLabelsDrawn: 0,
    dsosDrawn: 0,
    bodiesDrawn: 0,
    constellationLabelsDrawn: 0,
    figurePaths: 0,
    boundaryPaths: 0,
    milkyWayPolygons: 0,
    referenceCircles: 0,
    gridLines: 0,
    darkness,
  };

  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawSkyWash(ctx, view, pal);
  ctx.save();
  clipToHorizon(ctx, view);
  drawTwilightGlow(ctx, view, sky, pal);
  if (layers.milkyWay) drawMilkyWay(ctx, sky, view, layers.refraction, stats);
  ctx.restore();

  drawGround(ctx, view, pal, dpr);

  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  clipToHorizon(ctx, view);

  const lineAlpha = pal.lineAlpha;
  ctx.globalAlpha = lineAlpha;
  drawPaths(ctx, sky, view, layers, layers.refraction, stats);
  ctx.globalAlpha = 1;

  if (layers.grid) drawGrid(ctx, view, stats);

  // --- deep-sky markers
  if (layers.dsos && darkness > 0.25) {
    ctx.strokeStyle = `rgba(150, 200, 170, ${(0.35 + 0.5 * darkness).toFixed(2)})`;
    ctx.lineWidth = 0.9;
    for (let i = 0; i < dsoMeta.length; i++) {
      const alt = sky.dsos[i * 2]!;
      if (alt < -1) continue;
      const meta = dsoMeta[i]!;
      if (meta.mag > options.magLimit + 3) continue;
      const p = place(layers.refraction ? apparentAlt(alt) : alt, sky.dsos[i * 2 + 1]!, view);
      const s = Math.max(2.6, Math.min(7, (dsoData[i * 4 + 3] ?? 4) / 6));
      (DSO_GLYPH[meta.type] ?? DSO_DEFAULT)(ctx, p.x, p.y, s);
      stats.dsosDrawn++;
    }
  }

  // --- stars
  if (layers.stars) {
    const starAlpha = Math.max(0, pal.starAlpha);
    if (starAlpha > 0.02) {
      const boxes: LabelBox[] = [];
      const clock = options.clock ?? 0;
      for (let i = 0; i < sky.stars.length / 2; i++) {
        const alt = sky.stars[i * 2]!;
        if (alt < -0.6) continue;
        const mag = starPositions[i * 4 + 2]!;
        if (mag > options.magLimit) continue;
        const bv = starPositions[i * 4 + 3]!;
        let p: Placement = place(layers.refraction ? apparentAlt(alt) : alt, sky.stars[i * 2 + 1]!, view);
        if (!p.inside) continue;
        let r = starRadius(mag);
        let alpha = starAlpha;
        if (layers.twinkle && mag < 3) {
          const phase = Math.sin(clock / 700 + i * 12.9898) * Math.sin(clock / 1327 + i * 4.1414);
          r *= 1 + 0.1 * phase;
          alpha *= 1 + 0.14 * phase;
        }
        ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
        ctx.fillStyle = starColor(bv);
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fill();
        stats.starsDrawn++;
        if (mag < 0.4) {
          const g = ctx.createRadialGradient(p.x, p.y, r * 0.5, p.x, p.y, Math.max(r * 0.5 + 0.5, r * 5));
          g.addColorStop(0, "rgba(255,255,255,0.25)");
          g.addColorStop(1, "rgba(255,255,255,0)");
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(p.x, p.y, r * 5, 0, Math.PI * 2);
          ctx.fill();
        }
        if (layers.starNames && mag <= options.labelLimit) {
          const nameIdx = starNameIdx[i]!;
          if (nameIdx >= 0) {
            const name = starNames[nameIdx]!;
            ctx.font = "11px ui-sans-serif, system-ui, sans-serif";
            const w = ctx.measureText(name).width;
            const box = { x: p.x + r + 3, y: p.y - 11, w, h: 13 };
            if (fits(boxes, box)) {
              boxes.push(box);
              ctx.globalAlpha = Math.max(0.25, alpha * 0.85);
              ctx.fillStyle = "rgba(215, 225, 245, 0.95)";
              ctx.fillText(name, box.x, box.y + 10);
              stats.starLabelsDrawn++;
            }
          }
        }
      }
      ctx.globalAlpha = 1;
    }
  }

  // --- constellation labels
  if (layers.constellationLabels && pal.lineAlpha > 0.2) {
    const boxes: LabelBox[] = [];
    ctx.font = "italic 12px ui-sans-serif, system-ui, sans-serif";
    ctx.fillStyle = `rgba(150, 190, 240, ${(pal.lineAlpha * 0.9).toFixed(2)})`;
    const order = constellations.map((c, i) => ({ c, i })).sort((a, b) => a.c.rank - b.c.rank);
    for (const { c, i } of order) {
      if (c.rank > 2) continue;
      const alt = sky.constellations[i * 2]!;
      if (alt < 2) continue;
      const p = place(alt, sky.constellations[i * 2 + 1]!, view);
      const w = ctx.measureText(c.name).width;
      const box = { x: p.x - w / 2, y: p.y - 6, w, h: 14 };
      if (!fits(boxes, box)) continue;
      boxes.push(box);
      ctx.fillText(c.name, box.x, box.y + 11);
      stats.constellationLabelsDrawn++;
    }
  }

  // --- Sun, Moon, planets
  if (layers.bodies) {
    const sunPos = place(apparentAlt(sky.sun.alt), sky.sun.az, view);
    for (const b of sky.bodies) {
      const alt = apparentAlt(b.alt);
      if (alt < -1) continue;
      const p = place(alt, b.az, view);
      if (!p.inside) continue;
      const style = BODY_COLOR[b.name] ?? { color: "#ffffff", symbol: "•" };
      stats.bodiesDrawn++;
      if (b.name === "Moon" && b.phase !== null) {
        const size = Math.max(6, Math.min(26, (b.diameterArcmin ?? 30) / 60 * p.scale * 2));
        drawMoonDisc(ctx, p.x, p.y, size / 2, b.phase, sunPos.x, sunPos.y);
      } else if (b.name === "Sun") {
        const size = Math.max(7, Math.min(30, (b.diameterArcmin ?? 60) / 60 * p.scale * 2));
        const g = ctx.createRadialGradient(p.x, p.y, size * 0.2, p.x, p.y, Math.max(size * 0.2 + 0.5, size * 3));
        g.addColorStop(0, "rgba(255, 225, 150, 0.65)");
        g.addColorStop(1, "rgba(255, 200, 120, 0)");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(p.x, p.y, size * 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = style.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, size / 2, 0, Math.PI * 2);
        ctx.fill();
      } else {
        const r = Math.min(6, Math.max(2.4, 2.6 + (2 - (b.mag ?? 2)) * 0.5));
        ctx.fillStyle = style.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "rgba(0,0,0,0.5)";
        ctx.lineWidth = 0.6;
        ctx.stroke();
      }
      if (layers.bodyLabels) {
        ctx.font = "11px ui-sans-serif, system-ui, sans-serif";
        ctx.fillStyle = "rgba(240, 235, 220, 0.95)";
        ctx.fillText(`${style.symbol} ${b.name}`, p.x + 8, p.y + 4);
      }
    }
  }

  ctx.restore();

  // --- horizon ring labels and ticks live outside the clip so they stay readable
  drawHorizonRing(ctx, view, dpr);
  drawSelection(ctx, view, sky, options, dpr);
  ctx.restore();
  return stats;
}

function drawHorizonRing(ctx: CanvasRenderingContext2D, view: View, dpr: number) {
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.font = "600 12px ui-sans-serif, system-ui, sans-serif";
  const cardinals: [number, string][] = [
    [0, "N"],
    [90, "E"],
    [180, "S"],
    [270, "W"],
  ];
  for (const [az, label] of cardinals) {
    const p = place(0, az, view);
    const theta = (az - view.rotation) * D2R;
    const nx = Math.sin(theta);
    const ny = -Math.cos(theta);
    const text = label;
    const w = ctx.measureText(text).width;
    ctx.fillStyle = "rgba(235, 235, 245, 0.92)";
    ctx.fillText(text, p.x + nx * 16 - w / 2, p.y + ny * 16 + 4);
  }
  ctx.strokeStyle = "rgba(230, 225, 240, 0.55)";
  ctx.lineWidth = 1;
  for (let az = 0; az < 360; az += 5) {
    const major = az % 45 === 0;
    const outer = place(0, az, view);
    const theta = (az - view.rotation) * D2R;
    const nx = Math.sin(theta);
    const ny = -Math.cos(theta);
    const len = major ? 9 : 4;
    ctx.beginPath();
    ctx.moveTo(outer.x + nx * 2, outer.y + ny * 2);
    ctx.lineTo(outer.x + nx * (2 + len), outer.y + ny * (2 + len));
    ctx.stroke();
  }
  ctx.restore();
}

function drawSelection(ctx: CanvasRenderingContext2D, view: View, sky: SkyState, options: DrawOptions, dpr: number) {
  const sel = options.selection ?? options.hover;
  if (!sel) return;
  let p: { x: number; y: number } | null = null;
  let label = "";
  if (sel.kind === "star") {
    const alt = sky.stars[sel.index * 2]!;
    if (alt > -1) {
      p = place(apparentAlt(alt), sky.stars[sel.index * 2 + 1]!, view);
      const nameIdx = starNameIdx[sel.index]!;
      label = nameIdx >= 0 ? starNames[nameIdx]! : `HIP ${sel.index}`;
    }
  } else if (sel.kind === "dso") {
    const alt = sky.dsos[sel.index * 2]!;
    if (alt > -1) {
      p = place(apparentAlt(alt), sky.dsos[sel.index * 2 + 1]!, view);
      label = dsoMeta[sel.index]!.name;
    }
  } else if (sel.kind === "constellation") {
    const alt = sky.constellations[sel.index * 2]!;
    if (alt > -1) {
      p = place(alt, sky.constellations[sel.index * 2 + 1]!, view);
      label = constellations[sel.index]!.en;
    }
  } else {
    const body = sky.bodies.find((b) => b.name === sel.name);
    if (body && body.alt > -1) {
      p = place(apparentAlt(body.alt), body.az, view);
      label = body.name;
    }
  }
  if (!p) return;
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.strokeStyle = "rgba(255, 214, 120, 0.95)";
  ctx.lineWidth = 1.4;
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.arc(p.x, p.y, 14, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.font = "600 12px ui-sans-serif, system-ui, sans-serif";
  const w = ctx.measureText(label).width;
  ctx.fillStyle = "rgba(255, 214, 120, 0.95)";
  ctx.fillText(label, p.x + 18, p.y - 10);
  ctx.restore();
}

/** True when the scene is dark enough to be worth drawing stars at all. */
export function starsVisible(sky: SkyState): boolean {
  return darknessFromSun(sky.sun.alt) > 0.05;
}

/**
 * The Moon's ecliptic longitude of date relative to the Sun's, measured eastward:
 * 0° new, 90° first quarter, 180° full, 270° last quarter.
 *
 * Both places go through the same J2000-equatorial-vector → ecliptic-of-date conversion, so
 * the precession between the two frames cancels instead of shifting the phase by tenths of
 * a degree.
 */
export function moonElongation(date: Date): number {
  const moon = Ecliptic(GeoVector(Body.Moon, date, true));
  const sun = Ecliptic(GeoVector(Body.Sun, date, true));
  return norm360(moon.elon - sun.elon);
}

/**
 * Is the Moon waxing — growing toward full?
 *
 * The lit limb always faces the Sun, so this asks whether the Moon is east or west of it:
 * east of the Sun the Moon is gaining light, west of it it is losing light. The phase angle
 * from `AngleFromSun` cannot answer that — it runs 0° → 180° → 0° and reads the same for a
 * waxing and a waning crescent — so the eastward elongation is used instead.
 */
export function moonWaxing(date: Date): boolean {
  return moonElongation(date) < 180;
}