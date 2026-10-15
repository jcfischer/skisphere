/**
 * map.ts — the location picker: an equirectangular world outline you can click or drag.
 *
 * Coastlines come from the generated `landPack` (Natural Earth 110 m). The map is drawn in
 * plain latitude/longitude degrees, no projection maths: x = (lon + 180) / 360, y is
 * linear in latitude, so a click reads back positionally without an inverse transform.
 */
import { landData, landIndex } from "./data/sky.generated";

export interface MapView {
  lat: number;
  lon: number;
}

const LAT_MIN = -85;
const LAT_MAX = 85;

export function lonToX(lon: number, w: number): number {
  return (((lon + 180) % 360) + 360) % 360 / 360 * w;
}
export function latToY(lat: number, h: number): number {
  const t = (LAT_MAX - Math.max(LAT_MIN, Math.min(LAT_MAX, lat))) / (LAT_MAX - LAT_MIN);
  return t * h;
}
export function xToLon(x: number, w: number): number {
  return (x / w) * 360 - 180;
}
export function yToLat(y: number, h: number): number {
  return LAT_MAX - (y / h) * (LAT_MAX - LAT_MIN);
}

export function drawMap(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  view: MapView,
  opts: { markers?: { lat: number; lon: number; label?: string; active?: boolean }[]; dpr: number },
) {
  ctx.save();
  ctx.setTransform(opts.dpr, 0, 0, opts.dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const ocean = ctx.createLinearGradient(0, 0, 0, h);
  ocean.addColorStop(0, "#0d1526");
  ocean.addColorStop(0.5, "#101a2e");
  ocean.addColorStop(1, "#0d1526");
  ctx.fillStyle = ocean;
  ctx.fillRect(0, 0, w, h);

  // graticule
  ctx.strokeStyle = "rgba(140, 165, 205, 0.14)";
  ctx.lineWidth = 0.6;
  for (let lon = -150; lon <= 150; lon += 30) {
    ctx.beginPath();
    ctx.moveTo(lonToX(lon, w), 0);
    ctx.lineTo(lonToX(lon, w), h);
    ctx.stroke();
  }
  for (let lat = -60; lat <= 60; lat += 30) {
    ctx.beginPath();
    ctx.moveTo(0, latToY(lat, h));
    ctx.lineTo(w, latToY(lat, h));
    ctx.stroke();
  }
  // equator and tropics read as reference lines
  ctx.strokeStyle = "rgba(160, 190, 230, 0.28)";
  ctx.setLineDash([4, 4]);
  for (const lat of [0, 23.44, -23.44, 66.56, -66.56]) {
    ctx.beginPath();
    ctx.moveTo(0, latToY(lat, h));
    ctx.lineTo(w, latToY(lat, h));
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // land
  ctx.fillStyle = "rgba(84, 106, 92, 0.75)";
  ctx.strokeStyle = "rgba(150, 180, 160, 0.55)";
  ctx.lineWidth = 0.5;
  for (let i = 0; i < landIndex.length; i++) {
    const start = landIndex[i]!;
    const count = i + 1 < landIndex.length ? (landIndex[i + 1]! - start) / 2 : landData.length / 2 - start / 2;
    if (count < 2) continue;
    ctx.beginPath();
    for (let v = 0; v < count; v++) {
      const lon = landData[(start + v) * 2]!;
      const lat = landData[(start + v) * 2 + 1]!;
      const x = lonToX(lon, w);
      const y = latToY(lat, h);
      if (v === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }

  // day/night terminator for the current instant: a soft band centred on local midnight
  if (opts.markers?.length) {
    for (const m of opts.markers) {
      const x = lonToX(m.lon, w);
      const y = latToY(m.lat, h);
      ctx.beginPath();
      ctx.arc(x, y, m.active ? 6 : 4, 0, Math.PI * 2);
      ctx.fillStyle = m.active ? "rgba(255, 205, 110, 0.95)" : "rgba(150, 200, 255, 0.7)";
      ctx.fill();
      if (m.label) {
        ctx.font = "11px ui-sans-serif, system-ui, sans-serif";
        ctx.fillStyle = "rgba(235, 240, 250, 0.9)";
        ctx.fillText(m.label, Math.min(w - ctx.measureText(m.label).width - 4, x + 8), y - 6);
      }
    }
  }

  ctx.strokeStyle = "rgba(255, 255, 255, 0.18)";
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
  ctx.restore();
}