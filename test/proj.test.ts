import { describe, expect, test } from "bun:test";
import { angularSize, altitudeOfRadius, horizonScale, place, read, zenithRadius } from "../src/proj";

describe("azimuthal projections", () => {
  const view = { cx: 500, cy: 400, radius: 300, rotation: 0, mode: "stereographic" as const };

  test("the horizon maps to the unit circle and the zenith to the centre", () => {
    expect(zenithRadius(90, "stereographic")).toBeCloseTo(0, 12);
    expect(zenithRadius(0, "stereographic")).toBeCloseTo(1, 12);
    expect(zenithRadius(0, "equidistant")).toBeCloseTo(1, 12);
    const zenith = place(90, 0, view);
    expect(zenith.x).toBeCloseTo(500, 9);
    expect(zenith.y).toBeCloseTo(400, 9);
    const north = place(0, 0, view);
    expect(north.x).toBeCloseTo(500, 9);
    expect(north.y).toBeCloseTo(100, 9);
    const east = place(0, 90, view);
    expect(east.x).toBeCloseTo(800, 9);
    expect(east.y).toBeCloseTo(400, 9);
    const west = place(0, 270, view);
    expect(west.x).toBeCloseTo(200, 9);
    const south = place(0, 180, view);
    expect(south.y).toBeCloseTo(700, 9);
  });

  test("south is under north and east is to the right, as on a planisphere", () => {
    const north = place(0, 0, view);
    const east = place(0, 90, view);
    const south = place(0, 180, view);
    const west = place(0, 270, view);
    expect(north.y < south.y).toBe(true);
    expect(east.x > north.x).toBe(true);
    expect(west.x < north.x).toBe(true);
    void east.y;
  });

  test("rotation moves the requested bearing to the top", () => {
    const rotated = { ...view, rotation: 90 };
    const eastAtTop = place(0, 90, rotated);
    expect(eastAtTop.x).toBeCloseTo(500, 9);
    expect(eastAtTop.y).toBeCloseTo(100, 9);
    const northLeft = place(0, 0, rotated);
    expect(northLeft.x < 500).toBe(true);
  });

  test("project and read are inverses", () => {
    for (const mode of ["stereographic", "equidistant"] as const) {
      const v = { ...view, mode, rotation: 37 };
      for (const [alt, az] of [
        [0, 0],
        [12.5, 143],
        [45, 270],
        [88, 12],
        [31.4, 200],
      ]) {
        const p = place(alt, az, v);
        const back = read(p.x, p.y, v);
        expect(back.alt).toBeCloseTo(alt, 6);
        expect(back.az).toBeCloseTo(az, 6);
      }
    }
  });

  test("below the horizon the radius keeps growing and `inside` goes false", () => {
    expect(zenithRadius(-20, "stereographic")).toBeGreaterThan(1);
    expect(place(-20, 0, view).inside).toBe(false);
    // inside means above the geometric horizon: refraction is applied where objects are
    // drawn, so the horizon ring stays a true circle
    expect(place(-0.2, 0, view).inside).toBe(false);
    expect(place(0.2, 0, view).inside).toBe(true);
    expect(altitudeOfRadius(zenithRadius(33, "equidistant"), "equidistant")).toBeCloseTo(33, 9);
  });

  test("equal-angle is uniform while stereographic stretches toward the horizon", () => {
    // equal-angle maps altitude linearly: the same number of degrees is always the same
    // number of pixels, near the zenith and near the rim alike
    expect(zenithRadius(45, "equidistant")).toBeCloseTo(0.5, 12);
    expect(zenithRadius(45, "equidistant") - zenithRadius(0, "equidistant")).toBeCloseTo(
      zenithRadius(90, "equidistant") - zenithRadius(45, "equidistant"),
      12,
    );
    // the stereographic fisheye is conformal instead: its radial scale is sec²(z/2), so a
    // degree of altitude at the horizon occupies twice what it does at the zenith, and the
    // whole sky fits inside the rim instead of needing an infinite radius
    const edgeStep = zenithRadius(0, "stereographic") - zenithRadius(0.5, "stereographic");
    const zenithStep = zenithRadius(89.5, "stereographic") - zenithRadius(90, "stereographic");
    // the ratio is sec²(45°)/sec²(0°) = 2, measured over a 0.5° step either end
    expect(edgeStep / zenithStep).toBeCloseTo(2, 1);
    expect(zenithRadius(45, "stereographic")).toBeLessThan(zenithRadius(45, "equidistant"));
    expect(zenithRadius(0, "stereographic")).toBeCloseTo(1, 12);
    expect(zenithRadius(90, "stereographic")).toBeCloseTo(0, 12);
  });

  test("scale and angular size agree at the horizon", () => {
    const v = { ...view, mode: "equidistant" as const };
    // equal-angle: 90° across a radius of 300 px, so 300/90 px per degree everywhere
    expect(horizonScale(v)).toBeCloseTo(300 / 90, 6);
    expect(angularSize(60, 0, v)).toBeCloseTo(300 / 90, 6);
    expect(angularSize(30, 40, v)).toBeCloseTo(150 / 90, 6);
  });
});