// Boolean operations on sketch solids — join (union), intersect, and cut (subtract) — with the Manifold geometry
// kernel (manifold-3d, Apache-2.0, WebAssembly; loaded the first time it's used). Solids go in as triangle meshes
// and the result comes back as flat polygon faces (coplanar touching triangles merged, holes kept), so Push/Pull,
// Draw and Slope keep working on it.
import { solidTris } from './solid.js?v=0.64.2';

let wasmP = null;
function kernel() {
  wasmP ??= import(new URL('../lib/manifold/manifold.js', import.meta.url).href).then(m => m.default()).then(w => { w.setup(); return w; });
  return wasmP;
}

/**
 * op: 'join' | 'intersect' | 'cut' (B from A). A, B: { v: [[x,y,z]…] (same frame, any units), f }.
 * Returns { v, f } or throws with a readable message.
 */
export async function booleanSolids(op, A, B) {
  const w = await kernel();
  // Work near the origin: State Plane coordinates are too large for the kernel's 32-bit floats.
  let ox = 0, oy = 0, oz = 0; for (const p of A.v) { ox += p[0]; oy += p[1]; oz += p[2]; }
  ox /= A.v.length; oy /= A.v.length; oz /= A.v.length;
  const toM = S => {
    const tris = solidTris(S), vp = new Float32Array(S.v.length * 3), tv = new Uint32Array(tris.length * 3);
    S.v.forEach((p, i) => { vp[i * 3] = p[0] - ox; vp[i * 3 + 1] = p[1] - oy; vp[i * 3 + 2] = p[2] - oz; });
    tris.forEach((t, i) => { tv[i * 3] = t.a; tv[i * 3 + 1] = t.b; tv[i * 3 + 2] = t.c; });
    const mesh = new w.Mesh({ numProp: 3, vertProperties: vp, triVerts: tv });
    mesh.merge();
    try { return new w.Manifold(mesh); } catch { throw new Error('one of the blocks isn\'t a closed solid (a flat shape, or an open edit)'); }
  };
  const a = toM(A), b = toM(B);
  let r;
  try {
    r = op === 'join' ? a.add(b) : op === 'intersect' ? a.intersect(b) : a.subtract(b);
    if (r.isEmpty()) throw new Error(op === 'intersect' ? 'the blocks don\'t overlap' : 'nothing is left');
    const m = r.getMesh();
    const n = m.vertProperties.length / m.numProp, v = [];
    for (let i = 0; i < n; i++) v.push([m.vertProperties[i * m.numProp] + ox, m.vertProperties[i * m.numProp + 1] + oy, m.vertProperties[i * m.numProp + 2] + oz]);
    return { v, f: facesFrom(v, m.triVerts) };
  } finally { a.delete(); b.delete(); r?.delete(); }
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Merge coplanar, edge-sharing triangles into polygon faces { o, h }. */
export function facesFrom(v, tv) {
  const T = tv.length / 3, N = [], D = [];
  let span = 0; for (const p of v) span = Math.max(span, Math.abs(p[0]), Math.abs(p[1]), Math.abs(p[2]));
  for (let t = 0; t < T; t++) {
    const a = v[tv[t * 3]], b = v[tv[t * 3 + 1]], c = v[tv[t * 3 + 2]];
    const n = cross(sub(b, a), sub(c, a)), l = Math.hypot(...n) || 1;
    N.push([n[0] / l, n[1] / l, n[2] / l]); D.push(dot(N[t], a));
  }
  // Triangles by edge, then union-find over coplanar neighbours.
  const parent = Int32Array.from({ length: T }, (_, i) => i);
  const find = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const edges = new Map();
  for (let t = 0; t < T; t++) for (let k = 0; k < 3; k++) {
    const p = tv[t * 3 + k], q = tv[t * 3 + (k + 1) % 3];
    edges.set(`${p},${q}`, t);
  }
  const tolD = 1e-5 * Math.max(1, span);
  for (let t = 0; t < T; t++) for (let k = 0; k < 3; k++) {
    const p = tv[t * 3 + k], q = tv[t * 3 + (k + 1) % 3], u = edges.get(`${q},${p}`);
    if (u == null || u === t) continue;
    if (dot(N[t], N[u]) > 1 - 1e-6 && Math.abs(D[t] - D[u]) < tolD) parent[find(t)] = find(u);
  }
  const groups = new Map();
  for (let t = 0; t < T; t++) { const r = find(t); let g = groups.get(r); if (!g) groups.set(r, g = []); g.push(t); }
  const faces = [];
  for (const g of groups.values()) {
    // Boundary edges: directed edges whose twin isn't in the group; chain them into loops.
    const inG = new Set(g), next = new Map();
    for (const t of g) for (let k = 0; k < 3; k++) {
      const p = tv[t * 3 + k], q = tv[t * 3 + (k + 1) % 3], u = edges.get(`${q},${p}`);
      if (u != null && inG.has(u)) continue;
      next.set(p, q);
    }
    const n = N[g[0]], ax = Math.abs(n[2]) > 0.9 ? [1, 0, 0] : [0, 0, 1];
    const U = (() => { const c = cross(ax, n), l = Math.hypot(...c) || 1; return [c[0] / l, c[1] / l, c[2] / l]; })(), V = cross(n, U);
    const p2 = i => [dot(v[i], U), dot(v[i], V)];
    const loops = [], seen = new Set();
    for (const s of next.keys()) {
      if (seen.has(s)) continue;
      const L = []; let c = s, guard = 0;
      while (!seen.has(c) && guard++ < 100000) { seen.add(c); L.push(c); c = next.get(c); if (c == null) break; }
      if (L.length >= 3) loops.push(L);
    }
    const area = L => { let a = 0; for (let i = 0; i < L.length; i++) { const [x0, y0] = p2(L[i]), [x1, y1] = p2(L[(i + 1) % L.length]); a += x0 * y1 - x1 * y0; } return a / 2; };
    const outers = loops.filter(L => area(L) > 0), holes = loops.filter(L => area(L) <= 0);
    const fs = outers.map(o => ({ o, h: [] }));
    for (const h of holes) {
      const q = p2(h[0]);
      const f = fs.find(F => inPoly(F.o.map(p2), q)) || fs[0];
      if (f) f.h.push(h);
    }
    for (const f of fs) faces.push(f.h.length ? f : { o: f.o });
  }
  return simplify(faces, v);
}
/** Drop corners that sit on a straight run in every face that uses them (the kernel adds them along cuts);
 *  a corner kept by one face stays in all, so the solid stays watertight. */
function simplify(faces, v) {
  const use = new Map(), straight = new Map();
  for (const f of faces) for (const L of [f.o, ...(f.h || [])]) L.forEach((i, k) => {
    const a = v[L[(k - 1 + L.length) % L.length]], b = v[i], c = v[L[(k + 1) % L.length]];
    const x = cross(sub(b, a), sub(c, b)), la = Math.hypot(...sub(b, a)), lc = Math.hypot(...sub(c, b));
    use.set(i, (use.get(i) || 0) + 1);
    if (Math.hypot(...x) <= 1e-6 * la * lc) straight.set(i, (straight.get(i) || 0) + 1);
  });
  const drop = i => straight.get(i) === use.get(i);
  const keep = L => { const o = L.filter(i => !drop(i)); return o.length >= 3 ? o : L; };
  return faces.map(f => (f.h ? { o: keep(f.o), h: f.h.map(keep) } : { o: keep(f.o) }));
}
function inPoly(P, [x, y]) { let c = false; for (let i = 0, j = P.length - 1; i < P.length; j = i++) { const [xi, yi] = P[i], [xj, yj] = P[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c; } return c; }
