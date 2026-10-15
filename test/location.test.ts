import { describe, expect, test } from "bun:test";
import {
  distanceKm,
  foldName,
  formatClock,
  formatDateWall,
  formatOffset,
  formatWall,
  nearestPlace,
  setCurrentLon,
  siteOffsetMs,
  utcToWall,
  wallInputValue,
  wallToUtc,
} from "../src/location";

const instant = new Date("2026-10-15T20:00:00.000Z");

describe("wall clocks", () => {
  test("UTC mode reads the instant straight through", () => {
    expect(utcToWall(instant, "utc").parts.slice(0, 5)).toEqual([2026, 10, 15, 20, 0]);
    expect(formatWall(instant, "utc")).toBe("2026-10-15 20:00 UTC (UTC+00:00)");
    expect(formatClock(instant, "utc")).toBe("20:00");
    expect(formatDateWall(instant, "utc")).toBe("2026-10-15");
  });

  test("site mode is mean solar time at the longitude, offset to the minute", () => {
    setCurrentLon(8.5417);
    expect(siteOffsetMs(instant)).toBe(34 * 60000);
    expect(formatOffset(siteOffsetMs(instant) / 3600000)).toBe("+00:34");
    const { parts, label } = utcToWall(instant, "site");
    expect(label).toBe("site");
    expect([parts[3], parts[4]]).toEqual([20, 34]);
    expect(formatWall(instant, "site")).toBe("2026-10-15 20:34 site (UTC+00:34)");
  });

  test("a western longitude gives a negative offset", () => {
    setCurrentLon(-74.006);
    expect(siteOffsetMs(instant)).toBe(-296 * 60000);
    expect(formatOffset(siteOffsetMs(instant) / 3600000)).toBe("-04:56");
    const { parts } = utcToWall(instant, "site");
    expect([parts[2], parts[3], parts[4]]).toEqual([15, 15, 4]);
  });

  test("wall ↔ UTC round-trips in every mode", () => {
    setCurrentLon(8.5417);
    for (const mode of ["utc", "site", "browser"] as const) {
      // the <input type="datetime-local"> form is "YYYY-MM-DDTHH:MM"; the clock model
      // wants the five separate fields, which is what the panel splits it into
      const value = wallInputValue(instant, mode);
      const [datePart, hour, minute] = value.split(/[T:]/);
      const parts = [...datePart!.split("-").map(Number), Number(hour), Number(minute)];
      expect(parts).toHaveLength(5);
      const back = wallToUtc(parts, mode);
      expect(back.toISOString()).toBe(instant.toISOString());
    }
  });

  test("site mode crosses the date line of the wall clock, not the instant", () => {
    setCurrentLon(-150);
    const midnight = new Date("2026-10-15T02:00:00.000Z");
    const { parts } = utcToWall(midnight, "site");
    expect([parts[1], parts[2], parts[3], parts[4]]).toEqual([10, 14, 16, 0]); // −10 h
    expect(wallToUtc(parts, "site").toISOString()).toBe(midnight.toISOString());
  });
});

describe("the gazetteer as geography", () => {
  test("distances between known cities come out right", () => {
    // Zürich → Davos (about 90 km) and Zürich → Sydney (about 16 570 km)
    expect(distanceKm({ lat: 47.3769, lon: 8.5417 }, { lat: 46.7955, lon: 10.2975 })).toBeGreaterThan(80);
    expect(distanceKm({ lat: 47.3769, lon: 8.5417 }, { lat: 46.7955, lon: 10.2975 })).toBeLessThan(160);
    expect(distanceKm({ lat: 47.3769, lon: 8.5417 }, { lat: 47.3769, lon: 8.5417 })).toBe(0);
    const zurichSydney = distanceKm({ lat: 47.3769, lon: 8.5417 }, { lat: -33.8688, lon: 151.2093 });
    expect(zurichSydney).toBeGreaterThan(16400);
    expect(zurichSydney).toBeLessThan(17000);
  });

  test("nearest named place is the place itself", () => {
    expect(nearestPlace(47.3769, 8.5417).place.name).toBe("Zürich");
    expect(nearestPlace(-33.87, 151.21).place.name).toBe("Sydney");
    const midAtlantic = nearestPlace(30.0, -40.0);
    expect(midAtlantic.km).toBeGreaterThan(500);
  });

  test("name folding survives letters Unicode will not decompose", () => {
    expect(foldName("Tromsø")).toBe("tromso");
    expect(foldName("Zürich")).toBe("zurich");
    expect(foldName("Köln")).toBe("koln");
    expect(foldName("São Paulo")).toBe("sao paulo");
    expect(foldName("Dakhla")).toBe("dakhla");
    expect(foldName("Aarhaus/Aarhus")).toBe("aarhaus aarhus");
    expect(foldName("Straße")).toBe("strasse");
  });
});