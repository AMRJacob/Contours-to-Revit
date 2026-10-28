// Existing trees from USGS lidar: a canopy height model (height of vegetation above the lidar's own ground, 1 m
// cells), treetops as local highs (the search window grows with the tree's height), and each crown grown down from
// its top. Gives each tree a position, a height and a crown radius — good for site diagrams, context and shade;
// not a tree survey (species, trunk size and condition need a field survey).

const GROUND = 2, BUILDING = 6, WATER = 9, BRIDGE = 17, NOISE = new Set([7, 18]);

/**
 * lid: { n, x, y (native), z (m), c (class), r (returns per pulse) }; box: { xmin, ymin, xmax, ymax } native;
 * nativePerM; buildings: [[x, y]…] rings to leave out.
 * opts: { minH (m, default 4), cell (m, default 1) }.
 * Returns { trees: [{ x, y, h (m), r (m) }], canopy (share of the site under crowns), hasGround, cell }.
 */
export function findTrees(lid, box, nativePerM, buildings = [], opts = {}) {
  const cellM = opts.cell || 1, cs = cellM * nativePerM, minH = opts.minH || 4;
  const nx = Math.max(1, Math.ceil((box.xmax - box.xmin) / cs)), ny = Math.max(1, Math.ceil((box.ymax - box.ymin) / cs));
  if (nx * ny > 16e6) throw new Error('site too large for tree detection');
  const N = nx * ny, idx = (x, y) => { const i = Math.floor((x - box.xmin) / cs), j = Math.floor((y - box.ymin) / cs); return i < 0 || j < 0 || i >= nx || j >= ny ? -1 : j * nx + i; };
  // Ground: lowest ground-class point per cell, gaps filled from their neighbours.
  const G = new Float32Array(N).fill(NaN);
  let nGround = 0;
  for (let k = 0; k < lid.n; k++) {
    if (lid.c[k] !== GROUND) continue;
    const q = idx(lid.x[k], lid.y[k]); if (q < 0) continue;
    nGround++;
    if (!(G[q] <= lid.z[k])) G[q] = lid.z[k];
  }
  const hasGround = nGround > N * 0.02;
  if (!hasGround) {
    // No ground class: the lowest point in a 9 m neighbourhood stands in for the ground.
    const low = new Float32Array(N).fill(NaN);
    for (let k = 0; k < lid.n; k++) { if (NOISE.has(lid.c[k])) continue; const q = idx(lid.x[k], lid.y[k]); if (q >= 0 && !(low[q] <= lid.z[k])) low[q] = lid.z[k]; }
    const R = Math.max(1, Math.round(4.5 / cellM));
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      let m = Infinity;
      for (let dj = -R; dj <= R; dj++) for (let di = -R; di <= R; di++) { const a = i + di, b = j + dj; if (a < 0 || b < 0 || a >= nx || b >= ny) continue; const v = low[b * nx + a]; if (v < m) m = v; }
      G[j * nx + i] = Number.isFinite(m) ? m : NaN;
    }
  }
  fillGaps(G, nx, ny);
  // Leave out buildings (with a 1.5 m margin) and anything the lidar calls a building, water or a bridge.
  const block = new Uint8Array(N);
  for (const R of buildings) rasterRing(R, block, nx, ny, box, cs, 1.5 * nativePerM);
  // Canopy height: highest vegetation-like point per cell. Cells count as vegetation if the lidar says so, or if
  // enough of their pulses hit several things on the way down (foliage), which flat roofs and paving don't do.
  const H = new Float32Array(N), multi = new Uint16Array(N), tot = new Uint16Array(N), veg = new Uint8Array(N);
  for (let k = 0; k < lid.n; k++) {
    const c = lid.c[k];
    if (c === GROUND || NOISE.has(c) || c === WATER || c === BRIDGE) continue;
    const q = idx(lid.x[k], lid.y[k]); if (q < 0) continue;
    if (c === BUILDING) { block[q] = 1; continue; }
    const h = lid.z[k] - G[q]; if (!(h > 1)) continue;
    if (c >= 3 && c <= 5) veg[q] = 1;
    tot[q]++; if ((lid.r?.[k] || 1) > 1) multi[q]++;
    if (h > H[q]) H[q] = h;
  }
  for (let q = 0; q < N; q++) {
    const isVeg = !block[q] && (veg[q] || (tot[q] && multi[q] / tot[q] >= 0.15));
    if (!isVeg) H[q] = 0;
  }
  // Light smoothing (keeps tops, removes single-cell spikes and gaps between returns).
  const S = smooth(H, nx, ny);
  // Treetops: highest within a window that grows with height.
  const tops = [];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const q = j * nx + i, h = S[q]; if (h < minH) continue;
    const R = Math.max(1, Math.round(Math.min(6, Math.max(1.5, 0.5 + 0.11 * h)) / cellM));
    let top = true;
    for (let dj = -R; dj <= R && top; dj++) for (let di = -R; di <= R; di++) {
      if (!di && !dj) continue; if (di * di + dj * dj > R * R) continue;
      const a = i + di, b = j + dj; if (a < 0 || b < 0 || a >= nx || b >= ny) continue;
      const v = S[b * nx + a];
      if (v > h || (v === h && (dj < 0 || (dj === 0 && di < 0)))) { top = false; break; }
    }
    if (top) tops.push(q);
  }
  // Crowns grown down from the tops (highest cells first), within reach of their top.
  const lab = new Int32Array(N).fill(-1);
  tops.forEach((q, t) => { lab[q] = t; });
  const order = [];
  for (let q = 0; q < N; q++) if (S[q] >= 2 && lab[q] < 0) order.push(q);
  order.sort((a, b) => S[b] - S[a]);
  const topH = tops.map(q => S[q]), ti = tops.map(q => q % nx), tj = tops.map(q => (q / nx) | 0);
  for (let pass = 0; pass < 3; pass++) {
    for (const q of order) {
      if (lab[q] >= 0) continue;
      const i = q % nx, j = (q / nx) | 0;
      let best = -1, bh = -1;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const a = i + di, b = j + dj; if (a < 0 || b < 0 || a >= nx || b >= ny) continue;
        const t = lab[b * nx + a]; if (t < 0) continue;
        const reach = Math.min(12, 1.5 + 0.4 * topH[t]) / cellM;
        if (S[q] < 0.45 * topH[t] || (i - ti[t]) ** 2 + (j - tj[t]) ** 2 > reach * reach) continue;
        if (topH[t] > bh) { bh = topH[t]; best = t; }
      }
      if (best >= 0) lab[q] = best;
    }
  }
  // Evergreen or not (a heuristic): USGS prefers leaf-off collections, when a bare deciduous crown lets most pulses
  // through to the ground while a pine or cedar crown stops them. ev = share of the crown's returns in its upper half.
  const up = new Float64Array(tops.length), all = new Float64Array(tops.length);
  for (let k = 0; k < lid.n; k++) {
    const c = lid.c[k]; if (NOISE.has(c) || c === BUILDING) continue;
    const q = idx(lid.x[k], lid.y[k]); if (q < 0) continue;
    const t = lab[q]; if (t < 0) continue;
    all[t]++; if (lid.z[k] - G[q] > 0.5 * topH[t]) up[t]++;
  }
  const area = new Float64Array(tops.length);
  let canopy = 0;
  for (let q = 0; q < N; q++) if (lab[q] >= 0) { area[lab[q]]++; canopy++; }
  const trees = [];
  tops.forEach((q, t) => {
    const a = area[t] * cellM * cellM; if (a < 3) return;
    const i = q % nx, j = (q / nx) | 0;
    trees.push({ x: box.xmin + (i + 0.5) * cs, y: box.ymin + (j + 0.5) * cs, h: Math.round(H[q] * 10) / 10 || Math.round(topH[t] * 10) / 10, r: Math.round(Math.sqrt(a / Math.PI) * 10) / 10,
      ev: all[t] >= 8 ? Math.round(up[t] / all[t] * 100) / 100 : null });
  });
  trees.sort((a, b) => b.h - a.h);
  return { trees: trees.slice(0, 40000), canopy: canopy / N, hasGround, cell: cellM };
}

function fillGaps(G, nx, ny) {
  for (let pass = 0; pass < 60; pass++) {
    let missing = 0;
    const src = G.slice();
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const q = j * nx + i; if (!Number.isNaN(src[q])) continue;
      let s = 0, n = 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) { const a = i + di, b = j + dj; if (a < 0 || b < 0 || a >= nx || b >= ny) continue; const v = src[b * nx + a]; if (!Number.isNaN(v)) { s += v; n++; } }
      if (n) G[q] = s / n; else missing++;
    }
    if (!missing) return;
  }
}
function smooth(H, nx, ny) {
  const S = new Float32Array(H.length);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const q = j * nx + i; if (!H[q]) continue;
    let s = 0, w = 0;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const a = i + di, b = j + dj; if (a < 0 || b < 0 || a >= nx || b >= ny) continue;
      const v = H[b * nx + a]; if (!v) continue;
      const k = di || dj ? (di && dj ? 1 : 2) : 4; s += v * k; w += k;
    }
    S[q] = w ? s / w : 0;
  }
  return S;
}
function rasterRing(R, M, nx, ny, box, cs, pad) {
  if (!R || R.length < 3) return;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of R) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  const i0 = Math.max(0, Math.floor((x0 - pad - box.xmin) / cs)), i1 = Math.min(nx - 1, Math.floor((x1 + pad - box.xmin) / cs));
  const j0 = Math.max(0, Math.floor((y0 - pad - box.ymin) / cs)), j1 = Math.min(ny - 1, Math.floor((y1 + pad - box.ymin) / cs));
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
    const x = box.xmin + (i + 0.5) * cs, y = box.ymin + (j + 0.5) * cs;
    if (inRing(R, x, y) || distRing(R, x, y) < pad) M[j * nx + i] = 1;
  }
}
function inRing(r, x, y) { let c = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const [xi, yi] = r[i], [xj, yj] = r[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c; } return c; }
function distRing(R, x, y) {
  let d = Infinity;
  for (let i = 0; i < R.length; i++) {
    const [ax, ay] = R[i], [bx, by] = R[(i + 1) % R.length], dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2));
    d = Math.min(d, Math.hypot(x - ax - dx * t, y - ay - dy * t));
  }
  return d;
}
