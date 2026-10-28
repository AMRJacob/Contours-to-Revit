// Aerial imagery: picks the sharpest source for a site by looking at the pixels, then fetches the site box in its
// State Plane zone, grid north up, at a requested pixel size.
//
// Picking (probe):
//   1. Candidates = every catalog source (national + the enabled states) whose bounds touch the site, a custom
//      service if one is set, and — for the Arkansas composite — one candidate per flight under the site.
//   2. Coverage: five small samples (centre + four corners) from every candidate. A sample that is blank (white,
//      black, transparent or a flat grey "no data" tile), or noticeably emptier than the same spot from other
//      sources, means the source has no photos there or has a gap — it isn't used.
//   3. Detail: one 96 ft square at 1.5 in per pixel from every source that covered the site. Each sample is blurred
//      at growing scales; the scale where the blurring starts to remove real detail is the source's working
//      pixel size (calibrated in Little Rock: 3 in / 9 in / 1 ft / ~2 ft flights come out in that order).
//      A source is never credited finer than its published pixel size.
//   4. Order: sharpest first (sources within 10 % count as equal and the newer wins), or — with "prefer newer" —
//      the newest source that is at most 1.5× coarser than the sharpest.
//
// Fetching:
//   'map'   — ArcGIS MapServer /export, reprojected by the server straight into the State Plane zone
//   'image' — ArcGIS ImageServer /exportImage, same (optionally locked to one flight)
//   'tiles' — cached tiles: Web Mercator grids are stitched and warped here; a grid already in the site's State
//             Plane zone is stitched and cropped directly.
import { projector, zoneUnitsPerMeter } from './geo.js?v=0.52.0';
import { NATIONAL, STATES, STATE_LIST } from './imgcatalog.js?v=0.52.0';

export { STATE_LIST };

/** Every static source (for the Settings list and saved choices). */
export const IMAGERY_SOURCES = [...Object.values(STATES).flatMap(s => s.sources), ...NATIONAL];

const derived = new Map();   // composite flights found at sites so far, by id
export const sourceById = id => IMAGERY_SOURCES.find(s => s.id === id) || derived.get(id) || null;
/** Re-register a flight source (from a cached probe) so a saved choice of it resolves. */
export function registerSource(s) { if (s?.parent && !derived.has(s.id)) derived.set(s.id, s); return sourceById(s.id) || s; }

/** A pasted ArcGIS MapServer / ImageServer URL as a source. */
export function customSource(url) {
  const u = String(url || '').trim().replace(/\/+$/, '').replace(/\/(export|exportImage)$/i, '').replace(/\?.*$/, '');
  if (!/^https:\/\/.+\/(MapServer|ImageServer)$/i.test(u)) return null;
  return { id: 'custom', label: 'Custom service', kind: /ImageServer$/i.test(u) ? 'image' : 'map', url: u, year: null,
    credit: `Custom imagery service: ${u}`, publisher: 'your custom service' };
}

// ---- politeness: at most 4 requests at a time per server (a burst of probes got Esri to stop answering) ----
const hostQ = new Map();
function hfetch(url, opts) {
  const host = new URL(url).host;
  if (!hostQ.has(host)) hostQ.set(host, limiter(4));
  return hostQ.get(host)(() => fetch(url, opts));
}
/** Resolve with the promise, or reject after ms (the work itself is left to finish in the background). */
function deadline(p, ms, msg = 'too slow to answer') {
  let t;
  return Promise.race([p, new Promise((_, bad) => { t = setTimeout(() => bad(new Error(msg)), ms); })]).finally(() => clearTimeout(t));
}

/** Lon/lat corners of the box. */
function corners(zone, box) {
  const p = projector(zone);
  return [[box.xmin, box.ymin], [box.xmax, box.ymin], [box.xmax, box.ymax], [box.xmin, box.ymax]].map(c => p.inv(c));
}
const llBox = (zone, box) => {
  const c = corners(zone, box);
  return [Math.min(...c.map(p => p[0])), Math.min(...c.map(p => p[1])), Math.max(...c.map(p => p[0])), Math.max(...c.map(p => p[1]))];
};
const touches = (b, a) => !b || (a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1]);
/** True when the source's box touches the site (real coverage is checked from the pixels). */
export function covers(src, zone, box) { return touches(src.bounds, llBox(zone, box)); }

// ---------------------------------------------------------------- candidates

const flightCache = new Map();
/** Flights of a mosaic ImageServer under the site, each as its own source locked to that flight. */
async function flightsAt(src, ll) {
  const key = `${src.id}|${ll.map(v => v.toFixed(4)).join(',')}`;
  if (flightCache.has(key)) return flightCache.get(key);
  const p = new URLSearchParams({
    geometry: ll.join(','), geometryType: 'esriGeometryEnvelope', inSR: '4326', spatialRel: 'esriSpatialRelIntersects',
    where: 'Category=1', outFields: 'OBJECTID,Name,LowPS', returnGeometry: 'false', f: 'json',
  });
  const r = await hfetch(`${src.url}/query?${p}`, { signal: AbortSignal.timeout(20000) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || 'catalog query failed');
  const out = (j.features || []).map(f => f.attributes).filter(a => !(src.skipFlights && src.skipFlights.test(a.Name))).map(a => {
    const yr = (String(a.Name).match(/(19|20)\d\d/) || [])[0];
    const inches = a.LowPS > 0 ? a.LowPS / 0.0254 : null;   // the composite is in Web Mercator meters
    const nice = String(a.Name).replace(/_/g, ' ').replace(/^Cityof/i, 'City of ').replace(/\s+(19|20)\d\d$/, '').replace(/\s+/g, ' ').trim();
    const s = {
      id: `${src.id}-${a.OBJECTID}`, label: `${nice}${yr ? ` ${yr}` : ''} (state composite${inches ? `, ${fmtIn(inches)}` : ''})`,
      kind: 'image', url: src.url, year: yr ? Number(yr) : null, nativeIn: inches, bounds: src.bounds,
      params: { mosaicRule: JSON.stringify({ mosaicMethod: 'esriMosaicLockRaster', lockRasterIds: [a.OBJECTID] }) },
      credit: `${src.credit}: ${String(a.Name).replace(/_/g, ' ')}`, publisher: src.publisher, parent: src.id, state: src.state,
    };
    derived.set(s.id, s);
    return s;
  });
  flightCache.set(key, out);
  return out;
}

/**
 * Candidates for this site as [source, method] pairs.
 * states: enabled state codes; custom: a customSource() or null; includeAll: also sources with auto:false.
 */
export async function candidates(zone, box, { states = ['AR'], custom = null, includeAll = false } = {}) {
  const ll = llBox(zone, box);
  const out = [], notes = [];
  if (custom) out.push([custom, 'export']);
  for (const code of states) {
    const st = STATES[code];
    if (!st || !touches(st.bounds, ll)) continue;
    for (const s of st.sources) {
      if (!touches(s.bounds, ll) || (s.auto === false && !includeAll)) continue;
      if (s.flights) {
        try { for (const f of await flightsAt(s, ll)) out.push([f, 'export']); }
        catch (e) { notes.push(`${s.label}: ${e.message || 'catalog not available'}`); }
      } else {
        out.push([s, s.kind === 'tiles' ? 'tiles' : 'export']);
        // A map service's dynamic export can be blank at site scale (scale limits) while its tile cache is fine.
        if (s.kind === 'map' && s.cache !== false) out.push([s, 'tiles']);
      }
    }
  }
  for (const s of NATIONAL) {
    out.push([s, 'export']);
    if (s.tiles) out.push([s, 'tiles']);
  }
  return { list: out, notes };
}
export const candKey = (src, how) => `${src.id}:${how}`;

// ---------------------------------------------------------------- fetching

/**
 * Fetch the box at W×H pixels from one source. Returns a canvas, or throws.
 * opts: { tile (max request size), onTile(done, total), quick (fail fast — used while probing) }
 */
export async function fetchBox(src, how, zone, box, W, H, opts = {}) {
  if (how !== 'tiles') return fetchExport(src, zone, box, W, H, opts);
  if (src.tiles) return fetchTiles(src, src.tiles, src.maxZ || 19, zone, box, W, H, opts);
  const ti = await tileInfo(src);
  const wkid = ti.wkid === 102100 ? 3857 : ti.wkid;
  const tpl = `${src.url}/tile/{z}/{y}/{x}`;
  if (wkid === 3857) return fetchTiles(src, tpl, ti.maxZ, zone, box, W, H, opts);
  if (wkid === zone.code) return fetchTilesNative(src, ti, tpl, zone, box, W, H, opts);
  throw new Error(`its tile grid (EPSG:${wkid}) isn't this site's zone`);
}

const tiCache = new Map();
async function tileInfo(src) {
  if (!tiCache.has(src.url)) {
    tiCache.set(src.url, (async () => {
      const j = await hfetch(`${src.url}?f=json`, { signal: AbortSignal.timeout(15000) }).then(r => r.json());
      const t = j.tileInfo;
      if (!t?.lods?.length) throw new Error('no tile cache');
      const sr = t.spatialReference || j.spatialReference || {};
      return { wkid: sr.latestWkid || sr.wkid, origin: t.origin, rows: t.rows || 256, cols: t.cols || 256,
        lods: t.lods.slice().sort((a, b) => b.resolution - a.resolution), maxZ: Math.max(...t.lods.map(l => l.level)) };
    })().catch(e => { tiCache.delete(src.url); throw e; }));
  }
  return tiCache.get(src.url);
}

async function fetchExport(src, zone, box, W, H, { tile = 2048, onTile, quick } = {}) {
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
  let done = 0, failed = false, lastErr = '';
  const one = async ([i, j]) => {
    const px0 = i * tile, py0 = j * tile;
    const tw = Math.min(tile, W - px0), th = Math.min(tile, H - py0);
    // Tile bbox in native zone units; pixel rows count down from the north edge.
    const x0 = box.xmin + px0 / W * w, x1 = box.xmin + (px0 + tw) / W * w;
    const y1 = box.ymax - py0 / H * h, y0 = box.ymax - (py0 + th) / H * h;
    const params = new URLSearchParams({
      bbox: [x0 * toReq, y0 * toReq, x1 * toReq, y1 * toReq].join(','),
      bboxSR: String(zone.code), imageSR: String(zone.code), size: `${tw},${th}`, format: 'jpg', f: 'image',
      ...(src.params || {}),
    });
    if (src.kind === 'image') params.set('interpolation', 'RSP_BilinearInterpolation');
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        // A first failure on the first piece usually means the service can't do this at all: give up fast.
        const r = await hfetch(`${endpoint}?${params}`, { signal: AbortSignal.timeout(quick ? 20000 : done ? 60000 : 25000) });
        if (!r.ok || !(r.headers.get('content-type') || '').startsWith('image/')) throw new Error(`HTTP ${r.status}`);
        const bmp = await createImageBitmap(await r.blob());
        ctx.drawImage(bmp, px0, py0, tw, th);
        bmp.close?.();
        onTile?.(++done, jobs.length);
        return;
      } catch (e) {
        lastErr = e.name === 'TimeoutError' ? 'no response' : (e.message || 'failed');
        if ((!done || quick) && attempt >= 1) break;
        await new Promise(res => setTimeout(res, 700 * (attempt + 1)));
      }
    }
    failed = true;
  };
  // The first piece alone (fails fast if the service can't serve this place), then 4 at a time.
  await one(jobs.shift());
  const queue = jobs;
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => { while (!failed && queue.length) await one(queue.shift()); }));
  if (failed) { canvas.width = canvas.height = 0; throw new Error(lastErr || 'did not return imagery'); }
  return canvas;
}

// ---- tiles ----
const R = 6378137, HALF = Math.PI * R;
const merc = ([lon, lat]) => [lon * HALF / 180, Math.log(Math.tan((90 + lat) * Math.PI / 360)) * R];
/* global proj4 */
// NAD83 -> WGS84 (ITRF) shift, about 1 m in Arkansas — the same transformation ArcGIS applies when it reprojects
// WGS84 imagery into State Plane. Tiles of WGS84 sources are looked up at the shifted position. (Esri tiles
// warped this way matched Esri's own State Plane export within a pixel; without it they were ~1 m off.)
const NAD83_ITRF = '+proj=longlat +ellps=GRS80 +towgs84=-0.9956,1.9013,0.5215,0.025915,0.009426,0.011599,-0.00062 +no_defs';
const toWgs84 = ll => proj4(NAD83_ITRF, 'EPSG:4326', ll);

async function tileBitmap(url, signal) {
  const r = await hfetch(url, { signal });
  const ct = r.headers.get('content-type') || '';
  // Some hosted caches send images as application/octet-stream; anything that decodes is an image.
  if (!r.ok || /json|html|text/.test(ct)) return null;
  return createImageBitmap(await r.blob()).catch(() => null);
}
/**
 * Missing levels come back as placeholder tiles: flat, empty/transparent, or Esri's light grey "Map data not yet
 * available" (which has a few lines of text on it). Water is tinted, so it isn't mistaken for one.
 */
function isPlaceholder(bmp) {
  const n = 32, c = new OffscreenCanvas(n, n), g = c.getContext('2d');
  g.drawImage(bmp, 0, 0, n, n);
  const d = g.getImageData(0, 0, n, n).data;
  let mn = 255, mx = 0, a = 0;
  const hist = new Uint16Array(64);
  let neutral = 0;
  for (let i = 0; i < d.length; i += 4) {
    const v = (d[i] + d[i + 1] + d[i + 2]) / 3;
    mn = Math.min(mn, v); mx = Math.max(mx, v); a += d[i + 3];
    if (Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]) < 4 && v > 150) { neutral++; hist[v >> 2]++; }
  }
  if (mx - mn < 6 || a / (n * n) < 20) return true;
  // Mostly one light neutral grey (a little text allowed).
  let peak = 0;
  for (let i = 1; i < 63; i++) peak = Math.max(peak, hist[i - 1] + hist[i] + hist[i + 1]);
  return neutral > n * n * 0.8 && peak > n * n * 0.75;
}

async function fetchTiles(src, tpl, maxZ, zone, box, W, H, { onTile, quick } = {}) {
  const shift = src.wgs84 ? toWgs84 : (ll => ll);
  const ll = corners(zone, box).map(shift), M = ll.map(merc);
  const lat = (ll[0][1] + ll[2][1]) / 2;
  const mx0 = Math.min(...M.map(m => m[0])), mx1 = Math.max(...M.map(m => m[0]));
  const my0 = Math.min(...M.map(m => m[1])), my1 = Math.max(...M.map(m => m[1]));
  // Zoom level whose ground pixel matches the requested output pixel (capped by the source and canvas size).
  const groundPx = (box.xmax - box.xmin) / zoneUnitsPerMeter(zone) / W; // meters per output pixel
  let z = Math.ceil(Math.log2(2 * HALF * Math.cos(lat * Math.PI / 180) / 256 / groundPx));
  z = Math.max(10, Math.min(maxZ || 19, z));
  const res = zz => 2 * HALF / 256 / 2 ** zz;
  while (z > 10 && Math.max((mx1 - mx0) / res(z), (my1 - my0) / res(z)) > 8192) z--;
  const url = (zz, ty, tx) => tpl.replace('{z}', zz).replace('{y}', ty).replace('{x}', tx);
  const tAt = (zz, x, y) => [Math.floor((HALF - y) / (256 * res(zz))), Math.floor((x + HALF) / (256 * res(zz)))];
  // Step down past levels that don't exist here (checked on the centre tile).
  const cx = (mx0 + mx1) / 2, cy = (my0 + my1) / 2;
  let found = false;
  for (let tries = 0; tries < 7 && z > 10; tries++, z--) {
    const [ty, tx] = tAt(z, cx, cy);
    let netErr = false;
    const b = await tileBitmap(url(z, ty, tx), AbortSignal.timeout(quick ? 8000 : 15000)).catch(() => { netErr = true; return null; });
    if (netErr && quick) throw new Error('no response');
    const ok = b && !isPlaceholder(b);
    b?.close?.();
    if (ok) { found = true; break; }
  }
  if (!found) throw new Error('no tiles here');
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
      for (let a = 0; a < (quick ? 1 : 2) && !b; a++) b = await tileBitmap(url(z, ty, tx), AbortSignal.timeout(20000)).catch(() => null);
      if (b) { if (!isPlaceholder(b)) { mg.drawImage(b, (tx - tx0) * 256, (ty - ty0) * 256); got++; } b.close?.(); }
      onTile?.(++done, jobs.length);
    }
  }));
  if (got < jobs.length * 0.9) { mc.width = mc.height = 0; throw new Error('tiles missing here'); }
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

/** Tiles cached in the site's own State Plane zone: stitch and crop, no warping. */
async function fetchTilesNative(src, ti, tpl, zone, box, W, H, { onTile, quick } = {}) {
  const px = (box.xmax - box.xmin) / W;                      // zone units per output pixel
  const tw = ti.cols, th = ti.rows, o = ti.origin;
  // Finest level that isn't much finer than needed; coarser if the stitched block would get huge.
  let li = ti.lods.findIndex(l => l.resolution <= px * 1.4);
  if (li < 0) li = ti.lods.length - 1;
  const tAt = (l, x, y) => [Math.floor((o.y - y) / (th * l.resolution)), Math.floor((x - o.x) / (tw * l.resolution))];
  const url = (l, r, c) => tpl.replace('{z}', l.level).replace('{y}', r).replace('{x}', c);
  while (li > 0 && Math.max((box.xmax - box.xmin), (box.ymax - box.ymin)) / ti.lods[li].resolution > 8192) li--;
  const cx = (box.xmin + box.xmax) / 2, cy = (box.ymin + box.ymax) / 2;
  let found = false;
  for (let tries = 0; tries < 7 && li >= 0; tries++, li--) {
    const [r, c] = tAt(ti.lods[li], cx, cy);
    let netErr = false;
    const b = await tileBitmap(url(ti.lods[li], r, c), AbortSignal.timeout(quick ? 8000 : 15000)).catch(() => { netErr = true; return null; });
    if (netErr && quick) throw new Error('no response');
    const ok = b && !isPlaceholder(b);
    b?.close?.();
    if (ok) { found = true; break; }
  }
  if (!found) throw new Error('no tiles here');
  const L = ti.lods[li], res = L.resolution;
  const [r0, c0] = tAt(L, box.xmin, box.ymax), [r1, c1] = tAt(L, box.xmax, box.ymin);
  const mc = document.createElement('canvas');
  mc.width = (c1 - c0 + 1) * tw; mc.height = (r1 - r0 + 1) * th;
  const mg = mc.getContext('2d');
  const jobs = [];
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) jobs.push([r, c]);
  let done = 0, got = 0;
  const queue = jobs.slice();
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (queue.length) {
      const [r, c] = queue.shift();
      let b = null;
      for (let a = 0; a < (quick ? 1 : 2) && !b; a++) b = await tileBitmap(url(L, r, c), AbortSignal.timeout(20000)).catch(() => null);
      if (b) { if (!isPlaceholder(b)) { mg.drawImage(b, (c - c0) * tw, (r - r0) * th); got++; } b.close?.(); }
      onTile?.(++done, jobs.length);
    }
  }));
  if (got < jobs.length * 0.9) { mc.width = mc.height = 0; throw new Error('tiles missing here'); }
  const bx0 = o.x + c0 * tw * res, by0 = o.y - r0 * th * res;   // NW corner of the block
  const out = document.createElement('canvas');
  out.width = W; out.height = H;
  const g = out.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(mc, (box.xmin - bx0) / res, (by0 - box.ymax) / res, (box.xmax - box.xmin) / res, (box.ymax - box.ymin) / res, 0, 0, W, H);
  mc.width = mc.height = 0;
  return out;
}

// ---------------------------------------------------------------- looking at the pixels

/**
 * Share of the image with no photo: 8×8 blocks (on a 64×64 copy) that are transparent, flat white/black,
 * or flat light neutral grey (Esri's "not available" tile). Calm water can be flat and fairly neutral but is
 * darker than that, so it isn't counted.
 */
export function emptyFraction(img) {
  const n = 64, c = new OffscreenCanvas(n, n), g = c.getContext('2d');
  g.drawImage(img, 0, 0, n, n);
  const d = g.getImageData(0, 0, n, n).data;
  let empty = 0;
  for (let by = 0; by < n; by += 8) for (let bx = 0; bx < n; bx += 8) {
    let s = 0, s2 = 0, a = 0, tint = 0;
    for (let y = by; y < by + 8; y++) for (let x = bx; x < bx + 8; x++) {
      const i = 4 * (y * n + x), v = (d[i] + d[i + 1] + d[i + 2]) / 3;
      s += v; s2 += v * v; a += d[i + 3];
      tint += Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]);
    }
    const m = s / 64, sd = Math.sqrt(Math.max(0, s2 / 64 - m * m));
    if (a / 64 < 20 || (sd < 2.5 && (m > 235 || m < 12)) || (sd < 1.5 && tint / 64 < 2 && m > 160)) empty++;
  }
  return empty / 64;
}

/** Mean gradient — how much texture a sample has (used to pick the spot for the detail check). */
function texture(img) {
  const n = 96, c = new OffscreenCanvas(n, n), g = c.getContext('2d');
  g.drawImage(img, 0, 0, n, n);
  const d = g.getImageData(0, 0, n, n).data;
  const L = i => d[4 * i] * 0.299 + d[4 * i + 1] * 0.587 + d[4 * i + 2] * 0.114;
  let s = 0;
  for (let y = 0; y < n - 1; y++) for (let x = 0; x < n - 1; x++) { const i = y * n + x; s += Math.abs(L(i) - L(i + 1)) + Math.abs(L(i) - L(i + n)); }
  return s / ((n - 1) * (n - 1));
}

const SCALES = [1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48];
function grayOf(src, n) {
  const c = new OffscreenCanvas(n, n), g = c.getContext('2d');
  g.drawImage(src, 0, 0, n, n);
  const d = g.getImageData(0, 0, n, n).data, o = new Float32Array(n * n);
  for (let i = 0; i < o.length; i++) o[i] = 0.299 * d[4 * i] + 0.587 * d[4 * i + 1] + 0.114 * d[4 * i + 2];
  return [o, c];
}
/**
 * Working pixel size of a sample, in sample pixels: blur it at growing scales (shrink, then enlarge back) and find
 * where the loss has climbed 15 % of the way from the fine-scale floor (noise, JPEG) to the loss at 48 px. Returns null if the sample has too little texture to judge (water, an empty field).
 */
export function detailPx(img) {
  const N = img.width;
  const [G, c] = grayOf(img, N);
  const e = {};
  for (const k of SCALES) {
    const m = Math.max(4, Math.round(N / k));
    const d = new OffscreenCanvas(m, m), dg = d.getContext('2d');
    dg.imageSmoothingQuality = 'high';
    dg.drawImage(c, 0, 0, m, m);
    const [U] = grayOf(d, N);
    let s = 0;
    for (let i = 0; i < G.length; i++) { const x = G[i] - U[i]; s += x * x; }
    e[k] = Math.sqrt(s / G.length);
  }
  const ref = e[48];
  if (ref < 2) return null;
  const n = SCALES.map(k => e[k] / ref);
  const t = n[0] + 0.15 * (1 - n[0]);
  for (let i = 1; i < SCALES.length; i++) {
    if (n[i] >= t) { const a = (t - n[i - 1]) / ((n[i] - n[i - 1]) || 1); return SCALES[i - 1] + a * (SCALES[i] - SCALES[i - 1]); }
  }
  return 48;
}

export const fmtIn = v => v == null ? '—' : v < 11.5 ? `${(Math.round(v * 2) / 2).toString().replace(/\.0$/, '')} in` : `${(v / 12).toFixed(1).replace(/\.0$/, '')} ft`;

/** Run tasks with at most `n` at a time. */
function limiter(n) {
  let active = 0;
  const q = [];
  const next = () => { if (active >= n || !q.length) return; active++; const [f, ok, bad] = q.shift(); f().then(ok, bad).finally(() => { active--; next(); }); };
  return f => new Promise((ok, bad) => { q.push([f, ok, bad]); next(); });
}

/**
 * Wait for every task, but stop waiting for stragglers once at least one has finished, `minMs` have passed and
 * nothing has finished for `quietMs`. Rows still running are marked too slow (their late answers are ignored).
 */
async function settle(tasks, rows, { minMs = 6000, quietMs = 4000 } = {}) {
  const t0 = performance.now();
  let last = t0, finished = 0;
  const all = tasks.map((t, i) => t.finally(() => { rows[i].done = true; finished++; last = performance.now(); }));
  await Promise.race([
    Promise.allSettled(all),
    new Promise(res => {
      const tick = setInterval(() => {
        const now = performance.now();
        if (finished && now - t0 > minMs && now - last > quietMs) { clearInterval(tick); res(); }
      }, 250);
      Promise.allSettled(all).then(() => { clearInterval(tick); res(); });
    }),
  ]);
  for (const r of rows) if (!r.done) { r.status = 'error'; r.why = 'too slow to answer'; r.late = true; }
  for (const r of rows) delete r.done;
}

/**
 * Check every candidate at the site. Returns { results, order, sampleIn, window }.
 * results: [{ key, src, how, status: 'ok'|'gaps'|'none'|'error', why, measuredIn, nativeIn, effIn, year, ms }]
 * order:   usable [src, how] pairs, best first (see rank()).
 */
export async function probe(zone, box, cands, { prefer = 'sharp', onProgress } = {}) {
  const perFt = zoneUnitsPerMeter(zone) * 0.3048;
  const w = box.xmax - box.xmin, h = box.ymax - box.ymin;
  const side = Math.min(Math.max(Math.min(w, h) * 0.14, 60 * perFt), 400 * perFt, w, h);
  const cx = (box.xmin + box.xmax) / 2, cy = (box.ymin + box.ymax) / 2;
  const ins = (lo, hi) => [lo + side / 2 + Math.min(w, h) * 0.03, hi - side / 2 - Math.min(w, h) * 0.03];
  const [x0, x1] = ins(box.xmin, box.xmax), [y0, y1] = ins(box.ymin, box.ymax);
  const centres = [[cx, cy]];
  if (x1 - x0 > side * 0.5 && y1 - y0 > side * 0.5) centres.push([x0, y0], [x1, y0], [x1, y1], [x0, y1]);
  const winBox = ([x, y], s) => ({ xmin: x - s / 2, xmax: x + s / 2, ymin: y - s / 2, ymax: y + s / 2 });
  const run = limiter(8);
  let done = 0, stage1Over = false, stage2Over = false;   // late stragglers must not report progress
  const total = cands.length;
  const results = cands.map(([src, how]) => ({ key: candKey(src, how), src, how, status: 'ok', why: '', empty: [], tex: [],
    measuredIn: null, nativeIn: src.nativeIn || null, effIn: null, year: src.year ?? null, ms: 0 }));

  // 1. Coverage: centre first (a source that fails there is dropped right away), then the corners.
  await settle(results.map(async r => {
    const t0 = performance.now();
    for (let i = 0; i < centres.length && r.status === 'ok' && !r.late; i++) {
      try {
        const cv = await run(() => deadline(fetchBox(r.src, r.how, zone, winBox(centres[i], side), 160, 160, { quick: true }), 20000));
        if (r.late) return;
        r.empty[i] = emptyFraction(cv);
        r.tex[i] = texture(cv);
        cv.width = cv.height = 0;
        if (r.empty[i] > 0.5) { r.status = i ? 'gaps' : 'none'; r.why = i ? 'no photos over part of the site' : 'no photos here (blank image)'; }
      } catch (e) {
        if (!r.late) { r.status = 'error'; r.why = e.message || 'failed'; }
      }
    }
    r.ms = Math.round(performance.now() - t0);
    if (!stage1Over) onProgress?.(++done, total, 'coverage');
  }), results, { minMs: 10000 });
  stage1Over = true;
  // A spot that is clearly emptier than the same spot from another source is a gap in this source (white roofs
  // and bright pavement look the same from every source, so they don't count against anyone).
  for (let i = 0; i < centres.length; i++) {
    const vals = results.filter(r => r.status === 'ok' && r.empty[i] != null).map(r => r.empty[i]);
    const best = vals.length ? Math.min(...vals) : 0;
    for (const r of results) if (r.status === 'ok' && r.empty[i] > 0.25 && r.empty[i] - best > 0.2) { r.status = 'gaps'; r.why = 'gaps in its coverage here'; }
  }

  // 2. Detail, at the corner/centre spot with the most texture.
  const ok = results.filter(r => r.status === 'ok');
  let wi = 0, bestTex = -1;
  for (let i = 0; i < centres.length; i++) {
    const t = ok.map(r => r.tex[i]).filter(v => v != null).sort((a, b) => a - b);
    const med = t.length ? t[t.length >> 1] : 0;
    if (med > bestTex) { bestTex = med; wi = i; }
  }
  const dSide = Math.min(96 * perFt, w, h);
  let [dx, dy] = centres[wi];
  dx = Math.min(Math.max(dx, box.xmin + dSide / 2), box.xmax - dSide / 2);
  dy = Math.min(Math.max(dy, box.ymin + dSide / 2), box.ymax - dSide / 2);
  const DN = 768, sampleIn = dSide / perFt * 12 / DN;
  done = 0;
  await settle(ok.map(async r => {
    try {
      const cv = await run(() => deadline(fetchBox(r.src, r.how, zone, winBox([dx, dy], dSide), DN, DN, { quick: true }), 15000));
      if (r.late) return;
      if (emptyFraction(cv) > 0.3) { r.status = 'gaps'; r.why = 'gaps in its coverage here'; }
      else { const k = detailPx(cv); r.measuredIn = k == null ? null : k * sampleIn; }
      cv.width = cv.height = 0;
    } catch (e) { if (!r.late) { r.status = 'error'; r.why = e.message || 'failed'; } }
    if (!stage2Over) onProgress?.(++done, ok.length, 'detail');
  }), ok, { minMs: 4000 });
  stage2Over = true;
  for (const r of results) r.effIn = r.measuredIn == null ? r.nativeIn : Math.max(r.measuredIn, r.nativeIn || 0);
  for (const r of results) { delete r.empty; delete r.tex; delete r.late; }
  // A map service tried through a tile cache it doesn't have isn't worth listing.
  for (let i = results.length - 1; i >= 0; i--) if (results[i].status === 'error' && /no tile cache|isn't this site's zone/.test(results[i].why) && results[i].src.kind !== 'tiles') results.splice(i, 1);
  return { results, order: rank(results, prefer), sampleIn, window: { x: dx, y: dy, side: dSide } };
}

/** Usable candidates, best first. prefer: 'sharp' (default) or 'new'. */
export function rank(results, prefer = 'sharp') {
  const ok = results.filter(r => r.status === 'ok');
  const eff = r => r.effIn ?? 999, yr = r => r.year ?? 0;
  ok.sort((a, b) => {
    const ea = eff(a), eb = eff(b);
    if (Math.abs(ea - eb) <= 0.1 * Math.min(ea, eb)) return yr(b) - yr(a) || ea - eb;   // equal detail: newer first
    return ea - eb;
  });
  if (prefer === 'new' && ok.length > 1) {
    const lim = eff(ok[0]) * 1.5;
    const pool = ok.filter(r => eff(r) <= lim).sort((a, b) => yr(b) - yr(a) || eff(a) - eff(b));
    const rest = ok.filter(r => !pool.includes(r));
    return [...pool, ...rest].map(r => [r.src, r.how]);
  }
  return ok.map(r => [r.src, r.how]);
}
