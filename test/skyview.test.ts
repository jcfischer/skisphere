import { describe, expect, test } from "bun:test";
import { Body, InverseRefraction, Observer } from "astronomy-engine";
import {
  constellationBoundIndex,
  constellationLineIndex,
  constellations,
  dsoMeta,
  milkyWayIndex,
  starNameIdx,
  starNames,
  starPositions,
} from "../src/data/sky.generated";
import {
  apparentAlt,
  brightestAbove,
  computeSky,
  constellationName,
  constellationUnder,
  type SkyConfig,
} from "../src/skyview";
import { MOON, horizontal, lstDeg, placeOf, refraction, skyFrame, toOfDate } from "../src/astro";

const DATE = new Date("2026-10-15T20:00:00.000Z");
const ZURICH: SkyConfig = { date: DATE, lat: 47.3769, lon: 8.5417, elevM: 408 };
const SYDNEY: SkyConfig = { date: DATE, lat: -33.8688, lon: 151.2093, elevM: 3 };
/** Early evening over Zürich: Vega is high, the Sun is long gone. */
const EVENING: SkyConfig = { date: new Date("2026-10-15T18:00:00.000Z"), lat: 47.3769, lon: 8.5417, elevM: 408 };

/** Geometric altitude whose apparent altitude is zero (the standard atmosphere). */
const INVERSE_ZERO = -InverseRefraction("normal", 0);

const starIndex = (name: string) => starNameIdx.indexOf((starNames as readonly string[]).indexOf(name));
const figureNames = () => constellations.map((c) => c.name);

/** Highest altitude a J2000 catalog point reaches for an observer, from the meridian crossing. */
function transitAltitude(name: string, lat: number, lon: number): number {
  const index = starIndex(name);
  const ofDate = toOfDate(starPositions[index * 4]!, starPositions[index * 4 + 1]!, skyFrame(DATE));
  let best = -91;
  for (let minutes = 0; minutes < 1440; minutes += 8) {
    const date = new Date(DATE.getTime() + minutes * 60e3);
    best = Math.max(best, horizontal(ofDate.ra, ofDate.dec, lat, lstDeg(date, lon)).alt);
  }
  return best;
}

describe("the sky state", () => {
  test("one call answers with every array the renderer reads", () => {
    const sky = computeSky(ZURICH);
    expect(sky.stars.length).toBe((starPositions.length / 4) * 2);
    expect(sky.stars.length % 2).toBe(0);
    expect(sky.dsos.length).toBe(dsoMeta.length * 2);
    expect(sky.constellations.length).toBe(constellations.length * 2);
    expect(sky.lines.altaz.length % 2).toBe(0);
    expect(sky.lines.index.length % 3).toBe(0);
    // the renderer walks the generated index triples over the freshly rotated altitudes
    expect(sky.lines.index).toBe(constellationLineIndex);
    expect(sky.bounds.index).toBe(constellationBoundIndex);
    expect(sky.milkyWay.index).toBe(milkyWayIndex);
    expect(sky.lst).toBeGreaterThan(0);
    expect(sky.lst).toBeLessThan(360);
    expect(sky.twilight).toBe("night"); // 22:00 in Zürich on 15 October
    expect(sky.sunAlt).toBeLessThan(-18);
    expect(sky.observer.latitude).toBeCloseTo(47.3769, 9);
    expect(sky.observer.longitude).toBeCloseTo(8.5417, 9);
    expect(sky.observer.height).toBe(408);
    expect(sky.sun.body).toBe(Body.Sun);
    expect(sky.moon.body).toBe(Body.Moon);
    expect(sky.bodies.map((b) => b.name)).toEqual([
      "Mercury",
      "Venus",
      "Mars",
      "Jupiter",
      "Saturn",
      "Uranus",
      "Neptune",
      "Pluto",
      "Sun",
      "Moon",
    ]);
    expect(sky.bodies.every((b) => Number.isFinite(b.alt) && b.az >= 0 && b.az < 360)).toBe(true);
    expect(sky.frame.angles.eps).toBeGreaterThan(23.4);
    expect(sky.frame.angles.eps).toBeLessThan(23.5);
    expect(sky.cfgKey).toBe(`${DATE.getTime()}|47.37690|8.54170`);
  });

  test("asking about the same instant and place twice answers with the same object", () => {
    const sky = computeSky(ZURICH);
    expect(computeSky({ ...ZURICH, date: new Date(DATE.getTime()) })).toBe(sky);
    // the cache key is the instant and the place, so moving the elevation slider alone
    // does not re-derive the sky: 4 km of hillside shifts the Moon by about two arcseconds
    const higher = computeSky({ ...ZURICH, elevM: 4000 });
    expect(higher).toBe(sky);
    const low = placeOf(MOON.body, "Moon", DATE, new Observer(ZURICH.lat, ZURICH.lon, 0), false);
    const high = placeOf(MOON.body, "Moon", DATE, new Observer(ZURICH.lat, ZURICH.lon, 4000), false);
    expect(Math.abs(high.alt - low.alt)).toBeLessThan(0.001);
    // a second later is a different instant, and the new state carries the new elevation
    const later = computeSky({ ...ZURICH, date: new Date(DATE.getTime() + 1000), elevM: 4000 });
    expect(later).not.toBe(sky);
    expect(later.observer.height).toBe(4000);
  });

  test("a SkyState describes the most recent computeSky call", () => {
    const zurich = computeSky(ZURICH);
    const zurichVegaAlt = zurich.stars[starIndex("Vega") * 2]!;
    const sydney = computeSky(SYDNEY);
    // the altitudes live in buffers that computeSky reuses on every call, which is what
    // makes re-deriving the whole sky each frame affordable; the price is that a state
    // kept from before another call now reads as the newer place
    expect(sydney).not.toBe(zurich);
    expect(sydney.stars).toBe(zurich.stars);
    expect(sydney.stars[starIndex("Vega") * 2]).not.toBe(zurichVegaAlt);
    // re-asking gives a state whose arrays agree with the place again
    expect(computeSky(ZURICH).stars[starIndex("Vega") * 2]).toBeCloseTo(zurichVegaAlt, 4);
  });

  test("a star that never rises is marked rather than dropped", () => {
    // a catalog point is invisible from this latitude when its of-date declination falls
    // outside lat ± 90°; those slots carry an altitude of −91 so the renderer skips them
    const zurich = computeSky(ZURICH);
    const achernar = starIndex("Achernar"); // dec ≈ −57°
    expect(achernar).toBeGreaterThan(0);
    expect(zurich.stars[achernar * 2]).toBe(-91);
    expect(zurich.stars[achernar * 2 + 1]).toBe(0);
    const south = computeSky(SYDNEY);
    expect(south.stars[achernar * 2]!).toBeGreaterThan(-90);
    // Vega never rises from the South Pole, and α Centauri is high there
    const pole = computeSky({ date: DATE, lat: -89.5, lon: 0, elevM: 2800 });
    expect(pole.stars[starIndex("Vega") * 2]).toBe(-91);
    expect(pole.stars[starIndex("α Cen") * 2]!).toBeGreaterThan(0);
    // the mark follows the latitude, not the instant: no time of night lifts Achernar into
    // Zürich's sky
    for (const hours of [0, 6, 12, 18]) {
      const at = computeSky({ ...ZURICH, date: new Date(DATE.getTime() + hours * 3600e3) });
      expect(at.stars[achernar * 2]).toBe(-91);
    }
  });

  test("the southern sky is not the northern sky", () => {
    // compare what each place can ever see rather than one instant: at 20:00 UTC it is
    // morning in Sydney and midnight in Zürich
    expect(transitAltitude("Fomalhaut", -33.8688, 151.2093)).toBeGreaterThan(
      transitAltitude("Fomalhaut", 47.3769, 8.5417) + 40,
    );
    expect(transitAltitude("Vega", 47.3769, 8.5417)).toBeGreaterThan(
      transitAltitude("Vega", -33.8688, 151.2093) + 50,
    );
    const zurich = computeSky(ZURICH);
    const zurichSun = zurich.sunAlt;
    const sydneySun = computeSky(SYDNEY).sunAlt;
    expect(zurichSun).toBeLessThan(-18); // astronomical night
    expect(sydneySun).toBeGreaterThan(0); // and broad daylight at the same instant
  });

  test("the brightest star well above the horizon is the brightest thing there", () => {
    const sky = computeSky(EVENING);
    const index = brightestAbove(sky, 20);
    expect(index).toBeGreaterThanOrEqual(0);
    expect(sky.stars[index * 2]!).toBeGreaterThan(20);
    expect(starNameIdx[index]!).toBeGreaterThanOrEqual(0);
    const mag = starPositions[index * 4 + 2]!;
    for (let i = 0; i < sky.stars.length / 2; i++) {
      if ((sky.stars[i * 2] ?? -91) > 20 && starNameIdx[i]! >= 0) {
        expect(starPositions[i * 4 + 2]!).toBeGreaterThanOrEqual(mag - 1e-6);
      }
    }
    expect(brightestAbove(sky, 95)).toBe(-1); // nothing is above the zenith
  });

  test("the constellation name is the IAU nominative, looked up in J2000", () => {
    expect(figureNames()).toContain("Cetus");
    expect(figureNames()).not.toContain("Whale");
    expect(figureNames()).not.toContain("Luchs");
    expect(constellationName(279.2347, 38.7836)).toBe("Lyra");
    expect(constellationName(83.8221, -5.3911)).toBe("Orion"); // Betelgeuse
    const vega = starIndex("Vega");
    expect(constellationName(starPositions[vega * 4]!, starPositions[vega * 4 + 1]!)).toBe("Lyra");
    const cetusStar = starIndex("Diphda"); // β Ceti, near the equator
    expect(constellationName(starPositions[cetusStar * 4]!, starPositions[cetusStar * 4 + 1]!)).toBe("Cetus");
  });

  test("the pointer readout answers with the figure a catalog star sits in", () => {
    const sky = computeSky(EVENING);
    const vega = starIndex("Vega");
    const alt = sky.stars[vega * 2]!;
    const az = sky.stars[vega * 2 + 1]!;
    expect(alt).toBeGreaterThan(10);
    expect(constellationUnder(alt, az, sky)).toBe("Lyra");
    for (const [testAlt, testAz] of [[45, 0], [45, 90], [45, 180], [45, 270], [10, 123], [80, 321], [1, 45]]) {
      expect(figureNames()).toContain(constellationUnder(testAlt, testAz, sky));
    }
    // a degree away from a bright star stays inside the same figure
    expect(constellationUnder(alt + 1, az, sky)).toBe("Lyra");
  });

  test("apparent altitude is geometric altitude plus refraction", () => {
    // the standard atmosphere: a body whose light grazes the ground appears half a degree
    // higher, which is why the Sun is still visible when its centre is geometrically down
    expect(refraction(0)).toBeGreaterThan(0.45);
    expect(refraction(0)).toBeLessThan(0.52);
    expect(apparentAlt(-INVERSE_ZERO)).toBeCloseTo(0, 2);
    expect(apparentAlt(0)).toBeCloseTo(0.483, 3);
    expect(apparentAlt(45)).toBeCloseTo(45 + refraction(45), 9);
    expect(apparentAlt(90)).toBeCloseTo(90, 4); // straight down the atmosphere the bend is nil
    expect(refraction(60)).toBeLessThan(0.02);
    expect(refraction(30)).toBeGreaterThan(refraction(60));
    expect(refraction(5)).toBeGreaterThan(refraction(30));
    expect(refraction(1)).toBeGreaterThan(refraction(5));
    // below −1.5° the models stop agreeing, and nothing is drawn there anyway
    expect(refraction(-1.6)).toBe(0);
    expect(refraction(-1.4)).toBeGreaterThan(refraction(0));
    expect(apparentAlt(-10)).toBe(-10);
  });
});