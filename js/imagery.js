// Aerial imagery: a catalog of sources (local Arkansas services first) and one fetcher that returns the site box
// in its State Plane zone, grid north up, at a requested pixel size.
//
// Three ways to get pixels:
//   'map'   — ArcGIS MapServer /export, reprojected by the server straight into the State Plane zone
//   'image' — ArcGIS ImageServer /exportImage, same
//   'tiles' — Web Mercator XYZ tiles, stitched and warped into the State Plane box here
import { projector, zoneUnitsPerMeter } from './geo.js?v=0.27.1';

const AR = [-94.65, 32.95, -89.58, 36.55];             // Arkansas (lon/lat box)
const PULASKI = [-92.757, 34.483, -92.024, 35.015];    // PAgis service extent

/**
 * Checked from the github.io origin on 2026-10-20 (all allow browser requests):
 * - PAgis 2024 (MAPS/AerialPhotos2024, State Plane AR North ft) — newest and sharpest seen in Little Rock.
 * - Arkansas GIS Office ADOP 2023, 9 in (pixel 0.2 m), statewide; dynamic export works.
 * - Arkansas GIS Office High_Resolution_Composite: local city/county sets (Pulaski 2018 3 in, City of Conway 2019 6 in,
 *   EAPDD Jonesboro 6 in, Polk 2010 6 in, Garland 2013, Benton, Washington, Paragould 2019, …). Its dynamic export
 *   did not respond; its cached tiles stop at level 19 (≈0.8 ft on the ground), so it's offered by hand only.
 * - Esri World Imagery: sharp in many towns, but /export returned HTTP 500 around Conway; its tiles there exist to
 *   level 19 only (higher levels are grey "not available" placeholders).
 */
export const IMAGERY_SOURCES = [
  { id: 'pagis2024', label: 'PAgis 2024 — Pulaski County', kind: 'map', bounds: PULASKI, year: 2024,
    url: 'https://www.pagis.org/arcgis/rest/services/MAPS/AerialPhotos2024/MapServer',
    credit: 'Pulaski Area GIS (PAgis) 2024 orthophotography' },
  { id: 'esri', label: 'Esri World Imagery', kind: 'map',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer',
    tiles: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', maxZ: 22, wgs84: true,
    credit: 'Esri World Imagery (Esri, Maxar, Earthstar Geographics)' },
  { id: 'ar2023', label: 'Arkansas statewide 2023 (9 in)', kind: 'image', bounds: AR, year: 2023,
    url: 'https://gis.arkansas.gov/arcgis/rest/services/ImageServices/IMAGERY_9IN_2023/ImageServer',
    credit: 'Arkansas GIS Office, ADOP 2023 9-inch orthoimagery' },
  { id: 'arlocal', label: 'Arkansas city/county high-res (composite, ~1 ft)', kind: 'tiles', bounds: AR, maxZ: 19,
    tiles: 'https://gis.arkansas.gov/arcgis/rest/services/ImageServices/High_Resolution_Composite/ImageServer/tile/{z}/{y}/{x}',
    credit: 'Arkansas GIS Office High Resolution Composite (local city/county orthoimagery)' },
  { id: 'pagis2021', label: 'PAgis 2021 — Pulaski County', kind: 'map', bounds: PULASKI, year: 2021,
    url: 'https://www.pagis.org/arcgis/rest/services/MAPS/AerialPhotos2021/MapServer',
    credit: 'Pulaski Area GIS (PAgis) 2021 orthophotography' },
  { id: 'usgs', label: 'USGS National Map (about 1 m)', kind: 'map',
    url: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer',
    credit: 'USGS The National Map: Orthoimagery (public domain)' },
];

/** Automatic order: [source id, method]. Esri's tiles are a later fallback when its export fails. */
const AUTO = [['pagis2024', 'export'], ['esri', 'export'], ['ar2023', 'export'], ['esri', 'tiles'], ['usgs', 'export']];

export const sourceById = id => IMAGERY_SOURCES.find(s => s.id === id);

/** A pasted ArcGIS MapServer / ImageServer URL as a source. */
export function customSource(url) {
  const u = String(url || '').trim().replace(/\/+$/, '').replace(/\/(export|exportImage)$/i, '').replace(/\?.*$/, '');
  if (!/^https:\/\/.+\/(MapServer|ImageServer)$/i.test(u)) return null;
  return { id: 'custom', label: 'Custom service', kind: /ImageServer$/i.test(u) ? 'image' : 'map', url: u,
    credit: `Custom imagery service: ${u}` };
}

/** Lon/lat corners of the box. */
function corners(zone, box) {
  const p = projector(zone);
  return [[box.xmin, box.ymin], [box.xmax, box.ymin], [box.xmax, box.ymax], [box.xmin, box.ymax]].map(c => p.inv(c));
}
const inside = (b, [lon, lat]) => lon >= b[0] && lon <= b[2] && lat >= b[1] && lat <= b[3];
export function covers(src, zone, box) { return !src.bounds || corners(zone, box).every(c => inside(src.bounds, c)); }

/** Sources to try, in order, for this site and choice ('auto', a source id, or 'custom'). */
export function plan(choice, zone, box, custom) {
  if (choice === 'custom' && custom) return [[custom, 'export'], ...plan('auto', zone, box)];
  const chosen = choice !== 'auto' && sourceById(choice);
  const steps = chosen ? [[chosen, chosen.kind === 'tiles' ? 'tiles' : 'export']] : [];
  if (chosen?.tiles && chosen.kind !== 'tiles') steps.push([chosen, 'tiles']);
  for (const [id, how] of AUTO) {
    const s = sourceById(id);
    if (!steps.some(([q, h]) => q === s && h === how) && covers(s, zone, box)) steps.push([s, how]);
  }
  return steps;
}

/**
 * Fetch the box at W×H pixels from one source. Returns a canvas, or throws.
 * opts: { tile (max request size), onTile(done, total) }
 */
export async function fetchBox(src, how, zone, box, W, H, opts = {}) {
  return how === 'tiles' ? fetchTiles(src, zone, box, W, H, opts) : fetchExport(src, zone, box, W, H, opts);
}

async function fetchExport(src, zone, box, W, H, { tile = 2048, onTile } = {}) {
  // Converted zones are requested in their metric EPSG units.
  const toReq = zone.note ? 1 / zoneUnitsPerMeter(zone) : 1;
  const w = box.xmax - box.xmin, h = box.ymax - box.ymin;
  const nx = Math.ceil(W / tile), ny = Math.ceil(H / tile);
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  const endpoint = `${src.url}/${src.kind === 'image' ? 'exportImage' : 'export'}`;
  const jobs = [];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) jobs.push([i, j]);
  let done = 0, failed = false;
  const one = async ([i, j]) => {
    const px0 = i * tile, py0 = j * tile;
    const tw = Math.min(tile, W - px0), th = Math.min(tile, H - py0);
    // Tile bbox in native zone units; pixel rows count down from the north edge.
    const x0 = box.xmin + px0 / W * w, x1 = box.xmin + (px0 + tw) / W * w;
    const y1 = box.ymax - py0 / H * h, y0 = box.ymax - (py0 + th) / H * h;
    const params = new URLSearchParams({
      bbox: [x0 * toReq, y0 * toReq, x1 * toReq, y1 * toReq].join(','),
      bboxSR: String(zone.code), imageSR: String(zone.code), size: `${tw},${th}`, format: 'jpg', f: 'image',
    });
    if (src.kind === 'image') params.set('interpolation', 'RSP_BilinearInterpolation');
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        // A first failure on the first piece usually means the service can't do this at all: give up fast.
        const r = await fetch(`${endpoint}?${params}`, { signal: AbortSignal.timeout(done ? 60000 : 25000) });
        if (!r.ok || !(r.headers.get('content-type') || '').startsWith('image/')) throw new Error(`HTTP ${r.status}`);
        const bmp = await createImageBitmap(await r.blob());
        ctx.drawImage(bmp, px0, py0, tw, th);
        bmp.close?.();
        onTile?.(++done, jobs.length);
        return;
      } catch {
        if (!done && attempt >= 1) break;
        await new Promise(res => setTimeout(res, 700 * (attempt + 1)));
      }
    }
    failed = true;
  };
  // The first piece alone (fails fast if the service can't serve this place), then 4 at a time.
  await one(jobs.shift());
  const queue = jobs;
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => { while (!failed && queue.length) await one(queue.shift()); }));
  if (failed) { canvas.width = canvas.height = 0; throw new Error(`${src.label} did not return imagery`); }
  return canvas;
}

// ---- Web Mercator tiles ----
const R = 6378137, HALF = Math.PI * R;
const merc = ([lon, lat]) => [lon * HALF / 180, Math.log(Math.tan((90 + lat) * Math.PI / 360)) * R];
/* global proj4 */
// NAD83 -> WGS84 (ITRF) shift, about 1 m in Arkansas — the same transformation ArcGIS applies when it reprojects
// WGS84 imagery into State Plane. Tiles of WGS84 sources are looked up at the shifted position. (Esri tiles
// warped this way matched Esri's own State Plane export within a pixel; without it they were ~1 m off.)
const NAD83_ITRF = '+proj=longlat +ellps=GRS80 +towgs84=-0.9956,1.9013,0.5215,0.025915,0.009426,0.011599,-0.00062 +no_defs';
const toWgs84 = ll => proj4(NAD83_ITRF, 'EPSG:4326', ll);

async function tileBitmap(url, signal) {
  const r = await fetch(url, { signal });
  if (!r.ok || !(r.headers.get('content-type') || '').startsWith('image/')) return null;
  return createImageBitmap(await r.blob());
}
/** Esri answers missing levels with a flat grey "not yet available" tile. */
function isPlaceholder(bmp) {
  const c = new OffscreenCanvas(16, 16), g = c.getContext('2d');
  g.drawImage(bmp, 0, 0, 16, 16);
  const d = g.getImageData(0, 0, 16, 16).data;
  let mn = 255, mx = 0;
  for (let i = 0; i < d.length; i += 4) { const v = (d[i] + d[i + 1] + d[i + 2]) / 3; mn = Math.min(mn, v); mx = Math.max(mx, v); }
  return mx - mn < 6;
}

async function fetchTiles(src, zone, box, W, H, { onTile } = {}) {
  const shift = src.wgs84 ? toWgs84 : (ll => ll);
  const ll = corners(zone, box).map(shift), M = ll.map(merc);
  const lat = (ll[0][1] + ll[2][1]) / 2;
  const mx0 = Math.min(...M.map(m => m[0])), mx1 = Math.max(...M.map(m => m[0]));
  const my0 = Math.min(...M.map(m => m[1])), my1 = Math.max(...M.map(m => m[1]));
  // Zoom level whose ground pixel matches the requested output pixel (capped by the source and canvas size).
  const groundPx = (box.xmax - box.xmin) / zoneUnitsPerMeter(zone) / W; // meters per output pixel
  let z = Math.ceil(Math.log2(2 * HALF * Math.cos(lat * Math.PI / 180) / 256 / groundPx));
  z = Math.max(10, Math.min(src.maxZ || 19, z));
  const res = zz => 2 * HALF / 256 / 2 ** zz;
  while (z > 10 && Math.max((mx1 - mx0) / res(z), (my1 - my0) / res(z)) > 8192) z--;
  const url = (zz, ty, tx) => src.tiles.replace('{z}', zz).replace('{y}', ty).replace('{x}', tx);
  const tAt = (zz, x, y) => [Math.floor((HALF - y) / (256 * res(zz))), Math.floor((x + HALF) / (256 * res(zz)))];
  // Step down past levels that don't exist here (checked on the centre tile).
  const cx = (mx0 + mx1) / 2, cy = (my0 + my1) / 2;
  for (let tries = 0; tries < 5 && z > 10; tries++, z--) {
    const [ty, tx] = tAt(z, cx, cy);
    const b = await tileBitmap(url(z, ty, tx), AbortSignal.timeout(15000)).catch(() => null);
    const ok = b && !isPlaceholder(b);
    b?.close?.();
    if (ok) break;
  }
  const rz = res(z);
  const [ty0, tx0] = tAt(z, mx0, my1), [ty1, tx1] = tAt(z, mx1, my0);
  const ox = tx0 * 256 * rz - HALF, oy = HALF - ty0 * 256 * rz; // NW corner of the tile block (mercator)
  const mc = document.createElement('canvas');
  mc.width = (tx1 - tx0 + 1) * 256; mc.height = (ty1 - ty0 + 1) * 256;
  const mg = mc.getContext('2d');
  const jobs = [];
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) jobs.push([ty, tx]);
  let done = 0, got = 0;
  const queue = jobs.slice();
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (queue.length) {
      const [ty, tx] = queue.shift();
      let b = null;
      for (let a = 0; a < 2 && !b; a++) b = await tileBitmap(url(z, ty, tx), AbortSignal.timeout(20000)).catch(() => null);
      if (b) { if (!isPlaceholder(b)) { mg.drawImage(b, (tx - tx0) * 256, (ty - ty0) * 256); got++; } b.close?.(); }
      onTile?.(++done, jobs.length);
    }
  }));
  if (got < jobs.length * 0.9) { mc.width = mc.height = 0; throw new Error(`${src.label}: tiles missing here`); }
  // Warp mercator -> State Plane output, piecewise affine on an 8×8 grid of cells (seam-free to well under a pixel).
  const out = document.createElement('canvas');
  out.width = W; out.height = H;
  const g = out.getContext('2d');
  g.imageSmoothingQuality = 'high';
  const p = projector(zone), w = box.xmax - box.xmin, h = box.ymax - box.ymin;
  const toM = (u, v) => { const [mX, mY] = merc(shift(p.inv([box.xmin + u / W * w, box.ymax - v / H * h]))); return [(mX - ox) / rz, (oy - mY) / rz]; };
  const N = 8;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const u0 = i * W / N, u1 = (i + 1) * W / N, v0 = j * H / N, v1 = (j + 1) * H / N;
    const A = toM(u0, v0), B = toM(u1, v0), C = toM(u0, v1);
    // out -> merc px: m = A + (u-u0)*du + (v-v0)*dv; invert for merc -> out.
    const du = [(B[0] - A[0]) / (u1 - u0), (B[1] - A[1]) / (u1 - u0)], dv = [(C[0] - A[0]) / (v1 - v0), (C[1] - A[1]) / (v1 - v0)];
    const det = du[0] * dv[1] - dv[0] * du[1];
    const ia = dv[1] / det, ib = -du[1] / det, ic = -dv[0] / det, id = du[0] / det; // inverse 2×2 (columns)
    g.save();
    g.beginPath(); g.rect(Math.floor(u0), Math.floor(v0), Math.ceil(u1) - Math.floor(u0) + 1, Math.ceil(v1) - Math.floor(v0) + 1); g.clip();
    // u = u0 + ia*(mx-A0) + ic*(my-A1); v = v0 + ib*(mx-A0) + id*(my-A1)
    g.setTransform(ia, ib, ic, id, u0 - ia * A[0] - ic * A[1], v0 - ib * A[0] - id * A[1]);
    g.drawImage(mc, 0, 0);
    g.restore();
  }
  mc.width = mc.height = 0;
  return out;
}
