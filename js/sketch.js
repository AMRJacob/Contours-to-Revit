// Sketch tab: a light brainstorming tool on the real site — massing blocks, parking lots with planter islands and
// drive aisles (arrows, regions, labels and trees come next). Everything updates live: floor area, parking
// provided vs required, accessible spaces, and the 3D / sun views. Works on the map and in the 3D view.
// Colours come from an editable scheme that travels with the project.
//
// Hotkeys: V select · M massing (1–5 shape) · P parking · I island · D drive aisle · Esc cancel / select ·
// Del delete · Ctrl+Z / Ctrl+Y undo / redo · ↑ ↓ floors (massing) or slide rows (parking) · R roof form ·
// [ ] turn parking rows · Enter / double-click finish an outline · Alt+drag duplicate · Alt+click a corner removes
// it · Shift square corners / snap rotation.
import { layoutLot, longestEdgeAngle, lanePoly } from './parking.js?v=0.42.0';
import { BUILTIN_SCHEMES, allSchemes, schemeById, saveScheme, deleteScheme, duplicateScheme, colorOf } from './schemes.js?v=0.42.0';
import { massGeom, massMesh, heightAt, presetShape, area, inPoly, ROOFS } from './sketchmass.js?v=0.42.0';

const TOOLS = [
  { id: 'select', key: 'V', label: 'Select', icon: '<path d="M5 3l14 8-6 1.5L10 19z"/>' },
  { id: 'mass', key: 'M', label: 'Massing', icon: '<path d="M4 9l8-4 8 4v9l-8 4-8-4z"/><path d="M4 9l8 4 8-4M12 13v9" opacity=".6"/>' },
  { id: 'lot', key: 'P', label: 'Parking', icon: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v6M11 4v6M15 4v6M7 20v-6M11 20v-6M15 20v-6" opacity=".7"/>' },
  { id: 'island', key: 'I', label: 'Island', icon: '<rect x="3" y="8" width="18" height="8" rx="4"/><path d="M9 12h6" opacity=".7"/>' },
  { id: 'drive', key: 'D', label: 'Drive aisle', icon: '<path d="M5 21L10 3M19 21L14 3"/><path d="M12 5v3M12 11v3M12 17v3" opacity=".7"/>' },
];
const SHAPES = [
  { id: 'box', key: '1', label: 'Box or outline', icon: '<rect x="5" y="6" width="14" height="12"/>' },
  { id: 'circle', key: '2', label: 'Round (drag from the centre)', icon: '<circle cx="12" cy="12" r="7.5"/>' },
  { id: 'L', key: '3', label: 'L-shape', icon: '<path d="M5 4h6v10h8v6H5z"/>' },
  { id: 'U', key: '4', label: 'U-shape', icon: '<path d="M4 5h5v9h6V5h5v15H4z"/>' },
  { id: 'court', key: '5', label: 'Courtyard', icon: '<rect x="4" y="4" width="16" height="16"/><rect x="9" y="9" width="6" height="6"/>' },
];
const HINTS = {
  select: 'Click to edit · drag to move · drag corners to reshape, edge dots to add a corner, ⟳ to rotate, ⤡ to scale · Alt+click a corner removes it · Alt+drag duplicates.',
  mass: 'Drag a shape (1–5 picks box, round, L, U, courtyard), or click corners and double-click to finish. ↑ ↓ floors · R roof.',
  lot: 'Drag a rectangle, or click corners and double-click to finish. [ ] turn the rows, ↑ ↓ slide them.',
  island: 'Drag or click out a planter island inside a lot — the stalls under it go away.',
  drive: 'Drag a straight drive aisle, or click points and double-click to finish. Stalls it crosses are cleared.',
};
const DEFAULT_RATIOS = {   // examples only — every jurisdiction sets its own
  residential: { mode: 'unit', r: 1.5, unitSf: 900 }, office: { mode: 'ksf', r: 3 }, retail: { mode: 'ksf', r: 4 },
  civic: { mode: 'ksf', r: 2.5 }, hospitality: { mode: 'unit', r: 1, unitSf: 450 }, mixed: { mode: 'ksf', r: 3 },
  industrial: { mode: 'ksf', r: 1 }, parking: { mode: 'ksf', r: 0 },
};
const LISTS = { mass: 'masses', lot: 'lots', island: 'islands', drive: 'drives' };
const svg = i => `<svg viewBox="0 0 24 24">${i}</svg>`;

export function createSketch(ctx) {
  const { map, $, escapeHtml } = ctx;
  const sk = {
    model: blank(), tool: 'select', shape: 'box', sel: null, drag: null, draw: null, undo: [], redo: [], ver: 0,
    site: null, key: null, layouts: new Map(), geoms: new Map(), active: false, v3: null,
  };
  function blank() {
    return { v: 2, masses: [], lots: [], islands: [], drives: [], scheme: JSON.parse(JSON.stringify(BUILTIN_SCHEMES[0])), ratios: JSON.parse(JSON.stringify(DEFAULT_RATIOS)) };
  }
  const scheme = () => sk.model.scheme;
  const uid = () => Math.random().toString(36).slice(2, 9);
  const perFt = () => (sk.site ? ctx.unitsPerFt(sk.site) : 1);           // native units per foot
  const sfPerNative2 = () => 1 / perFt() ** 2;
  const metric = () => sk.site?.outUnit === 'm';
  const outPerFt = () => (metric() ? 0.3048 : 1);
  const uLen = () => (metric() ? 'm' : 'ft');
  const fmtArea = sf => (metric() ? `${Math.round(sf * 0.092903).toLocaleString()} m²` : `${Math.round(sf).toLocaleString()} sf`);
  const centroid = P => { let x = 0, y = 0; for (const p of P) { x += p[0]; y += p[1]; } return [x / P.length, y / P.length]; };
  const bbox = P => { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const [x, y] of P) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } return [x0, y0, x1, y1]; };
  const overlap = (a, b) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
  const list = kind => sk.model[LISTS[kind]];
  const ex3 = () => (sk.v3 ? ctx.ex3d?.() || 1 : 1);
  const zGround = p => { const z = ctx.zAt(p[0], p[1]); return Number.isFinite(z) ? z : 0; };
  const closed = kind => kind !== 'drive';

  // ---------------------------------------------------------------- model helpers
  function geom(m) {
    const key = JSON.stringify([m.pts, m.floors, m.ftf, m.court, m.step, m.roof, perFt(), outPerFt()]);
    const c = sk.geoms.get(m.id);
    if (c && c.key === key) return c.G;
    const G = massGeom(m, perFt(), outPerFt());
    sk.geoms.set(m.id, { key, G });
    return G;
  }
  const massGfa = m => geom(m).fa * sfPerNative2();
  function massBase(m) {
    let lo = Infinity;
    for (const p of [...m.pts, centroid(m.pts)]) { const z = ctx.zAt(...p); if (Number.isFinite(z) && z < lo) lo = z; }
    return Number.isFinite(lo) ? lo : 0;
  }
  const massHeight = m => m.floors * m.ftf;
  const massTop = m => massBase(m) + massHeight(m);
  function lotOpts(l) {
    const bb = bbox(l.pts);
    const islands = sk.model.islands.filter(i => overlap(bbox(i.pts), bb)).map(i => i.pts);
    const drives = [];
    for (const d of sk.model.drives) {
      if (!overlap(bbox(d.pts), bb)) continue;
      for (let i = 0; i < d.pts.length - 1; i++) drives.push({ a: d.pts[i], b: d.pts[i + 1], w: d.w });
    }
    return { stall: l.stall, shift: l.shift, angle: l.angle ?? longestEdgeAngle(l.pts), k: perFt(), accNear: nearestMass(l),
      setback: l.setback || 0, endIslands: !!l.endIslands, islandEvery: l.islandEvery || 0, islands, drives };
  }
  function lotLayout(l) {
    const opts = lotOpts(l);
    const key = JSON.stringify([l.pts, opts]);
    const c = sk.layouts.get(l.id);
    if (c && c.key === key) return c.res;
    const res = layoutLot(l.pts, opts);
    sk.layouts.set(l.id, { key, res });
    return res;
  }
  function nearestMass(l) {
    const c = centroid(l.pts);
    let best = null, bd = Infinity;
    for (const m of sk.model.masses) { const mc = centroid(m.pts), d = Math.hypot(mc[0] - c[0], mc[1] - c[1]); if (d < bd) { bd = d; best = mc; } }
    return best;
  }
  function stats() {
    const byUse = new Map();
    for (const m of sk.model.masses) byUse.set(m.use, (byUse.get(m.use) || 0) + massGfa(m));
    let req = 0;
    const reqBy = [];
    for (const [use, sf] of byUse) {
      const r = sk.model.ratios[use];
      if (!r) continue;
      const n = r.mode === 'unit' ? (sf / Math.max(1, r.unitSf || 1)) * r.r : sf / 1000 * r.r;
      req += n; reqBy.push([use, n]);
    }
    let prov = 0, acc = 0, van = 0, accReq = 0, short = 0;
    for (const l of sk.model.lots) { const L = lotLayout(l); prov += L.total; acc += L.acc; van += L.van; accReq += L.required.acc; short += L.short; }
    return { byUse, gfa: [...byUse.values()].reduce((a, v) => a + v, 0), req: Math.ceil(req), reqBy, prov, acc, van, accReq, short };
  }

  // ---------------------------------------------------------------- undo / change
  const SAVED = ['masses', 'lots', 'islands', 'drives'];
  function snapshot() { return JSON.stringify(Object.fromEntries(SAVED.map(k => [k, sk.model[k]]))); }
  function before() { sk.undo.push(snapshot()); if (sk.undo.length > 80) sk.undo.shift(); sk.redo.length = 0; }
  function restore(s) { const o = JSON.parse(s); for (const k of SAVED) sk.model[k] = o[k] || []; if (sk.sel && !findSel()) sk.sel = null; changed(); }
  function changed(soft = false) {
    sk.ver++;
    draw(); panel(); card(); live();
    clearTimeout(sk.saveT);
    sk.saveT = setTimeout(save, 400);
    if (!soft) ctx.onChange?.();
    else { clearTimeout(sk.softT); sk.softT = setTimeout(() => ctx.onChange?.(), 150); }
  }
  /** Quick refresh of the 3D blocks while dragging (the full rebuild waits until the drag pauses). */
  function live() { if (!sk.v3 || sk.liveQ) return; sk.liveQ = requestAnimationFrame(() => { sk.liveQ = 0; ctx.onLive?.(); }); }
  async function save() { if (sk.key) await ctx.idb.set(sk.key, sk.model).catch(() => {}); }
  const findSel = () => (sk.sel ? list(sk.sel.kind)?.find(o => o.id === sk.sel.id) : null);

  // ---------------------------------------------------------------- site
  async function onSite(site, pending) {
    sk.site = site; sk.sel = null; sk.draw = null; sk.layouts.clear(); sk.geoms.clear(); sk.undo = []; sk.redo = [];
    if (!site) { sk.key = null; sk.model = blank(); draw(); panel(); return; }
    const b = site.box;
    sk.key = `sketch:${site.zone.code}:${[b.xmin, b.ymin, b.xmax, b.ymax].map(v => Math.round(v / 10)).join(',')}`;
    let m = pending || await ctx.idb.get(sk.key).catch(() => null);
    if (!m || !m.masses) m = blank();
    for (const k of SAVED) if (!m[k]) m[k] = [];
    if (!m.scheme) m.scheme = JSON.parse(JSON.stringify(BUILTIN_SCHEMES[0]));
    if (!m.ratios) m.ratios = JSON.parse(JSON.stringify(DEFAULT_RATIOS));
    m.v = 2;
    sk.model = m;
    if (pending) save();
    sk.ver++;
    draw(); panel(); ctx.onChange?.();
  }

  // ---------------------------------------------------------------- views: the map, or the 3D view
  const canvas = document.createElement('canvas');
  canvas.className = 'sketch-canvas'; canvas.hidden = true;
  map.getContainer().appendChild(canvas);
  const toS = (M, p) => ctx.toScreen(M, p[0], p[1]);
  /** Screen position of a native point at output elevation z (map: z ignored). null = behind the 3D camera. */
  function scr(p, z) {
    if (sk.v3) return sk.v3.project(p[0], p[1], z ?? zGround(p));
    return toS(ctx.affine(sk.site), p);
  }
  const host = () => (sk.v3 ? sk.v3.el : map.getContainer());
  const visible = () => (sk.v3 ? sk.active : showOnMap());
  /** Blocks and lots show on the map in the Sketch tab and on the Existing site tab (not while sculpting grades). */
  function showOnMap() { return sk.active || ctx.mode() === 'existing'; }
  /** Elevation at which a block's handles sit (its outline top in 3D; the ground for everything else). */
  function handleZ(kind, o) {
    if (!sk.v3) return () => 0;
    if (kind === 'mass') { const z = massBase(o) + geom(o).tiers[0].h1 / ex3(); return () => z; }
    return p => zGround(p) + 0.2;
  }

  function draw() {
    const el = host(), dpr = window.devicePixelRatio || 1;
    const W = el.clientWidth, H = el.clientHeight;
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); canvas.style.width = `${W}px`; canvas.style.height = `${H}px`;
    }
    const g = canvas.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, canvas.width, canvas.height);
    if (!sk.site || !visible()) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (sk.v3) drawLabels3d(g); else drawPlan(g);
    drawSelection(g);
    drawInProgress(g);
  }
  /** Screen path of a ring (null if any corner is behind the camera). */
  function sPath(g, P, zf, close = true) {
    const Q = P.map(p => scr(p, zf ? zf(p) : undefined));
    if (Q.some(q => !q)) return false;
    g.beginPath(); Q.forEach((q, i) => (i ? g.lineTo(q[0], q[1]) : g.moveTo(q[0], q[1])));
    if (close) g.closePath();
    return true;
  }
  function drawPlan(g) {
    const M = ctx.affine(sk.site), px = M.scale;                 // screen px per native unit
    const path = (P, close = true) => sPath(g, P, null, close);
    const green = colorOf(scheme(), 'green');
    for (const l of sk.model.lots) {
      const L = lotLayout(l), sel = sk.sel?.id === l.id;
      path(l.pts); g.fillStyle = colorOf(scheme(), 'lot'); g.globalAlpha = 0.75; g.fill(); g.globalAlpha = 1;
      if (l.setback > 0 && L.inner?.length > 2) { path(l.pts); g.save(); g.clip(); g.fillStyle = green; g.globalAlpha = 0.55; g.fill(); g.restore(); path(L.inner); g.fillStyle = colorOf(scheme(), 'lot'); g.globalAlpha = 0.9; g.fill(); g.globalAlpha = 1; }
      for (const dp of L.drives || []) { path(dp); g.fillStyle = colorOf(scheme(), 'lot'); g.fill(); }
      if (px * 9 * perFt() > 2.2) {   // stalls only when they're big enough to see
        g.lineWidth = 1; g.strokeStyle = colorOf(scheme(), 'stripe');
        for (const st of L.stalls) {
          if (st.acc) { path(st.pts); g.fillStyle = colorOf(scheme(), 'accessible'); g.fill(); g.strokeStyle = colorOf(scheme(), 'stripe'); g.stroke(); continue; }
          if (st.aisle) { path(st.pts); g.save(); g.clip(); g.strokeStyle = colorOf(scheme(), 'accessible'); g.lineWidth = 1; const [a] = st.pts.map(p => toS(M, p)); for (let d = -60; d < 60; d += 5) { g.beginPath(); g.moveTo(a[0] + d, a[1] - 40); g.lineTo(a[0] + d + 40, a[1] + 40); g.stroke(); } g.restore(); continue; }
          const q = st.pts.map(p => toS(M, p));        // two side lines and the back line, like striping
          g.beginPath(); g.moveTo(...q[0]); g.lineTo(...q[3]); g.lineTo(...q[2]); g.lineTo(...q[1]); g.stroke();
        }
      }
      for (const isl of L.islands || []) { path(isl); g.fillStyle = green; g.fill(); g.strokeStyle = 'rgba(20,83,45,0.6)'; g.lineWidth = 1; g.stroke(); }
      path(l.pts); g.lineWidth = sel ? 2.5 : 1.5; g.strokeStyle = sel ? '#e8913f' : 'rgba(30,41,59,0.85)'; g.stroke();
    }
    for (const d of sk.model.drives) {
      const w = (d.w || 24) * perFt();
      for (let i = 0; i < d.pts.length - 1; i++) { path(lanePoly(d.pts[i], d.pts[i + 1], w)); g.fillStyle = colorOf(scheme(), 'lot'); g.globalAlpha = 0.9; g.fill(); g.globalAlpha = 1; }
      path(d.pts, false); g.setLineDash([8, 6]); g.strokeStyle = '#fde047'; g.lineWidth = 1.5; g.stroke(); g.setLineDash([]);
    }
    for (const isl of sk.model.islands) { path(isl.pts); g.fillStyle = green; g.fill(); g.strokeStyle = sk.sel?.id === isl.id ? '#e8913f' : 'rgba(20,83,45,0.8)'; g.lineWidth = sk.sel?.id === isl.id ? 2.5 : 1.2; g.stroke(); }
    for (const l of sk.model.lots) {
      const L = lotLayout(l);
      label(g, scr(centroid(l.pts)), `${L.total} spaces`, L.acc ? `${L.acc} accessible${L.van ? ` (${L.van} van)` : ''}${L.short ? ` · ${L.short} short` : ''}` : '');
    }
    // Massing, lowest first, each with its courtyard, step-back and roof lines.
    const ms = sk.model.masses.slice().sort((a, b) => massTop(a) - massTop(b));
    for (const m of ms) {
      const sel = sk.sel?.id === m.id, col = colorOf(scheme(), m.use), G = geom(m);
      g.beginPath();
      for (const R of [G.tiers[0].ring, G.tiers[0].hole].filter(Boolean)) {
        R.forEach((p, i) => { const [x, y] = toS(M, p); if (i) g.lineTo(x, y); else g.moveTo(x, y); });
        g.closePath();
      }
      g.fillStyle = col; g.globalAlpha = 0.88; g.fill('evenodd'); g.globalAlpha = 1;
      g.lineWidth = sel ? 2.5 : 1.25; g.strokeStyle = sel ? '#e8913f' : 'rgba(17,24,39,0.8)'; g.stroke();
      g.lineWidth = 1; g.strokeStyle = 'rgba(17,24,39,0.45)';
      for (const t of G.tiers.slice(1)) { path(t.ring); g.stroke(); }
      if (G.roof) for (const pc of G.roof.pieces) { path(pc); g.stroke(); }
    }
    for (const m of ms) {
      const u = scheme().uses.find(x => x.key === m.use);
      label(g, scr(labelPt(m)), `${u?.label || m.use} · ${m.floors} fl`, fmtArea(massGfa(m)));
    }
  }
  /** A label spot inside the block (not over a courtyard). */
  function labelPt(m) {
    const c = centroid(m.pts), G = geom(m);
    if (!G.tiers[0].hole && inPoly(m.pts, ...c)) return c;
    // Middle of the first wing: halfway between the first outline edge and the matching courtyard edge.
    const R = m.pts, H = G.tiers[0].hole || R;
    return [(R[0][0] + R[1][0] + H[0][0] + H[1][0]) / 4, (R[0][1] + R[1][1] + H[0][1] + H[1][1]) / 4];
  }
  function drawLabels3d(g) {
    for (const l of sk.model.lots) {
      const L = lotLayout(l), c = centroid(l.pts);
      label(g, scr(c, zGround(c) + 1), `${L.total} spaces`, L.acc ? `${L.acc} accessible${L.van ? ` (${L.van} van)` : ''}` : '');
    }
    for (const m of sk.model.masses) {
      const u = scheme().uses.find(x => x.key === m.use), c = labelPt(m);
      label(g, scr(c, massBase(m) + (massHeight(m) + (geom(m).roof ? 6 : 2)) / ex3()), `${u?.label || m.use} · ${m.floors} fl`, fmtArea(massGfa(m)));
    }
  }
  function label(g, q, a, b) {
    if (!q) return;
    const [x, y] = q;
    g.font = '600 12px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    const w = Math.max(g.measureText(a).width, b ? g.measureText(b).width * 0.92 : 0) + 12, h = b ? 32 : 18;
    g.fillStyle = 'rgba(255,255,255,0.88)'; g.strokeStyle = 'rgba(15,23,42,0.25)'; g.lineWidth = 1;
    g.beginPath(); g.roundRect(x - w / 2, y - h / 2, w, h, 4); g.fill(); g.stroke();
    g.fillStyle = '#111827'; g.fillText(a, x, b ? y - 7 : y);
    if (b) { g.font = '11px system-ui, sans-serif'; g.fillStyle = '#374151'; g.fillText(b, x, y + 8); }
  }

  // ---------------------------------------------------------------- selection handles
  /** Handles of the selection: corners (v), edge midpoints (m, drag to add a corner), rotate (r), scale (s). */
  function handles(kind, o) {
    const zf = handleZ(kind, o), out = [], P = o.pts, n = P.length, cl = closed(kind);
    P.forEach((p, i) => out.push({ t: 'v', i, p, z: zf(p) }));
    if (n <= 16) for (let i = 0; i < (cl ? n : n - 1); i++) { const a = P[i], b = P[(i + 1) % n], p = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; out.push({ t: 'm', i, p, z: zf(p) }); }
    if (cl) {
      const c = centroid(P), bb = bbox(P), r = Math.max(...P.map(p => Math.hypot(p[0] - c[0], p[1] - c[1])));
      const rp = [c[0], c[1] + r * 1.18 + 6 * perFt()], sp = [bb[2] + 8 * perFt(), bb[1] - 8 * perFt()];   // scale sits off the corner
      out.push({ t: 'r', p: rp, z: zf(rp), c }, { t: 's', p: sp, z: zf(sp), c });
    }
    return out;
  }
  function drawSelection(g) {
    const o = findSel(); if (!o) return;
    const kind = sk.sel.kind, zf = handleZ(kind, o);
    if (sk.v3) {      // outline of the selection, so it reads against the model
      if (sPath(g, o.pts, zf, closed(kind))) { g.lineWidth = 2.5; g.strokeStyle = '#e8913f'; g.stroke(); }
    }
    for (const h of handles(kind, o)) {
      const q = scr(h.p, h.z); if (!q) continue;
      const [x, y] = q;
      g.beginPath();
      if (h.t === 'v') { g.rect(x - 4, y - 4, 8, 8); g.fillStyle = '#fff'; g.fill(); g.strokeStyle = '#e8913f'; g.lineWidth = 1.5; g.stroke(); }
      else if (h.t === 'm') { g.arc(x, y, 3.2, 0, Math.PI * 2); g.fillStyle = 'rgba(232,145,63,0.85)'; g.fill(); }
      else {
        const cq = scr(h.c, h.z);
        if (h.t === 'r' && cq) { g.save(); g.setLineDash([3, 3]); g.strokeStyle = 'rgba(232,145,63,0.8)'; g.lineWidth = 1; g.beginPath(); g.moveTo(...cq); g.lineTo(x, y); g.stroke(); g.restore(); g.beginPath(); }
        g.arc(x, y, 8, 0, Math.PI * 2); g.fillStyle = '#1c2226'; g.fill(); g.strokeStyle = '#e8913f'; g.lineWidth = 1.5; g.stroke();
        g.fillStyle = '#e8913f'; g.font = '700 11px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(h.t === 'r' ? '⟳' : '⤡', x, y + 0.5);
      }
    }
  }
  function drawInProgress(g) {
    const d = sk.draw; if (!d) return;
    const P = drawPts();
    if (P.length > 1) {
      const cl = d.kind !== 'drive' && (d.rect || P.length > 2);
      const zf = sk.v3 ? (p => zGround(p) + 0.3) : null;
      if (sPath(g, P, zf, cl)) {
        if (cl) { g.fillStyle = d.kind === 'mass' ? colorOf(scheme(), sk.last?.use || scheme().uses[0].key) : d.kind === 'island' ? colorOf(scheme(), 'green') : colorOf(scheme(), 'lot'); g.globalAlpha = 0.45; g.fill(); g.globalAlpha = 1; }
        g.setLineDash([6, 4]); g.strokeStyle = '#e8913f'; g.lineWidth = d.kind === 'drive' ? 3 : 2; g.stroke(); g.setLineDash([]);
      }
      if (cl) {
        const ar = area(P) * sfPerNative2(), c = centroid(P);
        if (ar > 1) label(g, scr(c, zf ? zf(c) : undefined), fmtArea(ar), d.kind === 'mass' ? `${sk.last?.floors || 3} floors → ${fmtArea(ar * (sk.last?.floors || 3))}` : '');
      } else {
        let len = 0; for (let i = 1; i < P.length; i++) len += Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]);
        const c = P[P.length - 1];
        label(g, scr(c, zf ? zf(c) : undefined), `${Math.round(len / perFt() * outPerFt())} ${uLen()}`, '');
      }
    }
    for (const p of d.pts || []) { const q = scr(p, sk.v3 ? zGround(p) + 0.3 : undefined); if (!q) continue; g.beginPath(); g.arc(q[0], q[1], 3.5, 0, Math.PI * 2); g.fillStyle = '#e8913f'; g.fill(); }
  }
  const rectPts = (a, b) => [[a[0], a[1]], [b[0], a[1]], [b[0], b[1]], [a[0], b[1]]];
  function drawPts() {
    const d = sk.draw;
    if (d.rect) {
      if (d.kind === 'drive') return [d.a, d.b];
      if (d.kind === 'mass' && d.shape !== 'box') return presetShape(d.shape === 'court' ? 'box' : d.shape, d.a, d.b);
      return rectPts(d.a, d.b);
    }
    return [...(d.pts || []), ...(d.hover ? [d.hover] : [])];
  }

  // ---------------------------------------------------------------- toolbar
  const bar = document.createElement('div');
  bar.className = 'sketch-bar'; bar.hidden = true;
  bar.innerHTML = TOOLS.map(t => `<button type="button" class="sk-tool" data-tool="${t.id}" title="${t.label} (${t.key})" aria-label="${t.label}">${svg(t.icon)}<kbd>${t.key}</kbd><span>${t.label}</span></button>`).join('')
    + '<div class="sk-sep"></div><button type="button" class="sk-tool sk-mini" data-act="undo" title="Undo (Ctrl+Z)" aria-label="Undo"><svg viewBox="0 0 24 24"><path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 010 12h-3"/></svg><kbd>^Z</kbd></button>'
    + '<button type="button" class="sk-tool sk-mini" data-act="redo" title="Redo (Ctrl+Y)" aria-label="Redo"><svg viewBox="0 0 24 24"><path d="M15 14l5-5-5-5"/><path d="M20 9H10a6 6 0 000 12h3"/></svg><kbd>^Y</kbd></button>'
    + `<div class="sk-shapes" hidden>${SHAPES.map(s => `<button type="button" class="sk-tool sk-mini" data-shape="${s.id}" title="${s.label} (${s.key})" aria-label="${s.label}">${svg(s.icon)}<kbd>${s.key}</kbd></button>`).join('')}</div>`;
  map.getContainer().appendChild(bar);
  L.DomEvent.disableClickPropagation(bar); L.DomEvent.disableScrollPropagation(bar);
  bar.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.tool) setTool(b.dataset.tool);
    if (b.dataset.shape) setShape(b.dataset.shape);
    if (b.dataset.act === 'undo') doUndo();
    if (b.dataset.act === 'redo') doRedo();
  });
  function setTool(t) {
    sk.tool = t; sk.draw = null;
    bar.querySelectorAll('[data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === t));
    bar.querySelector('.sk-shapes').hidden = t !== 'mass';
    setShape(sk.shape, true);
    map.getContainer().classList.toggle('sk-drawing', t !== 'select');
    sk.v3?.el.classList.toggle('sk-drawing', t !== 'select' && sk.active);
    sk.v3?.sketchNav(sk.active && t !== 'select');
    const hint = HINTS[t] + (sk.v3 && t !== 'select' ? ' In 3D: right-drag orbits, Shift+right-drag pans.' : '');
    if ($('sk-hint')) $('sk-hint').textContent = hint;
    draw();
  }
  function setShape(s, quiet) {
    sk.shape = s;
    bar.querySelectorAll('[data-shape]').forEach(b => b.classList.toggle('on', b.dataset.shape === s));
    if (!quiet && sk.tool !== 'mass') setTool('mass');
  }
  function doUndo() { if (!sk.undo.length) return; sk.redo.push(snapshot()); restore(sk.undo.pop()); }
  function doRedo() { if (!sk.redo.length) return; sk.undo.push(snapshot()); restore(sk.redo.pop()); }

  // ---------------------------------------------------------------- floating property card
  const cardEl = document.createElement('div');
  cardEl.className = 'sk-card'; cardEl.hidden = true;
  map.getContainer().appendChild(cardEl);
  L.DomEvent.disableClickPropagation(cardEl); L.DomEvent.disableScrollPropagation(cardEl);
  const num = (k, v, min, max, step, w = 46) => `<input type="number" data-k="${k}" min="${min}" max="${max}" step="${step}" value="${v}" style="width:${w}px">`;
  function cardHtml(kind, o) {
    if (kind === 'mass') {
      const r = o.roof || { type: 'flat', pitch: 6 }, st = o.step || { at: 0, inset: 10 };
      return `<div class="skc-row"><select data-k="use">${scheme().uses.map(u => `<option value="${u.key}"${u.key === o.use ? ' selected' : ''}>${escapeHtml(u.label)}</option>`).join('')}</select>
          <button type="button" data-k="del" title="Delete (Del)">🗑</button></div>
        <div class="skc-row"><span>Floors</span><button type="button" data-k="fl-">−</button><output data-o="floors"></output><button type="button" data-k="fl+">+</button>
          <span>@</span>${num('ftf', o.ftf, 2, 40, 0.5)}<span>${uLen()}</span></div>
        <div class="skc-row seg seg-dark" title="Roof form (R)">${ROOFS.map(([k, l]) => `<label><input type="radio" name="skc-roof" value="${k}"${r.type === k ? ' checked' : ''}><span>${l}</span></label>`).join('')}</div>
        ${r.type !== 'flat' ? `<div class="skc-row"><span>Pitch</span>${num('pitch', r.pitch, 0.5, 24, 0.5, 42)}<span>: 12</span>${r.type === 'shed' ? '<button type="button" data-k="flip" title="Turn the slope around">⇄</button>' : ''}</div>` : ''}
        <div class="skc-row"><span title="Open courtyard: building depth around it (0 = solid)">Courtyard ring</span>${num('court', o.court || 0, 0, 500, 5)}<span>${uLen()} deep</span></div>
        <div class="skc-row"><span title="Upper floors step back from the outline">Step back above floor</span>${num('stepAt', st.at || 0, 0, 120, 1, 40)}<span>by</span>${num('stepIn', st.inset, 1, 200, 1, 40)}<span>${uLen()}</span></div>
        <div class="skc-row skc-read" data-o="read"></div>`;
    }
    if (kind === 'lot') {
      return `<div class="skc-row seg seg-dark">${[90, 60, 45].map(a => `<label><input type="radio" name="skc-ang" value="${a}"${o.stall === a ? ' checked' : ''}><span>${a}°</span></label>`).join('')}
          <button type="button" data-k="del" title="Delete (Del)">🗑</button></div>
        <div class="skc-row"><span>Rows</span><button type="button" data-k="rot-" title="Turn ([)">⟲</button><button type="button" data-k="rot0" title="Line up with the longest side">auto</button><button type="button" data-k="rot+" title="Turn (])">⟳</button>
          <button type="button" data-k="sh-" title="Slide rows (↑)">▲</button><button type="button" data-k="sh+" title="Slide rows (↓)">▼</button></div>
        <div class="skc-row"><span title="Landscape strip inside the lot edge">Edge buffer</span>${num('setback', o.setback || 0, 0, 100, 1, 42)}<span>${uLen()}</span></div>
        <div class="skc-row"><label class="skc-chk"><input type="checkbox" data-k="endIslands"${o.endIslands ? ' checked' : ''}> End islands</label>
          <span>Island every</span>${num('islandEvery', o.islandEvery || 0, 0, 40, 1, 38)}<span>stalls</span></div>
        <div class="skc-row skc-read" data-o="read"></div>`;
    }
    if (kind === 'drive') {
      return `<div class="skc-row"><span>Drive aisle</span>${num('w', o.w || 24, 10, 60, 1)}<span>${uLen()} wide</span><button type="button" data-k="del" title="Delete (Del)">🗑</button></div>
        <div class="skc-row skc-read" data-o="read"></div>`;
    }
    return `<div class="skc-row"><span>Planter island</span><button type="button" data-k="del" title="Delete (Del)">🗑</button></div><div class="skc-row skc-read" data-o="read"></div>`;
  }
  function card() {
    const o = findSel();
    if (!o || !sk.active || !sk.site || sk.drag || sk.draw || (sk.v3 && !sk.v3.visible)) { cardEl.hidden = true; return; }
    const kind = sk.sel.kind, zf = handleZ(kind, o);
    let x1 = -Infinity, y0 = Infinity;
    for (const p of o.pts) { const q = scr(p, zf(p)); if (!q) continue; if (q[0] > x1) x1 = q[0]; if (q[1] < y0) y0 = q[1]; }
    if (!Number.isFinite(x1)) { cardEl.hidden = true; return; }
    const W = cardEl.parentElement.clientWidth, H = cardEl.parentElement.clientHeight;
    const sig = `${kind}:${o.id}:${sk.cardVer || 0}:${JSON.stringify([o.roof?.type, o.stall, o.endIslands, o.court, o.step, o.roof?.pitch, o.ftf, o.setback, o.islandEvery, o.w, o.use])}`;
    if (cardEl.dataset.sig !== sig && !cardEl.contains(document.activeElement)) { cardEl.dataset.sig = sig; cardEl.innerHTML = cardHtml(kind, o); }
    const read = cardEl.querySelector('[data-o="read"]');
    if (kind === 'mass') {
      cardEl.querySelector('[data-o="floors"]').textContent = String(o.floors);
      const G = geom(o), roofH = G.roof ? Math.max(...o.pts.map(p => G.roof.at(...p)), ...G.roof.pieces.flat().map(p => G.roof.at(...p))) : 0;
      read.textContent = `${fmtArea(area(o.pts) * sfPerNative2())} footprint · ${fmtArea(massGfa(o))} total · ${(massHeight(o) + roofH).toFixed(0)} ${uLen()} tall`;
    } else if (kind === 'lot') {
      const Lr = lotLayout(o);
      read.textContent = `${Lr.total} spaces (${Lr.acc} accessible${Lr.van ? `, ${Lr.van} van` : ''}) · ${Math.round(area(o.pts) * sfPerNative2() / Math.max(1, Lr.total))} sf per space`;
    } else if (kind === 'drive') {
      let len = 0; for (let i = 1; i < o.pts.length; i++) len += Math.hypot(o.pts[i][0] - o.pts[i - 1][0], o.pts[i][1] - o.pts[i - 1][1]);
      read.textContent = `${Math.round(len / perFt() * outPerFt())} ${uLen()} long · stalls it crosses are cleared`;
    } else read.textContent = fmtArea(area(o.pts) * sfPerNative2());
    cardEl.hidden = false;
    const cw = cardEl.offsetWidth || 240, ch = cardEl.offsetHeight || 120;
    cardEl.style.left = `${Math.max(8, Math.min(W - cw - 8, x1 + 14))}px`;
    cardEl.style.top = `${Math.max(56, Math.min(H - ch - 8, y0 - 4))}px`;
  }
  cardEl.addEventListener('click', e => {
    const b = e.target.closest('button[data-k]'); const o = findSel(); if (!b || !o) return;
    const k = b.dataset.k;
    if (k === 'del') { removeSel(); return; }
    if (k === 'fl-' || k === 'fl+') { before(); o.floors = Math.max(1, Math.min(120, o.floors + (k === 'fl+' ? 1 : -1))); remember(o); changed(true); }
    if (k === 'flip') { before(); o.roof = { ...o.roof, flip: !o.roof?.flip }; changed(true); }
    if (k.startsWith('rot') || k.startsWith('sh')) {
      before();
      const cur = o.angle ?? longestEdgeAngle(o.pts);
      if (k === 'rot-') o.angle = cur - Math.PI / 36; if (k === 'rot+') o.angle = cur + Math.PI / 36; if (k === 'rot0') o.angle = null;
      if (k === 'sh-') o.shift = (o.shift || 0) - 3; if (k === 'sh+') o.shift = (o.shift || 0) + 3;
      changed(true);
    }
  });
  cardEl.addEventListener('change', e => {
    const o = findSel(); if (!o) return;
    const t = e.target, k = t.dataset.k, v = Number(t.value);
    before();
    if (k === 'use') o.use = t.value;
    if (k === 'ftf') o.ftf = Math.max(2, v || o.ftf);
    if (t.name === 'skc-roof') o.roof = { pitch: o.roof?.pitch || 6, ...o.roof, type: t.value };
    if (k === 'pitch') o.roof = { ...o.roof, pitch: Math.max(0.5, Math.min(24, v || 6)) };
    if (k === 'court') o.court = Math.max(0, v || 0);
    if (k === 'stepAt' || k === 'stepIn') {
      const st = o.step || { at: 0, inset: 10 };
      if (k === 'stepAt') st.at = Math.max(0, Math.min(o.floors - 1, Math.round(v) || 0)); else st.inset = Math.max(1, v || 10);
      o.step = st.at > 0 ? st : (k === 'stepIn' ? st : null);
    }
    if (t.name === 'skc-ang') { o.stall = v; sk.lastStall = v; }
    if (k === 'setback') o.setback = Math.max(0, v || 0);
    if (k === 'endIslands') o.endIslands = t.checked;
    if (k === 'islandEvery') o.islandEvery = Math.max(0, Math.round(v) || 0);
    if (k === 'w') o.w = Math.max(10, Math.min(60, v || 24));
    if (sk.sel.kind === 'mass') remember(o);
    cardEl.dataset.sig = '';
    changed();
  });
  function remember(o) { sk.last = { use: o.use, floors: o.floors, ftf: o.ftf, roof: o.roof?.type || 'flat' }; }
  function removeSel() {
    if (!sk.sel) return;
    before();
    sk.model[LISTS[sk.sel.kind]] = list(sk.sel.kind).filter(m => m.id !== sk.sel.id);
    sk.sel = null; changed();
  }

  // ---------------------------------------------------------------- pointer (shared by the map and the 3D view)
  // ev: { sx, sy (px in the view), xy (ground point, native) , at(z) (point on the plane at elevation z), shift, alt }
  const ortho = (a, b) => (Math.abs(b[0] - a[0]) > Math.abs(b[1] - a[1]) ? [b[0], a[1]] : [a[0], b[1]]);
  const distSeg = (p, a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1; const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2)); return Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t); };
  function hit(ev) {
    const o = findSel();
    if (o) for (const h of handles(sk.sel.kind, o)) { const q = scr(h.p, h.z); if (q && Math.hypot(q[0] - ev.sx, q[1] - ev.sy) < (h.t === 'r' || h.t === 's' ? 10 : 7)) return { kind: sk.sel.kind, id: o.id, h, z: h.z }; }
    if (sk.v3) { const p = sk.v3.pickSketch(ev.sx, ev.sy); if (p && p.id) return { kind: 'mass', id: p.id, z: p.at[2] }; }
    const xy = ev.xy; if (!xy) return null;
    const zg = zGround(xy);
    if (!sk.v3) {
      const ms = sk.model.masses.slice().sort((a, b) => massTop(b) - massTop(a));
      for (const m of ms) if (Number.isFinite(heightAt(geom(m), ...xy))) return { kind: 'mass', id: m.id, z: 0 };
    }
    const tol = sk.v3 ? 0 : 4 / ctx.affine(sk.site).scale;
    for (const d of sk.model.drives) for (let i = 0; i < d.pts.length - 1; i++) if (distSeg(xy, d.pts[i], d.pts[i + 1]) < (d.w || 24) * perFt() / 2 + tol) return { kind: 'drive', id: d.id, z: zg };
    for (const i of sk.model.islands) if (inPoly(i.pts, ...xy)) return { kind: 'island', id: i.id, z: zg };
    for (const l of sk.model.lots) if (inPoly(l.pts, ...xy)) return { kind: 'lot', id: l.id, z: zg };
    return null;
  }
  function finishDraw(pts) {
    const d = sk.draw;
    sk.draw = null;
    const kind = d.kind;
    if (kind === 'drive') {
      let len = 0; for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      if (pts.length < 2 || len / perFt() < 10) { draw(); return; }
    } else if (pts.length < 3 || area(pts) * sfPerNative2() < 50) { draw(); return; }
    before();
    const o = { id: uid(), pts };
    if (kind === 'mass') {
      Object.assign(o, { use: sk.last?.use || scheme().uses[0].key, floors: sk.last?.floors || 3, ftf: sk.last?.ftf || (metric() ? 3.6 : 12) });
      if (sk.last?.roof && sk.last.roof !== 'flat') o.roof = { type: sk.last.roof, pitch: 6 };
      if (d.shape === 'court' && d.rect) { const bb = bbox(pts); o.court = Math.max(10, Math.round(Math.min(bb[2] - bb[0], bb[3] - bb[1]) * 0.3 / perFt() * outPerFt() / 5) * 5); }
    } else if (kind === 'lot') Object.assign(o, { stall: sk.lastStall || 90, shift: 0, angle: null, setback: 0, endIslands: false, islandEvery: 0 });
    else if (kind === 'drive') o.w = 24;
    list(kind).push(o);
    sk.sel = { kind, id: o.id };
    changed();
  }
  /** Pointer down; true when the sketch took it (so the map / 3D camera shouldn't). */
  function down(ev) {
    if (!sk.active || !sk.site) return false;
    if (sk.tool !== 'select') {
      const xy = ev.xy; if (!xy) return true;
      if (sk.draw?.pts) {      // outline in progress
        const q = scr(sk.draw.pts[0], sk.v3 ? zGround(sk.draw.pts[0]) + 0.3 : undefined);
        if (sk.tool !== 'drive' && sk.draw.pts.length >= 3 && q && Math.hypot(q[0] - ev.sx, q[1] - ev.sy) < 10) { finishDraw(sk.draw.pts); return true; }
        sk.draw.pts.push(ev.shift ? ortho(sk.draw.pts.at(-1), xy) : xy);
        draw(); return true;
      }
      sk.draw = { kind: sk.tool, shape: sk.tool === 'mass' ? sk.shape : 'box', a: xy, b: xy, cp: [ev.sx, ev.sy], rect: false, pending: true };
      card();
      return true;
    }
    const h = hit(ev);
    if (!h) { sk.clickEmpty = [ev.sx, ev.sy]; return false; }
    const src = list(h.kind).find(o => o.id === h.id);
    if (ev.alt && h.h?.t === 'v') {                         // Alt+click a corner: remove it
      if (src.pts.length > (closed(h.kind) ? 3 : 2)) { before(); src.pts.splice(h.h.i, 1); changed(); }
      return true;
    }
    let target = h, obj = src;
    const pushed = ev.alt && !h.h;
    if (pushed) {                                          // Alt+drag: duplicate and move the copy
      before();
      obj = JSON.parse(JSON.stringify(src)); obj.id = uid();
      list(h.kind).push(obj);
      target = { ...h, id: obj.id };
    }
    const start = ev.at(h.z) || ev.xy; if (!start) return true;
    // Moving a lot takes its islands and drive aisles along.
    const carry = h.kind === 'lot' && (!h.h || h.h.t === 'r') ? [...sk.model.islands, ...sk.model.drives].filter(q => inPoly(src.pts, ...centroid(q.pts))).map(q => ({ q, orig: JSON.parse(JSON.stringify(q.pts)) })) : [];
    sk.drag = { kind: target.kind, id: target.id, h: h.h, z: h.z, start, orig: JSON.parse(JSON.stringify(obj.pts)), angle0: obj.angle, carry, pushed, sx: ev.sx, sy: ev.sy };
    sk.sel = { kind: target.kind, id: target.id };
    draw(); panel(); card();
    return true;
  }
  function move(ev) {
    if (!sk.active || !sk.site) return;
    const d = sk.draw;
    if (d && d.pending !== undefined && !d.pts) {
      if (d.pending && Math.hypot(ev.sx - d.cp[0], ev.sy - d.cp[1]) > 6) { d.pending = false; d.rect = true; }
      if (d.rect) {
        const xy = ev.xy; if (!xy) return;
        let b = xy;
        if (ev.shift && d.kind !== 'drive' && d.shape !== 'circle') { const m = Math.max(Math.abs(xy[0] - d.a[0]), Math.abs(xy[1] - d.a[1])); b = [d.a[0] + Math.sign(xy[0] - d.a[0]) * m, d.a[1] + Math.sign(xy[1] - d.a[1]) * m]; }
        if (ev.shift && d.kind === 'drive') b = ortho(d.a, xy);
        d.b = b; draw();
      }
      return;
    }
    if (d?.pts) { const xy = ev.xy; if (xy) { d.hover = ev.shift ? ortho(d.pts.at(-1), xy) : xy; draw(); } return; }
    if (!sk.drag) return;
    const g = sk.drag, o = list(g.kind).find(q => q.id === g.id);
    if (!o) return;
    const cur = ev.at(g.z); if (!cur) return;
    if (!g.pushed) { before(); g.pushed = true; }
    const dx = cur[0] - g.start[0], dy = cur[1] - g.start[1];
    const P = g.orig.map(p => p.slice()), n = P.length, t = g.h?.t;
    if (t === 'm' && !g.inserted) { g.inserted = true; g.h = { t: 'v', i: g.h.i + 1 }; P.splice(g.h.i, 0, g.start.slice()); g.orig = P.map(p => p.slice()); return move(ev); }
    if (t === 'v') {
      const i = g.h.i;
      let p = [P[i][0] + dx, P[i][1] + dy];
      if (ev.shift) p = ortho(P[(i - 1 + n) % n], p);
      // A rectangle stays a rectangle when a corner is dragged (its two neighbours follow).
      if (n === 4 && closed(g.kind) && isRect(P)) { const a = (i + 1) % 4, c = (i + 3) % 4, opp = P[(i + 2) % 4]; P[i] = p; if (Math.abs(P[a][0] - opp[0]) < 1e-6) { P[a] = [opp[0], p[1]]; P[c] = [p[0], opp[1]]; } else { P[a] = [p[0], opp[1]]; P[c] = [opp[0], p[1]]; } }
      else P[i] = p;
      o.pts = P;
    } else if (t === 'r' || t === 's') {
      const c = g.h.c;
      if (t === 'r') {
        let a = Math.atan2(cur[1] - c[1], cur[0] - c[0]) - Math.atan2(g.start[1] - c[1], g.start[0] - c[0]);
        if (ev.shift) a = Math.round(a / (Math.PI / 12)) * Math.PI / 12;
        const cs = Math.cos(a), sn = Math.sin(a), rot = ([x, y]) => [c[0] + (x - c[0]) * cs - (y - c[1]) * sn, c[1] + (x - c[0]) * sn + (y - c[1]) * cs];
        o.pts = g.orig.map(rot);
        if (g.kind === 'lot' && g.angle0 != null) o.angle = g.angle0 + a;
        for (const cq of g.carry) cq.q.pts = cq.orig.map(rot);
      } else {
        const f = Math.max(0.05, Math.hypot(cur[0] - c[0], cur[1] - c[1]) / Math.max(1e-9, Math.hypot(g.start[0] - c[0], g.start[1] - c[1])));
        o.pts = g.orig.map(([x, y]) => [c[0] + (x - c[0]) * f, c[1] + (y - c[1]) * f]);
      }
    } else {
      o.pts = g.orig.map(([x, y]) => [x + dx, y + dy]);
      for (const cq of g.carry) cq.q.pts = cq.orig.map(([x, y]) => [x + dx, y + dy]);
    }
    g.moved = true;
    draw(); panel(); live();
    clearTimeout(sk.softT); sk.softT = setTimeout(() => ctx.onChange?.(), 160);
  }
  const isRect = P => P.length === 4 && [0, 1, 2, 3].every(i => { const a = P[i], b = P[(i + 1) % 4]; return Math.abs(a[0] - b[0]) < 1e-6 || Math.abs(a[1] - b[1]) < 1e-6; });
  function up(ev) {
    if (!sk.active) return;
    if (sk.clickEmpty) {
      const [x, y] = sk.clickEmpty; sk.clickEmpty = null;
      if (ev && Math.hypot(ev.sx - x, ev.sy - y) < 5) { sk.sel = null; draw(); panel(); card(); }
    }
    const d = sk.draw;
    if (d && !d.pts) {
      if (d.rect) { finishDraw(drawPts()); return; }
      sk.draw = { kind: d.kind, shape: d.shape, pts: [d.a] }; draw(); return;   // a click without dragging starts an outline
    }
    if (sk.drag) { const moved = sk.drag.moved; sk.drag = null; if (moved) changed(true); else card(); }
  }
  function finishOutline() {
    if (!sk.draw?.pts) return;
    const P = sk.draw.pts.slice();
    if (P.length > 2 && Math.hypot(P.at(-1)[0] - P.at(-2)[0], P.at(-1)[1] - P.at(-2)[1]) < 1e-6) P.pop();
    if (P.length >= (sk.draw.kind === 'drive' ? 2 : 3)) finishDraw(P);
  }

  // Map events.
  const mapEv = e => { const xy = ctx.toNative(e.latlng); return { sx: e.containerPoint.x, sy: e.containerPoint.y, xy, at: () => xy, shift: e.originalEvent.shiftKey, alt: e.originalEvent.altKey }; };
  map.on('mousedown', e => { if (sk.v3 || e.originalEvent.button !== 0) return; if (down(mapEv(e))) map.dragging.disable(); });
  map.on('mousemove', e => { if (!sk.v3) move(mapEv(e)); });
  map.on('mouseup', e => { if (!sk.v3 && sk.active) { map.dragging.enable(); up(mapEv(e)); } });
  document.addEventListener('mouseup', e => {
    if (sk.v3 || !(sk.drag || (sk.draw && !sk.draw.pts))) return;
    map.dragging.enable();
    const r = map.getContainer().getBoundingClientRect();
    up({ sx: e.clientX - r.left, sy: e.clientY - r.top });
  });
  map.on('dblclick', () => { if (sk.active && !sk.v3) finishOutline(); });
  map.on('move zoom resize viewreset', () => { if (!sk.v3 && showOnMap()) { draw(); card(); } });
  map.on('zoomstart', () => { if (!sk.v3 && showOnMap()) canvas.style.visibility = 'hidden'; });
  map.on('zoomend', () => { canvas.style.visibility = ''; if (!sk.v3 && showOnMap()) { draw(); card(); } });

  // 3D events: capture phase on the stage, so a sketch drag never also orbits the camera.
  const wired = new WeakSet();
  function wire3d(v3) {
    const stage = v3.el;
    if (wired.has(stage)) return;
    wired.add(stage);
    const ev3 = e => {
      const r = stage.getBoundingClientRect(), sx = e.clientX - r.left, sy = e.clientY - r.top;
      let gxy;
      return { sx, sy, get xy() { if (gxy === undefined) { const p = sk.v3?.pickGround(sx, sy); gxy = p ? p.slice(0, 2) : null; } return gxy; },
        at: z => sk.v3?.pickPlane(sx, sy, z) || null, shift: e.shiftKey, alt: e.altKey };
    };
    stage.addEventListener('pointerdown', e => {
      if (sk.v3 !== v3 || !sk.active || e.button !== 0) return;
      if (down(ev3(e))) { e.stopPropagation(); e.preventDefault(); sk.p3 = true; }
    }, true);
    window.addEventListener('pointermove', e => {
      if (sk.v3 !== v3 || !sk.active) return;
      if (sk.drag || sk.draw) { if (sk.drag || e.target === stage || stage.contains(e.target)) move(ev3(e)); }
    });
    window.addEventListener('pointerup', e => {
      if (sk.v3 !== v3 || !sk.active) return;
      if (sk.p3 || sk.clickEmpty) { sk.p3 = false; up(ev3(e)); }
    });
    stage.addEventListener('dblclick', e => { if (sk.v3 === v3 && sk.active) { e.stopPropagation(); finishOutline(); } }, true);
  }
  /** Follow the 3D view (v3 = the viewer while the 3D tab shows, else null). */
  function attach3d(v3) {
    if (sk.v3 && sk.v3 !== v3) { delete sk.v3.frames.sketch; sk.v3.sketchNav(false); sk.v3.el.classList.remove('sk-drawing'); }
    sk.v3 = v3 || null;
    sk.draw = null; sk.drag = null;
    if (v3) {
      wire3d(v3);
      v3.el.appendChild(canvas);
      v3.el.parentElement.appendChild(bar); v3.el.parentElement.appendChild(cardEl);
      v3.frames.sketch = () => { if (sk.active) { draw(); card(); } };
    } else {
      const c = map.getContainer();
      c.appendChild(canvas); c.appendChild(bar); c.appendChild(cardEl);
    }
    canvas.hidden = !visible();
    setTool(sk.tool);
    draw(); card();
  }

  const typing = e => /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName) && !['range', 'checkbox', 'radio'].includes(e.target.type);
  // Capture phase, so keys used here (arrows) don't also pan the map.
  document.addEventListener('keydown', e => {
    if (!sk.active) return;
    if (onKey(e)) e.stopPropagation();
  }, true);
  function onKey(e) {
    if (typing(e)) { if (e.key === 'Escape' || e.key === 'Enter') e.target.blur(); return false; }
    const k = e.key;
    if (k === 'Escape') { if (sk.draw) { sk.draw = null; draw(); } else if (sk.tool !== 'select') setTool('select'); else { sk.sel = null; draw(); panel(); card(); } return true; }
    if (k === 'Enter' && sk.draw?.pts) { e.preventDefault(); finishOutline(); return true; }
    if (k === 'Backspace' && sk.draw?.pts) { e.preventDefault(); sk.draw.pts.pop(); if (!sk.draw.pts.length) sk.draw = null; draw(); return true; }
    if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); return true; }
    if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'y') { e.preventDefault(); doRedo(); return true; }
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    const t = TOOLS.find(x => x.key.toLowerCase() === k.toLowerCase());
    if (t) { e.preventDefault(); setTool(t.id); return true; }
    const s = SHAPES.find(x => x.key === k);
    if (s) { e.preventDefault(); setShape(s.id); return true; }
    const o = findSel();
    if (!o) return false;
    const kind = sk.sel.kind;
    if (k === 'Delete' || k === 'Backspace') { e.preventDefault(); removeSel(); return true; }
    if (kind === 'mass' && (k === 'ArrowUp' || k === 'ArrowDown')) { e.preventDefault(); before(); o.floors = Math.max(1, Math.min(120, o.floors + (k === 'ArrowUp' ? 1 : -1))); remember(o); changed(true); return true; }
    if (kind === 'mass' && k.toLowerCase() === 'r') {
      e.preventDefault(); before();
      const i = ROOFS.findIndex(r => r[0] === (o.roof?.type || 'flat'));
      o.roof = { pitch: o.roof?.pitch || 6, ...o.roof, type: ROOFS[(i + 1) % ROOFS.length][0] }; remember(o); changed(true); return true;
    }
    if (kind === 'lot' && (k === 'ArrowUp' || k === 'ArrowDown')) { e.preventDefault(); before(); o.shift = (o.shift || 0) + (k === 'ArrowUp' ? -3 : 3); changed(true); return true; }
    if (kind === 'lot' && (k === '[' || k === ']')) { e.preventDefault(); before(); o.angle = (o.angle ?? longestEdgeAngle(o.pts)) + (k === ']' ? 1 : -1) * Math.PI / 36; changed(true); return true; }
    return false;
  }

  // ---------------------------------------------------------------- side panel: stats, scheme, ratios
  function panel() {
    if (!$('sk-stats')) return;
    const has = !!sk.site;
    $('sk-empty').hidden = has; $('sk-body').hidden = !has;
    if (!has) return;
    const st = stats();
    const useRows = [...st.byUse].sort((a, b) => b[1] - a[1]).map(([u, sf]) => {
      const def = scheme().uses.find(x => x.key === u);
      return `<div class="sk-srow"><i style="background:${colorOf(scheme(), u)}"></i><span>${escapeHtml(def?.label || u)}</span><b>${fmtArea(sf)}</b></div>`;
    }).join('');
    const diff = st.prov - st.req;
    $('sk-stats').innerHTML = `
      <div class="sk-big"><div><small>Floor area</small><b>${fmtArea(st.gfa)}</b></div><div><small>Blocks</small><b>${sk.model.masses.length}</b></div></div>
      ${useRows || '<p class="hint">Draw a block with the Massing tool (M).</p>'}
      <div class="sk-big sk-park ${st.req ? (diff >= 0 ? 'ok' : 'short') : ''}">
        <div><small>Parking provided</small><b>${st.prov}</b></div><div><small>Required</small><b>${st.req || '—'}</b></div>
        <div><small>${diff >= 0 ? 'Surplus' : 'Short'}</small><b>${st.req ? Math.abs(diff) : '—'}</b></div></div>
      <p class="hint">${st.acc} accessible provided (${st.accReq} required${st.van ? `, ${st.van} van` : ''})${st.short ? ` — <strong>${st.short} short: a row is too short for the accessible group</strong>` : ''}. Accessible counts per lot by the 2010 ADA Standards (Table 208.2, 208.2.4).</p>`;
    schemeUi(); ratiosUi(); listUi();
  }
  function listUi() {
    const el = $('sk-list'); if (!el) return;
    const rows = [
      ...sk.model.masses.map(m => ({ kind: 'mass', o: m, t: `${scheme().uses.find(u => u.key === m.use)?.label || m.use} · ${m.floors} fl · ${fmtArea(massGfa(m))}`, c: colorOf(scheme(), m.use) })),
      ...sk.model.lots.map(l => ({ kind: 'lot', o: l, t: `Parking · ${lotLayout(l).total} spaces · ${l.stall}°`, c: colorOf(scheme(), 'lot') })),
      ...sk.model.drives.map(d => ({ kind: 'drive', o: d, t: `Drive aisle · ${d.w || 24} ${uLen()}`, c: colorOf(scheme(), 'lot') })),
      ...sk.model.islands.map(i => ({ kind: 'island', o: i, t: `Island · ${fmtArea(area(i.pts) * sfPerNative2())}`, c: colorOf(scheme(), 'green') })),
    ];
    el.innerHTML = rows.length ? rows.map(r => `<button type="button" class="sk-item${sk.sel?.id === r.o.id ? ' on' : ''}" data-kind="${r.kind}" data-id="${r.o.id}"><i style="background:${r.c}"></i>${escapeHtml(r.t)}</button>`).join('') : '';
  }
  function schemeUi() {
    const sel = $('sk-scheme'); if (!sel) return;
    const cur = scheme();
    const all = allSchemes();
    const opts = all.map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('') + (all.some(s => s.id === cur.id) ? '' : `<option value="${cur.id}">${escapeHtml(cur.name)} (this project)</option>`);
    if (sel.dataset.html !== opts) { sel.innerHTML = opts; sel.dataset.html = opts; }
    sel.value = cur.id;
    const sw = (arr, grp) => arr.map((u, i) => `<label class="sk-sw" title="${escapeHtml(u.label)}"><input type="color" value="${u.color}" data-grp="${grp}" data-i="${i}"><span>${escapeHtml(u.label)}</span></label>`).join('');
    const html = `<div class="sk-swh">Building uses</div>${sw(cur.uses, 'uses')}<div class="sk-swh">Site and diagram</div>${sw(cur.site, 'site')}`;
    if ($('sk-swatches').dataset.html !== html) { $('sk-swatches').innerHTML = html; $('sk-swatches').dataset.html = html; }
    $('sk-scheme-del').hidden = !!cur.builtin || !all.some(s => s.id === cur.id);
  }
  function ratiosUi() {
    const el = $('sk-ratios'); if (!el) return;
    const html = scheme().uses.map(u => {
      const r = sk.model.ratios[u.key] || { mode: 'ksf', r: 0 };
      return `<div class="sk-ratio" data-use="${u.key}"><i style="background:${u.color}"></i><span>${escapeHtml(u.label)}</span>
        <input type="number" min="0" step="0.1" value="${r.r}" data-f="r" aria-label="Spaces">
        <select data-f="mode"><option value="ksf"${r.mode === 'ksf' ? ' selected' : ''}>per 1,000 sf</option><option value="unit"${r.mode === 'unit' ? ' selected' : ''}>per unit</option></select>
        ${r.mode === 'unit' ? `<input type="number" min="100" step="50" value="${r.unitSf || 900}" data-f="unitSf" aria-label="Average unit size" title="Average gross sf per unit">` : ''}</div>`;
    }).join('');
    if (el.dataset.html !== html && !el.contains(document.activeElement)) { el.innerHTML = html; el.dataset.html = html; }
  }
  function wirePanel() {
    $('sk-scheme').addEventListener('change', e => {
      const s = schemeById(e.target.value); if (!s) return;
      sk.model.scheme = JSON.parse(JSON.stringify(s)); for (const u of s.uses) if (!sk.model.ratios[u.key]) sk.model.ratios[u.key] = { mode: 'ksf', r: 0 };
      sk.cardVer = (sk.cardVer || 0) + 1; changed();
    });
    $('sk-swatches').addEventListener('input', e => {
      const t = e.target; if (t.type !== 'color') return;
      let cur = sk.model.scheme;
      if (cur.builtin) { cur = saveScheme(cur); sk.model.scheme = cur; }       // editing a built-in makes your own copy
      cur[t.dataset.grp][Number(t.dataset.i)].color = t.value;
      saveScheme(cur);
      changed(true);
    });
    $('sk-scheme-dup').addEventListener('click', () => {
      const name = prompt('Name for the new colour scheme:', `${scheme().name} (copy)`);
      if (!name) return;
      sk.model.scheme = duplicateScheme(scheme(), name); changed();
    });
    $('sk-scheme-ren').addEventListener('click', () => {
      const name = prompt('Rename this colour scheme:', scheme().name);
      if (!name) return;
      let cur = sk.model.scheme; if (cur.builtin) cur = saveScheme(cur);
      cur.name = name; sk.model.scheme = saveScheme(cur); changed();
    });
    $('sk-scheme-del').addEventListener('click', () => {
      if (!confirm(`Delete the colour scheme "${scheme().name}" from this browser? This project keeps its copy until you pick another.`)) return;
      deleteScheme(scheme().id); panel();
    });
    $('sk-ratios').addEventListener('change', e => {
      const row = e.target.closest('.sk-ratio'); if (!row) return;
      const r = sk.model.ratios[row.dataset.use] || (sk.model.ratios[row.dataset.use] = { mode: 'ksf', r: 0 });
      const f = e.target.dataset.f;
      if (f === 'mode') r.mode = e.target.value; else r[f] = Number(e.target.value) || 0;
      if (r.mode === 'unit' && !r.unitSf) r.unitSf = 900;
      $('sk-ratios').dataset.html = ''; changed(true);
    });
    $('sk-list').addEventListener('click', e => {
      const b = e.target.closest('.sk-item'); if (!b) return;
      sk.sel = { kind: b.dataset.kind, id: b.dataset.id }; setTool('select'); draw(); panel(); card();
    });
  }

  // ---------------------------------------------------------------- outputs for the rest of the app
  /** Massing as building-like objects (for the sun / shadow raster), roofs, step-backs and courtyards included. */
  function buildings() {
    return sk.model.masses.map(m => {
      const base = massBase(m), G = geom(m);
      return { ring: m.pts, massRing: m.pts, base, top: base + massHeight(m), roofAt: (x, y) => base + heightAt(G, x, y), sketch: true };
    });
  }
  /** Massing triangles (flat [x, y, z × 3 …], native XY, output Z), a colour and a block id per triangle, and floor
   *  lines. ex: vertical exaggeration of the 3D view (heights above each block's base are divided by it so blocks
   *  stay true-scale). */
  function tris(ex = 1) {
    const out = [], col = [], ids = [], lines = [];
    for (const m of sk.model.masses) {
      const base = massBase(m), G = geom(m), c = colorOf(scheme(), m.use);
      const Z = p => [p[0], p[1], base + p[2] / ex];
      massMesh(m, G, ctx.triangulate, (a, b, d) => { out.push(...Z(a), ...Z(b), ...Z(d)); col.push(c); ids.push(m.id); }, (a, b) => lines.push(...Z(a), ...Z(b)));
    }
    return { tris: out, colors: col, ids, lines };
  }
  /** Parking for 3D: stall lines, accessible stalls, islands (low planters) and drive aisles draped on the ground. */
  function parking3d() {
    const lines = [], acc = [], islands = [], drives = [], marks = [];
    const z = (x, y) => zGround([x, y]) + 0.15;
    const curb = 0.5 * outPerFt();
    const planter = P => {
      if (P.length < 3) return;
      const top = Math.max(...P.map(p => zGround(p))) + curb;
      for (const [i, j, k] of ctx.triangulate(P)) islands.push(...P[i], top, ...P[j], top, ...P[k], top);
      for (let i = 0; i < P.length; i++) { const a = P[i], b = P[(i + 1) % P.length], za = zGround(a) - 0.2, zb = zGround(b) - 0.2; islands.push(...a, za, ...b, zb, ...b, top, ...a, za, ...b, top, ...a, top); }
    };
    // A strip a→b, w wide, cut into short pieces so it follows the ground.
    const drape = (a, b, w, outArr) => {
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(1, Math.ceil(L / (8 * perFt())));
      const nx = -(b[1] - a[1]) / (L || 1) * w / 2, ny = (b[0] - a[0]) / (L || 1) * w / 2;
      for (let i = 0; i < n; i++) {
        const p = [a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n], q = [a[0] + (b[0] - a[0]) * (i + 1) / n, a[1] + (b[1] - a[1]) * (i + 1) / n];
        const c = [[p[0] + nx, p[1] + ny], [q[0] + nx, q[1] + ny], [q[0] - nx, q[1] - ny], [p[0] - nx, p[1] - ny]].map(r => [...r, z(...r) + 0.05]);
        outArr.push(...c[0], ...c[1], ...c[2], ...c[0], ...c[2], ...c[3]);
        if (i % 2 === 0) marks.push(...p, z(...p) + 0.12, ...q, z(...q) + 0.12);
      }
    };
    for (const l of sk.model.lots) {
      const Lr = lotLayout(l);
      const P = l.pts;
      for (let i = 0; i < P.length; i++) { const a = P[i], b = P[(i + 1) % P.length]; lines.push(a[0], a[1], z(...a), b[0], b[1], z(...b)); }
      for (const st of Lr.stalls) {
        const q = st.pts;
        if (st.acc) { for (const [i, j, k2] of [[0, 1, 2], [0, 2, 3]]) acc.push(...q[i], z(...q[i]), ...q[j], z(...q[j]), ...q[k2], z(...q[k2])); continue; }
        if (st.aisle) continue;
        for (const [i, j] of [[0, 3], [3, 2], [2, 1]]) lines.push(q[i][0], q[i][1], z(...q[i]), q[j][0], q[j][1], z(...q[j]));
      }
      for (const isl of Lr.islands || []) planter(isl);
      if (l.setback > 0 && Lr.inner?.length > 2) for (let i = 0; i < Lr.inner.length; i++) { const a = Lr.inner[i], b = Lr.inner[(i + 1) % Lr.inner.length]; lines.push(a[0], a[1], z(...a), b[0], b[1], z(...b)); }
    }
    for (const isl of sk.model.islands) planter(isl.pts);
    for (const d of sk.model.drives) for (let i = 0; i < d.pts.length - 1; i++) drape(d.pts[i], d.pts[i + 1], (d.w || 24) * perFt(), drives);
    return { lines, acc, islands, drives, marks, stripe: colorOf(scheme(), 'stripe'), accColor: colorOf(scheme(), 'accessible'), lotColor: colorOf(scheme(), 'lot'), greenColor: colorOf(scheme(), 'green') };
  }

  return {
    get version() { return sk.ver; },
    get model() { return sk.model; },
    onSite,
    setActive(on) {
      sk.active = on; canvas.hidden = !visible(); bar.hidden = !on;
      if (!on) { sk.draw = null; cardEl.hidden = true; map.getContainer().classList.remove('sk-drawing'); sk.v3?.el.classList.remove('sk-drawing'); sk.v3?.sketchNav(false); }
      else setTool(sk.tool);
      draw(); card(); panel();
    },
    attach3d,
    redraw() { draw(); card(); },
    buildings, tris, parking3d, stats, wirePanel, panel,
    hasContent: () => sk.model.masses.length + sk.model.lots.length + sk.model.islands.length + sk.model.drives.length > 0,
    refreshVisibility() { canvas.hidden = !visible(); draw(); },
    _sk: sk,
  };
}
