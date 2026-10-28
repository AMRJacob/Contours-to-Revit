// Sketch massing geometry: a block is an outline extruded floor by floor, with optional courtyard (a ring), one
// step-back (upper floors inset from a chosen floor) and a roof form (flat, gable, hip, shed). Shapes: box, circle,
// L, U and courtyard presets — after drawing, every block is just an outline you can reshape.
import { dominantAngle, wingRects, wingRoof, wingShape, convexHalfplanes } from './massing.js?v=0.54.0';
import { insetPoly } from './parking.js?v=0.54.0';

export const area = P => { let a = 0; for (let i = 0, j = P.length - 1; i < P.length; j = i++) a += P[j][0] * P[i][1] - P[i][0] * P[j][1]; return Math.abs(a) / 2; };
const sArea = P => { let a = 0; for (let i = 0, j = P.length - 1; i < P.length; j = i++) a += P[j][0] * P[i][1] - P[i][0] * P[j][1]; return a / 2; };
export const inPoly = (P, x, y) => { let c = false; for (let i = 0, j = P.length - 1; i < P.length; j = i++) { const [xi, yi] = P[i], [xj, yj] = P[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c; } return c; };
export const ROOFS = [['flat', 'Flat'], ['gable', 'Gable'], ['hip', 'Hip'], ['shed', 'Shed']];

/** An inset that kept its shape (same turn direction, smaller, every corner inside the original). */
function goodInset(P, Q) {
  if (!Q || Q.length !== P.length) return false;
  const a = sArea(P), b = sArea(Q);
  if (Math.sign(a) !== Math.sign(b) || Math.abs(b) >= Math.abs(a) || Math.abs(b) < Math.abs(a) * 0.02) return false;
  return Q.every(p => inPoly(P, p[0], p[1]));
}

/**
 * Geometry of a block (native XY, heights in output units above the block's base).
 * k: native units per foot; o: output units per foot.
 * Returns { tiers: [{ ring, hole|null, h0, h1, floors }], roof: { pieces: [[native pts]…], at(x,y) } | null, gfaArea (native²·floors) }.
 */
export function massGeom(m, k, o) {
  const P = m.pts, H = m.floors * m.ftf;
  let hole = m.court > 0 ? insetPoly(P, m.court * k) : null;
  if (hole && !goodInset(P, hole)) hole = null;
  const tiers = [];
  const st = m.step;
  if (st && st.at > 0 && st.at < m.floors && st.inset > 0) {
    const up = insetPoly(P, st.inset * k);
    const upHole = hole && st.inset < m.court ? hole : null;
    if (goodInset(P, up) && (!hole || upHole)) {
      tiers.push({ ring: P, hole, h0: 0, h1: st.at * m.ftf, floors: st.at });
      tiers.push({ ring: up, hole: upHole, h0: st.at * m.ftf, h1: H, floors: m.floors - st.at });
    }
  }
  if (!tiers.length) tiers.push({ ring: P, hole, h0: 0, h1: H, floors: m.floors });
  const top = tiers[tiers.length - 1];
  const roof = !top.hole && m.roof && m.roof.type !== 'flat' ? roofOf(top.ring, m.roof, (m.roof.pitch || 6) / 12 * o / k) : null;
  let fa = 0;
  for (const t of tiers) fa += (area(t.ring) - (t.hole ? area(t.hole) : 0)) * t.floors;
  return { tiers, roof, fa };
}

/** Roof pieces over outline R; s = output height per native unit of run. */
function roofOf(R, roof, s) {
  const a = dominantAngle(R), c = Math.cos(a), sn = Math.sin(a);
  let cx = 0, cy = 0; for (const [x, y] of R) { cx += x; cy += y; } cx /= R.length; cy /= R.length;
  const toF = (x, y) => [(x - cx) * c + (y - cy) * sn, -(x - cx) * sn + (y - cy) * c];
  const fromF = (u, v) => [cx + u * c - v * sn, cy + u * sn + v * c];
  const RF = R.map(p => toF(...p));
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (const [u, v] of RF) { if (u < u0) u0 = u; if (u > u1) u1 = u; if (v < v0) v0 = v; if (v > v1) v1 = v; }
  if (roof.type === 'shed') {
    // One plane rising across the short side (flip turns it around).
    const alongU = u1 - u0 >= v1 - v0, flip = roof.flip ? -1 : 1;
    const h = (u, v) => s * (alongU ? (flip > 0 ? v - v0 : v1 - v) : (flip > 0 ? u - u0 : u1 - u));
    return { pieces: [R.slice()], at: (x, y) => h(...toF(x, y)), planar: true };
  }
  const mode = roof.type === 'hip' ? 'hip' : 'long';
  let wings = wingRects(RF, 1e-3 * Math.max(1, u1 - u0)), clip = [];
  if (!wings) {
    clip = convexHalfplanes(RF);
    if (!clip) return null;                       // concave and not square: stays flat
    wings = [{ u0, u1, v0, v1 }];
  }
  const shape = wingShape(wings, mode);
  const pieces = wingRoof(wings, mode, clip).map(pc => pc.poly.map(([u, v]) => fromF(u, v)));
  return { pieces, at: (x, y) => s * shape(...toF(x, y)) };
}

/** Top height (above base) of a block at native (x, y): NaN outside it or over the courtyard. */
export function heightAt(G, x, y) {
  for (let i = G.tiers.length - 1; i >= 0; i--) {
    const t = G.tiers[i];
    if (!inPoly(t.ring, x, y)) continue;
    if (t.hole && inPoly(t.hole, x, y)) return NaN;
    return t.h1 + (i === G.tiers.length - 1 && G.roof ? G.roof.at(x, y) : 0);
  }
  return NaN;
}

/**
 * Triangles of a block: push(a, b, c) with [x, y, h] corners (h above base, true scale), line(a, b) for floor lines.
 * tri: polygon triangulator (indices).
 */
export function massMesh(m, G, tri, push, line) {
  const T = G.tiers;
  T.forEach((t, ti) => {
    const last = ti === T.length - 1;
    const wallTop = p => t.h1 + (last && G.roof ? G.roof.at(p[0], p[1]) : 0);
    // Outer walls; under a pitched roof each wall follows the roof edge (gable peaks included).
    const R = t.ring, n = R.length;
    for (let i = 0; i < n; i++) {
      const a = R[i], b = R[(i + 1) % n];
      const pts = last && G.roof && !G.roof.planar ? edgeBreaks(a, b, G.roof.pieces) : [a, b];
      for (let j = 0; j < pts.length - 1; j++) {
        const p = pts[j], q = pts[j + 1], hp = wallTop(p), hq = wallTop(q);
        push([...p, t.h0], [...q, t.h0], [...q, hq]);
        push([...p, t.h0], [...q, hq], [...p, hp]);
      }
    }
    if (t.hole) {
      const Hh = t.hole;
      for (let i = 0; i < Hh.length; i++) {
        const a = Hh[i], b = Hh[(i + 1) % Hh.length];
        push([...a, t.h0], [...a, t.h1], [...b, t.h1]); push([...a, t.h0], [...b, t.h1], [...b, t.h0]);
      }
      for (let i = 0; i < n; i++) {               // ring roof: strips between the outline and the courtyard
        const j = (i + 1) % n;
        push([...R[i], t.h1], [...R[j], t.h1], [...Hh[j], t.h1]); push([...R[i], t.h1], [...Hh[j], t.h1], [...Hh[i], t.h1]);
      }
    } else if (last && G.roof) {
      // Hip / gable pieces are convex: fan them (they can carry collinear corners an ear-clipper rejects).
      const fan = P => Array.from({ length: Math.max(0, P.length - 2) }, (_, i) => [0, i + 1, i + 2]);
      for (const pc of G.roof.pieces) for (const [i, j, k] of (G.roof.planar ? tri(pc) : fan(pc))) push([...pc[i], t.h1 + G.roof.at(...pc[i])], [...pc[j], t.h1 + G.roof.at(...pc[j])], [...pc[k], t.h1 + G.roof.at(...pc[k])]);
    } else for (const [i, j, k] of tri(R)) push([...R[i], t.h1], [...R[j], t.h1], [...R[k], t.h1]);
    // Floor lines on the walls.
    for (let f = 1; f < t.floors; f++) {
      const h = t.h0 + f * m.ftf;
      for (const ring of [R, t.hole].filter(Boolean)) for (let i = 0; i < ring.length; i++) line([...ring[i], h], [...ring[(i + 1) % ring.length], h]);
    }
  });
}

/** Points along a→b where roof pieces have corners on that edge (so walls follow ridges and valleys). */
function edgeBreaks(a, b, pieces) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy, L = Math.sqrt(L2) || 1, tol = L * 1e-4 + 1e-6;
  const ts = [0, 1];
  for (const pc of pieces) for (const p of pc) {
    const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (L2 || 1);
    if (t <= 1e-6 || t >= 1 - 1e-6) continue;
    const d = Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / L;
    if (d < tol) ts.push(t);
  }
  ts.sort((x, y) => x - y);
  const out = [];
  for (const t of ts) if (!out.length || t - out[out.length - 1] > 1e-6) out.push(t);
  return out.map(t => [a[0] + dx * t, a[1] + dy * t]);
}

/** Preset outlines from a dragged box (a = where the drag started, b = where it ended). */
export function presetShape(shape, a, b, segs = 24) {
  const x0 = Math.min(a[0], b[0]), x1 = Math.max(a[0], b[0]), y0 = Math.min(a[1], b[1]), y1 = Math.max(a[1], b[1]);
  const w = x1 - x0, h = y1 - y0;
  if (shape === 'circle') {
    const r = Math.hypot(b[0] - a[0], b[1] - a[1]);
    return Array.from({ length: segs }, (_, i) => [a[0] + r * Math.cos(i / segs * 2 * Math.PI), a[1] + r * Math.sin(i / segs * 2 * Math.PI)]);
  }
  // Mirror so the shape's corner sits at the drag start.
  const fx = a[0] <= b[0] ? (x => x) : (x => x0 + x1 - x), fy = a[1] <= b[1] ? (y => y) : (y => y0 + y1 - y);
  const t = Math.min(w, h) * 0.4;
  let P;
  if (shape === 'L') P = [[x0, y0], [x1, y0], [x1, y0 + t], [x0 + t, y0 + t], [x0 + t, y1], [x0, y1]];
  else if (shape === 'U') { const u = Math.min(w * 0.3, h * 0.5); P = [[x0, y0], [x1, y0], [x1, y1], [x1 - u, y1], [x1 - u, y0 + u], [x0 + u, y0 + u], [x0 + u, y1], [x0, y1]]; }
  else P = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  P = P.map(([x, y]) => [fx(x), fy(y)]);
  if (sArea(P) < 0) P.reverse();
  return P;
}
