/**
 * skyview.ts — turns the J2000 catalog into "where is it in this observer's sky".
 *
 * One {@link SkyState} is a snapshot for an instant and a place: every catalog point
 * (star, deep-sky object, constellation line vertex, Milky Way and coastline vertex is
 * handled by the caller) precessed to the equator/equinox of date, converted to
 * geometric altitude/azimuth, and bucketed so the renderer can cull cheaply.
 *
 * Altitudes here are **geometric** (no refraction): refraction is a display choice and
 * is applied at draw time, so the horizon ring stays a true circle.
 */
import { Body, Observer } from "astronomy-engine";
import {
  MOON,
  PLANETS,
  SUN,
  constellationOf,
  horizontal,
  horizontalToEquatorial,
  lstDeg,
  placeOf,
  refraction,
  skyFrame,
  mulVec,
  toJ2000,
  type SkyFrame,
  toRaDec,
  unitSphere,
  twilightBand,
  type BodyPlace,
  type Twilight,
} from "./astro";
import {
  constellationBoundData,
  constellationBoundIndex,
  constellationLineData,
  constellationLineIndex,
  constellations,
  dsoData,
  dsoMeta,
  milkyWayData,
  milkyWayIndex,
  starNameIdx,
  starPositions,
} from "./data/sky.generated";


export interface SkyConfig {
  /** instant, UTC */
  date: Date;
  /** observer, WGS84 */
  lat: number;
  lon: number;
  elevM: number;
}

export interface PlacedPoint {
  alt: number;
  az: number;
}

/** [alt, az] pairs for stars (catalog order, brightest first). */
export type StarAltAz = Float32Array;

export interface PathGeometry {
  /** flat [alt, az, alt, az, …] */
  altaz: Float32Array;
  /** [startOffset, vertexCount, tag] triples, mirroring the generated data layout */
  index: Int32Array;
}

export interface SkyState {
  cfgKey: string;
  date: Date;
  lat: number;
  lon: number;
  lst: number;
  /** equinox-of-date frame: obliquity and the J2000 rotation, for reference circles */
  frame: SkyFrame;
  stars: StarAltAz;
  dsos: Float32Array;
  lines: PathGeometry;
  bounds: PathGeometry;
  milkyWay: PathGeometry;
  /** constellation label anchors, alt/az per entry of `constellations` */
  constellations: Float32Array;
  bodies: BodyPlace[];
  sun: BodyPlace;
  moon: BodyPlace;
  sunAlt: number;
  twilight: Twilight;
  observer: Observer;
}

const bodyList = [...PLANETS, SUN, MOON];

function rotateCatalog(
  src: Float32Array,
  dst: Float32Array,
  frame: ReturnType<typeof skyFrame>,
  lat: number,
  lst: number,
  stride: number,
  limitDeclination?: { min: number; max: number },
): void {
  for (let i = 0, j = 0; i < src.length; i += stride, j += 2) {
    const ra = src[i]!;
    const dec = src[i + 1]!;
    const [x, y, z] = unitSphere(ra, dec);
    const [px, py, pz] = mulVec(frame.eqjToOfDate, x, y, z);
    const ofDate = toRaDec(px, py, pz);
    if (limitDeclination && (ofDate.dec < limitDeclination.min || ofDate.dec > limitDeclination.max)) {
      dst[j] = -91;
      dst[j + 1] = 0;
      continue;
    }
    const h = horizontal(ofDate.ra, ofDate.dec, lat, lst);
    dst[j] = h.alt;
    dst[j + 1] = h.az;
  }
}

let cache: { key: string; state: SkyState } | null = null;
const starAltAz = new Float32Array((starPositions.length / 4) * 2);
const dsoAltAz = new Float32Array((dsoData.length / 4) * 2);
const lineAltAz = new Float32Array(constellationLineData.length);
const boundAltAz = new Float32Array(constellationBoundData.length);
const mwAltAz = new Float32Array(milkyWayData.length);
const constAltAz = new Float32Array(constellations.length * 2);

/** Precess + convert everything. Results are cached for an unchanged instant/place. */
export function computeSky(cfg: SkyConfig): SkyState {
  const key = `${cfg.date.getTime()}|${cfg.lat.toFixed(5)}|${cfg.lon.toFixed(5)}`;
  if (cache && cache.key === key) return cache.state;

  const frame = skyFrame(cfg.date);
  const lst = lstDeg(cfg.date, cfg.lon);
  const { lat } = cfg;
  // a star is invisible from this latitude when dec < lat − 90° (never rises) or
  // dec > lat + 90° (never sets); those entries are marked and skipped at draw time
  rotateCatalog(starPositions, starAltAz, frame, lat, lst, 4, { min: lat - 91, max: lat + 91 });
  rotateCatalog(dsoData, dsoAltAz, frame, lat, lst, 4);
  rotateCatalog(constellationLineData, lineAltAz, frame, lat, lst, 2);
  rotateCatalog(constellationBoundData, boundAltAz, frame, lat, lst, 2);
  rotateCatalog(milkyWayData, mwAltAz, frame, lat, lst, 2);

  for (let i = 0; i < constellations.length; i++) {
    const c = constellations[i]!;
    const [x, y, z] = unitSphere(c.ra, c.dec);
    const ofDate = toRaDec(...mulVec(frame.eqjToOfDate, x, y, z));
    const h = horizontal(ofDate.ra, ofDate.dec, lat, lst);
    constAltAz[i * 2] = h.alt;
    constAltAz[i * 2 + 1] = h.az;
  }

  const observer = new Observer(lat, cfg.lon, cfg.elevM);
  const bodies = bodyList.map((b) => placeOf(b.body, b.name, cfg.date, observer, false));
  const sun = bodies.find((b) => b.body === Body.Sun)!;
  const moon = bodies.find((b) => b.body === Body.Moon)!;

  const state: SkyState = {
    cfgKey: key,
    date: cfg.date,
    lat,
    lon: cfg.lon,
    lst,
    frame,
    stars: starAltAz,
    dsos: dsoAltAz,
    lines: { altaz: lineAltAz, index: constellationLineIndex },
    bounds: { altaz: boundAltAz, index: constellationBoundIndex },
    milkyWay: { altaz: mwAltAz, index: milkyWayIndex },
    constellations: constAltAz,
    bodies,
    sun,
    moon,
    sunAlt: sun.alt,
    twilight: twilightBand(sun.alt),
    observer,
  };
  cache = { key, state };
  return state;
}

/** Apparent altitude: geometric altitude plus atmospheric refraction. */
export function apparentAlt(geometricAlt: number): number {
  return geometricAlt + refraction(geometricAlt);
}

/** Catalog index of the brightest named star above `minAlt`, for the "find something" affordance. */
export function brightestAbove(sky: SkyState, minAlt = 20): number {
  for (let i = 0; i < sky.stars.length / 2; i++) {
    if ((sky.stars[i * 2] ?? -91) > minAlt && starNameIdx[i]! >= 0) return i;
  }
  return -1;
}

/**
 * IAU constellation whose 1930 boundary contains a **J2000** position.
 *
 * astronomy-engine's boundary table is keyed to J2000 (it converts from the published
 * B1875.0 figures), so of-date coordinates must not be fed in: precession since 2000 is
 * already ~0.5°, enough to hand a star near a boundary to the wrong figure.
 */
export function constellationName(raJ2000: number, decJ2000: number): string {
  const designator = constellationOf(raJ2000, decJ2000).symbol;
  const found = constellations.find((c) => c.id === designator);
  return found ? found.name : designator;
}

/** The constellation under an observed (altitude, azimuth) for this observer and instant. */
export function constellationUnder(alt: number, az: number, sky: SkyState): string {
  const ofDate = horizontalToEquatorial(alt, az, sky.lat, sky.lst);
  const j2000 = toJ2000(ofDate.ra, ofDate.dec, sky.frame);
  return constellationName(j2000.ra, j2000.dec);
}
