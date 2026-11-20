// Surface water flow: a downhill field over a grid, animated particles that follow it, and ponding spots.
// Grid: { x0, y0, s, nx, ny } with z values (output units); XY native. k = output units per native unit.

export class Flow {
  constructor(g, z, k = 1) {
    this.g = g; this.k = k;
    this.speed = 1; // multiplier (Settings › Water flow speed)
    this.setSurface(z);
    this.n = 0;
    this.px = new Float32Array(0); this.py = new Float32Array(0);
    this.ox = new Float32Array(0); this.oy = new Float32Array(0);
    this.age = new Uint16Array(0); this.life = new Uint16Array(0);
  }

  /** Downhill direction and slope at every node (central differences, NaN-safe). */
  setSurface(z) {
    const { nx, ny, s } = this.g, k = this.k;
    this.z = z;
    const vx = new Float32Array(nx * ny), vy = new Float32Array(nx * ny), sl = new Float32Array(nx * ny);
    const at = (i, j) => z[Math.max(0, Math.min(ny - 1, j)) * nx + Math.max(0, Math.min(nx - 1, i))];
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const c = z[j * nx + i];
      if (Number.isNaN(c)) continue;
      let zl = at(i - 1, j), zr = at(i + 1, j), zd = at(i, j - 1), zu = at(i, j + 1);
      if (Number.isNaN(zl)) zl = c; if (Number.isNaN(zr)) zr = c; if (Number.isNaN(zd)) zd = c; if (Number.isNaN(zu)) zu = c;
      const gx = (zr - zl) / (2 * s * k), gy = (zu - zd) / (2 * s * k); // rise per run (dimensionless)
      const m = Math.hypot(gx, gy);
      const idx = j * nx + i;
      sl[idx] = m;
      if (m > 1e-6) { vx[idx] = -gx / m; vy[idx] = -gy / m; }
    }
    this.vx = vx; this.vy = vy; this.sl = sl;
    this._ponds = null; this._streams = null;
    this._route();
  }

  /**
   * Fill-and-spill routing (priority flood from the site edge inward): every node gets a downstream node, so water
   * that reaches a pit or a trench fills it to its spill level and carries on instead of stopping.
   *   zf = water level a node would fill to (= ground where nothing ponds), dp = zf − ground (ponding depth),
   *   to = downstream node (−1 where water leaves the site), acc = nodes draining through each node,
   *   rx, ry = unit direction to the downstream node.
   */
  _route() {
    const { nx, ny } = this.g, z = this.z, N = nx * ny;
    const zf = new Float32Array(N).fill(NaN), to = new Int32Array(N).fill(-1), order = new Int32Array(N), seen = new Uint8Array(N);
    const hk = new Float32Array(N), hi = new Int32Array(N), hs = new Int32Array(N); let hn = 0, seq = 0, no = 0;
    const less = (a, b) => hk[a] < hk[b] || (hk[a] === hk[b] && hs[a] < hs[b]);
    const swap = (a, b) => { const k = hk[a], i = hi[a], q = hs[a]; hk[a] = hk[b]; hi[a] = hi[b]; hs[a] = hs[b]; hk[b] = k; hi[b] = i; hs[b] = q; };
    const push = (i, k) => { let c = hn++; hk[c] = k; hi[c] = i; hs[c] = seq++; while (c > 0) { const p = (c - 1) >> 1; if (!less(c, p)) break; swap(c, p); c = p; } };
    const pop = () => { const top = hi[0]; hn--; if (hn > 0) { hk[0] = hk[hn]; hi[0] = hi[hn]; hs[0] = hs[hn]; let c = 0; for (;;) { const l = 2 * c + 1, r = l + 1; let m = c; if (l < hn && less(l, m)) m = l; if (r < hn && less(r, m)) m = r; if (m === c) break; swap(c, m); c = m; } } return top; };
    // Seeds: nodes on the edge of the grid or beside a gap (outside a polygon boundary).
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const q = j * nx + i; if (Number.isNaN(z[q])) continue;
      const edge = i === 0 || j === 0 || i === nx - 1 || j === ny - 1 || Number.isNaN(z[q - 1]) || Number.isNaN(z[q + 1]) || Number.isNaN(z[q - nx]) || Number.isNaN(z[q + nx]);
      if (edge) { seen[q] = 1; zf[q] = z[q]; push(q, z[q]); }
    }
    while (hn) {
      const c = pop(); order[no++] = c;
      const ci = c % nx, cj = (c / nx) | 0, zc = zf[c];
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const a = ci + di, b = cj + dj; if (a < 0 || b < 0 || a >= nx || b >= ny) continue;
        const n = b * nx + a; if (seen[n] || Number.isNaN(z[n])) continue;
        seen[n] = 1; zf[n] = z[n] > zc ? z[n] : zc; to[n] = c; push(n, zf[n]);
      }
    }
    // Where the ground itself falls away, follow the steepest fall instead of the flood's discovery order.
    const D = Math.SQRT1_2;
    for (let o = 0; o < no; o++) {
      const c = order[o]; if (zf[c] > z[c]) continue;
      const ci = c % nx, cj = (c / nx) | 0; let best = -1, bd = 1e-7;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const a = ci + di, b = cj + dj; if (a < 0 || b < 0 || a >= nx || b >= ny) continue;
        const n = b * nx + a; if (Number.isNaN(zf[n])) continue;
        const d = (zf[c] - zf[n]) * (di && dj ? D : 1);
        if (d > bd) { bd = d; best = n; }
      }
      if (best >= 0) to[c] = best;
    }
    const acc = new Float32Array(N), dp = new Float32Array(N), rx = new Float32Array(N), ry = new Float32Array(N);
    for (let o = 0; o < no; o++) acc[order[o]] = 1;
    for (let o = no - 1; o >= 0; o--) {
      const c = order[o], t = to[c];
      dp[c] = zf[c] - z[c];
      if (t < 0) continue;
      acc[t] += acc[c];
      const dx = (t % nx) - (c % nx), dy = ((t / nx) | 0) - ((c / nx) | 0), L = Math.hypot(dx, dy) || 1;
      rx[c] = dx / L; ry[c] = dy / L;
    }
    this.zf = zf; this.to = to; this.acc = acc; this.dp = dp; this.rx = rx; this.ry = ry;
  }
  _node(x, y) {
    const { x0, y0, s, nx, ny } = this.g, i = Math.round((x - x0) / s), j = Math.round((y - y0) / s);
    return i < 0 || j < 0 || i >= nx || j >= ny ? -1 : j * nx + i;
  }

  _sample(arr, x, y) {
    const { x0, y0, s, nx, ny } = this.g;
    const fx = (x - x0) / s, fy = (y - y0) / s;
    const i = Math.floor(fx), j = Math.floor(fy);
    if (i < 0 || j < 0 || i >= nx - 1 || j >= ny - 1) return NaN;
    const tx = fx - i, ty = fy - j, q = j * nx + i;
    return (arr[q] * (1 - tx) + arr[q + 1] * tx) * (1 - ty) + (arr[q + nx] * (1 - tx) + arr[q + nx + 1] * tx) * ty;
  }
  zAt(x, y) { return this._sample(this.z, x, y); }

  /** (Re)seed `n` particles uniformly over the grid. */
  seed(n) {
    this.n = n;
    this.px = new Float32Array(n); this.py = new Float32Array(n);
    this.ox = new Float32Array(n); this.oy = new Float32Array(n);
    this.age = new Uint16Array(n); this.life = new Uint16Array(n);
    for (let p = 0; p < n; p++) { this._spawn(p); this.age[p] = Math.floor(Math.random() * this.life[p]); }
  }
  _spawn(p) {
    const { x0, y0, s, nx, ny } = this.g;
    this.px[p] = this.ox[p] = x0 + Math.random() * (nx - 1) * s;
    this.py[p] = this.oy[p] = y0 + Math.random() * (ny - 1) * s;
    this.age[p] = 0;
    this.life[p] = 220 + Math.floor(Math.random() * 260); // frames; long enough to follow a slope a good way
  }

  /**
   * Advance every particle one frame. On a slope it runs down the fall line, faster where steeper; on flat ground
   * and in filled low spots it follows the routing toward the spill point; where water stands it slows and sinks in.
   */
  step() {
    const s = this.g.s, pd = this.pondDepth || 0.15;
    for (let p = 0; p < this.n; p++) {
      const x = this.px[p], y = this.py[p];
      this.ox[p] = x; this.oy[p] = y;
      let vx = this._sample(this.vx, x, y), vy = this._sample(this.vy, x, y), m = this._sample(this.sl, x, y);
      if (!Number.isFinite(vx) || ++this.age[p] > this.life[p]) { this._spawn(p); continue; }
      const q = this._node(x, y), d = q >= 0 ? this.dp[q] : 0;
      let k = 1;
      if (d > 0.01 || !(m > 0.004)) {
        // Standing water or flat ground: head for the downstream node.
        const rx = q >= 0 ? this.rx[q] : 0, ry = q >= 0 ? this.ry[q] : 0;
        if (!rx && !ry) { this._spawn(p); continue; }
        vx = rx; vy = ry; m = Math.max(m || 0, 0.004);
        if (d >= pd) { k = 0.35; this.age[p] += 3; } // in a pond: slow, and gone soon
      }
      const L = Math.hypot(vx, vy) || 1;
      const sp = s * this.speed * k * Math.min(0.45, 0.07 + m * 2.5);
      this.px[p] = x + vx / L * sp;
      this.py[p] = y + vy / L * sp;
    }
  }

  /**
   * Ponding areas: connected nodes that fill at least `minDepth` deep before spilling. Returns
   * { list: [{ x, y (deepest point), z (water level), depth, cells }], mask (Uint8 per node) }, deepest first.
   */
  ponds(minDepth = 0.15, minCells = 3) {
    if (this._ponds && this._ponds.minDepth === minDepth) return this._ponds;
    this.pondDepth = minDepth;
    const { x0, y0, s, nx, ny } = this.g, dp = this.dp, N = nx * ny;
    const lab = new Int32Array(N).fill(-1), mask = new Uint8Array(N), list = [], stack = [];
    for (let q0 = 0; q0 < N; q0++) {
      if (!(dp[q0] >= minDepth) || lab[q0] >= 0) continue;
      const id = list.length, cells = []; let deep = q0;
      lab[q0] = id; stack.push(q0);
      while (stack.length) {
        const q = stack.pop(); cells.push(q);
        if (dp[q] > dp[deep]) deep = q;
        const i = q % nx, j = (q / nx) | 0;
        if (i > 0 && lab[q - 1] < 0 && dp[q - 1] >= minDepth) { lab[q - 1] = id; stack.push(q - 1); }
        if (i < nx - 1 && lab[q + 1] < 0 && dp[q + 1] >= minDepth) { lab[q + 1] = id; stack.push(q + 1); }
        if (j > 0 && lab[q - nx] < 0 && dp[q - nx] >= minDepth) { lab[q - nx] = id; stack.push(q - nx); }
        if (j < ny - 1 && lab[q + nx] < 0 && dp[q + nx] >= minDepth) { lab[q + nx] = id; stack.push(q + nx); }
      }
      const keep = cells.length >= minCells;
      if (keep) for (const q of cells) mask[q] = 1;
      list.push(keep ? { x: x0 + (deep % nx) * s, y: y0 + ((deep / nx) | 0) * s, z: this.zf[deep], depth: dp[deep], cells: cells.length } : null);
    }
    this._ponds = { minDepth, mask, list: list.filter(Boolean).sort((a, b) => b.depth - a.depth) };
    return this._ponds;
  }

  /**
   * Where runoff collects into a stream: links between nodes that at least `minCells` nodes drain through (and that
   * aren't under standing water). Returns { seg: Float32Array [x1, y1, x2, y2, …] native, w: Float32Array 0…1
   * (how much water, log scale), q: Int32Array (upstream node of each link), n }.
   */
  streams(minCells) {
    const { x0, y0, s, nx, ny } = this.g, N = nx * ny;
    minCells = minCells || Math.max(150, Math.round(N * 0.0025));
    if (this._streams && this._streams.minCells === minCells) return this._streams;
    const mask = this.ponds(this.pondDepth || 0.15).mask, acc = this.acc, to = this.to;
    let n = 0, top = minCells;
    for (let q = 0; q < N; q++) if (acc[q] >= minCells && to[q] >= 0) { n++; if (acc[q] > top) top = acc[q]; }
    const seg = new Float32Array(n * 4), w = new Float32Array(n), qs = new Int32Array(n), span = Math.log(top / minCells) || 1;
    let o = 0;
    for (let q = 0; q < N; q++) {
      if (!(acc[q] >= minCells) || to[q] < 0) continue;
      if (mask[q] && mask[to[q]]) continue;
      const t = to[q];
      seg[o * 4] = x0 + (q % nx) * s; seg[o * 4 + 1] = y0 + ((q / nx) | 0) * s; seg[o * 4 + 2] = x0 + (t % nx) * s; seg[o * 4 + 3] = y0 + ((t / nx) | 0) * s;
      w[o] = Math.min(1, Math.log(acc[q] / minCells) / span); qs[o] = q; o++;
    }
    this._streams = { minCells, seg: seg.subarray(0, o * 4), w: w.subarray(0, o), q: qs.subarray(0, o), n: o };
    return this._streams;
  }
}
