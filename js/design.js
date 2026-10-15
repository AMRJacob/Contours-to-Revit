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
export const FEATURE_NAMES = { pad: 'Pad', wall: 'Wall', slope: 'Slope' };

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
   * Building pad. geom: { a, b } opposite corners. p: { elev (null = ground at centre), ratio (H:V), rot, k }.
   * Inside: flat at elev. Outside: fill slopes down / cut slopes up at 1:ratio until they meet the ground.
   */
  _pad(D, base, geom, p) {
    const r = (p.rot || 0) * Math.PI / 180;
    const ex = [Math.cos(r), -Math.sin(r)], ey = [Math.sin(r), Math.cos(r)];
    const o = geom.a;
    const loc = (x, y) => [(x - o[0]) * ex[0] + (y - o[1]) * ex[1], (x - o[0]) * ey[0] + (y - o[1]) * ey[1]];
    const [ub, vb] = loc(...geom.b);
    const u0 = Math.min(0, ub), u1 = Math.max(0, ub), v0 = Math.min(0, vb), v1 = Math.max(0, vb);
    const corners = Design.padCorners(geom, p.rot);
    const cx = (geom.a[0] + geom.b[0]) / 2, cy = (geom.a[1] + geom.b[1]) / 2;
    const elev = Number.isFinite(p.elev) ? p.elev : this.sample(this.g.z, cx, cy) + this.sample(D, cx, cy);
    if (!Number.isFinite(elev)) return null;
    const [lo, hi] = this.zRange;
    const R = Math.min((Math.max(Math.abs(elev - lo), Math.abs(elev - hi)) + 30) * p.ratio / p.k, 2000 / p.k);
    const xs = corners.map(c => c[0]), ys = corners.map(c => c[1]);
    const E = this.g.z;
    this._forBox(Math.min(...xs) - R, Math.min(...ys) - R, Math.max(...xs) + R, Math.max(...ys) + R, (k, x, y) => {
      const [u, v] = loc(x, y);
      const du = Math.max(u0 - u, 0, u - u1), dv = Math.max(v0 - v, 0, v - v1);
      const dist = Math.hypot(du, dv) * p.k;
      const b = base(k);
      let z = b;
      if (!dist) z = elev;
      else {
        const zf = elev - dist / p.ratio, zc = elev + dist / p.ratio;
        if (b < zf) z = zf; else if (b > zc) z = zc;
      }
      if (z !== b) D[k] = z - E[k];
    });
    return { corners, elev, w: (u1 - u0) * p.k, h: (v1 - v0) * p.k };
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
    const reach = (p.height + 4) * p.ratio / p.k + p.shelf / p.k + half + 2 * this.g.s;
    const E = this.g.z;
    this._forBox(Math.min(ax, bx) - reach, Math.min(ay, by) - reach, Math.max(ax, bx) + reach, Math.max(ay, by) + reach, (k, x, y) => {
      const t = (x - ax) * dx + (y - ay) * dy;
      const sd = (x - ax) * nxv + (y - ay) * nyv;
      const endOver = (t < 0 ? -t : t > L ? t - L : 0) * p.k;
      const foot = footAt(t);
      if (!Number.isFinite(foot)) return;
      const b = base(k);
      let z = b;
      if (p.mode === 'cut') {
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
    const at = t => { const f = footAt(t); return p.mode === 'cut' ? { tw: f, bw: f - p.height } : { tw: f + p.height, bw: f }; };
    return { ends: [at(0), at(L / 2), at(L)], len: L * p.k };
  }

  /** Slope run a→b: corridor `width` wide graded to fall `slope` (rise/run) from a toward b. p: { slope, startElev, width, soft, k } */
  _slope(D, base, baseAt, geom, p) {
    const [ax, ay] = geom.a, [bx, by] = geom.b;
    const L = Math.hypot(bx - ax, by - ay) || 1e-9;
    const dx = (bx - ax) / L, dy = (by - ay) / L;
    const half = p.width / 2 / p.k;
    const zA = Number.isFinite(p.startElev) ? p.startElev : baseAt(ax, ay);
    if (!Number.isFinite(zA)) return null;
    const E = this.g.z;
    this._forBox(Math.min(ax, bx) - half, Math.min(ay, by) - half, Math.max(ax, bx) + half, Math.max(ay, by) + half, (k, x, y) => {
      const t = (x - ax) * dx + (y - ay) * dy;
      const perp = Math.abs(-(x - ax) * dy + (y - ay) * dx);
      let w = falloff(perp / half, p.soft);
      const over = t < 0 ? -t : t > L ? t - L : 0;
      if (over) w *= falloff(over / half, p.soft);
      if (!w) return;
      const tgt = zA - p.slope * Math.max(0, Math.min(L, t)) * p.k;
      const b = base(k);
      D[k] = b + (tgt - b) * w - E[k];
    });
    return { zA, zB: zA - p.slope * L * p.k, len: L * p.k };
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
  const major = [], minor = [];
  if (!levels.length) return { major, minor };
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
        const out = isMajor(L) ? major : minor;
        for (const [ea, eb] of pairs) { const p = ex(ea), q = ex(eb); out.push(p[0], p[1], q[0], q[1]); }
      }
    }
  }
  return { major, minor };
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
