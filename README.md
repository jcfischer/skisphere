# skisphere

A planetarium in one HTML page: the constellations, the Messier objects and the seven
wanderers, drawn for any place on Earth and any instant, from a hemisphere looking up to a
zoomed-in fisheye.

It is a static site. Everything it needs — star catalog, constellation figures and IAU
boundaries, Milky Way outline, Messier data, world coastlines, a gazetteer — is compiled into
`public/skisphere.js` at build time, so the page asks the network for nothing.

```sh
bun install
bun run build     # tools/build-data.ts → src/data/sky.generated.ts, then bundles public/skisphere.js
bun run serve     # http://127.0.0.1:8123
```

`bun run dev` rebuilds the bundle on change. `bun run check` runs every gate this repository
commits to: typecheck, ephemeris verification, unit tests, browser checks, screenshots.

## What is on the screen

| Panel | What it gives you |
| --- | --- |
| Sky | Altazimuth hemisphere. Drag turns the compass ring, wheel zooms, double-click resets. Click anything to select it. |
| Place | Clickable world map, latitude/longitude/elevation, a ~200-city gazetteer, and the browser's own geolocation when you allow it. |
| Instant | Wall-clock time at the site, in the browser, or UTC; `now`, play with eight rates, and a ±12 h strip of Sun and Moon altitude with the hours of darkness. |
| Display | Projection (stereographic or equal-angle), rotation, zoom, limiting magnitude, label limit, and fourteen layers. |
| Object | Altitude, azimuth, both coordinate frames, magnitude, colour index, rise/transit/set, and for the Sun and Moon distance, angular diameter, illumination and twilight times. |
| Tonight's bodies | Rise, transit and set for all ten bodies with their constellations. |
| Twilight | Civil, nautical, astronomical and sunrise/sunset crossings, evening and morning. |

`copy link` puts the whole view in the URL hash (`lat`, `lon`, `elev`, `t`, `loc`, `zoom`,
`rot`, `proj`, `mag`, `sel`), and a pasted hash loads the view it describes.

Keys: `←` `→` time by 10 min (`⇧` 1 h, `⌥` 1 day) · `↑` `↓` magnitude limit · `space` run or
hold time · `0` follow the clock · `n` `e` `s` `w` put that bearing on top · `l` figures ·
`c` constellation names · `b` boundaries · `m` Milky Way · `r` star names · `d` Messier ·
`p` planets · `t` twinkle · `j` ecliptic · `q` equator · `g` alt/az grid · `f` refraction ·
`esc` clear selection · `?` the list.

## How the sky is computed

`astronomy-engine` does the ephemerides, the rise/set and twilight searches, refraction and
sidereal time; this repository does the frame rotation for catalog points.

1. `src/data/sky.generated.ts` holds the catalog as **J2000** right ascension and declination
   in degrees, packed in typed arrays.
2. `skyFrame(date)` builds one matrix, J2000 mean equator/equinox → true equator and equinox
   of date: IAU 1976 precession plus a four-term nutation series.
3. `computeSky(cfg)` rotates every catalog point through it, converts to geometric
   altitude/azimuth for the observer, and caches the result for an unchanged instant and place.
   Points that can never rise or set at that latitude are marked with an altitude of −91.
4. The renderer applies refraction where objects are drawn, so the horizon ring stays a true
   circle, and fades the sky on the Sun's altitude: 0 at the horizon, 1 past −18°.

Conventions worth knowing before editing:

- Right ascension and declination are **degrees** throughout the app. `astronomy-engine`'s
  equatorial API takes sidereal **hours**, so the conversions are explicit at the boundary.
- Altitudes from `computeSky` are **geometric**; `apparentAlt()` adds refraction at the moments
  where something is displayed or drawn. The Sun, Moon and planets already come back refracted.
- The IAU boundary lookup takes **J2000**, not of-date: `astronomy-engine`'s boundary table is
  keyed to J2000, and precession since 2000 is already ~0.5° — enough to hand a star near a
  boundary to the wrong figure.
- Constellation names are the Latin IAU nominatives (`Cetus`, `Lyra`), not English
  translations. The English name, genitive and three-letter designator are searchable.
- `SkyState`'s altitude arrays are buffers `computeSky` reuses on every call, which is what
  makes re-deriving the whole sky per frame affordable. A state kept from before another call
  reads as the newer place — recompute before drawing, or copy the numbers you want to keep.

## Where the data comes from

`data/SOURCES.md` and `data/LICENSE.d3-celestial.txt` cover provenance. In short:

| Data | Source |
| --- | --- |
| 5 044 stars, magnitudes, B−V, 2 277 names | [d3-celestial](https://github.com/ofrohn/d3-celestial) (Hipparcos/Yale through `D3_celestial`), MIT |
| 88 constellation figures, names, genitives | d3-celestial, from IAU figures |
| IAU 1930 boundaries | d3-celestial, from the IAU's published figures |
| Milky Way outline, 110 Messier objects | d3-celestial |
| Coastlines | Natural Earth 1:110m through `world-atlas`, public domain |
| ~200-city gazetteer | hand-written in `src/location.ts`, with elevations |

`tools/build-data.ts` converts GeoJSON whose longitude is −180…180 into RA 0…360 and writes
flat typed arrays with index triples, so the bundle carries no JSON parsing and no runtime fetch.

## How the numbers are checked

`bun run verify` (needs network on the first run, then reads `data/horizons/`) compares the app
against NASA JPL Horizons and against brute force. Last run:

| Check | Worst | Limit |
| --- | --- | --- |
| Geocentric apparent RA/Dec vs Horizons | 37.4″ over 700 samples | 60″ |
| Topocentric apparent RA/Dec vs Horizons | 25.6″ over 1 143 samples | 60″ |
| Topocentric elevation vs Horizons (airless) | 0.0013° | 0.02° |
| Topocentric azimuth vs Horizons (airless) | 0.0031° | 0.02° |
| J2000→of-date matrix vs `astronomy-engine`'s rotation, 1700–2300 | 13.2″ | 15″ |
| `horizontal()` vs `astronomy-engine` `Horizon()` | 0.0000° | 0.002° |
| Sidereal time vs GMST with ΔUT1 = 0 | 25.7″ (1.7 s of time) | 60″ |
| Twilight search vs brute-force altitude crossing | 0.058 s | 30 s |
| IAU boundaries vs catalog designators | 99.8 % agree over 489 stars | ≥ 99.5 % |

The remaining gates:

- `bun test` — 102 tests: projections, URL state, wall clocks and the gazetteer, ephemerides
  and coordinate frames, the sky state, the object cards and tables, search, the timeline, and
  the renderer — including frames painted into a recording canvas that refuses colours a
  browser would reject.
- `bun run browser` — 32 checks that drive headless Chromium: Node predicts where Vega,
  Capella, Fomalhaut and Saturn will be drawn, clicks those pixels, and asserts the card that
  comes back. It also exercises search, layer switches, keyboard shortcuts, a hand-edited
  share link, daylight and night counts, the South Pole, and console errors.
- `bun run shot` — eight views written to `.artifacts/`, with assertions on the pixels: star
  counts, darkness, the contrast across the horizon ring, and that daylight paints no stars.

## Modules

| File | Job |
| --- | --- |
| `src/astro.ts` | frames, precession/nutation, horizontal transform, sidereal time, rise/transit/set, twilight, formatting |
| `src/proj.ts` | azimuthal projections: stereographic and equal-angle, and the inverse |
| `src/skyview.ts` | catalog + instant + place → every altitude and azimuth, cached |
| `src/render.ts` | one frame: sky wash, Milky Way, figures, boundaries, stars, bodies, labels, ground |
| `src/location.ts` | gazetteer, great-circle distance, wall-clock modes, name folding |
| `src/map.ts` | the clickable coastline map |
| `src/state.ts` | app state and its URL encoding |
| `src/details.ts` | object cards, the events and twilight tables, the location summary |
| `src/timeline.ts` | the ±12 h altitude strip and the hours of darkness |
| `src/search.ts` | one box for stars, Messier objects, figures, bodies and cities |
| `src/main.ts` | canvas sizing, pointer and keyboard, panels, the render loop |

## Limits of the model

- The horizon is an ideal sea-level plane at the observer's elevation: no terrain, no trees,
  and the dip is approximated from height alone.
- No atmospheric extinction, dispersion or light pollution: a 6th-magnitude star is drawn the
  same in Zürich as on a mountain.
- ΔUT1 is not predictable offline, so sidereal time carries Earth-rotation phase, about a
  second of time these days — a few hundred metres of longitude if you care about that.
- Solar-system bodies are the Sun, Moon and eight planets plus Pluto. No asteroids, comets,
  satellites or spacecraft, and no Moon libration or physical ephemeris.
- Messier markers are glyphs, not images, and the Milky Way is an outline, not a photograph.
- Precession and nutation are IAU 1976 with a truncated nutation series: good to a few tens of
  arcseconds over 1700–2300, which is what the verification above measures.