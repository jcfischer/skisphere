import { describe, expect, test } from "bun:test";
import {
  DEFAULT_STATE,
  clampLat,
  coordinateLabel,
  findCity,
  formatLat,
  formatLon,
  stateFromHash,
  stateToHash,
  wrapLon,
  type AppState,
} from "../src/state";
import { DEFAULT_LAYERS } from "../src/render";

const at = new Date("2026-10-15T20:00:00.000Z");

function state(over: Partial<AppState>): AppState {
  return { ...DEFAULT_STATE, date: at, follow: false, ...over };
}

describe("the share link", () => {
  test("place, instant and label survive a round trip", () => {
    const s = state({ lat: 47.3769, lon: 8.5417, elevM: 408, place: "Zürich" });
    const back = stateFromHash(stateToHash(s), { ...DEFAULT_STATE, date: new Date(0), follow: true });
    expect(back.lat).toBeCloseTo(47.3769, 5);
    expect(back.lon).toBeCloseTo(8.5417, 5);
    expect(back.elevM).toBe(408);
    expect(back.place).toBe("Zürich");
    expect(back.date.toISOString()).toBe(at.toISOString());
    expect(back.follow).toBe(false);
  });

  test("no hash keeps the defaults and keeps following the clock", () => {
    const back = stateFromHash("", state({}));
    expect(back.date.toISOString()).toBe(at.toISOString());
    expect(back.place).toBe(DEFAULT_STATE.place);
  });

  test("layers round-trip and an empty layer list changes nothing", () => {
    const s = state({ layers: { ...DEFAULT_LAYERS, bounds: true, ecliptic: true, lines: false } });
    const back = stateFromHash(stateToHash(s), state({}));
    expect(back.layers.bounds).toBe(true);
    expect(back.layers.ecliptic).toBe(true);
    expect(back.layers.lines).toBe(false);
    expect(back.layers.stars).toBe(true);
  });

  test("projection, zoom, rotation, magnitude limit and selection survive", () => {
    const s = state({
      projection: "equidistant",
      zoom: 2.5,
      rotation: 135,
      magLimit: 4.25,
      selected: "dso:4",
      timeMode: "utc",
    });
    const back = stateFromHash(stateToHash(s), state({}));
    expect(back.projection).toBe("equidistant");
    expect(back.zoom).toBeCloseTo(2.5, 4);
    expect(back.rotation).toBe(135);
    // the link carries one decimal of limiting magnitude, which is finer than the slider
    expect(back.magLimit).toBe(4.3);
    expect(back.selected).toBe("dso:4");
    expect(back.timeMode).toBe("utc");
  });

  test("out-of-range and garbage values are refused, not applied", () => {
    const back = stateFromHash("#lat=140&lon=-500&zoom=900&proj=gnomonic&mag=22&t=nonsense", state({}));
    // latitude clamps and longitude wraps rather than being thrown away: a link that says
    // "140° N" means "straight up at the pole", while a bad number falls back to the default
    expect(back.lat).toBe(90);
    expect(back.lon).toBe(-140);
    expect(back.zoom).toBe(1);
    expect(back.projection).toBe("stereographic");
    expect(back.magLimit).toBe(6);
    expect(back.date.toISOString()).toBe(at.toISOString());
  });

  test("latitude clamps and longitude wraps", () => {
    expect(clampLat(95)).toBe(90);
    expect(clampLat(-200)).toBe(-90);
    expect(wrapLon(190)).toBeCloseTo(-170, 9);
    expect(wrapLon(-190)).toBeCloseTo(170, 9);
    expect(wrapLon(360)).toBeCloseTo(0, 9);
  });

  test("coordinate labels carry the hemisphere letters", () => {
    expect(formatLat(47.3769)).toBe("47.377°N");
    expect(formatLat(-33.8688)).toBe("33.869°S");
    expect(formatLon(-74.006)).toBe("74.006°W");
    expect(formatLon(8.5417)).toBe("8.542°E");
    expect(coordinateLabel(0, 0)).toBe("0.000°N 0.000°E");
  });
});

describe("place lookup", () => {
  test("diacritics and plain-ASCII spellings both find a city", () => {
    for (const q of ["Zürich", "zurich", "ZURICH", " zürich "]) expect(findCity(q)?.name).toBe("Zürich");
    for (const q of ["Tromso", "tromsø", "TROMSØ"]) expect(findCity(q)?.name).toBe("Tromsø");
    expect(findCity("geneve")?.name).toBe("Genève");
    expect(findCity("Sao Paulo")?.name).toBe("São Paulo");
    expect(findCity("La Paz")?.country).toBe("BO");
  });

  test("prefix matching is forgiving, nonsense finds nothing", () => {
    expect(findCity("franc")?.name).toBe("San Francisco");
    expect(findCity("kai")?.name).toBe("Kairo");
    expect(findCity("qqqq")).toBeNull();
    expect(findCity("")).toBeNull();
  });

  test("the gazetteer holds plausible coordinates", () => {
    for (const c of findCity("Zürich") ? [] : []) void c;
    const zurich = findCity("Zürich")!;
    expect(zurich.lat).toBeGreaterThan(47);
    expect(zurich.lon).toBeGreaterThan(8);
    const sydney = findCity("Sydney")!;
    expect(sydney.lat).toBeLessThan(-33);
    expect(sydney.elev).toBeLessThan(100);
  });
});