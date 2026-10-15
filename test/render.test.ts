import { describe, expect, test } from "bun:test";
import { Body, GeoVector, Illumination } from "astronomy-engine";
import {
  DEFAULT_LAYERS,
  bvColor,
  darknessFromSun,
  drawScene,
  moonElongation,
  moonWaxing,
  palette,
  starRadius,
  starsVisible,
  type DrawOptions,
  type Layers,
  type SceneStats,
} from "../src/render";
import { computeSky } from "../src/skyview";
import { starNames, starPositions } from "../src/data/sky.generated";

function rgb(css: string): [number, number, number] {
  const m = css.match(/rgb\((\d+),(\d+),(\d+)\)/);
  if (!m) throw new Error(`not an rgb() colour: ${css}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

const D2R = Math.PI / 180;

describe("star rendering model", () => {
  test("glyph radius falls monotonically with magnitude", () => {
    const mags = [-1.44, 0, 1, 2, 3, 4, 5, 6];
    const radii = mags.map(starRadius);
    for (let i = 1; i < radii.length; i++) expect(radii[i]!).toBeLessThan(radii[i - 1]!);
    expect(starRadius(-1.44)).toBeGreaterThan(5); // Sirius is the biggest dot on the map
    expect(starRadius(6)).toBeLessThan(1); // and a 6th-magnitude star is a speck
    expect(starRadius(30)).toBeGreaterThanOrEqual(0.35); // absurd input stays drawable
  });

  test("B−V drives the colour the way the spectrum does", () => {
    const hot = rgb(bvColor(-0.3));
    const sun = rgb(bvColor(0.65));
    const cool = rgb(bvColor(2.4));
    expect(hot[2]).toBeGreaterThan(hot[0]); // blue stars are blue
    expect(cool[0]).toBeGreaterThan(cool[2]); // and cool stars are orange-red
    expect(sun[0]).toBeGreaterThan(240); // the Sun is close to white
    expect(cool[2]).toBeLessThan(sun[2]); // redder means less blue, monotonically
    // clamped at both ends of the anchor table, and always a legal CSS colour
    expect(bvColor(-3)).toBe(bvColor(-0.35));
    expect(bvColor(9)).toBe(bvColor(3.2));
    for (const testBv of [-3, -0.35, 0, 0.6, 1.5, 3.2, 3.27, 9, NaN]) {
      const [r, g, b] = rgb(bvColor(testBv));
      expect(r! >= 0 && r! <= 255, `red ${testBv}`).toBe(true);
      expect(g! >= 0 && g! <= 255, `green ${testBv}`).toBe(true);
      expect(b! >= 0 && b! <= 255, `blue ${testBv}`).toBe(true);
    }
    expect(bvColor(NaN)).toBe(bvColor(0.6)); // a star with no colour index is drawn solar
  });
});

describe("darkness drives every fade in the scene", () => {
  test("the four twilight boundaries are the breakpoints", () => {
    expect(darknessFromSun(10)).toBe(0);
    expect(darknessFromSun(-0.5)).toBe(0); // still daylight: the upper limb is up
    expect(darknessFromSun(-0.9)).toBeGreaterThan(0);
    expect(darknessFromSun(-6)).toBeCloseTo(0.25, 6);
    expect(darknessFromSun(-12)).toBeCloseTo(0.6, 6);
    expect(darknessFromSun(-18)).toBeCloseTo(1, 6);
    expect(darknessFromSun(-60)).toBe(1);
  });

  test("darkness rises monotonically as the Sun sinks", () => {
    let previous = -1;
    for (let alt = 10; alt > -60; alt -= 0.5) {
      const d = darknessFromSun(alt);
      expect(d).toBeGreaterThanOrEqual(previous);
      previous = d;
    }
    expect(previous).toBe(1);
  });

  test("the palette darkens and the ground goes from dusk-brown to night-black", () => {
    const day = palette(30, 0);
    const night = palette(-30, 1);
    // the glow is daylight airlight: strongest under a blue sky, gone by astronomical night
    expect(day.glowAlpha).toBeGreaterThan(0.5);
    expect(night.glowAlpha).toBe(0);
    expect(day.starAlpha).toBe(0);
    expect(night.starAlpha).toBe(1);
    expect(night.lineAlpha).toBeGreaterThan(day.lineAlpha);
    const rgbOf = (c: string) => rgb(c).reduce((a, b) => a + b, 0);
    expect(rgbOf(night.zenith)).toBeLessThan(rgbOf(day.zenith));
    expect(rgbOf(night.horizon)).toBeLessThan(rgbOf(day.horizon));
    expect(rgbOf(night.ground)).toBeLessThan(rgbOf(day.ground));
  });

  test("the glow fades out by 12° below the horizon and follows the darkness", () => {
    expect(palette(-3, 0.1).glowAlpha).toBeGreaterThan(0);
    expect(palette(-11.9, 0.5).glowAlpha).toBeGreaterThan(0);
    expect(palette(-12.1, 0.5).glowAlpha).toBe(0); // no airlight to paint in astronomical night
    expect(palette(-18, 1).glowAlpha).toBe(0);
    // the brighter the sky, the stronger the airlight: it is driven by 1 − darkness
    expect(palette(-3, 0.05).glowAlpha).toBeGreaterThan(palette(-3, 0.4).glowAlpha);
    expect(palette(0.5, 0).glowAlpha).toBeCloseTo(0.55, 6);
  });
});

/** Signed distance of the Moon's eastward elongation from a phase target, degrees. */
function signedTo(ms: number, target: number): number {
  return ((moonElongation(new Date(ms)) - target + 540) % 360) - 180;
}

/** The first instant after `fromMs` when the elongation reaches `target`. */
function crossing(target: number, fromMs: number): number {
  let previous = signedTo(fromMs, target);
  for (let hours = 1; hours <= 24 * 34; hours++) {
    const ms = fromMs + hours * 3600e3;
    const now = signedTo(ms, target);
    if (Math.sign(now) !== Math.sign(previous)) {
      let lo = ms - 3600e3;
      let hi = ms;
      for (let i = 0; i < 40; i++) {
        const mid = (lo + hi) / 2;
        if (Math.sign(signedTo(mid, target)) === Math.sign(signedTo(lo, target))) lo = mid;
        else hi = mid;
      }
      return (lo + hi) / 2;
    }
    previous = now;
  }
  throw new Error(`no ${target}° crossing after ${new Date(fromMs).toISOString()}`);
}

const AUTUMN_LUNATION = Date.UTC(2026, 9, 1);
const NEW_MOON = crossing(0, AUTUMN_LUNATION);
const FIRST_QUARTER = crossing(90, NEW_MOON);
const FULL_MOON = crossing(180, FIRST_QUARTER);
const LAST_QUARTER = crossing(270, FULL_MOON);

describe("the Moon's phase orientation", () => {
  test("waxing follows the Moon's position east or west of the Sun", () => {
    // an independent read on the same fact: in geocentric ICRS coordinates the Moon drifts
    // counterclockwise as seen from the north celestial pole, so it is waxing exactly while
    // the z component of (Sun × Moon) is positive — no ecliptic longitudes, no phase angle.
    // Near new and full Moon the two bodies lie on one line and that cross product says
    // nothing, so the comparison is made away from those instants.
    const waxingFromVectors = (date: Date) => {
      const sun = GeoVector(Body.Sun, date, true);
      const moon = GeoVector(Body.Moon, date, true);
      return sun.x * moon.y - sun.y * moon.x > 0;
    };
    let flips = 0;
    let compared = 0;
    let previousWaxing = moonWaxing(new Date(AUTUMN_LUNATION));
    let previousElongation = moonElongation(new Date(AUTUMN_LUNATION));
    for (let minutes = 30; minutes <= 60 * 24 * 62; minutes += 30) {
      const date = new Date(AUTUMN_LUNATION + minutes * 60e3);
      const elongation = moonElongation(date);
      if (Math.abs(Math.sin(elongation * D2R)) > 0.05) {
        expect(moonWaxing(date), date.toISOString()).toBe(waxingFromVectors(date));
        compared++;
      }
      // the elongation only runs eastward, and it goes once round in a lunation
      expect(((elongation - previousElongation + 540) % 360) - 180).toBeGreaterThan(0);
      previousElongation = elongation;
      if (moonWaxing(date) !== previousWaxing) flips++;
      previousWaxing = moonWaxing(date);
    }
    expect(compared).toBeGreaterThan(2000);
    expect(flips).toBe(4); // two new moons and two full moons in two lunations
  });

  test("the four principal phases land where they should", () => {
    // the quarters are found by bisecting the elongation rather than looked up, so this
    // cannot drift out of step with the sky
    const days = (a: number, b: number) => (b - a) / 86400e3;
    expect(days(AUTUMN_LUNATION, NEW_MOON)).toBeGreaterThan(0);
    expect(days(NEW_MOON, FIRST_QUARTER)).toBeGreaterThan(6.5);
    expect(days(NEW_MOON, FIRST_QUARTER)).toBeLessThan(8.4);
    expect(days(FIRST_QUARTER, FULL_MOON)).toBeGreaterThan(6.5);
    expect(days(FIRST_QUARTER, FULL_MOON)).toBeLessThan(8.4);
    expect(days(FULL_MOON, LAST_QUARTER)).toBeGreaterThan(6.5);
    expect(days(FULL_MOON, LAST_QUARTER)).toBeLessThan(8.4);
    expect(days(NEW_MOON, LAST_QUARTER)).toBeLessThan(26);

    for (const [ms, expected, waxing] of [
      [NEW_MOON, 0, true], // it turns to waxing as it passes the Sun
      [FIRST_QUARTER, 90, true], // half lit and growing
      [FULL_MOON, 180, false], // fully lit, and from here the Moon wanes
      [LAST_QUARTER, 270, false], // half lit and shrinking
    ] as [number, number, boolean][]) {
      const date = new Date(ms);
      expect(Math.abs(signedTo(ms, expected))).toBeLessThan(0.01);
      expect(moonWaxing(date), date.toISOString()).toBe(waxing);
      const fraction = Illumination(Body.Moon, date).phase_fraction;
      expect(Math.abs(fraction - (1 - Math.cos(expected * D2R)) / 2), date.toISOString()).toBeLessThan(0.02);
      // the trend agrees too: light comes in before full Moon and goes out after it
      if (expected !== 0 && expected !== 180) {
        const trend = Illumination(Body.Moon, new Date(ms + 3600e3)).phase_fraction - fraction;
        expect(trend > 0, date.toISOString()).toBe(waxing);
      }
    }
  });

  test("the waxing flag is a step: it changes at new and full Moon and nowhere else", () => {
    expect(moonWaxing(new Date(NEW_MOON - 3600e3))).toBe(false);
    expect(moonWaxing(new Date(NEW_MOON + 3600e3))).toBe(true);
    expect(moonWaxing(new Date(FULL_MOON - 3600e3))).toBe(true);
    expect(moonWaxing(new Date(FULL_MOON + 3600e3))).toBe(false);
    // a fortnight before full Moon the Moon is waxing all day long
    expect(moonWaxing(new Date(FIRST_QUARTER))).toBe(true);
    expect(moonWaxing(new Date(LAST_QUARTER))).toBe(false);
  });

  test("the drawn crescent is oriented by the Sun's place on screen, not by this flag", () => {
    // drawMoonDisc takes the illuminated fraction and the Sun's canvas position, so a waning
    // crescent still points at the Sun; the flag only words the card
    for (const ms of [NEW_MOON, FIRST_QUARTER, FULL_MOON, LAST_QUARTER]) {
      const fraction = Illumination(Body.Moon, new Date(ms)).phase_fraction;
      expect(fraction).toBeGreaterThanOrEqual(0);
      expect(fraction).toBeLessThanOrEqual(1);
    }
  });
});

/**
 * A canvas that records instead of painting. drawScene is pure enough to run in Node, which
 * means the whole frame — colours, culling, layer switches — can be checked without a
 * browser, and a colour that a browser would silently reject is caught here instead.
 */
function recordingContext(width = 1200, height = 800) {
  const styles: string[] = [];
  let styleObjects = 0;
  const calls = new Map<string, number>();
  const gradient = { addColorStop: () => {} };
  const target: Record<string, unknown> = {
    canvas: { width, height },
    createRadialGradient: () => gradient,
    createLinearGradient: () => gradient,
    measureText: (text: string) => ({ width: String(text).length * 6 }),
    getTransform: () => new DOMMatrix(),
  };
  const ctx = new Proxy(target, {
    get(t, prop: string) {
      if (prop in t) return t[prop];
      return (...args: unknown[]) => {
        calls.set(prop, (calls.get(prop) ?? 0) + 1);
        return undefined;
      };
    },
    set(t, prop: string, value: unknown) {
      if (prop === "fillStyle" || prop === "strokeStyle") {
        // a gradient object is a legal assignment; only literal colours get validated
        if (typeof value === "string") styles.push(value);
        else styleObjects++;
      }
      t[prop] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, styles, calls, gradientAssignments: () => styleObjects };
}

/** Every colour the renderer handed the canvas must be one a browser will accept. */
function assertLegalColours(styles: string[]) {
  expect(styles.length).toBeGreaterThan(20);
  const named = /^[a-z]+$/i;
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
  const rgb = /^rgba?\((\d{1,3}),\s*(\d{1,3}),\s*(\d{1,3})(?:,\s*(\d*\.?\d+))?\)$/i;
  for (const style of styles) {
    if (named.test(style) || hex.test(style)) continue;
    const m = rgb.exec(style);
    if (!m) throw new Error(`not a colour a canvas accepts: ${JSON.stringify(style)}`);
    for (const channel of [m[1]!, m[2]!, m[3]!]) {
      const value = Number(channel);
      expect(value >= 0 && value <= 255, style).toBe(true);
    }
    if (m[4] !== undefined) {
      const alpha = Number(m[4]);
      expect(alpha >= 0 && alpha <= 1, style).toBe(true);
    }
  }
}

const NIGHT_CFG = { date: new Date("2026-10-15T21:00:00.000Z"), lat: 47.3769, lon: 8.5417, elevM: 408 };
const SYDNEY_CFG = { date: new Date("2026-10-15T18:00:00.000Z"), lat: -33.8688, lon: 151.2093, elevM: 3 };
const ZURICH_AT_SYDNEY_TIME = { ...NIGHT_CFG, date: SYDNEY_CFG.date };
const DAY_CFG = { date: new Date("2026-06-21T10:00:00.000Z"), lat: 47.3769, lon: 8.5417, elevM: 408 };
const VIEW = { cx: 400, cy: 400, radius: 380, rotation: 0, mode: "stereographic" as const };
const CATALOG_STARS = starPositions.length / 4;

const drawOptions = (over: Partial<DrawOptions> = {}): DrawOptions => ({
  layers: { ...DEFAULT_LAYERS },
  magLimit: 6,
  labelLimit: 3,
  clock: 0,
  ...over,
});

const ALL_LAYERS: Layers = {
  milkyWay: true,
  bounds: true,
  lines: true,
  constellationLabels: true,
  stars: true,
  starNames: true,
  dsos: true,
  bodies: true,
  bodyLabels: true,
  ecliptic: true,
  equator: true,
  grid: true,
  refraction: true,
  twinkle: true,
};

/**
 * Each frame re-derives its own sky: SkyState's altitude arrays are buffers computeSky
 * reuses on every call, so a state held over from before another call would paint the
 * newer place (see the skyview tests).
 */
function paint(cfg: typeof NIGHT_CFG, view = VIEW, over: Partial<DrawOptions> = {}, dpr = 1) {
  const { ctx, styles, gradientAssignments } = recordingContext();
  const stats = drawScene({ ctx, view, sky: computeSky(cfg), options: drawOptions(over), dpr });
  return { stats, styles, gradientAssignments };
}

describe("painting a frame", () => {
  test("the default night frame paints the sky, the figures and the planets", () => {
    const { stats, styles, gradientAssignments } = paint(NIGHT_CFG);
    expect(stats.darkness).toBe(1);
    expect(stats.starsDrawn).toBeGreaterThan(500);
    expect(stats.starLabelsDrawn).toBeGreaterThan(10);
    expect(stats.dsosDrawn).toBeGreaterThan(10);
    expect(stats.bodiesDrawn).toBeGreaterThan(1);
    expect(stats.figurePaths).toBeGreaterThan(50);
    expect(stats.milkyWayPolygons).toBeGreaterThan(0);
    // boundaries, the alt/az grid and the reference circles start switched off
    expect(stats.boundaryPaths).toBe(0);
    expect(stats.gridLines).toBe(0);
    expect(stats.referenceCircles).toBe(0);
    expect(stats.starsDrawn).toBeLessThan(CATALOG_STARS);
    expect(gradientAssignments()).toBeGreaterThan(0); // the sky wash and star bloom are gradients
    assertLegalColours(styles);
  });

  test("with every layer on, everything the scene can draw is drawn", () => {
    const { stats, styles } = paint(NIGHT_CFG, VIEW, { layers: ALL_LAYERS });
    expect(stats.boundaryPaths).toBeGreaterThan(20);
    expect(stats.gridLines).toBeGreaterThan(4);
    expect(stats.referenceCircles).toBeGreaterThan(1); // ecliptic and celestial equator
    expect(stats.milkyWayPolygons).toBeGreaterThan(0);
    expect(stats.constellationLabelsDrawn).toBeGreaterThan(10);
    assertLegalColours(styles);
  });

  test("each layer switch stops its own drawing and nothing else", () => {
    const switches: [keyof Layers, (st: SceneStats) => number][] = [
      ["milkyWay", (st) => st.milkyWayPolygons],
      ["lines", (st) => st.figurePaths],
      ["bounds", (st) => st.boundaryPaths],
      ["grid", (st) => st.gridLines],
      ["ecliptic", (st) => st.referenceCircles],
      ["constellationLabels", (st) => st.constellationLabelsDrawn],
    ];
    for (const [layer, read] of switches) {
      const on = read(paint(NIGHT_CFG, VIEW, { layers: { ...ALL_LAYERS, [layer]: true } }).stats);
      const off = read(paint(NIGHT_CFG, VIEW, { layers: { ...ALL_LAYERS, [layer]: false } }).stats);
      expect(on, layer).toBeGreaterThan(0);
      if (layer !== "ecliptic") expect(off, layer).toBe(0); // the equator still counts as a circle
      expect(paint(NIGHT_CFG, VIEW, { layers: { ...ALL_LAYERS, [layer]: false } }).stats.starsDrawn).toBeGreaterThan(500);
    }
    const bare = paint(NIGHT_CFG, VIEW, { layers: { ...ALL_LAYERS, stars: false, dsos: false, bodies: false, starNames: false } });
    expect(bare.stats.starsDrawn).toBe(0);
    expect(bare.stats.dsosDrawn).toBe(0);
    expect(bare.stats.bodiesDrawn).toBe(0);
    expect(bare.stats.starLabelsDrawn).toBe(0);
    expect(bare.stats.figurePaths).toBeGreaterThan(0); // the figures are still there
  });

  test("the magnitude and label limits cull the way the sliders say", () => {
    const faint = paint(NIGHT_CFG).stats;
    const bright = paint(NIGHT_CFG, VIEW, { magLimit: 1.5 }).stats;
    const zoomed = paint(NIGHT_CFG, { ...VIEW, radius: 1400 }).stats;
    expect(bright.starsDrawn).toBeLessThan(faint.starsDrawn);
    expect(bright.starsDrawn).toBeGreaterThan(0);
    expect(faint.starsDrawn).toBeLessThan(CATALOG_STARS);
    // zoom changes how big things are, not what is in the hemisphere: both projections map
    // the whole visible sky inside the horizon ring, so the same stars are drawn and the
    // browser clips whatever falls off the canvas
    expect(zoomed.starsDrawn).toBe(faint.starsDrawn);
    expect(paint(NIGHT_CFG, VIEW, { labelLimit: 0 }).stats.starLabelsDrawn).toBeLessThan(faint.starLabelsDrawn);
    expect(paint(NIGHT_CFG, VIEW, { layers: { ...ALL_LAYERS, starNames: false } }).stats.starLabelsDrawn).toBe(0);
  });

  test("daylight empties the sky without emptying the scene", () => {
    expect(starsVisible(computeSky(DAY_CFG))).toBe(false);
    const { stats, styles } = paint(DAY_CFG);
    expect(stats.darkness).toBe(0);
    expect(stats.starsDrawn).toBe(0);
    expect(stats.starLabelsDrawn).toBe(0);
    expect(stats.dsosDrawn).toBe(0);
    expect(stats.bodiesDrawn).toBeGreaterThan(0); // the Sun is drawn whatever the hour
    assertLegalColours(styles);
  });

  test("the same instant gives a different picture from the other hemisphere", () => {
    // 18:00 UTC is dark in both places: nautical evening in Zürich, past midnight in Sydney
    // (the two places are nine hours round the world from each other, so that is the whole
    // of the overlap between their nights)
    const northStats = paint(ZURICH_AT_SYDNEY_TIME).stats;
    const southFrame = paint(SYDNEY_CFG);
    expect(northStats.darkness).toBeGreaterThan(0.7);
    expect(southFrame.stats.darkness).toBeGreaterThan(0.7);
    expect(southFrame.stats.starsDrawn).toBeGreaterThan(0);
    expect(Math.abs(southFrame.stats.starsDrawn - northStats.starsDrawn)).toBeGreaterThan(1);
    assertLegalColours(southFrame.styles);
  });

  test("the horizon ring and the ground survive a tall mobile canvas", () => {
    const { ctx, calls } = recordingContext(390, 780);
    const stats = drawScene({
      ctx,
      view: { cx: 195, cy: 330, radius: 180, rotation: 0, mode: "equidistant" },
      sky: computeSky(NIGHT_CFG),
      options: drawOptions({ layers: ALL_LAYERS }),
      dpr: 3,
    });
    expect(stats.starsDrawn).toBeGreaterThan(50);
    expect(calls.get("arc") ?? 0).toBeGreaterThan(10); // the horizon, ticks and glyphs
    expect(calls.get("setTransform") ?? 0).toBeGreaterThan(0);
  });
});
