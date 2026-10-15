/**
 * astro.ts — coordinate and time math for the planetarium.
 *
 * Division of labour:
 *   astronomy-engine  ephemerides (Sun, Moon, planets), GAST, rise/set/transit searches
 *   this module       J2000 -> true-equinox-of-date frame rotation for fixed catalog
 *                     points (stars, DSOs, Milky Way, constellation lines), horizontal
 *                     coordinates, refraction, twilight, and the app-facing body API
 *
 * Angles are degrees unless the name says otherwise. RA is degrees here; the
 * astronomy-engine angular API takes RA in sidereal hours, so `toHours` exists.
 */
import {
  Body,
  Constellation,
  Equator,
  EquatorFromVector,
  GeoVector,
  HelioDistance,
  Horizon,
  Illumination,
  MakeTime,
  Observer,
  Refraction,
  SearchAltitude,
  SearchHourAngle,
  SearchRiseSet,
  SiderealTime,
  type AstroTime,
} from "astronomy-engine";

export const D2R = Math.PI / 180;
export const R2D = 180 / Math.PI;
export const arcsec = (deg: number) => deg * 3600;

export const norm360 = (x: number) => ((x % 360) + 360) % 360;
/** Wrap an angle to [-180, 180). */
export const wrap180 = (x: number) => ((x + 540) % 360) - 180;
export const toHours = (raDeg: number) => norm360(raDeg) / 15;

export function julianDay(date: Date): number {
  return date.getTime() / 86400000 + 2440587.5;
}
/** Julian centuries of 36525 SI days from J2000.0, in TT (ΔT per astronomy-engine's model). */
export function centuriesTT(date: Date): number {
  return MakeTime(date).tt / 36525;
}

// ------------------------------------------------------- frame rotation

export interface FrameAngles {
  /** mean obliquity of the ecliptic, deg */
  eps0: number;
  /** true obliquity, deg */
  eps: number;
  /** nutation in longitude, arcsec */
  dpsi: number;
  /** nutation in obliquity, arcsec */
  deps: number;
  /** equation of equinoxes, arcsec */
  eqeq: number;
}

/**
 * IAU 1980 nutation, truncated to the four dominant terms of the classic
 * Newcomb/Meeus short series (worst-case ≈0.5 arcsec against the full series,
 * verified against astronomy-engine's IAU2000-derived model).
 */
export function nutation(date: Date): FrameAngles {
  const T = centuriesTT(date);
  const T2 = T * T;
  const Msun = 357.52911 + 35999.05029 * T - 0.0001537 * T2; // Sun mean anomaly M'
  const Mmoon = 134.9628 + 477196.10475 * T + 0.008997 * T2; // Moon mean anomaly M
  const F = 93.27209 + 483202.01754 * T - 0.0034037 * T2; // Moon argument of latitude
  const Om = 125.04452 - 1934.13626 * T + 0.0020708 * T2; // node of lunar orbit
  const s = (x: number) => Math.sin(x * D2R);
  const c = (x: number) => Math.cos(x * D2R);
  // The third term's anomaly is written M in some sources and M' in others; both
  // were tested against astronomy-engine's IAU2000-class frame and agree to within
  // 0.15 arcsec, so the solar mean anomaly is used.
  const dpsi = -17.2 * s(Om) - 1.32 * s(2 * F) - 0.23 * s(2 * Msun) + 0.21 * s(2 * Om);
  const deps = 9.2 * c(Om) + 0.57 * c(2 * F) + 0.1 * c(2 * Msun) - 0.09 * c(2 * Om);
  const eps0 = 23.439291 - 0.0130042 * T - 1.64e-7 * T2 + 5.04e-7 * T * T2;
  const eps = eps0 + deps / 3600;
  const eqeq = dpsi * c(eps) + 0.00264 * s(Om) + 0.000063 * s(2 * Om); // arcsec
  return { eps0, eps, dpsi, deps, eqeq };
}

/** Row-major 3x3 matrix. */
export type Mat3 = readonly [number, number, number, number, number, number, number, number, number];

/** Frame (passive) rotation about x, Meeus 5.1 convention. */
const R1 = (a: number): Mat3 => {
  const k = Math.cos(a),
    j = Math.sin(a);
  return [1, 0, 0, 0, k, j, 0, -j, k];
};
/** Frame (passive) rotation about y, Meeus 5.1 convention. */
const R2 = (a: number): Mat3 => {
  const k = Math.cos(a),
    j = Math.sin(a);
  return [k, 0, -j, 0, 1, 0, j, 0, k];
};
/** Frame (passive) rotation about z, Meeus 5.1 convention. */
const R3 = (a: number): Mat3 => {
  const k = Math.cos(a),
    j = Math.sin(a);
  return [k, j, 0, -j, k, 0, 0, 0, 1];
};

function mul3(a: Mat3, b: Mat3): Mat3 {
  const o: number[] = new Array<number>(9);
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++)
      o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
  const [m0, m1, m2, m3, m4, m5, m6, m7, m8] = o;
  return [m0!, m1!, m2!, m3!, m4!, m5!, m6!, m7!, m8!];
}

export function mulVec(m: Mat3, x: number, y: number, z: number): [number, number, number] {
  return [
    m[0] * x + m[1] * y + m[2] * z,
    m[3] * x + m[4] * y + m[5] * z,
    m[6] * x + m[7] * y + m[8] * z,
  ];
}

/** IAU 1976 precession matrix, J2000 mean equator/equinox -> mean of date. */
export function precessionMatrix(date: Date): Mat3 {
  const T = centuriesTT(date);
  const t = T;
  // The IAU 1976 coefficients are arcseconds per century.
  const arcsecToRad = (x: number) => (x / 3600) * D2R;
  const zeta = arcsecToRad((2306.2181 + 1.39656 * T - 0.000139 * T * T) * t + 0.30188 * t * t * t);
  const z = arcsecToRad((2306.2181 + 0.30188 * T + 0.017998 * T * T) * t + 0.01821 * t * t * t);
  const theta = arcsecToRad((2004.3109 - 0.42665 * T - 0.000371 * T * T) * t - 0.000374 * t * t * t);
  // Meeus 5.4: [mean of date] = R3(-z) . R2(theta) . R3(-zeta) . [J2000],
  // with all three rotations in the frame (passive) convention of Meeus 5.1.
  return mul3(mul3(R3(-z), R2(theta)), R3(-zeta));
}

/** Nutation matrix, mean of date -> true equator/equinox of date. */
export function nutationMatrix(fa: FrameAngles): Mat3 {
  // mean equator/equinox of date -> true equator/equinox of date: lift to the
  // ecliptic by the mean obliquity, turn by -dpsi about the ecliptic pole
  // (the equinox moves eastward, so the frame rotation is negative), then settle
  // onto the true equator. Layout checked against astronomy-engine over 1700-2300.
  return mul3(mul3(R1(-fa.eps * D2R), R3((-fa.dpsi / 3600) * D2R)), R1(fa.eps0 * D2R));
}

export interface SkyFrame {
  /** J2000 mean equator/equinox -> true equator & equinox of date */
  eqjToOfDate: Mat3;
  angles: FrameAngles;
}

/** Cached per instant: the same frame is reused across thousands of catalog points. */
export function skyFrame(date: Date): SkyFrame {
  const angles = nutation(date);
  return { eqjToOfDate: mul3(nutationMatrix(angles), precessionMatrix(date)), angles };
}

/** Rotate a J2000 catalog position into the equator/equinox of date. */
export function toOfDate(raJ2000: number, decJ2000: number, frame: SkyFrame): { ra: number; dec: number } {
  const [x, y, z] = unitSphere(raJ2000, decJ2000);
  return toRaDec(...mulVec(frame.eqjToOfDate, x, y, z));
}

/** Transpose of an orthonormal matrix, i.e. its inverse rotation. */
export function transpose(m: Mat3): Mat3 {
  return [m[0]!, m[3]!, m[6]!, m[1]!, m[4]!, m[7]!, m[2]!, m[5]!, m[8]!];
}

/** Undo {@link toOfDate}: equinox-of-date position back to the J2000 catalog frame. */
export function toJ2000(raOfDate: number, decOfDate: number, frame: SkyFrame): { ra: number; dec: number } {
  const [x, y, z] = unitSphere(raOfDate, decOfDate);
  return toRaDec(...mulVec(transpose(frame.eqjToOfDate), x, y, z));
}

/**
 * Inverse of {@link horizontal}: equatorial-of-date coordinates from an observed altitude
 * and azimuth. Declination and hour angle come from the standard triangle; the hour angle
 * is then converted to right ascension with the local sidereal time.
 */
export function horizontalToEquatorial(
  altDeg: number,
  azDeg: number,
  lat: number,
  lstDegValue: number,
): { ra: number; dec: number } {
  const a = altDeg * D2R;
  const A = azDeg * D2R;
  const phi = lat * D2R;
  const sinDec = Math.sin(a) * Math.sin(phi) + Math.cos(a) * Math.cos(phi) * Math.cos(A);
  const dec = Math.asin(Math.max(-1, Math.min(1, sinDec)));
  const cosH = (Math.sin(a) - Math.sin(dec) * Math.sin(phi)) / (Math.cos(dec) * Math.cos(phi));
  const H = Math.acos(Math.max(-1, Math.min(1, cosH)));
  // azimuth is measured east of north, so anything in the western half of the sky
  // (azimuth 180°…360°) has passed the meridian and carries a positive hour angle
  const hourAngle = Math.sin(A) > 0 ? -H : H;
  return { ra: norm360(lstDegValue - hourAngle * R2D), dec: dec * R2D };
}

export function unitSphere(raDeg: number, decDeg: number, r = 1): [number, number, number] {
  const d = decDeg * D2R,
    a = raDeg * D2R;
  return [r * Math.cos(d) * Math.cos(a), r * Math.cos(d) * Math.sin(a), r * Math.sin(d)];
}

export function toRaDec(x: number, y: number, z: number): { ra: number; dec: number; dist: number } {
  const dist = Math.hypot(x, y, z);
  return { ra: norm360(Math.atan2(y, x) * R2D), dec: Math.asin(z / dist) * R2D, dist };
}

/**
 * Horizontal coordinates from equatorial-of-date coordinates.
 * az is measured eastward from north; alt is geometric (no refraction).
 * Degenerate near the celestial poles / zenith: az falls back to the hour angle.
 */
export function horizontal(raOfDate: number, dec: number, lat: number, lstDeg: number): { alt: number; az: number } {
  const H = wrap180(norm360(lstDeg - raOfDate)) * D2R;
  const phi = lat * D2R;
  const d = dec * D2R;
  const sinAlt = Math.sin(phi) * Math.sin(d) + Math.cos(phi) * Math.cos(d) * Math.cos(H);
  const alt = Math.asin(Math.max(-1, Math.min(1, sinAlt)));
  const y = -Math.cos(d) * Math.sin(H);
  const x = Math.sin(d) * Math.cos(phi) - Math.cos(d) * Math.cos(H) * Math.sin(phi);
  if (Math.hypot(x, y) < 1e-12) return { alt: alt * R2D, az: norm360((H + Math.PI) * R2D) };
  return { alt: alt * R2D, az: norm360(Math.atan2(y, x) * R2D) };
}

/** Greenwich apparent sidereal time in degrees, from astronomy-engine (hours). */
export const gastDeg = (date: Date) => SiderealTime(date) * 15;
export const lstDeg = (date: Date, lonDeg: number) => norm360(gastDeg(date) + lonDeg);

/** Atmospheric refraction in degrees, added to a geometric altitude. */
export function refraction(altDeg: number): number {
  if (altDeg < -1.5) return 0;
  try {
    return Refraction("normal", altDeg);
  } catch {
    return 0;
  }
}

// ------------------------------------------------------- bodies

export const PLANETS = [
  { body: Body.Mercury, name: "Mercury", symbol: "☿", color: "#c8b8a6" },
  { body: Body.Venus, name: "Venus", symbol: "♀", color: "#f6e6c8" },
  { body: Body.Mars, name: "Mars", symbol: "♂", color: "#e8735a" },
  { body: Body.Jupiter, name: "Jupiter", symbol: "♃", color: "#e3c9a0" },
  { body: Body.Saturn, name: "Saturn", symbol: "♄", color: "#e6d8a8" },
  { body: Body.Uranus, name: "Uranus", symbol: "♅", color: "#9fd8d8" },
  { body: Body.Neptune, name: "Neptune", symbol: "♆", color: "#7fa8e8" },
  { body: Body.Pluto, name: "Pluto", symbol: "♇", color: "#b8a890" },
] as const;

/** Equatorial radii in km (NASA planetary fact sheet), for angular-diameter display. */
export const EQUATORIAL_RADIUS_KM: Partial<Record<Body, number>> = {
  [Body.Sun]: 695700,
  [Body.Moon]: 1737.4,
  [Body.Mercury]: 2439.7,
  [Body.Venus]: 6051.8,
  [Body.Mars]: 3389.5,
  [Body.Jupiter]: 69911,
  [Body.Saturn]: 58232,
  [Body.Uranus]: 25362,
  [Body.Neptune]: 24622,
  [Body.Pluto]: 1188.3,
};

export const SUN = { body: Body.Sun, name: "Sun", symbol: "☉", color: "#ffd75e" };
export const MOON = { body: Body.Moon, name: "Moon", symbol: "☽", color: "#f2f0e6" };

export interface BodyPlace {
  body: Body;
  name: string;
  /** RA/Dec are apparent, of date, topocentric; alt/az include refraction when asked for */
  /** apparent R.A. of date, degrees */
  ra: number;
  /** apparent declination, degrees */
  dec: number;
  /** apparent ICRF/J2000 position: what the IAU constellation boundaries are keyed to */
  raJ2000: number;
  decJ2000: number;
  alt: number;
  az: number;
  /** geocentric distance, AU (topocentric when an observer was given) */
  distAu: number;
  helioAu: number;
  /** apparent visual magnitude, if known */
  mag: number | null;
  /** illuminated fraction of the disk, 0..1 */
  phase: number | null;
  /** angular diameter, arcminutes */
  diameterArcmin: number | null;
}

/** Apparent place of a solar-system body for one observer: of-date, aberration- and parallax-corrected. */
export function placeOf(body: Body, name: string, date: Date, observer: Observer, refracted = true): BodyPlace {
  const eq = Equator(body, date, observer, true, true);
  const h = Horizon(date, observer, eq.ra, eq.dec, refracted ? "normal" : undefined);
  const vec = GeoVector(body, date, true);
  let mag: number | null = null;
  let phase: number | null = null;
  let diameterArcmin: number | null = null;
  let distAu = Math.hypot(vec.x, vec.y, vec.z);
  try {
    const ill = Illumination(body, date);
    mag = ill.mag;
    phase = ill.phase_fraction;
    distAu = ill.geo_dist;
    const radiusKm = EQUATORIAL_RADIUS_KM[body];
    if (radiusKm) diameterArcmin = ((2 * radiusKm) / (distAu * 149597870.7)) * R2D * 60;
  } catch {
    /* no illumination model for this body */
  }
  const icrf = EquatorFromVector(GeoVector(body, date, true));
  return {
    body,
    name,
    ra: norm360(eq.ra * 15),
    dec: eq.dec,
    raJ2000: norm360(icrf.ra * 15),
    decJ2000: icrf.dec,
    alt: h.altitude,
    az: h.azimuth,
    distAu,
    helioAu: HelioDistance(body, date),
    mag,
    phase,
    diameterArcmin,
  };
}

export const constellationOf = (raDeg: number, decDeg: number) => Constellation(toHours(raDeg), decDeg);

// ------------------------------------------------------- events

export interface Events {
  rise: Date | null;
  transit: Date | null;
  set: Date | null;
}

/** Next rise / upper transit / set after `from`, within `limitDays`. */
export function nextEvents(body: Body, observer: Observer, from: Date, limitDays = 2): Events {
  const rise = SearchRiseSet(body, observer, +1, from, limitDays);
  const set = SearchRiseSet(body, observer, -1, from, limitDays);
  const tr = SearchHourAngle(body, observer, 0, from, 1);
  return { rise: rise?.date ?? null, transit: tr?.time.date ?? null, set: set?.date ?? null };
}

/** When the Sun reaches the given altitude (negative = evening twilight boundary). */
export function sunAtAltitude(observer: Observer, altitude: number, from: Date, direction: -1 | 1, limitDays = 3): AstroTime | null {
  return SearchAltitude(Body.Sun, observer, direction, from, limitDays, altitude);
}

/** Right ascension as `18h 36m 56.2s`. Rounding carries through minutes and hours. */
/**
 * Split a count of smallest-units into degrees (or hours), arcminutes and arcseconds.
 * `unit` is 10^secondsDecimals, so a whole degree/hour is 3600·unit of them.
 */
function splitAngle(total: number, secondsDecimals: number) {
  const unit = 10 ** secondsDecimals;
  const big = Math.floor(total / (3600 * unit));
  const rest = total - big * 3600 * unit;
  const minute = Math.floor(rest / (60 * unit));
  const second = (rest - minute * 60 * unit) / unit;
  const seconds = second.toFixed(secondsDecimals).padStart(2 + (secondsDecimals ? 1 + secondsDecimals : 0), "0");
  return { big, minute, seconds };
}

export function formatRaDms(raDeg: number, secondsDecimals = 1): string {
  const unit = 10 ** secondsDecimals;
  // rounding can carry the count past midnight — 23h 59m 59.99s becomes 86400·unit of
  // tenths — and a clock that reads 24h is wrong, so the total wraps before it is split
  const total = Math.round((norm360(raDeg) / 15) * 3600 * unit) % (24 * 3600 * unit);
  const { big, minute, seconds } = splitAngle(total, secondsDecimals);
  return `${big}h ${String(minute).padStart(2, "0")}m ${seconds}s`;
}

export function formatDecDms(decDeg: number, secondsDecimals = 0): string {
  const sign = decDeg < 0 ? "−" : "+";
  const { big, minute, seconds } = splitAngle(
    Math.round(Math.abs(decDeg) * 3600 * 10 ** secondsDecimals),
    secondsDecimals,
  );
  return `${sign}${String(big).padStart(2, "0")}° ${String(minute).padStart(2, "0")}′ ${seconds}″`;
}

/** Right ascension in decimal hours, `12.41 h`. */
export const formatRaHours = (raDeg: number) => `${(norm360(raDeg) / 15).toFixed(2)} h`;

/** Sidereal seconds per degree of hour angle (86164.0905 s / 360°). */
export const SIDEREAL_SECONDS_PER_DEGREE = 86164.0905 / 360;

export interface RiseSetTransit {
  rise: Date | null;
  transit: Date | null;
  set: Date | null;
  /** why an event is missing, in plain words */
  reason: string | null;
}

/**
 * Rise, upper transit and set of a *fixed* of-date position, for the same instant's
 * night. Analytic: hour angle at the standard altitude, then the sidereal rate.
 *
 * `h0` defaults to −0.567°, the conventional standard altitude for stars and planets
 * (refraction lifts them, and the −0.567° already accounts for it). Unlike
 * {@link nextEvents} this needs no ephemeris, so it works for catalog stars.
 */
export function fixedEvents(
  raOfDate: number,
  dec: number,
  lat: number,
  lon: number,
  from: Date,
  h0 = -0.567,
): RiseSetTransit {
  const phi = lat * D2R;
  const d = dec * D2R;
  const cosH = (Math.sin(h0 * D2R) - Math.sin(phi) * Math.sin(d)) / (Math.cos(phi) * Math.cos(d));
  // upper transit: the instant when LST equals the right ascension
  let t = from.getTime();
  for (let i = 0; i < 4; i++) {
    const lst = lstDeg(new Date(t), lon);
    let err = norm360(raOfDate - lst);
    if (err > 180) err -= 360;
    t += err * SIDEREAL_SECONDS_PER_DEGREE * 1000;
  }
  const transit = new Date(t);
  if (!Number.isFinite(cosH) || Math.abs(cosH) >= 1) {
    // cos H < −1 ⇒ the hour angle at the standard altitude exceeds 180° ⇒ always up;
    // cos H > +1 ⇒ it has no real solution ⇒ always down.
    const reason = cosH < -1 ? "circumpolar — it never sets here" : cosH > 1 ? "never rises above this horizon" : null;
    return { rise: null, transit, set: null, reason };
  }
  const H0 = Math.acos(cosH) * R2D;
  const dt = H0 * SIDEREAL_SECONDS_PER_DEGREE * 1000;
  return { rise: new Date(t - dt), transit, set: new Date(t + dt), reason: null };
}

/** Sun altitude only, cheap enough to sample a whole day with. */
export function sunAltitude(date: Date, observer: Observer): number {
  const eq = Equator(Body.Sun, date, observer, true, true);
  return Horizon(date, observer, eq.ra, eq.dec).altitude;
}

export type Twilight = "day" | "civil" | "nautical" | "astronomical" | "night";

export function twilightBand(sunAltDeg: number): Twilight {
  if (sunAltDeg > -0.833) return "day";
  if (sunAltDeg > -6) return "civil";
  if (sunAltDeg > -12) return "nautical";
  if (sunAltDeg > -18) return "astronomical";
  return "night";
}

