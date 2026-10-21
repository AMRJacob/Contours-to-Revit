// Contours to Revit — building heights and roof shapes from USGS 3DEP lidar.
// Point clouds are read straight from the public USGS Entwine (EPT) copy on AWS (usgs-lidar-public), decoded in
// the browser with laz-perf (WASM), and turned into a roof surface per footprint. Heights are measured against the
// lidar's own ground points next to each building, so the lidar's vertical datum never matters.

const RESOURCES = 'https://raw.githubusercontent.com/hobuinc/usgs-lidar/master/boundaries/resources.geojson';
const R_EARTH = 6378137;
const GROUND = 2, BUILDING = 6, NOISE = new Set([7, 18]);

let resourcesP = null;
let lazP = null;
let delaunayP = null;

function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.onload = () => res(); s.onerror = () => rej(new Error(`couldn't load ${src}`));
    document.head.append(s);
  });
}
const libBase = () => new URL('lib/', document.baseURI).href;
function laz() {
  lazP ??= loadScript(libBase() + 'laz-perf/laz-perf.js').then(() => window.createLazPerf({ locateFile: f => libBase() + 'laz-perf/' + f }));
  return lazP;
}
function delaunator() {
  delaunayP ??= loadScript(libBase() + 'delaunator.min.js').then(() => window.Delaunator);
  return delaunayP;
}

const toMerc = (lon, lat) => [lon * Math.PI / 180 * R_EARTH, Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)) * R_EARTH];
const fromMerc = (x, y) => [x / R_EARTH * 180 / Math.PI, (2 * Math.atan(Math.exp(y / R_EARTH)) - Math.PI / 2) * 180 / Math.PI];
const yearOf = name => Math.max(0, ...(String(name).match(/(19|20)\d{2}/g) || []).map(Number));
/** Collection year as named (first year in the name; a second one is usually the delivery year). */
const flownOf = name => Number((String(name).match(/(19|20)\d{2}/) || [0])[0]);

function inRing(r, x, y) {
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
  }
  return c;
}

/** Lidar collections covering a lon/lat point, newest first. */
async function collectionsAt(lon, lat) {
  resourcesP ??= fetch(RESOURCES).then(r => { if (!r.ok) throw new Error(`lidar index HTTP ${r.status}`); return r.json(); });
  const gj = await resourcesP.catch(e => { resourcesP = null; throw e; });
  const hits = [];
  for (const f of gj.features || []) {
    const g = f.geometry; if (!g) continue;
    const polys = g.type === 'MultiPolygon' ? g.coordinates : g.type === 'Polygon' ? [g.coordinates] : [];
    if (polys.some(p => inRing(p[0], lon, lat) && !p.slice(1).some(h => inRing(h, lon, lat)))) hits.push(f.properties);
  }
  return hits.sort((a, b) => yearOf(b.name) - yearOf(a.name));
}

/** Read every EPT node overlapping the bbox (EPSG:3857). Returns typed arrays of points inside it. */
async function readEpt(url, [x0, y0, x1, y1], onStatus) {
  const base = url.replace(/ept\.json$/, '');
  const ept = await (await fetch(url)).json();
  if (ept.dataType !== 'laszip') throw new Error(`unsupported lidar format ${ept.dataType}`);
  const B = ept.bounds;
  const nodeBox = key => {
    const [d, x, y] = key.split('-').map(Number);
    const sx = (B[3] - B[0]) / 2 ** d, sy = (B[4] - B[1]) / 2 ** d;
    return [B[0] + x * sx, B[1] + y * sy, B[0] + (x + 1) * sx, B[1] + (y + 1) * sy];
  };
  const hits = k => { const b = nodeBox(k); return !(b[2] < x0 || b[0] > x1 || b[3] < y0 || b[1] > y1); };
  // Hierarchy: -1 marks a subtree stored in its own file.
  const nodes = [];
  let pending = ['0-0-0-0'];
  while (pending.length) {
    const files = await Promise.all(pending.map(k => fetch(`${base}ept-hierarchy/${k}.json`).then(r => r.json())));
    pending = [];
    for (const h of files) for (const [k, v] of Object.entries(h)) {
      if (!hits(k)) continue;
      if (v === -1) pending.push(k); else if (v > 0) nodes.push(k);
    }
  }
  const L = await laz();
  const xs = [], ys = [], zs = [], cs = [];
  let done = 0, bytes = 0;
  const one = async key => {
    const buf = await (await fetch(`${base}ept-data/${key}.laz`)).arrayBuffer();
    bytes += buf.byteLength;
    decode(L, buf, x0, y0, x1, y1, xs, ys, zs, cs);
    done++;
    onStatus?.(`Reading lidar — ${done} of ${nodes.length} tiles (${(bytes / 1e6).toFixed(0)} MB)…`);
  };
  // A few downloads at a time.
  const queue = nodes.slice();
  await Promise.all(Array.from({ length: 6 }, async () => { while (queue.length) await one(queue.shift()); }));
  return { x: Float64Array.from(xs), y: Float64Array.from(ys), z: Float32Array.from(zs), c: Uint8Array.from(cs), bytes, nodes: nodes.length };
}

function decode(L, buf, x0, y0, x1, y1, xs, ys, zs, cs) {
  const dv = new DataView(buf);
  const sx = dv.getFloat64(131, true), sy = dv.getFloat64(139, true), sz = dv.getFloat64(147, true);
  const ox = dv.getFloat64(155, true), oy = dv.getFloat64(163, true), oz = dv.getFloat64(171, true);
  const u8 = new Uint8Array(buf);
  const fp = L._malloc(u8.length);
  L.HEAPU8.set(u8, fp);
  const lz = new L.LASZip();
  try {
    lz.open(fp, u8.length);
    const n = lz.getCount(), len = lz.getPointLength(), fmt = lz.getPointFormat();
    const pp = L._malloc(len);
    try {
      for (let i = 0; i < n; i++) {
        lz.getPoint(pp);
        const v = new DataView(L.HEAPU8.buffer, pp, len);
        const x = v.getInt32(0, true) * sx + ox, y = v.getInt32(4, true) * sy + oy;
        if (x < x0 || x > x1 || y < y0 || y > y1) continue;
        const c = fmt >= 6 ? v.getUint8(16) : v.getUint8(15) & 31;
        if (NOISE.has(c)) continue;
        xs.push(x); ys.push(y); zs.push(v.getInt32(8, true) * sz + oz); cs.push(c);
      }
    } finally { L._free(pp); }
  } finally { lz.delete(); L._free(fp); }
}

/**
 * Load lidar for a site. bbox = [w, s, e, n] lon/lat. fwd: [lon, lat] → native zone XY.
 * Returns { name, year, n, hasBuildingClass, x, y (native), z (m), c } or throws.
 */
export async function loadLidar(bbox, fwd, onStatus) {
  const [w, s, e, n] = bbox;
  onStatus?.('Finding lidar for this site…');
  const cols = await collectionsAt((w + e) / 2, (s + n) / 2);
  if (!cols.length) throw new Error('no USGS lidar covers this site');
  const [mx0, my0] = toMerc(w, s), [mx1, my1] = toMerc(e, n);
  let pc = null, used = null;
  for (const col of cols.slice(0, 3)) {
    try {
      onStatus?.(`Reading lidar — ${col.name}…`);
      pc = await readEpt(col.url, [mx0, my0, mx1, my1], onStatus);
      if (pc.x.length > 100) { used = col; break; }
    } catch (err) { console.warn('lidar', col.name, err); }
  }
  if (!used) throw new Error('the lidar for this site could not be read');
  onStatus?.(`Placing ${pc.x.length.toLocaleString()} lidar points…`);
  const X = new Float64Array(pc.x.length), Y = new Float64Array(pc.x.length);
  let hasB = false;
  for (let i = 0; i < pc.x.length; i++) {
    const [lon, lat] = fromMerc(pc.x[i], pc.y[i]);
    const [px, py] = fwd([lon, lat]);
    X[i] = px; Y[i] = py;
    if (pc.c[i] === BUILDING) hasB = true;
  }
  return { name: used.name, year: flownOf(used.name), n: pc.x.length, mb: pc.bytes / 1e6, hasBuildingClass: hasB, x: X, y: Y, z: pc.z, c: pc.c };
}

/** Points bucketed on a coarse grid (native units) for neighbourhood lookups. */
function bucket(lid, cell) {
  const map = new Map();
  for (let i = 0; i < lid.n; i++) {
    const k = Math.floor(lid.x[i] / cell) + ':' + Math.floor(lid.y[i] / cell);
    let a = map.get(k); if (!a) map.set(k, a = []); a.push(i);
  }
  return { map, cell, near(x0, y0, x1, y1, fn) {
    for (let gx = Math.floor(x0 / cell); gx <= Math.floor(x1 / cell); gx++) for (let gy = Math.floor(y0 / cell); gy <= Math.floor(y1 / cell); gy++) {
      const a = map.get(gx + ':' + gy); if (a) for (const i of a) fn(i);
    }
  } };
}

const median = a => { if (!a.length) return NaN; const s = Float64Array.from(a).sort(); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const pct = (a, p) => { if (!a.length) return NaN; const s = Float64Array.from(a).sort(); return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))]; };

/**
 * Give footprints lidar heights and roof surfaces. Mutates each building that has enough lidar on it:
 *   top, heightKnown, hSrc = 'lidar', roofType ('flat' | 'shaped' = pitched or stepped), roof = { pts: [[x,y,z]], tris: [[a,b,c]] },
 *   ringTop (roof height at each footprint corner, for the walls), roofAt(x, y).
 * Others are left as they were (their dataset height, or the assumed one). Returns counts.
 * opts: { zAt (native → output Z, the site's DEM), zPerM (m → output), nativePerM }.
 */
export async function applyLidar(list, lid, { zAt, zPerM, nativePerM, cellFt = 5 }) {
  const D = await delaunator();
  const m = nativePerM;                       // native units per metre
  const idx = lid._idx ??= bucket(lid, 10 * m);
  const cellM = Math.max(0.25, cellFt * 0.3048), cell = cellM * m;
  const fine = cellM < 1.2;                                // finer than the lidar's point spacing: interpolate
  let used = 0, flat = 0, shaped = 0, skipped = 0;
  for (const b of list) {
    const R = b.ring;
    if (!R || R.length < 3) { skipped++; continue; }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of R) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    let area = 0; for (let i = 0, k = R.length - 1; i < R.length; k = i++) area += (R[k][0] + R[i][0]) * (R[k][1] - R[i][1]);
    const areaM2 = Math.abs(area) / 2 / (m * m);
    // Ground next to the building (lidar ground class within 8 m outside the footprint) and the DEM there.
    const pad = 8 * m, gl = [], gd = [], pin = [];
    idx.near(x0 - pad, y0 - pad, x1 + pad, y1 + pad, i => {
      const x = lid.x[i], y = lid.y[i];
      if (x < x0 - pad || x > x1 + pad || y < y0 - pad || y > y1 + pad) return;
      const inside = inRing(R, x, y);
      if (lid.c[i] === GROUND && !inside) { gl.push(lid.z[i]); if (gd.length < 60 && gl.length % 3 === 1) gd.push(zAt(x, y)); }
      else if (inside && lid.c[i] !== GROUND && (!lid.hasBuildingClass || lid.c[i] === BUILDING)) pin.push(i);
    });
    const g = median(gl), gDem = median(gd.filter(Number.isFinite));
    if (gl.length < 5 || !Number.isFinite(gDem)) { skipped++; continue; }
    const pts = pin.filter(i => lid.z[i] - g > 1.5);
    if (pts.length < Math.max(6, areaM2 * 0.2)) { skipped++; continue; } // too few returns: new building, or no coverage
    // Roof raster. Coarse cells: highest return per cell. Fine cells (smaller than the point spacing): a TIN
    // through the returns, sampled at each cell centre. Then a 3×3 median drops spikes, and holes are filled.
    const nx = Math.max(1, Math.ceil((x1 - x0) / cell)), ny = Math.max(1, Math.ceil((y1 - y0) / cell));
    const top = new Float32Array(nx * ny).fill(NaN);
    if (!fine) {
      for (const i of pts) {
        const cx = Math.min(nx - 1, Math.floor((lid.x[i] - x0) / cell)), cy = Math.min(ny - 1, Math.floor((lid.y[i] - y0) / cell));
        const h = lid.z[i] - g, q = cy * nx + cx;
        if (!(top[q] >= h)) top[q] = h;
      }
    } else {
      const px = pts.map(i => lid.x[i]), py = pts.map(i => lid.y[i]), ph = pts.map(i => lid.z[i] - g);
      const tin = D.from(pts.map((_, k) => [px[k], py[k]]));
      const maxEdge = 4 * m; // longer triangles bridge gaps (courtyards, missing returns): leave those to the fill
      const T = tin.triangles;
      for (let t = 0; t < T.length; t += 3) {
        const a = T[t], b2 = T[t + 1], c = T[t + 2];
        const ax = px[a], ay = py[a], bx = px[b2], by = py[b2], cx2 = px[c], cy2 = py[c];
        if (Math.hypot(bx - ax, by - ay) > maxEdge || Math.hypot(cx2 - bx, cy2 - by) > maxEdge || Math.hypot(ax - cx2, ay - cy2) > maxEdge) continue;
        const det = (by - cy2) * (ax - cx2) + (cx2 - bx) * (ay - cy2);
        if (Math.abs(det) < 1e-12) continue;
        const i0 = Math.max(0, Math.floor((Math.min(ax, bx, cx2) - x0) / cell - 0.5)), i1 = Math.min(nx - 1, Math.ceil((Math.max(ax, bx, cx2) - x0) / cell - 0.5));
        const j0 = Math.max(0, Math.floor((Math.min(ay, by, cy2) - y0) / cell - 0.5)), j1 = Math.min(ny - 1, Math.ceil((Math.max(ay, by, cy2) - y0) / cell - 0.5));
        for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
          const x = x0 + (i + 0.5) * cell, y = y0 + (j + 0.5) * cell;
          const l1 = ((by - cy2) * (x - cx2) + (cx2 - bx) * (y - cy2)) / det, l2 = ((cy2 - ay) * (x - cx2) + (ax - cx2) * (y - cy2)) / det, l3 = 1 - l1 - l2;
          if (l1 < -1e-9 || l2 < -1e-9 || l3 < -1e-9) continue;
          top[j * nx + i] = l1 * ph[a] + l2 * ph[b2] + l3 * ph[c];
        }
      }
    }
    const sm = new Float32Array(nx * ny).fill(NaN);
    for (let cy = 0; cy < ny; cy++) for (let cx = 0; cx < nx; cx++) {
      const v = [];
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const a = cx + dx, c = cy + dy;
        if (a >= 0 && a < nx && c >= 0 && c < ny && Number.isFinite(top[c * nx + a])) v.push(top[c * nx + a]);
      }
      if (v.length >= 3) sm[cy * nx + cx] = median(v);
      else if (Number.isFinite(top[cy * nx + cx])) sm[cy * nx + cx] = top[cy * nx + cx];
    }
    if (fine) {
      // Interpolated fine grids carry the returns' noise (equipment, trees, scan jitter): one more 3×3 median.
      const sm2 = sm.slice();
      for (let cy = 0; cy < ny; cy++) for (let cx = 0; cx < nx; cx++) {
        const v = [];
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const a = cx + dx, c = cy + dy;
          if (a >= 0 && a < nx && c >= 0 && c < ny && Number.isFinite(sm[c * nx + a])) v.push(sm[c * nx + a]);
        }
        if (v.length >= 5) sm2[cy * nx + cx] = median(v);
      }
      sm.set(sm2);
    }
    const vals = [...sm].filter(Number.isFinite);
    const med = median(vals);
    for (let pass = 0; pass < (fine ? 40 : 12); pass++) {
      let left = 0;
      for (let q = 0; q < sm.length; q++) {
        if (Number.isFinite(sm[q])) continue;
        const cx = q % nx, cy = (q / nx) | 0; let s = 0, k = 0;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const a = cx + dx, c = cy + dy;
          if (a >= 0 && a < nx && c >= 0 && c < ny && Number.isFinite(sm[c * nx + a])) { s += sm[c * nx + a]; k++; }
        }
        if (k) sm[q] = s / k; else left++;
      }
      if (!left) break;
    }
    for (let q = 0; q < sm.length; q++) if (!Number.isFinite(sm[q])) sm[q] = med;
    // Buildings are made of flat decks and flat roof planes. Fit planes to the roof, give every roof cell its
    // plane, then build the massing as clean blocks: one prism per plane region (outline traced from the cells and
    // straightened), topped by its exact plane, standing on a base block that is the footprint itself.
    const inFp = (cx, cy) => inRing(R, x0 + (cx + 0.5) * cell, y0 + (cy + 0.5) * cell);
    const reg = regularize(sm, nx, ny, cell / m, inFp);
    const zOf = h => gDem + h * zPerM;       // roof elevation in output units
    const roofH = [];
    for (let cy = 0; cy < ny; cy++) for (let cx = 0; cx < nx; cx++) if (inFp(cx, cy)) roofH.push(sm[cy * nx + cx]);
    if (!roofH.length) { skipped++; continue; }
    const lo = pct(roofH, 0.1), hi = pct(roofH, 0.9);
    const isFlat = hi - lo < 0.8 || !reg.planes.length;
    const v = [], f = [];                    // vertices [x, y, z] (native XY, output Z) and faces (index lists)
    const add = (x, y, z) => { v.push([x, y, z]); return v.length - 1; };
    const prism = (ring, topZ, roofTris) => {
      // Walls from the ground (b.base) to the roof edge, the roof, and the bottom.
      const n = ring.length, bot = ring.map(([x, y]) => add(x, y, b.base)), top = ring.map(([x, y], i) => add(x, y, topZ[i]));
      for (let i = 0; i < n; i++) { const j = (i + 1) % n; f.push([bot[i], bot[j], top[j], top[i]]); }
      for (const [a, c, d] of roofTris) f.push([top[a], top[c], top[d]]);
      for (const [a, c, d] of roofTris) f.push([bot[d], bot[c], bot[a]]);
    };
    let topMax = -Infinity;
    if (isFlat) {
      const z = zOf(pct(roofH, 0.6));
      prism(R, R.map(() => z), polyTris(R, D, (x, y) => inRing(R, x, y)));
      topMax = z;
    } else {
      // Base block: the exact footprint up to the lowest roof level, so traced outlines never leave gaps.
      const zb = zOf(pct(roofH, 0.03));
      prism(R, R.map(() => zb), polyTris(R, D, (x, y) => inRing(R, x, y)));
      for (let li = 0; li < reg.planes.length; li++) {
        const pl = reg.planes[li];
        const mask = (cx, cy) => cx >= 0 && cy >= 0 && cx < nx && cy < ny && reg.lab[cy * nx + cx] === li;
        for (let ring of traceMask(mask, nx, ny)) {
          if (ring.length < 3) continue;
          ring = simplifyRing(ring, 0.9);                         // in cell units
          if (ring.length < 3) continue;
          const pts = ring.map(([i, j]) => [x0 + i * cell, y0 + j * cell]);
          const zAtPl = ([x, y]) => zOf(pl[0] * (x - x0) / m + pl[1] * (y - y0) / m + pl[2]);
          const inside = (x, y) => { const cx = Math.floor((x - x0) / cell), cy = Math.floor((y - y0) / cell); return mask(cx, cy); };
          const tris = polyTris(pts, D, inside);
          if (!tris.length) continue;
          const tz = pts.map(zAtPl);
          prism(pts, tz, tris);
          topMax = Math.max(topMax, ...tz);
        }
      }
      topMax = Math.max(topMax, zb);
    }
    if (!f.length) { skipped++; continue; }
    const labAt = (x, y) => { const cx = Math.floor((x - x0) / cell), cy = Math.floor((y - y0) / cell); return cx >= 0 && cy >= 0 && cx < nx && cy < ny ? reg.lab[cy * nx + cx] : -1; };
    const flatZ = zOf(pct(roofH, 0.6));
    b.mass = { v, f };
    b.roofAt = isFlat ? () => flatZ : (x, y) => { const l = labAt(x, y), pl = reg.planes[l]; return pl ? zOf(pl[0] * (x - x0) / m + pl[1] * (y - y0) / m + pl[2]) : zOf(pct(roofH, 0.03)); };
    b.roofType = isFlat ? 'flat' : 'shaped';
    b.roofPlanes = reg.planes.length;
    b.top = topMax;
    b.heightKnown = true;
    b.hSrc = 'lidar';
    used++; if (isFlat) flat++; else shaped++;
  }
  return { used, flat, shaped, skipped };
}

/**
 * Snap a roof raster (metres) to planes. Sequential RANSAC finds up to 10 planes (each must carry ≥ 3 % of the
 * roof); nearly level ones (< 4°) become exactly level at their median height. Each roof cell then takes the
 * height of the plane it fits best (within 0.6 m; others keep their measured height), and a 3×3 majority vote
 * cleans ragged plane borders. Mutates h. Returns the number of planes.
 */
function regularize(h, nx, ny, cellM, isInside) {
  const cells = [];
  for (let cy = 0; cy < ny; cy++) for (let cx = 0; cx < nx; cx++) if (isInside(cx, cy) && Number.isFinite(h[cy * nx + cx])) cells.push(cy * nx + cx);
  if (cells.length < 12) return { planes: [], lab: new Int16Array(nx * ny).fill(-1) };
  const X = q => (q % nx) * cellM, Y = q => ((q / nx) | 0) * cellM;
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const TH = 0.25, minSup = Math.max(8, Math.round(cells.length * 0.03));
  const planes = [];
  let rest = cells.slice();
  for (let k = 0; k < 10 && rest.length >= minSup; k++) {
    const sample = rest.length > 3000 ? Array.from({ length: 3000 }, () => rest[(rnd() * rest.length) | 0]) : rest;
    let best = null, bestN = 0;
    for (let it = 0; it < 160; it++) {
      // Three cells near each other (planes are local), so a sample rarely straddles two roof parts.
      const a = rest[(rnd() * rest.length) | 0], ax = X(a), ay = Y(a);
      const near = [];
      for (let tries = 0; tries < 60 && near.length < 2; tries++) {
        const q = rest[(rnd() * rest.length) | 0];
        const d = Math.hypot(X(q) - ax, Y(q) - ay);
        if (d > 1.5 * cellM && d < 12) near.push(q);
      }
      if (near.length < 2) continue;
      const [b, c] = near;
      const p = plane3(ax, ay, h[a], X(b), Y(b), h[b], X(c), Y(c), h[c]);
      if (!p) continue;
      let n = 0;
      for (const q of sample) if (Math.abs(p[0] * X(q) + p[1] * Y(q) + p[2] - h[q]) < TH) n++;
      if (n > bestN) { bestN = n; best = p; }
    }
    if (!best) break;
    let inl = rest.filter(q => Math.abs(best[0] * X(q) + best[1] * Y(q) + best[2] - h[q]) < TH);
    if (inl.length < minSup) break;
    let p = fitPlane(inl, X, Y, h) || best;
    if (Math.hypot(p[0], p[1]) < 0.07) p = [0, 0, median(inl.map(q => h[q]))];
    inl = rest.filter(q => Math.abs(p[0] * X(q) + p[1] * Y(q) + p[2] - h[q]) < TH);
    planes.push(p);
    const used = new Set(inl);
    rest = rest.filter(q => !used.has(q));
  }
  if (!planes.length) return { planes, lab: new Int16Array(nx * ny).fill(-1) };
  // Label every roof cell with its best plane.
  const lab = new Int16Array(nx * ny).fill(-1);
  for (const q of cells) {
    let bi = -1, be = 0.6;
    planes.forEach((p, i) => { const e = Math.abs(p[0] * X(q) + p[1] * Y(q) + p[2] - h[q]); if (e < be) { be = e; bi = i; } });
    lab[q] = bi;
  }
  // Majority vote (3×3) so plane borders are straight-ish and stray cells join their neighbours.
  const lab2 = lab.slice();
  for (const q of cells) {
    const cx = q % nx, cy = (q / nx) | 0, cnt = new Map();
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const a = cx + dx, c = cy + dy;
      if (a < 0 || a >= nx || c < 0 || c >= ny) continue;
      const l = lab[c * nx + a]; if (l < 0) continue;
      cnt.set(l, (cnt.get(l) || 0) + 1);
    }
    let bl = lab[q], bc = 0;
    for (const [l, n] of cnt) if (n > bc) { bc = n; bl = l; }
    if (bc >= 5) lab2[q] = bl;
  }
  // Cells no plane fits take their neighbours' plane, so the planes tile the whole roof.
  for (let pass = 0; pass < 50; pass++) {
    let left = 0;
    const next = lab2.slice();
    for (const q of cells) {
      if (lab2[q] >= 0) continue;
      const cx = q % nx, cy = (q / nx) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const a = cx + dx, c = cy + dy;
        if (a >= 0 && a < nx && c >= 0 && c < ny && lab2[c * nx + a] >= 0) { next[q] = lab2[c * nx + a]; break; }
      }
      if (next[q] < 0) left++;
    }
    lab2.set(next);
    if (!left) break;
  }
  for (const q of cells) {
    const l = lab2[q];
    if (l >= 0) { const p = planes[l]; h[q] = p[0] * X(q) + p[1] * Y(q) + p[2]; }
  }
  return { planes, lab: lab2 };
}

/** Closed outlines of a cell mask, as rings of cell-corner coordinates [i, j] (holes come out as rings too). */
function traceMask(mask, nx, ny) {
  // Directed boundary edges with the mask on the left; then chain them into loops.
  const edges = new Map();
  const put = (a, b) => { const k = a[0] + ',' + a[1]; (edges.get(k) || edges.set(k, []).get(k)).push(b); };
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    if (!mask(i, j)) continue;
    if (!mask(i, j - 1)) put([i, j], [i + 1, j]);
    if (!mask(i + 1, j)) put([i + 1, j], [i + 1, j + 1]);
    if (!mask(i, j + 1)) put([i + 1, j + 1], [i, j + 1]);
    if (!mask(i - 1, j)) put([i, j + 1], [i, j]);
  }
  const rings = [];
  for (const [k0, outs] of edges) {
    while (outs.length) {
      const start = k0.split(',').map(Number);
      const ring = [start];
      let cur = outs.pop();
      let guard = 0;
      while (guard++ < 1e6) {
        const k = cur[0] + ',' + cur[1];
        if (k === k0) break;
        ring.push(cur);
        const nxt = edges.get(k);
        if (!nxt || !nxt.length) break;
        cur = nxt.pop();
      }
      if (ring.length >= 4) rings.push(ring);
    }
  }
  return rings;
}

/** Douglas–Peucker on a closed ring (tolerance in the ring's units), then drop near-collinear corners. */
function simplifyRing(ring, tol) {
  if (ring.length < 5) return ring;
  // Split at the two farthest-apart points and simplify each half.
  let far = 0, fd = -1;
  for (let i = 1; i < ring.length; i++) { const d = Math.hypot(ring[i][0] - ring[0][0], ring[i][1] - ring[0][1]); if (d > fd) { fd = d; far = i; } }
  const dp = pts => {
    if (pts.length < 3) return pts;
    const [ax, ay] = pts[0], [bx, by] = pts[pts.length - 1], L = Math.hypot(bx - ax, by - ay) || 1e-9;
    let mi = 0, md = -1;
    for (let i = 1; i < pts.length - 1; i++) { const d = Math.abs((bx - ax) * (ay - pts[i][1]) - (ax - pts[i][0]) * (by - ay)) / L; if (d > md) { md = d; mi = i; } }
    if (md <= tol) return [pts[0], pts[pts.length - 1]];
    const l = dp(pts.slice(0, mi + 1)), r = dp(pts.slice(mi));
    return l.slice(0, -1).concat(r);
  };
  const a = dp(ring.slice(0, far + 1)), b = dp(ring.slice(far).concat([ring[0]]));
  return a.slice(0, -1).concat(b.slice(0, -1));
}

/** Triangles (indices into pts) covering a polygon, keeping those whose centroid and edge midpoints are inside. */
function polyTris(pts, D, inside) {
  if (pts.length < 3) return [];
  const del = D.from(pts);
  const out = [];
  for (let t = 0; t < del.triangles.length; t += 3) {
    const a = del.triangles[t], c = del.triangles[t + 1], d = del.triangles[t + 2];
    const mx = (pts[a][0] + pts[c][0] + pts[d][0]) / 3, my = (pts[a][1] + pts[c][1] + pts[d][1]) / 3;
    if (!inside(mx, my)) continue;
    const ok = (u, w) => { const ex = (pts[u][0] + pts[w][0]) / 2, ey = (pts[u][1] + pts[w][1]) / 2; return inside(ex + (mx - ex) * 0.05, ey + (my - ey) * 0.05); };
    if (ok(a, c) && ok(c, d) && ok(d, a)) out.push([a, c, d]);
  }
  return out;
}

function plane3(x1, y1, z1, x2, y2, z2, x3, y3, z3) {
  const det = (x2 - x1) * (y3 - y1) - (x3 - x1) * (y2 - y1);
  if (Math.abs(det) < 1e-6) return null;
  const a = ((z2 - z1) * (y3 - y1) - (z3 - z1) * (y2 - y1)) / det;
  const b = ((x2 - x1) * (z3 - z1) - (x3 - x1) * (z2 - z1)) / det;
  if (Math.hypot(a, b) > 3) return null; // steeper than ~70°: a wall or noise, not a roof
  return [a, b, z1 - a * x1 - b * y1];
}

/** Least-squares plane z = a x + b y + c through the cells. */
function fitPlane(qs, X, Y, h) {
  let sx = 0, sy = 0, sz = 0, sxx = 0, sxy = 0, syy = 0, sxz = 0, syz = 0;
  const n = qs.length;
  for (const q of qs) { const x = X(q), y = Y(q), z = h[q]; sx += x; sy += y; sz += z; sxx += x * x; sxy += x * y; syy += y * y; sxz += x * z; syz += y * z; }
  const mx = sx / n, my = sy / n, mz = sz / n;
  const cxx = sxx / n - mx * mx, cxy = sxy / n - mx * my, cyy = syy / n - my * my, cxz = sxz / n - mx * mz, cyz = syz / n - my * mz;
  const det = cxx * cyy - cxy * cxy;
  if (Math.abs(det) < 1e-9) return null;
  const a = (cxz * cyy - cyz * cxy) / det, b = (cyz * cxx - cxz * cxy) / det;
  return [a, b, mz - a * mx - b * my];
}
