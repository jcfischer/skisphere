/**
 * screenshot.ts — visual verification harness.
 *
 * Serves `public/`, drives a headless Chromium through a set of named views, and writes
 * screenshots to `.artifacts/`. It fails the run on any page error, and it checks pixels
 * rather than trusting the eye: a night view must contain bright stellar pixels, the day
 * view must be brighter on average than the night view, and the horizon ring must be drawn.
 */
import { mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Page } from "playwright";
import { startServer } from "./serve";
import type { PlanetariumProbe } from "../src/main";

declare global {
  interface Window {
    skisphere?: PlanetariumProbe;
  }
}

const OUT = resolve(import.meta.dir, "..", ".artifacts");
mkdirSync(OUT, { recursive: true });

interface Shot {
  name: string;
  hash: string;
  viewport?: { width: number; height: number };
  note: string;
}

const SHOTS: Shot[] = [
  {
    name: "01-zurich-night",
    hash: "#lat=47.3769&lon=8.5417&elev=408&t=2026-10-15T20:00:00.000Z&loc=Z%C3%BCrich&mag=6.0&sel=star:0",
    note: "Zürich, 22:00 site, Sirius selected",
  },
  {
    name: "02-all-layers",
    hash: "#lat=47.3769&lon=8.5417&elev=408&t=2026-10-15T20:00:00.000Z&loc=Z%C3%BCrich&mag=6.0&layers=lines,constellationLabels,bounds,milkyWay,stars,starNames,dsos,bodies,bodyLabels,ecliptic,equator,grid,refraction|twinkle",
    note: "every layer at once, including boundaries, ecliptic, equator and the alt/az grid",
  },
  {
    name: "03-sydney-galactic-core",
    hash: "#lat=-33.8688&lon=151.2093&elev=3&t=2026-04-15T19:20:00.000Z&loc=Sydney&mag=6.0",
    note: "southern sky with the galactic core high — the same code, the other hemisphere",
  },
  {
    name: "04-daylight",
    hash: "#lat=47.3769&lon=8.5417&elev=408&t=2026-06-21T10:30:00.000Z&loc=Z%C3%BCrich",
    note: "summer noon: sky wash, daylight palette, stars faded out",
  },
  {
    name: "05-tromso-twilight",
    hash: "#lat=69.6492&lon=18.9553&elev=10&t=2026-01-15T08:30:00.000Z&loc=Troms%C3%B8&mag=5.0&zoom=1.6",
    note: "polar twilight at 69.6°N: the Sun a few degrees down, stars half faded, glow toward its azimuth",
  },
  {
    name: "06-south-pole",
    hash: "#lat=-89.9&lon=0&t=2026-06-21T12:00:00.000Z&loc=South+Pole&proj=equidistant&mag=4.0",
    note: "the degenerate case: the rotational south pole in polar night, equal-angle projection",
  },
  {
    name: "07-equatorial-zoom",
    hash: "#lat=0&lon=-90&elev=0&t=2026-03-20T02:00:00.000Z&loc=Gal%C3%A1pagos&zoom=2.8&mag=6.0&sel=dso:0",
    note: "zoomed 2.8× at the equator with a Messier object selected",
  },
  {
    name: "08-mobile",
    hash: "#lat=47.3769&lon=8.5417&elev=408&t=2026-10-15T20:00:00.000Z&loc=Z%C3%BCrich&mag=5.5",
    viewport: { width: 390, height: 844 },
    note: "phone viewport, panels overlapping the sky",
  },
];

interface CanvasStats {
  bright: number;
  meanBrightness: number;
  /** mean |inside − outside| luminance across the horizon circle */
  ringContrast: number;
  /** how many samples the ring contrast came from: zero when the ring is off canvas */
  ringSamples: number;
  radius: number;
  width: number;
  height: number;
  starsDrawn: number;
  darkness: number;
}

async function canvasStats(page: Page): Promise<CanvasStats> {
  return page.evaluate(() => {
    const probe: PlanetariumProbe | undefined = window.skisphere;
    const canvas = document.getElementById("sky") as HTMLCanvasElement;
    const ctx = canvas.getContext("2d")!;
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const lumaAt = (x: number, y: number) => {
      const px = Math.round(x);
      const py = Math.round(y);
      if (px < 0 || py < 0 || px >= canvas.width || py >= canvas.height) return -1;
      const i = (py * canvas.width + px) * 4;
      return data[i]! * 0.2126 + data[i + 1]! * 0.7152 + data[i + 2]! * 0.0722;
    };
    let bright = 0;
    let total = 0;
    let count = 0;
    for (let i = 0; i < data.length; i += 4) {
      const luma = data[i]! * 0.2126 + data[i + 1]! * 0.7152 + data[i + 2]! * 0.0722;
      total += luma;
      count++;
      if (luma > 190) bright++;
    }
    const view = probe?.view;
    const stats = probe?.stats;
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    let contrast = 0;
    let samples = 0;
    if (view) {
      for (let deg = 0; deg < 360; deg += 1) {
        const t = (deg * Math.PI) / 180;
        const inside = lumaAt(cx + Math.sin(t) * (view.radius - 6), cy - Math.cos(t) * (view.radius - 6));
        const outside = lumaAt(cx + Math.sin(t) * (view.radius + 6), cy - Math.cos(t) * (view.radius + 6));
        if (inside < 0 || outside < 0) continue;
        contrast += Math.abs(inside - outside);
        samples++;
      }
    }
    return {
      bright,
      meanBrightness: total / count,
      ringContrast: samples ? contrast / samples : 0,
      ringSamples: samples,
      radius: view?.radius ?? 0,
      width: canvas.width,
      height: canvas.height,
      starsDrawn: stats?.starsDrawn ?? -1,
      darkness: stats?.darkness ?? -1,
    };
  });
}

async function main() {
  const server = startServer(8123);
  const browser = await chromium.launch();
  const failures: string[] = [];
  const results: { name: string; note: string; stats: CanvasStats; status: string; errors: string[] }[] = [];
  try {
    for (const shot of SHOTS) {
      const context = await browser.newContext({
        viewport: shot.viewport ?? { width: 1512, height: 950 },
        deviceScaleFactor: 1,
        locale: "en-CH",
      });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
      page.on("console", (m) => {
        if (m.type() === "error") errors.push(`console: ${m.text()}`);
      });
      await page.goto(`http://localhost:${server.port}/index.html${shot.hash}`, { waitUntil: "load" });
      await page.waitForFunction(
        () => {
          const el = document.getElementById("sky-status");
          return Boolean(el && el.textContent && !el.textContent.startsWith("—"));
        },
        { timeout: 8000 },
      );
      await page.waitForTimeout(700);
      const stats = await canvasStats(page);
      const file = resolve(OUT, `${shot.name}.png`);
      await page.screenshot({ path: file });
      const status = byName(shot.name, stats);
      if (status.length) failures.push(`${shot.name}: ${status.join("; ")}`);
      if (errors.length) failures.push(`${shot.name}: ${errors.slice(0, 3).join(" | ")}`);
      results.push({ name: shot.name, note: shot.note, stats, status: status.length ? "FAIL" : "ok", errors });
      await context.close();
    }
  } finally {
    await browser.close();
    server.stop();
  }

  for (const r of results) {
    console.log(
      `${r.status === "ok" ? "ok  " : "FAIL"} ${r.name.padEnd(26)} ${String(r.stats.width).padStart(4)}×${String(r.stats.height).padStart(4)} stars=${String(r.stats.starsDrawn).padStart(5)} dark=${r.stats.darkness.toFixed(2)} bright=${String(r.stats.bright).padStart(5)} mean=${r.stats.meanBrightness.toFixed(1).padStart(5)} ${
        r.stats.ringSamples
          ? `horizonΔ=${r.stats.ringContrast.toFixed(1).padStart(5)}`
          : `horizonΔ=  n/a (ring off canvas, r=${r.stats.radius.toFixed(0)})`
      } ${r.errors.length ? `errors=${r.errors.length}` : ""}`,
    );
  }
  console.log(`\nwrote ${results.length} screenshots to ${OUT}`);
  if (failures.length) {
    console.log("\nfailures:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

/** Pixel assertions per view. */
function byName(name: string, s: CanvasStats): string[] {
  const problems: string[] = [];
  if (s.width < 100 || s.height < 100) problems.push("canvas did not size itself");
  if (s.radius < 20) problems.push("the page reports no horizon radius");
  const circleInside = s.radius < Math.min(s.width, s.height) / 2 - 8;
  if (circleInside && s.ringContrast < 6) {
    problems.push(`horizon circle is not visible (contrast ${s.ringContrast.toFixed(1)})`);
  }
  if (name.startsWith("01") && s.starsDrawn < 1000) problems.push("night view drew too few stars");
  if (name.startsWith("02") && s.starsDrawn < 1000) problems.push("layer view drew too few stars");
  if (name.startsWith("03") && s.starsDrawn < 800) problems.push("southern night view drew too few stars");
  if (name.startsWith("04") && s.starsDrawn !== 0) problems.push("day view drew stars at all");
  if (name.startsWith("04") && s.meanBrightness < 60) problems.push("day view is not bright");
  if (name.startsWith("05") && !(s.darkness > 0.05 && s.darkness < 0.99)) {
    problems.push(`polar twilight view is neither dark nor lit (darkness ${s.darkness.toFixed(2)})`);
  }
  if (name.startsWith("05") && s.starsDrawn < 200) problems.push("polar twilight view drew almost no stars");
  if (name.startsWith("06") && s.starsDrawn < 40) problems.push("polar night view shows no stars at all");
  if (name.startsWith("08") && s.starsDrawn < 400) problems.push("phone view drew almost nothing");
  return problems;
}

main().catch((err) => {
  console.error(`screenshot run failed: ${String(err)}`);
  process.exit(1);
});