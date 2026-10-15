/**
 * timeline.ts — the altitude strip under the sky: Sun, Moon and one tracked object over
 * ±12 hours.
 *
 * A sky map answers "where is it now"; this answers the two questions that follow it: how
 * long is the dark part of *this* night, and when does the object I clicked clear the
 * horizon. Sampling uses ephemeris calls only (no catalog sweep), so a day costs about a
 * millisecond and the strip is rebuilt whenever the instant or place changes.
 */
import { Body, Observer } from "astronomy-engine";
import { MOON, PLANETS, SUN, horizontal, lstDeg, placeOf, skyFrame, toOfDate } from "./astro";
import { pad2, utcToWall, type TimeMode } from "./location";
import { dsoData, starPositions } from "./data/sky.generated";

export interface TimelineTarget {
  kind: "star" | "dso" | "body";
  /** catalog index for star/dso, ignored for body */
  index: number;
  name: string;
  /** J2000 position for star/dso */
  raJ2000?: number;
  decJ2000?: number;
  body?: Body;
}

export interface AltitudeSample {
  /** ms since epoch */
  t: number;
  sunAlt: number;
  moonAlt: number;
  targetAlt: number | null;
}

const SPAN_HOURS = 24;
const STEP_MINUTES = 20;
const cache = new Map<string, AltitudeSample[]>();

const BODY_BY_NAME = new Map<string, Body>([
  [SUN.name, SUN.body],
  [MOON.name, MOON.body],
  ...PLANETS.map((p) => [p.name, p.body] as [string, Body]),
]);

/** Altitude of a J2000 catalog point at an instant, without sweeping the catalog. */
function catalogAltitude(raJ2000: number, decJ2000: number, date: Date, lat: number, lon: number): number {
  const ofDate = toOfDate(raJ2000, decJ2000, skyFrame(date));
  return horizontal(ofDate.ra, ofDate.dec, lat, lstDeg(date, lon)).alt;
}

export function sampleTimeline(
  date: Date,
  lat: number,
  lon: number,
  elevM: number,
  target: TimelineTarget | null,
): AltitudeSample[] {
  const key = [
    Math.round(date.getTime() / 600000),
    lat.toFixed(2),
    lon.toFixed(2),
    elevM,
    target ? `${target.kind}:${target.index}` : "-",
  ].join("|");
  const cached = cache.get(key);
  if (cached) return cached;

  const observer = new Observer(lat, lon, elevM);
  const step = STEP_MINUTES * 60000;
  const start = date.getTime() - (SPAN_HOURS / 2) * 3600000;
  const count = Math.round((SPAN_HOURS * 3600000) / step) + 1;
  const targetBody = target?.kind === "body" ? BODY_BY_NAME.get(target.name) : undefined;
  const out: AltitudeSample[] = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(start + i * step);
    let targetAlt: number | null = null;
    if (target) {
      if (targetBody !== undefined) {
        targetAlt = placeOf(targetBody, target.name, d, observer, false).alt;
      } else if (target.raJ2000 !== undefined && target.decJ2000 !== undefined) {
        targetAlt = catalogAltitude(target.raJ2000, target.decJ2000, d, lat, lon);
      }
    }
    out.push({
      t: d.getTime(),
      sunAlt: placeOf(SUN.body, "Sun", d, observer, false).alt,
      moonAlt: placeOf(MOON.body, "Moon", d, observer, false).alt,
      targetAlt,
    });
  }
  cache.set(key, out);
  if (cache.size > 80) cache.delete(cache.keys().next().value!);
  return out;
}

export function timelineTargetFor(
  selection: { kind: string; index: number; name?: string } | null,
): TimelineTarget | null {
  if (!selection) return null;
  if (selection.kind === "body" && selection.name) {
    const body = BODY_BY_NAME.get(selection.name);
    return body === undefined ? null : { kind: "body", index: -1, name: selection.name, body };
  }
  if (selection.kind === "star" || selection.kind === "dso") {
    const arr = selection.kind === "star" ? starPositions : dsoData;
    const base = selection.index * 4;
    return {
      kind: selection.kind,
      index: selection.index,
      name: selection.name ?? "",
      raJ2000: arr[base],
      decJ2000: arr[base + 1],
    };
  }
  return null;
}

export interface TimelineOptions {
  dpr: number;
  date: Date;
  timeMode: TimeMode;
  showTarget: boolean;
}

/** Altitude bands, top to bottom, coloured the way the sky wash above is. */
const BANDS: [number, number, string][] = [
  [90, -0.833, "rgba(150, 190, 235, 0.28)"],
  [-0.833, -6, "rgba(108, 140, 196, 0.26)"],
  [-6, -12, "rgba(58, 82, 142, 0.26)"],
  [-12, -18, "rgba(30, 42, 92, 0.28)"],
  [-18, -90, "rgba(9, 13, 32, 0.55)"],
];

export function drawTimeline(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  samples: AltitudeSample[],
  opts: TimelineOptions,
) {
  ctx.save();
  ctx.setTransform(opts.dpr, 0, 0, opts.dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (samples.length < 2) {
    ctx.restore();
    return;
  }
  const t0 = samples[0]!.t;
  const t1 = samples[samples.length - 1]!.t;
  const altTop = 60;
  const altBottom = -30;
  const x = (t: number) => ((t - t0) / (t1 - t0)) * w;
  const y = (alt: number) => ((altTop - Math.max(altBottom, Math.min(altTop, alt))) / (altTop - altBottom)) * h;

  for (const [a, b, color] of BANDS) {
    ctx.fillStyle = color;
    const top = y(Math.min(altTop, a));
    ctx.fillRect(0, top, w, Math.max(0, y(Math.max(altBottom, b)) - top));
  }

  ctx.font = "10px ui-sans-serif, system-ui, sans-serif";
  const tick = 3 * 3600000;
  for (let t = Math.ceil(t0 / tick) * tick; t <= t1; t += tick) {
    const px = x(t);
    ctx.strokeStyle = "rgba(200, 210, 235, 0.14)";
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, h);
    ctx.stroke();
    const { parts } = utcToWall(new Date(t), opts.timeMode);
    ctx.fillStyle = "rgba(200, 210, 235, 0.6)";
    ctx.fillText(`${pad2(parts[3]!)}:${pad2(parts[4]!)}`, px + 3, h - 4);
  }

  ctx.strokeStyle = "rgba(235, 230, 245, 0.5)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, y(0));
  ctx.lineTo(w, y(0));
  ctx.stroke();

  const curve = (get: (s: AltitudeSample) => number | null, color: string, width: number, dash: number[] = []) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.setLineDash(dash);
    ctx.beginPath();
    let open = false;
    for (const s of samples) {
      const alt = get(s);
      if (alt === null || alt < altBottom - 3) {
        open = false;
        continue;
      }
      const px = x(s.t);
      const py = y(alt);
      if (open) ctx.lineTo(px, py);
      else {
        ctx.moveTo(px, py);
        open = true;
      }
    }
    ctx.stroke();
    ctx.setLineDash([]);
  };

  curve((s) => s.moonAlt, "rgba(226, 226, 212, 0.6)", 1.1, [3, 3]);
  if (opts.showTarget) curve((s) => s.targetAlt, "rgba(255, 205, 110, 0.95)", 1.7);
  curve((s) => s.sunAlt, "rgba(255, 216, 120, 1)", 1.8);

  const nowX = x(opts.date.getTime());
  ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(nowX, 0);
  ctx.lineTo(nowX, h);
  ctx.stroke();
  const sunNow = interpolateAlt(samples, opts.date.getTime(), (s) => s.sunAlt);
  if (sunNow !== null) {
    ctx.fillStyle = "#ffd878";
    ctx.beginPath();
    ctx.arc(nowX, y(sunNow), 3, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

export function interpolateAlt(samples: AltitudeSample[], t: number, get: (s: AltitudeSample) => number | null): number | null {
  if (!samples.length) return null;
  const stepMs = samples[1] ? samples[1]!.t - samples[0]!.t : 1;
  const pos = (t - samples[0]!.t) / stepMs;
  const i = Math.max(0, Math.min(samples.length - 2, Math.floor(pos)));
  const a = samples[i]!;
  const b = samples[i + 1] ?? a;
  const fa = get(a);
  const fb = get(b);
  if (fa === null || fb === null) return null;
  const f = Math.max(0, Math.min(1, pos - i));
  return fa + (fb - fa) * f;
}

/** Hours for which the Sun stays below −0.833° within the sampled window. */
export function darknessHours(samples: AltitudeSample[]): number {
  let minutes = 0;
  const dark = (alt: number) => alt < -0.833;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1]!.sunAlt;
    const b = samples[i]!.sunAlt;
    const dt = (samples[i]!.t - samples[i - 1]!.t) / 60000;
    if (dark(a) && dark(b)) minutes += dt;
    else if (dark(a) !== dark(b)) minutes += dt * (dark(a) ? (-0.833 - a) / (b - a) : 1 - (-0.833 - a) / (b - a));
  }
  return minutes / 60;
}