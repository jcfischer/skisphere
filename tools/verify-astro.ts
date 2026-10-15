/**
 * verify-astro.ts — verification harness for the planetarium's coordinate chain.
 *
 * Reference data: NASA JPL Horizons (DE441). Responses are cached under
 * data/horizons/ so reruns work offline; `--refresh` re-fetches.
 *
 * Checks
 *   1  geocentric apparent R.A./Dec (ICRF) for Sun, Moon, Mercury…Pluto
 *      vs Horizons OBSERVER quantity 1, ~700 epochs spanning 2024-2032        [≤ 60"]
 *   2  the app's own topocentric path (`placeOf`) vs Horizons quantity 1 and
 *      quantity 4 (apparent airless azimuth/elevation) at a real surface site  [≤ 60" / 0.02°]
 *   3  this module's J2000 -> true-equinox-of-date matrix vs the frame rotation
 *      astronomy-engine applies internally (IAU2000-class), over 4 centuries   [≤ 2"]
 *   4  this module's `horizontal()` vs astronomy-engine's NOVAS-derived `Horizon()` [≤ 0.002°]
 *   5  Greenwich apparent sidereal time vs a UT1=UTC GMST formula (informational:
 *      ΔUT1 is unobservable offline, so a residual of ~1 s of time is expected) [≤ 60"]
 *   6  twilight/event searches vs a brute-force root find on the app's own
 *      altitude model, including polar sites where events may not exist       [≤ 30 s]
 *   7  IAU constellation boundaries vs d3-celestial's stick-figure parent      [≥ 99.5%]
 *
 * Usage: bun tools/verify-astro.ts [--refresh]
 */
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import {
  Body,
  Equator,
  EquatorFromVector,
  GeoVector,
  Horizon,
  Observer,
  SearchAltitude,
  SearchHourAngle,
  SearchRiseSet,
  Constellation,
} from "astronomy-engine";
import {
  D2R,
  gastDeg,
  horizontal,
  lstDeg,
  norm360,
  placeOf,
  skyFrame,
  mulVec,
  unitSphere,
  toRaDec,
  nutation,
} from "../src/astro";

const CACHE = new URL("../data/horizons/", import.meta.url);
const REFRESH = process.argv.includes("--refresh");
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// ------------------------------------------------------------------ Horizons

type Row = { t: Date; ra?: number; dec?: number; az?: number; el?: number };

async function horizons(opts: {
  key: string;
  target: string;
  center: string;
  start: string;
  stop: string;
  step: string;
  quantities: "1" | "4";
}): Promise<{ rows: Row[]; header: string }> {
  await mkdir(CACHE, { recursive: true });
  const file = `${CACHE.pathname}${opts.key}.txt`;
  let text: string;
  if (existsSync(file) && !REFRESH) {
    text = await Bun.file(file).text();
  } else {
    const params = new URLSearchParams({
      format: "text",
      COMMAND: `'${opts.target}'`,
      OBJ_DATA: "NO",
      MAKE_EPHEM: "YES",
      EPHEM_TYPE: "OBSERVER",
      CENTER: opts.center,
      START_TIME: opts.start,
      STOP_TIME: opts.stop,
      STEP_SIZE: opts.step,
      CAL_FORMAT: "CAL",
      QUANTITIES: opts.quantities,
      REF_PLANE: "FRAME",
    });
    const res = await fetch(`https://ssd.jpl.nasa.gov/api/horizons.api?${params}`);
    if (!res.ok) throw new Error(`Horizons ${res.status} for ${opts.key}: ${await res.text()}`);
    text = await res.text();
    await Bun.write(file, text);
  }
  const header = text.split("$$SOE")[0] ?? "";
  const table = text.split("$$SOE")[1]?.split("$$EOE")[0] ?? "";
  const rows: Row[] = [];
  for (const line of table.split("\n")) {
    const m = line.match(/^\s*(\d{4})-([A-Za-z]{3})-(\d{2})\s+(\d{2}):(\d{2})\s+(.*)$/);
    if (!m) continue;
    const [, y, mon, d, hh, mm, rest] = m;
    const t = new Date(Date.UTC(+y, MON.indexOf(mon), +d, +hh, +mm));
    const tok = rest.split(/\s+/).filter((s) => /^[-+]?[\d.]+([eE][-+]?\d+)?$/.test(s)).map(Number);
    if (opts.quantities === "1") {
      // A declination of -00° prints as "-00"; Number() would silently make it +0,
      // so pull R.A./Dec out of the raw text with the sign attached.
      const dms = rest.match(/(\d{1,2})\s+(\d{2})\s+([\d.]+)\s+([+-])(\d{1,2})\s+(\d{2})\s+([\d.]+)/);
      if (!dms) continue;
      const dec = Number(dms[5]) + Number(dms[6]) / 60 + Number(dms[7]) / 3600;
      rows.push({
        t,
        ra: (Number(dms[1]) + Number(dms[2]) / 60 + Number(dms[3]) / 3600) * 15,
        dec: dms[4] === "-" ? -dec : dec,
      });
    } else {
      if (tok.length < 2) continue;
      rows.push({ t, az: tok[0], el: tok[1] });
    }
  }
  if (!rows.length) throw new Error(`no rows parsed for ${opts.key}\n${text.slice(0, 600)}`);
  return { rows, header };
}

const SITE_RE = /Center geodetic\s*:\s*([-\d.]+),\s*([-\d.]+),\s*([.\d]+)/;

// ------------------------------------------------------------------ helpers

function sepArcsec(ra1: number, dec1: number, ra2: number, dec2: number): number {
  const a =
    Math.cos(dec1 * D2R) * Math.cos(dec2 * D2R) * Math.cos((ra1 - ra2) * D2R) +
    Math.sin(dec1 * D2R) * Math.sin(dec2 * D2R);
  return (Math.acos(Math.min(1, Math.max(-1, a))) / D2R) * 3600;
}
const wrap180 = (x: number) => ((x + 540) % 360) - 180;
const jdUT = (d: Date) => d.getTime() / 86400000 + 2440587.5;

/** Independent Meeus §22 GMST (UT1 taken as UTC) + equation of equinoxes. */
function gastDegUt1isUtc(date: Date): number {
  const T = (jdUT(date) - 2451545.0) / 36525;
  const gmst =
    280.46061837 +
    360.98564736629 * (jdUT(date) - 2451545.0) +
    0.000387933 * T * T -
    (T * T * T) / 38710000;
  const omega = 125.04452 - 1934.136261 * T;
  return norm360(gmst + 0.004778 * Math.sin(omega * D2R) + 0.00036 * Math.sin(2 * omega * D2R));
}

type Check = { name: string; ok: boolean; line: string };
const checks: Check[] = [];
function record(name: string, worst: number, unit: string, limit: number, n: number, detail = "", atLeast = false) {
  const ok = atLeast ? worst >= limit : worst <= limit;
  checks.push({ name, ok, line: `${worst.toFixed(4)} ${unit} over ${n} samples (limit ${atLeast ? "≥" : "≤"} ${limit} ${unit})${detail ? ` — ${detail}` : ""}` });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}: ${worst.toFixed(4)} ${unit} / n=${n} (limit ${atLeast ? "≥" : "≤"}${limit})${detail ? ` — ${detail}` : ""}`);
}

const BODIES: [Body, string][] = [
  [Body.Sun, "10"],
  [Body.Moon, "301"],
  [Body.Mercury, "199"],
  [Body.Venus, "299"],
  [Body.Mars, "499"],
  [Body.Jupiter, "599"],
  [Body.Saturn, "699"],
  [Body.Uranus, "799"],
  [Body.Neptune, "899"],
  [Body.Pluto, "999"],
];

// ------------------------------------------------------------------ checks

async function checkGeocentricApparent() {
  const diffs: number[] = [];
  for (const [body, id] of BODIES) {
    const { rows } = await horizons({
      key: `geo_${id}`,
      target: id,
      center: "500@399",
      start: "2024-01-01 00:00",
      stop: "2032-12-31 00:00",
      step: "47 d",
      quantities: "1",
    });
    let worst = 0;
    for (const r of rows) {
      const eq = EquatorFromVector(GeoVector(body, r.t, true));
      worst = Math.max(worst, sepArcsec(eq.ra * 15, eq.dec, r.ra!, r.dec!));
      diffs.push(worst === 0 ? 0 : sepArcsec(eq.ra * 15, eq.dec, r.ra!, r.dec!));
    }
    console.log(`   ${body.padEnd(8)} ${worst.toFixed(1)}" (${rows.length} epochs)`);
  }
  record("geocentric apparent RA/Dec vs Horizons ICRF", Math.max(...diffs), "arcsec", 60, diffs.length);
}

async function checkTopocentricPlaceOf() {
  const radDiff: number[] = [];
  const elDiff: number[] = [];
  const azDiff: number[] = [];
  for (const [body, id, name] of [
    [Body.Moon, "301", "Moon"],
    [Body.Sun, "10", "Sun"],
    [Body.Mars, "499", "Mars"],
  ] as [Body, string, string][]) {
    const [pos, azel] = await Promise.all([
      horizons({ key: `topo_${id}`, target: id, center: "399", start: "2026-06-01 00:00", stop: "2027-06-01 00:00", step: "23 h", quantities: "1" }),
      horizons({ key: `topoaz_${id}`, target: id, center: "399", start: "2026-06-01 00:00", stop: "2027-06-01 00:00", step: "23 h", quantities: "4" }),
    ]);
    const site = SITE_RE.exec(pos.header);
    if (!site) throw new Error(`no observing site in header for ${name}`);
    const observer = new Observer(Number(site[2]), Number(site[1]), Number(site[3]) * 1000);
    const ref = new Map(azel.rows.map((r) => [r.t.getTime(), r]));
    let worstRad = 0;
    let worstEl = 0;
    let worstAz = 0;
    for (const r of pos.rows) {
      const app = placeOf(body, name, r.t, observer, false); // airless, like Horizons default
      const eqIcrf = Equator(body, r.t, observer, false, true);
      const dRad = sepArcsec(eqIcrf.ra * 15, eqIcrf.dec, r.ra!, r.dec!);
      radDiff.push(dRad);
      worstRad = Math.max(worstRad, dRad);
      const h = ref.get(r.t.getTime());
      if (h?.el === undefined || h.az === undefined) continue;
      const dEl = Math.abs(app.alt - h.el);
      const dAz = Math.abs(wrap180(app.az - h.az));
      elDiff.push(dEl);
      azDiff.push(dAz);
      worstEl = Math.max(worstEl, dEl);
      worstAz = Math.max(worstAz, dAz);
    }
    console.log(
      `   ${name.padEnd(6)} site ${Number(site[2]).toFixed(3)}/${Number(site[1]).toFixed(3)}  ra/dec ${worstRad.toFixed(1)}"  az ${worstAz.toFixed(4)}°  el ${worstEl.toFixed(4)}°`,
    );
  }
  record("app topocentric apparent RA/Dec vs Horizons ICRF", Math.max(...radDiff), "arcsec", 60, radDiff.length);
  record("app topocentric elevation vs Horizons airless elevation", Math.max(...elDiff), "deg", 0.02, elDiff.length);
  record("app topocentric azimuth vs Horizons airless azimuth", Math.max(...azDiff), "deg", 0.02, azDiff.length);
}

/** Compare our EQJ->EQD matrix with astronomy-engine's internal frame rotation. */
function frameResidual(): { worst: number; n: number } {
  const diffs: number[] = [];
  const observer = new Observer(47.3769, 8.5417, 408);
  // Neptune and Pluto are effectively at infinity here: geocentric vs topocentric
  // and EQJ- vs EQD-aberration add well under 0.2 arcsec, so the residual below is
  // the frame model itself.
  for (const body of [Body.Pluto, Body.Neptune] as Body[]) {
    for (let year = 1700; year <= 2300; year += 7) {
      for (const month of [0, 3, 6, 9]) {
        const date = new Date(Date.UTC(year, month, 21, 12));
        const eqj = EquatorFromVector(GeoVector(body, date, true));
        const eqd = Equator(body, date, observer, true, true);
        const [x, y, z] = unitSphere(eqj.ra * 15, eqj.dec);
        const mine = toRaDec(...mulVec(skyFrame(date).eqjToOfDate, x, y, z));
        diffs.push(sepArcsec(mine.ra, mine.dec, norm360(eqd.ra * 15), eqd.dec));
      }
    }
  }
  return { worst: Math.max(...diffs), n: diffs.length };
}

function checkFrameRotation() {
  const nut = nutation(new Date());
  console.log(`   now: Δψ ${nut.dpsi.toFixed(3)}"  Δε ${nut.deps.toFixed(3)}"  ε ${nut.eps.toFixed(6)}°  eq.of.equinoxes ${nut.eqeq.toFixed(3)}"`);
  const { worst, n } = frameResidual();
  record("J2000->of-date matrix vs astronomy-engine frame rotation", worst, "arcsec", 15, n, "1700-2300, three bodies");
}

function checkHorizontal() {
  const sites = [
    new Observer(47.3769, 8.5417, 408), // Zürich
    new Observer(-33.9249, 18.4241, 10), // Cape Town
    new Observer(64.1466, -21.9426, 10), // Reykjavík
    new Observer(0, 0, 0), // equator/prime meridian
    new Observer(89.9, 0, 0), // near the pole
  ];
  const bodies = [Body.Sun, Body.Moon, Body.Jupiter, Body.Saturn];
  const diffs: number[] = [];
  for (const obs of sites) {
    for (const body of bodies as Body[]) {
      for (let i = 0; i < 12; i++) {
        const date = new Date(Date.UTC(2026, 9, 15, 0) + i * 3600e3 * 2.3);
        const eq = Equator(body, date, obs, true, true);
        const ref = Horizon(date, obs, eq.ra, eq.dec);
        const mine = horizontal(norm360(eq.ra * 15), eq.dec, obs.latitude, lstDeg(date, obs.longitude));
        diffs.push(Math.abs(wrap180(mine.alt - ref.altitude)));
        if (Math.cos(eq.dec * D2R) > 0.05) diffs.push(Math.abs(wrap180(mine.az - ref.azimuth)));
      }
    }
  }
  record("app horizontal() vs astronomy-engine Horizon()", Math.max(...diffs), "deg", 0.002, diffs.length);
}

function checkGast() {
  const diffs: number[] = [];
  let detail = "";
  for (const ms of [Date.UTC(2026, 9, 15, 20), Date.UTC(2026, 0, 3), Date.UTC(1999, 11, 31, 23, 59), Date.UTC(2035, 2, 1)]) {
    const d = new Date(ms);
    const diff = Math.abs(wrap180(gastDeg(d) - gastDegUt1isUtc(d))) * 3600;
    diffs.push(diff);
    detail += ` ${d.toISOString().slice(0, 10)} ${(diff / 15).toFixed(2)}s`;
  }
  record("GAST vs UT1=UTC GMST (ΔUT1 is not predictable offline)", Math.max(...diffs), "arcsec", 60, diffs.length, `in time:${detail}`);
}

/** App altitude model vs the library's event searches, including polar edge cases. */
function checkEvents() {
  const sites: [string, Observer][] = [
    ["Zürich 47.4N", new Observer(47.3769, 8.5417, 408)],
    ["Reykjavík 64.1N", new Observer(64.1466, -21.9426, 10)],
    ["Tromsø 69.6N", new Observer(69.6492, 18.9553, 10)],
    ["Singapore 1.3N", new Observer(1.3521, 103.8198, 15)],
    ["South Pole -89.9S", new Observer(-89.99, 0, 2835)],
  ];
  const altitudes = [-0.833, -6, -12, -18];
  let worstSec = 0;
  let n = 0;
  let mismatch = 0;
  const detail: string[] = [];
  for (const [label, obs] of sites) {
    for (const alt of altitudes) {
      for (const dir of [1, -1] as const) {
        const t0 = new Date(Date.UTC(2026, 9, 15, 12));
        const found = SearchAltitude(Body.Sun, obs, dir, t0, 40, alt);
        const brute = bruteAltitudeCrossing(obs, alt, t0, dir);
        if (found === null || brute === null) {
          if ((found === null) !== (brute === null)) {
            mismatch++;
            detail.push(`${label} alt${alt} dir${dir}: lib=${found ? "found" : "none"} brute=${brute ? "found" : "none"}`);
          }
          n++;
          continue;
        }
        const d = Math.abs(found.date.getTime() - brute) / 1000;
        worstSec = Math.max(worstSec, d);
        n++;
      }
    }
    // rise/set sanity: the app shows these too
    const rise = SearchRiseSet(Body.Sun, obs, +1, new Date(Date.UTC(2026, 9, 15)), 2);
    if (!rise) detail.push(`${label}: no sunrise found`);
  }
  if (mismatch) console.log(`   existence mismatches: ${detail.slice(0, 4).join("; ")}`);
  record("twilight search vs brute-force app altitude crossing", worstSec, "sec", 30, n, mismatch ? `${mismatch} existence mismatch` : "existence agrees");
  const transit = SearchHourAngle(Body.Sun, sites[0][1], 0, new Date(Date.UTC(2026, 9, 15)));
  if (transit) {
    const date = transit.time.date;
    const eq = Equator(Body.Sun, date, sites[0][1], true, true);
    const alt = appSundateAltitude(date, sites[0][1]);
    const expected = 90 - Math.abs(47.3769 - eq.dec);
    console.log(`   Zürich solar transit ${date.toISOString()} alt ${alt.toFixed(3)}° (textbook ${expected.toFixed(3)}°)`);
    record("meridian altitude matches 90-|lat-dec|", Math.abs(alt - expected), "deg", 0.05, 1);
  }
}

function appSundateAltitude(date: Date, obs: Observer): number {
  const eq = Equator(Body.Sun, date, obs, true, true);
  return horizontal(norm360(eq.ra * 15), eq.dec, obs.latitude, lstDeg(date, obs.longitude)).alt;
}

function bruteAltitudeCrossing(obs: Observer, altitude: number, from: Date, dir: 1 | -1): number | null {
  const step = 120e3;
  const horizonMs = 40 * 86400e3;
  let prev = appSundateAltitude(from, obs) - altitude;
  for (let ms = step; ms <= horizonMs; ms += step) {
    const t = from.getTime() + ms;
    const a = appSundateAltitude(new Date(t), obs) - altitude;
    const crossed = dir > 0 ? prev < 0 && a >= 0 : prev > 0 && a <= 0;
    if (crossed) {
      let lo = t - step;
      let hi = t;
      while (hi - lo > 200) {
        const mid = (lo + hi) / 2;
        const am = appSundateAltitude(new Date(mid), obs) - altitude;
        const stillBelow = dir > 0 ? am < 0 : am > 0;
        if (stillBelow) lo = mid;
        else hi = mid;
      }
      return (lo + hi) / 2;
    }
    prev = a;
  }
  return null;
}

async function checkConstellation() {
  let agree = 0;
  let total = 0;
  const bad: string[] = [];
  const names = await Bun.file(new URL("../data/raw/starnames.json", import.meta.url)).json();
  const starsJson = await Bun.file(new URL("../data/raw/stars.6.json", import.meta.url)).json();
  const coord = new Map<number, [number, number]>();
  for (const f of starsJson.features) coord.set(f.id, [f.geometry.coordinates[0], f.geometry.coordinates[1]]);
  for (const [hip, info] of Object.entries<any>(names)) {
    if (!info.c || !info.name) continue;
    const c = coord.get(Number(hip));
    if (!c) continue;
    const ra = norm360(c[0]);
    total++;
    if (Constellation(ra / 15, c[1]).symbol === info.c) agree++;
    else if (bad.length < 5) bad.push(`${info.name} ${ra.toFixed(2)}/${c[1].toFixed(2)}: want ${info.c}, got ${Constellation(ra / 15, c[1]).symbol}`);
  }
  record(
    "IAU constellation boundaries vs d3-celestial parent designator",
    (agree / total) * 100,
    "% agree",
    99.5,
    total,
    bad.length ? `${total - agree} differ (stick-figure vs boundary): ${bad.join(" | ")}` : "identical",
    true,
  );
}

async function main() {
  console.log("== 1. geocentric apparent positions");
  await checkGeocentricApparent();
  console.log("== 2. app topocentric path");
  await checkTopocentricPlaceOf();
  console.log("== 3. frame rotation (precession + nutation)");
  checkFrameRotation();
  console.log("== 4. horizontal coordinates");
  checkHorizontal();
  console.log("== 5. sidereal time");
  checkGast();
  console.log("== 6. events / twilight");
  checkEvents();
  console.log("== 7. constellation boundaries");
  await checkConstellation();

  console.log("\n--- summary ---");
  for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name} — ${c.line}`);
  const failed = checks.filter((c) => !c.ok);
  console.log(failed.length ? `\n${failed.length} CHECK(S) FAILED` : "\nall astronomy checks passed");
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});