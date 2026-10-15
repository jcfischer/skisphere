/**
 * browser-check.ts — end-to-end checks in a real browser.
 *
 * The strongest assertion here is the alignment test: the expected altitude and azimuth of
 * a named star are computed in Node (astronomy-engine ephemeris plus this repository's own
 * precession and projection code), converted to canvas pixels, clicked, and then the page
 * must report that same star. That covers the catalog, precession, the horizontal transform,
 * the projection's orientation, and hit-testing, all in one stroke.
 */
import { chromium } from "playwright";
import { computeSky } from "../src/skyview";
import { place, type View } from "../src/proj";
import { dsoMeta, starHip, starNameIdx, starNames } from "../src/data/sky.generated";
import { startServer } from "./serve";
import { DEFAULT_STATE, stateToHash, type AppState } from "../src/state";

const PORT = 8125;
const failures: string[] = [];
const checks: string[] = [];
const NAMES = starNames as readonly string[];

function check(name: string, ok: boolean, detail = "") {
  checks.push(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

function catalogIndex(name: string): number {
  const nameIndex = NAMES.indexOf(name);
  if (nameIndex < 0) throw new Error(`${name} carries no name in this catalog`);
  const star = starNameIdx.indexOf(nameIndex);
  if (star < 0) throw new Error(`${name} is named but not present in the star table`);
  return star;
}

interface Geo {
  lat: number;
  lon: number;
  elevM: number;
}

interface PlaceArgs extends Geo {
  date: Date;
}

interface CanvasBox {
  x: number;
  y: number;
  width: number;
  height: number;
  zoom: number;
  rotation: number;
}

/** The pixel an object occupies on the live canvas, computed independently of the page. */
function pixelOf(args: Geo & { date: Date; kind: "star" | "dso" | "body"; key: string }, box: CanvasBox) {
  const sky = computeSky({ date: args.date, lat: args.lat, lon: args.lon, elevM: args.elevM });
  let alt = -90;
  let az = 0;
  if (args.kind === "star") {
    const i = catalogIndex(args.key);
    alt = sky.stars[i * 2]!;
    az = sky.stars[i * 2 + 1]!;
  } else if (args.kind === "body") {
    const b = sky.bodies.find((x) => x.name === args.key);
    if (!b) throw new Error(`${args.key} is not in the body list`);
    alt = b.alt;
    az = b.az;
  } else {
    const i = dsoMeta.findIndex((d) => d.id === args.key || d.name === args.key);
    if (i < 0) throw new Error(`${args.key} is not in the Messier list`);
    alt = sky.dsos[i * 2]!;
    az = sky.dsos[i * 2 + 1]!;
  }
  const view: View = {
    cx: box.width / 2,
    cy: box.height / 2,
    radius: (Math.min(box.width, box.height) / 2 - 28) * box.zoom,
    rotation: box.rotation,
    mode: "stereographic",
  };
  const p = place(alt, az, view);
  return { x: box.x + p.x, y: box.y + p.y, alt, az, inside: p.inside, sky };
}

function hashFor(over: Partial<AppState>): string {
  const merged: AppState = { ...DEFAULT_STATE, ...over, layers: { ...DEFAULT_STATE.layers, ...(over.layers ?? {}) } };
  const base = stateToHash(merged);
  const params = new URLSearchParams(base.replace(/^#/, ""));
  return `#${params.toString()}`;
}

async function main() {
  const server = startServer(PORT);
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e.message)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });

  const open = async (hash: string) => {
    await page.goto(`http://localhost:${PORT}/index.html${hash}`, { waitUntil: "load" });
    await page.waitForFunction(() => {
      const el = document.getElementById("sky-status");
      return Boolean(el && el.textContent && !el.textContent.startsWith("—"));
    });
    await page.waitForTimeout(320);
  };

  const canvasBox = async (zoom = 1, rotation = 0): Promise<CanvasBox> => {
    const rect = await page.locator("#sky").boundingBox();
    if (!rect) throw new Error("the sky canvas has no box");
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, zoom, rotation };
  };

  const zurich: Geo = { lat: 47.3769, lon: 8.5417, elevM: 408 };
  const instant = new Date(Date.UTC(2026, 9, 15, 20));
  await open(hashFor({ ...zurich, place: "Zürich", date: instant, timeMode: "utc", follow: false }));
  let box = await canvasBox();

  // 1. clicking each of three stars selects that star, at the pixel the math predicts
  for (const star of ["Vega", "Capella", "Fomalhaut"]) {
    const p = pixelOf({ ...zurich, date: instant, kind: "star", key: star }, box);
    if (!p.inside) {
      check(`${star} is above Zürich's horizon at this instant`, false, `predicted alt ${p.alt.toFixed(1)}°`);
      continue;
    }
    await page.mouse.click(p.x, p.y);
    await page.waitForTimeout(140);
    const title = (await page.locator("#details h3").first().textContent()) ?? "";
    const hip = `HIP ${starHip[catalogIndex(star)]}`;
    check(`clicking ${star}'s predicted pixel selects it`, title.includes(star) || title.includes(hip), `alt ${p.alt.toFixed(1)}° az ${p.az.toFixed(1)}° at ${p.x.toFixed(0)},${p.y.toFixed(0)} → "${title}"`);
  }

  // 2. a planet, same test; then its card against the ephemeris numbers
  const saturn = pixelOf({ ...zurich, date: instant, kind: "body", key: "Saturn" }, box);
  await page.mouse.click(saturn.x, saturn.y);
  await page.waitForTimeout(140);
  let title = (await page.locator("#details h3").first().textContent()) ?? "";
  check("clicking Saturn's predicted pixel selects it", title === "Saturn", `alt ${saturn.alt.toFixed(1)}° az ${saturn.az.toFixed(1)}° → "${title}"`);
  const sat = saturn.sky.bodies.find((b) => b.name === "Saturn")!;
  // read the card by row label rather than by cell position, so reordering the card
  // does not silently change what is being asserted
  // the key cells are <th> and the value cells <td>, so read them in document order
  const cardRows = await page.$$eval("#details table tbody tr", (trs) =>
    trs.map((tr) => Array.from(tr.querySelectorAll("th, td")).map((cell) => cell.textContent ?? "")),
  );
  const cardValue = (key: string) => cardRows.find((r) => r[0]?.startsWith(key))?.[1] ?? "";
  const altCell = cardValue("Altitude");
  const shownAlt = Number(altCell.replace("−", "-").match(/^[+-][\d.]+/)?.[0] ?? NaN);
  check(
    "the card's altitude is the ephemeris altitude, in words",
    Math.abs(shownAlt - sat.alt) < 0.06 && /above the horizon · \d+\.\d° [NSEW]+$/.test(altCell),
    `"${altCell}" vs ${sat.alt.toFixed(2)}°`,
  );
  const constCell = cardValue("Constellation");
  check(
    "Saturn's constellation is the IAU boundary lookup's Latin name",
    /Cetus|Pisces|Aries|Aquarius/.test(constCell),
    `"${constCell}"`,
  );
  const raDecCell = cardValue("RA / Dec (apparent, of date)");
  check(
    "the card's coordinates are written as hours and degrees",
    /^\d{1,2}h \d\dm \d+\.\ds  [+−]\d\d° \d\d′ \d\d″$/.test(raDecCell),
    `"${raDecCell}"`,
  );

  // 2b. the picture itself: Vega's pixel is bright, and the layer counts match the catalog
  const starLuma = (x: number, y: number) =>
    page.evaluate(
      ([px, py]) => {
        const c = document.getElementById("sky") as HTMLCanvasElement;
        const d = c.getContext("2d")!.getImageData(Math.round(px) - 2, Math.round(py) - 2, 5, 5).data;
        let peak = 0;
        for (let i = 0; i < d.length; i += 4) peak = Math.max(peak, d[i]! * 0.2126 + d[i + 1]! * 0.7152 + d[i + 2]! * 0.0722);
        return peak;
      },
      [x, y],
    );
  const vega = pixelOf({ ...zurich, date: instant, kind: "star", key: "Vega" }, box);
  const vegaPeak = await starLuma(vega.x - box.x, vega.y - box.y);
  check("Vega is actually painted at its predicted pixel", vegaPeak > 140, `peak luma ${vegaPeak.toFixed(0)} at alt ${vega.alt.toFixed(1)}°`);

  const counts = await page.evaluate(() => {
    const p = window.skisphere;
    return { stars: p?.stats?.starsDrawn ?? -1, figures: p?.stats?.figurePaths ?? -1, dsos: p?.stats?.dsosDrawn ?? -1 };
  });
  const skyForCount = computeSky({ ...zurich, date: instant });
  let aboveHorizon = 0;
  for (let i = 0; i < skyForCount.stars.length / 2; i++) {
    if ((skyForCount.stars[i * 2] ?? -91) > 0) aboveHorizon++;
  }
  check(
    "the star count on screen matches the catalog above the horizon",
    Math.abs(counts.stars - aboveHorizon) <= Math.max(25, aboveHorizon * 0.03),
    `drew ${counts.stars}, catalog says ${aboveHorizon} above the horizon at V ≤ 6`,
  );
  check("all stick-figure paths are drawn", counts.figures === 150, `${counts.figures} paths`);
  check("Messier markers are drawn for the visible ones", counts.dsos > 20 && counts.dsos < dsoMeta.length, `${counts.dsos} of ${dsoMeta.length}`);

  // 3. rise / transit / set table
  const rows = await page.locator("#events tbody tr").allTextContents();
  check("the events table has one row per body", rows.length === saturn.sky.bodies.length, `${rows.length} rows`);
  const sunRow = rows.find((r) => r.includes("Sun")) ?? "";
  check("the Sun row carries rise, transit and set", (sunRow.match(/\d{2}:\d{2}/g) ?? []).length === 3, `"${sunRow}"`);
  const twRows = await page.locator("#twilight tbody tr").allTextContents();
  check("twilight table lists four boundaries", twRows.length === 4, `${twRows.length}`);

  // 4. southern sky: Achernar is invisible at 47°N and high over Sydney
  const sydney: Geo = { lat: -33.8688, lon: 151.2093, elevM: 3 };
  const april = new Date(Date.UTC(2026, 3, 15, 19, 20));
  // computeSky reuses one buffer per catalog table, so read each place before the next call
  const achernar = catalogIndex("Achernar");
  const fromZurich = computeSky({ ...zurich, date: april }).stars[achernar * 2] ?? 0;
  const fromSydney = computeSky({ ...sydney, date: april }).stars[achernar * 2] ?? 0;
  check(
    "Achernar never rises at 47°N and stands well up over Sydney",
    fromSydney > 20 && fromZurich < 0,
    `Sydney ${fromSydney.toFixed(1)}°, Zürich ${fromZurich.toFixed(1)}°`,
  );
  await open(hashFor({ ...sydney, place: "Sydney", date: april, timeMode: "utc", follow: false }));
  box = await canvasBox();
  const mimosa = pixelOf({ ...sydney, date: april, kind: "star", key: "Mimosa" }, box);
  await page.mouse.click(mimosa.x, mimosa.y);
  await page.waitForTimeout(140);
  title = (await page.locator("#details h3").first().textContent()) ?? "";
  check("clicking Mimosa over Sydney selects it", /Mimosa|Becrux|HIP/.test(title), `alt ${mimosa.alt.toFixed(1)}° az ${mimosa.az.toFixed(1)}° → "${title}"`);

  // 5. search selects an object and moves the observer to a city
  await open(hashFor({ ...zurich, date: instant, timeMode: "utc", follow: false }));

  /** Type a query, report what the page offered, click the first hit. */
  const useSearch = async (query: string) => {
    await page.fill("#search", query);
    await page.waitForTimeout(300);
    const count = await page.locator("#search-results button").count();
    const labels = count ? await page.locator("#search-results strong").allTextContents() : [];
    if (!count) check(`searching "${query}" offers a result`, false, `no buttons; errors so far: ${errors.slice(0, 2).join(" | ") || "none"}`);
    else check(`searching "${query}" offers a result`, true, labels.slice(0, 3).join(", "));
    if (count) {
      await page.locator("#search-results button").first().click();
      await page.waitForTimeout(220);
    }
    return count;
  };

  if (await useSearch("m42")) {
    title = (await page.locator("#details h3").first().textContent()) ?? "";
    check("searching M42 selects the Orion Nebula", /M42/.test(title), `"${title}"`);
  }
  await useSearch("tromso");
  const placeName = (await page.locator("#place-name").textContent()) ?? "";
  const latValue = await page.inputValue("#lat");
  check("searching Tromsø moves the observer there", placeName.includes("Tromsø") && latValue.startsWith("69.6"), `${placeName} @ ${latValue}`);

  // 6. layer toggles change the picture
  const brightPixels = () =>
    page.evaluate(() => {
      const c = document.getElementById("sky") as HTMLCanvasElement;
      const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
      let bright = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i]! * 0.2126 + d[i + 1]! * 0.7152 + d[i + 2]! * 0.0722 > 190) bright++;
      }
      return bright;
    });
  const before = await brightPixels();
  await page.click("#layer-lines");
  await page.waitForTimeout(260);
  const after = await brightPixels();
  check("toggling the constellation figures changes the drawing", before !== after, `${before} → ${after} bright px`);
  await page.click("#layer-lines");
  await page.waitForTimeout(200);

  // 7. keyboard shortcuts
  // keys belong to the document, not the search box that still holds focus
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("ArrowUp");
  await page.waitForTimeout(200);
  check("ArrowUp raises the magnitude limit", Number(await page.inputValue("#mag")) > DEFAULT_STATE.magLimit, await page.inputValue("#mag"));
  const timeBefore = (await page.locator("#time-line").textContent()) ?? "";
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(220);
  const timeAfter = (await page.locator("#time-line").textContent()) ?? "";
  check("ArrowRight moves the instant forward", timeBefore !== timeAfter, `${timeBefore} → ${timeAfter}`);
  await page.keyboard.press("g");
  await page.waitForTimeout(200);
  check("g toggles the altitude/azimuth grid", await page.isChecked("#layer-grid"));
  await page.keyboard.press("g");

  // 8. a shared link reloads the same view
  const shared = await page.evaluate(() => location.hash);
  const edited = new URLSearchParams(shared);
  edited.set("lat", "48.2082");
  edited.set("lon", "16.3738");
  edited.set("loc", "Wien");
  await open(`#${edited.toString()}`);
  const coords = (await page.locator("#place-coords").textContent()) ?? "";
  check("editing a shared link loads that view", /48\.208/.test(coords) && coords.includes("16.37"), `"${coords}"`);

  // 9. daylight vs night, read from the frame's own counts
  const probe = () =>
    page.evaluate(() => {
      const p = window.skisphere;
      return {
        stars: p?.stats?.starsDrawn ?? -1,
        labels: p?.stats?.starLabelsDrawn ?? -1,
        dsos: p?.stats?.dsosDrawn ?? -1,
        figures: p?.stats?.figurePaths ?? -1,
        bodies: p?.stats?.bodiesDrawn ?? -1,
        darkness: p?.stats?.darkness ?? -1,
        magLimit: p?.state.magLimit ?? -1,
      };
    });
  await open(hashFor({ ...zurich, date: new Date(Date.UTC(2026, 5, 21, 10, 30)), timeMode: "utc", follow: false }));
  const day = await probe();
  await open(hashFor({ ...zurich, date: instant, timeMode: "utc", follow: false }));
  const night = await probe();
  check("the night frame paints a star field", night.stars > 1000, `${night.stars} stars, ${night.labels} labels, ${night.figures} figure paths`);
  check("the daylight frame paints no stars", day.stars === 0 && day.darkness === 0, `stars ${day.stars}, darkness ${day.darkness}`);
  check("the Sun and Moon are drawn in daylight", day.bodies >= 2, `${day.bodies} bodies`);
  check("Messier objects appear only when it is dark", night.dsos > 20 && day.dsos === 0, `night ${night.dsos}, day ${day.dsos}`);

  // 10. the rotational south pole renders without breaking
  await open(hashFor({ lat: -89.9, lon: 0, elevM: 2835, projection: "equidistant", date: new Date(Date.UTC(2026, 8, 23)), timeMode: "utc", follow: false }));
  const poleStatus = (await page.locator("#sky-status").textContent()) ?? "";
  check("the south pole renders a sky", /Sun/.test(poleStatus), `"${poleStatus}"`);
  const polePixels = await brightPixels();
  check("the pole view actually draws stars", polePixels > 30, `${polePixels} bright px`);

  // 11. nothing blew up anywhere in the run
  check("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));

  await browser.close();
  server.stop();

  console.log(checks.join("\n"));
  console.log(`\n${checks.length - failures.length}/${checks.length} checks passed`);
  if (failures.length) {
    console.log("\nfailures:\n" + failures.map((f) => `  - ${f}`).join("\n"));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`browser check failed: ${String(err)}`);
  process.exit(1);
});