import { describe, expect, test } from "bun:test";
import { Body, Equator, EquatorFromVector, GeoVector, Observer } from "astronomy-engine";
import {
  D2R,
  R2D,
  arcsec,
  formatDecDms,
  formatRaDms,
  gastDeg,
  horizontal,
  horizontalToEquatorial,
  lstDeg,
  mulVec,
  toRaDec,
  norm360,
  placeOf,
  precessionMatrix,
  skyFrame,
  toJ2000,
  toOfDate,
  unitSphere,
} from "../src/astro";
import { constellationName } from "../src/skyview";

/**
 * Regression guard against JPL Horizons, using the responses cached in `data/horizons/`
 * (see tools/verify-astro.ts, which does the full sweep). No network here: the point is to
 * fail fast in `bun test` if a change ever moves the app's numbers away from the ephemeris.
 */

const CACHE = new URL("../data/horizons/", import.meta.url);
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

interface Row {
  t: Date;
  ra?: number;
  dec?: number;
  az?: number;
  el?: number;
}

async function raw(key: string): Promise<string> {
  return Bun.file(`${CACHE.pathname}${key}.txt`).text();
}

/** The observer the cached response was computed for, read from its own header. */
function siteOf(header: string): { lat: number; lon: number; elevM: number } {
  const m = header.match(/Center geodetic\s*:\s*([-\d.]+),\s*([-\d.]+),\s*([.\d]+)/);
  if (!m) throw new Error("no observer site in this Horizons response");
  return { lon: Number(m[1]), lat: Number(m[2]), elevM: Number(m[3]) * 1000 };
}

async function rows(key: string, quantities: "1" | "4"): Promise<Row[]> {
  const text = await raw(key);
  const table = text.split("$$SOE")[1]?.split("$$EOE")[0] ?? "";
  const out: Row[] = [];
  for (const line of table.split("\n")) {
    const m = line.match(/^\s*(\d{4})-([A-Za-z]{3})-(\d{2})\s+(\d{2}):(\d{2})\s+(.*)$/);
    if (!m) continue;
    const [, y, mon, d, hh, mm, rest] = m;
    const t = new Date(Date.UTC(+y!, MON.indexOf(mon!), +d!, +hh!, +mm!));
    if (quantities === "1") {
      const dms = rest.match(/(\d{1,2})\s+(\d{2})\s+([\d.]+)\s+([+-])(\d{1,2})\s+(\d{2})\s+([\d.]+)/);
      if (!dms) continue;
      const dec = Number(dms[5]) + Number(dms[6])! / 60 + Number(dms[7])! / 3600;
      out.push({
        t,
        ra: (Number(dms[1]) + Number(dms[2])! / 60 + Number(dms[3])! / 3600) * 15,
        dec: dms[4] === "-" ? -dec : dec,
      });
    } else {
      const tok = rest.split(/\s+/).filter((s) => /^[-+]?[\d.]+$/.test(s)).map(Number);
      if (tok.length < 2) continue;
      out.push({ t, az: tok[0], el: tok[1] });
    }
  }
  return out;
}

function separation(ra1: number, dec1: number, ra2: number, dec2: number): number {
  const cos =
    Math.cos(dec1 * D2R) * Math.cos(dec2 * D2R) * Math.cos((ra1 - ra2) * D2R) +
    Math.sin(dec1 * D2R) * Math.sin(dec2 * D2R);
  return (Math.acos(Math.min(1, Math.max(-1, cos))) / D2R) * 3600;
}

describe("against cached JPL Horizons answers", () => {
  test("geocentric apparent places of the Sun and Mars stay inside 60 arcsec", async () => {
    for (const [body, key] of [
      [Body.Sun, "geo_10"],
      [Body.Mars, "geo_499"],
      [Body.Jupiter, "geo_599"],
    ] as [Body, string][]) {
      const table = await rows(key, "1");
      expect(table.length).toBeGreaterThan(40);
      let worst = 0;
      for (const r of table) {
        // Horizons quantity 1 for a geocentre observer is the apparent ICRF place:
        // light-time corrected, aberration included, referred to J2000 axes.
        const eq = EquatorFromVector(GeoVector(body, r.t, true));
        worst = Math.max(worst, separation(eq.ra * 15, eq.dec, r.ra!, r.dec!));
      }
      expect(worst).toBeLessThan(60);
    }
  });

  test("the app's topocentric path matches Horizons airless azimuth and elevation", async () => {
    const table = await rows("topoaz_301", "4");
    expect(table.length).toBeGreaterThan(40);
    const site = siteOf((await raw("topoaz_301")).split("$$SOE")[0] ?? "");
    const observer = new Observer(site.lat, site.lon, site.elevM);
    let worstAz = 0;
    let worstEl = 0;
    for (const r of table) {
      const p = placeOf(Body.Moon, "Moon", r.t, observer, false);
      worstEl = Math.max(worstEl, Math.abs(p.alt - r.el!));
      worstAz = Math.max(worstAz, Math.abs(((p.az - r.az! + 540) % 360) - 180));
    }
    expect(worstEl).toBeLessThan(0.02);
    expect(worstAz).toBeLessThan(0.02);
  });

  test("the frame rotation is identity at J2000 and precesses afterwards", async () => {
    // 2000-01-01 12:00 TT is the defining epoch: precession angles vanish and nutation is
    // a few tens of arcseconds, so the matrix must be very close to the identity.
    const atJ2000 = skyFrame(new Date(Date.UTC(2000, 0, 1, 12, 0)));
    const m = atJ2000.eqjToOfDate;
    expect(m[0]).toBeCloseTo(1, 5);
    expect(m[4]).toBeCloseTo(1, 5);
    expect(m[8]).toBeCloseTo(1, 5);
    expect(Math.abs(m[1])).toBeLessThan(0.0002);
    expect(Math.abs(m[7])).toBeLessThan(0.0002);

    // mean obliquity is 23°26′21.448″ at J2000; nutation in obliquity is worth several
    // arcseconds of it, so the true obliquity sits a little below the mean
    expect(atJ2000.angles.eps0).toBeCloseTo(23.439291, 4);
    expect(atJ2000.angles.eps).toBeLessThan(atJ2000.angles.eps0);
    expect(Math.abs(atJ2000.angles.eps - atJ2000.angles.eps0)).toBeLessThan(0.003);
    expect(Math.abs(atJ2000.angles.eps - (atJ2000.angles.eps0 + atJ2000.angles.deps / 3600))).toBeLessThan(1e-9);
    const now = skyFrame(new Date(Date.UTC(2026, 0, 1)));
    expect(now.angles.eps0).toBeLessThan(atJ2000.angles.eps0);
    expect(now.angles.eps0).toBeGreaterThan(23.4350);
    expect(now.angles.eps0).toBeLessThan(23.4362);

    // the anchor that matters: rotate a body's ICRF place into the equinox of date with
    // this matrix and compare against astronomy-engine's own frame rotation
    const observer = new Observer(0, 0, 0);
    let worst = 0;
    let n = 0;
    // only near-infinity bodies: for the Sun, Moon and inner planets the difference between
    // an EQJ place rotated forward and an EQD place computed with aberration (plus the
    // Moon's parallax) dwarfs the frame model being tested here
    for (const body of [Body.Neptune, Body.Pluto]) {
      for (let i = 0; i < 6; i++) {
        const date = new Date(Date.UTC(1980 + i * 40, i % 12, 21, 12));
        const icrf = EquatorFromVector(GeoVector(body, date, true));
        const [x, y, z] = unitSphere(icrf.ra * 15, icrf.dec);
        const mine = toRaDec(...mulVec(skyFrame(date).eqjToOfDate, x, y, z));
        const theirs = Equator(body, date, observer, true, true);
        worst = Math.max(worst, separation(mine.ra, mine.dec, theirs.ra * 15, theirs.dec));
        n++;
      }
    }
    expect(n).toBe(12);
    // tools/verify-astro.ts records ~13" worst over 1700-2300 for the same four-term
    // nutation series, so 15" is the tolerance this repository commits to
    expect(worst).toBeLessThan(15);
  });
});



describe("sidereal time and the horizontal transform", () => {
  test("local sidereal time advances about 1° every four minutes", () => {
    const t0 = new Date(Date.UTC(2026, 0, 1, 0, 0));
    const t1 = new Date(t0.getTime() + 4 * 60000);
    const d = ((lstDeg(t1, 8.5417) - lstDeg(t0, 8.5417) + 540) % 360) - 180;
    expect(d).toBeGreaterThan(0.9);
    expect(d).toBeLessThan(1.1);
  });

  test("greenwich apparent sidereal time is near the Meeus value (ΔUT1 aside)", () => {
    const d = new Date(Date.UTC(2026, 5, 21, 12, 0));
    const T = (d.getTime() / 86400000 + 2440587.5 - 2451545.0) / 36525;
    const rawGmst =
      280.46061837 +
      360.98564736629 * (d.getTime() / 86400000 + 2440587.5 - 2451545.0) +
      0.000387933 * T * T -
      (T * T * T) / 38710000;
    const gmst = norm360(rawGmst + 0.004778 * Math.sin((125.04452 - 1934.136261 * T) * D2R));
    const diff = Math.abs(((gastDeg(d) - gmst + 540) % 360) - 180);
    // ΔUT1 is not modelled offline, so this is dominated by Earth's rotation phase
    expect(diff).toBeLessThan(0.02); // ≈ 0.08 s of time
  });

  test("a star on the meridian is due south at its maximum altitude", () => {
    const date = new Date(Date.UTC(2026, 2, 1, 22, 0));
    const lat = 47.3769;
    const ra = lstDeg(date, 8.5417); // on the meridian by construction
    const dec = 30;
    const h = horizontal(ra, dec, lat, ra);
    expect(h.alt).toBeCloseTo(90 - lat + dec, 6);
    expect(h.az).toBeCloseTo(180, 6);
  });

  test("a circumpolar star's two culminations bracket the latitude", () => {
    const lat = 47.3769;
    const dec = 89.2641; // Polaris today
    const upper = horizontal(0, dec, lat, 0); // H = 0, above the pole
    const lower = horizontal(0, dec, lat, 180); // H = 12h, below the pole
    expect(upper.alt).toBeCloseTo(90 - (dec - lat), 6);
    expect(lower.alt).toBeCloseTo(dec + lat - 90, 6);
    expect(upper.alt - lower.alt).toBeCloseTo(2 * (90 - dec), 6);
    expect(lower.alt).toBeGreaterThan(0);
    // both culminations of a circumpolar star whose declination exceeds the latitude
    // happen on the northern meridian: above the pole, then below it
    expect(upper.az).toBeCloseTo(0, 6);
    expect(lower.az).toBeCloseTo(0, 6);
  });

  test("at the equator the celestial equator passes through the zenith", () => {
    const h = horizontal(120, 0, 0, 120);
    expect(h.alt).toBeCloseTo(90, 6);
    // azimuth is meaningless exactly at the zenith; it must stay defined and in range
    expect(Number.isFinite(h.az)).toBe(true);
    expect(h.az).toBeGreaterThanOrEqual(0);
    expect(h.az).toBeLessThan(360);
    const setting = horizontal(120, 0, 0, 120 + 90); // hour angle +6h
    expect(setting.alt).toBeCloseTo(0, 6);
    expect(setting.az).toBeCloseTo(270, 6);
    const rising = horizontal(120, 0, 0, 120 - 90); // hour angle −6h
    expect(rising.alt).toBeCloseTo(0, 6);
    expect(rising.az).toBeCloseTo(90, 6);
  });

  test("the precession matrix is orthonormal and its determinant is +1", () => {
    const m = precessionMatrix(new Date(Date.UTC(2026, 0, 1)));
    const [x, y, z] = unitSphere(123.4, -56.7);
    const len = Math.hypot(x, y, z);
    expect(len).toBeCloseTo(1, 12);
    const rows = [
      [m[0], m[1], m[2]],
      [m[3], m[4], m[5]],
      [m[6], m[7], m[8]],
    ];
    for (const r of rows) expect(Math.hypot(...r)).toBeCloseTo(1, 9);
    const det =
      m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
    expect(det).toBeCloseTo(1, 9);
  });

  test("horizontal and equatorial conversions undo each other", () => {
    const latitudes = [47.3769, -33.8688, 0, 69.6492];
    const instants = [0, 61.2, 143.7, 300.1];
    let checked = 0;
    for (const lat of latitudes) {
      for (const ra of [12.3, 180, 279.2347, 350, 101]) {
        for (const dec of [-70, -12.5, 0, 38.7836, 80]) {
          for (const lstValue of instants) {
            const h = horizontal(ra, dec, lat, lstValue);
            if (h.alt < 5) continue; // the inverse triangle is ill-conditioned near the horizon
            const back = horizontalToEquatorial(h.alt, h.az, lat, lstValue);
            // acos() in the inverse triangle is ill-conditioned low in the sky; five
            // degrees of altitude buys about four decimal places
            expect(back.dec).toBeCloseTo(dec, 4);
            expect(norm360(back.ra - ra + 180) - 180).toBeCloseTo(0, 4);
            checked++;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(60);
  });

  test("the frame rotation is a pure rotation and its inverse undoes it", () => {
    // compare directions as unit vectors: right ascension is undefined at the poles, so
    // an angular round-trip there would be a coordinate artefact, not an error
    const frame = skyFrame(new Date(Date.UTC(2026, 9, 15, 20)));
    const m = frame.eqjToOfDate;
    for (const [ra, dec] of [
      [0, 90],
      [0, 0],
      [279.2347, 38.7836],
      [100.7, -60.2],
    ]) {
      const ofDate = toOfDate(ra, dec, frame);
      const back = toJ2000(ofDate.ra, ofDate.dec, frame);
      const [x0, y0, z0] = unitSphere(ra, dec);
      const [x1, y1, z1] = unitSphere(back.ra, back.dec);
      expect(Math.hypot(x1 - x0, y1 - y0, z1 - z0)).toBeLessThan(1e-12);
      // the rotation preserves length
      const [rx, ry, rz] = [
        m[0] * x0 + m[1] * y0 + m[2] * z0,
        m[3] * x0 + m[4] * y0 + m[5] * z0,
        m[6] * x0 + m[7] * y0 + m[8] * z0,
      ];
      expect(Math.hypot(rx, ry, rz)).toBeCloseTo(1, 12);
    }
  });

  test("the constellation under a cursor is the one the catalog star belongs to", () => {
    // Vega: J2000 18h36m56.2s +38°47′, firmly inside Lyra
    expect(constellationName(279.2347, 38.7836)).toBe("Lyra");
    const date = new Date(Date.UTC(2026, 9, 15, 20));
    const lat = 47.3769;
    const lon = 8.5417;
    const lstValue = lstDeg(date, lon);
    const ofDate = toOfDate(279.2347, 38.7836, skyFrame(date));
    const h = horizontal(ofDate.ra, ofDate.dec, lat, lstValue);
    const recovered = horizontalToEquatorial(h.alt, h.az, lat, lstValue);
    const j2000 = toJ2000(recovered.ra, recovered.dec, skyFrame(date));
    expect(constellationName(j2000.ra, j2000.dec)).toBe("Lyra");
    expect(h.alt).toBeGreaterThan(20);
  });

  test("right ascension and declination are written the way astronomers read them", () => {
    expect(formatRaDms(0)).toBe("0h 00m 00.0s");
    expect(formatRaDms(90)).toBe("6h 00m 00.0s");
    expect(formatRaDms(279.2347)).toBe("18h 36m 56.3s"); // Vega
    expect(formatRaDms(279.2347, 0)).toBe("18h 36m 56s");
    expect(formatRaDms(-10)).toBe("23h 20m 00.0s"); // negative input wraps rather than weeps
    expect(formatRaDms(359.9999)).toBe("0h 00m 00.0s"); // rounding carries past midnight
    expect(formatRaDms(0.000001)).toBe("0h 00m 00.0s");
    expect(formatDecDms(38.7836)).toBe("+38° 47′ 01″");
    expect(formatDecDms(-67.2856)).toBe("−67° 17′ 08″"); // the minus sign is a real minus
    expect(formatDecDms(0)).toBe("+00° 00′ 00″");
    expect(formatDecDms(89.9999)).toBe("+90° 00′ 00″"); // rounding carries through arcminutes
    expect(formatDecDms(-0.00001)).toBe("−00° 00′ 00″");
    expect(formatDecDms(45.5)).toBe("+45° 30′ 00″");
    // hours go 0–23, and the seconds field keeps its width whatever the value
    expect(formatRaDms(180)).toBe("12h 00m 00.0s"); // the input is degrees, not hours
    expect(formatRaDms(2)).toBe("0h 08m 00.0s"); // 2° of arc is 8 minutes of time
    expect(formatRaDms(30)).toBe("2h 00m 00.0s");
    expect(formatDecDms(5.0001)).toMatch(/^\+05° 00′ 00″$/);
  });

  test("arcsec conversion is what it says", () => {
    expect(arcsec(1)).toBe(3600);
    expect(arcsec(1 / 3600)).toBeCloseTo(1, 9);
    expect(R2D * D2R).toBeCloseTo(1, 12);
  });
});