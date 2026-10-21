// Contours to Revit — clean building massing.
// Goal: buildings that read right from a distance (site plans, aerial diagrams, rendering backgrounds), not survey
// detail: square footprints, level decks, simple roofs. Footprints come from the best available source, heights
// from lidar where measured, else the datasets.

const ANG_TOL = 15 * Math.PI / 180;          // edges within 15° of the main axes are squared up

const area2 = R => { let a = 0; for (let i = 0, k = R.length - 1; i < R.length; k = i++) a += (R[k][0] + R[i][0]) * (R[k][1] - R[i][1]); return a / 2; };
export const polyArea = R => Math.abs(area2(R));

export function inRing(r, x, y) {
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
  }
  return c;
}

/** Main direction of a footprint (radians, 0…π/2): length-weighted average of edge angles modulo 90°. */
export function dominantAngle(R) {
  let sx = 0, sy = 0;
  for (let i = 0; i < R.length; i++) {
    const [ax, ay] = R[i], [bx, by] = R[(i + 1) % R.length];
    const L = Math.hypot(bx - ax, by - ay); if (!L) continue;
    const a = Math.atan2(by - ay, bx - ax) * 4;      // ×4: directions 90° apart coincide
    sx += Math.cos(a) * L; sy += Math.sin(a) * L;
  }
  let t = Math.atan2(sy, sx) / 4;
  if (t < 0) t += Math.PI / 2;
  return t;
}

function dp(pts, tol) {
  if (pts.length < 3) return pts;
  const [ax, ay] = pts[0], [bx, by] = pts[pts.length - 1], L = Math.hypot(bx - ax, by - ay) || 1e-9;
  let mi = 0, md = -1;
  for (let i = 1; i < pts.length - 1; i++) { const d = Math.abs((bx - ax) * (ay - pts[i][1]) - (ax - pts[i][0]) * (by - ay)) / L; if (d > md) { md = d; mi = i; } }
  if (md <= tol) return [pts[0], pts[pts.length - 1]];
  return dp(pts.slice(0, mi + 1), tol).slice(0, -1).concat(dp(pts.slice(mi), tol));
}
/** Douglas–Peucker for a closed ring. */
export function simplifyClosed(R, tol) {
  if (R.length < 5) return R.slice();
  let far = 0, fd = -1;
  for (let i = 1; i < R.length; i++) { const d = Math.hypot(R[i][0] - R[0][0], R[i][1] - R[0][1]); if (d > fd) { fd = d; far = i; } }
  const a = dp(R.slice(0, far + 1), tol), b = dp(R.slice(far).concat([R[0]]), tol);
  return a.slice(0, -1).concat(b.slice(0, -1));
}

/**
 * Square up a footprint: simplify (tol in native units), rotate so the main direction is the x axis, make edges
 * within 15° of an axis exactly horizontal/vertical (merging runs of them), rotate back. Diagonal walls stay.
 */
export function orthogonalize(R, tol, angle = dominantAngle(R)) {
  let P = simplifyClosed(R, tol);
  if (P.length < 4) return R.slice();
  const c = Math.cos(angle), s = Math.sin(angle);
  let cx = 0, cy = 0; for (const [x, y] of P) { cx += x; cy += y; } cx /= P.length; cy /= P.length;
  const F = P.map(([x, y]) => [(x - cx) * c + (y - cy) * s, -(x - cx) * s + (y - cy) * c]);
  const n = F.length;
  // Classify each edge: 'h', 'v' or 'd' (diagonal).
  const kind = F.map((p, i) => {
    const q = F[(i + 1) % n], a = Math.atan2(q[1] - p[1], q[0] - p[0]);
    const m = ((a % Math.PI) + Math.PI) % Math.PI;
    if (m < ANG_TOL || m > Math.PI - ANG_TOL) return 'h';
    if (Math.abs(m - Math.PI / 2) < ANG_TOL) return 'v';
    return 'd';
  });
  // Each squared edge becomes a line at the length-weighted average coordinate; corners are line intersections.
  const lines = F.map((p, i) => {
    const q = F[(i + 1) % n];
    if (kind[i] === 'h') return { k: 'h', y: (p[1] + q[1]) / 2, p, q };
    if (kind[i] === 'v') return { k: 'v', x: (p[0] + q[0]) / 2, p, q };
    return { k: 'd', p, q };
  });
  // Merge consecutive edges of the same kind (h,h or v,v) into one line.
  const merged = [];
  for (const L of lines) {
    const prev = merged[merged.length - 1];
    if (prev && prev.k === L.k && L.k !== 'd') {
      const lp = Math.hypot(prev.q[0] - prev.p[0], prev.q[1] - prev.p[1]), lq = Math.hypot(L.q[0] - L.p[0], L.q[1] - L.p[1]);
      if (L.k === 'h') prev.y = (prev.y * lp + L.y * lq) / (lp + lq || 1); else prev.x = (prev.x * lp + L.x * lq) / (lp + lq || 1);
      prev.q = L.q;
    } else merged.push({ ...L });
  }
  if (merged.length > 1 && merged[0].k === merged[merged.length - 1].k && merged[0].k !== 'd') {
    const last = merged.pop(), first = merged[0];
    if (first.k === 'h') first.y = (first.y + last.y) / 2; else first.x = (first.x + last.x) / 2;
    first.p = last.p;
  }
  if (merged.length < 3) return R.slice();
  const meet = (A, B) => {
    if (A.k === 'h' && B.k === 'v') return [B.x, A.y];
    if (A.k === 'v' && B.k === 'h') return [A.x, B.y];
    if (A.k === B.k && A.k !== 'd') return A.k === 'h' ? [A.q[0], A.y] : [A.x, A.q[1]];
    // With a diagonal: intersect the two lines (squared line as a horizontal/vertical through its coordinate).
    const seg = L => L.k === 'h' ? [[0, L.y], [1, L.y]] : L.k === 'v' ? [[L.x, 0], [L.x, 1]] : [L.p, L.q];
    const [[x1, y1], [x2, y2]] = seg(A), [[x3, y3], [x4, y4]] = seg(B);
    const d = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
    if (Math.abs(d) < 1e-9) return A.q;
    const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / d;
    return [x1 + t * (x2 - x1), y1 + t * (y2 - y1)];
  };
  const out = merged.map((L, i) => meet(merged[(i - 1 + merged.length) % merged.length], L));
  // Drop near-duplicate corners and tiny jogs.
  const clean = [];
  for (const p of out) { const q = clean[clean.length - 1]; if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > tol * 0.5) clean.push(p); }
  if (clean.length > 3 && Math.hypot(clean[0][0] - clean[clean.length - 1][0], clean[0][1] - clean[clean.length - 1][1]) <= tol * 0.5) clean.pop();
  if (clean.length < 3) return R.slice();
  const back = clean.map(([u, v]) => [cx + u * c - v * s, cy + u * s + v * c]);
  // Guard against a squared outline that drifted: keep it only if the area is within 25 % of the original.
  const a0 = polyArea(R), a1 = polyArea(back);
  return a1 > a0 * 0.75 && a1 < a0 * 1.25 ? back : R.slice();
}

/** Flat-topped prism (walls, roof, bottom) as { v, f }; tris(ring) gives triangles over the ring. */
export function prismMass(ring, base, top, tris) {
  const v = [], f = [], n = ring.length;
  ring.forEach(([x, y]) => v.push([x, y, base]));
  ring.forEach(([x, y]) => v.push([x, y, top]));
  for (let i = 0; i < n; i++) { const j = (i + 1) % n; f.push([i, j, n + j, n + i]); }
  for (const [a, b, c] of tris(ring)) { f.push([n + a, n + b, n + c]); f.push([c, b, a]); }
  return { v, f };
}

/** Append mass B into mass A (index offset). */
export function mergeMass(A, B) {
  const o = A.v.length;
  for (const p of B.v) A.v.push(p);
  for (const fc of B.f) A.f.push(fc.map(i => i + o));
  return A;
}

/** Sutherland–Hodgman clip of a polygon by the half-plane a·u + b·v + c ≥ 0 (frame coordinates). */
export function clipHalf(P, a, b, c) {
  const out = [], n = P.length;
  for (let i = 0; i < n; i++) {
    const p = P[i], q = P[(i + 1) % n];
    const fp = a * p[0] + b * p[1] + c, fq = a * q[0] + b * q[1] + c;
    if (fp >= 0) out.push(p);
    if ((fp >= 0) !== (fq >= 0)) { const t = fp / (fp - fq); out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]); }
  }
  return out;
}

/**
 * One combined building layer: OpenStreetMap footprints (hand-mapped) first, then Microsoft footprints that don't
 * duplicate them; FEMA/ORNL footprints only on sites where neither has any. A footprint that would swallow several already-chosen
 * ones (a merged blob) is skipped. Footprints without a height borrow the best overlapping dataset height.
 */
export function combineBuildings(ctx) {
  // FEMA/ORNL footprints include buildings that have since been demolished, so they are only used when neither
  // OpenStreetMap nor Microsoft has any footprint on the site (their heights can still be borrowed below).
  const hasNewer = (ctx.bldgOsm || []).length + (ctx.bldgMs || []).length > 0;
  const srcs = [['bldgOsm', ctx.bldgOsm || []], ['bldgMs', ctx.bldgMs || []], ...(hasNewer ? [] : [['buildings', ctx.buildings || []]])];
  const femaHeights = (ctx.buildings || []).filter(b => b.ring?.length >= 3 && b.heightKnown);
  const samples = R => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of R) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    const pts = [];
    for (let i = 1; i <= 5; i++) for (let j = 1; j <= 5; j++) { const x = x0 + (x1 - x0) * i / 6, y = y0 + (y1 - y0) * j / 6; if (inRing(R, x, y)) pts.push([x, y]); }
    return { pts, box: [x0, y0, x1, y1] };
  };
  const overlap = (A, B) => { // share of A's sample points inside B
    if (!A.s.pts.length) return 0;
    const [ax0, ay0, ax1, ay1] = A.s.box, [bx0, by0, bx1, by1] = B.s.box;
    if (ax1 < bx0 || bx1 < ax0 || ay1 < by0 || by1 < ay0) return 0;
    let n = 0; for (const [x, y] of A.s.pts) if (inRing(B.b.ring, x, y)) n++;
    return n / A.s.pts.length;
  };
  const all = srcs.flatMap(([key, list]) => list.filter(b => b.ring?.length >= 3).map(b => ({ key, b, s: samples(b.ring) })));
  const donors = hasNewer ? all.concat(femaHeights.map(b => ({ key: 'buildings', b, s: samples(b.ring) }))) : all;
  const chosen = [];
  for (const [key] of srcs) {
    for (const it of all.filter(a => a.key === key)) {
      if (chosen.some(c => overlap(it, c) > 0.4)) continue;     // already mapped by a better source
      const swallowed = chosen.filter(c => overlap(c, it) > 0.6).length;
      if (swallowed >= 2) continue;              // a blob over several mapped buildings
      if (swallowed === 1 && key !== 'bldgOsm') continue;
      chosen.push(it);
    }
  }
  return chosen.map(it => {
    const b = { ...it.b, combinedFrom: it.key };
    delete b.mass; delete b.roof; delete b.wall; delete b.ringTop; delete b.roofAt; delete b.hSrc;
    if (!b.heightKnown) {
      // Borrow: FEMA/ORNL first (lidar-derived where ORNL had lidar), then OSM tags, then Microsoft's estimate.
      for (const key of ['buildings', 'bldgOsm', 'bldgMs']) {
        const best = donors.filter(o => o.key === key && o.b.heightKnown && o.b !== it.b).map(o => [overlap(it, o), o]).filter(([v]) => v > 0.3).sort((p, q) => q[0] - p[0])[0];
        if (best) { b.top = b.base + (best[1].b.top - best[1].b.base); b.heightKnown = true; b.heightFrom = key; break; }
      }
    }
    return b;
  });
}
