// Drawing snaps for the Sketch and Diagram tools, in plan coordinates (native XY), judged in screen pixels:
// corners (endpoints), midpoints, points on edges, a light pull to the directions of what's already drawn (and the
// grid), alignment with existing corners (dotted guides), and Shift to lock to those directions.
//
// cands: { pts: [{ p, t }], segs: [{ a, b, t }] } — t: a short word for the tooltip ('corner', 'stall', 'parcel'…).

const TOL_END = 10, TOL_MID = 8, TOL_EDGE = 7, TOL_ALIGN = 6;
const AXIS_DEG = 3;                       // light pull toward an existing direction (degrees)

/** Main directions (radians, 0…π/2) of a set of segments, longest first; the grid (0) always included. */
export function frameAngles(segs, max = 4) {
  const bins = new Map();
  for (const s of segs) {
    const L = Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]); if (L < 1e-9) continue;
    let a = Math.atan2(s.b[1] - s.a[1], s.b[0] - s.a[0]) % (Math.PI / 2); if (a < 0) a += Math.PI / 2;
    const k = Math.round(a / (Math.PI / 360)) % 180;            // ½° bins
    bins.set(k, (bins.get(k) || 0) + L);
  }
  const out = [0];
  for (const [k] of [...bins].sort((x, y) => y[1] - x[1])) {
    const a = k * Math.PI / 360;
    if (out.every(b => angDiff(a, b) > Math.PI / 180)) out.push(a);
    if (out.length >= max + 1) break;
  }
  return out;
}
const angDiff = (a, b) => { let d = Math.abs(a - b) % (Math.PI / 2); return Math.min(d, Math.PI / 2 - d); };
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const len = a => Math.hypot(a[0], a[1]);
function nearestOnSeg(p, a, b) {
  const d = sub(b, a), L2 = dot(d, d) || 1, t = Math.max(0, Math.min(1, dot(sub(p, a), d) / L2));
  return [a[0] + d[0] * t, a[1] + d[1] * t];
}
/** The direction (radians, full circle) closest to v among the frames and their right angles. */
function nearestAxis(v, frames) {
  const ang = Math.atan2(v[1], v[0]);
  let best = null;
  for (const f of frames) for (let k = 0; k < 4; k++) {
    const a = f + k * Math.PI / 2;
    let d = Math.abs(((ang - a) % (2 * Math.PI) + 3 * Math.PI) % (2 * Math.PI) - Math.PI);
    if (!best || d < best.d) best = { a, d, f };
  }
  return best;
}

/**
 * Snap cursor c (native XY). opt: { scr(p) → [sx, sy] | null, prev (previous point of the line being drawn),
 * shift (lock to a direction), frames (radians), off (snapping off) }.
 * Returns { p, t: 'corner' | 'mid' | 'edge' | 'axis' | 'align' | 'lock' | null, label, guides: [[a, b]…] }.
 */
export function snap(c, cands, opt) {
  const { scr, prev, frames = [0] } = opt;
  const S = p => scr(p);
  const cs = S(c);
  if (!cs || opt.off) return { p: c, t: null, guides: [] };
  const dpx = p => { const q = S(p); return q ? Math.hypot(q[0] - cs[0], q[1] - cs[1]) : Infinity; };
  // Shift: lock the line from prev to the nearest direction; a corner under the cursor sets its length.
  if (opt.shift && prev) {
    const ax = nearestAxis(sub(c, prev), frames), u = [Math.cos(ax.a), Math.sin(ax.a)];
    let p = [prev[0] + u[0] * dot(sub(c, prev), u), prev[1] + u[1] * dot(sub(c, prev), u)], guide = null;
    let best = null;
    for (const q of cands.pts) { const d = dpx(q.p); if (d < TOL_END && (!best || d < best.d)) best = { d, q }; }
    if (best) { const t = dot(sub(best.q.p, prev), u); p = [prev[0] + u[0] * t, prev[1] + u[1] * t]; guide = [best.q.p, p]; }
    return { p, t: 'lock', label: best ? `locked · from ${best.q.t}` : 'locked', guides: [[prev, p], ...(guide ? [guide] : [])] };
  }
  // Corners, then midpoints.
  let best = null;
  for (const q of cands.pts) { const d = dpx(q.p); if (d < TOL_END && (!best || d < best.d)) best = { d, p: q.p, t: 'corner', label: q.t }; }
  if (best) return { p: best.p.slice(), t: 'corner', label: best.label, guides: [] };
  for (const s of cands.segs) { const m = [(s.a[0] + s.b[0]) / 2, (s.a[1] + s.b[1]) / 2], d = dpx(m); if (d < TOL_MID && (!best || d < best.d)) best = { d, p: m, label: `${s.t} midpoint` }; }
  if (best) return { p: best.p, t: 'mid', label: best.label, guides: [] };
  // Light pull toward the directions already on the site, and alignment with existing corners.
  let p = c, t = null, label = '', guides = [], dir = null;
  if (prev && dpx(prev) > 15) {
    const ax = nearestAxis(sub(c, prev), frames);
    if (ax.d < AXIS_DEG * Math.PI / 180) {
      dir = [Math.cos(ax.a), Math.sin(ax.a)];
      p = [prev[0] + dir[0] * dot(sub(c, prev), dir), prev[1] + dir[1] * dot(sub(c, prev), dir)];
      t = 'axis'; label = ax.f === 0 ? 'square to the grid' : 'parallel / square to the drawing'; guides = [[prev, p]];
    }
  }
  // Align with a corner along a frame direction (an extension line from it).
  const near = cands.pts.filter(q => { const d = dpx(q.p); return d < 400 && d > TOL_END; });
  let al = null;
  for (const f of frames) for (const u of [[Math.cos(f), Math.sin(f)], [-Math.sin(f), Math.cos(f)]]) {
    for (const q of near) {
      // Point on the line through q along u, nearest the cursor (or on the locked line, when there is one).
      let x;
      if (dir) { const den = dir[0] * u[1] - dir[1] * u[0]; if (Math.abs(den) < 1e-6) continue; const w = sub(q.p, prev), s = (w[0] * u[1] - w[1] * u[0]) / den; x = [prev[0] + dir[0] * s, prev[1] + dir[1] * s]; }
      else x = [q.p[0] + u[0] * dot(sub(p, q.p), u), q.p[1] + u[1] * dot(sub(p, q.p), u)];
      const d = dpx(x);
      if (d < TOL_ALIGN && (!al || d < al.d)) al = { d, x, q };
    }
  }
  if (al) { p = al.x; t = 'align'; label = `in line with ${al.q.t}`; guides = [...guides, [al.q.p, al.x]]; }
  if (t) return { p, t, label, guides };
  // On an edge.
  for (const s of cands.segs) { const x = nearestOnSeg(c, s.a, s.b), d = dpx(x); if (d < TOL_EDGE && (!best || d < best.d)) best = { d, p: x, label: `on ${s.t}` }; }
  if (best) return { p: best.p, t: 'edge', label: best.label, guides: [] };
  return { p: c, t: null, guides: [] };
}

/** Snap a moved shape: the corner of `pts` (already moved by delta) closest to a candidate corner pulls it there. */
export function snapMove(pts, cands, scr) {
  let best = null;
  for (const p of pts.slice(0, 64)) {
    const ps = scr(p); if (!ps) continue;
    for (const q of cands.pts) { const qs = scr(q.p); if (!qs) continue; const d = Math.hypot(ps[0] - qs[0], ps[1] - qs[1]); if (d < TOL_END && (!best || d < best.d)) best = { d, dx: q.p[0] - p[0], dy: q.p[1] - p[1], label: q.t, p: q.p }; }
  }
  return best;
}
export { len };
