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
    const hAt = (x, y) => {
      const fx = (x - x0) / cell - 0.5, fy = (y - y0) / cell - 0.5;
      const i = Math.max(0, Math.min(nx - 1, Math.floor(fx))), j = Math.max(0, Math.min(ny - 1, Math.floor(fy)));
      const i2 = Math.min(nx - 1, i + 1), j2 = Math.min(ny - 1, j + 1);
      const tx = Math.max(0, Math.min(1, fx - i)), ty = Math.max(0, Math.min(1, fy - j));
      return (sm[j * nx + i] * (1 - tx) + sm[j * nx + i2] * tx) * (1 - ty) + (sm[j2 * nx + i] * (1 - tx) + sm[j2 * nx + i2] * tx) * ty;
    };
    const lo = pct(vals, 0.1), hi = pct(vals, 0.9);
    const isFlat = hi - lo < 0.8;
    const flatH = pct(vals, 0.6);
    const zOf = h => gDem + h * zPerM;       // roof elevation in output units
    // Corner heights sampled a little inside the footprint (edges catch walls and eaves only partly).
    let cxm = 0, cym = 0; for (const [x, y] of R) { cxm += x; cym += y; } cxm /= R.length; cym /= R.length;
    const inward = ([x, y]) => { const dx = cxm - x, dy = cym - y, d = Math.hypot(dx, dy) || 1, s = Math.min(0.75 * m, d * 0.3); return [x + dx / d * s, y + dy / d * s]; };
    const ringTop = R.map(p => zOf(isFlat ? flatH : hAt(...inward(p))));
    const mesh = R.map((p, i) => [p[0], p[1], ringTop[i]]);
    // Roof mesh by greedy refinement: start from the footprint corners and keep adding the roof cell the current
    // triangles miss by the most, until every cell is within TOL. Flat decks and plane roof slopes need only a few
    // points; ridges, valleys and steps get them where needed. Capped per building.
    const inside = [];
    for (let cy = 0; cy < ny; cy++) for (let cx = 0; cx < nx; cx++) {
      if (inRing(R, x0 + (cx + 0.5) * cell, y0 + (cy + 0.5) * cell)) inside.push(cy * nx + cx);
    }
    const TOL = 0.3, CAP = 2500;                       // metres; points per roof
    const cellXY = q => [x0 + ((q % nx) + 0.5) * cell, y0 + (((q / nx) | 0) + 0.5) * cell];
    const triangulateMesh = () => {
      const del = D.from(mesh.map(p => [p[0], p[1]]));
      const out = [];
      for (let t = 0; t < del.triangles.length; t += 3) {
        const a = del.triangles[t], c = del.triangles[t + 1], d = del.triangles[t + 2];
        const mx = (mesh[a][0] + mesh[c][0] + mesh[d][0]) / 3, my = (mesh[a][1] + mesh[c][1] + mesh[d][1]) / 3;
        if (inRing(R, mx, my)) out.push([a, c, d]);
      }
      return out;
    };
    let tris = triangulateMesh();
    if (!isFlat) {
      const approx = new Float32Array(nx * ny);
      const used2 = new Uint8Array(nx * ny);
      for (let iter = 0; iter < 30 && mesh.length < CAP; iter++) {
        approx.fill(NaN);
        // Rasterize the current roof triangles (metres above ground) onto the cell centres.
        for (const [a, c, d] of tris) {
          const A = mesh[a], B2 = mesh[c], C = mesh[d];
          const det = (B2[1] - C[1]) * (A[0] - C[0]) + (C[0] - B2[0]) * (A[1] - C[1]);
          if (Math.abs(det) < 1e-12) continue;
          const i0 = Math.max(0, Math.floor((Math.min(A[0], B2[0], C[0]) - x0) / cell - 0.5)), i1 = Math.min(nx - 1, Math.ceil((Math.max(A[0], B2[0], C[0]) - x0) / cell - 0.5));
          const j0 = Math.max(0, Math.floor((Math.min(A[1], B2[1], C[1]) - y0) / cell - 0.5)), j1 = Math.min(ny - 1, Math.ceil((Math.max(A[1], B2[1], C[1]) - y0) / cell - 0.5));
          for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
            const x = x0 + (i + 0.5) * cell, y = y0 + (j + 0.5) * cell;
            const l1 = ((B2[1] - C[1]) * (x - C[0]) + (C[0] - B2[0]) * (y - C[1])) / det, l2 = ((C[1] - A[1]) * (x - C[0]) + (A[0] - C[0]) * (y - C[1])) / det, l3 = 1 - l1 - l2;
            if (l1 < -1e-9 || l2 < -1e-9 || l3 < -1e-9) continue;
            approx[j * nx + i] = ((l1 * A[2] + l2 * B2[2] + l3 * C[2]) - gDem) / zPerM;
          }
        }
        const bad = [];
        for (const q of inside) {
          if (used2[q]) continue;
          const e = Number.isFinite(approx[q]) ? Math.abs(approx[q] - sm[q]) : 1e6;
          if (e > TOL) bad.push([e, q]);
        }
        if (!bad.length) break;
        bad.sort((u, v) => v[0] - u[0]);
        // Add the worst cells, a few cells apart so one pass doesn't spend its budget on a single edge.
        const room = Math.min(CAP - mesh.length, Math.max(16, Math.round(mesh.length * 0.6)));
        const block = new Set();
        const gap = Math.max(1, Math.round(1.5 / cellM));
        let added = 0;
        for (const [, q] of bad) {
          if (added >= room) break;
          const cx = q % nx, cy = (q / nx) | 0, key = `${Math.floor(cx / (gap + 1))}:${Math.floor(cy / (gap + 1))}`;
          if (block.has(key)) continue;
          block.add(key);
          const [x, y] = cellXY(q);
          mesh.push([x, y, zOf(sm[q])]);
          used2[q] = 1;
          added++;
        }
        if (!added) break;
        tris = triangulateMesh();
      }
    }
    if (!tris.length) { skipped++; continue; }
    b.roof = { pts: mesh, tris };
    b.ringTop = ringTop;
    b.roofAt = isFlat ? () => zOf(flatH) : (x, y) => zOf(hAt(x, y));
    b.roofType = isFlat ? 'flat' : 'shaped';
    b.top = Math.max(...mesh.map(p => p[2]));
    b.heightKnown = true;
    b.hSrc = 'lidar';
    used++; if (isFlat) flat++; else shaped++;
  }
  return { used, flat, shaped, skipped };
}
