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

/**
 * Polygon offset inward by d (negative = outward): each edge moved along its inward normal, corners re-intersected.
 * Good for the convex and mostly square outlines sketched here; returns null if the result collapses.
 */
export function insetPoly(P, d) {
  if (!d) return P.slice();
  let a2 = 0; for (let i = 0, j = P.length - 1; i < P.length; j = i++) a2 += P[j][0] * P[i][1] - P[i][0] * P[j][1];
  const sg = a2 > 0 ? 1 : -1, n = P.length, out = [];
  const L = i => { const p = P[i], q = P[(i + 1) % n]; const dx = q[0] - p[0], dy = q[1] - p[1], len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len * sg, ny = dx / len * sg; return { p: [p[0] + nx * d, p[1] + ny * d], dx, dy }; };
  for (let i = 0; i < n; i++) {
    const A = L((i - 1 + n) % n), B = L(i);
    const den = A.dx * B.dy - A.dy * B.dx;
    if (Math.abs(den) < 1e-9) { out.push(B.p); continue; }
    const t = ((B.p[0] - A.p[0]) * B.dy - (B.p[1] - A.p[1]) * B.dx) / den;
    out.push([A.p[0] + A.dx * t, A.p[1] + A.dy * t]);
  }
  let b2 = 0; for (let i = 0, j = out.length - 1; i < out.length; j = i++) b2 += out[j][0] * out[i][1] - out[i][0] * out[j][1];
  return Math.sign(b2) === Math.sign(a2) && Math.abs(b2) > 1e-6 ? out : null;
}
/** Sutherland–Hodgman clip by a·u + b·v + c ≥ 0. */
function clipH(P, a, b, c) {
  const out = [];
  for (let i = 0; i < P.length; i++) {
    const p = P[i], q = P[(i + 1) % P.length], fp = a * p[0] + b * p[1] + c, fq = a * q[0] + b * q[1] + c;
    if (fp >= 0) out.push(p);
    if ((fp >= 0) !== (fq >= 0)) { const t = fp / (fp - fq); out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]); }
  }
  return out;
}
/** u-ranges an obstacle covers within the band v0..v1 (frame coordinates), widened by pad. */
function blocked(obst, v0, v1, pad = 0) {
  const out = [];
  for (const O of obst) {
    const C = clipH(clipH(O, 0, 1, -v0), 0, -1, v1);
    if (C.length < 3) continue;
    let a = Infinity, b = -Infinity; for (const [u] of C) { if (u < a) a = u; if (u > b) b = u; }
    out.push([a - pad, b + pad]);
  }
  return out;
}
function subtractIv(I, B) {
  let cur = I;
  for (const [b0, b1] of B) {
    const next = [];
    for (const [a0, a1] of cur) { if (b1 <= a0 || b0 >= a1) { next.push([a0, a1]); continue; } if (b0 > a0) next.push([a0, b0]); if (b1 < a1) next.push([b1, a1]); }
    cur = next;
  }
  return cur.filter(([a, b]) => b - a > 1e-6);
}
/** A straight drive lane from a to b, w wide, as a polygon. */
export function lanePoly(a, b, w) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1, nx = -dy / L * w / 2, ny = dx / L * w / 2;
  return [[a[0] + nx, a[1] + ny], [b[0] + nx, b[1] + ny], [b[0] - nx, b[1] - ny], [a[0] - nx, a[1] - ny]];
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
 *         aisle, accNear: [x, y] (accessible spaces go to the row end nearest this point), k (native units per ft),
 *         setback (ft of landscape buffer inside the outline), islands: [polygons] (planters / obstacles),
 *         drives: [{ a, b, w? }] (drive lanes, w ft wide (default driveW, else a 90° aisle), that clear the stalls they cross), endIslands (bool),
 *         islandEvery (a planter island after every N stalls; 0 = none), islandW (ft, default 9) }
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
  const inner = (opts.setback ? insetPoly(poly, opts.setback * k) : poly) || [];
  const drivePolys = (opts.drives || []).map(d => lanePoly(d.a, d.b, (d.w ?? opts.driveW ?? PARK_DEFAULTS.aisle[90]) * k));
  const iw = (opts.islandW ?? 9) * k, every = Math.max(0, Math.floor(opts.islandEvery || 0));
  const autoIslands = [];
  const toF = ([x, y]) => [(x - cx) * c + (y - cy) * s, -(x - cx) * s + (y - cy) * c];
  const fromF = ([u, v]) => [cx + u * c - v * s, cy + u * s + v * c];
  const P = inner.map(toF);
  const islF = (opts.islands || []).map(o => o.map(toF)), drvF = drivePolys.map(o => o.map(toF));
  if (P.length < 3) return { stalls: [], aisles: [], islands: [], drives: drivePolys, inner, total: 0, std: 0, acc: 0, van: 0, required: adaRequired(0), short: 0, rows: 0, angle: ang };
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
    let I = intersect(bandIntervals(P, ...r.band), bandIntervals(P, ...r.aisle));
    I = subtractIv(I, blocked([...islF, ...drvF], r.band[0], r.band[1], lean));     // planters and drive lanes take stalls
    I = subtractIv(I, blocked(islF, r.aisle[0], r.aisle[1], 0));                    // a planter in the aisle cuts access
    const island = (a, b) => autoIslands.push([[a, r.band[0]], [b, r.band[0]], [b, r.band[1]], [a, r.band[1]]]);
    for (let [u0, u1] of I) {
      if (opts.endIslands && u1 - u0 > 2 * iw + pitch + lean) { island(u0, u0 + iw); island(u1 - iw, u1); u0 += iw; u1 -= iw; }
      const len = u1 - u0 - lean;
      const n = Math.floor(len / pitch + 1e-6);
      if (n < 1) continue;
      const off = r.face === 1 ? 0 : lean;
      if (!every || n <= every) { rowRuns.push({ r, u0: u0 + (len - n * pitch) / 2 + off, n }); continue; }
      // Groups of `every` stalls with a planter between them, centred in the run.
      const groups = Math.floor((len + iw) / (every * pitch + iw));
      const used = groups * every * pitch + (groups - 1) * iw, rest = Math.floor((len - used - iw) / pitch + 1e-6);
      let pos = u0 + (len - used - (rest > 0 ? iw + rest * pitch : 0)) / 2;
      for (let gi = 0; gi < groups; gi++) {
        rowRuns.push({ r, u0: pos + off, n: every }); pos += every * pitch;
        if (gi < groups - 1 || rest > 0) { island(pos + off / 2, pos + iw + off / 2); pos += iw; }
      }
      if (rest > 0) rowRuns.push({ r, u0: pos + off, n: rest });
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
  // Accessible spaces: pairs sharing an access aisle (a pair holding a van space gets the 8 ft van aisle), placed
  // at the row ends nearest accNear (the nearest building), spilling to the next-nearest rows when one is full.
  // accAt: a point the user dragged them to — the group centres on it in the nearest row (the rest spill to row ends).
  const at = opts.accAt ? toF(opts.accAt) : null;
  const near = at || (opts.accNear ? toF(opts.accNear) : null);
  const ends = [];
  for (const run of rowRuns) {
    const mid = (run.r.band[0] + run.r.band[1]) / 2, e0 = run.u0, e1 = run.u0 + run.n * pitch;
    const d0 = near ? Math.hypot(near[0] - e0, near[1] - mid) : -run.n, d1 = near ? Math.hypot(near[0] - e1, near[1] - mid) : -run.n;
    const uc = near ? Math.max(e0, Math.min(e1, near[0])) : 0;
    ends.push({ run, fromEnd: d1 < d0, d: at ? Math.hypot(at[0] - uc, at[1] - mid) : Math.min(d0, d1), at: at ? at[0] : null });
  }
  ends.sort((p, q) => p.d - q.d);
  const pairLen = van => 2 * S.accW * k + (van ? S.vanAisle : S.accAisle) * k;
  /** Place `acc` accessible spaces (`van` of them van): returns per-run groups and how many standard stalls each displaces. */
  const plan = (acc, van) => {
    const groups = new Map();
    let left = acc, vans = van;
    for (const e of ends) {
      if (left <= 0) break;
      const room = e.run.n * pitch;
      let len = 0, inRun = 0, vanIn = 0;
      while (left - inRun > 0) {
        const n2 = Math.min(2, left - inRun), isVan = vans - vanIn > 0;
        const add = n2 === 2 ? pairLen(isVan) : S.accW * k + (isVan ? S.vanAisle : S.accAisle) * k;
        if (len + add > room) break;
        len += add; inRun += n2; if (isVan) vanIn++;
      }
      if (!inRun) continue;
      groups.set(e.run, { acc: inRun, van: vanIn, len, removed: Math.ceil(len / pitch - 1e-9), fromEnd: e.fromEnd, at: e === ends[0] ? e.at : null });
      left -= inRun; vans -= vanIn;
    }
    let removed = 0, placedAcc = 0, placedVan = 0;
    for (const g of groups.values()) { removed += g.removed; placedAcc += g.acc; placedVan += g.van; }
    return { groups, removed, acc: placedAcc, van: placedVan };
  };
  let req = adaRequired(total), P2 = plan(req.acc, req.van);
  for (let iter = 0; iter < 4; iter++) {
    const r2 = adaRequired(total - P2.removed + P2.acc);
    if (r2.acc === req.acc && r2.van === req.van) break;
    req = r2; P2 = plan(req.acc, req.van);
  }
  for (const run of rowRuns) {
    let u = run.u0, n = run.n;
    const g = P2.groups.get(run);
    if (g) {
      const gl = g.removed * pitch;
      const startIdx = g.at != null ? Math.max(0, Math.min(n - g.removed, Math.round((g.at - run.u0) / pitch - g.removed / 2))) : g.fromEnd ? n - g.removed : 0;
      const g0 = run.u0 + startIdx * pitch;
      let x = g0 + (gl - g.len) / 2, vans = g.van;
      for (let i = 0; i < g.acc; i += 2) {
        const isVan = vans > 0, inPair = Math.min(2, g.acc - i), aw = (isVan ? S.vanAisle : S.accAisle) * k, sw = S.accW * k;
        stalls.push({ pts: stallAt(run.r, x, sw), acc: true, van: isVan }); x += sw;
        stalls.push({ pts: stallAt(run.r, x, aw), aisle: true }); x += aw;
        if (inPair === 2) { stalls.push({ pts: stallAt(run.r, x, sw), acc: true, van: false }); x += sw; }
        if (isVan) vans--;
      }
      for (let i = 0; i < n; i++) if (i < startIdx || i >= startIdx + g.removed) stalls.push({ pts: stallAt(run.r, u + i * pitch, pitch) });
      continue;
    }
    for (let i = 0; i < n; i++) stalls.push({ pts: stallAt(run.r, u + i * pitch, pitch) });
  }
  const placed = { acc: P2.acc, van: P2.van };
  const back = q => q.map(fromF);
  const out = stalls.map(st => ({ ...st, pts: back(st.pts) }));
  const std = out.filter(st => !st.acc && !st.aisle).length;
  const prov = std + placed.acc;
  return {
    stalls: out, aisles: aisles.map(back), islands: autoIslands.map(back), drives: drivePolys, inner,
    total: prov, std, acc: placed.acc, van: placed.van,
    required: adaRequired(prov), short: Math.max(0, adaRequired(prov).acc - placed.acc), rows: rowRuns.length, angle: ang,
  };
}

// ---------------------------------------------------------------- curb geometry for drawing (not counting)
/** Polygon with every corner rounded to radius r (limited to fit), arcs as `segs` pieces. */
export function roundPoly(P, r, segs = 6) {
  if (!(r > 0) || P.length < 3) return P.slice();
  const n = P.length, out = [];
  let a2 = 0; for (let i = 0, j = n - 1; i < n; j = i++) a2 += P[j][0] * P[i][1] - P[i][0] * P[j][1];
  for (let i = 0; i < n; i++) {
    const p = P[i], a = P[(i - 1 + n) % n], b = P[(i + 1) % n];
    const u = [a[0] - p[0], a[1] - p[1]], v = [b[0] - p[0], b[1] - p[1]], lu = Math.hypot(...u), lv = Math.hypot(...v);
    if (lu < 1e-9 || lv < 1e-9) { out.push(p); continue; }
    const ux = [u[0] / lu, u[1] / lu], vx = [v[0] / lv, v[1] / lv];
    const cos = Math.max(-1, Math.min(1, ux[0] * vx[0] + ux[1] * vx[1])), th = Math.acos(cos);
    if (th < 1e-3 || Math.PI - th < 1e-3) { out.push(p); continue; }
    const t = Math.min(r / Math.tan(th / 2), lu * 0.49, lv * 0.49), rr = t * Math.tan(th / 2);
    const A = [p[0] + ux[0] * t, p[1] + ux[1] * t], B = [p[0] + vx[0] * t, p[1] + vx[1] * t];
    const bis = [ux[0] + vx[0], ux[1] + vx[1]], lb = Math.hypot(...bis), h = rr / Math.sin(th / 2);
    const C = [p[0] + bis[0] / lb * h, p[1] + bis[1] / lb * h];
    let s0 = Math.atan2(A[1] - C[1], A[0] - C[0]), s1 = Math.atan2(B[1] - C[1], B[0] - C[0]);
    let ds = s1 - s0; while (ds > Math.PI) ds -= 2 * Math.PI; while (ds < -Math.PI) ds += 2 * Math.PI;
    for (let k = 0; k <= segs; k++) { const s = s0 + ds * k / segs; out.push([C[0] + rr * Math.cos(s), C[1] + rr * Math.sin(s)]); }
  }
  void a2;
  return out;
}
/**
 * Paving that rounds the outside corner at P between two curb lines leaving P along d1 and d2 (unit vectors):
 * the wedge between P, the two tangent points and the arc of radius r. Returns a polygon, or null.
 */
export function filletWedge(P, d1, d2, r, segs = 8) {
  const cos = Math.max(-1, Math.min(1, d1[0] * d2[0] + d1[1] * d2[1])), th = Math.acos(cos);
  if (th < 0.05 || th > Math.PI - 0.05 || !(r > 0)) return null;
  const t = r / Math.tan(th / 2), A = [P[0] + d1[0] * t, P[1] + d1[1] * t], B = [P[0] + d2[0] * t, P[1] + d2[1] * t];
  const bis = [d1[0] + d2[0], d1[1] + d2[1]], lb = Math.hypot(...bis), h = r / Math.sin(th / 2);
  const C = [P[0] + bis[0] / lb * h, P[1] + bis[1] / lb * h];
  let s0 = Math.atan2(A[1] - C[1], A[0] - C[0]), s1 = Math.atan2(B[1] - C[1], B[0] - C[0]);
  let ds = s1 - s0; while (ds > Math.PI) ds -= 2 * Math.PI; while (ds < -Math.PI) ds += 2 * Math.PI;
  const out = [P];
  for (let k = 0; k <= segs; k++) { const s = s0 + ds * k / segs; out.push([C[0] + r * Math.cos(s), C[1] + r * Math.sin(s)]); }
  return out;
}
const inP = (P, x, y) => { let c = false; for (let i = 0, j = P.length - 1; i < P.length; j = i++) { const [xi, yi] = P[i], [xj, yj] = P[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c; } return c; };
function segX(p, q, a, b) {
  const r = [q[0] - p[0], q[1] - p[1]], s = [b[0] - a[0], b[1] - a[1]], den = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(den) < 1e-12) return null;
  const t = ((a[0] - p[0]) * s[1] - (a[1] - p[1]) * s[0]) / den, u = ((a[0] - p[0]) * r[1] - (a[1] - p[1]) * r[0]) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? { t, u, x: [p[0] + r[0] * t, p[1] + r[1] * t] } : null;
}
/**
 * Curb returns where drive aisles meet paving (lots and other aisles), and curb cuts where an aisle ends at the
 * street (an end outside every paved area). drives: [{ pts, w (native), r (native radius), cut (bool) }],
 * paved: [polygon…] (lots). Returns { wedges: [polygon…], cuts: [[a, b]…] (curb line across each cut) }.
 */
export function driveJoins(drives, paved) {
  const wedges = [], cuts = [], corners = [];
  const lanes = drives.map(d => { const L = []; for (let i = 0; i < d.pts.length - 1; i++) L.push(lanePoly(d.pts[i], d.pts[i + 1], d.w)); return L; });
  drives.forEach((d, di) => {
    const regions = [...paved, ...lanes.flatMap((L, j) => (j === di ? [] : L))];
    for (let i = 0; i < d.pts.length - 1; i++) {
      const a = d.pts[i], b = d.pts[i + 1], dx = b[0] - a[0], dy = b[1] - a[1], Ls = Math.hypot(dx, dy) || 1;
      const dir = [dx / Ls, dy / Ls], nrm = [-dir[1], dir[0]];
      for (const sd of [1, -1]) {
        const p = [a[0] + nrm[0] * sd * d.w / 2, a[1] + nrm[1] * sd * d.w / 2], q = [b[0] + nrm[0] * sd * d.w / 2, b[1] + nrm[1] * sd * d.w / 2];
        for (const R of regions) for (let k = 0; k < R.length; k++) {
          const e0 = R[k], e1 = R[(k + 1) % R.length], X = segX(p, q, e0, e1); if (!X) continue;
          // d2: along the lane side, out of the region; d1: along the region edge, away from the lane.
          const fw = inP(R, X.x[0] + dir[0] * 1e-3 * Ls, X.x[1] + dir[1] * 1e-3 * Ls) ? -1 : 1;
          const d2 = [dir[0] * fw, dir[1] * fw];
          let ed = [e1[0] - e0[0], e1[1] - e0[1]]; const le = Math.hypot(...ed) || 1; ed = [ed[0] / le, ed[1] / le];
          const d1 = ed[0] * nrm[0] * sd + ed[1] * nrm[1] * sd > 0 ? ed : [-ed[0], -ed[1]];
          corners.push({ p: X.x, di });
          const W = filletWedge(X.x, d1, d2, d.rAt ? d.rAt(X.x) : d.r); if (W) wedges.push(W);
        }
      }
    }
    // Curb cuts at ends outside all paving (each end can be switched off: d.cut = [start, end] or a boolean).
    const cutAt = Array.isArray(d.cut) ? d.cut : [d.cut !== false, d.cut !== false];
    for (const [ei, end, nb] of [[0, d.pts[0], d.pts[1]], [1, d.pts[d.pts.length - 1], d.pts[d.pts.length - 2]]]) {
      if (!cutAt[ei]) continue;
      if (regions.some(R => inP(R, end[0], end[1]))) continue;
      const dx = end[0] - nb[0], dy = end[1] - nb[1], Ls = Math.hypot(dx, dy) || 1, dir = [dx / Ls, dy / Ls], nrm = [-dir[1], dir[0]];
      const tips = [];
      for (const sd of [1, -1]) {
        const P = [end[0] + nrm[0] * sd * d.w / 2, end[1] + nrm[1] * sd * d.w / 2];
        corners.push({ p: P, di, entry: true });
        const W = filletWedge(P, [nrm[0] * sd, nrm[1] * sd], [-dir[0], -dir[1]], d.rAt ? d.rAt(P) : d.r);
        if (W) { wedges.push(W); tips.push(W[1]); } else tips.push(P);
      }
      if (tips.length === 2) cuts.push([tips[0], tips[1]]);
    }
  });
  return { wedges, cuts, corners };
}
/** Outline with corner i rounded to radius rOf(i) (0 = left sharp); each radius is limited to fit its two sides. */
export function roundEach(P, rOf, segs = 8) {
  const n = P.length; if (n < 3) return P.slice();
  const out = [];
  for (let i = 0; i < n; i++) {
    const r = rOf(i);
    if (!(r > 0)) { out.push(P[i]); continue; }
    const tri = [P[(i - 1 + n) % n], P[i], P[(i + 1) % n]], k = segs + 1;
    out.push(...roundPoly(tri, r, segs).slice(k, 2 * k));
  }
  return out;
}
/** Round one corner (index i) of an outline with radius r: the corner is replaced by arc points. */
export function filletAt(P, i, r, segs = 8) {
  const n = P.length, closedRing = n >= 3;
  if (!closedRing || !(r > 0)) return P.slice();
  const tri = [P[(i - 1 + n) % n], P[i], P[(i + 1) % n]];
  const R = roundPoly(tri, r, segs);            // the middle corner's arc sits between the two end corners' arcs
  const k = segs + 1, arc = R.slice(k, 2 * k);
  const out = P.slice(); out.splice(i, 1, ...arc);
  return out;
}
