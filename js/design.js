// Site design: a proposed surface = existing grid + an editable elevation change (delta), sculpted with brushes.
// All XY are native State Plane units of the site's grid; Z is in output units (ft or m), like site.grid.

/** Brush weight for normalized distance d (0 centre .. 1 edge); `soft` 0 = hard edge, 1 = fully feathered. */
export function falloff(d, soft) {
  if (d >= 1) return 0;
  const h = 1 - Math.max(0.02, Math.min(1, soft));
  if (d <= h) return 1;
  const t = (d - h) / (1 - h);
  return 0.5 * (1 + Math.cos(Math.PI * t));
}

export class Design {
  /** grid: {x0, y0, s, nx, ny, z} existing surface (left untouched). */
  constructor(grid) {
    this.g = grid;
    const n = grid.nx * grid.ny;
    this.delta = new Float32Array(n);
    this.z = Float32Array.from(grid.z);      // proposed = existing + delta
    this.undo = [];
    this.redo = [];
    this.stroke = null;
    this.version = 0;                         // bumps on every change (for redraw throttling)
    this.dirty = null;                        // node bbox changed since last raster refresh {i0,j0,i1,j1}
  }

  get changed() { return this.delta.some(v => v !== 0); }

  /** Proposed grid object usable by contourLines / sampling. */
  grid() { return { ...this.g, z: this.z }; }

  _markDirty(i0, j0, i1, j1) {
    const d = this.dirty;
    this.dirty = d ? { i0: Math.min(d.i0, i0), j0: Math.min(d.j0, j0), i1: Math.max(d.i1, i1), j1: Math.max(d.j1, j1) } : { i0, j0, i1, j1 };
  }

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

  /**
   * Start a stroke. tool: 'raise' | 'lower' | 'flatten' | 'smooth'.
   * p: { amount (output units), target (output units, flatten), soft (0..1), radius (native units), strength (smooth 0..1) }
   * Within one stroke raise/lower/flatten never compound: each node moves by at most `amount` (or to `target`),
   * using the strongest brush weight the stroke passed over it. Repeated strokes stack.
   */
  begin(tool, p) {
    this.stroke = { tool, p, start: Float32Array.from(this.delta), w: new Float32Array(this.delta.length), bbox: null };
  }

  /** Apply the brush at native (cx, cy). */
  dab(cx, cy) {
    const st = this.stroke;
    if (!st) return;
    const { x0, y0, s, nx, ny } = this.g;
    const R = st.p.radius;
    const i0 = Math.max(0, Math.floor((cx - R - x0) / s)), i1 = Math.min(nx - 1, Math.ceil((cx + R - x0) / s));
    const j0 = Math.max(0, Math.floor((cy - R - y0) / s)), j1 = Math.min(ny - 1, Math.ceil((cy + R - y0) / s));
    if (i0 > i1 || j0 > j1) return;
    const E = this.g.z, D = this.delta, Z = this.z, W = st.w, S = st.start;
    const soft = st.p.soft;
    if (st.tool === 'smooth') {
      // Blend each node toward the mean of its 3x3 neighbourhood (proposed surface), weighted by the brush.
      const k = Math.max(0.05, Math.min(1, st.p.strength ?? 0.5));
      const src = Z.slice(Math.max(0, (j0 - 1) * nx), Math.min(Z.length, (j1 + 2) * nx));
      const off = Math.max(0, (j0 - 1) * nx);
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const w = falloff(Math.hypot(x0 + i * s - cx, y0 + j * s - cy) / R, soft) * k;
        if (!w) continue;
        let acc = 0, n = 0;
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
          const ii = i + di, jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
          const v = src[jj * nx + ii - off];
          if (Number.isNaN(v)) continue;
          acc += v; n++;
        }
        const idx = j * nx + i;
        if (!n || Number.isNaN(E[idx])) continue;
        const nz = Z[idx] + (acc / n - Z[idx]) * w;
        D[idx] = nz - E[idx];
        Z[idx] = nz;
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
        else d = S[idx] + ((T - E[idx]) - S[idx]) * w; // flatten toward target elevation
        D[idx] = d;
        Z[idx] = E[idx] + d;
      }
    }
    const b = st.bbox;
    st.bbox = b ? { i0: Math.min(b.i0, i0), j0: Math.min(b.j0, j0), i1: Math.max(b.i1, i1), j1: Math.max(b.j1, j1) } : { i0, j0, i1, j1 };
    this._markDirty(i0, j0, i1, j1);
    this.version++;
  }

  /** Finish the stroke; records an undo step if anything changed. */
  end() {
    const st = this.stroke;
    this.stroke = null;
    if (!st || !st.bbox) return false;
    this._pushUndo(st.start);
    return true;
  }

  _pushUndo(prev) {
    this.undo.push(prev);
    if (this.undo.length > 25) this.undo.shift();
    this.redo = [];
  }

  _setDelta(d) {
    this.delta = d;
    const E = this.g.z;
    for (let k = 0; k < d.length; k++) this.z[k] = E[k] + d[k];
    this._markDirty(0, 0, this.g.nx - 1, this.g.ny - 1);
    this.version++;
  }

  doUndo() { if (!this.undo.length) return false; this.redo.push(this.delta); this._setDelta(this.undo.pop()); return true; }
  doRedo() { if (!this.redo.length) return false; this.undo.push(this.delta); this._setDelta(this.redo.pop()); return true; }
  reset() { if (!this.changed) return false; this._pushUndo(this.delta); this._setDelta(new Float32Array(this.delta.length)); return true; }
  load(delta) { if (delta?.length === this.delta.length) this._setDelta(Float32Array.from(delta)); }

  /**
   * Earthwork from the change grid. cellArea in (output units)^2. Returns volumes in output units^3 plus extremes.
   * Each node stands for one cell (s x s) — a close approximation for preliminary quantities.
   */
  earthwork(cellArea) {
    let cut = 0, fill = 0, maxCut = 0, maxFill = 0, n = 0;
    for (const d of this.delta) {
      if (!d || Number.isNaN(d)) continue;
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
      // Only the levels that cross this cell.
      let a = Math.max(0, Math.ceil((mn - lo) / step - 1e-9)), b = Math.min(levels.length - 1, Math.floor((mx - lo) / step + 1e-9));
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

/** Per-site storage of the change grid (IndexedDB), keyed by the grid's position and size. */
export function designKey(g, zoneCode) {
  return `design:${zoneCode}:${g.x0.toFixed(2)}:${g.y0.toFixed(2)}:${g.s.toFixed(4)}:${g.nx}x${g.ny}`;
}
