// Surface water flow: a downhill field over a grid, animated particles that follow it, and ponding spots.
// Grid: { x0, y0, s, nx, ny } with z values (output units); XY native. k = output units per native unit.

export class Flow {
  constructor(g, z, k = 1) {
    this.g = g; this.k = k;
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
    this._sinks = null;
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
    this.life[p] = 60 + Math.floor(Math.random() * 90);
  }

  /** Advance every particle one frame. Speed grows with slope (flat ground: particles fade out). */
  step() {
    const s = this.g.s;
    for (let p = 0; p < this.n; p++) {
      const x = this.px[p], y = this.py[p];
      this.ox[p] = x; this.oy[p] = y;
      const vx = this._sample(this.vx, x, y), vy = this._sample(this.vy, x, y), m = this._sample(this.sl, x, y);
      if (!Number.isFinite(vx) || ++this.age[p] > this.life[p] || !(m > 0.004)) { this._spawn(p); continue; }
      const L = Math.hypot(vx, vy) || 1;
      const sp = s * Math.min(1.1, 0.18 + m * 6);
      this.px[p] = x + vx / L * sp;
      this.py[p] = y + vy / L * sp;
    }
  }

  /**
   * Low spots where water would collect: local minima in a (2r+1)² window that sit at least `minDepth`
   * below the lowest point of the window's rim. Returns [{ x, y, z, depth }], deepest first, at most `max`.
   */
  sinks(minDepth = 0.15, r = 4, max = 80) {
    if (this._sinks) return this._sinks;
    const { x0, y0, s, nx, ny } = this.g, z = this.z;
    const out = [];
    for (let j = r; j < ny - r; j += 1) for (let i = r; i < nx - r; i += 1) {
      const c = z[j * nx + i];
      if (Number.isNaN(c)) continue;
      let isMin = true;
      for (let dj = -1; dj <= 1 && isMin; dj++) for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const v = z[(j + dj) * nx + i + di];
        if (v < c || (v === c && (dj < 0 || (dj === 0 && di < 0)))) { isMin = false; break; }
      }
      if (!isMin) continue;
      let rim = Infinity;
      for (let d = -r; d <= r; d++) {
        for (const [a, b] of [[i + d, j - r], [i + d, j + r], [i - r, j + d], [i + r, j + d]]) {
          const v = z[b * nx + a];
          if (!Number.isNaN(v) && v < rim) rim = v;
        }
      }
      const depth = rim - c;
      if (depth >= minDepth) out.push({ x: x0 + i * s, y: y0 + j * s, z: c, depth });
    }
    out.sort((a, b) => b.depth - a.depth);
    // Keep spots at least 2r nodes apart.
    const kept = [];
    for (const o of out) {
      if (kept.length >= max) break;
      if (kept.every(q => Math.hypot(q.x - o.x, q.y - o.y) > 2 * r * s)) kept.push(o);
    }
    this._sinks = kept;
    return kept;
  }
}
