// Sketch solids: SketchUp-style building masses made of flat faces you can push, pull, split, slope and move.
// A solid: { v: [[x, y, z]…], f: [{ o: [vertex indices, counter-clockwise seen from outside], h: [[hole loop]…] }] }
// x, y in native zone units, z in native units above the solid's base (the lowest ground under it). A solid with a
// single face is a flat "sheet" (a shape drawn on the ground, waiting to be pulled up).
// Floors aren't stored as geometry: they come from slicing the solid every floor-to-floor height.
import earcut from '../lib/earcut.js';
import { massGeom } from './sketchmass.js?v=0.50.0';

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = a => Math.hypot(a[0], a[1], a[2]);
export const unit = a => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const sArea2 = P => { let a = 0; for (let i = 0, j = P.length - 1; i < P.length; j = i++) a += P[j][0] * P[i][1] - P[i][0] * P[j][1]; return a / 2; };
export const clone = S => JSON.parse(JSON.stringify(S));
export const isSheet = S => S.f.length === 1;

/** Newell normal of a loop of points (length = twice the area). */
function newell(P) {
  const n = [0, 0, 0];
  for (let i = 0; i < P.length; i++) {
    const a = P[i], b = P[(i + 1) % P.length];
    n[0] += (a[1] - b[1]) * (a[2] + b[2]); n[1] += (a[2] - b[2]) * (a[0] + b[0]); n[2] += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return n;
}
export const loopPts = (S, L) => L.map(i => S.v[i]);
export const faceNormal = (S, fi) => unit(newell(loopPts(S, S.f[fi].o)));
export const faceLoops = (S, fi) => [S.f[fi].o, ...(S.f[fi].h || [])];
export const faceVerts = (S, fi) => [...new Set(faceLoops(S, fi).flat())];

/** In-plane axes of a face: u horizontal (or along the longest edge on flat faces), v = n × u. */
export function faceFrame(S, fi) {
  const n = faceNormal(S, fi), P = loopPts(S, S.f[fi].o);
  let u;
  if (Math.abs(n[2]) > 0.98) {
    let best = 0; u = [1, 0, 0];
    for (let i = 0; i < P.length; i++) { const e = sub(P[(i + 1) % P.length], P[i]); const l = Math.hypot(e[0], e[1]); if (l > best) { best = l; u = unit([e[0], e[1], 0]); } }
  } else u = unit(cross([0, 0, 1], n));
  const v = cross(n, u);
  return { n, u, v, o: P[0] };
}
const to2 = (F, p) => { const d = sub(p, F.o); return [dot(d, F.u), dot(d, F.v)]; };

/** Triangles of one face as vertex-index triples, wound to match the face normal. */
export function faceTris(S, fi) {
  const F = faceFrame(S, fi), loops = faceLoops(S, fi), flat = [], holes = [], idx = [];
  for (const L of loops) { if (flat.length) holes.push(flat.length / 2); for (const i of L) { const q = to2(F, S.v[i]); flat.push(q[0], q[1]); idx.push(i); } }
  const t = earcut(flat, holes), out = [];
  for (let k = 0; k < t.length; k += 3) {
    let a = idx[t[k]], b = idx[t[k + 1]], c = idx[t[k + 2]];
    if (dot(cross(sub(S.v[b], S.v[a]), sub(S.v[c], S.v[a])), F.n) < 0) [b, c] = [c, b];
    out.push([a, b, c]);
  }
  return out;
}
/** All triangles: [{ a, b, c, fi }]. */
export function solidTris(S) {
  const out = [];
  S.f.forEach((_, fi) => { for (const [a, b, c] of faceTris(S, fi)) out.push({ a, b, c, fi }); });
  return out;
}
/** Unique edges [a, b] of all face loops (the model's outlines). */
export function edgesOf(S) {
  const seen = new Set(), out = [];
  for (const f of S.f) for (const L of [f.o, ...(f.h || [])]) for (let i = 0; i < L.length; i++) {
    const a = L[i], b = L[(i + 1) % L.length], k = a < b ? `${a},${b}` : `${b},${a}`;
    if (!seen.has(k)) { seen.add(k); out.push([a, b]); }
  }
  return out;
}

/** Horizontal section at height z: net area (native²) and its outline segments. */
export function slice(S, z, tris = solidTris(S)) {
  const c = S.v[0];
  let area = 0;
  const segs = [];
  for (const t of tris) {
    const P = [S.v[t.a], S.v[t.b], S.v[t.c]], pts = [];
    for (let i = 0; i < 3; i++) {
      const a = P[i], b = P[(i + 1) % 3], da = a[2] - z, db = b[2] - z;
      if ((da > 0) !== (db > 0)) { const s = da / (da - db); pts.push([a[0] + (b[0] - a[0]) * s - c[0], a[1] + (b[1] - a[1]) * s - c[1]]); }
    }
    if (pts.length !== 2) continue;
    const n = cross(sub(P[1], P[0]), sub(P[2], P[0]));
    let [p, q] = pts;
    if ((q[0] - p[0]) * -n[1] + (q[1] - p[1]) * n[0] < 0) [p, q] = [q, p];      // walk the section counter-clockwise
    area += (p[0] * q[1] - q[0] * p[1]) / 2;
    segs.push([[p[0] + c[0], p[1] + c[1]], [q[0] + c[0], q[1] + c[1]]]);
  }
  return { area, segs };
}
export const zMax = S => Math.max(...S.v.map(p => p[2]));

/**
 * Floor plates: a level every ftf (native) from the base. A level counts when at least half of its floor still has
 * the full storey above it (so a pitched roof's attic doesn't, a tall shed's might); its area is the floor plate.
 * Returns [{ z, area, segs }].
 */
export function plates(S, ftf, tris = solidTris(S)) {
  if (isSheet(S) || !(ftf > 0)) return [];
  const top = zMax(S), out = [];
  for (let i = 0; i < 400; i++) {
    const z = i * ftf; if (z + 0.05 * ftf >= top) break;
    const lo = slice(S, z + 0.05 * ftf, tris), hi = slice(S, z + 0.95 * ftf, tris);
    if (lo.area > 1e-6 && hi.area >= 0.5 * lo.area) out.push({ z, area: lo.area, segs: slice(S, z + 1e-4 * ftf, tris).segs });
  }
  return out;
}

/** Highest upward-facing surface over (x, y): { z, fi } or null. */
export function topAt(S, tris = solidTris(S)) {
  const up = tris.filter(t => { const n = cross(sub(S.v[t.b], S.v[t.a]), sub(S.v[t.c], S.v[t.a])); return n[2] > 1e-9 * (Math.abs(n[0]) + Math.abs(n[1]) + n[2]); });
  return (x, y) => {
    let best = null;
    for (const t of up) {
      const A = S.v[t.a], B = S.v[t.b], C = S.v[t.c];
      const d = (B[1] - C[1]) * (A[0] - C[0]) + (C[0] - B[0]) * (A[1] - C[1]); if (Math.abs(d) < 1e-12) continue;
      const l1 = ((B[1] - C[1]) * (x - C[0]) + (C[0] - B[0]) * (y - C[1])) / d, l2 = ((C[1] - A[1]) * (x - C[0]) + (A[0] - C[0]) * (y - C[1])) / d, l3 = 1 - l1 - l2;
      if (l1 < -1e-9 || l2 < -1e-9 || l3 < -1e-9) continue;
      const z = l1 * A[2] + l2 * B[2] + l3 * C[2];
      if (!best || z > best.z) best = { z, fi: t.fi };
    }
    return best;
  };
}

// ---------------------------------------------------------------- building solids
function builder() {
  const v = [], f = [], key = new Map();
  const vi = p => { const k = p.map(x => Math.round(x * 1e4)).join(','); let i = key.get(k); if (i == null) { i = v.length; v.push(p.slice()); key.set(k, i); } return i; };
  const loop = P => { const L = []; for (const p of P) { const i = vi(p); if (L[L.length - 1] !== i) L.push(i); } while (L.length > 1 && L[0] === L[L.length - 1]) L.pop(); return L; };
  return { v, f, face(outer, holes = []) { const o = loop(outer); if (o.length < 3) return; const h = holes.map(loop).filter(L => L.length >= 3); f.push(h.length ? { o, h } : { o }); } };
}
const ccw = P => (sArea2(P) < 0 ? P.slice().reverse() : P);
const at = (P, z) => P.map(p => [p[0], p[1], typeof z === 'function' ? z(p) : z]);

/** Flat sheet from a ground outline. */
export function sheet(pts) { const B = builder(); B.face(at(ccw(pts), 0)); return { v: B.v, f: B.f }; }

/** Prism of an outline, h tall (native). */
export function prism(pts, h) {
  const P = ccw(pts), B = builder();
  B.face(at(P.slice().reverse(), 0));
  for (let i = 0; i < P.length; i++) { const a = P[i], b = P[(i + 1) % P.length]; B.face([[...a, 0], [...b, 0], [...b, h], [...a, h]]); }
  B.face(at(P, h));
  return { v: B.v, f: B.f };
}

/**
 * Solid from preset parameters { pts, floors, court, step, roof } (the quick Massing shapes). k: native per foot;
 * ftf: floor-to-floor in native units.
 */
export function fromParams(prm, k, ftf) {
  const m = { ...prm, pts: ccw(prm.pts), ftf };
  const G = massGeom(m, k, k);                 // output-per-foot = native-per-foot → every height in native units
  const B = builder(), T = G.tiers;
  T.forEach((t, ti) => {
    const last = ti === T.length - 1, roof = last ? G.roof : null;
    const top = p => t.h1 + (roof ? roof.at(p[0], p[1]) : 0);
    if (ti === 0) B.face(at(t.ring.slice().reverse(), 0), t.hole ? [at(t.hole.slice().reverse(), 0)] : []);
    const R = t.ring;
    for (let i = 0; i < R.length; i++) {
      const a = R[i], b = R[(i + 1) % R.length];
      const tops = roof && !roof.planar ? breaks(a, b, roof.pieces) : [a, b];
      B.face([[...a, t.h0], [...b, t.h0], ...tops.slice().reverse().map(p => [...p, top(p)])]);
    }
    if (t.hole) for (let i = 0; i < t.hole.length; i++) {
      const a = t.hole[i], b = t.hole[(i + 1) % t.hole.length];
      B.face([[...b, t.h0], [...a, t.h0], [...a, t.h1], [...b, t.h1]]);
    }
    if (roof) for (const pc of roof.pieces) B.face(at(ccw(pc), top));
    else {
      const holes = [];
      if (!last) holes.push(at(T[ti + 1].ring, t.h1)); else if (t.hole) holes.push(at(t.hole, t.h1));
      B.face(at(R, t.h1), holes);
    }
  });
  return { v: B.v, f: B.f };
}
function breaks(a, b, pieces) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy, L = Math.sqrt(L2) || 1, tol = L * 1e-4 + 1e-6, ts = [0, 1];
  for (const pc of pieces) for (const p of pc) {
    const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (L2 || 1);
    if (t > 1e-6 && t < 1 - 1e-6 && Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / L < tol) ts.push(t);
  }
  ts.sort((x, y) => x - y);
  const out = []; for (const t of ts) if (!out.length || t - out[out.length - 1] > 1e-6) out.push(t);
  return out.map(t => [a[0] + dx * t, a[1] + dy * t]);
}

// ---------------------------------------------------------------- editing (all mutate S)
/** Faces that share an edge with face fi. */
function neighbours(S, fi) {
  const E = new Set();
  for (const L of faceLoops(S, fi)) for (let i = 0; i < L.length; i++) { const a = L[i], b = L[(i + 1) % L.length]; E.add(a < b ? `${a},${b}` : `${b},${a}`); }
  const out = [];
  S.f.forEach((f, j) => {
    if (j === fi) return;
    for (const L of [f.o, ...(f.h || [])]) for (let i = 0; i < L.length; i++) { const a = L[i], b = L[(i + 1) % L.length]; if (E.has(a < b ? `${a},${b}` : `${b},${a}`)) { out.push(j); return; } }
  });
  return out;
}
/** Would push/pull of fi just stretch the solid (every neighbour square to it)? */
export function stretches(S, fi) {
  if (isSheet(S)) return false;
  const n = faceNormal(S, fi);
  return neighbours(S, fi).every(j => Math.abs(dot(n, faceNormal(S, j))) < 0.02);
}
/**
 * Push / pull face fi by d (native) along its normal. Faces whose neighbours are all square to them just move
 * (the walls stretch); otherwise — or with makeNew — new side faces are made. A sheet becomes a solid.
 */
export function pushPull(S, fi, d, makeNew = false) {
  if (!d) return S;
  const n = faceNormal(S, fi);
  if (isSheet(S)) {
    if (d < 0) { n[0] = -n[0]; n[1] = -n[1]; n[2] = -n[2]; d = -d; S.f[0].o.reverse(); S.f[0].h?.forEach(h => h.reverse()); }
    S.f.push({ o: S.f[0].o.slice().reverse(), ...(S.f[0].h ? { h: S.f[0].h.map(h => h.slice().reverse()) } : {}) });
  } else if (!makeNew && stretches(S, fi)) {
    for (const i of faceVerts(S, fi)) S.v[i] = add(S.v[i], mul(n, d));
    return S;
  }
  const map = new Map();
  for (const i of faceVerts(S, fi)) { map.set(i, S.v.length); S.v.push(add(S.v[i], mul(n, d))); }
  for (const L of faceLoops(S, fi)) for (let k = 0; k < L.length; k++) {
    const a = L[k], b = L[(k + 1) % L.length];
    S.f.push({ o: [a, b, map.get(b), map.get(a)] });
  }
  const F = S.f[fi];
  F.o = F.o.map(i => map.get(i)); if (F.h) F.h = F.h.map(h => h.map(i => map.get(i)));
  return S;
}
export function moveVerts(S, ids, delta) { for (const i of new Set(ids)) S.v[i] = add(S.v[i], delta); return S; }
export function mapXY(S, fn) { S.v = S.v.map(p => { const q = fn([p[0], p[1]]); return [q[0], q[1], p[2]]; }); return S; }

/** Put a new vertex at p on edge a–b (in every face that uses that edge). Returns its index. */
export function splitEdge(S, a, b, p) {
  const m = S.v.length; S.v.push(p.slice());
  for (const f of S.f) for (const L of [f.o, ...(f.h || [])]) for (let i = 0; i < L.length; i++) {
    const x = L[i], y = L[(i + 1) % L.length];
    if ((x === a && y === b) || (x === b && y === a)) { L.splice(i + 1, 0, m); break; }
  }
  return m;
}
/**
 * Split face fi along a path of vertex indices whose ends are on its outline (interior points already added).
 * Returns the new face's index, or -1.
 */
export function splitFace(S, fi, path) {
  const F = S.f[fi], L = F.o, i0 = L.indexOf(path[0]), i1 = L.indexOf(path[path.length - 1]);
  if (i0 < 0 || i1 < 0 || i0 === i1) return -1;
  const walk = (s, e) => { const out = []; for (let i = s; ; i = (i + 1) % L.length) { out.push(L[i]); if (i === e) break; } return out; };
  const inner = path.slice(1, -1);
  const A = [...walk(i0, i1), ...inner.slice().reverse()], B = [...walk(i1, i0), ...inner];
  if (A.length < 3 || B.length < 3) return -1;
  const Fr = faceFrame(S, fi), poly = Q => Q.map(i => to2(Fr, S.v[i]));
  const pa = poly(A), ha = [], hb = [];
  for (const h of F.h || []) (inPoly2(pa, to2(Fr, S.v[h[0]])) ? ha : hb).push(h);
  S.f[fi] = ha.length ? { o: A, h: ha } : { o: A };
  S.f.push(hb.length ? { o: B, h: hb } : { o: B });
  return S.f.length - 1;
}
/** A new face inside face fi from a closed loop of points on it (fi gets the matching hole). Returns its index. */
export function innerFace(S, fi, pts) {
  const Fr = faceFrame(S, fi);
  let P = pts.map(p => p.slice());
  const q = P.map(p => to2(Fr, p));
  if (sArea2(q) < 0) P = P.reverse();
  const idx = P.map(p => { S.v.push(p); return S.v.length - 1; });
  const F = S.f[fi];
  F.h = [...(F.h || []), idx.slice().reverse()];
  S.f.push({ o: idx });
  return S.f.length - 1;
}
/** Is a point (in the face's plane) inside face fi (outline minus holes)? */
export function inFace(S, fi, p) {
  const Fr = faceFrame(S, fi), q = to2(Fr, p), F = S.f[fi];
  if (!inPoly2(F.o.map(i => to2(Fr, S.v[i])), q)) return false;
  return !(F.h || []).some(h => inPoly2(h.map(i => to2(Fr, S.v[i])), q));
}
export function inPoly2(P, [x, y]) { let c = false; for (let i = 0, j = P.length - 1; i < P.length; j = i++) { const [xi, yi] = P[i], [xj, yj] = P[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c; } return c; }

/**
 * Slope face fi: tilt it along direction dir (in its plane) so it rises `slope` (rise per run) toward dir; the
 * back edge stays put. Its neighbours stretch to follow.
 */
export function slopeFace(S, fi, dir, slope) {
  const n = faceNormal(S, fi), ids = faceVerts(S, fi);
  const d = unit(sub(dir, mul(n, dot(dir, n))));
  const s = ids.map(i => dot(S.v[i], d)), s0 = Math.min(...s);
  ids.forEach((i, k) => { S.v[i] = add(S.v[i], mul(n, (s[k] - s0) * slope)); });
  return S;
}

/**
 * Add or take away a storey at the top of the walls. The cut is the highest vertex level with straight walls just
 * below it (the eaves of a pitched roof, the top of a flat one, the top of a tower on a podium); everything at or
 * above it moves up / down by ftf, so roofs keep their shape. Returns false when a storey can't be removed.
 */
export function shiftTop(S, ftf, dir, tris = solidTris(S)) {
  if (isSheet(S)) return false;
  const levels = [...new Set(S.v.map(p => Math.round(p[2] * 1e4) / 1e4))].filter(z => z > 1e-6).sort((a, b) => b - a);
  let cut = null;
  for (const z of levels) {
    const a1 = slice(S, z - Math.min(0.01 * ftf, z * 0.01), tris).area, a2 = slice(S, z - Math.min(0.5 * ftf, z * 0.5), tris).area;
    if (a1 > 1e-6 && Math.abs(a1 - a2) <= 0.02 * Math.max(a1, a2)) { cut = z; break; }
  }
  if (cut == null) return false;
  const eps = 1e-4 * ftf;
  if (dir < 0) {
    const below = levels.filter(z => z < cut - eps);
    const floor = below.length ? below[0] : 0;
    if (cut - ftf < floor + 0.25 * ftf) return false;          // would sink into the storey below
  }
  for (const p of S.v) if (p[2] >= cut - eps) p[2] += dir * ftf;
  return true;
}

/** Plane through face fi: closest point to a ray (o, d) in solid space, or null. */
export function rayFace(S, fi, o, d) {
  const n = faceNormal(S, fi), p0 = S.v[S.f[fi].o[0]], den = dot(n, d);
  if (Math.abs(den) < 1e-9) return null;
  const t = dot(n, sub(p0, o)) / den;
  return t > 0 ? add(o, mul(d, t)) : null;
}
export { sub, add, mul, cross, len };
