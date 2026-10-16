// Site design: proposed surface = existing grid + brush layer + editable features (pads, walls, slope runs).
// Features stay editable: the surface is rebuilt from them whenever anything changes. Nothing is baked in.
// XY are native State Plane units of the site's grid; Z and all heights/elevations are output units (ft or m).
// `k` (in feature params) = output units per native XY unit.

/** Brush weight for normalized distance d (0 centre .. 1 edge); `soft` 0 = hard edge, 1 = fully feathered. */
export function falloff(d, soft) {
  if (d >= 1) return 0;
  const h = 1 - Math.max(0.02, Math.min(1, soft));
  if (d <= h) return 1;
  const t = (d - h) / (1 - h);
  return 0.5 * (1 + Math.cos(Math.PI * t));
}

let nextId = 1;
export const FEATURE_NAMES = { pad: 'Pad', wall: 'Wall', slope: 'Slope', swale: 'Swale' };

export class Design {
  /** grid: {x0, y0, s, nx, ny, z} existing surface (left untouched). */
  constructor(grid) {
    this.g = grid;
    const n = grid.nx * grid.ny;
    this.brush = new Float32Array(n);         // sculpted change (brushes)
    this.delta = new Float32Array(n);         // total change = brush + features
    this.z = Float32Array.from(grid.z);       // proposed = existing + delta
    this.features = [];                       // [{id, type, geom, p, out}]
    this.undo = [];
    this.redo = [];
    this.stroke = null;
    this.stale = false;                       // features need re-applying after brush edits
    this.version = 0;
    this.dirty = null;
    let lo = Infinity, hi = -Infinity;
    for (const v of grid.z) { if (v < lo) lo = v; if (v > hi) hi = v; }
    this.zRange = [lo, hi];
  }

  get changed() { return this.features.length > 0 || this.brush.some(v => v !== 0); }
  grid() { return { ...this.g, z: this.z }; }

  _markDirty(i0, j0, i1, j1) {
    const d = this.dirty;
    this.dirty = d ? { i0: Math.min(d.i0, i0), j0: Math.min(d.j0, j0), i1: Math.max(d.i1, i1), j1: Math.max(d.j1, j1) } : { i0, j0, i1, j1 };
  }
  _allDirty() { this._markDirty(0, 0, this.g.nx - 1, this.g.ny - 1); this.version++; }

  /** Bilinear sample of an array on the grid at native (x, y); NaN outside. */
  sample(arr, x, y) {
    const { x0, y0, s, nx, ny } = this.g;
    const fx = (x - x0) / s, fy = (y - y0) / s;
    const i = Math.floor(fx), j = Math.floor(fy);
    if (i < 0 || j < 0 || i >= nx - 1 || j >= ny - 1) return NaN;
    const tx = fx - i, ty = fy - j, k = j * nx + i;
    return (arr[k] * (1 - tx) + arr[k + 1] * tx) * (1 - ty) + (arr[k + nx] * (1 - tx) + arr[k + nx + 1] * tx) * ty;
  }
  existingAt(x, y) { return this.sample(this.g.z, x, y); }
  proposedAt(x, y) { return this.sample(this.z, x, y); }

  // ----- Undo (snapshots of brush layer + features) -----
  _snap() { return { b: Float32Array.from(this.brush), f: JSON.stringify(this.features.map(({ out, ...r }) => r)) }; }
  checkpoint() {
    this.undo.push(this._snap());
    if (this.undo.length > 30) this.undo.shift();
    this.redo = [];
  }
  _restore(s) { this.brush = Float32Array.from(s.b); this.features = JSON.parse(s.f); this.rebuild(); }
  doUndo() { if (!this.undo.length) return false; this.redo.push(this._snap()); this._restore(this.undo.pop()); return true; }
  doRedo() { if (!this.redo.length) return false; this.undo.push(this._snap()); this._restore(this.redo.pop()); return true; }
  reset() {
    if (!this.changed) return false;
    this.checkpoint();
    this.brush.fill(0); this.features = [];
    this.rebuild();
    return true;
  }

  // ----- Saving -----
  serialize() { return { v: 2, brush: this.brush, features: this.features.map(({ out, ...r }) => r) }; }
  /** Restore { brush, features } (v2) or a bare delta array (older saves). */
  load(saved) {
    const b = saved?.brush || saved?.delta || saved;
    if (!b || b.length !== this.brush.length) return false;
    this.brush = Float32Array.from(b);
    this.features = saved.v === 2 ? (saved.features || []) : [];
    for (const f of this.features) nextId = Math.max(nextId, (f.id || 0) + 1);
    this.rebuild();
    return true;
  }

  // ----- Brushes (edit the brush layer) -----
  /** tool: 'raise' | 'lower' | 'flatten' | 'smooth'. p: { amount, target, soft, radius (native), strength } */
  begin(tool, p) {
    this.checkpoint();
    this.stroke = { tool, p, start: Float32Array.from(this.brush), w: new Float32Array(this.brush.length), hit: false };
  }

  dab(cx, cy) {
    const st = this.stroke;
    if (!st) return;
    const { x0, y0, s, nx, ny } = this.g;
    const R = st.p.radius;
    const i0 = Math.max(0, Math.floor((cx - R - x0) / s)), i1 = Math.min(nx - 1, Math.ceil((cx + R - x0) / s));
    const j0 = Math.max(0, Math.floor((cy - R - y0) / s)), j1 = Math.min(ny - 1, Math.ceil((cy + R - y0) / s));
    if (i0 > i1 || j0 > j1) return;
    const E = this.g.z, B = this.brush, W = st.w, S = st.start, soft = st.p.soft;
    const plain = !this.features.length;
    if (st.tool === 'smooth') {
      // Blend each node toward the mean of its 3x3 neighbourhood (existing + brush).
      const k = Math.max(0.05, Math.min(1, st.p.strength ?? 0.5));
      const r0 = Math.max(0, j0 - 1), r1 = Math.min(ny - 1, j1 + 1);
      const src = new Float32Array((r1 - r0 + 1) * nx);
      for (let j = r0; j <= r1; j++) for (let i = 0; i < nx; i++) src[(j - r0) * nx + i] = E[j * nx + i] + B[j * nx + i];
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const w = falloff(Math.hypot(x0 + i * s - cx, y0 + j * s - cy) / R, soft) * k;
        const idx = j * nx + i;
        if (!w || Number.isNaN(E[idx])) continue;
        let acc = 0, n = 0;
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
          const ii = i + di, jj = j + dj;
          if (ii < 0 || jj < r0 || ii >= nx || jj > r1) continue;
          const v = src[(jj - r0) * nx + ii];
          if (!Number.isNaN(v)) { acc += v; n++; }
        }
        if (!n) continue;
        const cur = E[idx] + B[idx];
        B[idx] = cur + (acc / n - cur) * w - E[idx];
        if (plain) { this.delta[idx] = B[idx]; this.z[idx] = E[idx] + B[idx]; }
      }
    } else {
      const amt = st.p.amount || 0, T = st.p.target;
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const w = falloff(Math.hypot(x0 + i * s - cx, y0 + j * s - cy) / R, soft);
        const idx = j * nx + i;
        if (w <= W[idx] || Number.isNaN(E[idx])) continue;
        W[idx] = w;
        let d;
        if (st.tool === 'raise') d = S[idx] + amt * w;
        else if (st.tool === 'lower') d = S[idx] - amt * w;
        else d = S[idx] + ((T - E[idx]) - S[idx]) * w;
        B[idx] = d;
        if (plain) { this.delta[idx] = d; this.z[idx] = E[idx] + d; }
      }
    }
    st.hit = true;
    if (plain) { this._markDirty(i0, j0, i1, j1); this.version++; } else this.stale = true;
  }

  end() {
    const st = this.stroke;
    this.stroke = null;
    if (!st) return false;
    if (!st.hit) { this.undo.pop(); return false; }
    if (this.stale) this.rebuild();
    return true;
  }

  // ----- Features -----
  addFeature(type, geom, p) {
    this.checkpoint();
    const f = { id: nextId++, type, geom, p };
    this.features.push(f);
    this.rebuild();
    return f;
  }
  feature(id) { return this.features.find(f => f.id === id); }
  /** Change a feature's geometry and/or params. Call checkpoint() first when starting an edit gesture. */
  updateFeature(id, patch) {
    const f = this.feature(id);
    if (!f) return null;
    if (patch.geom) f.geom = { ...f.geom, ...patch.geom };
    if (patch.p) f.p = { ...f.p, ...patch.p };
    this.rebuild();
    return f;
  }
  removeFeature(id) {
    const i = this.features.findIndex(f => f.id === id);
    if (i < 0) return false;
    this.checkpoint();
    this.features.splice(i, 1);
    this.rebuild();
    return true;
  }

  /** Recompute the proposed surface: brush layer, then each feature in order over the result so far. */
  rebuild() {
    const E = this.g.z;
    const D = Float32Array.from(this.brush);
    for (const f of this.features) {
      const cur = Float32Array.from(D); // surface before this feature
      const base = k => E[k] + cur[k];
      const baseAt = (x, y) => this.sample(E, x, y) + this.sample(cur, x, y);
      try {
        f.out = f.type === 'pad' ? this._pad(D, base, f.geom, f.p)
          : f.type === 'wall' ? this._wall(D, base, baseAt, f.geom, f.p)
          : f.type === 'swale' ? this._swale(D, base, baseAt, f.geom, f.p)
          : this._slope(D, base, baseAt, f.geom, f.p);
      } catch { f.out = null; }
    }
    this.delta = D;
    for (let k = 0; k < D.length; k++) this.z[k] = E[k] + D[k];
    this.stale = false;
    this._allDirty();
  }

  _forBox(xmin, ymin, xmax, ymax, fn) {
    const { x0, y0, s, nx, ny } = this.g;
    const i0 = Math.max(0, Math.floor((xmin - x0) / s)), i1 = Math.min(nx - 1, Math.ceil((xmax - x0) / s));
    const j0 = Math.max(0, Math.floor((ymin - y0) / s)), j1 = Math.min(ny - 1, Math.ceil((ymax - y0) / s));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const k = j * nx + i;
      if (Number.isNaN(this.g.z[k])) continue;
      fn(k, x0 + i * s, y0 + j * s);
    }
  }

  /** Pad rectangle corners (native) in the project frame (rot = project-north bearing, ° cw from grid north). */
  static padCorners(geom, rot = 0) {
    const r = rot * Math.PI / 180;
    const ex = [Math.cos(r), -Math.sin(r)], ey = [Math.sin(r), Math.cos(r)];
    const o = geom.a;
    const ub = (geom.b[0] - o[0]) * ex[0] + (geom.b[1] - o[1]) * ex[1];
    const vb = (geom.b[0] - o[0]) * ey[0] + (geom.b[1] - o[1]) * ey[1];
    const P = (u, v) => [o[0] + u * ex[0] + v * ey[0], o[1] + u * ex[1] + v * ey[1]];
    return [P(0, 0), P(ub, 0), P(ub, vb), P(0, vb)];
  }

  /**
   * Outline of a pad as a closed polygon (native XY, no repeated last point).
   * geom: { shape: 'rect', a, b } (default) | { shape: 'poly', pts, smooth } | { shape: 'circle', c, r }.
   */
  static padOutline(geom, rot = 0) {
    if (geom.shape === 'circle') {
      const n = 72, out = [];
      for (let i = 0; i < n; i++) { const t = i / n * Math.PI * 2; out.push([geom.c[0] + geom.r * Math.cos(t), geom.c[1] + geom.r * Math.sin(t)]); }
      return out;
    }
    if (geom.shape === 'poly') return geom.smooth ? smoothClosed(geom.pts, 14) : geom.pts.map(q => q.slice());
    return Design.padCorners(geom, rot);
  }

  /**
   * Building pad of any outline. p: { elev (null = ground at centre), ratio (H:V), rot, k }.
   * Inside: flat at elev. Outside: fill slopes down / cut slopes up at 1:ratio until they meet the ground.
   */
  _pad(D, base, geom, p) {
    const poly = Design.padOutline(geom, p.rot);
    if (poly.length < 3) return null;
    const n = poly.length;
    let A = 0, cx = 0, cy = 0;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const cr = poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
      A += cr; cx += (poly[j][0] + poly[i][0]) * cr; cy += (poly[j][1] + poly[i][1]) * cr;
    }
    if (Math.abs(A) < 1e-9) return null;
    cx /= 3 * A; cy /= 3 * A;
    const elev = Number.isFinite(p.elev) ? p.elev : this.sample(this.g.z, cx, cy) + this.sample(D, cx, cy);
    if (!Number.isFinite(elev)) return null;
    const [lo, hi] = this.zRange;
    const R = Math.min((Math.max(Math.abs(elev - lo), Math.abs(elev - hi)) + 30) * p.ratio / p.k, 2000 / p.k);
    const xs = poly.map(c => c[0]), ys = poly.map(c => c[1]);
    const E = this.g.z;
    const inside = (x, y) => {
      let c = false;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const [xi, yi] = poly[i], [xj, yj] = poly[j];
        if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
      }
      return c;
    };
    const edgeDist = (x, y) => {
      let best = Infinity;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const [ax, ay] = poly[j], [bx, by] = poly[i];
        const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
        const t = L2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2)) : 0;
        const d2 = (ax + t * dx - x) ** 2 + (ay + t * dy - y) ** 2;
        if (d2 < best) best = d2;
      }
      return Math.sqrt(best);
    };
    const bx0 = Math.min(...xs), bx1 = Math.max(...xs), by0 = Math.min(...ys), by1 = Math.max(...ys);
    this._forBox(bx0 - R, by0 - R, bx1 + R, by1 + R, (k, x, y) => {
      const b = base(k);
      // Cheap lower bound on the distance: to the outline's bounding box. If the ground already lies inside the
      // daylight cone at that distance it is untouched, so the exact edge distance isn't needed.
      const dBox = Math.hypot(Math.max(bx0 - x, 0, x - bx1), Math.max(by0 - y, 0, y - by1)) * p.k;
      if (dBox > 0 && Math.abs(b - elev) <= dBox / p.ratio) return;
      const dist = (dBox === 0 && inside(x, y)) ? 0 : edgeDist(x, y) * p.k;
      let z = b;
      if (!dist) z = elev;
      else {
        const zf = elev - dist / p.ratio, zc = elev + dist / p.ratio;
        if (b < zf) z = zf; else if (b > zc) z = zc;
      }
      if (z !== b) D[k] = z - E[k];
    });
    return { outline: poly, elev, area: Math.abs(A) / 2 * p.k * p.k, w: (Math.max(...xs) - Math.min(...xs)) * p.k, h: (Math.max(...ys) - Math.min(...ys)) * p.k };
  }

  /**
   * Retaining wall a→b. p: { height, thick, side 'left'|'right' (high side looking a→b),
   * mode 'fill' (raise the high side to a level shelf, then 1:ratio down) | 'cut' (lower the low side), shelf, ratio, k }.
   */
  _wall(D, base, baseAt, geom, p) {
    const [ax, ay] = geom.a, [bx, by] = geom.b;
    const L = Math.hypot(bx - ax, by - ay) || 1e-9;
    const dx = (bx - ax) / L, dy = (by - ay) / L;
    const sg = p.side === 'right' ? -1 : 1;
    const nxv = -dy * sg, nyv = dx * sg;
    const half = p.thick / 2 / p.k;
    const footAt = t => { const tt = Math.max(0, Math.min(L, t)); return baseAt(ax + dx * tt, ay + dy * tt); };
    const setMode = p.elevMode === 'set';
    const fin = v => Number.isFinite(v) ? v : null;
    const tw0 = fin(p.tw0), tw1 = fin(p.tw1) ?? tw0, bw0 = fin(p.bw0), bw1 = fin(p.bw1) ?? bw0;
    // Missing values follow the ground: TW = ground + height, BW = ground.
    const twAt = (f, foot) => tw0 == null ? foot + p.height : tw0 + (tw1 - tw0) * f;
    const bwAt = (f, foot) => bw0 == null ? foot : bw0 + (bw1 - bw0) * f;
    let span = p.height + 4;
    if (setMode) for (const v of [tw0, tw1, bw0, bw1]) if (v != null) span = Math.max(span, Math.abs(v - this.zRange[0]) + 4, Math.abs(v - this.zRange[1]) + 4);
    const reach = Math.min(span * p.ratio / p.k + Math.max(p.shelf, p.front ?? 5) / p.k + half + 2 * this.g.s, 1500 / p.k);
    const E = this.g.z;
    this._forBox(Math.min(ax, bx) - reach, Math.min(ay, by) - reach, Math.max(ax, bx) + reach, Math.max(ay, by) + reach, (k, x, y) => {
      const t = (x - ax) * dx + (y - ay) * dy;
      const sd = (x - ax) * nxv + (y - ay) * nyv;
      const endOver = (t < 0 ? -t : t > L ? t - L : 0) * p.k;
      const foot = footAt(t);
      if (!Number.isFinite(foot)) return;
      const b = base(k);
      let z = b;
      if (setMode) {
        // Set top / bottom of wall (linear between the ends): high side graded to TW, low side to BW,
        // each held level for its shelf width, then daylighting both ways to existing at 1:ratio.
        const f = Math.max(0, Math.min(1, t / L));
        const TW = twAt(f, foot), BW = bwAt(f, foot);
        if (Math.abs(sd) <= half && !endOver) z = TW;
        else if (sd > half || sd < -half) {
          const hiSide = sd > half;
          const T = hiSide ? TW : BW, sh = hiSide ? p.shelf : (p.front ?? 5);
          const d = ((hiSide ? sd : -sd) - half) * p.k;
          const dist = Math.max(0, d - sh) + endOver;
          const zf = T - dist / p.ratio, zc = T + dist / p.ratio;
          z = b < zf ? zf : b > zc ? zc : b;
        }
      } else if (p.mode === 'cut') {
        if (Math.abs(sd) <= half && !endOver) z = foot;
        else if (sd < -half) {
          const d = (-sd - half) * p.k;
          z = Math.min(b, foot - p.height + Math.max(0, d - p.shelf) / p.ratio + endOver / p.ratio);
        }
      } else {
        const top = foot + p.height;
        if (Math.abs(sd) <= half && !endOver) z = Math.max(b, top);
        else if (sd > half) {
          const d = (sd - half) * p.k;
          z = Math.max(b, top - Math.max(0, d - p.shelf) / p.ratio - endOver / p.ratio);
        }
      }
      if (z !== b) D[k] = z - E[k];
    });
    const at = t => {
      const f = footAt(t);
      if (setMode) { const u = Math.max(0, Math.min(1, t / L)); return { tw: twAt(u, f), bw: bwAt(u, f) }; }
      return p.mode === 'cut' ? { tw: f, bw: f - p.height } : { tw: f + p.height, bw: f };
    };
    return { ends: [at(0), at(L / 2), at(L)], len: L * p.k };
  }

  /** Points of a run's centre line: { a, b } (straight) or { pts, smooth } (polyline / curve). */
  static pathPoints(geom) {
    if (geom.pts?.length >= 2) return geom.smooth && geom.pts.length > 2 ? smoothOpen(geom.pts, 12) : geom.pts.map(q => q.slice());
    return [geom.a, geom.b];
  }

  /**
   * Measure a path for nearest-point queries. Returns { pts, cum (station at each vertex), len, at(x, y) → { s, d, over } }
   * where s = station (native, clamped to the path), d = perpendicular distance, over = distance beyond an end.
   */
  static measure(pts) {
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    const len = cum.at(-1) || 1e-9;
    // Segment boxes let most segments be skipped once a close one is found.
    const nseg = pts.length - 1, sb = new Float64Array(nseg * 4);
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay] = pts[i - 1], [bx, by] = pts[i], o = (i - 1) * 4;
      sb[o] = Math.min(ax, bx); sb[o + 1] = Math.min(ay, by); sb[o + 2] = Math.max(ax, bx); sb[o + 3] = Math.max(ay, by);
    }
    const at = (x, y) => {
      let best = Infinity, bs = 0, bover = 0;
      for (let i = 1; i < pts.length; i++) {
        const o = (i - 1) * 4;
        const ex = x < sb[o] ? sb[o] - x : x > sb[o + 2] ? x - sb[o + 2] : 0, ey = y < sb[o + 1] ? sb[o + 1] - y : y > sb[o + 3] ? y - sb[o + 3] : 0;
        if (ex * ex + ey * ey >= best && i !== 1 && i !== pts.length - 1) continue;
        const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
        const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
        let t = L2 ? ((x - ax) * dx + (y - ay) * dy) / L2 : 0;
        let over = 0;
        const L = Math.sqrt(L2);
        if (t < 0) { if (i === 1) over = -t * L; t = 0; }
        if (t > 1) { if (i === pts.length - 1) over = (t - 1) * L; t = 1; }
        const d2 = (ax + t * dx - x) ** 2 + (ay + t * dy - y) ** 2;
        if (d2 < best) { best = d2; bs = cum[i - 1] + t * L; bover = over; }
      }
      const d = Math.sqrt(best);
      return { s: bs, d: bover ? Math.sqrt(Math.max(0, best - bover * bover)) : d, over: bover };
    };
    return { pts, cum, len, at };
  }

  /** Bounding box of points, grown by r. */
  static bbox(pts, r) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of pts) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
    return [x0 - r, y0 - r, x1 + r, y1 + r];
  }

  /**
   * Slope run along a path (straight, polyline or curve): corridor `width` wide graded to fall `slope` (rise/run)
   * from the start, measured along the path. p: { slope, startElev, width, soft, k }
   */
  _slope(D, base, baseAt, geom, p) {
    const pts = Design.pathPoints(geom);
    const P = Design.measure(pts);
    const half = p.width / 2 / p.k;
    const zA = Number.isFinite(p.startElev) ? p.startElev : baseAt(...pts[0]);
    if (!Number.isFinite(zA)) return null;
    const m = p.slope;
    const mode = p.mode || 'exact';
    // Profile along the path. 'exact': uniform fall. 'max': follow the ground, never steeper than m (up or down).
    // 'min': always fall at least m; follow the ground where it falls faster (up to 3:1), cut where it is flatter.
    const ds = Math.max(this.g.s / 2, P.len / 4000);
    const n = Math.max(1, Math.ceil(P.len / ds)), step = P.len / n;
    const prof = new Float64Array(n + 1);
    let seg = 1;
    const ptAt = sv => {
      while (seg < pts.length - 1 && P.cum[seg] < sv) seg++;
      const a = pts[seg - 1], b = pts[seg], L = (P.cum[seg] - P.cum[seg - 1]) || 1, t = (sv - P.cum[seg - 1]) / L;
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    };
    prof[0] = zA;
    let steep = 0, flat = Infinity;
    for (let i = 1; i <= n; i++) {
      const sv = i * step, dz = m * step * p.k;
      let z;
      if (mode === 'exact') z = zA - m * sv * p.k;
      else {
        let g = baseAt(...ptAt(sv));
        if (!Number.isFinite(g)) g = prof[i - 1] - (mode === 'min' ? dz : 0);
        if (mode === 'max') z = Math.max(prof[i - 1] - dz, Math.min(prof[i - 1] + dz, g));
        else z = prof[i - 1] - Math.max(dz, Math.min(prof[i - 1] - g, step * p.k / 3));
      }
      prof[i] = z;
      const gr = Math.abs(z - prof[i - 1]) / (step * p.k);
      steep = Math.max(steep, gr); flat = Math.min(flat, (prof[i - 1] - z) / (step * p.k));
    }
    const zAtS = sv => { const f = Math.max(0, Math.min(n, sv / step)), i = Math.floor(f), t = f - i; return i >= n ? prof[n] : prof[i] + (prof[i + 1] - prof[i]) * t; };
    const E = this.g.z;
    const [bx0, by0, bx1, by1] = Design.bbox(pts, half);
    this._forBox(bx0, by0, bx1, by1, (k, x, y) => {
      const q = P.at(x, y);
      let w = falloff(q.d / half, p.soft);
      if (q.over) w *= falloff(q.over / half, p.soft);
      if (!w) return;
      const tgt = zAtS(q.s);
      const b = base(k);
      D[k] = b + (tgt - b) * w - E[k];
    });
    return { zA, zB: prof[n], len: P.len * p.k, path: pts, mode, steep, flat: Number.isFinite(flat) ? flat : m };
  }

  /**
   * Swale along a path. Flowline falls `slope` from the start (startElev = flowline at the start; blank = ground − depth).
   * Rounded (parabolic) channel `width` wide (top) and `depth` deep, cut or filled to shape, then side slopes at
   * 1:ratio back to existing grade. Ends taper over half a width. p: { slope, startElev, width, depth, ratio, k }
   */
  _swale(D, base, baseAt, geom, p) {
    const pts = Design.pathPoints(geom);
    const P = Design.measure(pts);
    const half = p.width / 2 / p.k;
    const depth = Math.max(0.05, p.depth || 1);
    const fA = Number.isFinite(p.startElev) ? p.startElev : baseAt(...pts[0]) - depth;
    if (!Number.isFinite(fA)) return null;
    const [lo, hi] = this.zRange;
    const reach = half + Math.min((Math.max(Math.abs(fA - lo), Math.abs(fA - hi)) + depth + 10) * p.ratio / p.k, 400 / p.k);
    const E = this.g.z;
    const [bx0, by0, bx1, by1] = Design.bbox(pts, reach);
    this._forBox(bx0, by0, bx1, by1, (k, x, y) => {
      const m = P.at(x, y);
      if (m.over > half) return;
      const flow = fA - p.slope * m.s * p.k;
      const top = flow + depth;
      const b = base(k);
      let z;
      if (m.d <= half) {
        const r = m.d / half;
        z = flow + depth * r * r;
      } else {
        // Beyond the top of bank: side slopes up (cut) or down (fill) at 1:ratio until they meet the ground.
        const dist = (m.d - half) * p.k;
        const zc = top + dist / p.ratio, zf = top - dist / p.ratio;
        if (b <= zc && b >= zf) return;
        z = b > zc ? zc : zf;
      }
      // Taper the ends so the channel opens out instead of stopping at a wall.
      if (m.over) { const w = falloff(m.over / half, 0.8); z = b + (z - b) * w; }
      D[k] = z - E[k];
    });
    return { fA, fB: fA - p.slope * P.len * p.k, len: P.len * p.k, depth, path: pts };
  }

  /** Earthwork from the total change grid. cellArea in (output units)^2. */
  earthwork(cellArea) {
    let cut = 0, fill = 0, maxCut = 0, maxFill = 0, n = 0;
    for (const d of this.delta) {
      if (!d || Number.isNaN(d) || Math.abs(d) < 1e-4) continue;
      n++;
      if (d > 0) { fill += d; if (d > maxFill) maxFill = d; } else { cut -= d; if (-d > maxCut) maxCut = -d; }
    }
    return { cut: cut * cellArea, fill: fill * cellArea, maxCut, maxFill, area: n * cellArea };
  }
}

/**
 * Fast marching squares for display: line segments only (no joining), as flat [x1,y1,x2,y2,...] arrays,
 * split into index (major) and intermediate (minor) levels. Native coordinates.
 */
export function contourSegments(g, levels, isMajor) {
  const { nx, ny, z, x0, y0, s } = g;
  const major = [], minor = [], majorLv = [];
  if (!levels.length) return { major, minor, majorLv };
  const lo = levels[0], step = levels.length > 1 ? levels[1] - levels[0] : 1;
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const k = j * nx + i;
      const bl = z[k], br = z[k + 1], tl = z[k + nx], tr = z[k + nx + 1];
      if (Number.isNaN(bl) || Number.isNaN(br) || Number.isNaN(tl) || Number.isNaN(tr)) continue;
      const mn = Math.min(bl, br, tl, tr), mx = Math.max(bl, br, tl, tr);
      const a = Math.max(0, Math.ceil((mn - lo) / step - 1e-9)), b = Math.min(levels.length - 1, Math.floor((mx - lo) / step + 1e-9));
      for (let li = a; li <= b; li++) {
        const L = levels[li];
        const c = (bl >= L ? 1 : 0) | (br >= L ? 2 : 0) | (tr >= L ? 4 : 0) | (tl >= L ? 8 : 0);
        if (c === 0 || c === 15) continue;
        const ex = e => {
          switch (e) {
            case 0: return [x0 + (i + (L - bl) / (br - bl)) * s, y0 + j * s];
            case 1: return [x0 + (i + 1) * s, y0 + (j + (L - br) / (tr - br)) * s];
            case 2: return [x0 + (i + (L - tl) / (tr - tl)) * s, y0 + (j + 1) * s];
            default: return [x0 + i * s, y0 + (j + (L - bl) / (tl - bl)) * s];
          }
        };
        let pairs = SEGS[c];
        if (c === 5 || c === 10) {
          const up = (bl + br + tl + tr) / 4 >= L;
          pairs = c === 5 ? (up ? [[0, 1], [2, 3]] : [[3, 0], [1, 2]]) : (up ? [[3, 0], [1, 2]] : [[0, 1], [2, 3]]);
        }
        const mj = isMajor(L), out = mj ? major : minor;
        for (const [ea, eb] of pairs) { const p = ex(ea), q = ex(eb); out.push(p[0], p[1], q[0], q[1]); if (mj) majorLv.push(L); }
      }
    }
  }
  return { major, minor, majorLv };
}

/** Open Catmull-Rom curve through pts (passes through every point), `per` samples per span. */
export function smoothOpen(pts, per = 12) {
  const n = pts.length;
  if (n < 3) return pts.map(q => q.slice());
  const P = i => pts[Math.max(0, Math.min(n - 1, i))];
  const out = [];
  for (let i = 0; i < n - 1; i++) {
    const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
    for (let s = 0; s < per; s++) {
      const t = s / per, t2 = t * t, t3 = t2 * t;
      out.push([0, 1].map(c => 0.5 * (2 * p1[c] + (-p0[c] + p2[c]) * t + (2 * p0[c] - 5 * p1[c] + 4 * p2[c] - p3[c]) * t2 + (-p0[c] + 3 * p1[c] - 3 * p2[c] + p3[c]) * t3)));
    }
  }
  out.push(pts[n - 1].slice());
  return out;
}

/** Closed Catmull-Rom curve through pts, `per` samples per span. */
export function smoothClosed(pts, per = 12) {
  const n = pts.length;
  if (n < 3) return pts.map(q => q.slice());
  const out = [];
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
    for (let s = 0; s < per; s++) {
      const t = s / per, t2 = t * t, t3 = t2 * t;
      out.push([0, 1].map(c => 0.5 * (2 * p1[c] + (-p0[c] + p2[c]) * t + (2 * p0[c] - 5 * p1[c] + 4 * p2[c] - p3[c]) * t2 + (-p0[c] + 3 * p1[c] - 3 * p2[c] + p3[c]) * t3)));
    }
  }
  return out;
}

const SEGS = {
  1: [[3, 0]], 2: [[0, 1]], 3: [[3, 1]], 4: [[1, 2]], 6: [[0, 2]], 7: [[3, 2]],
  8: [[2, 3]], 9: [[0, 2]], 11: [[1, 2]], 12: [[3, 1]], 13: [[0, 1]], 14: [[3, 0]],
};

/** Per-site storage key (IndexedDB), from the grid's position and size. */
export function designKey(g, zoneCode) {
  return `design:${zoneCode}:${g.x0.toFixed(2)}:${g.y0.toFixed(2)}:${g.s.toFixed(4)}:${g.nx}x${g.ny}`;
}

/** Float32Array <-> base64 for design files. */
export function f32ToB64(a) {
  const u = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s);
}
export function b64ToF32(b64) {
  const s = atob(b64), u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return new Float32Array(u.buffer);
}
