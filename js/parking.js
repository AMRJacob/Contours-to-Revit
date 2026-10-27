// Parking layout: fills a lot outline with rows of stalls and drive aisles, counts them, and sets aside the
// accessible spaces. Schematic — for early counts and diagrams, not a striping plan.
//
// Accessible spaces (2010 ADA Standards, checked against the published text 2026-10-27):
//   Table 208.2 — 1–25 → 1, 26–50 → 2, 51–75 → 3, 76–100 → 4, 101–150 → 5, 151–200 → 6, 201–300 → 7,
//   301–400 → 8, 401–500 → 9, 501–1,000 → 2 % of total, 1,001+ → 20 plus 1 per 100 (or fraction) over 1,000.
//   208.2.4 — one van space for every six accessible spaces or fraction of six.
//   502.2 / 502.3 — car space ≥ 96 in, van ≥ 132 in (or 96 in with a 96 in aisle), access aisle ≥ 60 in; two
//   spaces may share an aisle. Counted per lot (the standard counts per parking facility).
// Stall and drive-aisle sizes are settings: they vary by jurisdiction.

/** Minimum accessible spaces for a facility with `total` spaces (Table 208.2), and how many must be van spaces. */
export function adaRequired(total) {
  if (total <= 0) return { acc: 0, van: 0 };
  const steps = [[25, 1], [50, 2], [75, 3], [100, 4], [150, 5], [200, 6], [300, 7], [400, 8], [500, 9]];
  let acc = null;
  for (const [n, a] of steps) if (total <= n) { acc = a; break; }
  if (acc == null) acc = total <= 1000 ? Math.ceil(total * 0.02) : 20 + Math.ceil((total - 1000) / 100);
  return { acc, van: Math.ceil(acc / 6) };
}

/** Default stall / aisle sizes in feet (typical values — edit to the local code). */
export const PARK_DEFAULTS = {
  stallW: 9, stallL: 18,
  aisle: { 90: 24, 60: 18, 45: 13 },          // 60° / 45° are one-way aisles
  accW: 8, accAisle: 5, vanAisle: 8,          // ADA 502: 96 in space, 60 in aisle, 96 in van aisle (with a 96 in space)
};

/** Intervals [a, b] (sorted) where the horizontal line y = v crosses inside polygon P (frame coordinates). */
function lineIntervals(P, v) {
  const xs = [];
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
    const [x1, y1] = P[j], [x2, y2] = P[i];
    if ((y1 > v) !== (y2 > v)) xs.push(x1 + (v - y1) / (y2 - y1) * (x2 - x1));
  }
  xs.sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i + 1 < xs.length; i += 2) out.push([xs[i], xs[i + 1]]);
  return out;
}
const intersect = (A, B) => {
  const out = [];
  for (const [a0, a1] of A) for (const [b0, b1] of B) { const lo = Math.max(a0, b0), hi = Math.min(a1, b1); if (hi > lo) out.push([lo, hi]); }
  return out;
};
/** Where the whole band v0..v1 is inside P (intervals common to several scan lines across it). */
function bandIntervals(P, v0, v1) {
  let I = null;
  for (let k = 0; k <= 4; k++) { const L = lineIntervals(P, v0 + (v1 - v0) * (k / 4) * 0.999 + (v1 - v0) * 0.0005); I = I ? intersect(I, L) : L; if (!I.length) break; }
  // Vertices of P inside the band also cut the band.
  for (const [x, y] of P) if (y > v0 && y < v1) I = I.flatMap(([a, b]) => (x > a && x < b ? [[a, x], [x, b]] : [[a, b]]));
  return I.filter(([a, b]) => b - a > 1e-6);
}

/** Direction (radians) of the polygon's longest edge — the default row direction. */
export function longestEdgeAngle(P) {
  let best = 0, ang = 0;
  for (let i = 0; i < P.length; i++) {
    const [x1, y1] = P[i], [x2, y2] = P[(i + 1) % P.length], L = Math.hypot(x2 - x1, y2 - y1);
    if (L > best) { best = L; ang = Math.atan2(y2 - y1, x2 - x1); }
  }
  return ang;
}

/**
 * Lay out a lot. poly: [[x, y]…] in feet (native units scaled so 1 unit = 1 ft — pass k for other units).
 * opts: { angle (row direction, radians), stall: 90|60|45, shift (feet, slides the rows across), stallW, stallL,
 *         aisle, accNear: [x, y] (accessible spaces go to the row end nearest this point), k (native units per ft) }
 * Returns { stalls: [{ pts: 4 corners, acc?, van? }], aisles: [[4 corners]…], total, acc, van, required: {acc, van},
 *           rows, short (accessible spaces that couldn't be placed) }.
 */
export function layoutLot(poly, opts = {}) {
  const k = opts.k || 1;
  const S = { ...PARK_DEFAULTS, ...opts };
  const deg = [90, 60, 45].includes(S.stall) ? S.stall : 90;
  const a = deg * Math.PI / 180;
  const W = (S.stallW) * k, L = (S.stallL) * k, A = (opts.aisle ?? PARK_DEFAULTS.aisle[deg]) * k;
  const depth = L * Math.sin(a) + (deg === 90 ? 0 : W * Math.cos(a));        // stall depth square to the aisle
  const pitch = W / Math.sin(a);                                            // stall spacing along the row
  const lean = deg === 90 ? 0 : L * Math.cos(a);                            // how far an angled stall leans along the row
  const ang = opts.angle ?? longestEdgeAngle(poly), c = Math.cos(ang), s = Math.sin(ang);
  let cx = 0, cy = 0; for (const [x, y] of poly) { cx += x; cy += y; } cx /= poly.length; cy /= poly.length;
  const toF = ([x, y]) => [(x - cx) * c + (y - cy) * s, -(x - cx) * s + (y - cy) * c];
  const fromF = ([u, v]) => [cx + u * c - v * s, cy + u * s + v * c];
  const P = poly.map(toF);
  let v0 = Infinity, v1 = -Infinity; for (const [, v] of P) { if (v < v0) v0 = v; if (v > v1) v1 = v; }
  const mod = 2 * depth + A;
  const shift = ((((opts.shift || 0) * k) % mod) + mod) % mod;
  // Rows: [stall][aisle][stall] modules stacked; a leftover strip deep enough gets a single-loaded row.
  const rows = [];   // { band: [v0, v1], aisle: [v0, v1], dir: +1 stall faces up (aisle above) / -1 }
  for (let v = v0 - mod + shift; v < v1; v += mod) {
    rows.push({ band: [v, v + depth], aisle: [v + depth, v + depth + A], face: 1 });
    rows.push({ band: [v + depth + A, v + mod], aisle: [v + depth, v + depth + A], face: -1 });
  }
  const stalls = [], aisles = [];
  const rowRuns = [];
  for (const r of rows) {
    if (r.band[1] <= v0 || r.band[0] >= v1) continue;
    const I = intersect(bandIntervals(P, ...r.band), bandIntervals(P, ...r.aisle));
    for (const [u0, u1] of I) {
      const len = u1 - u0 - lean;
      const n = Math.floor(len / pitch + 1e-6);
      if (n < 1) continue;
      const start = u0 + (len - n * pitch) / 2 + (r.face === 1 ? 0 : lean);
      rowRuns.push({ r, u0: start, n });
    }
    if (r.face === 1) for (const [u0, u1] of bandIntervals(P, ...r.aisle)) if (u1 - u0 > pitch * 2) aisles.push([[u0, r.aisle[0]], [u1, r.aisle[0]], [u1, r.aisle[1]], [u0, r.aisle[1]]]);
  }
  // Stall corners in the frame: a parallelogram leaning along the row (front edge on the aisle).
  const stallAt = (r, u, w) => {
    const front = r.face === 1 ? r.band[1] : r.band[0], back = r.face === 1 ? r.band[0] : r.band[1];
    const dl = r.face === 1 ? -lean : lean;
    return [[u, front], [u + w, front], [u + w + dl, back], [u + dl, back]];
  };
  let total = 0;
  for (const run of rowRuns) total += run.n;
  // Accessible spaces: on the run whose end is nearest accNear (or the longest run), at that end.
  let req = adaRequired(total), placed = { acc: 0, van: 0 }, removed = 0;
  let accRun = null, accFromEnd = false;
  if (rowRuns.length) {
    const near = opts.accNear ? toF(opts.accNear) : null;
    let best = Infinity;
    for (const run of rowRuns) {
      const mid = (run.r.band[0] + run.r.band[1]) / 2, e0 = run.u0, e1 = run.u0 + run.n * pitch;
      if (near) {
        const d0 = Math.hypot(near[0] - e0, near[1] - mid), d1 = Math.hypot(near[0] - e1, near[1] - mid);
        if (Math.min(d0, d1) < best) { best = Math.min(d0, d1); accRun = run; accFromEnd = d1 < d0; }
      } else if (-run.n < best) { best = -run.n; accRun = run; accFromEnd = false; }
    }
  }
  // Width the accessible group needs: spaces in pairs sharing an aisle; a pair with a van gets the van aisle.
  const groupLen = (acc, van) => {
    let len = 0;
    for (let i = 0; i < acc; i += 2) {
      const inPair = Math.min(2, acc - i), hasVan = i / 2 < van;
      len += inPair * S.accW * k + (hasVan ? S.vanAisle : S.accAisle) * k;
    }
    return len;
  };
  for (let iter = 0; iter < 3 && accRun; iter++) {
    const need = Math.ceil(groupLen(req.acc, req.van) / pitch);
    if (need > accRun.n) break;
    removed = need;
    const newTotal = total - removed + req.acc;
    const r2 = adaRequired(newTotal);
    if (r2.acc === req.acc) { placed = { ...req }; break; }
    req = r2;
  }
  if (accRun && !placed.acc && req.acc && Math.ceil(groupLen(req.acc, req.van) / pitch) <= accRun.n) { removed = Math.ceil(groupLen(req.acc, req.van) / pitch); placed = { ...req }; }
  for (const run of rowRuns) {
    let u = run.u0, n = run.n;
    if (run === accRun && placed.acc) {
      // The accessible group takes `removed` standard stalls' worth of row at the chosen end.
      const gl = removed * pitch;
      const g0 = accFromEnd ? run.u0 + (n - removed) * pitch : run.u0;
      let x = g0 + (gl - groupLen(placed.acc, placed.van)) / 2;
      for (let i = 0; i < placed.acc; i += 2) {
        const hasVan = i / 2 < placed.van, inPair = Math.min(2, placed.acc - i), aw = (hasVan ? S.vanAisle : S.accAisle) * k, sw = S.accW * k;
        stalls.push({ pts: stallAt(run.r, x, sw), acc: true, van: hasVan });
        x += sw;
        stalls.push({ pts: stallAt(run.r, x, aw), aisle: true });
        x += aw;
        if (inPair === 2) { stalls.push({ pts: stallAt(run.r, x, sw), acc: true, van: hasVan && false }); x += sw; }
      }
      if (!accFromEnd) u += removed * pitch;
      n -= removed;
    }
    for (let i = 0; i < n; i++) stalls.push({ pts: stallAt(run.r, u + i * pitch, pitch) });
  }
  const back = q => q.map(fromF);
  const out = stalls.map(st => ({ ...st, pts: back(st.pts) }));
  const std = out.filter(st => !st.acc && !st.aisle).length;
  const prov = std + placed.acc;
  return {
    stalls: out, aisles: aisles.map(back), total: prov, std, acc: placed.acc, van: placed.van,
    required: adaRequired(prov), short: Math.max(0, adaRequired(prov).acc - placed.acc), rows: rowRuns.length, angle: ang,
  };
}
