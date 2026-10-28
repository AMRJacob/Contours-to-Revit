// Sketch tab: a light brainstorming and massing tool on the real site — solids you can push and pull like SketchUp,
// quick massing shapes, parking lots with planter islands and drive aisles. Everything updates live: floor area,
// parking provided vs required, accessible spaces, and the 3D / sun views. Works on the map and in the 3D view.
// Colours come from an editable scheme that travels with the project.
//
// Hotkeys: V select · M massing shapes (1–5) · L draw (ground or any face) · U push/pull · S slope · P parking ·
// I island · D drive aisle · Esc cancel / select · Del delete · Ctrl+Z / Ctrl+Y undo / redo · ↑ ↓ floors or slide
// rows · R roof form (shape presets) · [ ] turn parking rows · Enter / double-click finish · Alt+drag duplicate ·
// Alt+click a corner removes it · Ctrl+drag (Select tool) moves a point, edge or face; add Shift to move it up/down ·
// Shift: square corners, snap rotation, free (unsnapped) push/pull.
import { layoutLot, longestEdgeAngle, lanePoly, roundPoly, driveJoins } from './parking.js?v=0.50.1';
import { snap as snapTo, snapMove, frameAngles } from './snap.js?v=0.50.1';
import { BUILTIN_SCHEMES, allSchemes, schemeById, saveScheme, deleteScheme, duplicateScheme, colorOf } from './schemes.js?v=0.50.1';
import { presetShape, area, inPoly, ROOFS } from './sketchmass.js?v=0.50.1';
import * as SO from './solid.js?v=0.50.1';
import { noteGeom, WIDTHS } from './notes.js?v=0.50.1';
import { booleanSolids } from './bool.js?v=0.50.1';

const TOOLS = [
  { id: 'select', key: 'V', label: 'Select', icon: '<path d="M5 3l14 8-6 1.5L10 19z"/>' },
  { id: 'mass', key: 'M', group: 'Building', label: 'Shapes', icon: '<path d="M4 9l8-4 8 4v9l-8 4-8-4z"/><path d="M4 9l8 4 8-4M12 13v9" opacity=".6"/>' },
  { id: 'pen', key: 'L', label: 'Draw', icon: '<path d="M4 20l4-1L19 8l-3-3L5 16z"/><path d="M14 7l3 3" opacity=".6"/>' },
  { id: 'push', key: 'U', label: 'Push/Pull', icon: '<path d="M5 14h14v6H5z"/><path d="M12 12V3M8.5 6.5L12 3l3.5 3.5"/>' },
  { id: 'slope', key: 'S', label: 'Slope', icon: '<path d="M3 19L21 9v10z"/><path d="M6 15l9-5M12 9.5l3 .5-1 3" opacity=".8"/>' },
  { id: 'lot', key: 'P', group: 'Parking', label: 'Lot', icon: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v6M11 4v6M15 4v6M7 20v-6M11 20v-6M15 20v-6" opacity=".7"/>' },
  { id: 'island', key: 'I', label: 'Island', icon: '<rect x="3" y="8" width="18" height="8" rx="4"/><path d="M9 12h6" opacity=".7"/>' },
  { id: 'drive', key: 'D', label: 'Drive aisle', icon: '<path d="M5 21L10 3M19 21L14 3"/><path d="M12 5v3M12 11v3M12 17v3" opacity=".7"/>' },
];
// Diagram tab tools (same model; annotations instead of modelling).
const DTOOLS = [
  { id: 'select', key: 'V', label: 'Select', icon: '<path d="M5 3l14 8-6 1.5L10 19z"/>' },
  { id: 'arrow', key: 'A', label: 'Arrow', icon: '<path d="M4 18C8 8 13 7 18 7"/><path d="M14 4l5 3-4 4"/>' },
  { id: 'line', key: 'L', label: 'Line', icon: '<path d="M4 19L20 5"/>' },
  { id: 'region', key: 'R', label: 'Region', icon: '<path d="M5 7l9-3 6 7-4 9-10-3z" fill="currentColor" fill-opacity=".3"/>' },
  { id: 'label', key: 'T', label: 'Label', icon: '<path d="M5 6h14M12 6v13"/>' },
  { id: 'paint', key: 'B', label: 'Paint', icon: '<path d="M5 11l6-6 7 7-6 6z"/><path d="M5 11h13" opacity=".6"/><path d="M19.5 15.5c1 1.4 1.5 2.4 1.5 3a1.5 1.5 0 01-3 0c0-.6.5-1.6 1.5-3z" fill="currentColor"/><path d="M9 7L6.5 4.5"/>' },
];
const DHINTS = {
  select: 'Click an annotation to style it · drag to move · drag its points · F stands it up / lays it down.',
  arrow: 'Drag a straight arrow, or click points (it curves through them) and double-click to finish — on the ground or on any building face.',
  line: 'Drag a straight line, or click points and double-click — on the ground or a face. Stand it up (F) for a fence or screen.',
  region: 'Drag a rectangle or click an outline — on the ground or a face. Stand it up (F) for a volume.',
  label: 'Click where the label goes, then type its text in the card.',
  paint: 'Click a building, tree, block, parking area or annotation to paint it the chosen colour · Alt+click picks up a colour · Shift+click puts it back to the default.',
};
// Diagram colours for whole categories (quick selectors in the Diagram panel); 'use' = colour blocks by their use.
const DG0 = { bldg: '#f1f0ec', tree: '#cfe0c8', mass: 'use' };
const DG_PRESETS = {
  bldg: ['#ffffff', '#f1f0ec', '#d9d4ca', '#a8a29e', '#57534e', '#1f2937'],
  tree: ['#e3ece0', '#cfe0c8', '#a9c29a', '#6f9e66', '#3f6e47', '#ffffff'],
  mass: ['use', '#ffffff', '#f1f0ec', '#e8913f', '#cbd5e1', '#374151'],
};
const DG_ROWS = [['bldg', 'Existing buildings'], ['tree', 'Trees'], ['mass', 'New blocks']];
const SIZES = ['S', 'M', 'L'];
const SHAPES = [
  { id: 'box', key: '1', label: 'Box or outline', icon: '<rect x="5" y="6" width="14" height="12"/>' },
  { id: 'circle', key: '2', label: 'Round (drag from the centre)', icon: '<circle cx="12" cy="12" r="7.5"/>' },
  { id: 'L', key: '3', label: 'L-shape', icon: '<path d="M5 4h6v10h8v6H5z"/>' },
  { id: 'U', key: '4', label: 'U-shape', icon: '<path d="M4 5h5v9h6V5h5v15H4z"/>' },
  { id: 'court', key: '5', label: 'Courtyard', icon: '<rect x="4" y="4" width="16" height="16"/><rect x="9" y="9" width="6" height="6"/>' },
];
const HINTS = {
  select: 'Click to edit · drag to move · ⟳ rotate, ⤡ scale · Ctrl+drag a point, edge or face to move it (add Shift to move it up or down) · Alt+drag duplicates.',
  mass: 'Drag a quick block (1–5: box, round, L, U, courtyard), or click corners and double-click. ↑ ↓ floors · R roof.',
  pen: 'On the ground: drag a rectangle or click an outline — it becomes a flat shape to pull up. On a face: drag a rectangle inside it, or click from edge to edge to split it.',
  push: 'Drag a face in or out. Tops snap to whole floors (Shift = free). Ctrl = always make new sides. Type an exact distance in the box.',
  slope: 'Drag across a face toward its high side to tilt it at the pitch in the box (walls lean out). The back edge stays put.',
  lot: 'Drag a rectangle, or click corners and double-click to finish. [ ] turn the rows, ↑ ↓ slide them.',
  island: 'Drag or click out a planter island — it snaps to stall lines, aisles and the lot edge; the stalls under it go away.',
  drive: 'Drag a straight drive aisle, or click points and double-click. It snaps to aisle centres and lot edges; stalls it crosses are cleared; an end off the paving gets a curb cut.',
};
const DEFAULT_RATIOS = {   // examples only — every jurisdiction sets its own
  residential: { mode: 'unit', r: 1.5, unitSf: 900 }, office: { mode: 'ksf', r: 3 }, retail: { mode: 'ksf', r: 4 },
  civic: { mode: 'ksf', r: 2.5 }, hospitality: { mode: 'unit', r: 1, unitSf: 450 }, mixed: { mode: 'ksf', r: 3 },
  industrial: { mode: 'ksf', r: 1 }, parking: { mode: 'ksf', r: 0 },
};
const LISTS = { mass: 'masses', lot: 'lots', island: 'islands', drive: 'drives', note: 'notes' };
const svg = i => `<svg viewBox="0 0 24 24">${i}</svg>`;
const ORANGE = '#e8913f';

export function createSketch(ctx) {
  const { map, $, escapeHtml } = ctx;
  const sk = {
    model: blank(), tool: 'select', shape: 'box', sel: null, drag: null, draw: null, op: null, hov: null, undo: [], redo: [], ver: 0,
    site: null, key: null, layouts: new Map(), infos: new Map(), ngeo: new Map(), active: false, v3: null, pitch: 6,
    set: 'sketch', style: { color: 'arrow', size: 1, stand: false, curve: true }, showLabels: false,
  };
  function blank() {
    return { v: 3, masses: [], lots: [], islands: [], drives: [], notes: [], dg: { ...DG0 }, paint: {}, scheme: JSON.parse(JSON.stringify(BUILTIN_SCHEMES[0])), ratios: JSON.parse(JSON.stringify(DEFAULT_RATIOS)) };
  }
  const scheme = () => sk.model.scheme;
  const uid = () => Math.random().toString(36).slice(2, 9);
  const perFt = () => (sk.site ? ctx.unitsPerFt(sk.site) : 1);           // native units per foot
  const sfPerNative2 = () => 1 / perFt() ** 2;
  const metric = () => sk.site?.outUnit === 'm';
  const outPerFt = () => (metric() ? 0.3048 : 1);
  const kz = () => perFt() / outPerFt();                                   // native units per output unit
  const uLen = () => (metric() ? 'm' : 'ft');
  const fmtLen = n => `${(n / kz()).toFixed(Math.abs(n / kz()) < 10 ? 1 : 0)} ${uLen()}`;   // native length → text
  const fmtArea = sf => (metric() ? `${Math.round(sf * 0.092903).toLocaleString()} m²` : `${Math.round(sf).toLocaleString()} sf`);
  const centroid = P => { let x = 0, y = 0; for (const p of P) { x += p[0]; y += p[1]; } return [x / P.length, y / P.length]; };
  const bbox = P => { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const [x, y] of P) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } return [x0, y0, x1, y1]; };
  const overlap = (a, b) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
  const list = kind => sk.model[LISTS[kind]];
  const ex3 = () => (sk.v3 ? ctx.ex3d?.() || 1 : 1);
  const zGround = p => { const z = ctx.zAt(p[0], p[1]); return Number.isFinite(z) ? z : 0; };
  const closed = kind => kind !== 'drive';
  const massById = id => sk.model.masses.find(m => m.id === id);

  // ---------------------------------------------------------------- solids
  const ftfN = m => m.ftf * kz();
  /** Rebuild a preset block's solid from its parameters. */
  function regen(m) { if (!m.prm) return; const S = SO.fromParams(m.prm, perFt(), ftfN(m)); m.v = S.v; m.f = S.f; }
  /** Hand edits turn a preset block into a free solid (its roof / courtyard / step settings are baked in). */
  const freeze = m => { delete m.prm; };
  /** Everything derived from a solid (cached): triangles, floor plates, area, top surface, outline, base elevation. */
  function info(m) {
    const key = JSON.stringify([m.v, m.f, m.ftf, kz()]);
    const c = sk.infos.get(m.id);
    if (c && c.key === key && !(sk.baseLock?.id === m.id)) return c.I;
    const tris = SO.solidTris(m), P0 = SO.plates(m, ftfN(m), tris);
    // A preset block has the floors it was given; its roof (an attic) isn't counted as more.
    const P = m.prm ? P0.slice(0, m.prm.floors) : P0;
    const xy = m.v.map(p => [p[0], p[1]]), foot = m.v.filter(p => p[2] < 1e-6).map(p => [p[0], p[1]]);
    const F = foot.length >= 3 ? foot : xy;
    let base;
    if (sk.baseLock?.id === m.id) base = sk.baseLock.base;
    else { let lo = Infinity; for (const p of [...F, centroid(F)]) { const z = ctx.zAt(...p); if (Number.isFinite(z) && z < lo) lo = z; } base = Number.isFinite(lo) ? lo : 0; }
    const I = { tris, P, floors: P.length, gfa: P.reduce((a, p) => a + p.area, 0), zmax: SO.zMax(m), top: SO.topAt(m, tris), edges: SO.edgesOf(m),
      c: centroid(xy), bb: bbox(xy), base, sheet: SO.isSheet(m), foot: F };
    sk.infos.set(m.id, { key, I });
    return I;
  }
  const massGfa = m => info(m).gfa * sfPerNative2();
  const massBase = m => info(m).base;
  const massTop = m => massBase(m) + info(m).zmax / kz();
  /** Output elevation (as drawn in the current view) of a solid-space point. */
  const zOut = (m, z) => massBase(m) + z / kz() / ex3() + (info(m).sheet ? 0.15 : 0);
  const P3 = (m, p) => scr([p[0], p[1]], zOut(m, p[2]));
  const outline = o => o.pts || o.prm?.pts || info(o).foot;

  // ---------------------------------------------------------------- lots
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
  /** Curb returns and curb cuts of the drive aisles (cached per sketch version). */
  function joins() {
    if (sk.joins?.ver === sk.ver) return sk.joins.J;
    const J = driveJoins(sk.model.drives.map(d => ({ pts: d.pts, w: (d.w || 24) * perFt(), r: (d.r ?? 15) * perFt(), cut: d.cut !== false })), sk.model.lots.map(l => l.pts));
    sk.joins = { ver: sk.ver, J };
    return J;
  }
  const islandShape = (P, r) => roundPoly(P, (r ?? 3) * perFt());
  function nearestMass(l) {
    const c = centroid(l.pts);
    let best = null, bd = Infinity;
    for (const m of sk.model.masses) { if (info(m).sheet) continue; const mc = info(m).c, d = Math.hypot(mc[0] - c[0], mc[1] - c[1]); if (d < bd) { bd = d; best = mc; } }
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
  const SAVED = ['masses', 'lots', 'islands', 'drives', 'notes'];
  const SAVEDO = ['dg', 'paint'];                    // diagram colours: undoable too
  function snapshot() { return JSON.stringify(Object.fromEntries([...SAVED, ...SAVEDO].map(k => [k, sk.model[k]]))); }
  function before() { sk.undo.push(snapshot()); if (sk.undo.length > 80) sk.undo.shift(); sk.redo.length = 0; }
  function restore(s) { const o = JSON.parse(s); for (const k of SAVED) sk.model[k] = o[k] || []; sk.model.dg = o.dg || { ...DG0 }; sk.model.paint = o.paint || {}; if (sk.sel && !findSel()) sk.sel = null; changed(); }
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
  function dragged() { sk.ver++; draw(); panel(); live(); clearTimeout(sk.softT); sk.softT = setTimeout(() => ctx.onChange?.(), 160); }
  async function save() { if (sk.key) await ctx.idb.set(sk.key, sk.model).catch(() => {}); }
  const findSel = () => (sk.sel ? list(sk.sel.kind)?.find(o => o.id === sk.sel.id) : null);

  // ---------------------------------------------------------------- site
  /** Older saves: blocks were outlines with floors → preset solids. */
  function migrate(m) {
    for (const k of SAVED) if (!m[k]) m[k] = [];
    for (const b of m.masses) {
      if (b.v) continue;
      b.prm = { pts: b.pts, floors: b.floors || 3, court: b.court || 0, step: b.step || null, roof: b.roof || null };
      for (const k of ['pts', 'floors', 'court', 'step', 'roof']) delete b[k];
      regen(b);
    }
    m.v = 3;
  }
  async function onSite(site, pending) {
    sk.site = site; sk.sel = null; sk.draw = null; sk.op = null; bar.hidden = !sk.active || !site; sk.layouts.clear(); sk.infos.clear(); sk.undo = []; sk.redo = [];
    if (!site) { sk.key = null; sk.model = blank(); draw(); panel(); return; }
    const b = site.box;
    sk.key = `sketch:${site.zone.code}:${[b.xmin, b.ymin, b.xmax, b.ymax].map(v => Math.round(v / 10)).join(',')}`;
    let m = pending || await ctx.idb.get(sk.key).catch(() => null);
    if (!m || !m.masses) m = blank();
    if (!m.scheme) m.scheme = JSON.parse(JSON.stringify(BUILTIN_SCHEMES[0]));
    if (!m.ratios) m.ratios = JSON.parse(JSON.stringify(DEFAULT_RATIOS));
    m.dg = { ...DG0, ...m.dg }; if (!m.paint) m.paint = {};
    migrate(m);
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
  /** Elevation at which a selection's handles sit. */
  function handleZ(kind, o) {
    if (!sk.v3) return () => 0;
    if (kind === 'mass') {
      const st = o.prm?.step, h = o.prm ? (st?.at > 0 ? st.at : o.prm.floors) * o.ftf : 0, z = massBase(o) + h / ex3() + 0.2;
      return () => z;
    }
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
    if (diagramOn()) { drawNotes(g); drawNoteSel(g); drawNoteDraft(g); drawSnap(g); return; }
    drawSelection(g);
    drawHover(g);
    drawInProgress(g);
    drawOp(g);
    drawSnap(g);
  }
  /** Screen path of a ring (null if any corner is behind the camera). */
  function sPath(g, P, zf, close = true, begin = true) {
    const Q = P.map(p => scr(p, zf ? zf(p) : undefined));
    if (Q.some(q => !q)) return false;
    if (begin) g.beginPath();
    Q.forEach((q, i) => (i ? g.lineTo(q[0], q[1]) : g.moveTo(q[0], q[1])));
    if (close) g.closePath();
    return true;
  }
  /** Screen path of a solid's face (outline + holes). */
  function facePath(g, m, fi) {
    g.beginPath();
    for (const L of SO.faceLoops(m, fi)) {
      const Q = L.map(i => P3(m, m.v[i]));
      if (Q.some(q => !q)) return false;
      Q.forEach((q, i) => (i ? g.lineTo(q[0], q[1]) : g.moveTo(q[0], q[1]))); g.closePath();
    }
    return true;
  }
  function drawPlan(g) {
    const M = ctx.affine(sk.site), px = M.scale;                 // screen px per native unit
    const path = (P, close = true) => sPath(g, P, null, close);
    const green = colorOf(scheme(), 'green');
    for (const l of sk.model.lots) {
      const L = lotLayout(l), sel = sk.sel?.id === l.id;
      const lc = siteColor(`l:${l.id}`, 'lot');
      path(l.pts); g.fillStyle = lc; g.globalAlpha = 0.75; g.fill(); g.globalAlpha = 1;
      if (l.setback > 0 && L.inner?.length > 2) { path(l.pts); g.save(); g.clip(); g.fillStyle = green; g.globalAlpha = 0.55; g.fill(); g.restore(); path(L.inner); g.fillStyle = lc; g.globalAlpha = 0.9; g.fill(); g.globalAlpha = 1; }
      for (const dp of L.drives || []) { path(dp); g.fillStyle = lc; g.fill(); }
      if (px * 9 * perFt() > 2.2) {   // stalls only when they're big enough to see
        g.lineWidth = 1; g.strokeStyle = colorOf(scheme(), 'stripe');
        for (const st of L.stalls) {
          if (st.acc) { path(st.pts); g.fillStyle = colorOf(scheme(), 'accessible'); g.fill(); g.strokeStyle = colorOf(scheme(), 'stripe'); g.stroke(); continue; }
          if (st.aisle) { path(st.pts); g.save(); g.clip(); g.strokeStyle = colorOf(scheme(), 'accessible'); g.lineWidth = 1; const [a] = st.pts.map(p => toS(M, p)); for (let d = -60; d < 60; d += 5) { g.beginPath(); g.moveTo(a[0] + d, a[1] - 40); g.lineTo(a[0] + d + 40, a[1] + 40); g.stroke(); } g.restore(); continue; }
          const q = st.pts.map(p => toS(M, p));        // two side lines and the back line, like striping
          g.beginPath(); g.moveTo(...q[0]); g.lineTo(...q[3]); g.lineTo(...q[2]); g.lineTo(...q[1]); g.stroke();
        }
      }
      for (const isl of L.islands || []) { path(islandShape(isl, l.islandR)); g.fillStyle = green; g.fill(); g.strokeStyle = 'rgba(20,83,45,0.6)'; g.lineWidth = 1; g.stroke(); }
      path(l.pts); g.lineWidth = sel ? 2.5 : 1.5; g.strokeStyle = sel ? ORANGE : 'rgba(30,41,59,0.85)'; g.stroke();
    }
    const J = joins();
    for (const d of sk.model.drives) {
      const w = (d.w || 24) * perFt();
      for (let i = 0; i < d.pts.length - 1; i++) { path(lanePoly(d.pts[i], d.pts[i + 1], w)); g.fillStyle = siteColor(`d:${d.id}`, 'lot'); g.globalAlpha = 0.9; g.fill(); g.globalAlpha = 1; }
    }
    for (const W of J.wedges) { path(W); g.fillStyle = colorOf(scheme(), 'lot'); g.globalAlpha = 0.9; g.fill(); g.globalAlpha = 1; }
    for (const d of sk.model.drives) { path(d.pts, false); g.setLineDash([8, 6]); g.strokeStyle = '#fde047'; g.lineWidth = 1.5; g.stroke(); g.setLineDash([]); }
    for (const [a, b] of J.cuts) { path([a, b], false); g.strokeStyle = '#ffffff'; g.lineWidth = 3; g.setLineDash([4, 3]); g.stroke(); g.setLineDash([]); }
    for (const isl of sk.model.islands) { path(islandShape(isl.pts, isl.r)); g.fillStyle = siteColor(`i:${isl.id}`, 'green'); g.fill(); g.strokeStyle = sk.sel?.id === isl.id ? ORANGE : 'rgba(20,83,45,0.8)'; g.lineWidth = sk.sel?.id === isl.id ? 2.5 : 1.2; g.stroke(); }
    for (const l of sk.model.lots) {
      if (!showTags()) break;
      const L = lotLayout(l);
      label(g, scr(centroid(l.pts)), `${L.total} spaces`, L.acc ? `${L.acc} accessible${L.van ? ` (${L.van} van)` : ''}${L.short ? ` · ${L.short} short` : ''}` : '');
    }
    // Solids from above: their upward faces, lowest first, shaded a little by slope; roof and step lines show.
    const ms = sk.model.masses.slice().sort((a, b) => massTop(a) - massTop(b));
    for (const m of ms) {
      const I = info(m), sel = sk.sel?.id === m.id, col = massColor(m);
      const up = m.f.map((_, fi) => ({ fi, n: SO.faceNormal(m, fi), z: SO.faceVerts(m, fi).reduce((a, i) => a + m.v[i][2], 0) / SO.faceVerts(m, fi).length }))
        .filter(o => o.n[2] > 0.05).sort((a, b) => a.z - b.z);
      for (const o of up) {
        if (!facePath(g, m, o.fi)) continue;
        g.fillStyle = col; g.globalAlpha = I.sheet ? 0.5 : 0.9; g.fill('evenodd');
        if (o.n[2] < 0.97) { g.fillStyle = o.n[1] > 0 || o.n[0] < 0 ? '#ffffff' : '#000000'; g.globalAlpha = 0.12; g.fill('evenodd'); }
        g.globalAlpha = 1; g.lineWidth = 1; g.strokeStyle = 'rgba(17,24,39,0.5)'; g.stroke();
      }
      const F = I.foot;
      if (F.length >= 3) {
        const P = m.prm?.pts || null;
        if (P) { path(P); g.lineWidth = sel ? 2.5 : 1.25; g.strokeStyle = sel ? ORANGE : 'rgba(17,24,39,0.85)'; if (I.sheet) g.setLineDash([6, 4]); g.stroke(); g.setLineDash([]); }
        else if (sel) for (const [a, b] of I.edges) if (m.v[a][2] < 1e-6 && m.v[b][2] < 1e-6) { g.beginPath(); g.moveTo(...scr(m.v[a])); g.lineTo(...scr(m.v[b])); g.lineWidth = 2.5; g.strokeStyle = ORANGE; g.stroke(); }
      }
    }
    if (showTags()) for (const m of ms) label(g, scr(labelPt(m)), massTitle(m), massSub(m));
  }
  const showTags = () => !diagramOn() || sk.showLabels;
  const useLabel = m => scheme().uses.find(x => x.key === m.use)?.label || m.use;
  const massTitle = m => (info(m).sheet ? `${useLabel(m)} · flat shape` : `${useLabel(m)} · ${info(m).floors} fl`);
  const massSub = m => (info(m).sheet ? 'pull it up (U)' : fmtArea(massGfa(m)));
  /** A label spot on top of the block (not over a courtyard). */
  function labelPt(m) {
    const I = info(m);
    if (I.top(...I.c)) return I.c;
    let best = null, ba = -1;
    m.f.forEach((f, fi) => { if (SO.faceNormal(m, fi)[2] <= 0.05) return; const P = f.o.map(i => m.v[i]); const a = Math.abs(area(P)); if (a > ba) { ba = a; best = centroid(P); } });
    return best || I.c;
  }
  function drawLabels3d(g) {
    if (!showTags()) return;
    for (const l of sk.model.lots) {
      const L = lotLayout(l), c = centroid(l.pts);
      label(g, scr(c, zGround(c) + 1), `${L.total} spaces`, L.acc ? `${L.acc} accessible${L.van ? ` (${L.van} van)` : ''}` : '');
    }
    for (const m of sk.model.masses) {
      const c = labelPt(m), I = info(m), t = I.top(...c);
      label(g, scr(c, zOut(m, (t ? t.z : I.zmax)) + 3 / ex3()), massTitle(m), massSub(m));
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
  function tag(g, q, text) {
    if (!q) return;
    g.font = '600 12px system-ui, sans-serif'; g.textAlign = 'left'; g.textBaseline = 'middle';
    const w = g.measureText(text).width + 10;
    g.fillStyle = 'rgba(28,34,38,0.92)'; g.beginPath(); g.roundRect(q[0] + 12, q[1] - 22, w, 20, 4); g.fill();
    g.fillStyle = '#fde7cf'; g.fillText(text, q[0] + 17, q[1] - 12);
  }

  // ---------------------------------------------------------------- selection handles
  /** Handles of the selection: corners (v), edge midpoints (m), rotate (r), scale (s). Free solids: rotate and scale. */
  function handles(kind, o) {
    const zf = handleZ(kind, o), out = [];
    const editable = kind !== 'mass' || o.prm;
    const P = outline(o), n = P.length, cl = closed(kind);
    if (editable) {
      P.forEach((p, i) => out.push({ t: 'v', i, p, z: zf(p) }));
      if (n <= 16) for (let i = 0; i < (cl ? n : n - 1); i++) { const a = P[i], b = P[(i + 1) % n], p = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; out.push({ t: 'm', i, p, z: zf(p) }); }
    }
    if (cl) {
      const c = centroid(P), bb = bbox(P), r = Math.max(...P.map(p => Math.hypot(p[0] - c[0], p[1] - c[1])));
      const rp = [c[0], c[1] + r * 1.18 + 6 * perFt()], sp = [bb[2] + 8 * perFt(), bb[1] - 8 * perFt()];   // scale sits off the corner
      out.push({ t: 'r', p: rp, z: zf(rp), c }, { t: 's', p: sp, z: zf(sp), c });
    }
    return out;
  }
  function drawSelection(g) {
    const o = findSel(); if (!o || sk.sel.kind === 'note') return;
    const o2 = sk.sel2 && sk.sel.kind === 'mass' ? massById(sk.sel2.id) : null;
    if (o2) {                                  // the second block for join / intersect / cut
      g.save(); g.setLineDash([6, 4]); g.lineWidth = 2.5; g.strokeStyle = '#22d3ee';
      for (const [a, b] of info(o2).edges) { const p = P3(o2, o2.v[a]), q = P3(o2, o2.v[b]); if (!p || !q) continue; g.beginPath(); g.moveTo(...p); g.lineTo(...q); g.stroke(); }
      g.restore();
    }
    const kind = sk.sel.kind, zf = handleZ(kind, o);
    if (sk.v3) {
      if (kind === 'mass') { g.lineWidth = 2; g.strokeStyle = ORANGE; for (const [a, b] of info(o).edges) { const p = P3(o, o.v[a]), q = P3(o, o.v[b]); if (!p || !q) continue; g.beginPath(); g.moveTo(...p); g.lineTo(...q); g.stroke(); } }
      else if (sPath(g, o.pts, zf, closed(kind))) { g.lineWidth = 2.5; g.strokeStyle = ORANGE; g.stroke(); }
    }
    for (const h of handles(kind, o)) {
      const q = scr(h.p, h.z); if (!q) continue;
      const [x, y] = q;
      g.beginPath();
      if (h.t === 'v') { g.rect(x - 4, y - 4, 8, 8); g.fillStyle = '#fff'; g.fill(); g.strokeStyle = ORANGE; g.lineWidth = 1.5; g.stroke(); }
      else if (h.t === 'm') { g.arc(x, y, 3.2, 0, Math.PI * 2); g.fillStyle = 'rgba(232,145,63,0.85)'; g.fill(); }
      else {
        const cq = scr(h.c, h.z);
        if (h.t === 'r' && cq) { g.save(); g.setLineDash([3, 3]); g.strokeStyle = 'rgba(232,145,63,0.8)'; g.lineWidth = 1; g.beginPath(); g.moveTo(...cq); g.lineTo(x, y); g.stroke(); g.restore(); g.beginPath(); }
        g.arc(x, y, 8, 0, Math.PI * 2); g.fillStyle = '#1c2226'; g.fill(); g.strokeStyle = ORANGE; g.lineWidth = 1.5; g.stroke();
        g.fillStyle = ORANGE; g.font = '700 11px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(h.t === 'r' ? '⟳' : '⤡', x, y + 0.5);
      }
    }
  }
  /** Highlight of the face / edge / point under the cursor for the face tools and Ctrl-move. */
  function drawHover(g) {
    const h = sk.hov; if (!h || sk.op) return;
    const m = massById(h.id); if (!m) return;
    g.save();
    if (h.t === 'f') { if (facePath(g, m, h.fi)) { g.fillStyle = 'rgba(232,145,63,0.28)'; g.fill('evenodd'); g.strokeStyle = ORANGE; g.lineWidth = 2; g.stroke(); } }
    else if (h.t === 'e') { const p = P3(m, m.v[h.a]), q = P3(m, m.v[h.b]); if (p && q) { g.beginPath(); g.moveTo(...p); g.lineTo(...q); g.strokeStyle = ORANGE; g.lineWidth = 4; g.stroke(); } }
    else if (h.t === 'v') { const p = P3(m, m.v[h.i]); if (p) { g.beginPath(); g.arc(p[0], p[1], 6, 0, Math.PI * 2); g.fillStyle = ORANGE; g.fill(); g.strokeStyle = '#fff'; g.lineWidth = 1.5; g.stroke(); } }
    g.restore();
  }
  function drawInProgress(g) {
    const d = sk.draw; if (!d) return;
    if (d.face) return drawPenFace(g, d);
    const P = drawPts();
    if (P.length > 1) {
      const cl = d.kind !== 'drive' && (d.rect || P.length > 2);
      const zf = sk.v3 ? (p => zGround(p) + 0.3) : null;
      if (sPath(g, P, zf, cl)) {
        if (cl) { g.fillStyle = d.kind === 'mass' || d.kind === 'sheet' ? colorOf(scheme(), sk.last?.use || scheme().uses[0].key) : d.kind === 'island' ? colorOf(scheme(), 'green') : colorOf(scheme(), 'lot'); g.globalAlpha = 0.45; g.fill(); g.globalAlpha = 1; }
        g.setLineDash([6, 4]); g.strokeStyle = ORANGE; g.lineWidth = d.kind === 'drive' ? 3 : 2; g.stroke(); g.setLineDash([]);
      }
      if (cl) {
        const ar = area(P) * sfPerNative2(), c = centroid(P);
        if (ar > 1) label(g, scr(c, zf ? zf(c) : undefined), fmtArea(ar), d.kind === 'mass' ? `${sk.last?.floors || 3} floors → ${fmtArea(ar * (sk.last?.floors || 3))}` : d.kind === 'sheet' ? 'then pull it up (U)' : '');
      } else {
        let L = 0; for (let i = 1; i < P.length; i++) L += Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]);
        const c = P[P.length - 1];
        label(g, scr(c, zf ? zf(c) : undefined), fmtLen(L), '');
      }
    }
    for (const p of d.pts || []) { const q = scr(p, sk.v3 ? zGround(p) + 0.3 : undefined); if (!q) continue; g.beginPath(); g.arc(q[0], q[1], 3.5, 0, Math.PI * 2); g.fillStyle = ORANGE; g.fill(); }
  }
  const rectPts = (a, b) => [[a[0], a[1]], [b[0], a[1]], [b[0], b[1]], [a[0], b[1]]];
  function drawPts() {
    const d = sk.draw;
    if (d.rect) {
      if (d.kind === 'drive') return [d.a, d.b];
      const F = rectFrame(d.a, d.b, d.frame || 0, d.square && d.shape !== 'circle');
      if (d.kind === 'mass' && d.shape !== 'box' && d.shape !== 'court') {
        // Preset drawn in the frame's own coordinates, then turned to match it.
        const loc = d.shape === 'circle' ? presetShape('circle', [0, 0], [Math.hypot(d.b[0] - d.a[0], d.b[1] - d.a[1]), 0]) : presetShape(d.shape, [0, 0], [F.du, F.dv]);
        return loc.map(([x, y]) => F.P(x, y));
      }
      return F.pts;
    }
    return [...(d.pts || []), ...(d.hover ? [d.hover] : [])];
  }

  // ---------------------------------------------------------------- toolbar
  const bar = document.createElement('div');
  bar.className = 'sketch-bar'; bar.hidden = true;
  const tools = () => (sk.set === 'diagram' ? DTOOLS : TOOLS);
  const hints = () => (sk.set === 'diagram' ? DHINTS : HINTS);
  const hintEl = () => $(sk.set === 'diagram' ? 'dg-hint' : 'sk-hint');
  const swatchKeys = () => [...scheme().site.filter(u => !['lot', 'stripe', 'accessible'].includes(u.key)), ...scheme().uses];
  const swatchHtml = cur => swatchKeys().map(u => `<button type="button" class="dg-sw${cur === u.key ? ' on' : ''}" data-col="${u.key}" title="${escapeHtml(u.label)}" style="background:${u.color}"></button>`).join('')
    + `<label class="dg-sw dg-custom${cur?.startsWith?.('#') ? ' on' : ''}" title="Any colour"><input type="color" data-col="custom" value="${cur?.startsWith?.('#') ? cur : '#e8913f'}"></label>`;
  function buildBar() {
    const T = tools();
    bar.dataset.set = sk.set;
    // Tools in groups (Building / Parking), each with its hotkey. Undo / redo are Ctrl+Z / Ctrl+Y.
    bar.innerHTML = T.map(t => `${t.group ? `<div class="sk-grp">${t.group}</div>` : ''}<button type="button" class="sk-tool" data-tool="${t.id}" data-tip="${sk.set === 'diagram' ? 'dg' : 'sk'}-${t.id}" aria-label="${t.label} (${t.key})">${svg(t.icon)}<kbd>${t.key}</kbd><span>${t.label}</span></button>`).join('')
      + (sk.set === 'diagram'
        ? `<div class="sk-fly dg-style" data-for="style" hidden><div class="dg-sws">${swatchHtml(sk.style.color)}</div>
            <div class="dg-row"><span class="seg seg-dark">${SIZES.map((z, i) => `<label><input type="radio" name="dg-size" value="${i}"${sk.style.size === i ? ' checked' : ''}><span>${z}</span></label>`).join('')}</span>
            <label class="skc-chk" title="Stand it up from the surface (F)"><input type="checkbox" data-st="stand"${sk.style.stand ? ' checked' : ''}> Upright</label>
            <label class="skc-chk" title="Curve arrows and lines through their points"><input type="checkbox" data-st="curve"${sk.style.curve ? ' checked' : ''}> Curved</label></div></div>`
        : `<div class="sk-fly" data-for="mass" hidden>${SHAPES.map(sh => `<button type="button" class="sk-tool sk-mini" data-shape="${sh.id}" title="${sh.label} (${sh.key})" aria-label="${sh.label}">${svg(sh.icon)}<kbd>${sh.key}</kbd></button>`).join('')}</div>`
          + '<div class="sk-fly sk-num" data-for="push" hidden><span>Distance</span><input type="number" step="0.5" data-fly="dist" title="Type an exact distance for the last push/pull"><span class="sk-u"></span></div>'
          + `<div class="sk-fly sk-num" data-for="slope" hidden><span>Pitch</span><input type="number" step="0.5" min="0" max="48" value="${sk.pitch}" data-fly="pitch" title="Rise per 12 of run"><span>: 12</span></div>`);
  }
  buildBar();
  map.getContainer().appendChild(bar);
  L.DomEvent.disableClickPropagation(bar); L.DomEvent.disableScrollPropagation(bar);
  bar.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.tool) setTool(b.dataset.tool);
    if (b.dataset.shape) setShape(b.dataset.shape);
    if (b.dataset.act === 'undo') doUndo();
    if (b.dataset.act === 'redo') doRedo();
    if (b.dataset.col) setStyle({ color: b.dataset.col });
  });
  bar.addEventListener('change', e => {
    const t = e.target, v = Number(t.value);
    if (t.dataset.fly === 'pitch') { sk.pitch = Math.max(0, Math.min(48, Number.isFinite(v) ? v : 6)); redoLast('slope'); }
    if (t.dataset.fly === 'dist' && Number.isFinite(v)) redoLast('push', v * kz());
    if (t.name === 'dg-size') setStyle({ size: v });
    if (t.dataset.st) setStyle({ [t.dataset.st]: t.checked });
    if (t.dataset.col === 'custom') setStyle({ color: t.value });
  });
  /** Diagram style for new annotations (and the selected one). */
  function setStyle(ch) {
    Object.assign(sk.style, ch);
    bar.querySelectorAll('[data-col]').forEach(x => x.classList.toggle('on', x.dataset.col === sk.style.color || (x.dataset.col === 'custom' && sk.style.color.startsWith('#'))));
    const o = sk.sel?.kind === 'note' ? findSel() : null;
    if (o) { before(); applyStyle(o, ch); cardEl.dataset.sig = ''; changed(true); }
  }
  function applyStyle(o, ch) {
    if ('color' in ch) o.color = ch.color;
    if ('size' in ch) { if (WIDTHS[o.type]) o.w = WIDTHS[o.type][ch.size]; o.size = ch.size; }
    if ('stand' in ch && o.type !== 'label') o.stand = ch.stand;
    if ('curve' in ch) o.curve = ch.curve;
  }
  function setTool(t) {
    if (!tools().some(x => x.id === t)) t = 'select';
    sk.tool = t; sk.draw = null; sk.hov = null;
    card();
    bar.querySelectorAll('[data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === t));
    bar.querySelectorAll('.sk-fly').forEach(f => {
      f.hidden = f.dataset.for === 'style' ? t === 'select' : f.dataset.for !== t;
      f.querySelector('.dg-row')?.toggleAttribute('hidden', t === 'paint');
      if (!f.hidden) { const b = bar.querySelector(`[data-tool="${f.dataset.for === 'style' ? 'arrow' : t}"]`); f.style.top = `${b.offsetTop}px`; }
    });
    const u = bar.querySelector('.sk-u'); if (u) u.textContent = uLen();
    setShape(sk.shape, true);
    const drawing = t !== 'select';
    map.getContainer().classList.toggle('sk-drawing', drawing);
    map.getContainer().classList.toggle('sk-paint', t === 'paint');
    sk.v3?.el.classList.toggle('sk-paint', t === 'paint' && sk.active);
    sk.v3?.el.classList.toggle('sk-drawing', drawing && sk.active);
    sk.v3?.sketchNav(sk.active && drawing);
    const hint = hints()[t] + (drawing ? (sk.v3 ? ' Wheel-drag pans, Shift+wheel-drag or right-drag orbits.' : ' Wheel-drag pans.') : '');
    if (hintEl()) hintEl().textContent = hint;
    draw();
  }
  function setShape(s, quiet) {
    sk.shape = s;
    bar.querySelectorAll('[data-shape]').forEach(b => b.classList.toggle('on', b.dataset.shape === s));
    if (!quiet && sk.tool !== 'mass' && sk.set === 'sketch') setTool('mass');
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
    if (kind === 'mass' && sk.sel2 && massById(sk.sel2.id)) {
      const b = massById(sk.sel2.id);
      return `<div class="skc-row"><b>Two blocks</b><span class="skc-read">${escapeHtml(useLabel(o))} (orange) + ${escapeHtml(useLabel(b))} (dashed)</span></div>
        <div class="skc-row skc-bool">
          <button type="button" data-k="bool-join" data-tip="bool-join">⊕ Join</button>
          <button type="button" data-k="bool-intersect" data-tip="bool-intersect">⊗ Intersect</button>
          <button type="button" data-k="bool-cut" data-tip="bool-cut">⊖ Cut</button></div>
        <div class="skc-row skc-note">Cut takes the dashed block out of the orange one. The result keeps the orange block's use and floor height. Shift+click again to drop the second block.</div>`;
    }
    if (kind === 'note') {
      const nm = { arrow: 'Arrow', line: 'Line', region: 'Region', label: 'Label' }[o.type];
      return `<div class="skc-row"><b>${nm}</b>${o.on === 'mass' ? '<span class="skc-read">on a building face</span>' : ''}<span style="flex:1"></span><button type="button" data-k="del" title="Delete (Del)">🗑</button></div>
        ${o.type === 'label' ? `<div class="skc-row"><input type="text" data-k="text" value="${escapeHtml(o.text || '')}" style="flex:1;min-width:160px"></div>` : ''}
        <div class="skc-row dg-sws">${swatchHtml(o.color)}</div>
        <div class="skc-row">${o.type !== 'region' ? `<span class="seg seg-dark">${SIZES.map((z, i) => `<label><input type="radio" name="skc-size" value="${i}"${(o.size ?? 1) === i ? ' checked' : ''}><span>${z}</span></label>`).join('')}</span>` : ''}
          ${o.type !== 'label' ? `<label class="skc-chk" title="F"><input type="checkbox" data-k="stand"${o.stand ? ' checked' : ''}> Upright</label>` : ''}
          ${o.type === 'arrow' || o.type === 'line' ? `<label class="skc-chk"><input type="checkbox" data-k="curve"${o.curve ? ' checked' : ''}> Curved</label>` : ''}</div>
        ${o.stand && (o.type === 'line' || o.type === 'region') ? `<div class="skc-row"><span>Height</span>${num('h', o.h || 20, 1, 500, 1)}<span>${uLen()}</span></div>` : ''}
        ${o.type === 'region' ? `<div class="skc-row"><span>Opacity</span><input type="range" data-k="op" min="0.1" max="1" step="0.05" value="${o.op ?? 0.55}"></div>` : ''}`;
    }
    if (kind === 'mass') {
      const head = `<div class="skc-row"><select data-k="use">${scheme().uses.map(u => `<option value="${u.key}"${u.key === o.use ? ' selected' : ''}>${escapeHtml(u.label)}</option>`).join('')}</select>
          <button type="button" data-k="del" title="Delete (Del)">🗑</button></div>`;
      const floors = `<div class="skc-row"><span>Floors</span><button type="button" data-k="fl-" title="↓">−</button><output data-o="floors"></output><button type="button" data-k="fl+" title="↑">+</button>
          <span>@</span>${num('ftf', o.ftf, 2, 40, 0.5)}<span>${uLen()}</span></div>`;
      if (info(o).sheet) return `${head}<div class="skc-row skc-note">Flat shape — pull it up with Push/Pull (U).</div><div class="skc-row skc-read" data-o="read"></div>`;
      if (!o.prm) return `${head}${floors}<div class="skc-row skc-note">Edited by hand — shape it with Draw, Push/Pull, Slope and Ctrl+drag.</div><div class="skc-row skc-read" data-o="read"></div>`;
      const r = o.prm.roof || { type: 'flat', pitch: 6 }, st = o.prm.step || { at: 0, inset: 10 };
      return `${head}${floors}
        <div class="skc-row seg seg-dark" title="Roof form (R)">${ROOFS.map(([k, l]) => `<label><input type="radio" name="skc-roof" value="${k}"${r.type === k ? ' checked' : ''}><span>${l}</span></label>`).join('')}</div>
        ${r.type !== 'flat' ? `<div class="skc-row"><span>Pitch</span>${num('pitch', r.pitch, 0.5, 24, 0.5, 42)}<span>: 12</span>${r.type === 'shed' ? '<button type="button" data-k="flip" title="Turn the slope around">⇄</button>' : ''}</div>` : ''}
        <div class="skc-row"><span title="Open courtyard: building depth around it (0 = solid)">Courtyard ring</span>${num('court', o.prm.court || 0, 0, 500, 5)}<span>${uLen()} deep</span></div>
        <div class="skc-row"><span title="Upper floors step back from the outline">Step back above floor</span>${num('stepAt', st.at || 0, 0, 120, 1, 40)}<span>by</span>${num('stepIn', st.inset, 1, 200, 1, 40)}<span>${uLen()}</span></div>
        <div class="skc-row skc-read" data-o="read"></div>`;
    }
    if (kind === 'lot') {
      return `<div class="skc-row seg seg-dark">${[90, 60, 45].map(a => `<label><input type="radio" name="skc-ang" value="${a}"${o.stall === a ? ' checked' : ''}><span>${a}°</span></label>`).join('')}
          <button type="button" data-k="del" title="Delete (Del)">🗑</button></div>
        <div class="skc-row"><span>Rows</span><button type="button" data-k="rot-" title="Turn ([)">⟲</button><button type="button" data-k="rot0" title="Line up with the longest side">auto</button><button type="button" data-k="rot+" title="Turn (])">⟳</button>
          <button type="button" data-k="sh-" title="Slide rows (↑)">▲</button><button type="button" data-k="sh+" title="Slide rows (↓)">▼</button></div>
        <div class="skc-row"><span title="Landscape strip inside the lot edge">Edge buffer</span>${num('setback', o.setback || 0, 0, 100, 1, 42)}<span>${uLen()}</span>
          <span title="Corner radius of the end / every-N islands">Island corners r</span>${num('islandR', o.islandR ?? 3, 0, 20, 0.5, 40)}<span>${uLen()}</span></div>
        <div class="skc-row"><label class="skc-chk"><input type="checkbox" data-k="endIslands"${o.endIslands ? ' checked' : ''}> End islands</label>
          <span>Island every</span>${num('islandEvery', o.islandEvery || 0, 0, 40, 1, 38)}<span>stalls</span></div>
        <div class="skc-row skc-read" data-o="read"></div>`;
    }
    if (kind === 'drive') {
      return `<div class="skc-row"><span>Drive aisle</span>${num('w', o.w || 24, 10, 60, 1)}<span>${uLen()} wide</span><button type="button" data-k="del" title="Delete (Del)">🗑</button></div>
        <div class="skc-row"><span title="Curb return where it meets a lot or another aisle, and at curb cuts">Turn radius</span>${num('r', o.r ?? 15, 0, 60, 1, 42)}<span>${uLen()}</span>
          <label class="skc-chk" title="Flared apron and depressed curb where an end leaves all paving (at the street)"><input type="checkbox" data-k="cut"${o.cut !== false ? ' checked' : ''}> Curb cut at street end</label></div>
        <div class="skc-row skc-read" data-o="read"></div>`;
    }
    return `<div class="skc-row"><span>Planter island</span><button type="button" data-k="del" title="Delete (Del)">🗑</button></div>
      <div class="skc-row"><span>Corner radius</span>${num('r', o.r ?? 3, 0, 30, 0.5, 42)}<span>${uLen()}</span></div><div class="skc-row skc-read" data-o="read"></div>`;
  }
  function card() {
    const o = findSel();
    if (!o || !sk.active || !sk.site || sk.drag || sk.draw || sk.op || (sk.set === 'sketch' && sk.tool !== 'select') || (sk.set === 'diagram' && sk.tool !== 'select' && !(sk.tool === 'label' && o.type === 'label')) || (sk.v3 && !sk.v3.visible)) { cardEl.hidden = true; return; }
    const kind = sk.sel.kind;
    let x1 = -Infinity, y0 = Infinity;
    const pts = kind === 'mass' ? o.v.map(p => P3(o, p)) : kind === 'note' ? (noteScreen(o) || []) : o.pts.map(p => scr(p, handleZ(kind, o)(p)));
    for (const q of pts) { if (!q) continue; if (q[0] > x1) x1 = q[0]; if (q[1] < y0) y0 = q[1]; }
    if (!Number.isFinite(x1)) { cardEl.hidden = true; return; }
    const W = cardEl.parentElement.clientWidth, H = cardEl.parentElement.clientHeight;
    const sig = `${kind}:${o.id}:${sk.sel2?.id || ''}:${sk.cardVer || 0}:${!!o.prm}:${kind === 'mass' && info(o).sheet}:${JSON.stringify([o.prm, o.stall, o.endIslands, o.ftf, o.setback, o.islandEvery, o.w, o.use, o.color, o.stand, o.curve, o.size, o.r, o.cut, o.islandR])}`;
    if (cardEl.dataset.sig !== sig && !cardEl.contains(document.activeElement)) { cardEl.dataset.sig = sig; cardEl.innerHTML = cardHtml(kind, o); }
    const read = cardEl.querySelector('[data-o="read"]') || {};
    if (kind === 'note') { /* nothing to read out */ } else if (kind === 'mass') {
      const I = info(o), fl = cardEl.querySelector('[data-o="floors"]');
      if (fl) fl.textContent = String(I.floors);
      read.textContent = I.sheet ? fmtArea(area(I.foot) * sfPerNative2()) : `${fmtArea(massGfa(o))} total · ${I.floors ? `${fmtArea(I.P[0].area * sfPerNative2())} ground floor · ` : ''}${fmtLen(I.zmax)} tall`;
    } else if (kind === 'lot') {
      const Lr = lotLayout(o);
      read.textContent = `${Lr.total} spaces (${Lr.acc} accessible${Lr.van ? `, ${Lr.van} van` : ''}) · ${Math.round(area(o.pts) * sfPerNative2() / Math.max(1, Lr.total))} sf per space`;
    } else if (kind === 'drive') {
      let Ln = 0; for (let i = 1; i < o.pts.length; i++) Ln += Math.hypot(o.pts[i][0] - o.pts[i - 1][0], o.pts[i][1] - o.pts[i - 1][1]);
      read.textContent = `${fmtLen(Ln)} long · stalls it crosses are cleared`;
    } else read.textContent = fmtArea(area(o.pts) * sfPerNative2());
    cardEl.hidden = false;
    // Pinned at the bottom-left of the view (beside the toolbar), so it never covers the blocks you're clicking.
    void x1; void y0; void W; void H;
    cardEl.style.left = '78px'; cardEl.style.top = 'auto'; cardEl.style.bottom = '14px';
  }
  function floorsBy(o, dir) {
    if (o.prm) { o.prm.floors = Math.max(1, Math.min(120, o.prm.floors + dir)); if (o.prm.step && o.prm.step.at >= o.prm.floors) o.prm.step = null; regen(o); return true; }
    return SO.shiftTop(o, ftfN(o), dir, info(o).tris);
  }
  cardEl.addEventListener('click', e => {
    const sw = e.target.closest('button[data-col]'), on = findSel();
    if (sw && on && sk.sel.kind === 'note') { before(); on.color = sw.dataset.col; cardEl.dataset.sig = ''; changed(true); return; }
    const b = e.target.closest('button[data-k]'); const o = findSel(); if (!b || !o) return;
    const k = b.dataset.k;
    if (k === 'del') { removeSel(); return; }
    if (k.startsWith('bool-')) { combine(k.slice(5)); return; }
    if (k === 'fl-' || k === 'fl+') { before(); if (floorsBy(o, k === 'fl+' ? 1 : -1)) { remember(o); changed(true); } else sk.undo.pop(); }
    if (k === 'flip') { before(); o.prm.roof = { ...o.prm.roof, flip: !o.prm.roof?.flip }; regen(o); changed(true); }
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
    const t = e.target, k = t.dataset.k, v = Number(t.value), p = o.prm;
    before();
    if (sk.sel.kind === 'note') {
      if (k === 'text') o.text = t.value;
      if (k === 'stand') o.stand = t.checked;
      if (k === 'curve') o.curve = t.checked;
      if (k === 'h') o.h = Math.max(1, v || 20);
      if (k === 'op') o.op = Math.max(0.1, Math.min(1, v || 0.55));
      if (t.name === 'skc-size') applyStyle(o, { size: v });
      if (t.dataset.col === 'custom') o.color = t.value;
      cardEl.dataset.sig = ''; changed(true); return;
    }
    if (k === 'use') o.use = t.value;
    if (k === 'ftf') { o.ftf = Math.max(2, v || o.ftf); regen(o); }
    if (p) {
      if (t.name === 'skc-roof') p.roof = { pitch: p.roof?.pitch || 6, ...p.roof, type: t.value };
      if (k === 'pitch') p.roof = { ...p.roof, pitch: Math.max(0.5, Math.min(24, v || 6)) };
      if (k === 'court') p.court = Math.max(0, v || 0);
      if (k === 'stepAt' || k === 'stepIn') {
        const st = p.step || { at: 0, inset: 10 };
        if (k === 'stepAt') st.at = Math.max(0, Math.min(p.floors - 1, Math.round(v) || 0)); else st.inset = Math.max(1, v || 10);
        p.step = st.at > 0 ? st : (k === 'stepIn' ? st : null);
      }
      regen(o);
    }
    if (t.name === 'skc-ang') { o.stall = v; sk.lastStall = v; }
    if (k === 'setback') o.setback = Math.max(0, v || 0);
    if (k === 'endIslands') o.endIslands = t.checked;
    if (k === 'islandEvery') o.islandEvery = Math.max(0, Math.round(v) || 0);
    if (k === 'w') o.w = Math.max(10, Math.min(60, v || 24));
    if (k === 'r') o.r = Math.max(0, Number.isFinite(v) ? v : 0);
    if (k === 'cut') o.cut = t.checked;
    if (k === 'islandR') o.islandR = Math.max(0, Number.isFinite(v) ? v : 0);
    if (sk.sel.kind === 'mass') remember(o);
    cardEl.dataset.sig = '';
    changed();
  });
  cardEl.addEventListener('input', e => {
    const o = findSel(); if (!o || sk.sel.kind !== 'note' || e.target.dataset.k !== 'text') return;
    o.text = e.target.value; sk.ver++; draw();
  });
  function remember(o) { sk.last = { use: o.use, floors: o.prm?.floors || info(o).floors || 3, ftf: o.ftf, roof: o.prm?.roof?.type || sk.last?.roof || 'flat' }; }
  /** Join / intersect / cut the selected block with the second one; the result replaces the first. */
  async function combine(op) {
    const A = findSel(), B = sk.sel2 && massById(sk.sel2.id);
    if (!A || !B || sk.busy) return;
    sk.busy = true; flash(`${op === 'join' ? 'Joining' : op === 'intersect' ? 'Intersecting' : 'Cutting'}…`);
    const abs = m => { const b = massBase(m) * kz(); return { v: m.v.map(p => [p[0], p[1], p[2] + b]), f: m.f }; };
    try {
      const r = await booleanSolids(op, abs(A), abs(B));
      before();
      const zmin = Math.min(...r.v.map(p => p[2]));
      A.v = r.v.map(p => [p[0], p[1], p[2] - zmin]); A.f = r.f; freeze(A);
      sk.infos.delete(A.id);
      sk.model.masses = sk.model.masses.filter(m => m.id !== B.id);
      sk.model.notes = sk.model.notes.filter(n => n.mid !== B.id);
      sk.sel2 = null; cardEl.dataset.sig = '';
      flash(`${op === 'join' ? 'Joined' : op === 'intersect' ? 'Intersected' : 'Cut'} — ${info(A).floors} floors, ${fmtArea(massGfa(A))}. Ctrl+Z to undo.`);
      changed();
    } catch (e) {
      console.error(e);
      flash(`Couldn't ${op === 'cut' ? 'cut' : op}: ${e.message || e}`);
    } finally { sk.busy = false; }
  }
  function removeSel() {
    if (!sk.sel) return;
    before();
    sk.model[LISTS[sk.sel.kind]] = list(sk.sel.kind).filter(m => m.id !== sk.sel.id);
    if (sk.sel.kind === 'mass') sk.model.notes = sk.model.notes.filter(n => n.mid !== sk.sel.id);
    sk.sel = null; changed();
  }

  // ---------------------------------------------------------------- picking
  // ev: { sx, sy (px in the view), xy (ground point, native), at(z) (point on the plane at output elevation z),
  //       ray (two native points [x, y, zOut] on the cursor ray), shift, alt, ctrl }
  const ortho = (a, b) => (Math.abs(b[0] - a[0]) > Math.abs(b[1] - a[1]) ? [b[0], a[1]] : [a[0], b[1]]);
  const distSeg = (p, a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1; const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2)); return Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t); };
  const segT = (p, a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1; return Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2)); };
  /** The cursor ray in a solid's own space (x, y native; z native above its base). */
  function rayIn(m, ev) {
    const r = ev.ray(); if (!r) return null;
    const base = massBase(m), k = kz(), e = ex3(), sheet = info(m).sheet ? 0.15 : 0;
    const S = p => [p[0], p[1], (p[2] - base - sheet) * e * k];
    const o = S(r[0]), q = S(r[1]);
    return { o, d: SO.unit(SO.sub(q, o)) };
  }
  /** Face of a solid under the cursor: { id, fi, p (solid-space point) } or null. */
  function pickFace(ev) {
    if (sk.v3) {
      const h = sk.v3.pickSketch(ev.sx, ev.sy);
      if (!h?.id) return null;
      const m = massById(h.id); if (!m) return null;
      const r = rayIn(m, ev), p = r && SO.rayFace(m, h.face, r.o, r.d);
      return p ? { id: m.id, fi: h.face, p } : null;
    }
    const xy = ev.xy; if (!xy) return null;
    const ms = sk.model.masses.slice().sort((a, b) => massTop(b) - massTop(a));
    for (const m of ms) { const t = info(m).top(...xy); if (t) return { id: m.id, fi: t.fi, p: [xy[0], xy[1], t.z] }; }
    return null;
  }
  /** Point, edge or face of a solid under the cursor (Ctrl-move). */
  function pickElement(ev) {
    let best = null;
    for (const m of sk.model.masses) {
      m.v.forEach((p, i) => { const q = P3(m, p); if (!q) return; const d = Math.hypot(q[0] - ev.sx, q[1] - ev.sy); if (d < 9 && (!best || d < best.d)) best = { id: m.id, t: 'v', i, d }; });
    }
    if (best) return best;
    for (const m of sk.model.masses) for (const [a, b] of info(m).edges) {
      const p = P3(m, m.v[a]), q = P3(m, m.v[b]); if (!p || !q) continue;
      const d = distSeg([ev.sx, ev.sy], p, q);
      if (d < 6 && (!best || d < best.d)) best = { id: m.id, t: 'e', a, b, d };
    }
    if (best) return best;
    const f = pickFace(ev);
    return f ? { id: f.id, t: 'f', fi: f.fi, p: f.p } : null;
  }
  function hit(ev) {
    const o = findSel();
    if (o) for (const h of handles(sk.sel.kind, o)) { const q = scr(h.p, h.z); if (q && Math.hypot(q[0] - ev.sx, q[1] - ev.sy) < (h.t === 'r' || h.t === 's' ? 10 : 7)) return { kind: sk.sel.kind, id: o.id, h, z: h.z }; }
    if (sk.v3) { const p = sk.v3.pickSketch(ev.sx, ev.sy); if (p && p.id) return { kind: 'mass', id: p.id, z: p.at[2] }; }
    const xy = ev.xy; if (!xy) return null;
    const zg = zGround(xy);
    if (!sk.v3) {
      const ms = sk.model.masses.slice().sort((a, b) => massTop(b) - massTop(a));
      for (const m of ms) if (info(m).top(...xy)) return { kind: 'mass', id: m.id, z: 0 };
    }
    const tol = sk.v3 ? 0 : 4 / ctx.affine(sk.site).scale;
    for (const d of sk.model.drives) for (let i = 0; i < d.pts.length - 1; i++) if (distSeg(xy, d.pts[i], d.pts[i + 1]) < (d.w || 24) * perFt() / 2 + tol) return { kind: 'drive', id: d.id, z: zg };
    for (const i of sk.model.islands) if (inPoly(i.pts, ...xy)) return { kind: 'island', id: i.id, z: zg };
    for (const l of sk.model.lots) if (inPoly(l.pts, ...xy)) return { kind: 'lot', id: l.id, z: zg };
    return null;
  }

  // ---------------------------------------------------------------- snapping (plan points)
  /** What drawing can snap to: sketch outlines, parking layout (for the parking tools), and the site's parcels,
   *  buildings and road edges. Cached until the sketch changes. */
  function snapCands(kind, exclude) {
    const key = `${sk.ver}:${kind}:${exclude || ''}`;
    if (sk.sc?.key === key) return sk.sc;
    const pts = [], segs = [], fsegs = [];
    const ring = (P, t, cl = true, frame = true) => {
      if (!P || P.length < 2) return;
      for (const p of P) pts.push({ p: [p[0], p[1]], t: `${t} corner` });
      for (let i = 0; i < (cl ? P.length : P.length - 1); i++) { const sg = { a: P[i], b: P[(i + 1) % P.length], t: `${t} edge` }; segs.push(sg); if (frame) fsegs.push(sg); }
    };
    for (const m of sk.model.masses) {
      if (m.id === exclude) continue;
      if (m.prm) ring(m.prm.pts, 'block');
      else {
        const I = info(m);
        for (const [a, b] of I.edges) if (m.v[a][2] < 1e-6 && m.v[b][2] < 1e-6) { const sg = { a: m.v[a].slice(0, 2), b: m.v[b].slice(0, 2), t: 'block edge' }; segs.push(sg); fsegs.push(sg); }
        for (const p of I.foot) pts.push({ p: p.slice(0, 2), t: 'block corner' });
      }
    }
    const parking = ['lot', 'island', 'drive'].includes(kind);
    for (const l of sk.model.lots) {
      if (l.id === exclude) continue;
      ring(l.pts, 'lot');
      if (!parking) continue;
      const Lr = lotLayout(l);
      if (Lr.inner?.length > 2 && l.setback > 0) ring(Lr.inner, 'buffer', true, false);
      for (const st of Lr.stalls) for (const p of [st.pts[0], st.pts[1]]) pts.push({ p, t: 'stall line' });
      for (const A of Lr.aisles) {
        const a = [(A[0][0] + A[3][0]) / 2, (A[0][1] + A[3][1]) / 2], b = [(A[1][0] + A[2][0]) / 2, (A[1][1] + A[2][1]) / 2];
        segs.push({ a, b, t: 'aisle centre' }); pts.push({ p: a, t: 'aisle end' }, { p: b, t: 'aisle end' });
      }
    }
    for (const i of sk.model.islands) if (i.id !== exclude) ring(i.pts, 'island');
    for (const d of sk.model.drives) if (d.id !== exclude) ring(d.pts, 'drive aisle', false);
    for (const c of ctx.contextSegs?.() || []) ring(c.pts, c.t, c.closed, c.frame !== false);
    sk.sc = { key, C: { pts, segs }, frames: frameAngles(fsegs) };
    return sk.sc;
  }
  /** Snapped plan point under the cursor (null off the ground). prev: the point the current line starts from. */
  function groundSnap(ev, prev, opt = {}) {
    const c = ev.xy; if (!c) return null;
    if (ev.alt || sk.snapOff) { sk.snap = null; return c; }
    const S = snapCands(opt.kind || sk.tool, opt.exclude);
    const s0 = scr(c), s1 = scr([c[0] + 10 * perFt(), c[1]]);
    const ppn = s0 && s1 ? Math.max(1e-6, Math.hypot(s1[0] - s0[0], s1[1] - s0[1]) / (10 * perFt())) : 1;
    const Rn = 420 / ppn, near = p => Math.abs(p[0] - c[0]) < Rn && Math.abs(p[1] - c[1]) < Rn;
    const pts = S.C.pts.filter(q => near(q.p)), segs = S.C.segs.filter(g => Math.min(g.a[0], g.b[0]) < c[0] + Rn && Math.max(g.a[0], g.b[0]) > c[0] - Rn && Math.min(g.a[1], g.b[1]) < c[1] + Rn && Math.max(g.a[1], g.b[1]) > c[1] - Rn);
    for (const p of opt.own || []) pts.push({ p, t: 'start point' });
    let frames = S.frames;
    if (opt.own?.length >= 2) { const a = opt.own[0], b = opt.own[1]; let f = Math.atan2(b[1] - a[1], b[0] - a[0]) % (Math.PI / 2); if (f < 0) f += Math.PI / 2; frames = [f, ...frames]; }
    const res = snapTo(c, { pts, segs }, { scr: p => scr(p), prev, shift: ev.shift, frames });
    sk.snap = res.t ? res : null;
    return res.p;
  }
  /** The frame (radians) of the outline nearest p, for rectangles that line up with what's there. */
  function frameNear(p) {
    const S = snapCands(sk.tool);
    const s0 = scr(p); if (!s0) return 0;
    let best = null;
    for (const g of S.C.segs) {
      if (g.t === 'aisle centre' || g.t === 'stall line') continue;
      const dx = g.b[0] - g.a[0], dy = g.b[1] - g.a[1], L2 = dx * dx + dy * dy || 1, t = Math.max(0, Math.min(1, ((p[0] - g.a[0]) * dx + (p[1] - g.a[1]) * dy) / L2));
      const q = scr([g.a[0] + dx * t, g.a[1] + dy * t]); if (!q) continue;
      const d = Math.hypot(q[0] - s0[0], q[1] - s0[1]);
      if (d < 150 && (!best || d < best.d)) { let f = Math.atan2(dy, dx) % (Math.PI / 2); if (f < 0) f += Math.PI / 2; best = { d, f }; }
    }
    return best ? best.f : 0;
  }
  const fu = f => [Math.cos(f), Math.sin(f)], fv = f => [-Math.sin(f), Math.cos(f)];
  /** Rectangle from a to b in frame f (square with Shift). */
  function rectFrame(a, b, f, square) {
    const u = fu(f), v = fv(f), w = [b[0] - a[0], b[1] - a[1]];
    let du = w[0] * u[0] + w[1] * u[1], dv = w[0] * v[0] + w[1] * v[1];
    if (square) { const m = Math.max(Math.abs(du), Math.abs(dv)); du = Math.sign(du || 1) * m; dv = Math.sign(dv || 1) * m; }
    const P = (x, y) => [a[0] + u[0] * x + v[0] * y, a[1] + u[1] * x + v[1] * y];
    return { P, du, dv, pts: [P(0, 0), P(du, 0), P(du, dv), P(0, dv)] };
  }
  function drawSnap(g) {
    const sn = sk.snap; if (!sn || !(sk.draw || sk.drag || sk.op || sk.tool !== 'select')) return;
    const q = scr(sn.p); if (!q) return;
    g.save();
    for (const [a, b] of sn.guides || []) {
      const qa = scr(a), qb = scr(b); if (!qa || !qb) continue;
      const vx = qb[0] - qa[0], vy = qb[1] - qa[1], L = Math.hypot(vx, vy) || 1, ext = sn.t === 'align' ? 0 : 60;
      g.beginPath(); g.moveTo(qa[0], qa[1]); g.lineTo(qb[0] + vx / L * ext, qb[1] + vy / L * ext);
      g.setLineDash(sn.t === 'align' ? [2, 4] : [7, 5]); g.strokeStyle = sn.t === 'lock' ? '#d946ef' : sn.t === 'align' ? '#a855f7' : '#d946ef'; g.lineWidth = 1.5; g.stroke();
    }
    g.setLineDash([]);
    g.beginPath();
    if (sn.t === 'corner') { g.rect(q[0] - 6, q[1] - 6, 12, 12); g.strokeStyle = '#16a34a'; g.lineWidth = 2.5; g.stroke(); }
    else if (sn.t === 'mid') { g.moveTo(q[0], q[1] - 7); g.lineTo(q[0] + 7, q[1] + 5); g.lineTo(q[0] - 7, q[1] + 5); g.closePath(); g.strokeStyle = '#0891b2'; g.lineWidth = 2.5; g.stroke(); }
    else if (sn.t === 'edge') { g.moveTo(q[0] - 6, q[1] - 6); g.lineTo(q[0] + 6, q[1] + 6); g.moveTo(q[0] + 6, q[1] - 6); g.lineTo(q[0] - 6, q[1] + 6); g.strokeStyle = '#dc2626'; g.lineWidth = 2.5; g.stroke(); }
    else { g.arc(q[0], q[1], 4, 0, Math.PI * 2); g.fillStyle = '#d946ef'; g.fill(); }
    g.restore();
    if (sn.label) { g.save(); g.font = '600 11px system-ui, sans-serif'; const w = g.measureText(sn.label).width + 10; g.fillStyle = 'rgba(28,34,38,0.9)'; g.beginPath(); g.roundRect(q[0] + 10, q[1] + 10, w, 18, 4); g.fill(); g.fillStyle = '#e7e4dd'; g.textBaseline = 'middle'; g.fillText(sn.label, q[0] + 15, q[1] + 19); g.restore(); }
  }

  // ---------------------------------------------------------------- creating things on the ground
  function finishDraw(pts) {
    const d = sk.draw;
    sk.draw = null;
    const kind = d.kind;
    if (kind === 'drive') {
      let Ln = 0; for (let i = 1; i < pts.length; i++) Ln += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      if (pts.length < 2 || Ln / perFt() < 10) { draw(); return; }
    } else if (pts.length < 3 || area(pts) * sfPerNative2() < 50) { draw(); return; }
    before();
    let o = { id: uid() };
    if (kind === 'mass' || kind === 'sheet') {
      Object.assign(o, { use: sk.last?.use || scheme().uses[0].key, ftf: sk.last?.ftf || (metric() ? 3.6 : 12) });
      if (kind === 'sheet') Object.assign(o, SO.sheet(pts));
      else {
        o.prm = { pts, floors: sk.last?.floors || 3, court: 0, step: null, roof: sk.last?.roof && sk.last.roof !== 'flat' ? { type: sk.last.roof, pitch: 6 } : null };
        if (d.shape === 'court' && d.rect) { const side = Math.min(Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]), Math.hypot(pts[2][0] - pts[1][0], pts[2][1] - pts[1][1])); o.prm.court = Math.max(10, Math.round(side * 0.3 / perFt() * outPerFt() / 5) * 5); }
        regen(o);
      }
      sk.model.masses.push(o);
      sk.sel = { kind: 'mass', id: o.id };
    } else {
      o.pts = pts;
      if (kind === 'lot') Object.assign(o, { stall: sk.lastStall || 90, shift: 0, angle: null, setback: 0, endIslands: false, islandEvery: 0 });
      else if (kind === 'drive') o.w = 24;
      list(kind).push(o);
      sk.sel = { kind, id: o.id };
    }
    changed();
  }

  // ---------------------------------------------------------------- drawing on a face (Draw tool)
  /** Snap a solid-space point on face fi to its corners / edges (screen tolerance). */
  function snapOnFace(m, fi, p) {
    const q = P3(m, p); if (!q) return { p };
    let best = null;
    for (const L of SO.faceLoops(m, fi)) for (let k = 0; k < L.length; k++) {
      const i = L[k], s = P3(m, m.v[i]); if (!s) continue;
      const d = Math.hypot(s[0] - q[0], s[1] - q[1]);
      if (d < 10 && (!best || best.t !== 'v' || d < best.d)) best = { t: 'v', i, p: m.v[i].slice(), d, outer: L === m.f[fi].o };
    }
    if (best) return best;
    for (const L of SO.faceLoops(m, fi)) for (let k = 0; k < L.length; k++) {
      const a = L[k], b = L[(k + 1) % L.length], sa = P3(m, m.v[a]), sb = P3(m, m.v[b]); if (!sa || !sb) continue;
      const d = distSeg(q, sa, sb);
      if (d < 8 && (!best || d < best.d)) {
        let t = segT(q, sa, sb);
        const mid = Math.abs(t - 0.5) * Math.hypot(sb[0] - sa[0], sb[1] - sa[1]) < 6; if (mid) t = 0.5;      // midpoints snap
        best = { t: 'e', a, b, p: SO.add(m.v[a], SO.mul(SO.sub(m.v[b], m.v[a]), t)), d, mid, outer: L === m.f[fi].o };
      }
    }
    return best || { p };
  }
  function penFacePoint(ev) {
    const d = sk.draw, m = massById(d.id); if (!m) return null;
    const r = rayIn(m, ev); if (!r) return null;
    const p = SO.rayFace(m, d.fi, r.o, r.d); if (!p) return null;
    const s = snapOnFace(m, d.fi, p);
    // Lines across a face pull square to the face (Shift locks), like on the ground.
    const prev = d.pts?.length && !d.rect && !d.pending ? d.pts[d.pts.length - 1].p : null;
    if (!s.t && prev && !ev.alt) {
      const F = SO.faceFrame(m, d.fi), w = SO.sub(p, prev), cu = SO.dot(w, F.u), cv = SO.dot(w, F.v);
      const ang = Math.atan2(Math.abs(cv), Math.abs(cu));
      if (ev.shift || ang < 3 * Math.PI / 180 || ang > 87 * Math.PI / 180) {
        const alongU = Math.abs(cu) >= Math.abs(cv);
        return { p: SO.add(prev, SO.mul(alongU ? F.u : F.v, alongU ? cu : cv)), axis: true };
      }
    }
    return s;
  }
  function penRect(d, m) {
    const F = SO.faceFrame(m, d.fi), a = d.pts[0].p, b = d.b.p;
    const du = SO.dot(SO.sub(b, a), F.u), dv = SO.dot(SO.sub(b, a), F.v);
    return [a, SO.add(a, SO.mul(F.u, du)), SO.add(SO.add(a, SO.mul(F.u, du)), SO.mul(F.v, dv)), SO.add(a, SO.mul(F.v, dv))];
  }
  function drawPenFace(g, d) {
    const m = massById(d.id); if (!m) return;
    if (facePath(g, m, d.fi)) { g.fillStyle = 'rgba(232,145,63,0.12)'; g.fill('evenodd'); }
    const P = d.rect ? penRect(d, m) : [...d.pts.map(s => s.p), ...(d.hover ? [d.hover.p] : [])];
    const Q = P.map(p => P3(m, p));
    if (Q.length > 1 && Q.every(Boolean)) {
      g.beginPath(); Q.forEach((q, i) => (i ? g.lineTo(...q) : g.moveTo(...q))); if (d.rect) g.closePath();
      const ok = !d.rect || P.every(p => SO.inFace(m, d.fi, p));
      g.setLineDash([6, 4]); g.strokeStyle = ok ? ORANGE : '#ef4444'; g.lineWidth = 2; g.stroke(); g.setLineDash([]);
    }
    for (const s of [...d.pts, ...(d.hover ? [d.hover] : [])]) {
      const q = P3(m, s.p); if (!q) continue;
      g.beginPath();
      if (s.t === 'v') g.rect(q[0] - 5, q[1] - 5, 10, 10); else g.arc(q[0], q[1], s.t === 'e' ? 5 : 3.5, 0, Math.PI * 2);
      g.fillStyle = s.t === 'v' ? '#22c55e' : s.t === 'e' ? (s.mid ? '#06b6d4' : '#ef4444') : ORANGE; g.fill();
    }
    if (d.rect) { const R = penRect(d, m); const w = SO.len(SO.sub(R[1], R[0])), h = SO.len(SO.sub(R[3], R[0])); tag(g, P3(m, d.b.p), `${fmtLen(w)} × ${fmtLen(h)}`); }
    else if (d.hover && d.pts.length) tag(g, P3(m, d.hover.p), fmtLen(SO.len(SO.sub(d.hover.p, d.pts[d.pts.length - 1].p))));
  }
  /** Vertex index for a snapped point on face fi (adds a vertex on an edge when needed). */
  function vertexFor(m, fi, s) {
    if (s.t === 'v') return s.i;
    if (s.t === 'e') {
      for (const L of SO.faceLoops(m, fi)) for (let k = 0; k < L.length; k++) {
        const a = L[k], b = L[(k + 1) % L.length], A = m.v[a], B = m.v[b];
        const ab = SO.sub(B, A), t = SO.dot(SO.sub(s.p, A), ab) / (SO.dot(ab, ab) || 1);
        if (t <= 1e-6 || t >= 1 - 1e-6) continue;
        if (SO.len(SO.sub(SO.add(A, SO.mul(ab, t)), s.p)) < 1e-4 * (1 + SO.len(ab))) return SO.splitEdge(m, a, b, s.p);
      }
    }
    m.v.push(s.p.slice()); return m.v.length - 1;
  }
  function penFinish(kindOf) {
    const d = sk.draw, m = massById(d.id); sk.draw = null;
    if (!m) { draw(); return; }
    before();
    let ok = false;
    if (kindOf === 'rect') {
      const R = penRect(d, m);
      if (SO.len(SO.sub(R[1], R[0])) > 0.5 * perFt() && SO.len(SO.sub(R[3], R[0])) > 0.5 * perFt() && R.every(p => SO.inFace(m, d.fi, p))) { freeze(m); const nf = SO.innerFace(m, d.fi, R); sk.hov = { id: m.id, t: 'f', fi: nf }; ok = true; }
      else flash('Draw the rectangle inside the face — or click from edge to edge to cut across it.');
    } else if (kindOf === 'loop') {
      if (d.pts.length >= 3 && d.pts.every(s => SO.inFace(m, d.fi, s.p))) { freeze(m); SO.innerFace(m, d.fi, d.pts.map(s => s.p)); ok = true; }
    } else {   // split: first and last on the outline
      freeze(m);
      const idx = d.pts.map(s => vertexFor(m, d.fi, s));
      ok = SO.splitFace(m, d.fi, idx) >= 0;
      if (!ok) flash('Couldn’t split that face — start and end on its outer edges.');
    }
    if (ok) { sk.sel = { kind: 'mass', id: m.id }; changed(); } else { sk.undo.pop(); draw(); }
  }
  function flash(text) {
    const h = hintEl(); if (!h) return;
    h.textContent = text; h.classList.add('sk-warn');
    clearTimeout(sk.flashT); sk.flashT = setTimeout(() => { h.classList.remove('sk-warn'); h.textContent = hints()[sk.tool]; }, 3500);
  }

  // ---------------------------------------------------------------- push/pull, Ctrl-move, slope
  /** Distance along a solid-space direction from where the drag started, measured on screen. */
  function along(m, op, ev, dir) {
    const Lr = 10 * perFt(), s0 = P3(m, op.p0), s1 = P3(m, SO.add(op.p0, SO.mul(dir, Lr)));
    if (!s0 || !s1) return 0;
    const vx = s1[0] - s0[0], vy = s1[1] - s0[1], L2 = vx * vx + vy * vy;
    if (L2 < 9) return -(ev.sy - op.sy) / (sk.v3 ? 4 : ctx.affine(sk.site).scale) * (dir[2] >= 0 ? 1 : -1);   // looking straight along it
    return ((ev.sx - op.sx) * vx + (ev.sy - op.sy) * vy) / L2 * Lr;
  }
  function startOp(type, m, extra, ev) {
    sk.op = { type, id: m.id, orig: JSON.stringify({ v: m.v, f: m.f, prm: m.prm }), sx: ev.sx, sy: ev.sy, ...extra };
    sk.baseLock = { id: m.id, base: massBase(m) };
    sk.hov = null; card();
  }
  function resetOp(m) { const o = JSON.parse(sk.op.orig); m.v = o.v; m.f = o.f; if (o.prm) m.prm = o.prm; else delete m.prm; }
  function moveOp(ev) {
    const op = sk.op, m = massById(op.id); if (!m) return;
    resetOp(m);
    if (op.type === 'push' || (op.type === 'move' && op.el.t === 'f')) {
      const n = SO.faceNormal(m, op.fi);
      let d = along(m, op, ev, n);
      if (!ev.shift) {
        if (Math.abs(n[2]) > 0.9) { const z0 = op.p0[2], f = ftfN(m); d = (Math.round((z0 + d * n[2]) / f) * f - z0) * n[2]; }
        else d = Math.round(d / perFt()) * perFt();
      }
      op.d = d;
      if (op.type === 'push') SO.pushPull(m, op.fi, d, op.makeNew); else SO.moveVerts(m, SO.faceVerts(m, op.fi), SO.mul(n, d));
    } else if (op.type === 'move') {
      const ids = op.el.t === 'v' ? [op.el.i] : [op.el.a, op.el.b];
      let delta;
      if (ev.shift) { const dz = along(m, op, ev, [0, 0, 1]); delta = [0, 0, Math.round(dz / perFt()) * perFt()]; }
      else {
        const zo = zOut(m, op.p0[2]);
        const xy = sk.v3 ? ev.at(zo) : groundSnap(ev, null, { exclude: m.id });
        if (!xy) return;
        delta = [xy[0] - op.p0[0], xy[1] - op.p0[1], 0];
      }
      op.d = SO.len(delta);
      SO.moveVerts(m, ids, delta);
    } else if (op.type === 'slope') {
      const r = rayIn(m, ev), p = r && SO.rayFace(m, op.fi, r.o, r.d);
      if (!p) return;
      op.p1 = p;
      const dir = SO.sub(p, op.p0);
      if (SO.len(dir) > 2 * perFt()) SO.slopeFace(m, op.fi, dir, sk.pitch / 12);
    }
    freeze(m);
    dragged();
  }
  function endOp() {
    const op = sk.op; sk.op = null; sk.baseLock = null;
    const m = massById(op.id);
    if (!m) return;
    if (!op.moved) { resetOp(m); sk.undo.pop(); draw(); card(); return; }
    sk.lastOp = { ...op };
    if (op.type === 'push') { const inp = bar.querySelector('[data-fly="dist"]'); if (inp) inp.value = (op.d / kz()).toFixed(1); }
    sk.infos.delete(m.id);
    changed();
  }
  /** Re-apply the last push/pull (exact distance typed) or slope (new pitch). */
  function redoLast(type, d) {
    const op = sk.lastOp, m = op && massById(op.id);
    if (!m || op.type !== type) return;
    before();
    const o = JSON.parse(op.orig); m.v = o.v; m.f = o.f; freeze(m);
    if (type === 'push') { SO.pushPull(m, op.fi, d, op.makeNew); op.d = d; }
    else if (op.p1) SO.slopeFace(m, op.fi, SO.sub(op.p1, op.p0), sk.pitch / 12);
    changed();
  }
  function drawOp(g) {
    const op = sk.op; if (!op) return;
    const m = massById(op.id); if (!m) return;
    if (op.type === 'push' || op.type === 'move') {
      if (op.type === 'push' || op.el.t === 'f') { if (facePath(g, m, op.fi)) { g.strokeStyle = ORANGE; g.lineWidth = 2.5; g.stroke(); } }
      tag(g, [op.sx, op.sy], `${op.d < 0 ? '−' : ''}${fmtLen(Math.abs(op.d || 0))}${op.type === 'push' && Math.abs(SO.faceNormal(m, op.fi)[2]) > 0.9 ? ` · ${info(m).floors} fl` : ''}`);
    } else if (op.type === 'slope' && op.p1) {
      const a = P3(m, op.p0), b = P3(m, op.p1); if (!a || !b) return;
      g.strokeStyle = ORANGE; g.lineWidth = 3; g.beginPath(); g.moveTo(...a); g.lineTo(...b); g.stroke();
      const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
      g.beginPath(); g.moveTo(...b); g.lineTo(b[0] - 12 * Math.cos(ang - 0.4), b[1] - 12 * Math.sin(ang - 0.4)); g.lineTo(b[0] - 12 * Math.cos(ang + 0.4), b[1] - 12 * Math.sin(ang + 0.4)); g.closePath(); g.fillStyle = ORANGE; g.fill();
      tag(g, b, `${sk.pitch} : 12`);
    }
  }

  // ---------------------------------------------------------------- diagram annotations
  const diagramOn = () => sk.set === 'diagram' && sk.active;
  const noteColor = n => (n.color?.startsWith?.('#') ? n.color : colorOf(scheme(), n.color || 'arrow'));
  /** Colour of a scheme key or a hex. */
  const resolveC = c => (c?.startsWith?.('#') ? c : colorOf(scheme(), c));
  const dgs = () => sk.model.dg || DG0;
  /** Diagram default for a paint key's category (before any paint). */
  function defaultFor(key) {
    const [k, id] = [key.slice(0, 1), key.slice(2)];
    if (k === 'm') { const m = massById(id); return dgs().mass && dgs().mass !== 'use' ? resolveC(dgs().mass) : colorOf(scheme(), m?.use); }
    if (k === 'b') return dgs().bldg;
    if (k === 't') return dgs().tree;
    return colorOf(scheme(), k === 'i' ? 'green' : 'lot');
  }
  /** Colour for a painted item in the diagram (its paint, else the category default); plain scheme colours elsewhere. */
  const paintOr = key => { const p = sk.model.paint?.[key]; return p ? resolveC(p) : defaultFor(key); };
  function massColor(m) { return diagramOn() ? paintOr(`m:${m.id}`) : colorOf(scheme(), m.use); }
  function siteColor(key, kind) { return diagramOn() && sk.model.paint?.[key] ? resolveC(sk.model.paint[key]) : colorOf(scheme(), kind); }
  /** How a note's points map to uniform space and back (see notes.js). */
  function noteEnv(n) {
    const e = ex3(), k = kz();
    const D = u => [u[0] * k, u[1] * k, u[2] / e];
    const drape = u => [u[0], u[1], (zGround([u[0] * k, u[1] * k]) + 0.25 * outPerFt()) * e];
    const base = { D, drape, ft: outPerFt(), step: 5 * perFt(), stepU: 5 * perFt() / k };
    if (n.on === 'mass') {
      const m = massById(n.mid); if (!m) return null;
      return { ...base, U: p => [p[0] / k, p[1] / k, zOut(m, p[2]) * e], N: n.n, ground: false };
    }
    return { ...base, U: p => [p[0] / k, p[1] / k, (zGround(p) + 0.25 * outPerFt()) * e], N: [0, 0, 1], ground: true };
  }
  function nGeom(n, flat = false) {
    const m = n.on === 'mass' ? massById(n.mid) : null;
    const key = JSON.stringify([n, ex3(), flat, m ? massBase(m) : 0, !!sk.v3]);
    const c = sk.ngeo.get(n.id);
    if (c && c.key === key) return c.G;
    const env = noteEnv(n);
    const G = env ? noteGeom(n, env, flat) : { outline: [], tris: [], edges: [] };
    sk.ngeo.set(n.id, { key, G });
    return G;
  }
  /** Display point of a note's point (for labels and handles). */
  function noteDisp(n, p) {
    if (n.on === 'mass') { const m = massById(n.mid); return m ? [p[0], p[1], zOut(m, p[2])] : null; }
    return [p[0], p[1], zGround(p) + 0.3];
  }
  const labelSize = n => [12, 15, 20][n.size ?? 1];
  function labelBox(g, n) {
    const d = noteDisp(n, n.pts[0]); const q = d && scr(d, d[2]); if (!q) return null;
    g.font = `700 ${labelSize(n)}px system-ui, sans-serif`;
    const w = g.measureText(n.text || 'Label').width + 12, h = labelSize(n) + 10;
    return { x: q[0] - w / 2, y: q[1] - h / 2, w, h, q };
  }
  function drawNotes(g) {
    for (const n of sk.model.notes) {
      if (n.type === 'label') continue;
      if (sk.v3) continue;                                  // 3D draws them as meshes
      const G = nGeom(n, true);
      const Q = G.outline.map(p => scr(p, p[2])); if (Q.length < 3 || Q.some(q => !q)) continue;
      g.beginPath(); Q.forEach((q, i) => (i ? g.lineTo(...q) : g.moveTo(...q))); g.closePath();
      g.fillStyle = noteColor(n); g.globalAlpha = n.type === 'region' ? (n.op ?? 0.55) : 1; g.fill(); g.globalAlpha = 1;
      if (n.stand) { g.setLineDash([5, 4]); g.strokeStyle = '#111827'; g.lineWidth = 1; g.stroke(); g.setLineDash([]); }
    }
    for (const n of sk.model.notes) {
      if (n.type !== 'label') continue;
      const B = labelBox(g, n); if (!B) continue;
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.lineWidth = 4; g.strokeStyle = 'rgba(255,255,255,0.92)'; g.strokeText(n.text || 'Label', B.q[0], B.q[1]);
      g.fillStyle = noteColor(n); g.fillText(n.text || 'Label', B.q[0], B.q[1]);
    }
  }
  /** Screen outline / box of a note, for picking and the selection outline. */
  function noteScreen(n, g) {
    if (n.type === 'label') { const B = labelBox(g || canvas.getContext('2d'), n); return B ? [[B.x, B.y], [B.x + B.w, B.y], [B.x + B.w, B.y + B.h], [B.x, B.y + B.h]] : null; }
    const G = nGeom(n, !sk.v3), Q = G.outline.map(p => scr(p, p[2]));
    return Q.length >= 3 && Q.every(Boolean) ? Q : null;
  }
  function hitNote(ev) {
    const o = findSel();
    if (o && sk.sel.kind === 'note') for (let i = 0; i < o.pts.length; i++) { const d = noteDisp(o, o.pts[i]), q = d && scr(d, d[2]); if (q && Math.hypot(q[0] - ev.sx, q[1] - ev.sy) < 8) return { id: o.id, vi: i }; }
    for (let i = sk.model.notes.length - 1; i >= 0; i--) { const n = sk.model.notes[i], Q = noteScreen(n); if (Q && inPoly(Q, ev.sx, ev.sy)) return { id: n.id }; }
    return null;
  }
  function drawNoteSel(g) {
    const o = findSel(); if (!o || sk.sel.kind !== 'note') return;
    const Q = noteScreen(o, g);
    if (Q) { g.beginPath(); Q.forEach((q, i) => (i ? g.lineTo(...q) : g.moveTo(...q))); g.closePath(); g.strokeStyle = ORANGE; g.lineWidth = 2; g.setLineDash([5, 3]); g.stroke(); g.setLineDash([]); }
    for (const p of o.pts) { const d = noteDisp(o, p), q = d && scr(d, d[2]); if (!q) continue; g.beginPath(); g.rect(q[0] - 4, q[1] - 4, 8, 8); g.fillStyle = '#fff'; g.fill(); g.strokeStyle = ORANGE; g.lineWidth = 1.5; g.stroke(); }
  }
  /** Point on the drawing surface of a note in progress / being moved. */
  function notePoint(ev, sfc) {
    if (sfc.on === 'ground') {
      const d = sk.draw;
      if (!d?.note) return ev.xy;
      return groundSnap(ev, d.pts?.at(-1) || (d.rect ? d.a : null), { kind: 'note', own: d.pts });
    }
    const m = massById(sfc.mid); if (!m) return null;
    const r = rayIn(m, ev); if (!r) return null;
    const den = SO.dot(sfc.n, r.d); if (Math.abs(den) < 1e-9) return null;
    const t = SO.dot(sfc.n, SO.sub(sfc.p0, r.o)) / den;
    return t > 0 ? SO.add(r.o, SO.mul(r.d, t)) : null;
  }
  function noteSurface(ev) {
    const f = pickFace(ev);
    if (f) { const m = massById(f.id); return { on: 'mass', mid: f.id, n: SO.faceNormal(m, f.fi), p0: f.p, p: f.p }; }
    const xy = groundSnap(ev, null, { kind: 'note' }); return xy ? { on: 'ground', p: xy } : null;
  }
  function noteRect(d) {
    if (d.on === 'ground') return rectPts(d.a, d.b);
    const n = d.n, u = SO.unit(Math.abs(n[2]) > 0.9 ? [1, 0, 0] : SO.cross([0, 0, 1], n)), v = SO.cross(n, u);
    const dd = SO.sub(d.b, d.a), du = SO.dot(dd, u), dv = SO.dot(dd, v);
    return [d.a, SO.add(d.a, SO.mul(u, du)), SO.add(SO.add(d.a, SO.mul(u, du)), SO.mul(v, dv)), SO.add(d.a, SO.mul(v, dv))];
  }
  function drawNoteDraft(g) {
    const d = sk.draw; if (!d?.note || (!d.rect && !d.pts)) return;
    const P = d.rect ? (d.type === 'region' ? noteRect(d) : [d.a, d.b]) : [...d.pts, ...(d.hover ? [d.hover] : [])];
    if (P.length < 2) return;
    const tmp = { id: '_draft', type: d.type, on: d.on, mid: d.mid, n: d.n, pts: P, color: sk.style.color, w: WIDTHS[d.type]?.[sk.style.size], stand: false, curve: sk.style.curve };
    sk.ngeo.delete('_draft');
    const G = nGeom(tmp, true), Q = G.outline.map(p => scr(p, p[2]));
    if (Q.length >= 3 && Q.every(Boolean)) { g.beginPath(); Q.forEach((q, i) => (i ? g.lineTo(...q) : g.moveTo(...q))); g.closePath(); g.fillStyle = noteColor(tmp); g.globalAlpha = 0.6; g.fill(); g.globalAlpha = 1; g.strokeStyle = ORANGE; g.lineWidth = 1.5; g.setLineDash([5, 3]); g.stroke(); g.setLineDash([]); }
  }
  function finishNote(pts) {
    const d = sk.draw; sk.draw = null;
    if (!d) return;
    if (pts.length < (d.type === 'region' ? 3 : d.type === 'label' ? 1 : 2)) { draw(); return; }
    before();
    const o = { id: uid(), type: d.type, on: d.on, pts, color: sk.style.color, size: sk.style.size, stand: d.type === 'label' ? false : sk.style.stand, curve: sk.style.curve };
    if (d.on === 'mass') { o.mid = d.mid; o.n = d.n; }
    if (WIDTHS[d.type]) o.w = WIDTHS[d.type][sk.style.size];
    if (d.type === 'region') { o.op = 0.55; o.h = 30; }
    if (d.type === 'line') o.h = 20;
    if (d.type === 'label') o.text = 'Label';
    sk.model.notes.push(o);
    sk.sel = { kind: 'note', id: o.id };
    changed();
    if (d.type === 'label') setTimeout(() => { const t = cardEl.querySelector('[data-k="text"]'); if (t) { t.focus(); t.select(); } }, 0);
  }
  /** What the paint bucket would paint under the cursor. */
  function paintTarget(ev) {
    const hn = hitNote(ev);
    if (hn && hn.vi == null) return { note: sk.model.notes.find(n => n.id === hn.id) };
    if (sk.v3) {
      const h = sk.v3.pickPaint(ev.sx, ev.sy);
      if (h?.kind === 'mass') return { key: `m:${h.id}` };
      if (h?.kind === 'bldg') return { key: `b:${h.key}` };
      if (h?.kind === 'tree') return { key: `t:${ctx.treeKey(h.tree)}` };
    }
    const xy = ev.xy; if (!xy) return null;
    if (!sk.v3) { const ms = sk.model.masses.slice().sort((a, b) => massTop(b) - massTop(a)); for (const m of ms) if (info(m).top(...xy)) return { key: `m:${m.id}` }; }
    const tree = !sk.v3 && ctx.pickContext?.(xy, 'tree'); if (tree) return { key: `t:${tree}` };
    for (const i of sk.model.islands) if (inPoly(islandShape(i.pts, i.r), ...xy)) return { key: `i:${i.id}` };
    for (const d of sk.model.drives) for (let i = 0; i < d.pts.length - 1; i++) if (distSeg(xy, d.pts[i], d.pts[i + 1]) < (d.w || 24) * perFt() / 2) return { key: `d:${d.id}` };
    for (const l of sk.model.lots) if (inPoly(l.pts, ...xy)) return { key: `l:${l.id}` };
    const b = !sk.v3 && ctx.pickContext?.(xy, 'bldg'); if (b) return { key: `b:${b}` };
    return null;
  }
  function paintAt(ev) {
    const T = paintTarget(ev);
    if (!T) { flash('Nothing to paint here — click a building, tree, block, parking area or annotation.'); return; }
    if (ev.alt) {                                          // eyedropper
      const c = T.note ? T.note.color : (sk.model.paint[T.key] || defaultFor(T.key));
      sk.sel = null; setStyle({ color: c }); flash('Picked up that colour.'); return;
    }
    before();
    if (T.note) T.note.color = ev.shift ? ({ region: 'region', label: 'label' }[T.note.type] || 'arrow') : sk.style.color;
    else if (ev.shift) delete sk.model.paint[T.key];
    else sk.model.paint[T.key] = sk.style.color;
    changed();
  }
  function noteDown(ev) {
    const t = sk.tool;
    if (t === 'paint') { paintAt(ev); return true; }
    if (t === 'select') {
      const h = hitNote(ev);
      if (!h) { sk.clickEmpty = [ev.sx, ev.sy]; sk.sel = null; draw(); card(); return false; }
      const o = sk.model.notes.find(n => n.id === h.id);
      if (ev.alt && h.vi == null) { before(); const c = JSON.parse(JSON.stringify(o)); c.id = uid(); sk.model.notes.push(c); sk.sel = { kind: 'note', id: c.id }; }
      else sk.sel = { kind: 'note', id: o.id };
      const tgt = findSel();
      const sfc = { on: tgt.on, mid: tgt.mid, n: tgt.n, p0: tgt.pts[0] };
      const start = notePoint(ev, sfc); if (!start) return true;
      sk.drag = { note: true, id: tgt.id, vi: h.vi, sfc, start, orig: JSON.stringify(tgt.pts), pushed: ev.alt };
      draw(); card();
      return true;
    }
    if (sk.draw?.note && sk.draw.pts) {                    // clicking out points
      const p = notePoint(ev, sk.draw); if (!p) return true;
      const d = sk.draw;
      if (d.type === 'region' && d.pts.length >= 3) { const a = noteDisp(d, d.pts[0]), q = a && scr(a, a[2]); if (q && Math.hypot(q[0] - ev.sx, q[1] - ev.sy) < 10) { finishNote(d.pts.slice()); return true; } }
      d.pts.push(p); draw(); return true;
    }
    const sfc = noteSurface(ev); if (!sfc) return true;
    if (t === 'label') { sk.draw = { note: true, type: 'label', ...sfc }; finishNote([sfc.p]); return true; }
    sk.draw = { note: true, type: t, ...sfc, a: sfc.p, b: sfc.p, cp: [ev.sx, ev.sy], pending: true };
    card();
    return true;
  }
  function noteMove(ev) {
    const d = sk.draw;
    if (!d && !sk.drag && sk.tool !== 'select') { const had = !!sk.snap; if (!pickFace(ev)) groundSnap(ev, null, { kind: 'note' }); else sk.snap = null; if (had || sk.snap) draw(); return; }
    if (d?.note) {
      const p = notePoint(ev, d); if (!p) return;
      if (d.pending && Math.hypot(ev.sx - d.cp[0], ev.sy - d.cp[1]) > 6) { d.pending = false; d.rect = true; }
      if (d.rect) d.b = p; else if (d.pts) d.hover = p;
      draw(); return;
    }
    const g = sk.drag; if (!g?.note) return;
    const o = sk.model.notes.find(n => n.id === g.id); if (!o) return;
    const cur = notePoint(ev, g.sfc); if (!cur) return;
    if (!g.pushed) { before(); g.pushed = true; }
    const dl = cur.map((v, i) => v - g.start[i]), P = JSON.parse(g.orig);
    o.pts = P.map((p, i) => (g.vi == null || g.vi === i ? p.map((v, j) => v + (dl[j] || 0)) : p));
    g.moved = true; dragged();
  }
  function noteUp(ev) {
    if (sk.clickEmpty) sk.clickEmpty = null;
    const d = sk.draw;
    if (d?.note) {
      if (d.rect) { finishNote(d.type === 'region' ? noteRect(d) : [d.a, d.b]); return; }
      if (d.pending) { sk.draw = { ...d, pending: false, pts: [d.a] }; draw(); }
      return;
    }
    if (sk.drag?.note) { const moved = sk.drag.moved; sk.drag = null; if (moved) changed(true); else card(); }
    void ev;
  }
  function finishNoteOutline() {
    const d = sk.draw; if (!d?.note || !d.pts) return;
    const P = d.pts.slice();
    while (P.length > 2 && P.at(-1).every((v, i) => Math.abs(v - P.at(-2)[i]) < 1e-6)) P.pop();
    finishNote(P);
  }
  /** Annotations as 3D meshes. */
  function notes3d() {
    if (sk.set !== 'diagram' || !sk.active) return [];
    return sk.model.notes.filter(n => n.type !== 'label').map(n => {
      const G = nGeom(n);
      return { tris: G.tris.flat(), edges: n.stand ? G.edges.flat(2) : [], color: noteColor(n), opacity: n.type === 'region' ? (n.op ?? 0.55) : 1, edgeColor: '#1f2937' };
    });
  }

  // ---------------------------------------------------------------- pointer (shared by the map and the 3D view)
  /** Pointer down; true when the sketch took it (so the map / 3D camera shouldn't). */
  function down(ev) {
    if (!sk.active || !sk.site) return false;
    if (sk.set === 'diagram') return noteDown(ev);
    const t = sk.tool;
    // Face tools.
    if (t === 'push' || t === 'slope' || (t === 'select' && ev.ctrl)) {
      const el = t === 'select' ? pickElement(ev) : (() => { const f = pickFace(ev); return f && { ...f, t: 'f' }; })();
      if (!el) return t !== 'select';
      const m = massById(el.id);
      before();
      const p0 = el.t === 'f' ? el.p : el.t === 'v' ? m.v[el.i].slice() : SO.add(m.v[el.a], SO.mul(SO.sub(m.v[el.b], m.v[el.a]), 0.5));
      startOp(t === 'select' ? 'move' : t, m, { fi: el.fi, el, p0, makeNew: t === 'push' && ev.ctrl, d: 0 }, ev);
      sk.sel = { kind: 'mass', id: m.id };
      return true;
    }
    if (t === 'pen') {
      if (sk.draw?.face) {                       // clicking out a line on a face
        const s = penFacePoint(ev); if (!s) return true;
        const d = sk.draw, first = d.pts[0];
        if (!first.t && d.pts.length >= 3) { const q0 = P3(massById(d.id), first.p), q = [ev.sx, ev.sy]; if (q0 && Math.hypot(q0[0] - q[0], q0[1] - q[1]) < 10) { penFinish('loop'); return true; } }
        d.pts.push(s);
        if (first.t && s.t && first.outer && s.outer && d.pts.length >= 2) penFinish('split');
        else draw();
        return true;
      }
      if (!sk.draw) {
        const f = pickFace(ev);
        if (f) {
          const m = massById(f.id), s = snapOnFace(m, f.fi, f.p);
          sk.draw = { face: true, id: f.id, fi: f.fi, pts: [s], b: s, cp: [ev.sx, ev.sy], pending: true };
          sk.hov = null; card(); draw();
          return true;
        }
      }
    }
    if (t !== 'select') {
      const kind = t === 'pen' ? 'sheet' : t;
      if (sk.draw?.pts && !sk.draw.face) {      // outline in progress
        const q = scr(sk.draw.pts[0], sk.v3 ? zGround(sk.draw.pts[0]) + 0.3 : undefined);
        if (sk.draw.kind !== 'drive' && sk.draw.pts.length >= 3 && q && Math.hypot(q[0] - ev.sx, q[1] - ev.sy) < 10) { finishDraw(sk.draw.pts); return true; }
        const xy = groundSnap(ev, sk.draw.pts.at(-1), { own: sk.draw.pts }); if (!xy) return true;
        sk.draw.pts.push(xy);
        draw(); return true;
      }
      const xy = groundSnap(ev, null); if (!xy) return true;
      sk.draw = { kind, shape: t === 'mass' ? sk.shape : 'box', a: xy, b: xy, cp: [ev.sx, ev.sy], rect: false, pending: true, frame: kind === 'drive' ? 0 : frameNear(xy) };
      card();
      return true;
    }
    const h = hit(ev);
    if (!h) { sk.clickEmpty = [ev.sx, ev.sy]; return false; }
    // Shift+click a second block: the two can be joined, intersected or cut (see the card).
    if (ev.shift && !h.h && h.kind === 'mass' && sk.sel?.kind === 'mass' && h.id !== sk.sel.id) {
      sk.sel2 = sk.sel2?.id === h.id ? null : { id: h.id };
      cardEl.dataset.sig = ''; draw(); card(); return true;
    }
    if (!ev.shift) sk.sel2 = null;
    const src = list(h.kind).find(o => o.id === h.id);
    if (ev.alt && h.h?.t === 'v') {                         // Alt+click a corner: remove it
      const P = outline(src);
      if (P.length > (closed(h.kind) ? 3 : 2)) { before(); P.splice(h.h.i, 1); if (src.prm) regen(src); changed(); }
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
    // A block takes the diagram annotations drawn on it.
    const carry = h.kind === 'lot' && (!h.h || h.h.t === 'r') ? [...sk.model.islands, ...sk.model.drives].filter(q => inPoly(src.pts, ...centroid(q.pts))).map(q => ({ q, orig: JSON.parse(JSON.stringify(q.pts)) }))
      : h.kind === 'mass' && !pushed && (!h.h || h.h.t === 'r' || h.h.t === 's') ? sk.model.notes.filter(n => n.mid === src.id).map(q => ({ q, orig: JSON.parse(JSON.stringify(q.pts)), n: q.n?.slice() })) : [];
    sk.drag = { kind: target.kind, id: target.id, h: h.h, z: h.z, start, orig: JSON.stringify(obj), angle0: obj.angle, carry, pushed, sx: ev.sx, sy: ev.sy };
    if (target.kind === 'mass') sk.baseLock = null;
    sk.sel = { kind: target.kind, id: target.id };
    draw(); panel(); card();
    return true;
  }
  /** Apply fn to every XY of an object (outline, solid vertices, preset outline). */
  function mapObj(o, fn) {
    if (o.pts) o.pts = o.pts.map(fn);
    if (o.v) SO.mapXY(o, fn);
    if (o.prm) o.prm.pts = o.prm.pts.map(fn);
  }
  function move(ev) {
    if (!sk.active || !sk.site) return;
    if (sk.set === 'diagram') { noteMove(ev); return; }
    if (sk.op) { sk.op.moved = sk.op.moved || Math.hypot(ev.sx - sk.op.sx, ev.sy - sk.op.sy) > 3; if (sk.op.moved) moveOp(ev); return; }
    const d = sk.draw;
    if (d?.face) {
      const s = penFacePoint(ev); if (!s) return;
      if (d.pending && Math.hypot(ev.sx - d.cp[0], ev.sy - d.cp[1]) > 6) { d.pending = false; d.rect = true; }
      if (d.rect) d.b = s; else if (!d.pending) d.hover = s;
      draw(); return;
    }
    if (d && d.pending !== undefined && !d.pts) {
      if (d.pending && Math.hypot(ev.sx - d.cp[0], ev.sy - d.cp[1]) > 6) { d.pending = false; d.rect = true; }
      if (d.rect) {
        // A drive aisle is a line (pull / Shift lock from its start); shapes snap their far corner, Shift = square.
        const b = d.kind === 'drive' ? groundSnap(ev, d.a, { own: [d.a] }) : groundSnap({ ...ev, shift: false }, null);
        if (!b) return;
        d.b = b; d.square = ev.shift && d.kind !== 'drive'; draw();
      }
      return;
    }
    if (d?.pts) { const xy = groundSnap(ev, d.pts.at(-1), { own: d.pts }); if (xy) { d.hover = xy; draw(); } return; }
    if (!sk.drag) {                                   // hover feedback for the face tools / Ctrl-move
      const want = sk.tool === 'push' || sk.tool === 'slope' || sk.tool === 'pen' || (sk.tool === 'select' && ev.ctrl);
      const h = want ? (sk.tool === 'select' ? pickElement(ev) : (() => { const f = pickFace(ev); return f && { id: f.id, t: 'f', fi: f.fi }; })()) : null;
      const key = h ? JSON.stringify([h.id, h.t, h.fi, h.i, h.a, h.b]) : '';
      // Before the first click, show what the start point would snap to.
      const pre = ['mass', 'lot', 'island', 'drive'].includes(sk.tool) || (sk.tool === 'pen' && !h);
      const had = !!sk.snap;
      if (pre) groundSnap(ev, null); else sk.snap = null;
      if (key !== (sk.hovKey || '') || pre || had) { sk.hov = h; sk.hovKey = key; draw(); }
      return;
    }
    const g = sk.drag, o = list(g.kind).find(q => q.id === g.id);
    if (!o) return;
    const cur = ev.at(g.z); if (!cur) return;
    if (!g.pushed) { before(); g.pushed = true; }
    const dx = cur[0] - g.start[0], dy = cur[1] - g.start[1];
    const orig = JSON.parse(g.orig);
    for (const k of ['pts', 'v', 'f', 'prm', 'angle']) if (k in orig) o[k] = orig[k];
    const P = outline(o), n = P.length, t = g.h?.t;
    if (t === 'm' && !g.inserted) {
      g.inserted = true; g.h = { t: 'v', i: g.h.i + 1 };
      P.splice(g.h.i, 0, g.start.slice());
      if (o.prm) regen(o);
      g.orig = JSON.stringify(o); return move(ev);
    }
    if (t === 'v') {
      const i = g.h.i;
      let p = [P[i][0] + dx, P[i][1] + dy];
      const nb = P[(i - 1 + n) % n];
      if (!sk.v3 || g.kind !== 'mass') p = groundSnap({ ...ev, xy: p }, closed(g.kind) || i > 0 ? nb : P[1], { exclude: o.id }) || p;
      else if (ev.shift) p = ortho(nb, p);
      // A rectangle stays a rectangle when a corner is dragged (its two neighbours follow), whatever its angle.
      if (n === 4 && closed(g.kind) && isRect(P)) {
        const a = (i + 1) % 4, c = (i + 3) % 4, opp = P[(i + 2) % 4];
        const ua = SO.unit([P[a][0] - opp[0], P[a][1] - opp[1], 0]), uc = SO.unit([P[c][0] - opp[0], P[c][1] - opp[1], 0]), w = [p[0] - opp[0], p[1] - opp[1], 0];
        const ka = SO.dot(w, ua), kc = SO.dot(w, uc);
        P[i] = [opp[0] + ua[0] * ka + uc[0] * kc, opp[1] + ua[1] * ka + uc[1] * kc]; P[a] = [opp[0] + ua[0] * ka, opp[1] + ua[1] * ka]; P[c] = [opp[0] + uc[0] * kc, opp[1] + uc[1] * kc];
      } else P[i] = p;
      if (o.prm) regen(o);
    } else if (t === 'r' || t === 's') {
      const c = g.h.c;
      if (t === 'r') {
        let a = Math.atan2(cur[1] - c[1], cur[0] - c[0]) - Math.atan2(g.start[1] - c[1], g.start[0] - c[0]);
        if (ev.shift) a = Math.round(a / (Math.PI / 12)) * Math.PI / 12;
        const cs = Math.cos(a), sn = Math.sin(a), rot = ([x, y]) => [c[0] + (x - c[0]) * cs - (y - c[1]) * sn, c[1] + (x - c[0]) * sn + (y - c[1]) * cs];
        mapObj(o, rot);
        if (g.kind === 'lot' && g.angle0 != null) o.angle = g.angle0 + a;
        carryAll(g, rot);
      } else {
        const f = Math.max(0.05, Math.hypot(cur[0] - c[0], cur[1] - c[1]) / Math.max(1e-9, Math.hypot(g.start[0] - c[0], g.start[1] - c[1])));
        const sc = ([x, y]) => [c[0] + (x - c[0]) * f, c[1] + (y - c[1]) * f];
        mapObj(o, sc); carryAll(g, sc);
      }
    } else {
      // Moving: the moved outline's nearest corner snaps to a corner of something else.
      let mx = dx, my = dy;
      if (!sk.v3 || g.kind !== 'mass') {
        const S = snapCands(g.kind, o.id), sn = ev.alt ? null : snapMove(P.map(([x, y]) => [x + dx, y + dy]), S.C, q => scr(q));
        if (sn) { mx += sn.dx; my += sn.dy; sk.snap = { p: sn.p, t: 'corner', label: sn.label, guides: [] }; } else sk.snap = null;
      }
      mapObj(o, ([x, y]) => [x + mx, y + my]);
      carryAll(g, ([x, y]) => [x + mx, y + my]);
    }
    g.moved = true;
    dragged();
  }
  /** Move what an object carries (lot islands / aisles, block annotations) with it; heights and normals follow. */
  function carryAll(g, fn) {
    for (const cq of g.carry) {
      cq.q.pts = cq.orig.map(p => [...fn(p), ...p.slice(2)]);
      if (cq.n) { const a = fn([0, 0]), b = fn([cq.n[0], cq.n[1]]); const hx = b[0] - a[0], hy = b[1] - a[1], l = Math.hypot(hx, hy), hl = Math.hypot(cq.n[0], cq.n[1]); cq.q.n = l > 1e-12 ? [hx / l * hl, hy / l * hl, cq.n[2]] : cq.n.slice(); }
    }
  }
  /** Four corners, all square (any rotation). */
  const isRect = P => P.length === 4 && [0, 1, 2, 3].every(i => { const a = P[(i + 3) % 4], b = P[i], c = P[(i + 1) % 4]; const u = [a[0] - b[0], a[1] - b[1]], v = [c[0] - b[0], c[1] - b[1]]; return Math.abs(u[0] * v[0] + u[1] * v[1]) < 1e-6 * (Math.hypot(...u) * Math.hypot(...v) + 1e-12); });
  function up(ev) {
    if (!sk.active) return;
    sk.snap = null;
    if (sk.set === 'diagram') { noteUp(ev); return; }
    if (sk.op) { endOp(); return; }
    if (sk.clickEmpty) {
      const [x, y] = sk.clickEmpty; sk.clickEmpty = null;
      if (ev && Math.hypot(ev.sx - x, ev.sy - y) < 5) { sk.sel = null; draw(); panel(); card(); }
    }
    const d = sk.draw;
    if (d?.face) {
      if (d.rect) { penFinish('rect'); return; }
      if (d.pending) { d.pending = false; draw(); }       // a click: carry on clicking points
      return;
    }
    if (d && !d.pts) {
      if (d.rect) { finishDraw(drawPts()); return; }
      sk.draw = { kind: d.kind, shape: d.shape, pts: [d.a] }; draw(); return;   // a click without dragging starts an outline
    }
    if (sk.drag) { const moved = sk.drag.moved; sk.drag = null; if (moved) changed(true); else card(); }
  }
  function finishOutline() {
    if (sk.set === 'diagram') { finishNoteOutline(); return; }
    const d = sk.draw;
    if (d?.face) { if (d.pts.length >= 3 && !d.pts[0].t) penFinish('loop'); return; }
    if (!d?.pts) return;
    const P = d.pts.slice();
    if (P.length > 2 && Math.hypot(P.at(-1)[0] - P.at(-2)[0], P.at(-1)[1] - P.at(-2)[1]) < 1e-6) P.pop();
    if (P.length >= (d.kind === 'drive' ? 2 : 3)) finishDraw(P);
  }

  // Map events.
  const mapEv = e => {
    const xy = ctx.toNative(e.latlng), oe = e.originalEvent;
    return { sx: e.containerPoint.x, sy: e.containerPoint.y, xy, at: () => xy, ray: () => [[xy[0], xy[1], 1e5], [xy[0], xy[1], 0]], shift: oe.shiftKey, alt: oe.altKey, ctrl: oe.ctrlKey || oe.metaKey };
  };
  map.on('mousedown', e => { if (sk.v3 || !sk.site || !sk.active || e.originalEvent.button !== 0) return; if (down(mapEv(e))) map.dragging.disable(); });
  map.on('mousemove', e => { if (!sk.v3 && sk.site && sk.active) move(mapEv(e)); });
  map.on('mouseup', e => { if (!sk.v3 && sk.active && sk.site) { map.dragging.enable(); up(mapEv(e)); } });
  document.addEventListener('mouseup', e => {
    if (sk.v3 || !(sk.drag || sk.op || (sk.draw && !sk.draw.pts))) return;
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
        at: z => sk.v3?.pickPlane(sx, sy, z) || null, ray: () => sk.v3?.rayPoints(sx, sy) || null, shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey || e.metaKey };
    };
    stage.addEventListener('pointerdown', e => {
      if (sk.v3 !== v3 || !sk.active || e.button !== 0) return;
      if (down(ev3(e))) { e.stopPropagation(); e.preventDefault(); sk.p3 = true; }
    }, true);
    window.addEventListener('pointermove', e => {
      if (sk.v3 !== v3 || !sk.active) return;
      if (e.buttons & 6) return;                       // orbiting / panning with the other buttons
      if (sk.drag || sk.op || e.target === stage || stage.contains(e.target)) move(ev3(e));
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
    sk.draw = null; sk.drag = null; sk.op = null; sk.hov = null; sk.baseLock = null;
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
  document.addEventListener('keyup', e => { if (sk.active && (e.key === 'Control' || e.key === 'Meta') && sk.tool === 'select' && sk.hov) { sk.hov = null; sk.hovKey = ''; draw(); } });
  function onKey(e) {
    if (typing(e)) { if (e.key === 'Escape' || e.key === 'Enter') e.target.blur(); return false; }
    const k = e.key;
    if (k === 'Escape') {
      if (sk.op) { const m = massById(sk.op.id); if (m) resetOp(m); sk.op = null; sk.baseLock = null; sk.undo.pop(); changed(true); }
      else if (sk.draw) { sk.draw = null; draw(); } else if (sk.tool !== 'select') setTool('select'); else { sk.sel = null; draw(); panel(); card(); }
      return true;
    }
    if (k === 'Enter' && sk.draw?.pts) { e.preventDefault(); finishOutline(); return true; }
    if (k === 'Backspace' && sk.draw?.pts) { e.preventDefault(); sk.draw.pts.pop(); if (!sk.draw.pts.length) sk.draw = null; draw(); return true; }
    if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); return true; }
    if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'y') { e.preventDefault(); doRedo(); return true; }
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    const t = tools().find(x => x.key.toLowerCase() === k.toLowerCase());
    if (t) { e.preventDefault(); setTool(t.id); return true; }
    const s = sk.set === 'sketch' && SHAPES.find(x => x.key === k);
    if (s) { e.preventDefault(); setShape(s.id); return true; }
    const o = findSel();
    if (!o) return false;
    const kind = sk.sel.kind;
    if (k === 'Delete' || k === 'Backspace') { e.preventDefault(); removeSel(); return true; }
    if (kind === 'note' && k.toLowerCase() === 'f' && o.type !== 'label') { e.preventDefault(); before(); o.stand = !o.stand; cardEl.dataset.sig = ''; changed(true); return true; }
    if (kind === 'mass' && (k === 'ArrowUp' || k === 'ArrowDown')) { e.preventDefault(); before(); if (floorsBy(o, k === 'ArrowUp' ? 1 : -1)) { remember(o); changed(true); } else sk.undo.pop(); return true; }
    if (kind === 'mass' && k.toLowerCase() === 'r' && o.prm) {
      e.preventDefault(); before();
      const i = ROOFS.findIndex(r => r[0] === (o.prm.roof?.type || 'flat'));
      o.prm.roof = { pitch: o.prm.roof?.pitch || 6, ...o.prm.roof, type: ROOFS[(i + 1) % ROOFS.length][0] }; regen(o); remember(o); changed(true); return true;
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
    if ($('dg-empty')) $('dg-empty').hidden = has;
    if (!has) return;
    const st = stats();
    const useRows = [...st.byUse].sort((a, b) => b[1] - a[1]).map(([u, sf]) => {
      const def = scheme().uses.find(x => x.key === u);
      return `<div class="sk-srow"><i style="background:${colorOf(scheme(), u)}"></i><span>${escapeHtml(def?.label || u)}</span><b>${fmtArea(sf)}</b></div>`;
    }).join('');
    const diff = st.prov - st.req;
    $('sk-stats').innerHTML = `
      <div class="sk-big"><div><small>Floor area</small><b>${fmtArea(st.gfa)}</b></div><div><small>Blocks</small><b>${sk.model.masses.length}</b></div></div>
      ${useRows || '<p class="hint">Drag a block with Shapes (M), or draw on the ground (L) and pull it up (U).</p>'}
      <div class="sk-big sk-park ${st.req ? (diff >= 0 ? 'ok' : 'short') : ''}">
        <div><small>Parking provided</small><b>${st.prov}</b></div><div><small>Required</small><b>${st.req || '—'}</b></div>
        <div><small>${diff >= 0 ? 'Surplus' : 'Short'}</small><b>${st.req ? Math.abs(diff) : '—'}</b></div></div>
      <p class="hint">${st.acc} accessible provided (${st.accReq} required${st.van ? `, ${st.van} van` : ''})${st.short ? ` — <strong>${st.short} short: a row is too short for the accessible group</strong>` : ''}. Accessible counts per lot by the 2010 ADA Standards (Table 208.2, 208.2.4). Floors are counted every floor-to-floor height where at least half the floor has full headroom.</p>`;
    schemeUi(); ratiosUi(); listUi(); dgColorsUi();
  }
  /** Quick colour selectors for whole categories in the Diagram panel. */
  function dgColorsUi() {
    const el = $('dg-colors'); if (!el) return;
    const d = dgs(), np = Object.keys(sk.model.paint || {}).length;
    const chip = (k, c) => c === 'use'
      ? `<button type="button" class="dg-sw dg-use${d[k] === 'use' ? ' on' : ''}" data-dgk="${k}" data-dgc="use" title="By use (the scheme's colours)"></button>`
      : `<button type="button" class="dg-sw${d[k] === c ? ' on' : ''}" data-dgk="${k}" data-dgc="${c}" title="${c}" style="background:${c}"></button>`;
    const html = DG_ROWS.map(([k, label]) => `<div class="dg-crow"><span>${label}</span><div class="dg-sws">${DG_PRESETS[k].map(c => chip(k, c)).join('')}
        <label class="dg-sw dg-custom${d[k] !== 'use' && !DG_PRESETS[k].includes(d[k]) ? ' on' : ''}" title="Any colour"><input type="color" data-dgk="${k}" value="${d[k]?.startsWith?.('#') ? d[k] : '#e8913f'}"></label></div></div>`).join('')
      + `<div class="dg-crow dg-cfoot"><span>${np ? `${np} item${np === 1 ? '' : 's'} painted by hand` : 'Paint single items with the Paint tool (B).'}</span>${np ? '<button type="button" class="linkish" data-dgclear>Clear painted colours</button>' : ''}</div>`;
    if (el.dataset.html !== html) { el.innerHTML = html; el.dataset.html = html; }
  }
  function setDg(k, c) { if (dgs()[k] === c) return; before(); sk.model.dg = { ...dgs(), [k]: c }; changed(); }
  function listUi() {
    const el = $('sk-list'); if (!el) return;
    const rows = [
      ...sk.model.masses.map(m => ({ kind: 'mass', o: m, t: `${useLabel(m)} · ${info(m).sheet ? 'flat shape' : `${info(m).floors} fl · ${fmtArea(massGfa(m))}`}`, c: colorOf(scheme(), m.use) })),
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
      sk.cardVer = (sk.cardVer || 0) + 1;
      if (sk.set === 'diagram') { buildBar(); setTool(sk.tool); }
      changed();
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
    $('dg-colors')?.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.dgk) setDg(b.dataset.dgk, b.dataset.dgc);
      if ('dgclear' in b.dataset) { before(); sk.model.paint = {}; changed(); }
    });
    $('dg-colors')?.addEventListener('change', e => { if (e.target.type === 'color') setDg(e.target.dataset.dgk, e.target.value); });
    $('sk-list').addEventListener('click', e => {
      const b = e.target.closest('.sk-item'); if (!b) return;
      sk.sel = { kind: b.dataset.kind, id: b.dataset.id }; setTool('select'); draw(); panel(); card();
    });
  }

  // ---------------------------------------------------------------- outputs for the rest of the app
  /** Solids as building-like objects for the sun / shadow raster (top surface per point; courtyards open). */
  function buildings() {
    return sk.model.masses.filter(m => !info(m).sheet).map(m => {
      const I = info(m), base = I.base, [x0, y0, x1, y1] = I.bb;
      return { ring: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], massRing: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], base, top: base + I.zmax / kz(),
        roofAt: (x, y) => { const t = I.top(x, y); return t ? base + t.z / kz() : NaN; }, sketch: true };
    });
  }
  /** Solid triangles (flat [x, y, z × 3 …], native XY, output Z), a colour, block id and face per triangle, floor
   *  lines and outline edges. ex: vertical exaggeration of the 3D view (heights above each block's base are divided
   *  by it so blocks stay true-scale). */
  function tris(ex = 1) {
    const out = [], col = [], ids = [], fis = [], lines = [], edges = [];
    for (const m of sk.model.masses) {
      const I = info(m), c = massColor(m), lift = I.sheet ? 0.15 : 0;
      const Z = p => [p[0], p[1], I.base + p[2] / kz() / ex + lift];
      for (const t of I.tris) { out.push(...Z(m.v[t.a]), ...Z(m.v[t.b]), ...Z(m.v[t.c])); col.push(c); ids.push(m.id); fis.push(t.fi); }
      for (const pl of I.P.slice(1)) for (const [a, b] of pl.segs) lines.push(...Z([...a, pl.z]), ...Z([...b, pl.z]));
      for (const [a, b] of I.edges) edges.push(...Z(m.v[a]), ...Z(m.v[b]));
    }
    return { tris: out, colors: col, ids, fis, lines, edges };
  }
  /** Parking for 3D: stall lines, accessible stalls, islands (low planters) and drive aisles draped on the ground. */
  function parking3d() {
    const lines = [], acc = [], islands = [], drives = [], marks = [], extra = [];
    /** Painted items (diagram) get their own mesh and colour. */
    const own = (key, def) => { if (!diagramOn() || !sk.model.paint?.[key]) return def; const arr = []; extra.push({ tris: arr, color: resolveC(sk.model.paint[key]) }); return arr; };
    const z = (x, y) => zGround([x, y]) + 0.15;
    const curb = 0.5 * outPerFt();
    const planter = (P, out = islands) => {
      if (P.length < 3) return;
      const top = Math.max(...P.map(p => zGround(p))) + curb;
      for (const [i, j, k] of ctx.triangulate(P)) out.push(...P[i], top, ...P[j], top, ...P[k], top);
      for (let i = 0; i < P.length; i++) { const a = P[i], b = P[(i + 1) % P.length], za = zGround(a) - 0.2, zb = zGround(b) - 0.2; out.push(...a, za, ...b, zb, ...b, top, ...a, za, ...b, top, ...a, top); }
    };
    // A strip a→b, w wide, cut into short pieces so it follows the ground.
    const drape = (a, b, w, outArr) => {
      const Ln = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(1, Math.ceil(Ln / (8 * perFt())));
      const nx = -(b[1] - a[1]) / (Ln || 1) * w / 2, ny = (b[0] - a[0]) / (Ln || 1) * w / 2;
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
      for (const isl of Lr.islands || []) planter(islandShape(isl, l.islandR));
      if (l.setback > 0 && Lr.inner?.length > 2) for (let i = 0; i < Lr.inner.length; i++) { const a = Lr.inner[i], b = Lr.inner[(i + 1) % Lr.inner.length]; lines.push(a[0], a[1], z(...a), b[0], b[1], z(...b)); }
    }
    for (const isl of sk.model.islands) planter(islandShape(isl.pts, isl.r), own(`i:${isl.id}`, islands));
    for (const d of sk.model.drives) { const out = own(`d:${d.id}`, drives); for (let i = 0; i < d.pts.length - 1; i++) drape(d.pts[i], d.pts[i + 1], (d.w || 24) * perFt(), out); }
    const J = joins();
    for (const W of J.wedges) for (let i = 1; i < W.length - 1; i++) for (const q of [W[0], W[i], W[i + 1]]) drives.push(q[0], q[1], z(...q) + 0.05);
    for (const [a, b] of J.cuts) lines.push(a[0], a[1], z(...a) + 0.1, b[0], b[1], z(...b) + 0.1);
    return { lines, acc, islands, drives, marks, extra, stripe: colorOf(scheme(), 'stripe'), accColor: colorOf(scheme(), 'accessible'), lotColor: colorOf(scheme(), 'lot'), greenColor: colorOf(scheme(), 'green') };
  }

  return {
    get version() { return sk.ver; },
    get model() { return sk.model; },
    onSite,
    /** on: the Sketch or Diagram tab is showing; set: which toolset ('sketch' | 'diagram'). */
    setActive(on, set = 'sketch') {
      if (on && set !== sk.set) { sk.set = set; sk.sel = null; sk.tool = 'select'; buildBar(); }
      sk.active = on; canvas.hidden = !visible(); bar.hidden = !on || !sk.site;
      if (!on) { sk.draw = null; sk.op = null; sk.hov = null; cardEl.hidden = true; map.getContainer().classList.remove('sk-drawing'); sk.v3?.el.classList.remove('sk-drawing'); sk.v3?.sketchNav(false); }
      else setTool(sk.tool);
      draw(); card(); panel();
    },
    attach3d,
    redraw() { draw(); card(); },
    buildings, tris, parking3d, stats, wirePanel, panel, info, notes3d,
    get diagram() { return diagramOn(); },
    /** Diagram colours for the rest of the app: fill(kind 'b' | 't', key) → hex (paint, else the category default). */
    dgColors: () => ({ bldg: dgs().bldg, tree: dgs().tree, fill: (k, key) => paintOr(`${k}:${key}`),
      painted: (k, key) => { const p = sk.model.paint?.[`${k}:${key}`]; return p ? resolveC(p) : null; } }),
    setShowLabels(on) { sk.showLabels = on; draw(); },
    /** The overlay canvas (labels, plan drawing) for image export. */
    overlay: () => { draw(); return canvas; },
    hasContent: () => sk.model.masses.length + sk.model.lots.length + sk.model.islands.length + sk.model.drives.length > 0,
    refreshVisibility() { canvas.hidden = !visible(); draw(); },
    _sk: sk,
  };
}
