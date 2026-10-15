/**
 * build-data.ts — turn raw catalog downloads into one compact TypeScript module.
 *
 * Input (data/raw/, see data/SOURCES.md for provenance and licences):
 *   stars.6.json              Hipparcos stars to V ≈ 6, J2000 RA/Dec + mag + B−V
 *   starnames.json            proper / Bayer / Flamsteed names keyed by HIP number
 *   constellations.json       IAU names, rank, label anchor
 *   constellations.lines.json stick figures, MultiLineString in RA/Dec
 *   constellations.bounds.json IAU boundary rings
 *   mw.json                   Milky Way outline, 5 opacity levels, MultiPolygon
 *   messier.json              Messier objects with type, magnitude, size
 *   land-110m.json            Natural Earth land (TopoJSON, quantized) for the map picker
 *
 * Output: src/data/sky.generated.ts — typed arrays plus a small object table.
 * Polygons are Ramer-Douglas-Peucker simplified; the sky is drawn at sub-arcminute
 * fidelity so 0.05° of outline tolerance is invisible.
 *
 * Usage: bun tools/build-data.ts
 */
import { mkdir } from "node:fs/promises";

const RAW = new URL("../data/raw/", import.meta.url);
const OUT = new URL("../src/data/sky.generated.ts", import.meta.url);

/** d3-celestial stores longitude wrapped to [-180, 180]; catalogs use RA [0, 360). */
const toRa = (lon: number) => ((lon % 360) + 360) % 360;

// --------------------------------------------------------------- RDP simplify

/** Perpendicular distance of p from segment a-b, in degrees (small-angle, fine for outlines). */
function segDist(p: number[], a: number[], b: number[]): number {
  const [ax, ay] = a;
  const [bx, by] = b;
  const dx = bx - ax;
  const dy = by - ay;
  // guard against the ±180° seam: if a segment spans most of the globe, measure distance unwrapped
  const px = p[0] - ax;
  const py = p[1] - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px, py);
  const t = Math.max(0, Math.min(1, (px * dx + py * dy) / len2));
  return Math.hypot(px - t * dx, py - t * dy);
}

function rdp(pts: number[][], tol: number): number[][] {
  if (pts.length < 3) return pts;
  const end = pts.length - 1;
  const stack: [number, number][] = [[0, end]];
  const out: number[][] = [];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let maxD = -1;
    let idx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = segDist(pts[i], pts[a], pts[b]);
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (maxD > tol && idx > 0) {
      stack.push([a, idx], [idx, b]);
    } else if (!out.length || out[out.length - 1] !== pts[a]) {
      out.push(pts[a]);
    }
  }
  out.push(pts[end]);
  return out;
}

// --------------------------------------------------------------- TopoJSON

type Topo = {
  transform: { scale: [number, number]; translate: [number, number] };
  arcs: [number, number][][];
  objects: { land: { type: string; geometries: { type: string; arcs: number[][][] }[] } };
};

/** Messier "dim" is written as "6x4" arcminutes, an array, or missing. */
function largestDimension(dim: string | number | number[] | undefined): number {
  if (dim === undefined || dim === null) return 0;
  const nums = (Array.isArray(dim) ? dim : String(dim).split(/[^0-9.]+/)).map(Number).filter((n) => Number.isFinite(n));
  return nums.length ? Math.max(...nums) : 0;
}

/** Decode quantized, delta-encoded TopoJSON arcs into [lon, lat] rings. */
function decodeTopo(topo: Topo): number[][][] {
  const [[sx, sy], [tx, ty]] = [topo.transform.scale, topo.transform.translate];
  const cache: (number[][] | null)[] = topo.arcs.map(() => null);
  const arcAt = (i: number): number[][] => {
    const rev = i < 0;
    const key = rev ? ~i : i;
    if (!cache[key]) {
      let x = 0;
      let y = 0;
      cache[key] = topo.arcs[key].map(([dx, dy]) => {
        x += dx;
        y += dy;
        return [x * sx + tx, y * sy + ty];
      });
    }
    const arc = cache[key]!;
    return rev ? arc.slice().reverse() : arc;
  };
  const rings: number[][][] = [];
  for (const geom of topo.objects.land.geometries) {
    if (geom.type !== "MultiPolygon") continue;
    for (const poly of geom.arcs) {
      for (const ringRefs of poly) {
        const pts: number[][] = [];
        for (const ref of ringRefs) for (const p of arcAt(ref)) if (!pts.length || pts[pts.length - 1] !== p) pts.push(p);
        if (pts.length > 3) rings.push(pts);
      }
    }
  }
  return rings;
}

// --------------------------------------------------------------- pipeline

async function json<T>(name: string): Promise<T> {
  return Bun.file(new URL(name, RAW)).json() as Promise<T>;
}

type StarFC = {
  features: { id: number; properties: { mag: number; bv?: string | number }; geometry: { coordinates: [number, number] } }[];
};
type NameTable = Record<string, { name?: string; bayer?: string; flam?: string; var?: string; c?: string }>;
type LineFC = { features: { id: string; properties?: { rank?: string }; geometry: { coordinates: [number, number][][] } }[] };
type ConstFC = {
  features: { id: string; properties: { name: string; en?: string; rank?: string; gen?: string }; geometry: { coordinates: [number, number] } }[];
};
type BoundsFC = { features: { id: string; geometry: { coordinates: [number, number][][] } }[] };
type MwFC = { features: { id: string; geometry: { coordinates: [number, number][][][] } }[] };
type MessierFC = {
  features: {
    id: string;
    properties: { desig: string; alt?: string; name?: string; type: string; mag: number; dim?: string | number | number[] };
    geometry: { coordinates: [number, number] };
  }[];
};

async function main() {
  await mkdir(new URL("../src/data/", import.meta.url), { recursive: true });
  const [stars, names, lines, consts, bounds, mw, messier, topo] = await Promise.all([
    json<StarFC>("stars.6.json"),
    json<NameTable>("starnames.json"),
    json<LineFC>("constellations.lines.json"),
    json<ConstFC>("constellations.json"),
    json<BoundsFC>("constellations.bounds.json"),
    json<MwFC>("mw.json"),
    json<MessierFC>("messier.json"),
    json<Topo>("land-110m.json"),
  ]);

  // --- stars, brightest first so the renderer can stop early
  const named = stars.features
    .map((f) => {
      const bvRaw = f.properties.bv;
      const bv = typeof bvRaw === "number" ? bvRaw : bvRaw ? Number(bvRaw) : 0.6;
      return {
        hip: f.id,
        ra: toRa(f.geometry.coordinates[0]),
        dec: f.geometry.coordinates[1],
        mag: f.properties.mag,
        bv: Number.isFinite(bv) ? bv : 0.6,
        info: names[String(f.id)],
      };
    })
    .filter((s) => s.mag <= 6.5)
    .sort((a, b) => a.mag - b.mag);

  const NAME_LIMIT = 5.5; // labels beyond this magnitude clutter the chart; names stay searchable
  const namePool: string[] = [];
  const nameIndex = new Map<string, number>();
  const starNameIdx: number[] = [];
  for (const s of named) {
    const info = s.info;
    let label = "";
    if (info?.name) label = info.name;
    else if (info?.bayer && info.c) label = `${info.bayer} ${info.c}`;
    else if (info?.flam && info.c) label = `${info.flam} ${info.c}`;
    if (!label || s.mag > NAME_LIMIT) {
      starNameIdx.push(-1);
      continue;
    }
    if (!nameIndex.has(label)) {
      nameIndex.set(label, namePool.length);
      namePool.push(label);
    }
    starNameIdx.push(nameIndex.get(label)!);
  }

  // --- constellations
  const constList = consts.features.map((f) => ({
    id: f.id,
    name: f.properties.name,
    en: f.properties.en ?? f.properties.name,
    gen: f.properties.gen ?? "",
    rank: Number(f.properties.rank ?? 3),
    ra: toRa(f.geometry.coordinates[0]),
    dec: f.geometry.coordinates[1],
  }));
  const constIdx = new Map(constList.map((c, i) => [c.id, i]));

  const linePaths = lines.features.flatMap((f) => {
    const ci = constIdx.get(f.id);
    if (ci === undefined) return [];
    return f.geometry.coordinates
      .filter((part) => part.length > 1)
      .map((part) => ({ ci, pts: part.flatMap(([lon, lat]) => [toRa(lon), lat]) }));
  });

  const boundRings = bounds.features.flatMap((f) => {
    const ci = constIdx.get(f.id);
    if (ci === undefined) return [];
    const ring = f.geometry.coordinates[0] ?? [];
    if (ring.length < 4) return [];
    const simplified = rdp(
      ring.map(([lon, lat]) => [toRa(lon), lat]),
      0.05,
    );
    return [{ ci, pts: simplified.flatMap(([ra, lat]) => [ra, lat]) }];
  });

  // --- Milky Way: five opacity levels, simplified but split per original piece
  const mwRings = mw.features.flatMap((f) => {
    const level = Number(f.id.replace(/\D/g, "")) || 1;
    return f.geometry.coordinates.map((poly) => {
      const ring = poly[0] ?? [];
      const simplified = rdp(
        ring.map(([lon, lat]) => [toRa(lon), lat]),
        0.06,
      );
      return { level, pts: simplified.flatMap(([ra, lat]) => [ra, lat]) };
    });
  });

  const dsos = messier.features
    .filter((f) => f.properties.mag < 900)
    .map((f) => ({
      id: f.id,
      desig: f.properties.desig,
      type: f.properties.type,
      mag: f.properties.mag,
      name: f.properties.alt?.trim() || f.id,
      dim: largestDimension(f.properties.dim),
      ra: toRa(f.geometry.coordinates[0]),
      dec: f.geometry.coordinates[1],
    }))
    .sort((a, b) => a.mag - b.mag);

  const landRings = decodeTopo(topo)
    .map((ring) => rdp(ring, 0.05))
    .filter((ring) => ring.length > 3);

  // --- emit
  const round = (x: number, digits: number) => (Number.isFinite(x) ? Number(x.toFixed(digits)) : 0);
  const f32 = (xs: number[]) => `new Float32Array([${xs.map((x) => round(x, 5)).join(",")}])`;
  const i32 = (xs: number[]) => `new Int32Array([${xs.join(",")}])`;

  /** Pack [ra,dec,…] paths into one flat array plus [offset, vertexCount, tag] triples. */
  function packPaths(paths: { tag: number; pts: number[] }[]) {
    const flat: number[] = [];
    const index: number[] = [];
    for (const p of paths) {
      index.push(flat.length, p.pts.length / 2, p.tag);
      flat.push(...p.pts.map((v) => round(v, 4)));
    }
    return { flat, index };
  }

  const starFlat: number[] = [];
  for (const s of named) starFlat.push(round(s.ra, 5), round(s.dec, 5), round(s.mag, 3), round(s.bv, 3));
  const hipList = named.map((s) => s.hip);

  const linePack = packPaths(linePaths.map((p) => ({ tag: p.ci, pts: p.pts })));
  const boundPack = packPaths(boundRings.map((p) => ({ tag: p.ci, pts: p.pts })));
  const mwPack = packPaths(mwRings.map((p) => ({ tag: -(p.level + 1), pts: p.pts })));
  const landPack = packPaths(landRings.map((pts) => ({ tag: 0, pts: pts.flatMap(([lon, lat]) => [lon, lat]) })));
  const dsoFlat: number[] = [];
  for (const d of dsos) dsoFlat.push(round(d.ra, 4), round(d.dec, 4), round(d.mag, 2), round(d.dim, 1));

  const body = `/**
 * GENERATED by tools/build-data.ts — do not edit by hand.
 * Star, constellation, Milky Way, Messier and coastline data; see data/SOURCES.md
 * for provenance and licence notices (sky catalogues: © Olaf Frohn / d3-celestial,
 * BSD-style terms; Natural Earth land: public domain).
 *
 * All sky coordinates are J2000 right ascension / declination in degrees, with RA
 * normalised to [0, 360). Packed coordinate arrays are [ra, dec, ra, dec, …].
 * A path index is a flat list of [startOffset, vertexCount, tag] triples; for
 * constellation lines and boundaries tag is the index into \`constellations\`, for
 * the Milky Way tag is -(opacity level + 1), and the coastline pack is untagged.
 */

export interface ConstellationInfo {
  id: string;
  name: string;
  en: string;
  gen: string;
  rank: number;
  ra: number;
  dec: number;
}

export interface DsoInfo {
  id: string;
  desig: string;
  name: string;
  type: string;
  mag: number;
  dim: number;
}

/** Bright stars sorted by apparent magnitude, brightest first: [ra, dec, mag, bv] × n. */
export const starPositions = ${f32(starFlat)};
/** Hipparcos number parallel to starPositions. */
export const starHip = ${i32(hipList)};
/** Index into starNames, or -1 when unnamed or fainter than ${NAME_LIMIT} mag. */
export const starNameIdx = ${i32(starNameIdx)};
export const starNames = ${JSON.stringify(namePool)} as const;

export const constellations = ${JSON.stringify(constList, null, 2)} satisfies ConstellationInfo[];

export const constellationLineData = ${f32(linePack.flat)};
export const constellationLineIndex = ${i32(linePack.index)};
export const constellationBoundData = ${f32(boundPack.flat)};
export const constellationBoundIndex = ${i32(boundPack.index)};

/** Milky Way outline in five opacity levels; tag = -(level + 1). */
export const milkyWayData = ${f32(mwPack.flat)};
export const milkyWayIndex = ${i32(mwPack.index)};

/** Messier objects, brightest first: [ra, dec, mag, longest dimension in arcmin] × n. */
export const dsoData = ${f32(dsoFlat)};
export const dsoMeta = ${JSON.stringify(dsos.map(({ id, desig, name, type, mag, dim }) => ({ id, desig, name, type, mag, dim })))} satisfies DsoInfo[];

/** Natural Earth land outlines: [lon, lat, …] per ring. */
export const landData = ${f32(landPack.flat)};
export const landIndex = ${i32(landPack.index.map((v, i) => (i % 3 === 2 ? 0 : v)))};

export const generatedAt = ${JSON.stringify(new Date().toISOString())};
`;
  await Bun.write(OUT, body);

  const kb = (n: number) => `${(n / 1024).toFixed(0)} KB`;
  console.log(`stars          ${named.length} (${kb(starFlat.length * 4)}), labelled ${namePool.length}`);
  console.log(`constellations ${constList.length}, line paths ${linePaths.length}, boundary rings ${boundRings.length}`);
  console.log(`milky way      ${mwRings.length} rings (${kb(mwPack.flat.length * 4)})`);
  console.log(`messier        ${dsos.length}`);
  console.log(`land           ${landRings.length} rings (${kb(landPack.flat.length * 4)})`);
  console.log(`wrote ${OUT.pathname}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});