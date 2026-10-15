/**
 * details.ts — the words beside the picture: object cards, rise/transit/set tables,
 * twilight times, and the coordinate formats they are written in.
 *
 * Everything here is a pure function of {@link SkyState} plus the app state, so the panels
 * can be rebuilt on any frame without touching the DOM twice.
 */
import { Body, Observer } from "astronomy-engine";
import {
  SUN,
  MOON,
  PLANETS,
  fixedEvents,
  formatRaDms,
  formatDecDms,
  nextEvents,
  sunAltitude,
  sunAtAltitude,
  toOfDate,
  type BodyPlace,
} from "./astro";
import {
  constellations,
  dsoData,
  dsoMeta,
  starHip,
  starNameIdx,
  starNames,
  starPositions,
} from "./data/sky.generated";
import { apparentAlt, constellationName, type SkyState } from "./skyview";
import { moonWaxing } from "./render";
import { formatEventDate, formatEventTime, nearestPlace, type TimeMode } from "./location";
import type { AppState } from "./state";

export interface Row {
  k: string;
  v: string;
}

export interface ObjectDetails {
  title: string;
  subtitle: string;
  rows: Row[];
  note?: string;
}

/**
 * Object kinds as the Messier catalog ships them. The codes come from the catalog file
 * (see data/SOURCES.md); M31/M33/M81 are the spirals, M110/M32/M49 the ellipticals,
 * M82 the irregular, and `pos` marks the three historical entries that turn out to be
 * asterisms or a disputed position rather than a nebula.
 */
export const DSO_TYPE: Record<string, string> = {
  oc: "open cluster",
  gc: "globular cluster",
  s: "spiral galaxy",
  e: "elliptical galaxy",
  i: "irregular galaxy",
  sfr: "emission nebula and star-forming region",
  pn: "planetary nebula",
  snr: "supernova remnant",
  rn: "reflection nebula",
  pos: "asterism or disputed position",
  g: "galaxy",
  en: "emission nebula",
  dn: "dark nebula",
  fn: "nebula",
};

const CARDINALS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];

export function cardinal(azDeg: number): string {
  return CARDINALS[Math.round((((azDeg % 360) + 360) % 360) / 22.5) % 16]!;
}

export function azimuthText(az: number): string {
  return `${az.toFixed(1)}° ${cardinal(az)}`;
}

/**
 * "+50.9° above the horizon", optionally with a bearing. Catalogue altitudes are the
 * geometric ones the renderer uses, so refraction is applied here unless the caller says
 * the value already carries it (the Sun, Moon and planets come back refracted).
 */
export function altitudeText(alt: number, az?: number, alreadyRefracted = false): string {
  const a = alreadyRefracted ? alt : apparentAlt(alt);
  const words = `${a >= 0 ? "+" : "−"}${Math.abs(a).toFixed(1)}° ${a >= 0 ? "above" : "below"} the horizon`;
  return az === undefined ? words : `${words} · ${azimuthText(az)}`;
}

function positionRows(raOfDate: number, decOfDate: number, raJ2000?: number, decJ2000?: number): Row[] {
  const rows: Row[] = [
    { k: "RA / Dec (of date)", v: `${formatRaDms(raOfDate)}  ${formatDecDms(decOfDate)}` },
  ];
  if (raJ2000 !== undefined && decJ2000 !== undefined) {
    rows.push({ k: "RA / Dec (J2000)", v: `${formatRaDms(raJ2000)}  ${formatDecDms(decJ2000)}` });
    rows.push({ k: "Constellation", v: constellationName(raJ2000, decJ2000) });
  }
  return rows;
}

function eventRow(label: string, date: Date | null, mode: TimeMode): Row {
  if (!date) return { k: label, v: "—" };
  return { k: label, v: `${formatEventTime(date, mode)} (${formatEventDate(date, mode)})` };
}

/** Star card: catalogue identity, place, and its events for the current night. */
export function describeStar(index: number, sky: SkyState, state: AppState): ObjectDetails {
  const base = index * 4;
  const raJ = starPositions[base]!;
  const decJ = starPositions[base + 1]!;
  const mag = starPositions[base + 2]!;
  const bv = starPositions[base + 3]!;
  const ofDate = toOfDate(raJ, decJ, sky.frame);
  const nameIdx = starNameIdx[index]!;
  const name = nameIdx >= 0 ? starNames[nameIdx]! : `HIP ${starHip[index]}`;
  const alt = sky.stars[index * 2]!;
  const az = sky.stars[index * 2 + 1]!;
  const ev = fixedEvents(ofDate.ra, ofDate.dec, sky.lat, sky.lon, state.date);
  const rows: Row[] = [
    { k: "Altitude / azimuth", v: altitudeText(alt, az) },
    ...positionRows(ofDate.ra, ofDate.dec, raJ, decJ),
    { k: "Visual magnitude", v: mag.toFixed(2) },
    { k: "Colour index B−V", v: bv.toFixed(3) },
    { k: "Hipparcos", v: `HIP ${starHip[index]}` },
    eventRow("Rises", ev.rise, state.timeMode),
    eventRow("Transits", ev.transit, state.timeMode),
    eventRow("Sets", ev.set, state.timeMode),
  ];
  return {
    title: name,
    subtitle: `star · ${constellationName(raJ, decJ)}`,
    rows,
    note: ev.reason ?? (nameIdx < 0 ? "This star carries no proper name in the catalogue." : undefined),
  };
}

/** Messier object card. */
export function describeDso(index: number, sky: SkyState, state: AppState): ObjectDetails {
  const meta = dsoMeta[index]!;
  const base = index * 4;
  const raJ = dsoData[base]!;
  const decJ = dsoData[base + 1]!;
  const mag = dsoData[base + 2]!;
  const sizeArcmin = dsoData[base + 3]!;
  const ofDate = toOfDate(raJ, decJ, sky.frame);
  const alt = sky.dsos[index * 2]!;
  const az = sky.dsos[index * 2 + 1]!;
  const ev = fixedEvents(ofDate.ra, ofDate.dec, sky.lat, sky.lon, state.date);
  const rows: Row[] = [
    { k: "Altitude / azimuth", v: altitudeText(alt, az) },
    ...positionRows(ofDate.ra, ofDate.dec, raJ, decJ),
    { k: "Magnitude", v: mag.toFixed(1) },
    { k: "Apparent size", v: sizeArcmin > 0 ? `${sizeArcmin.toFixed(0)}′` : "point-like" },
    eventRow("Rises", ev.rise, state.timeMode),
    eventRow("Transits", ev.transit, state.timeMode),
    eventRow("Sets", ev.set, state.timeMode),
  ];
  return {
    title: `${meta.id}${meta.name && meta.name !== meta.id ? ` · ${meta.name}` : ""}`,
    subtitle: DSO_TYPE[meta.type] ?? meta.type,
    rows,
    note: ev.reason ?? (alt < -12 ? "Far below the horizon now — look for it later tonight." : undefined),
  };
}

const PHASE_NAMES: [number, string][] = [
  [0.02, "new"],
  [0.25, "waxing crescent"],
  [0.48, "first quarter"],
  [0.72, "waxing gibbous"],
  [0.98, "full"],
];

function phaseName(fraction: number, waxing: boolean): string {
  for (const [limit, name] of PHASE_NAMES) if (fraction < limit) return name;
  return waxing ? "waxing gibbous" : "waning gibbous";
}

/** Sun / Moon / planet card, including the light-time-corrected distance. */
export function describeBody(name: string, sky: SkyState, state: AppState): ObjectDetails {
  const body = sky.bodies.find((b) => b.name === name);
  if (!body) return { title: name, subtitle: "not in the loaded ephemeris", rows: [] };
  const waxing = body.name !== "Moon" ? true : isWaxing(body, sky);
  const ev = nextEvents(body.body, sky.observer, state.date, 2);
  const rows: Row[] = [
    { k: "Altitude / azimuth", v: altitudeText(body.alt, body.az, true) },
    { k: "RA / Dec (apparent, of date)", v: `${formatRaDms(body.ra)}  ${formatDecDms(body.dec)}` },
    { k: "RA / Dec (apparent, J2000)", v: `${formatRaDms(body.raJ2000)}  ${formatDecDms(body.decJ2000)}` },
    { k: "Constellation", v: constellationName(body.raJ2000, body.decJ2000) },
    { k: "Distance from Earth", v: `${body.distAu.toFixed(4)} AU · ${(body.distAu * 8.3167).toFixed(1)} light-minutes` },
    { k: "Distance from Sun", v: `${body.helioAu.toFixed(4)} AU` },
  ];
  if (body.mag !== null) rows.push({ k: "Apparent magnitude", v: body.mag.toFixed(1) });
  if (body.phase !== null && body.name !== "Sun") {
    rows.push({ k: "Illuminated", v: `${(body.phase * 100).toFixed(0)}% (${phaseName(body.phase, waxing)})` });
  }
  if (body.diameterArcmin !== null) {
    rows.push({ k: "Angular diameter", v: `${body.diameterArcmin.toFixed(1)}′ (${(body.diameterArcmin / 60).toFixed(2)}°)` });
  }
  rows.push(eventRow("Rises", ev.rise, state.timeMode));
  rows.push(eventRow("Transits", ev.transit, state.timeMode));
  rows.push(eventRow("Sets", ev.set, state.timeMode));
  const note =
    body.name === "Moon"
      ? `Topocentric: the Moon's ${body.distAu.toFixed(4)} AU distance means parallax shifts it by up to ${(body.distAu * 1.0).toFixed(2)}° against the stars.`
      : body.alt > 0 && sky.sun.alt > -6
        ? "Above the horizon, but the sky is still too bright to see it with the naked eye."
        : undefined;
  return { title: body.name, subtitle: "solar-system body", rows, note };
}

function isWaxing(body: BodyPlace, sky: SkyState): boolean {
  if (body.name !== "Moon") return true;
  return moonWaxing(sky.date);
}

/** Constellation card: the figure, its official boundary, and where its name sits. */
export function describeConstellation(index: number, sky: SkyState, state: AppState): ObjectDetails {
  const c = constellations[index]!;
  const alt = sky.constellations[index * 2]!;
  const az = sky.constellations[index * 2 + 1]!;
  let segments = 0;
  for (let p = 0; p < sky.lines.index.length; p += 3) {
    if (sky.lines.index[p + 2] === index) segments++;
  }
  const ofDate = toOfDate(c.ra, c.dec, sky.frame);
  return {
    title: c.name,
    subtitle: `${c.en} · ${c.id}`,
    rows: [
      { k: "Name anchor altitude", v: altitudeText(alt) },
      { k: "Anchor azimuth", v: azimuthText(az) },
      { k: "Genitive", v: c.gen },
      { k: "Anchor RA / Dec (of date)", v: `${formatRaDms(ofDate.ra)}  ${formatDecDms(ofDate.dec)}` },
      { k: "Stick-figure segments drawn", v: String(segments) },
      { k: "Brightness rank", v: `${c.rank} (1 = most prominent)` },
    ],
    note: "The anchor is the ancient figure's name position; the boundary ring is the IAU 1930 one.",
  };
}

/** Only a run of digits is a catalogue index; anything else is a bad selection. */
function catalogIndex(value: string): number | null {
  return /^\d+$/.test(value) ? Number(value) : null;
}

/**
 * A stale or hand-typed share link can name an index the regenerated catalogue no longer
 * has, so every branch is range-checked and the caller renders "Nothing selected" instead
 * of a card full of NaN.
 */
export function describe(sel: NonNullable<AppState["selected"]>, sky: SkyState, state: AppState): ObjectDetails | null {
  const cut = sel.indexOf(":");
  if (cut < 0) return null;
  const kind = sel.slice(0, cut);
  const value = sel.slice(cut + 1);
  const index = catalogIndex(value);
  switch (kind) {
    case "star":
      return index === null || index * 4 >= starPositions.length ? null : describeStar(index, sky, state);
    case "dso":
      return index === null || index >= dsoMeta.length ? null : describeDso(index, sky, state);
    case "constellation":
      return index === null || index >= constellations.length ? null : describeConstellation(index, sky, state);
    case "body":
      return describeBody(value, sky, state);
    default:
      return null;
  }
}

export interface EventTable {
  name: string;
  symbol: string;
  alt: number;
  az: number;
  rise: Date | null;
  transit: Date | null;
  set: Date | null;
  mag: number | null;
  constellation: string;
  visible: boolean;
}

const TABLE_BODIES: { body: Body; name: string; symbol: string }[] = [
  { body: Body.Sun, name: "Sun", symbol: "☉" },
  { body: Body.Moon, name: "Moon", symbol: "☽" },
  ...PLANETS.map((p) => ({ body: p.body, name: p.name, symbol: p.symbol })),
];

export const TABLE_SYMBOL = new Map(TABLE_BODIES.map((b) => [b.name, b.symbol]));

/** Rise / transit / set for the Sun, Moon and the eight planets plus Pluto. */
export function eventTable(sky: SkyState, state: AppState): EventTable[] {
  return sky.bodies.map((b) => {
    const ev = nextEvents(b.body, sky.observer, state.date, 2);
    return {
      name: b.name,
      symbol: TABLE_SYMBOL.get(b.name) ?? "•",
      alt: b.alt,
      az: b.az,
      rise: ev.rise,
      transit: ev.transit,
      set: ev.set,
      mag: b.mag,
      constellation: constellationName(b.raJ2000, b.decJ2000),
      visible: b.alt > 0 && sky.sun.alt < -0.833,
    };
  });
}

export interface TwilightTable {
  label: string;
  evening: Date | null;
  morning: Date | null;
  altitude: number;
}

/** Evening and morning crossings of the four twilight boundaries. */
export function twilightTable(state: AppState): TwilightTable[] {
  const rows: { label: string; altitude: number }[] = [
    { label: "Sunset / sunrise (upper limb)", altitude: -0.833 },
    { label: "Civil", altitude: -6 },
    { label: "Nautical", altitude: -12 },
    { label: "Astronomical", altitude: -18 },
  ];
  const observer = new Observer(state.lat, state.lon, state.elevM);
  return rows.map((r) => ({
    label: r.label,
    altitude: r.altitude,
    // once the Sun has sunk under a boundary its next *downward* crossing belongs to the
    // following day; what matters tonight is the crossing that opened this dark interval,
    // so look backwards for it. Both columns then bracket the present night.
    evening:
      (sunAltitude(state.date, observer) < r.altitude
        ? sunAtAltitude(observer, r.altitude, state.date, -1, -3)
        : sunAtAltitude(observer, r.altitude, state.date, -1, 3))?.date ?? null,
    morning: sunAtAltitude(observer, r.altitude, state.date, 1, 3)?.date ?? null,
  }));
}

/** Where the observer is, in words the panel can print. */
export function locationSummary(state: AppState, sky: SkyState): Row[] {
  const near = nearestPlace(state.lat, state.lon);
  return [
    { k: "Position", v: `${Math.abs(state.lat).toFixed(4)}° ${state.lat >= 0 ? "N" : "S"}, ${Math.abs(state.lon).toFixed(4)}° ${state.lon >= 0 ? "E" : "W"}` },
    { k: "Elevation", v: `${Math.round(state.elevM)} m` },
    { k: "Nearest named place", v: `${near.place.name} — ${near.km.toFixed(0)} km away` },
    { k: "Sun altitude", v: `${sky.sun.alt.toFixed(1)}° (${sky.twilight})` },
    { k: "Moon altitude", v: `${sky.moon.alt.toFixed(1)}°` },
    { k: "Local sidereal time", v: formatRaDms(sky.lst) },
  ];
}

export const BODY_NAMES = [SUN, MOON, ...PLANETS].map((b) => b.name);