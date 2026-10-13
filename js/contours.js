// Regular grids in State Plane coordinates, smoothing, and marching-squares contour lines.

/**
 * A grid: origin (x0,y0) at the south-west node, spacing s, nx by ny nodes,
 * values z[j*nx + i] at (x0 + i*s, y0 + j*s) — j increases northward.
 */
export function buildGrid(box, s, zAt) {
  const x0 = Math.ceil(box.xmin / s) * s;
  const y0 = Math.ceil(box.ymin / s) * s;
  const nx = Math.floor((box.xmax - x0) / s) + 1;
  const ny = Math.floor((box.ymax - y0) / s) + 1;
  const z = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    const y = y0 + j * s;
    for (let i = 0; i < nx; i++) z[j * nx + i] = zAt(x0 + i * s, y);
  }
  return { x0, y0, s, nx, ny, z };
}

export function gridStats(g) {
  let min = Infinity, max = -Infinity, missing = 0;
  for (const v of g.z) {
    if (Number.isNaN(v)) { missing++; continue; }
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { min, max, missing };
}

/** Separable Gaussian blur that ignores NaN cells. */
export function smooth(g, sigma = 1) {
  if (sigma <= 0) return g;
  const r = Math.ceil(sigma * 2);
  const k = [];
  for (let i = -r; i <= r; i++) k.push(Math.exp(-(i * i) / (2 * sigma * sigma)));
  const { nx, ny } = g;
  const pass = (src, horiz) => {
    const out = new Float32Array(src.length);
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        let acc = 0, wt = 0;
        for (let t = -r; t <= r; t++) {
          const ii = horiz ? i + t : i, jj = horiz ? j : j + t;
          if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
          const v = src[jj * nx + ii];
          if (Number.isNaN(v)) continue;
          acc += v * k[t + r]; wt += k[t + r];
        }
        out[j * nx + i] = Number.isNaN(src[j * nx + i]) || wt === 0 ? NaN : acc / wt;
      }
    }
    return out;
  };
  return { ...g, z: pass(pass(g.z, true), false) };
}

// Segment table: corner bits bl=1, br=2, tr=4, tl=8 (set when value >= level).
// Edges: 0 bottom, 1 right, 2 top, 3 left. Saddles (5, 10) resolved by the cell-centre value.
const SEGS = {
  1: [[3, 0]], 2: [[0, 1]], 3: [[3, 1]], 4: [[1, 2]], 6: [[0, 2]], 7: [[3, 2]],
  8: [[2, 3]], 9: [[0, 2]], 11: [[1, 2]], 12: [[3, 1]], 13: [[0, 1]], 14: [[3, 0]],
};

/**
 * Contour lines at each level. Returns [{level, lines: [[ [x,y], ... ], ...]}] in grid coordinates (State Plane).
 */
export function contourLines(g, levels) {
  const { nx, ny, z, x0, y0, s } = g;
  const results = [];
  for (const L of levels) {
    const pts = new Map(); // edge key -> [x,y]
    const segs = [];
    const edgePoint = (key, ia, ja, ib, jb) => {
      if (!pts.has(key)) {
        const za = z[ja * nx + ia], zb = z[jb * nx + ib];
        const t = (L - za) / (zb - za);
        pts.set(key, [x0 + (ia + (ib - ia) * t) * s, y0 + (ja + (jb - ja) * t) * s]);
      }
      return key;
    };
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        const bl = z[j * nx + i], br = z[j * nx + i + 1], tl = z[(j + 1) * nx + i], tr = z[(j + 1) * nx + i + 1];
        if (Number.isNaN(bl) || Number.isNaN(br) || Number.isNaN(tl) || Number.isNaN(tr)) continue;
        const c = (bl >= L ? 1 : 0) | (br >= L ? 2 : 0) | (tr >= L ? 4 : 0) | (tl >= L ? 8 : 0);
        if (c === 0 || c === 15) continue;
        let pairs = SEGS[c];
        if (c === 5 || c === 10) {
          const centreAbove = (bl + br + tl + tr) / 4 >= L;
          if (c === 5) pairs = centreAbove ? [[0, 1], [2, 3]] : [[3, 0], [1, 2]];
          else pairs = centreAbove ? [[3, 0], [1, 2]] : [[0, 1], [2, 3]];
        }
        const key = e => {
          switch (e) {
            case 0: return edgePoint(2 * (j * nx + i), i, j, i + 1, j);
            case 1: return edgePoint(2 * (j * nx + i + 1) + 1, i + 1, j, i + 1, j + 1);
            case 2: return edgePoint(2 * ((j + 1) * nx + i), i, j + 1, i + 1, j + 1);
            default: return edgePoint(2 * (j * nx + i) + 1, i, j, i, j + 1);
          }
        };
        for (const [a, b] of pairs) segs.push([key(a), key(b)]);
      }
    }
    results.push({ level: L, lines: joinSegments(segs, pts) });
  }
  return results;
}

function joinSegments(segs, pts) {
  const adj = new Map();
  segs.forEach(([a, b], idx) => {
    if (!adj.has(a)) adj.set(a, []);
    if (!adj.has(b)) adj.set(b, []);
    adj.get(a).push(idx);
    adj.get(b).push(idx);
  });
  const used = new Uint8Array(segs.length);
  const lines = [];
  const walk = start => {
    const keys = [start];
    let cur = start;
    for (;;) {
      const next = (adj.get(cur) || []).find(si => !used[si]);
      if (next === undefined) break;
      used[next] = 1;
      const [a, b] = segs[next];
      cur = a === cur ? b : a;
      keys.push(cur);
    }
    return keys;
  };
  // Open lines first (start at endpoints), then closed loops.
  for (const [k, list] of adj) {
    if (list.length === 1 && !used[list[0]]) lines.push(walk(k));
  }
  for (let si = 0; si < segs.length; si++) {
    if (!used[si]) lines.push(walk(segs[si][0]));
  }
  return lines.filter(l => l.length > 1).map(l => l.map(k => pts.get(k)));
}

export function contourLevels(min, max, interval) {
  const out = [];
  const start = Math.ceil(min / interval) * interval;
  for (let v = start; v <= max + 1e-9; v += interval) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}

export function isMajor(level, interval, every = 5) {
  const r = level / (interval * every);
  return Math.abs(r - Math.round(r)) < 1e-6;
}

export function polylineLength(line) {
  let L = 0;
  for (let i = 1; i < line.length; i++) L += Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]);
  return L;
}

/** Label positions along a line: every `spacing` units, at least one for lines longer than minLen. */
export function labelPositions(line, spacing, minLen) {
  const total = polylineLength(line);
  if (total < minLen) return [];
  const n = Math.max(1, Math.floor(total / spacing));
  const out = [];
  for (let k = 0; k < n; k++) {
    const target = total * (k + 0.5) / n;
    let acc = 0;
    for (let i = 1; i < line.length; i++) {
      const [ax, ay] = line[i - 1], [bx, by] = line[i];
      const seg = Math.hypot(bx - ax, by - ay);
      if (acc + seg >= target) {
        const t = seg ? (target - acc) / seg : 0;
        let ang = Math.atan2(by - ay, bx - ax) * 180 / Math.PI;
        if (ang > 90) ang -= 180;
        if (ang < -90) ang += 180;
        out.push({ x: ax + (bx - ax) * t, y: ay + (by - ay) * t, angle: ang });
        break;
      }
      acc += seg;
    }
  }
  return out;
}
