/**
 * state.ts — the app's single observable state, its defaults, and its URL form.
 *
 * The URL hash is the share format: `#lat=..&lon=..&t=<ISO>&elev=..&loc=..&zoom=..&rot=..&proj=..&mag=..&layers=...`
 * so a view of the sky over Tromsø at 02:00 site time is one link.
 */
import type { Layers } from "./render";
import { DEFAULT_LAYERS } from "./render";
import type { TimeMode } from "./location";
import type { ProjectionMode } from "./proj";
import { CITIES, foldName, type Place } from "./location";

export interface AppState {
  lat: number;
  lon: number;
  elevM: number;
  /** observer label, e.g. "Zürich" or "61.2°N 149.9°W" */
  place: string;
  /** the shown instant, always kept as a UTC Date */
  date: Date;
  /** wall-clock mode for the date-time control and all tables */
  timeMode: TimeMode;
  /** "now" follows the clock; "fixed" holds the chosen instant */
  follow: boolean;
  playing: boolean;
  /** simulated minutes advanced per real second while playing */
  rate: number;
  layers: Layers;
  magLimit: number;
  labelLimit: number;
  projection: ProjectionMode;
  /** 1 = the whole hemisphere fits; >1 zooms in around the view centre */
  zoom: number;
  rotation: number;
  selected: string | null;
}

export const DEFAULT_STATE: AppState = {
  lat: 47.3769,
  lon: 8.5417,
  elevM: 408,
  place: "Zürich",
  date: new Date(),
  timeMode: "site",
  follow: true,
  playing: false,
  rate: 120,
  layers: { ...DEFAULT_LAYERS },
  magLimit: 6,
  labelLimit: 3.0,
  projection: "stereographic",
  zoom: 1,
  rotation: 0,
  selected: null,
};

export const LAYER_LABELS: { key: keyof Layers; label: string; hint: string }[] = [
  { key: "lines", label: "Constellation figures", hint: "IAU stick figures" },
  { key: "constellationLabels", label: "Constellation names", hint: "Latin names at their anchors" },
  { key: "bounds", label: "IAU boundaries", hint: "1930 boundary of each constellation" },
  { key: "milkyWay", label: "Milky Way", hint: "Five-opacity galactic band" },
  { key: "stars", label: "Stars", hint: "Catalogue to the magnitude limit" },
  { key: "starNames", label: "Star names", hint: "Brightest stars only, no overlaps" },
  { key: "dsos", label: "Messier objects", hint: "Glyph per object type" },
  { key: "bodies", label: "Sun, Moon, planets", hint: "Include Pluto" },
  { key: "bodyLabels", label: "Body labels", hint: "Names beside planets" },
  { key: "ecliptic", label: "Ecliptic", hint: "Apparent yearly path of the Sun" },
  { key: "equator", label: "Celestial equator", hint: "Earth's equator projected" },
  { key: "grid", label: "Alt/az grid", hint: "30° and 60° altitude circles, azimuth spokes" },
  { key: "refraction", label: "Atmospheric refraction", hint: "Lifts objects near the horizon" },
  { key: "twinkle", label: "Twinkle", hint: "Slow scintillation on bright stars" },
];

export const TIME_MODES: { key: TimeMode; label: string; hint: string }[] = [
  { key: "site", label: "Site (mean solar)", hint: "Sundial time at the observer's longitude" },
  { key: "browser", label: "Browser local", hint: "Your device's clock, with its zone offsets" },
  { key: "utc", label: "UTC", hint: "Civil time at Greenwich, no offsets" },
];

export const RATES = [
  { value: 1, label: "1×" },
  { value: 60, label: "1 min/s" },
  { value: 600, label: "10 min/s" },
  { value: 3600, label: "1 h/s" },
  { value: 86400, label: "1 day/s" },
];

export const RATE_LABEL = new Map(RATES.map((r) => [r.value, r.label]));

export function clampLat(v: number): number {
  return Math.max(-90, Math.min(90, v));
}
export function wrapLon(v: number): number {
  return ((v + 540) % 360) - 180;
}

export function formatLat(lat: number): string {
  const h = lat >= 0 ? "N" : "S";
  return `${Math.abs(lat).toFixed(3)}°${h}`;
}
export function formatLon(lon: number): string {
  const h = lon >= 0 ? "E" : "W";
  return `${Math.abs(lon).toFixed(3)}°${h}`;
}

export function stateToHash(s: AppState): string {
  const p = new URLSearchParams();
  p.set("lat", s.lat.toFixed(5));
  p.set("lon", s.lon.toFixed(5));
  if (s.elevM) p.set("elev", String(Math.round(s.elevM)));
  p.set("t", s.date.toISOString().slice(0, 16).replace(":", "T"));
  p.set("t", s.date.toISOString());
  if (s.place) p.set("loc", s.place);
  if (s.zoom !== 1) p.set("zoom", s.zoom.toFixed(2));
  if (s.rotation) p.set("rot", s.rotation.toFixed(1));
  if (s.projection !== DEFAULT_STATE.projection) p.set("proj", s.projection);
  if (s.magLimit !== DEFAULT_STATE.magLimit) p.set("mag", s.magLimit.toFixed(1));
  if (s.timeMode !== DEFAULT_STATE.timeMode) p.set("mode", s.timeMode);
  if (s.selected) p.set("sel", s.selected);
  const on = LAYER_LABELS.filter((l) => s.layers[l.key]).map((l) => l.key).join(",");
  const off = LAYER_LABELS.filter((l) => !s.layers[l.key]).map((l) => l.key).join(",");
  if (on !== LAYER_LABELS.filter((l) => DEFAULT_LAYERS[l.key]).map((l) => l.key).join(",")) {
    p.set("layers", `${on}|${off}`);
  }
  return `#${p.toString()}`;
}

export function stateFromHash(hash: string, fallback: AppState): AppState {
  const s: AppState = { ...fallback, layers: { ...fallback.layers } };
  const text = hash.replace(/^#/, "");
  if (!text) return s;
  const p = new URLSearchParams(text);
  const num = (k: string) => {
    const v = p.get(k);
    if (v === null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const lat = num("lat");
  const lon = num("lon");
  if (lat !== null) s.lat = clampLat(lat);
  if (lon !== null) s.lon = wrapLon(lon);
  const elev = num("elev");
  if (elev !== null) s.elevM = elev;
  const t = p.get("t");
  if (t) {
    const d = new Date(t.length === 16 ? `${t}Z` : t);
    if (!Number.isNaN(d.getTime())) {
      s.date = d;
      s.follow = false;
    }
  }
  const loc = p.get("loc");
  if (loc) s.place = loc;
  const zoom = num("zoom");
  if (zoom !== null && zoom > 0.2 && zoom < 20) s.zoom = zoom;
  const rot = num("rot");
  if (rot !== null) s.rotation = ((rot % 360) + 360) % 360;
  const proj = p.get("proj");
  if (proj === "stereographic" || proj === "equidistant") s.projection = proj;
  const mag = num("mag");
  if (mag !== null && mag >= 0 && mag <= 7) s.magLimit = mag;
  const mode = p.get("mode");
  if (mode === "site" || mode === "browser" || mode === "utc") s.timeMode = mode;
  const sel = p.get("sel");
  if (sel) s.selected = sel;
  const layers = p.get("layers");
  if (layers) {
    const [on = "", off = ""] = layers.split("|");
    for (const key of on.split(",")) {
      if (key && key in s.layers) s.layers[key as keyof Layers] = true;
    }
    for (const key of off.split(",")) {
      if (key && key in s.layers) s.layers[key as keyof Layers] = false;
    }
  }
  return s;
}

/** Look a place up by name, forgiving case, diacritics and "Zurich" vs "Zürich". */
export function findCity(query: string): Place | null {
  const norm = (x: string) => foldName(x).replace(/ /g, "");
  const q = norm(query);
  if (!q) return null;
  const exact = CITIES.find((c) => norm(c.name) === q);
  if (exact) return exact;
  const starts = CITIES.find((c) => norm(c.name).startsWith(q));
  if (starts) return starts;
  const contains = CITIES.find((c) => norm(c.name).includes(q));
  return contains ?? null;
}

/** `47.3769 N 8.5417 E` — the label shown when a position has no name. */
export function coordinateLabel(lat: number, lon: number): string {
  return `${formatLat(lat)} ${formatLon(lon)}`;
}

export function selectionId(sel: { kind: string; index?: number; name?: string } | null): string | null {
  if (!sel) return null;
  return sel.kind === "body" ? `body:${sel.name}` : `${sel.kind}:${sel.index}`;
}