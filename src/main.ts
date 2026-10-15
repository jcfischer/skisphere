/**
 * main.ts — the planetarium: state, canvases, interaction, panels.
 *
 * Frame flow on each animation tick:
 *   state → computeSky()   catalog precession + alt/az, cached per instant and place
 *         → drawScene()    projection and painting
 *         → renderPanels() tables and readouts, rebuilt only when a panel key changes:
 *           the rise/transit/set tables run dozens of ephemeris searches and do not
 *           need 60 Hz.
 *
 * The DOM is built with createElement rather than markup strings: every value printed in a
 * panel is a catalog name or a formatted number, and going through textContent means none of
 * them can become markup.
 */
import { drawScene, moonWaxing, type Layers, type SceneStats, type Selection } from "./render";
import { apparentAlt, computeSky, constellationName, constellationUnder, type SkyState } from "./skyview";
import { place, read, zenithRadius, type ProjectionMode, type View } from "./proj";
import {
  CITIES,
  askBrowserLocation,
  formatClock,
  formatWall,
  nearestPlace,
  setCurrentLon,
  wallInputValue,
  wallToUtc,
  type TimeMode,
} from "./location";
import { drawMap, xToLon, yToLat } from "./map";
import { darknessHours, drawTimeline, sampleTimeline, timelineTargetFor } from "./timeline";
import { search, type Match } from "./search";
import { describe, eventTable, locationSummary, twilightTable, azimuthText, type EventTable, type Row } from "./details";
import {
  DEFAULT_STATE,
  LAYER_LABELS,
  RATES,
  TIME_MODES,
  clampLat,
  coordinateLabel,
  stateFromHash,
  stateToHash,
  wrapLon,
  type AppState,
} from "./state";
import { dsoMeta, starHip, starNameIdx, starNames } from "./data/sky.generated";

const byId = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`index.html is missing #${id}`);
  return el as T;
};
const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] => {
  const el = document.createElement(tag);
  if (className) el.className = className;
  return el;
};
const num = (id: string) => byId<HTMLInputElement>(id);
const pick = (id: string) => byId<HTMLSelectElement>(id);
const clear = (host: HTMLElement) => {
  while (host.firstChild) host.removeChild(host.firstChild);
};

/** A two-column key/value table, rebuilt from `rows`. */
function fillRows(host: HTMLElement, rows: Row[], head?: string[]) {
  clear(host);
  const table = element("table", "kv");
  if (head) {
    const thead = element("thead");
    const tr = element("tr");
    for (const h of head) {
      const th = element("th");
      th.textContent = h;
      tr.appendChild(th);
    }
    thead.appendChild(tr);
    table.appendChild(thead);
  }
  const tbody = element("tbody");
  for (const r of rows) {
    const tr = element("tr");
    const th = element("th");
    th.textContent = r.k;
    const td = element("td");
    td.textContent = r.v;
    tr.append(th, td);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  host.appendChild(table);
}

let state: AppState = stateFromHash(location.hash, DEFAULT_STATE);
let lastStats: SceneStats | null = null;
let hover: Selection = null;
let dirty = true;
let lastPanelKey = "";
let lastPointer: { x: number; y: number } | null = null;
let noteTimer = 0;

const skyCanvas = byId<HTMLCanvasElement>("sky");
const mapCanvas = byId<HTMLCanvasElement>("map");
const stripCanvas = byId<HTMLCanvasElement>("strip");
const skyCtx = skyCanvas.getContext("2d")!;
const mapCtx = mapCanvas.getContext("2d")!;
const stripCtx = stripCanvas.getContext("2d")!;
const dpr = Math.max(1, Math.min(2.5, window.devicePixelRatio || 1));

function viewFor(): View {
  const w = skyCanvas.clientWidth;
  const h = skyCanvas.clientHeight;
  return {
    cx: w / 2,
    cy: h / 2,
    radius: (Math.min(w, h) / 2 - 28) * state.zoom,
    rotation: state.rotation,
    mode: state.projection as ProjectionMode,
  };
}

function currentSky(): SkyState {
  return computeSky({ date: state.date, lat: state.lat, lon: state.lon, elevM: state.elevM });
}

function parseSelection(id: string | null): Selection {
  if (!id) return null;
  const [kind, value] = id.split(":");
  if (kind === "body") return { kind: "body", name: value! };
  const index = Number(value);
  if (!Number.isInteger(index) || index < 0) return null;
  if (kind === "star" || kind === "dso" || kind === "constellation") return { kind, index };
  return null;
}

function selectionId(kind: string, indexOrName: number | string): string {
  return kind === "body" ? `body:${indexOrName}` : `${kind}:${indexOrName}`;
}

function syncHash() {
  const hash = stateToHash(state);
  if (hash !== location.hash) history.replaceState(null, "", hash);
}

function setSelection(id: string | null) {
  state.selected = id;
  dirty = true;
  syncHash();
  renderPanels(currentSky(), true);
}

function note(text: string, ms = 9000) {
  const el = byId("note");
  el.textContent = text;
  el.hidden = false;
  window.clearTimeout(noteTimer);
  noteTimer = window.setTimeout(() => {
    if (el.textContent === text) {
      el.textContent = "";
      el.hidden = true;
    }
  }, ms);
}

// ------------------------------------------------------------- sizing

function sizeCanvas(canvas: HTMLCanvasElement): { w: number; h: number } {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  const pw = Math.max(1, Math.round(w * dpr));
  const ph = Math.max(1, Math.round(h * dpr));
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width = pw;
    canvas.height = ph;
  }
  return { w, h };
}

new ResizeObserver(() => {
  dirty = true;
}).observe(skyCanvas);
window.addEventListener("resize", () => {
  dirty = true;
});

// ------------------------------------------------------------- hit testing

interface Hit {
  kind: "star" | "dso" | "body";
  index: number;
  name?: string;
  px: number;
  /** preference weight: bodies win ties because they are what people mean */
  bias: number;
}

function hitTest(x: number, y: number, sky = currentSky()): Hit | null {
  const v = viewFor();
  const candidates: Hit[] = [];
  const consider = (alt: number, az: number, kind: Hit["kind"], index: number, name: string | undefined, limit: number, bias: number) => {
    if (alt < -0.5) return;
    const p = place(apparentAlt(alt), az, v);
    if (!p.inside) return;
    const d = Math.hypot(p.x - x, p.y - y);
    if (d <= limit) candidates.push({ kind, index, name, px: d, bias });
  };
  for (const b of sky.bodies) consider(b.alt, b.az, "body", -1, b.name, 18, 0.6);
  for (let i = 0; i < dsoMeta.length; i++) consider(sky.dsos[i * 2]!, sky.dsos[i * 2 + 1]!, "dso", i, dsoMeta[i]!.name, 13, 1);
  for (let i = 0; i < sky.stars.length / 2; i++) {
    const alt = sky.stars[i * 2]!;
    if (alt < -0.5) continue;
    consider(alt, sky.stars[i * 2 + 1]!, "star", i, undefined, 11, 1.15);
  }
  candidates.sort((a, b) => a.px * a.bias - b.px * b.bias);
  return candidates[0] ?? null;
}

function hoverIdOf(sel: Selection): string | null {
  if (!sel) return null;
  return sel.kind === "body" ? `body:${sel.name}` : `${sel.kind}:${(sel as { index: number }).index}`;
}

function labelOfHit(hit: Hit): string {
  if (hit.kind === "body") return hit.name ?? "";
  if (hit.kind === "dso") return dsoMeta[hit.index]!.name;
  const nameIdx = starNameIdx[hit.index]!;
  return nameIdx >= 0 ? starNames[nameIdx]! : `HIP ${starHip[hit.index]}`;
}

// ------------------------------------------------------------- pointer

function bearingAt(x: number, y: number): number {
  const v = viewFor();
  return (Math.atan2(x - v.cx, -(y - v.cy)) / (Math.PI / 180) + 360) % 360;
}

let drag: { startBearing: number; startRotation: number; x: number; y: number; moved: boolean } | null = null;

skyCanvas.addEventListener("pointerdown", (e) => {
  const r = skyCanvas.getBoundingClientRect();
  const x = e.clientX - r.left;
  const y = e.clientY - r.top;
  drag = { startBearing: bearingAt(x, y), startRotation: state.rotation, x, y, moved: false };
  skyCanvas.setPointerCapture(e.pointerId);
});

skyCanvas.addEventListener("pointermove", (e) => {
  const r = skyCanvas.getBoundingClientRect();
  const x = e.clientX - r.left;
  const y = e.clientY - r.top;
  lastPointer = { x, y };
  if (drag) {
    if (Math.hypot(x - drag.x, y - drag.y) > 4) drag.moved = true;
    if (drag.moved) {
      const delta = bearingAt(x, y) - drag.startBearing;
      state.rotation = (((drag.startRotation - delta) % 360) + 360) % 360;
      num("rotation").value = state.rotation.toFixed(0);
      byId("rotation-readout").textContent = `${Math.round(state.rotation)}° at top`;
      dirty = true;
    }
    return;
  }
  // the pointer readout follows the cursor, so every move repaints
  dirty = true;
  const hit = hitTest(x, y);
  const id = hit ? selectionId(hit.kind, hit.kind === "body" ? hit.name! : hit.index) : null;
  const hoverId = hover ? hoverIdOf(hover) : null;
  if (id !== hoverId) {
    hover = hit ? ({ kind: hit.kind, index: hit.index, name: hit.name } as Selection) : null;
    skyCanvas.style.cursor = hit ? "pointer" : "grab";
  }
});

skyCanvas.addEventListener("pointerup", (e) => {
  const r = skyCanvas.getBoundingClientRect();
  const moved = drag?.moved ?? false;
  drag = null;
  if (moved) {
    syncHash();
    return;
  }
  const hit = hitTest(e.clientX - r.left, e.clientY - r.top);
  setSelection(hit ? selectionId(hit.kind, hit.kind === "body" ? hit.name! : hit.index) : null);
});

skyCanvas.addEventListener("pointerleave", () => {
  lastPointer = null;
  hover = null;
  dirty = true;
});

skyCanvas.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    state.zoom = Math.max(0.35, Math.min(14, state.zoom * Math.exp(-e.deltaY * 0.0016)));
    num("zoom").value = state.zoom.toFixed(2);
    byId("zoom-readout").textContent = `${state.zoom.toFixed(2)}×`;
    dirty = true;
    syncHash();
  },
  { passive: false },
);

skyCanvas.addEventListener("dblclick", () => {
  resetView();
});

function resetView() {
  state.zoom = DEFAULT_STATE.zoom;
  state.rotation = DEFAULT_STATE.rotation;
  state.magLimit = DEFAULT_STATE.magLimit;
  state.labelLimit = DEFAULT_STATE.labelLimit;
  const readouts: [string, string][] = [
    ["zoom", `${DEFAULT_STATE.zoom.toFixed(2)}×`],
    ["rotation", `${DEFAULT_STATE.rotation.toFixed(0)}° at top`],
    ["mag", `V ≤ ${DEFAULT_STATE.magLimit.toFixed(1)}`],
    ["label-mag", `names at V ≤ ${DEFAULT_STATE.labelLimit.toFixed(1)}`],
  ];
  for (const [id, text] of readouts) {
    num(id).value = text.replace(/[^0-9.]/g, "").slice(0, 5) || "0";
    const readout = document.getElementById(`${id}-readout`);
    if (readout) readout.textContent = text;
  }
  num("zoom").value = DEFAULT_STATE.zoom.toFixed(2);
  num("rotation").value = DEFAULT_STATE.rotation.toFixed(0);
  num("mag").value = String(DEFAULT_STATE.magLimit);
  num("label-mag").value = String(DEFAULT_STATE.labelLimit);
  dirty = true;
  syncHash();
  renderPanels(currentSky(), true);
}

// ------------------------------------------------------------- controls

function bindRange(id: string, get: () => number, set: (v: number) => void, format: (v: number) => string) {
  const el = num(id);
  const readout = document.getElementById(`${id}-readout`);
  // Seed the slider from the state before listening: an <input type="range"> with no value
  // attribute reports its own midpoint, which would overwrite the shared link's numbers.
  el.value = String(get());
  const apply = () => {
    const v = Number(el.value);
    if (Number.isFinite(v)) set(v);
    if (readout) readout.textContent = format(Number(el.value));
    dirty = true;
    syncHash();
  };
  if (readout) readout.textContent = format(get());
  el.addEventListener("input", apply);
}

function setLocation(lat: number, lon: number, elev?: number, name?: string) {
  state.lat = clampLat(lat);
  state.lon = wrapLon(lon);
  if (elev !== undefined) state.elevM = elev;
  const near = nearestPlace(state.lat, state.lon);
  state.place = name ?? (near.km < 40 ? near.place.name : coordinateLabel(state.lat, state.lon));
  setCurrentLon(state.lon);
  num("lat").value = state.lat.toFixed(4);
  num("lon").value = state.lon.toFixed(4);
  num("elev").value = String(Math.round(state.elevM));
  num("city").value = state.place;
  dirty = true;
  syncHash();
  renderPanels(currentSky(), true);
}

function wireLocation() {
  num("lat").value = state.lat.toFixed(4);
  num("lon").value = state.lon.toFixed(4);
  num("elev").value = String(Math.round(state.elevM));
  num("city").value = state.place;
  const datalist = byId("city-list");
  clear(datalist);
  for (const c of CITIES) {
    const opt = element("option");
    opt.value = c.name;
    datalist.appendChild(opt);
  }
  for (const id of ["lat", "lon", "elev"]) {
    num(id).addEventListener("change", () => {
      const v = Number(num(id).value);
      if (!Number.isFinite(v)) return;
      if (id === "elev") setLocation(state.lat, state.lon, v);
      else if (id === "lat") setLocation(v, state.lon, state.elevM);
      else setLocation(state.lat, v, state.elevM);
    });
  }
  const applyCity = () => {
    const wanted = num("city").value.trim().toLowerCase();
    const found = CITIES.find((c) => c.name.toLowerCase() === wanted) ?? CITIES.find((c) => c.name.toLowerCase().startsWith(wanted));
    if (!found) {
      note(`"${num("city").value}" is not in the gazetteer — the latitude and longitude fields take anything.`);
      return;
    }
    setLocation(found.lat, found.lon, found.elev, found.name);
  };
  num("city").addEventListener("change", applyCity);
  num("city").addEventListener("keydown", (e) => {
    if (e.key === "Enter") applyCity();
  });

  byId("where").addEventListener("click", async () => {
    const button = byId("where");
    button.textContent = "locating…";
    try {
      const pos = await askBrowserLocation();
      setLocation(pos.lat, pos.lon, Math.round(pos.elev));
      button.textContent = "located";
    } catch (err) {
      button.textContent = "location blocked";
      note(err instanceof Error ? err.message : String(err));
    }
    window.setTimeout(() => (button.textContent = "Use my location"), 1800);
  });
}

function wireTime() {
  const time = num("time");
  const syncInput = () => {
    time.value = wallInputValue(state.date, state.timeMode);
  };
  syncInput();
  time.addEventListener("change", () => {
    const parts = time.value.split(/[T:]/).map(Number);
    if (parts.length < 5 || parts.some((n) => !Number.isFinite(n))) return;
    state.date = wallToUtc(parts, state.timeMode);
    state.follow = false;
    state.playing = false;
    byId("play").textContent = "play";
    dirty = true;
    syncHash();
    renderPanels(currentSky(), true);
  });

  const modeSelect = pick("time-mode");
  clear(modeSelect);
  for (const m of TIME_MODES) {
    const opt = element("option");
    opt.value = m.key;
    opt.textContent = m.label;
    opt.title = m.hint;
    modeSelect.appendChild(opt);
  }
  modeSelect.value = state.timeMode;
  modeSelect.addEventListener("change", () => {
    state.timeMode = modeSelect.value as TimeMode;
    syncInput();
    dirty = true;
    syncHash();
    renderPanels(currentSky(), true);
  });

  byId("now").addEventListener("click", () => {
    state.follow = true;
    state.playing = false;
    byId("play").textContent = "play";
    syncInput();
    dirty = true;
    syncHash();
    renderPanels(currentSky(), true);
  });

  for (const button of Array.from(document.querySelectorAll(".nudge"))) {
    button.addEventListener("click", () => {
      const minutes = Number(button.getAttribute("data-minutes") ?? "0");
      nudge(minutes);
    });
  }

  byId("play").addEventListener("click", () => {
    state.playing = !state.playing;
    if (state.playing) state.follow = false;
    byId("play").textContent = state.playing ? "pause" : "play";
    dirty = true;
    renderPanels(currentSky(), true);
  });

  const rateSelect = pick("rate");
  clear(rateSelect);
  for (const r of RATES) {
    const opt = element("option");
    opt.value = String(r.value);
    opt.textContent = r.label;
    rateSelect.appendChild(opt);
  }
  rateSelect.value = String(state.rate);
  rateSelect.addEventListener("change", () => {
    state.rate = Number(rateSelect.value);
  });

  syncTimeInput = syncInput;
}

let syncTimeInput: () => void = () => {};

function nudge(minutes: number) {
  state.date = new Date(state.date.getTime() + minutes * 60000);
  state.follow = false;
  state.playing = false;
  byId("play").textContent = "play";
  syncTimeInput();
  dirty = true;
  syncHash();
  renderPanels(currentSky(), true);
}

function wireDisplay() {
  const proj = pick("projection");
  clear(proj);
  for (const [value, label, title] of [
    ["stereographic", "Fisheye (stereographic)", "Angles around the zenith keep their shape; the horizon is the circle"],
    ["equidistant", "Equal-angle", "Distance from the centre reads directly as degrees from the zenith"],
  ]) {
    const opt = element("option");
    opt.value = value;
    opt.textContent = label;
    opt.title = title;
    proj.appendChild(opt);
  }
  proj.value = state.projection;
  proj.addEventListener("change", () => {
    state.projection = proj.value as ProjectionMode;
    dirty = true;
    syncHash();
    renderPanels(currentSky(), true);
  });

  bindRange(
    "mag",
    () => state.magLimit,
    (v) => (state.magLimit = Math.max(0, Math.min(6.5, v))),
    (v) => `V ≤ ${v.toFixed(1)}`,
  );
  bindRange(
    "label-mag",
    () => state.labelLimit,
    (v) => (state.labelLimit = v),
    (v) => `names at V ≤ ${v.toFixed(1)}`,
  );
  bindRange(
    "zoom",
    () => state.zoom,
    (v) => (state.zoom = v),
    (v) => `${v.toFixed(2)}×`,
  );
  bindRange(
    "rotation",
    () => state.rotation,
    (v) => (state.rotation = ((v % 360) + 360) % 360),
    (v) => `${Math.round(v)}° at top`,
  );
  byId("reset").addEventListener("click", resetView);

  const host = byId("layer-list");
  clear(host);
  for (const layer of LAYER_LABELS) {
    const label = element("label", "row");
    const box = element("input");
    box.type = "checkbox";
    box.id = `layer-${layer.key}`;
    box.checked = state.layers[layer.key];
    box.addEventListener("change", () => {
      state.layers[layer.key] = box.checked;
      dirty = true;
      syncHash();
      renderPanels(currentSky(), true);
    });
    const text = element("span");
    text.textContent = layer.label;
    label.append(box, text);
    label.title = layer.hint;
    host.appendChild(label);
  }
}

function wireSearch() {
  const box = num("search");
  const results = byId("search-results");
  const show = (matches: Match[]) => {
    clear(results);
    for (const m of matches) {
      const row = element("button", "match");
      row.type = "button";
      const strong = element("strong");
      strong.textContent = m.label;
      const small = element("small");
      small.textContent = m.detail;
      row.append(strong, small);
      row.addEventListener("click", () => {
        if (m.kind === "city" && m.place) setLocation(m.place.lat, m.place.lon, m.place.elev, m.place.name);
        else setSelection(m.id);
        clear(results);
        box.value = m.label;
      });
      results.appendChild(row);
    }
  };
  box.addEventListener("input", () => show(search(box.value)));
  box.addEventListener("keydown", (e) => {
    if (e.key === "Enter") results.querySelector<HTMLButtonElement>("button")?.click();
    if (e.key === "Escape") {
      box.value = "";
      clear(results);
    }
  });
}

function wireMap() {
  let down = false;
  const pickUp = (e: PointerEvent) => {
    const r = mapCanvas.getBoundingClientRect();
    const lon = wrapLon(xToLon(e.clientX - r.left, r.width));
    const lat = clampLat(yToLat(e.clientY - r.top, r.height));
    setLocation(lat, lon);
  };
  mapCanvas.addEventListener("pointerdown", (e) => {
    down = true;
    pickUp(e);
    mapCanvas.setPointerCapture(e.pointerId);
  });
  mapCanvas.addEventListener("pointermove", (e) => {
    if (down) pickUp(e);
  });
  mapCanvas.addEventListener("pointerup", () => {
    down = false;
  });
}

// ------------------------------------------------------------- panels

function eventRows(rows: EventTable[]): Row[] {
  return rows.map((r) => ({
    k: `${r.symbol} ${r.name}`,
    v: `${r.alt >= 0 ? "+" : "−"}${Math.abs(r.alt).toFixed(0)}° ${azimuthText(r.az).split(" ")[1]} · ${
      r.rise ? `↑${formatClock(r.rise, state.timeMode)}` : "↑—"
    } ${r.transit ? `▪${formatClock(r.transit, state.timeMode)}` : "▪—"} ${r.set ? `↓${formatClock(r.set, state.timeMode)}` : "↓—"} · ${r.constellation}`,
  }));
}

function renderPanels(sky: SkyState, force = false) {
  const key = [
    Math.round(state.date.getTime() / 60000),
    state.lat.toFixed(3),
    state.lon.toFixed(3),
    state.timeMode,
    state.selected ?? "-",
    state.projection,
    Object.entries(state.layers)
      .map(([k, v]) => (v ? k : ""))
      .join(","),
  ].join("|");
  if (!force && key === lastPanelKey) return;
  lastPanelKey = key;

  byId("place-name").textContent = state.place;
  byId("place-coords").textContent = `${coordinateLabel(state.lat, state.lon)} · ${Math.round(state.elevM)} m · ${nearestPlace(state.lat, state.lon).place.name} nearby`;
  byId("time-line").textContent = formatWall(state.date, state.timeMode, true);
  byId("follow").textContent = state.follow ? "following the clock" : state.playing ? `running at ${state.rate}× real time` : "held";
  byId("sky-status").textContent = `Sun ${sky.sun.alt.toFixed(1)}° · ${sky.twilight} · sidereal time ${(sky.lst / 15).toFixed(2)} h`;
  byId("moon-status").textContent = `Moon ${sky.moon.alt.toFixed(1)}° · ${((sky.moon.phase ?? 0) * 100).toFixed(0)}% ${
    moonWaxing(state.date) ? "waxing" : "waning"
  }`;

  fillRows(byId("location-rows"), locationSummary(state, sky));

  const details = state.selected ? describe(state.selected, sky, state) : null;
  const card = byId("details");
  clear(card);
  if (details) {
    const h = element("h3");
    h.textContent = details.title;
    const sub = element("p", "sub");
    sub.textContent = details.subtitle;
    card.append(h, sub);
    const holder = element("div");
    fillRows(holder, details.rows);
    card.appendChild(holder);
    if (details.note) {
      const n = element("p", "note");
      n.textContent = details.note;
      card.appendChild(n);
    }
    byId("clear-selection").hidden = false;
  } else {
    const hint = element("p", "hint");
    hint.textContent =
      "Click a star, planet or Messier object in the sky — or search for one. Bodies and named stars are drawn for the current magnitude limit; the pointer readout below the map gives altitude, azimuth and the IAU constellation under the cursor.";
    card.appendChild(hint);
    byId("clear-selection").hidden = true;
  }
  byId("clear-selection").onclick = () => setSelection(null);

  fillRows(byId("events"), eventRows(eventTable(sky, state)), ["Body", "Now · rise · transit · set · constellation"]);
  fillRows(
    byId("twilight"),
    twilightTable(state).map((r) => ({
      k: r.label,
      v: `${r.evening ? formatClock(r.evening, state.timeMode) : "—"} evening · ${r.morning ? formatClock(r.morning, state.timeMode) : "—"} morning`,
    })),
  );

  const strip = sizeCanvas(stripCanvas);
  const selectedKind = state.selected?.split(":")[0];
  const target = timelineTargetFor(
    state.selected && (selectedKind === "star" || selectedKind === "dso" || selectedKind === "body")
      ? {
          kind: selectedKind,
          index: Number(state.selected.split(":")[1]),
          name: selectedKind === "body" ? state.selected.slice(5) : labelOfSelection(state.selected),
        }
      : null,
  );
  const samples = sampleTimeline(state.date, state.lat, state.lon, state.elevM, target);
  drawTimeline(stripCtx, strip.w, strip.h, samples, { dpr, date: state.date, timeMode: state.timeMode, showTarget: Boolean(target) });
  byId("darkness").textContent = `${darknessHours(samples).toFixed(1)} h with the Sun below −0.83° in this window`;

  const map = sizeCanvas(mapCanvas);
  drawMap(mapCtx, map.w, map.h, { lat: state.lat, lon: state.lon }, {
    dpr,
    markers: [{ lat: state.lat, lon: state.lon, label: state.place, active: true }],
  });
}

function labelOfSelection(selId: string): string {
  const [kind, value] = selId.split(":");
  if (kind !== "star") return "";
  const nameIdx = starNameIdx[Number(value)]!;
  return nameIdx >= 0 ? starNames[nameIdx]! : `HIP ${starHip[Number(value)]}`;
}

// ------------------------------------------------------------- overlay + loop

function drawOverlay(h: number, v: View) {
  skyCtx.save();
  skyCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  skyCtx.font = "11px ui-sans-serif, system-ui, sans-serif";
  const degreesPerPixel = 90 / (zenithRadius(0, v.mode) * v.radius);
  const degrees = Math.max(1, Math.round(90 * degreesPerPixel));
  const px = degrees / degreesPerPixel;
  const x0 = 14;
  const y0 = h - 16;
  skyCtx.strokeStyle = "rgba(226, 232, 245, 0.8)";
  skyCtx.lineWidth = 1.2;
  skyCtx.beginPath();
  skyCtx.moveTo(x0, y0 - 6);
  skyCtx.lineTo(x0, y0);
  skyCtx.lineTo(x0 + px, y0);
  skyCtx.lineTo(x0 + px, y0 - 6);
  skyCtx.stroke();
  skyCtx.fillStyle = "rgba(226, 232, 245, 0.9)";
  skyCtx.fillText(`${degrees}°`, x0 + px / 2 - 8, y0 - 9);
  skyCtx.fillText(
    `${v.mode === "equidistant" ? "equal-angle" : "fisheye"} · ${state.zoom.toFixed(2)}× · north is ${Math.round((360 - state.rotation) % 360)}° clockwise from the top`,
    x0,
    y0 - 26,
  );
  skyCtx.restore();
}

function updatePointerReadout(v: View) {
  const el = byId("pointer-readout");
  if (!lastPointer) {
    el.textContent = "move the pointer over the sky for altitude and azimuth";
    return;
  }
  const r = read(lastPointer.x, lastPointer.y, v);
  if (r.alt < -50) {
    el.textContent = "beyond the horizon circle";
    return;
  }
  const under = r.alt > -1 ? constellationUnder(r.alt, r.az, currentSky()) : "";
  el.textContent = `${r.alt >= 0 ? "+" : "−"}${Math.abs(r.alt).toFixed(1)}° altitude · ${azimuthText(r.az)}${
    under ? ` · in ${under}` : ""
  }${hoverSuffix(hover)}`;
}

/** What the hovered object is called, and where it sits, appended to the pointer readout. */
function hoverSuffix(sel: Selection): string {
  if (!sel) return "";
  switch (sel.kind) {
    case "body": {
      const body = currentSky().bodies.find((x) => x.name === sel.name);
      if (!body) return ` — ${sel.name}`;
      return ` — ${body.name}, mag ${body.mag?.toFixed(1) ?? "?"}, in ${constellationName(body.ra, body.dec)}`;
    }
    case "dso":
      return ` — ${dsoMeta[sel.index]!.name}`;
    case "star":
      return ` — ${labelOfHit({ kind: "star", index: sel.index, px: 0, bias: 1 })}`;
    case "constellation":
      return "";
    default:
      return "";
  }
}

let lastFrame = performance.now();

function frame(now: number) {
  const dt = Math.min(0.5, (now - lastFrame) / 1000);
  lastFrame = now;
  if (state.follow) {
    state.date = new Date();
    dirty = true;
  } else if (state.playing) {
    state.date = new Date(state.date.getTime() + state.rate * dt * 1000);
    dirty = true;
  }
  if (dirty) {
    dirty = false;
    const { w, h } = sizeCanvas(skyCanvas);
    if (w < 40 || h < 40) {
      // the stage has not been laid out yet — try again on the next frame
      dirty = true;
      requestAnimationFrame(frame);
      return;
    }
    const sky = currentSky();
    const view = viewFor();
    try {
      lastStats = drawScene({
        ctx: skyCtx,
        view,
        sky,
        options: {
          layers: state.layers,
          magLimit: state.magLimit,
          labelLimit: state.labelLimit,
          selection: parseSelection(state.selected),
          hover,
          clock: now,
        },
        dpr,
      });
      drawOverlay(h, view);
      updatePointerReadout(view);
      renderPanels(sky);
    } catch (err) {
      // one bad frame must not stop the loop: report it and keep the last picture
      note(`drawing failed: ${err instanceof Error ? err.message : String(err)}`, 4000);
    }
  }
  requestAnimationFrame(frame);
}

// ------------------------------------------------------------- keyboard

const LAYER_KEYS: Record<string, keyof Layers> = {
  l: "lines",
  c: "constellationLabels",
  b: "bounds",
  m: "milkyWay",
  r: "starNames",
  f: "refraction",
  t: "twinkle",
  d: "dsos",
  p: "bodies",
  j: "ecliptic",
  q: "equator",
  g: "grid",
};

const BEARINGS: Record<string, number> = { n: 0, e: 90, s: 180, w: 270 };

window.addEventListener("keydown", (e) => {
  const target = e.target as HTMLElement | null;
  if (target && ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName)) return;
  const key = e.key.toLowerCase();
  if (key === " ") {
    byId("play").click();
  } else if (key === "arrowright") {
    nudge(e.altKey ? 1440 : e.shiftKey ? 60 : 10);
  } else if (key === "arrowleft") {
    nudge(e.altKey ? -1440 : e.shiftKey ? -60 : -10);
  } else if (key === "arrowup" || key === "arrowdown") {
    const step = key === "arrowup" ? 0.5 : -0.5;
    state.magLimit = Math.max(0, Math.min(6.5, state.magLimit + step));
    num("mag").value = String(state.magLimit);
    byId("mag-readout").textContent = `V ≤ ${state.magLimit.toFixed(1)}`;
    dirty = true;
    syncHash();
  } else if (key === "escape") {
    setSelection(null);
  } else if (key === "0") {
    byId("now").click();
  } else if (key === "?" || key === "/") {
    byId("help").hidden = !byId("help").hidden;
  } else if (BEARINGS[key] !== undefined) {
    state.rotation = BEARINGS[key]!;
    num("rotation").value = String(state.rotation);
    byId("rotation-readout").textContent = `${state.rotation}° at top`;
    dirty = true;
    syncHash();
  } else if (LAYER_KEYS[key]) {
    const layer = LAYER_KEYS[key]!;
    state.layers[layer] = !state.layers[layer];
    const box = document.getElementById(`layer-${layer}`) as HTMLInputElement | null;
    if (box) box.checked = state.layers[layer];
    dirty = true;
    syncHash();
    renderPanels(currentSky(), true);
  } else {
    return;
  }
  e.preventDefault();
});

// ------------------------------------------------------------- boot

function boot() {
  setCurrentLon(state.lon);
  wireLocation();
  wireTime();
  wireDisplay();
  wireSearch();
  wireMap();
  byId("caption").textContent = `${CITIES.length} places in the gazetteer · stars to V ≈ 6 · ephemerides from JPL DE441 via astronomy-engine`;
  window.addEventListener("hashchange", () => {
    state = stateFromHash(location.hash, DEFAULT_STATE);
    setCurrentLon(state.lon);
    num("lat").value = state.lat.toFixed(4);
    num("lon").value = state.lon.toFixed(4);
    num("elev").value = String(Math.round(state.elevM));
    num("city").value = state.place;
    pick("time-mode").value = state.timeMode;
    pick("projection").value = state.projection;
    num("zoom").value = state.zoom.toFixed(2);
    num("rotation").value = state.rotation.toFixed(0);
    num("mag").value = String(state.magLimit);
    num("label-mag").value = String(state.labelLimit);
    for (const layer of LAYER_LABELS) {
      const box = document.getElementById(`layer-${layer.key}`) as HTMLInputElement | null;
      if (box) box.checked = state.layers[layer.key];
    }
    syncTimeInput();
    dirty = true;
    renderPanels(currentSky(), true);
  });
  const params = new URLSearchParams(location.search);
  if (params.get("nofullscreen") !== null) {
    note("Add #lat=..&lon=..&t=..&loc=.. to the URL to share this exact view; the share button copies it.", 12000);
  }
  requestAnimationFrame(frame);
}

byId("copy-link").addEventListener("click", async () => {
  const url = location.href;
  try {
    await navigator.clipboard.writeText(url);
    byId("copy-link").textContent = "link copied";
  } catch {
    byId("copy-link").textContent = "copy failed";
    note("The clipboard is blocked here; the address bar already holds the link.");
  }
  window.setTimeout(() => (byId("copy-link").textContent = "copy link"), 1600);
});

byId("help").hidden = true;
byId("toggle-help").addEventListener("click", () => {
  byId("help").hidden = !byId("help").hidden;
});
byId("toggle-left").addEventListener("click", () => document.body.classList.toggle("hide-left"));
byId("toggle-right").addEventListener("click", () => document.body.classList.toggle("hide-right"));

/**
 * `window.skisphere` — the frame's counts and the live state, for the browser checks and for
 * poking at the page from a console. Read-only by construction: every access recomputes.
 */
export interface PlanetariumProbe {
  stats: SceneStats | null;
  state: AppState;
  view: View;
  sky: SkyState;
}

declare global {
  interface Window {
    skisphere?: PlanetariumProbe;
  }
}

Object.defineProperty(window, "skisphere", {
  get: (): PlanetariumProbe => ({ stats: lastStats, state, view: viewFor(), sky: currentSky() }),
});

boot();