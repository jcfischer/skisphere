import { describe, expect, test } from "bun:test";
import { Body } from "astronomy-engine";
import {
  darknessHours,
  interpolateAlt,
  sampleTimeline,
  timelineTargetFor,
} from "../src/timeline";

const DATE = new Date("2026-10-15T12:00:00.000Z");
const ZURICH = { lat: 47.3769, lon: 8.5417, elevM: 408 };

const strip = (lat: number, lon: number, iso: string, elevM = 0) =>
  sampleTimeline(new Date(iso), lat, lon, elevM, null);

describe("timeline sampling", () => {
  const samples = sampleTimeline(DATE, ZURICH.lat, ZURICH.lon, ZURICH.elevM, null);

  test("the strip covers twelve hours either side of the instant", () => {
    expect(samples).toHaveLength(73); // 24 h at 20-minute steps, endpoints included
    expect(samples[0]!.t).toBe(DATE.getTime() - 12 * 3600e3);
    expect(samples[36]!.t).toBe(DATE.getTime()); // the instant sits at the centre of the strip
    expect(samples[72]!.t).toBe(DATE.getTime() + 12 * 3600e3);
    expect(samples[36]!.sunAlt).toBeGreaterThan(30); // 14:00 in Zürich on 15 Oct: mid-afternoon
    expect(samples[0]!.sunAlt).toBeLessThan(-12); // and midnight is astronomical night
    expect(samples[1]!.t - samples[0]!.t).toBe(20 * 60e3);
    expect(samples.every((s) => Number.isFinite(s.sunAlt) && Number.isFinite(s.moonAlt))).toBe(true);
  });

  test("the same ten-minute bucket is served from the cache", () => {
    const again = sampleTimeline(new Date(DATE.getTime() + 4000), ZURICH.lat, ZURICH.lon, ZURICH.elevM, null);
    expect(again).toBe(samples);
    // a quarter of an hour later the bucket changes and the strip is regenerated: it is a
    // coarse visualisation, and that coarseness is what keeps re-deriving 146 altitudes
    // per frame affordable
    const later = sampleTimeline(new Date(DATE.getTime() + 15 * 60e3), ZURICH.lat, ZURICH.lon, ZURICH.elevM, null);
    expect(later).not.toBe(samples);
    const afternoonDrop = samples[36]!.sunAlt - later[36]!.sunAlt;
    expect(afternoonDrop).toBeGreaterThan(0.1); // the Sun has gone down a little
    expect(afternoonDrop).toBeLessThan(3); // and the strip has not shifted by a whole hour
  });

  test("a selected object rides along on the strip", () => {
    const vega = timelineTargetFor({ kind: "star", index: 4, name: "Vega" })!;
    expect(vega.raJ2000).toBeCloseTo(279.2347, 3);
    expect(vega.decJ2000).toBeCloseTo(38.7837, 3);
    const withStar = sampleTimeline(DATE, ZURICH.lat, ZURICH.lon, ZURICH.elevM, vega);
    expect(withStar.every((s) => s.targetAlt !== null && Number.isFinite(s.targetAlt!))).toBe(true);
    // Vega culminates in the afternoon/evening of this strip, not at either end
    const alts = withStar.map((s) => s.targetAlt!);
    const peak = alts.indexOf(Math.max(...alts));
    expect(Math.max(...alts)).toBeGreaterThan(60); // it passes almost overhead from Zürich
    expect(peak).toBeGreaterThan(36);
    expect(peak).toBeLessThan(60);

    const m42 = timelineTargetFor({ kind: "dso", index: 4, name: "M42 · Orion Nebula" })!;
    expect(m42.raJ2000).toBeCloseTo(83.82, 1); // 05h 35m: the Orion Nebula, not λ Orionis
    const withDso = sampleTimeline(DATE, ZURICH.lat, ZURICH.lon, ZURICH.elevM, m42);
    expect(withDso.some((s) => s.targetAlt! < 0)).toBe(true); // the Orion Nebula is below at midnight

    const mars = timelineTargetFor({ kind: "body", index: -1, name: "Mars" })!;
    expect(mars.body).toBe(Body.Mars);
    const withBody = sampleTimeline(DATE, ZURICH.lat, ZURICH.lon, ZURICH.elevM, mars);
    expect(withBody.every((s) => s.targetAlt !== null)).toBe(true);
  });

  test("anything that is not a point on the sky is refused", () => {
    expect(timelineTargetFor(null)).toBeNull();
    expect(timelineTargetFor({ kind: "constellation", index: 0 })).toBeNull();
    expect(timelineTargetFor({ kind: "city", index: 3 })).toBeNull();
    expect(timelineTargetFor({ kind: "body", index: -1, name: "Not A Planet" })).toBeNull();
  });
});

describe("darkness measured from the strip", () => {
  test("Zürich's nights run from eight hours at midsummer to fifteen and a half at midwinter", () => {
    const midsummer = darknessHours(strip(ZURICH.lat, ZURICH.lon, "2026-06-21T12:00:00Z", ZURICH.elevM));
    const midwinter = darknessHours(strip(ZURICH.lat, ZURICH.lon, "2026-12-21T12:00:00Z", ZURICH.elevM));
    expect(midsummer).toBeGreaterThan(7);
    expect(midsummer).toBeLessThan(9.5);
    expect(midwinter).toBeGreaterThan(14.5);
    expect(midwinter).toBeLessThan(16.5);
    expect(midwinter - midsummer).toBeGreaterThan(7);
  });

  test("the equator keeps about 11.9 hours of dark all year", () => {
    const equinox = darknessHours(strip(0, 25, "2026-03-20T12:00:00Z"));
    const solstice = darknessHours(strip(0, 25, "2026-06-21T12:00:00Z"));
    // a little under twelve: the Sun's disc is half a degree wide and refraction lifts it,
    // so day is slightly longer than the geometric twelve hours
    expect(equinox).toBeGreaterThan(11.3);
    expect(equinox).toBeLessThan(12.4);
    expect(Math.abs(equinox - solstice)).toBeLessThan(0.4);
  });

  test("polar night fills the strip and midnight sun empties it", () => {
    expect(darknessHours(strip(89.9, 0, "2026-12-21T12:00:00Z"))).toBe(24);
    expect(darknessHours(strip(-89.9, 0, "2026-12-21T12:00:00Z"))).toBe(0);
    expect(darknessHours(strip(69.6492, 18.9553, "2026-07-01T12:00:00Z"))).toBe(0);
    // deep polar night in Tromsø: dark apart from a few minutes when the refracted upper
    // limb grazes the horizon, which is why the season is defined by that limb
    const january = darknessHours(strip(69.6492, 18.9553, "2026-01-05T11:00:00Z"));
    expect(january).toBeGreaterThan(23);
    expect(january).toBeLessThanOrEqual(24);
  });

  test("the two hemispheres are half a year out of phase", () => {
    const north = darknessHours(strip(ZURICH.lat, ZURICH.lon, "2026-06-21T12:00:00Z"));
    const south = darknessHours(strip(-33.8688, 151.2093, "2026-06-21T12:00:00Z"));
    expect(south).toBeGreaterThan(north + 4);
    expect(south).toBeLessThan(16.5);
  });

  test("darkness never exceeds the strip it was measured over", () => {
    for (const iso of ["2026-01-05T11:00:00Z", "2026-03-20T12:00:00Z", "2026-06-21T12:00:00Z", "2026-10-15T12:00:00Z"]) {
      for (const lat of [-60, -20, 0, 35, 60, 80]) {
        const hours = darknessHours(strip(lat, 10, iso));
        expect(hours).toBeGreaterThanOrEqual(0);
        expect(hours).toBeLessThanOrEqual(24);
      }
    }
  });
});

describe("reading an altitude off the strip between samples", () => {
  const samples = sampleTimeline(DATE, ZURICH.lat, ZURICH.lon, ZURICH.elevM, null);

  test("sample instants answer exactly", () => {
    for (const index of [0, 40, 72, 72]) {
      expect(interpolateAlt(samples, samples[index]!.t, (s) => s.sunAlt)).toBeCloseTo(samples[index]!.sunAlt, 9);
    }
  });

  test("midpoints interpolate linearly", () => {
    for (const index of [10, 60, 66]) {
      const a = samples[index]!;
      const b = samples[index + 1]!;
      expect(interpolateAlt(samples, (a.t + b.t) / 2, (s) => s.sunAlt)).toBeCloseTo((a.sunAlt + b.sunAlt) / 2, 4);
    }
  });

  test("the ends clamp and a gap in the target curve answers with nothing", () => {
    // the marker can be dragged past the end of the strip; clamping beats a null readout
    expect(interpolateAlt(samples, samples[0]!.t - 60e3, (s) => s.sunAlt)).toBeCloseTo(samples[0]!.sunAlt, 6);
    expect(interpolateAlt(samples, samples[72]!.t + 60e3, (s) => s.sunAlt)).toBeCloseTo(samples[72]!.sunAlt, 6);
    expect(interpolateAlt([], DATE.getTime(), (s) => s.sunAlt)).toBeNull();
    const withGaps = samples.map((s) => ({ ...s, targetAlt: null }));
    expect(interpolateAlt(withGaps, samples[40]!.t, (s) => s.targetAlt)).toBeNull();
    const withTarget = sampleTimeline(DATE, ZURICH.lat, ZURICH.lon, ZURICH.elevM, timelineTargetFor({ kind: "star", index: 4, name: "Vega" }));
    const oneGap = withTarget.map((s, i) => (i === 41 ? { ...s, targetAlt: null } : s));
    expect(interpolateAlt(oneGap, samples[40]!.t, (s) => s.targetAlt)).toBeNull();
  });
});