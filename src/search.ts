/**
 * search.ts — one box for "take me to Vega".
 *
 * The index is built once from the catalog: named stars, Messier objects (id and proper
 * name), the ten solar-system bodies, the 88 IAU figures by English name, genitive and
 * three-letter designator, and the gazetteer cities. Matching is substring-based with a
 * prefix bonus and diacritic folding, so "zuid", "vega" and "m42" all land.
 */
import { constellations, dsoMeta, starNameIdx, starNames, starHip, starPositions } from "./data/sky.generated";
import { CITIES, foldName, type Place } from "./location";

export interface Match {
  /** selection id (`star:123`, `dso:8`, `body:Venus`, `constellation:41`) or `city:` */
  id: string;
  kind: "star" | "dso" | "body" | "constellation" | "city";
  label: string;
  detail: string;
  /** catalog index for objects, array index for cities */
  index: number;
  place?: Place;
}

export const BODIES = ["Sun", "Moon", "Mercury", "Venus", "Mars", "Jupiter", "Saturn", "Uranus", "Neptune", "Pluto"];

const fold = foldName;

let index: Match[] | null = null;

function build(): Match[] {
  if (index) return index;
  const out: Match[] = [];
  for (let i = 0; i < starNames.length; i++) {
    const starIndex = starNameIdx.indexOf(i);
    if (starIndex < 0) continue;
    out.push({
      id: `star:${starIndex}`,
      kind: "star",
      label: starNames[i]!,
      detail: `star · V ${starPositions[starIndex * 4 + 2]!.toFixed(1)} · HIP ${starHip[starIndex]}`,
      index: starIndex,
    });
  }
  for (let i = 0; i < dsoMeta.length; i++) {
    const m = dsoMeta[i]!;
    const label = m.name && m.name !== m.id ? `${m.id} · ${m.name}` : m.id;
    out.push({ id: `dso:${i}`, kind: "dso", label, detail: `${m.type} · mag ${m.mag.toFixed(1)}`, index: i });
  }
  for (let i = 0; i < constellations.length; i++) {
    const c = constellations[i]!;
    out.push({
      id: `constellation:${i}`,
      kind: "constellation",
      label: c.name,
      detail: `${c.en} · ${c.id} · genitive ${c.gen}`,
      index: i,
    });
  }
  for (const name of BODIES) {
    out.push({ id: `body:${name}`, kind: "body", label: name, detail: "solar-system body", index: -1 });
  }
  CITIES.forEach((c, i) => {
    out.push({ id: `city:${i}`, kind: "city", label: c.name, detail: `${c.country} · ${c.lat.toFixed(2)}° ${c.lon.toFixed(2)}°`, index: i, place: c });
  });
  index = out;
  return out;
}

/** Ranked substring search over the built index. */
export function search(query: string, limit = 12): Match[] {
  const q = fold(query);
  if (q.length < 2) return [];
  const scored: { m: Match; score: number }[] = [];
  for (const m of build()) {
    const label = fold(m.label);
    const detail = fold(m.detail);
    let score = 0;
    if (label === q) score = 100;
    else if (label.startsWith(q)) score = 80 - label.length / 40;
    else if (label.includes(q)) score = 55 - label.length / 60;
    else if (detail.includes(q)) score = 25;
    if (score > 0) scored.push({ m, score });
  }
  scored.sort((a, b) => b.score - a.score || a.m.label.localeCompare(b.m.label));
  return scored.slice(0, limit).map((s) => s.m);
}

/** Everything, for tests and for the "what can I search?" hint. */
export function indexSize(): number {
  return build().length;
}