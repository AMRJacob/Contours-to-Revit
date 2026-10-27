// Diagram annotations: arrows, lines, regions and labels that lie on the ground, on a building face, or stand
// upright from it. Geometry is built in a uniform space (output units on every axis) so widths and heights are
// true, then handed back in display coordinates [x native, y native, z as drawn].
//
// note: { id, type: 'arrow' | 'line' | 'region' | 'label', on: 'ground' | 'mass', mid (mass id), pts, n (face
//         normal, solid space, for 'mass'), color (scheme key or #hex), w (ft), stand (bool), h (ft), curve (bool),
//         op (fill opacity), text }
import earcut from '../lib/earcut.js';

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

export const NOTE_TYPES = ['arrow', 'line', 'region', 'label'];
export const WIDTHS = { arrow: [4, 8, 16], line: [1, 2, 4] };       // ft: small / medium / large

/** Smooth a polyline through its points (Catmull–Rom), any dimension. */
export function smooth(P, per = 10) {
  if (P.length < 3) return P.map(p => p.slice());
  const out = [], n = P.length, D = P[0].length;
  for (let i = 0; i < n - 1; i++) {
    const p0 = P[Math.max(0, i - 1)], p1 = P[i], p2 = P[i + 1], p3 = P[Math.min(n - 1, i + 2)];
    for (let k = 0; k < per; k++) {
      const t = k / per, t2 = t * t, t3 = t2 * t;
      out.push(Array.from({ length: D }, (_, d) => 0.5 * (2 * p1[d] + (-p0[d] + p2[d]) * t + (2 * p0[d] - 5 * p1[d] + 4 * p2[d] - p3[d]) * t2 + (-p0[d] + 3 * p1[d] - 3 * p2[d] + p3[d]) * t3)));
    }
  }
  out.push(P[n - 1].slice());
  return out;
}
/** Points every `step` (or closer) along a polyline. */
function densify(P, step, closed = false) {
  const out = [], n = P.length;
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const a = P[i], b = P[(i + 1) % n], L = Math.hypot(...sub3(b, a)), k = Math.max(1, Math.ceil(L / step));
    for (let j = 0; j < k; j++) out.push(a.map((v, d) => v + (b[d] - v) * j / k));
  }
  if (!closed) out.push(P[n - 1].slice());
  return out;
}
const sub3 = (b, a) => b.map((v, d) => v - a[d]);

/**
 * Geometry of a note. env: { U(p): note point → uniform [x, y, z] (output units), D(u): uniform → display point,
 * N: surface normal (uniform), ground (bool: re-drape flat geometry on the terrain), drape(u) → u with z on the
 * ground (+ lift), ft: output units per foot, step: densify step (anchor units), stepU: the same in uniform units }.
 * Returns { outline: [display points] (closed, as seen flat), tris: [display] × 3k, edges: [[a, b]…] (display) }.
 */
export function noteGeom(note, env, flat = false) {
  const stand = note.stand && !flat, ft = env.ft, N = env.N;
  if (note.type === 'label') return { outline: [], tris: [], edges: [] };
  const raw = note.type !== 'region' && note.curve && note.pts.length > 2 ? smooth(note.pts) : note.pts;
  const anchor = densify(raw, env.step, note.type === 'region');
  const C = anchor.map(env.U);
  const lift = 0.35 * ft;
  const tris = [], edges = [];
  const put = (a, b, c) => tris.push(a, b, c);
  const fin = u => (env.ground && !stand ? env.drape(u) : u);
  if (note.type === 'region') {
    if (C.length < 3) return { outline: [], tris: [], edges: [] };
    const Nn = N, ax = unit(Math.abs(Nn[2]) > 0.9 ? [1, 0, 0] : cross([0, 0, 1], Nn)), ay = cross(Nn, ax);
    const flat2 = []; for (const u of C) flat2.push(dot(u, ax), dot(u, ay));
    const off = u => add(u, mul(Nn, lift));
    const T = earcut(flat2);
    const top = stand ? (note.h || 30) * ft : 0;
    const raise = u => add(u, mul(Nn, top + lift));
    for (let k = 0; k < T.length; k += 3) {
      const a = C[T[k]], b = C[T[k + 1]], c = C[T[k + 2]];
      if (env.ground && !stand) subdivide(a, b, c, env.stepU * 2, (p, q, r) => put(fin(off(p)), fin(off(q)), fin(off(r))));
      else put(raise(a), raise(b), raise(c));
    }
    if (stand) for (let i = 0; i < C.length; i++) {
      const a = C[i], b = C[(i + 1) % C.length], A = env.ground ? env.drape(a) : off(a), B = env.ground ? env.drape(b) : off(b);
      put(A, B, raise(b)); put(A, raise(b), raise(a));
      edges.push([raise(a), raise(b)]);
    }
    const outline = C.map(u => fin(off(u)));
    for (let i = 0; i < outline.length; i++) edges.push([outline[i], outline[(i + 1) % outline.length]]);
    return { outline: outline.map(env.D), tris: tris.map(env.D), edges: edges.map(([a, b]) => [env.D(a), env.D(b)]) };
  }
  // Arrows and lines: a ribbon along the path, w wide; an arrow ends in a head.
  if (C.length < 2) return { outline: [], tris: [], edges: [] };
  const w = (note.w || (note.type === 'arrow' ? 8 : 2)) * ft;
  const s = [0]; for (let i = 1; i < C.length; i++) s.push(s[i - 1] + Math.hypot(...sub(C[i], C[i - 1])));
  const Lt = s[s.length - 1]; if (Lt < 1e-6) return { outline: [], tris: [], edges: [] };
  const head = note.type === 'arrow' ? Math.min(w * 2.6, Lt * 0.45) : 0, headW = note.type === 'arrow' ? w * 2.6 : w;
  const at = t => { let i = 1; while (i < s.length - 1 && s[i] < t) i++; const f = (t - s[i - 1]) / ((s[i] - s[i - 1]) || 1); return add(C[i - 1], mul(sub(C[i], C[i - 1]), f)); };
  const tan = i => unit(sub(C[Math.min(C.length - 1, i + 1)], C[Math.max(0, i - 1)]));
  const side = (p, t) => (stand ? N : unit(cross(N, t)));
  const hfLift = stand ? headW / 2 + lift : lift;
  const L = [], R = [];
  const sEnd = Lt - head;
  for (let i = 0; i < C.length && s[i] <= sEnd + 1e-9; i++) { const t = tan(i), sd = side(C[i], t), c = add(C[i], mul(N, stand ? hfLift : lift)); L.push(add(c, mul(sd, w / 2))); R.push(add(c, mul(sd, -w / 2))); }
  const cb = at(sEnd), ib = Math.min(C.length - 1, s.findIndex(v => v >= sEnd)), tb = tan(Math.max(0, ib)), sb = side(cb, tb), cbl = add(cb, mul(N, stand ? hfLift : lift));
  if (!L.length || Math.hypot(...sub(cbl, sub(L[L.length - 1], mul(sb, w / 2)))) > 1e-6) { L.push(add(cbl, mul(sb, w / 2))); R.push(add(cbl, mul(sb, -w / 2))); }
  for (let i = 0; i < L.length - 1; i++) { put(fin(R[i]), fin(R[i + 1]), fin(L[i + 1])); put(fin(R[i]), fin(L[i + 1]), fin(L[i])); }
  let outline = [...R];
  if (head > 0) {
    const tip = add(C[C.length - 1], mul(N, stand ? hfLift : lift)), hl = add(cbl, mul(sb, headW / 2)), hr = add(cbl, mul(sb, -headW / 2));
    put(fin(hr), fin(tip), fin(hl));
    outline.push(hr, tip, hl);
  }
  outline.push(...L.slice().reverse());
  outline = outline.map(fin);
  for (let i = 0; i < outline.length; i++) edges.push([outline[i], outline[(i + 1) % outline.length]]);
  if (stand && note.type === 'line') {      // a line stood up is a fence / screen panel
    tris.length = 0; edges.length = 0;
    const h = (note.h || 20) * ft, base = C.map(u => (env.ground ? env.drape(u) : add(u, mul(N, lift))));
    for (let i = 0; i < base.length - 1; i++) { const a = base[i], b = base[i + 1], A = add(a, mul(N, h)), B = add(b, mul(N, h)); put(a, b, B); put(a, B, A); }
    edges.push([add(base[0], mul(N, h)), add(base[base.length - 1], mul(N, h))]);
    for (let i = 0; i < base.length - 1; i++) edges.push([add(base[i], mul(N, h)), add(base[i + 1], mul(N, h))]);
  }
  return { outline: outline.map(env.D), tris: tris.map(env.D), edges: edges.map(([a, b]) => [env.D(a), env.D(b)]) };
}
/** Split a triangle until its edges are shorter than maxLen, so it follows the ground. */
function subdivide(a, b, c, maxLen, out, depth = 0) {
  const lab = Math.hypot(a[0] - b[0], a[1] - b[1]), lbc = Math.hypot(b[0] - c[0], b[1] - c[1]), lca = Math.hypot(c[0] - a[0], c[1] - a[1]);
  const m = Math.max(lab, lbc, lca);
  if (m <= maxLen || depth > 7) { out(a, b, c); return; }
  const mid = (p, q) => p.map((v, i) => (v + q[i]) / 2);
  if (m === lab) { const d = mid(a, b); subdivide(a, d, c, maxLen, out, depth + 1); subdivide(d, b, c, maxLen, out, depth + 1); }
  else if (m === lbc) { const d = mid(b, c); subdivide(a, b, d, maxLen, out, depth + 1); subdivide(a, d, c, maxLen, out, depth + 1); }
  else { const d = mid(c, a); subdivide(a, b, d, maxLen, out, depth + 1); subdivide(d, b, c, maxLen, out, depth + 1); }
}
