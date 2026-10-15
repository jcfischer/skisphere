import { describe, expect, test } from "bun:test";
import { BODIES, search } from "../src/search";
import { CITIES, distanceKm, foldName, nearestPlace } from "../src/location";

const ids = (query: string, limit = 8) => search(query, limit).map((r) => r.id);

describe("one search box for the whole catalog", () => {
  test("a star is found by name and answered with its magnitude and HIP number", () => {
    const results = search("vega");
    expect(results).toHaveLength(2); // Vega and Las Vegas
    expect(results[0]!.id).toBe("star:4");
    expect(results[0]!.kind).toBe("star");
    expect(results[0]!.label).toBe("Vega");
    expect(results[0]!.detail).toMatch(/V 0\.0/);
    expect(results[0]!.detail).toContain("HIP 91262");
    expect(results[0]!.index).toBe(4);
    expect(results[1]!.kind).toBe("city");
  });

  test("a Messier object answers to its number and to its proper name", () => {
    expect(ids("m42")).toEqual(["dso:4"]);
    expect(search("m42")[0]!.label).toBe("M42 · Orion Nebula");
    expect(search("orion nebula")[0]!.id).toBe("dso:4");
    expect(ids("pleiades")[0]).toBe("dso:0"); // M45 heads the catalog
    expect(search("m45")[0]!.detail).toContain("mag 1.2");
    // a bare number also matches Bayer-designated stars, which rank above a substring hit
    expect(search("42", 3).map((m) => m.kind)).toEqual(["star", "star", "star"]);
    expect(ids("42", 25)).toContain("dso:4");
  });

  test("a constellation is found by its Latin name and by its English one", () => {
    const lyra = search("lyra");
    expect(lyra).toHaveLength(1);
    expect(lyra[0]!.id).toBe("constellation:51");
    expect(lyra[0]!.detail).toBe("Lyre · Lyr · genitive Lyrae");
    expect(search("orion")[0]!.id).toBe("constellation:59");
    // the panel and the sky say "Cetus"; the English name still finds it, one rank lower
    const whale = search("whale");
    expect(whale[0]!.id).toBe("constellation:20");
    expect(whale[0]!.label).toBe("Cetus");
    // the designator matches the constellation and a Bayer star alike, ranked by label length
    expect(search("lyr").map((m) => m.id)).toContain("constellation:51");
    expect(search("lyrae")[0]!.id).toBe("constellation:51"); // genitive
  });

  test("the ten wanderers are all findable", () => {
    expect(BODIES).toEqual([
      "Sun",
      "Moon",
      "Mercury",
      "Venus",
      "Mars",
      "Jupiter",
      "Saturn",
      "Uranus",
      "Neptune",
      "Pluto",
    ]);
    for (const name of BODIES) {
      const hits = search(name);
      expect(hits.length, name).toBeGreaterThan(0);
      expect(hits[0]!.id, name).toBe(`body:${name}`);
      expect(hits[0]!.kind, name).toBe("body");
      expect(hits[0]!.detail, name).toBe("solar-system body");
    }
  });

  test("a city is found, with or without the diacritics", () => {
    expect(ids("zurich")).toContain("city:0");
    expect(ids("Zürich")[0]).toBe("city:0");
    expect(search("zurich")[0]!.label).toBe("Zürich");
    expect(search("zurich")[0]!.detail).toBe("CH · 47.38° 8.54°");
    expect(search("zurich")[0]!.place?.elev).toBe(408);
    expect(search("tromso")[0]!.label).toBe("Tromsø");
    expect(search("sao paulo")[0]!.label).toBe("São Paulo");
    expect(search("tokyo")[0]!.kind).toBe("city");
  });

  test("exact matches beat prefixes, prefixes beat substrings", () => {
    const top = search("mars"); // Mars the planet, not "Mars-" anything
    expect(top[0]!.id).toBe("body:Mars");
    const scores = search("ori", 12).map((m) => `${m.kind}:${m.label}`);
    expect(scores[0]).toContain("Ori"); // Orion / Ori ranks first among prefix hits
    expect(search("").length).toBe(0);
    expect(search("m").length).toBe(0); // one character is not a search
    expect(search("   ").length).toBe(0);
    expect(search("zzzzqqqq")).toEqual([]);
  });

  test("the result limit is honoured", () => {
    expect(search("a", 200)).toHaveLength(0); // still one character
    expect(search("st", 5).length).toBeLessThanOrEqual(5);
    expect(search("a b", 3).length).toBeLessThanOrEqual(3);
    const many = search("or", 300);
    expect(many.length).toBeGreaterThan(20);
    expect(many.length).toBeLessThanOrEqual(300);
  });
});

describe("name folding", () => {
  test("diacritics and case do not decide a match", () => {
    expect(foldName("Zürich")).toBe(foldName("zurich"));
    expect(foldName("Tromsø")).toBe(foldName("tromso"));
    expect(foldName("São Paulo")).toBe(foldName("sao paulo"));
    expect(foldName("København")).toBe(foldName("Kobenhavn"));
    expect(foldName("Anstruther")).toBe(foldName("anstruther"));
    expect(foldName("Ø").length).toBeGreaterThan(0);
  });

  test("a folded name keeps its word shape for prefix searches", () => {
    expect(foldName("  Great   Bear  ")).toBe("great bear");
    expect(foldName("Crux")).toBe("crux");
    expect(foldName("β Andromedae")).toContain("andromedae");
  });
});

describe("nearest named place", () => {
  test("the gazetteer answers with the expected town", () => {
    expect(nearestPlace(47.3769, 8.5417).place.name).toBe("Zürich");
    expect(nearestPlace(51.5074, -0.1278).place.name).toBe("London");
    expect(nearestPlace(-33.8688, 151.2093).place.name).toBe("Sydney");
    expect(nearestPlace(-22.9068, -43.1729).place.name).toBe("Rio de Janeiro");
    expect(nearestPlace(35.6895, 139.6917).place.name).toBe("Tokyo");
    expect(nearestPlace(69.6492, 18.9553).place.name).toBe("Tromsø");
    expect(nearestPlace(47.3769, 8.5417).km).toBeLessThan(1);
  });

  test("the open ocean is still attributed to somewhere", () => {
    const mid = nearestPlace(0, -140);
    expect(mid.place.name.length).toBeGreaterThan(1);
    expect(mid.km).toBeGreaterThan(500);
  });

  test("the date-line wrap does not double the distance", () => {
    const east = nearestPlace(0, 179.99);
    const west = nearestPlace(0, -179.99);
    expect(east.place.name).toBe(west.place.name);
    // 0.02° of longitude is about two kilometres at the equator, not 40 000
    expect(Math.abs(east.km - west.km)).toBeLessThan(1);
  });
});

describe("great-circle distance", () => {
  test("it measures what a globe would", () => {
    const city = (name: string) => CITIES.find((c) => c.name === name)!;
    const zurich = city("Zürich");
    const london = city("London");
    const tokyo = city("Tokyo");
    const sydney = city("Sydney");
    expect(distanceKm(zurich, zurich)).toBeCloseTo(0, 9);
    // Zürich–London ≈ 780 km, Zürich–Tokyo ≈ 9 600 km, Zürich–Sydney ≈ 16 900 km
    expect(distanceKm(zurich, london)).toBeGreaterThan(700);
    expect(distanceKm(zurich, london)).toBeLessThan(860);
    expect(distanceKm(zurich, tokyo)).toBeGreaterThan(9000);
    expect(distanceKm(zurich, tokyo)).toBeLessThan(10200);
    expect(distanceKm(zurich, sydney)).toBeGreaterThan(16000);
    expect(distanceKm(zurich, sydney)).toBeLessThan(17800);
    expect(distanceKm(zurich, sydney)).toBeGreaterThan(distanceKm(zurich, tokyo));
    expect(distanceKm(tokyo, zurich)).toBeCloseTo(distanceKm(zurich, tokyo), 9);
    // across the date line the short way is the short way
    const fiji = { lat: -17.7134, lon: 178.065 };
    const seattle = { lat: 47.6062, lon: -122.3321 };
    expect(distanceKm(fiji, seattle)).toBeGreaterThan(9000);
    expect(distanceKm(fiji, seattle)).toBeLessThan(9700);
  });
});