import { describe, expect, test } from "bun:test";
import {
  DSO_TYPE,
  azimuthText,
  cardinal,
  describe as describeObject,
  eventTable,
  locationSummary,
  twilightTable,
} from "../src/details";
import { DEFAULT_STATE } from "../src/state";
import { computeSky } from "../src/skyview";
import { dsoMeta, starNames } from "../src/data/sky.generated";

const instant = new Date("2026-10-15T20:00:00.000Z");

function stateAt(over = {}) {
  return { ...DEFAULT_STATE, date: instant, follow: false, timeMode: "utc" as const, ...over };
}

describe("the object cards", () => {
  const sky = computeSky({ date: instant, lat: 47.3769, lon: 8.5417, elevM: 408 });
  // names and stars share one order in this catalog (brightest first), so the name index
  // is the star index; pinning Vega makes a reordered rebuild fail loudly
  const vegaIndex = (starNames as readonly string[]).indexOf("Vega");

  test("a star card reports both frames, its magnitude and its events", () => {
    const card = describeObject(`star:${vegaIndex}`, sky, stateAt());
    expect(card).not.toBeNull();
    const keys = card!.rows.map((r) => r.k);
    expect(keys).toContain("RA / Dec (of date)");
    expect(keys).toContain("RA / Dec (J2000)");
    expect(keys).toContain("Constellation");
    expect(keys).toContain("Visual magnitude");
    expect(keys).toContain("Hipparcos");
    expect(keys).toContain("Transits");
    expect(card!.subtitle).toContain("star");
    expect(card!.rows.find((r) => r.k === "Constellation")!.v).toBe("Lyra");
    expect(card!.rows.find((r) => r.k === "Visual magnitude")!.v).toBe("0.03");
  });

  test("the altitude line says which side of the horizon the object is on", () => {
    const card = describeObject(`star:${vegaIndex}`, sky, stateAt());
    const alt = card!.rows.find((r) => r.k === "Altitude / azimuth")!.v;
    expect(alt).toMatch(/above the horizon · /);
    expect(alt).toMatch(/ · \d+\.\d° [NSEW]+$/);
  });

  test("a circumpolar star's card explains why there is no rise or set", () => {
    const card = describeObject(`star:${(starNames as readonly string[]).indexOf("Polaris")}`, sky, stateAt());
    expect(card!.rows.find((r) => r.k === "Rises")!.v).toBe("—");
    expect(card!.rows.find((r) => r.k === "Sets")!.v).toBe("—");
    expect(card!.note).toContain("circumpolar");
  });

  test("a Messier card names the object type in words", () => {
    const m42 = 4;
    const card = describeObject(`dso:${m42}`, sky, stateAt());
    expect(card!.title).toContain("M42");
    expect(Object.values(DSO_TYPE)).toContain(card!.subtitle);
  });

  test("the Sun and Moon cards carry distance and illumination", () => {
    const moon = describeObject("body:Moon", sky, stateAt());
    expect(moon!.rows.map((r) => r.k)).toContain("Distance from Earth");
    expect(moon!.rows.map((r) => r.k)).toContain("Illuminated");
    expect(moon!.rows.map((r) => r.k)).toContain("Angular diameter");
    const sun = describeObject("body:Sun", sky, stateAt());
    expect(sun!.rows.map((r) => r.k)).not.toContain("Illuminated");
    expect(sun!.rows.find((r) => r.k === "Distance from Earth")!.v).toMatch(/light-minutes/);
  });

  test("an unknown selection id is refused without throwing", () => {
    expect(describeObject("bogus:1", sky, stateAt())).toBeNull();
    expect(describeObject("star:not-a-number", sky, stateAt())).toBeNull();
  });
});

describe("bearing language", () => {
  test("the 32-point names come out where they should", () => {
    expect(cardinal(0)).toBe("N");
    expect(cardinal(11.24)).toBe("N");
    expect(cardinal(11.26)).toBe("NNE");
    expect(cardinal(45)).toBe("NE");
    expect(cardinal(90)).toBe("E");
    expect(cardinal(180)).toBe("S");
    expect(cardinal(225)).toBe("SW");
    expect(cardinal(270)).toBe("W");
    expect(cardinal(348)).toBe("NNW");
    expect(cardinal(359.9)).toBe("N");
    expect(cardinal(-90)).toBe("W"); // −90° is the same bearing as 270°
    expect(cardinal(450)).toBe("E"); // 450° is one turn past 90°
  });

  test("azimuth text pairs the number with the name", () => {
    expect(azimuthText(135.2)).toBe("135.2° SE");
    expect(azimuthText(0)).toBe("0.0° N");
  });


});

describe("the tables beside the sky", () => {
  const sky = computeSky({ date: instant, lat: 47.3769, lon: 8.5417, elevM: 408 });

  test("every body gets an events row with its constellation", () => {
    const rows = eventTable(sky, stateAt());
    expect(rows).toHaveLength(sky.bodies.length);
    for (const row of rows) {
      expect(row.constellation.length).toBeGreaterThan(2);
      expect(row.symbol.length).toBeGreaterThan(0);
    }
    expect(rows.map((r) => r.name)).toContain("Sun");
    expect(rows.map((r) => r.name)).toContain("Pluto");
  });

  test("the twilight table gives an evening and a morning crossing per boundary", () => {
    const rows = twilightTable(stateAt());
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.evening).toBeInstanceOf(Date);
      expect(row.morning).toBeInstanceOf(Date);
      expect(row.evening!.getTime()).toBeLessThan(row.morning!.getTime());
      expect(row.altitude).toBeLessThan(0);
    }
  });

  test("the location summary names the nearest place and the sidereal time", () => {
    const rows = locationSummary(stateAt(), sky);
    const value = (k: string) => rows.find((r) => r.k === k)!.v;
    expect(value("Position")).toBe("47.3769° N, 8.5417° E");
    expect(value("Elevation")).toBe("408 m");
    expect(value("Nearest named place")).toContain("Zürich");
    expect(value("Local sidereal time")).toMatch(/^\d\dh \d\dm /);
    expect(value("Sun altitude")).toContain("night");
  });
});

describe("object kinds are named in words", () => {
  test("every type code in the catalog has a human name", () => {
    for (const meta of dsoMeta) expect(DSO_TYPE[meta.type], `type ${meta.type} of ${meta.id}`).toBeTruthy();
  });
});
