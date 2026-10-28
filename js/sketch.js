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
import { layoutLot, longestEdgeAngle, lanePoly, roundPoly, roundEach, driveJoins } from './parking.js?v=0.66.1';
import { snap as snapTo, snapMove, frameAngles } from './snap.js?v=0.66.1';
import { BUILTIN_SCHEMES, allSchemes, schemeById, saveScheme, deleteScheme, duplicateScheme, colorOf } from './schemes.js?v=0.66.1';
import { presetShape, area, inPoly, ROOFS } from './sketchmass.js?v=0.66.1';
import * as SO from './solid.js?v=0.66.1';
import { noteGeom, WIDTHS } from './notes.js?v=0.66.1';
import { booleanSolids } from './bool.js?v=0.66.1';
import { CODES, codeFor, spacesFor } from './parking-codes.js?v=0.51.1';

const TOOLS = [
  { id: 'select', key: 'V', label: 'Select', icon: '<path d="M5 3l14 8-6 1.5L10 19z"/>' },
  { id: 'mass', key: 'M', group: 'Building', label: 'Shapes', icon: '<path d="M4 9l8-4 8 4v9l-8 4-8-4z"/><path d="M4 9l8 4 8-4M12 13v9" opacity=".6"/>' },
  { id: 'point', key: 'A', label: 'Add point', icon: '<path d="M3 17L21 7" opacity=".6"/><rect x="9" y="9" width="6" height="6" fill="currentColor"/>' },
  { id: 'pen', key: 'L', label: 'Draw', icon: '<path d="M4 20l4-1L19 8l-3-3L5 16z"/><path d="M14 7l3 3" opacity=".6"/>' },
  { id: 'push', key: 'U', label: 'Push/Pull', icon: '<path d="M5 14h14v6H5z"/><path d="M12 12V3M8.5 6.5L12 3l3.5 3.5"/>' },
  { id: 'slope', key: 'S', label: 'Slope', icon: '<path d="M3 19L21 9v10z"/><path d="M6 15l9-5M12 9.5l3 .5-1 3" opacity=".8"/>' },
  { id: 'lot', key: 'P', group: 'Parking', label: 'Lot', icon: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v6M11 4v6M15 4v6M7 20v-6M11 20v-6M15 20v-6" opacity=".7"/>' },
  { id: 'island', key: 'I', label: 'Island', icon: '<rect x="3" y="8" width="18" height="8" rx="4"/><path d="M9 12h6" opacity=".7"/>' },
  { id: 'drive', key: 'D', label: 'Drive aisle', icon: '<path d="M5 21L10 3M19 21L14 3"/><path d="M12 5v3M12 11v3M12 17v3" opacity=".7"/>' },
  { id: 'radius', key: 'F', label: 'Radius', icon: '<path d="M4 20V12a8 8 0 0 1 8-8h8"/><path d="M4 20h4M20 4v4" opacity=".5"/>' },
  { id: 'walk', key: 'W', group: 'Site', label: 'Sidewalk', icon: '<path d="M4 20C9 16 10 9 20 4" stroke-width="4" opacity=".35"/><path d="M4 20C9 16 10 9 20 4"/>' },
  { id: 'plant', key: 'G', label: 'Planting', icon: '<path d="M4 15c2-6 6-9 9-8s6 4 7 8c-2 4-5 5-8 5s-7-1-8-5z" fill="currentColor" fill-opacity=".25"/><path d="M8 15c1-2 2-3 3-3M13 15c1-2 2-3 3-3" opacity=".7"/>' },
  { id: 'tree', key: 'T', label: 'Tree', icon: '<circle cx="12" cy="10" r="7"/><path d="M12 17v4M9 10a3 3 0 0 1 3-3" opacity=".7"/>' },
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
  select: 'Click to select · drag to move · drag a corner or an edge of the selection to reshape it (Shift = free direction) · ⟳ rotate, ⤡ scale · Ctrl+drag any point, edge or face (add Shift for up / down) · Alt+drag duplicates · Alt+click a corner removes it.',
  point: 'Click an edge to add a corner there — then drag it with Select.',
  radius: 'Click a corner of a lot, island or planting bed — or a curb return where an aisle meets the lot or the street — to round it; a box opens there to type the radius (0 = sharp).',
  mass: 'Drag a quick block (1–5: box, round, L, U, courtyard), or click corners and double-click. ↑ ↓ floors · R roof.',
  pen: 'On the ground: drag a rectangle or click an outline — it becomes a flat shape to pull up. On a face: drag or click from edge to edge to split it (lines stop at the edges; the new faces pull separately), or drag a rectangle inside it.',
  push: 'Drag a face in or out. Tops snap to whole floors (Shift = free). Ctrl = always make new sides. Type an exact distance in the box.',
  slope: 'Drag across a face toward its high side to tilt it at the pitch in the box (walls lean out). The back edge stays put.',
  lot: 'Drag a rectangle, or click corners and double-click to finish. [ ] turn the rows, ↑ ↓ slide them. With Select, drag the blue accessible spaces to move them.',
  island: 'Drag or click out a planter island — it snaps to stall lines, aisles and the lot edge; the stalls under it go away.',
  walk: 'Drag a straight sidewalk, or click points and double-click. Set the width in the box. It snaps to lots, blocks and the site lines.',
  plant: 'Drag a rectangle or click an outline and double-click: a planting bed or lawn.',
  tree: 'Click to plant a tree (the crown size in the box), or drag out its crown. Alt+drag a tree with Select to copy it.',
  drive: 'Drag a straight drive aisle, or click points and double-click. It snaps to aisle centres and lot edges; stalls it crosses are cleared; an end off the paving gets a curb cut.',
};
const DEFAULT_RATIOS = {   // examples only — every jurisdiction sets its own
  residential: { mode: 'unit', r: 1.5, unitSf: 900 }, office: { mode: 'ksf', r: 3 }, retail: { mode: 'ksf', r: 4 },
  civic: { mode: 'ksf', r: 2.5 }, hospitality: { mode: 'unit', r: 1, unitSf: 450 }, mixed: { mode: 'ksf', r: 3 },
  industrial: { mode: 'ksf', r: 1 }, parking: { mode: 'ksf', r: 0 },
};
const LISTS = { mass: 'masses', lot: 'lots', island: 'islands', drive: 'drives', note: 'notes', walk: 'walks', plant: 'plants', tree: 'trees', revit: 'rvbs' };
const svg = i => `<svg viewBox="0 0 24 24">${i}</svg>`;
const ORANGE = '#e8913f';

export function createSketch(ctx) {
  const { map, $, escapeHtml } = ctx;
  const sk = {
    model: blank(), tool: 'select', shape: 'box', sel: null, drag: null, draw: null, op: null, hov: null, undo: [], redo: [], ver: 0,
    site: null, key: null, layouts: new Map(), infos: new Map(), ngeo: new Map(), active: false, v3: null, pitch: 6,
    radius: 10, walkW: 5, treeD: 25, set: 'sketch', style: { color: 'arrow', size: 1, stand: false, curve: true }, showLabels: false,
  };
  function blank() {
    return { v: 3, masses: [], lots: [], islands: [], drives: [], notes: [], walks: [], plants: [], trees: [], rvbs: [], dg: { ...DG0 }, paint: {}, scheme: JSON.parse(JSON.stringify(BUILTIN_SCHEMES[0])), ratios: JSON.parse(JSON.stringify(DEFAULT_RATIOS)) };
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
  /** The two curb lines of a sidewalk, per segment: [[a, b], …]. */
  function walkEdges(w) {
    const out = [], hw = (w.w || 5) * perFt() / 2;
    for (let i = 0; i < w.pts.length - 1; i++) {
      const a = w.pts[i], b = w.pts[i + 1], L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, nx = -(b[1] - a[1]) / L * hw, ny = (b[0] - a[0]) / L * hw;
      out.push([[a[0] + nx, a[1] + ny], [b[0] + nx, b[1] + ny]], [[a[0] - nx, a[1] - ny], [b[0] - nx, b[1] - ny]]);
    }
    return out;
  }
  /** A drive aisle starting on a sidewalk's edge leaves it square: the edge's normal (pointing away from the walk), or null. */
  function walkEdgeNormal(p) {
    const tol = 3 * perFt();
    let best = null;
    for (const w of sk.model.walks) {
      const hw = (w.w || 5) * perFt() / 2;
      for (let i = 0; i < w.pts.length - 1; i++) {
        const a = w.pts[i], b = w.pts[i + 1], dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1;
        const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (L * L); if (t < -0.02 || t > 1.02) continue;
        const side = ((p[0] - a[0]) * -dy + (p[1] - a[1]) * dx) / L;          // signed distance from the centre line
        if (Math.abs(side) > hw + tol) continue;                                 // on the walk or just off its edge
        const sg = Math.sign(side) || 1, n = [-dy / L * sg, dx / L * sg], d = Math.abs(Math.abs(side) - hw);
        const q = [a[0] + dx * t + n[0] * hw, a[1] + dy * t + n[1] * hw];          // the point on that edge
        if (!best || d < best.d) best = { n, p: q, d };
      }
    }
    return best;
  }
  /** Point c held to the line through a along n (Alt lets go). */
  const alongN = (a, n, c) => { const k = (c[0] - a[0]) * n[0] + (c[1] - a[1]) * n[1]; return [a[0] + n[0] * k, a[1] + n[1] * k]; };
  function perpSnap(d, c, ev) {
    if (!d.perpN || ev.alt || !c) return c;
    const a = d.pts ? d.pts[0] : d.a, p = alongN(a, d.perpN, c);
    sk.snap = { p, t: 'lock', label: '⟂ sidewalk', guides: [[a, p]] };
    return p;
  }
  /** One-way arrows along an aisle (native polylines): a shaft and a head every ~40 ft. */
  function driveArrows(d) {
    const out = [], ft = perFt(), step = 40 * ft, len = 9 * ft, hw = 2.6 * ft;
    for (let i = 0; i < d.pts.length - 1; i++) {
      const a = d.pts[i], b = d.pts[i + 1], L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L < len * 1.5) continue;
      const ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L, n = Math.max(1, Math.floor(L / step));
      for (let k = 0; k < n; k++) {
        const t = (k + 0.5) * L / n, cx = a[0] + ux * t, cy = a[1] + uy * t, tip = [cx + ux * len / 2, cy + uy * len / 2], tail = [cx - ux * len / 2, cy - uy * len / 2];
        out.push([tail, tip], [[tip[0] - ux * hw * 1.4 - uy * hw, tip[1] - uy * hw * 1.4 + ux * hw], tip, [tip[0] - ux * hw * 1.4 + uy * hw, tip[1] - uy * hw * 1.4 - ux * hw]]);
      }
    }
    return out;
  }
  /** Curb cuts at an aisle's [start, end] (older saves: one boolean for both). */
  const cutsOf = d => (Array.isArray(d.cut) ? d.cut.slice(0, 2) : [d.cut !== false, d.cut !== false]);
  const zGround = p => { const z = ctx.zAt(p[0], p[1]); return Number.isFinite(z) ? z : 0; };
  const isLine = kind => kind === 'drive' || kind === 'walk';
  const closed = kind => !isLine(kind);
  const massById = id => sk.model.masses.find(m => m.id === id);

  // ---------------------------------------------------------------- solids
  const ftfN = m => m.ftf * kz();
  /** Rebuild a preset block's solid from its parameters. */
  function regen(m) { if (!m.prm) return; const S = SO.fromParams(m.prm, perFt(), ftfN(m)); m.v = S.v; m.f = S.f; }
  /** Hand edits turn a preset block into a free solid (its roof / courtyard / step settings are baked in). */
  const freeze = m => { delete m.prm; };
  /** Everything derived from a solid (cached): triangles, floor plates, area, top surface, outline, base elevation. */
  function info(m) {
    const key = JSON.stringify([m.v, m.f, m.ftf, kz(), m.ff || 0, ctx.groundVer?.() || 0]);
    const c = sk.infos.get(m.id);
    if (c && c.key === key && !(sk.baseLock?.id === m.id)) return c.I;
    const tris = SO.solidTris(m), P0 = SO.plates(m, ftfN(m), tris);
    // A preset block has the floors it was given; its roof (an attic) isn't counted as more.
    const P = m.prm ? P0.slice(0, m.prm.floors) : P0;
    const xy = m.v.map(p => [p[0], p[1]]), foot = m.v.filter(p => p[2] < 1e-6).map(p => [p[0], p[1]]);
    const F = foot.length >= 3 ? foot : xy;
    let base;
    if (sk.baseLock?.id === m.id) base = sk.baseLock.base;
    else base = avgGrade(F) + (m.ff || 0) * outPerFt();      // sits at the average grade under it, ± the first-floor slider
    const I = { tris, P, floors: P.length, gfa: P.reduce((a, p) => a + p.area, 0), zmax: SO.zMax(m), top: SO.topAt(m, tris), edges: SO.edgesOf(m),
      c: centroid(xy), bb: bbox(xy), base, sheet: SO.isSheet(m), foot: F };
    sk.infos.set(m.id, { key, I });
    return I;
  }
  /** Average ground elevation under an outline (a grid of samples inside it; corners + centre for slivers). */
  function avgGrade(F) {
    const [x0, y0, x1, y1] = bbox(F), n = 14; let sum = 0, cnt = 0;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const x = x0 + (i + 0.5) / n * (x1 - x0), y = y0 + (j + 0.5) / n * (y1 - y0);
      if (!inPoly(F, x, y)) continue;
      const z = ctx.zAt(x, y); if (Number.isFinite(z)) { sum += z; cnt++; }
    }
    if (!cnt) for (const p of [...F, centroid(F)]) { const z = ctx.zAt(...p); if (Number.isFinite(z)) { sum += z; cnt++; } }
    return cnt ? sum / cnt : 0;
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
    return { stall: l.stall, shift: l.shift, angle: l.angle ?? longestEdgeAngle(l.pts), k: perFt(), accNear: nearestMass(l), accAt: l.accAt || null,
      setback: l.setback || 0, endIslands: !!l.endIslands, islandEvery: l.islandEvery || 0, islands, drives };
  }
  function lotLayout(l) {
    const opts = lotOpts(l);
    const key = JSON.stringify([l.pts, l.rad, opts]);
    const c = sk.layouts.get(l.id);
    if (c && c.key === key) return c.res;
    const res = layoutLot(shapeOf(l), opts);
    sk.layouts.set(l.id, { key, res });
    return res;
  }
  /** Curb returns and curb cuts of the drive aisles (cached per sketch version). */
  function joins() {
    if (sk.joins?.ver === sk.ver) return sk.joins.J;
    const rAt = d => p => { for (const [k, r] of Object.entries(d.rj || {})) { const [x, y] = k.split(',').map(Number); if (Math.hypot(x - p[0], y - p[1]) < 3 * perFt()) return r * perFt(); } return (d.r ?? 15) * perFt(); };
    const J = driveJoins(sk.model.drives.map(d => ({ pts: d.pts, w: (d.w || 24) * perFt(), r: (d.r ?? 15) * perFt(), rAt: rAt(d), cut: cutsOf(d) })), sk.model.lots.map(l => shapeOf(l)));
    sk.joins = { ver: sk.ver, J };
    return J;
  }
  const islandShape = (P, r) => roundPoly(P, (r ?? 3) * perFt());
  /** An outline with its rounded corners (o.rad: { corner index: radius }). Free islands round every corner by o.r (3) unless set. */
  function shapeOf(o, kind) {
    const def = kind === 'island' ? (o.r ?? 3) : 0;
    if (!def && !(o.rad && Object.keys(o.rad).length)) return o.pts;
    return roundEach(o.pts, i => (o.rad?.[i] ?? def) * perFt());
  }
  function nearestMass(l) {
    const c = centroid(l.pts);
    let best = null, bd = Infinity;
    for (const m of sk.model.masses) { if (info(m).sheet) continue; const mc = info(m).c, d = Math.hypot(mc[0] - c[0], mc[1] - c[1]); if (d < bd) { bd = d; best = mc; } }
    return best;
  }
  function stats() {
    const byUse = new Map();
    for (const m of sk.model.masses) byUse.set(m.use, (byUse.get(m.use) || 0) + massGfa(m));
    for (const o of sk.model.rvbs) if (o.gfa) byUse.set(o.use || 'office', (byUse.get(o.use || 'office') || 0) + o.gfa);
    let req = 0;
    const reqBy = [];
    // Per block, so a code's step-downs for large buildings apply to each building.
    const per = new Map();
    for (const m of sk.model.masses) { const r = sk.model.ratios[m.use]; if (!r) continue; per.set(m.use, (per.get(m.use) || 0) + spacesFor(r, massGfa(m))); }
    for (const o of sk.model.rvbs) { const r = sk.model.ratios[o.use || 'office']; if (r && o.gfa) per.set(o.use || 'office', (per.get(o.use || 'office') || 0) + spacesFor(r, o.gfa)); }
    for (const [use, n] of per) { req += n; reqBy.push([use, n]); }
    let prov = 0, acc = 0, van = 0, accReq = 0, short = 0;
    for (const l of sk.model.lots) { const L = lotLayout(l); prov += L.total; acc += L.acc; van += L.van; accReq += L.required.acc; short += L.short; }
    const down = sk.model.ratioSrc?.round === 'down';
    return { byUse, gfa: [...byUse.values()].reduce((a, v) => a + v, 0), req: down ? Math.floor(req + 1e-9) : Math.ceil(req - 1e-9), reqBy, prov, acc, van, accReq, short };
  }

  // ---------------------------------------------------------------- undo / change
  const SAVED = ['masses', 'lots', 'islands', 'drives', 'notes', 'walks', 'plants', 'trees', 'rvbs'];
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
    jurisdiction(site);
    sk.ver++;
    draw(); panel(); ctx.onChange?.();
  }

  // ---------------------------------------------------------------- parking ratios from the site's jurisdiction
  /** Look up the city the site is in; use its code's ratios unless this project's ratios were edited by hand. */
  async function jurisdiction(site) {
    sk.jur = { loading: true };
    let place = null, err = null;
    try { place = await ctx.jurisdiction?.(site); } catch (e) { err = e; }
    if (sk.site !== site) return;
    const code = place ? codeFor(place) : null;
    sk.jur = { place, code, err };
    const src = sk.model.ratioSrc;
    if (code && !src?.edited && src?.id !== code.id) applyCode(code);
    else if (!code && !src) sk.model.ratioSrc = { id: null };
    panel();
  }
  function applyCode(code) {
    for (const [use, R] of Object.entries(code.uses)) {
      const cur = sk.model.ratios[use] || {};
      sk.model.ratios[use] = { mode: R.mode, r: R.r ?? 0, unitSf: cur.unitSf || (use === 'hospitality' ? 450 : 900), ...(R.tiers ? { tiers: R.tiers } : {}), ...(R.r == null ? { need: true } : {}) };
    }
    sk.model.ratioSrc = { id: code.id, round: code.round, checked: code.checked };
    $('sk-ratios') && ($('sk-ratios').dataset.html = '');
    changed(true);
  }
  const ST = { '05': 'AR', Arkansas: 'AR' };
  const jurName = () => { const p = sk.jur?.place; const st = p && (ST[p.stateFips] || ST[p.stateName]); return p?.name ? `${p.name}${st ? `, ${st}` : ''}` : null; };

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
    drawEdgeHover(g);
    drawRadiusHover(g);
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
  // ---------------------------------------------------------------- a building brought in from Revit
  // { id, name, at, how, gfa, floors, use, origin: [x, y, z] (native XY, output Z), buckets: [{ mat, pos (base64 Float32
  //   offsets from origin, 9 per triangle) }], materials: [{ name, rgb, render, opacity, shine, tex, mime, sx, sy (native) }] }
  const b64f32 = b64 => { const bin = atob(b64), u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); return new Float32Array(u8.buffer); };
  /** Decoded triangles (absolute), up-facing ones for plan / picking, a height raster for shadows. Cached. */
  function rvInfo(o) {
    const c = sk.rvCache?.get(o.id); if (c && c.o === o) return c.I;
    const [ox, oy, oz] = o.origin, buckets = o.buckets.map(b => { const a = b64f32(b.pos); for (let i = 0; i < a.length; i += 3) { a[i] += ox; a[i + 1] += oy; a[i + 2] += oz; } return { mat: b.mat, pos: a }; });
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    const up = [];
    for (const b of buckets) {
      const a = b.pos;
      for (let i = 0; i < a.length; i += 9) {
        for (let k = 0; k < 9; k += 3) { const x = a[i + k], y = a[i + k + 1], z = a[i + k + 2]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z; }
        // Up-facing (plan): normal z of the triangle in native XY / output Z (scaled to native).
        const ux = a[i + 3] - a[i], uy = a[i + 4] - a[i + 1], uz = (a[i + 5] - a[i + 2]) * kz(), vx = a[i + 6] - a[i], vy = a[i + 7] - a[i + 1], vz = (a[i + 8] - a[i + 2]) * kz();
        const nz = ux * vy - uy * vx, nl = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, nz);
        if (nl > 0 && nz / nl > 0.25) up.push({ mat: b.mat, p: [a[i], a[i + 1], a[i + 3], a[i + 4], a[i + 6], a[i + 7]], z: (a[i + 2] + a[i + 5] + a[i + 8]) / 3, za: [a[i + 2], a[i + 5], a[i + 8]] });
      }
    }
    up.sort((p, q) => p.z - q.z);
    // Height raster (top surface), 2 ft cells, for sun / shadow.
    const cs = 2 * perFt(), nx = Math.max(1, Math.ceil((x1 - x0) / cs) + 1), ny = Math.max(1, Math.ceil((y1 - y0) / cs) + 1), H = new Float32Array(nx * ny).fill(NaN);
    if (nx * ny < 4e6) for (const t of up) {
      const [ax, ay, bx, by, cx, cy] = t.p, den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy); if (Math.abs(den) < 1e-12) continue;
      const i0 = Math.max(0, Math.floor((Math.min(ax, bx, cx) - x0) / cs)), i1 = Math.min(nx - 1, Math.ceil((Math.max(ax, bx, cx) - x0) / cs));
      const j0 = Math.max(0, Math.floor((Math.min(ay, by, cy) - y0) / cs)), j1 = Math.min(ny - 1, Math.ceil((Math.max(ay, by, cy) - y0) / cs));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const px = x0 + i * cs, py = y0 + j * cs, w1 = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / den, w2 = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / den, w3 = 1 - w1 - w2;
        if (w1 < -0.02 || w2 < -0.02 || w3 < -0.02) continue;
        const z = w1 * t.za[0] + w2 * t.za[1] + w3 * t.za[2], q = j * nx + i; if (!(H[q] >= z)) H[q] = z;
      }
    }
    const roofAt = (x, y) => { const i = Math.round((x - x0) / cs), j = Math.round((y - y0) / cs); return i < 0 || j < 0 || i >= nx || j >= ny ? NaN : H[j * nx + i]; };
    const I = { buckets, up, bb: [x0, y0, x1, y1], zmin: z0, zmax: z1, roofAt };
    (sk.rvCache ||= new Map()).set(o.id, { o, I });
    return I;
  }
  /** Where a Revit building landed relative to the site: off the site or off the ground → a note and a fix button. */
  function rvWhere(o) {
    const I = rvInfo(o), [x0, y0, x1, y1] = I.bb, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, box = ctx.siteBox?.(), out = [];
    if (box && (cx < box.xmin || cx > box.xmax || cy < box.ymin || cy > box.ymax)) {
      const bx = (box.xmin + box.xmax) / 2, by = (box.ymin + box.ymax) / 2, d = Math.hypot(cx - bx, cy - by) / perFt();
      const dir = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'][Math.round(((Math.atan2(cx - bx, cy - by) * 180 / Math.PI + 360) % 360) / 45) % 8];
      out.push(`<div class="skc-row skc-warn">It landed ${Math.round(d).toLocaleString()} ft ${dir} of the site — the building isn't where the site sits in that Revit model (check the Project Base Point / placement there).<button type="button" data-k="rv-fit">Move it onto the site</button></div>`);
    }
    const g = Math.min(...[[cx, cy], [x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(p => zGround(p))), dz = (I.zmin - g) / outPerFt();
    if (Number.isFinite(dz) && Math.abs(dz) > 10) out.push(`<div class="skc-row skc-warn">Its lowest point is ${Math.round(Math.abs(dz)).toLocaleString()} ft ${dz > 0 ? 'above' : 'below'} the ground there${dz < 0 ? ' (hidden underground)' : ''} — the model's levels don't match the site's elevations.<button type="button" data-k="rv-ground">Set it on the ground</button></div>`);
    return out.join('');
  }
  const rvMatColor = (o, mi) => { const m = o.materials[mi] || {}, c = m.render || m.rgb || [200, 200, 200]; return `rgb(${c[0]},${c[1]},${c[2]})`; };
  function drawRevit(g) {
    for (const o of sk.model.rvbs) {
      const I = rvInfo(o), sel = sk.sel?.id === o.id, dg = diagramOn(), dcol = dg ? paintOr(`r:${o.id}`) : null;
      for (const t of I.up) {
        const a = scr([t.p[0], t.p[1]]), b = scr([t.p[2], t.p[3]]), c = scr([t.p[4], t.p[5]]); if (!a || !b || !c) continue;
        g.beginPath(); g.moveTo(...a); g.lineTo(...b); g.lineTo(...c); g.closePath();
        g.fillStyle = dcol || rvMatColor(o, t.mat); g.fill(); g.strokeStyle = g.fillStyle; g.lineWidth = 0.6; g.stroke();
      }
      const [x0, y0, x1, y1] = I.bb;
      if (sel) { sPath(g, [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]); g.setLineDash([6, 4]); g.strokeStyle = ORANGE; g.lineWidth = 2; g.stroke(); g.setLineDash([]); }
    }
  }
  const rvHit = xy => sk.model.rvbs.find(o => { const I = rvInfo(o), [x0, y0, x1, y1] = I.bb; if (xy[0] < x0 || xy[0] > x1 || xy[1] < y0 || xy[1] > y1) return false; return I.up.some(t => inPoly([[t.p[0], t.p[1]], [t.p[2], t.p[3]], [t.p[4], t.p[5]]], ...xy)); });
  /** Triangles by material for the 3D view (absolute native XY, output Z). */
  function revit3d() {
    return sk.model.rvbs.map(o => { const I = rvInfo(o); return { id: o.id, buckets: I.buckets, materials: o.materials, zmin: I.zmin, paint: diagramOn() ? paintOr(`r:${o.id}`) : null }; });
  }
  function drawPlan(g) {
    const M = ctx.affine(sk.site), px = M.scale;                 // screen px per native unit
    const path = (P, close = true) => sPath(g, P, null, close);
    const green = colorOf(scheme(), 'green');
    // Planting beds and sidewalks sit under everything else.
    for (const pl of sk.model.plants) {
      const plS = shapeOf(pl);
      if (!path(plS)) continue;
      g.fillStyle = siteColor(`g:${pl.id}`, 'green'); g.globalAlpha = 0.85; g.fill(); g.globalAlpha = 1;
      g.save(); g.clip(); g.strokeStyle = 'rgba(20,83,45,0.35)'; g.lineWidth = 1;          // a light stipple of shrubs
      const bb = bbox(pl.pts), st = Math.max(6 / px, 6 * perFt());
      for (let x = bb[0]; x < bb[2]; x += st) for (let y = bb[1] + ((x / st) % 2) * st / 2; y < bb[3]; y += st) { const q = scr([x, y]); if (q) { g.beginPath(); g.arc(q[0], q[1], Math.max(1.2, st * px * 0.18), 0, Math.PI * 2); g.stroke(); } }
      g.restore();
      path(plS); g.strokeStyle = sk.sel?.id === pl.id ? ORANGE : 'rgba(20,83,45,0.85)'; g.lineWidth = sk.sel?.id === pl.id ? 2.5 : 1.2; g.stroke();
    }
    for (const w of sk.model.walks) {
      if (!path(w.pts, false)) continue;
      g.lineJoin = 'round'; g.lineCap = 'butt';
      g.lineWidth = (w.w || 5) * perFt() * px + 2; g.strokeStyle = sk.sel?.id === w.id ? ORANGE : 'rgba(90,84,74,0.9)'; g.stroke();
      path(w.pts, false); g.lineWidth = (w.w || 5) * perFt() * px; g.strokeStyle = siteColor(`w:${w.id}`, 'plaza'); g.stroke();
      g.lineJoin = 'miter';
      if (w.grade) {          // graded walk: an arrow down the slope at its middle, with the slope
        const i = Math.floor((w.pts.length - 1) / 2), a = w.pts[i], b = w.pts[i + 1], q0 = scr(a), q1 = scr(b);
        if (q0 && q1) { const mx = (q0[0] + q1[0]) / 2, my = (q0[1] + q1[1]) / 2, L = Math.hypot(q1[0] - q0[0], q1[1] - q0[1]) || 1, ux = (q1[0] - q0[0]) / L, uy = (q1[1] - q0[1]) / L;
          g.beginPath(); g.moveTo(mx - ux * 14, my - uy * 14); g.lineTo(mx + ux * 14, my + uy * 14); g.moveTo(mx + ux * 14 - ux * 6 - uy * 5, my + uy * 14 - uy * 6 + ux * 5); g.lineTo(mx + ux * 14, my + uy * 14); g.lineTo(mx + ux * 14 - ux * 6 + uy * 5, my + uy * 14 - uy * 6 - ux * 5);
          g.strokeStyle = '#1f2937'; g.lineWidth = 2; g.stroke();
          label(g, [mx, my - 12], `${{ max: '≤ ', min: '≥ ' }[w.grade.mode] || ''}${w.grade.slope ?? 2}%`, ''); }
      }
      if (sk.sel?.id === w.id) { const q = scr(w.pts[0]); if (q) { g.font = 'bold 11px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = 'rgba(15,23,42,.85)'; g.beginPath(); g.arc(q[0], q[1] - 14, 8, 0, Math.PI * 2); g.fill(); g.fillStyle = '#fff'; g.fillText('S', q[0], q[1] - 14); } }
    }
    for (const l of sk.model.lots) {
      const L = lotLayout(l), sel = sk.sel?.id === l.id;
      const lc = siteColor(`l:${l.id}`, 'lot');
      const lS = shapeOf(l);
      path(lS); g.fillStyle = lc; g.fill();                       // solid paving: hides the aerial under the lot
      if (l.setback > 0 && L.inner?.length > 2) { path(lS); g.save(); g.clip(); g.fillStyle = green; g.globalAlpha = 0.55; g.fill(); g.restore(); path(L.inner); g.fillStyle = lc; g.globalAlpha = 0.9; g.fill(); g.globalAlpha = 1; }
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
      path(lS); g.lineWidth = sel ? 2.5 : 1.5; g.strokeStyle = sel ? ORANGE : 'rgba(30,41,59,0.85)'; g.stroke();
    }
    const J = joins();
    for (const d of sk.model.drives) {
      const w = (d.w || 24) * perFt();
      for (let i = 0; i < d.pts.length - 1; i++) { path(lanePoly(d.pts[i], d.pts[i + 1], w)); g.fillStyle = siteColor(`d:${d.id}`, 'lot'); g.globalAlpha = 0.9; g.fill(); g.globalAlpha = 1; }
    }
    for (const W of J.wedges) { path(W); g.fillStyle = colorOf(scheme(), 'lot'); g.globalAlpha = 0.9; g.fill(); g.globalAlpha = 1; }
    for (const d of sk.model.drives) {
      if (!d.oneWay) { path(d.pts, false); g.setLineDash([8, 6]); g.strokeStyle = '#fde047'; g.lineWidth = 1.5; g.stroke(); g.setLineDash([]); }
      else for (const ar of driveArrows(d)) { path(ar, false); g.strokeStyle = '#ffffff'; g.lineWidth = 2.2; g.stroke(); }
      if (sk.sel?.id === d.id) for (const [p, t] of [[d.pts[0], 'S'], [d.pts[d.pts.length - 1], 'E']]) { const q = scr(p); if (!q) continue; g.font = 'bold 11px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = 'rgba(15,23,42,.85)'; g.beginPath(); g.arc(q[0], q[1] - 14, 8, 0, Math.PI * 2); g.fill(); g.fillStyle = '#fff'; g.fillText(t, q[0], q[1] - 14); }
    }
    for (const [a, b] of J.cuts) { path([a, b], false); g.strokeStyle = '#ffffff'; g.lineWidth = 3; g.setLineDash([4, 3]); g.stroke(); g.setLineDash([]); }
    for (const isl of sk.model.islands) { path(shapeOf(isl, 'island')); g.fillStyle = siteColor(`i:${isl.id}`, 'green'); g.fill(); g.strokeStyle = sk.sel?.id === isl.id ? ORANGE : 'rgba(20,83,45,0.8)'; g.lineWidth = sk.sel?.id === isl.id ? 2.5 : 1.2; g.stroke(); }
    for (const l of sk.model.lots) {
      if (!showTags()) break;
      const L = lotLayout(l);
      label(g, scr(centroid(l.pts)), `${L.total} spaces`, L.acc ? `${L.acc} accessible${L.van ? ` (${L.van} van)` : ''}${L.short ? ` · ${L.short} short` : ''}` : '');
    }
    drawRevit(g);
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
    // Trees on top: crown, a few branch strokes, trunk dot.
    for (const t of sk.model.trees) {
      const q = scr(t.pts[0]), e = scr([t.pts[0][0] + t.d / 2 * perFt(), t.pts[0][1]]); if (!q || !e) continue;
      const rr = Math.hypot(e[0] - q[0], e[1] - q[1]), col = diagramOn() ? paintOr(`t:${treeKeyOf(t)}`) : '#3f8a4a', sel = sk.sel?.id === t.id;
      g.beginPath(); for (let k = 0; k <= 20; k++) { const a = k / 20 * Math.PI * 2, w = rr * (1 + 0.06 * Math.sin(5 * a + t.pts[0][0])); const x = q[0] + w * Math.cos(a), y = q[1] + w * Math.sin(a); k ? g.lineTo(x, y) : g.moveTo(x, y); }
      g.fillStyle = col; g.globalAlpha = 0.72; g.fill(); g.globalAlpha = 1; g.strokeStyle = sel ? ORANGE : 'rgba(20,60,30,0.9)'; g.lineWidth = sel ? 2.5 : 1; g.stroke();
      g.beginPath(); for (let k = 0; k < 5; k++) { const a = k / 5 * Math.PI * 2 + 0.4; g.moveTo(q[0], q[1]); g.lineTo(q[0] + rr * 0.6 * Math.cos(a), q[1] + rr * 0.6 * Math.sin(a)); } g.strokeStyle = 'rgba(20,60,30,0.45)'; g.lineWidth = 1; g.stroke();
      g.beginPath(); g.arc(q[0], q[1], 2, 0, Math.PI * 2); g.fillStyle = '#3b2a1a'; g.fill();
    }
    if (showTags()) for (const m of ms) label(g, scr(labelPt(m)), massTitle(m), massSub(m));
  }
  const treeKeyOf = t => `${Math.round(t.pts[0][0])},${Math.round(t.pts[0][1])}`;
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
    if (kind === 'tree' || kind === 'revit') return [];
    const zf = handleZ(kind, o), out = [];
    const editable = kind !== 'mass' || o.prm;
    const P = outline(o), n = P.length, cl = closed(kind);
    if (editable) {
      P.forEach((p, i) => out.push({ t: 'v', i, p, z: zf(p) }));
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
    const kind = sk.sel.kind;
    if (kind === 'revit') return;                       // its dashed box is drawn with it
    const zf = handleZ(kind, o);
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
    if (d.treeDraw) {
      const q = scr(d.c), e = scr([d.c[0] + d.r, d.c[1]]); if (!q || !e) return;
      const rr = Math.hypot(e[0] - q[0], e[1] - q[1]);
      g.beginPath(); g.arc(q[0], q[1], rr, 0, Math.PI * 2); g.fillStyle = 'rgba(74,140,70,0.35)'; g.fill(); g.setLineDash([5, 4]); g.strokeStyle = ORANGE; g.lineWidth = 2; g.stroke(); g.setLineDash([]);
      tag(g, q, `⌀ ${fmtLen(d.r * 2)}`); return;
    }
    if (d.face) return drawPenFace(g, d);
    const P = drawPts();
    if (P.length > 1) {
      const cl = !isLine(d.kind) && (d.rect || P.length > 2);
      const zf = sk.v3 ? (p => zGround(p) + 0.3) : null;
      if (sPath(g, P, zf, cl)) {
        if (cl) { g.fillStyle = d.kind === 'mass' || d.kind === 'sheet' ? colorOf(scheme(), sk.last?.use || scheme().uses[0].key) : d.kind === 'island' || d.kind === 'plant' ? colorOf(scheme(), 'green') : colorOf(scheme(), 'lot'); g.globalAlpha = 0.45; g.fill(); g.globalAlpha = 1; }
        g.setLineDash([6, 4]); g.strokeStyle = ORANGE; g.lineWidth = isLine(d.kind) ? 3 : 2; g.stroke(); g.setLineDash([]);
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
      if (isLine(d.kind)) return [d.a, d.b];
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
          + `<div class="sk-fly sk-num" data-for="walk" hidden><span>Width</span><input type="number" step="0.5" min="2" max="40" value="${sk.walkW}" data-fly="walkW" title="Sidewalk width"><span class="sk-u"></span></div>`
          + `<div class="sk-fly sk-num" data-for="tree" hidden><span>Crown ⌀</span><input type="number" step="1" min="3" max="120" value="${sk.treeD}" data-fly="treeD" title="Crown diameter for a click (drag to size it instead)"><span class="sk-u"></span></div>`
          + `<div class="sk-fly sk-num" data-for="radius" hidden><span>Radius</span><input type="number" step="1" min="0" max="500" value="${sk.radius}" data-fly="radius" title="Radius for the next corner you click"><span class="sk-u"></span></div>`
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
    if (t.dataset.fly === 'walkW') sk.walkW = Math.max(2, Number.isFinite(v) ? v : 5);
    if (t.dataset.fly === 'treeD') sk.treeD = Math.max(3, Number.isFinite(v) ? v : 25);
    if (t.dataset.fly === 'radius') sk.radius = Math.max(0, Number.isFinite(v) ? v : 10);
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
  /** Two columns when the toolbar is taller than the view. */
  function fitBar() {
    if (bar.hidden) return;
    bar.classList.remove('two');
    const H = (bar.parentElement?.clientHeight || 0) - 16;
    if (H > 0 && bar.offsetHeight > H) bar.classList.add('two');
  }
  window.addEventListener('resize', () => requestAnimationFrame(fitBar));
  function setTool(t) {
    if (!tools().some(x => x.id === t)) t = 'select';
    if (t !== 'radius') sk.rpopClose?.();
    sk.tool = t; sk.draw = null; sk.hov = null;
    card();
    bar.querySelectorAll('[data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === t));
    fitBar();
    bar.querySelectorAll('.sk-fly').forEach(f => {
      f.hidden = f.dataset.for === 'style' ? t === 'select' : f.dataset.for !== t;
      f.querySelector('.dg-row')?.toggleAttribute('hidden', t === 'paint');
      if (!f.hidden) { const b = bar.querySelector(`[data-tool="${f.dataset.for === 'style' ? 'arrow' : t}"]`); f.style.top = `${b.offsetTop}px`; }
    });
    bar.querySelectorAll('.sk-u').forEach(u => { u.textContent = uLen(); });
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
      const avg = avgGrade(info(o).foot), u = uLen(), ffEl = avg + (o.ff || 0) * outPerFt();
      const floors = `<div class="skc-row"><span>Floors</span><button type="button" data-k="fl-" title="↓">−</button><output data-o="floors"></output><button type="button" data-k="fl+" title="↑">+</button>
          <span>@</span>${num('ftf', o.ftf, 2, 40, 0.5)}<span>${u}</span></div>
        <div class="skc-row" title="The block sits at the average grade under it; slide the first floor up or down to line it up with a point on the grade"><span>First floor</span><input type="range" data-k="ff" min="-20" max="20" step="0.5" value="${o.ff || 0}" style="flex:1;min-width:90px">
          <output data-o="ff">${(o.ff || 0) > 0 ? '+' : ''}${o.ff || 0} ft</output></div>
        <div class="skc-row skc-read" data-o="ffel">FF ${ffEl.toFixed(1)} · average grade ${avg.toFixed(1)}</div>`;
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
          <span title="Drag the blue accessible spaces to move them">Accessible</span>${o.accAt ? '<span class="skc-read">placed by hand</span><button type="button" data-k="accAuto" title="Back to the row ends nearest the building">auto</button>' : '<span class="skc-read">nearest the building — drag to move</span>'}</div>
        <div class="skc-row"><label class="skc-chk"><input type="checkbox" data-k="endIslands"${o.endIslands ? ' checked' : ''}> End islands</label>
          <span>Island every</span>${num('islandEvery', o.islandEvery || 0, 0, 40, 1, 38)}<span>stalls</span></div>
        <div class="skc-row skc-read" data-o="read"></div>`;
    }
    if (kind === 'drive') {
      return `<div class="skc-row"><span>Drive aisle</span>${num('w', o.w || 24, 10, 60, 1)}<span>${uLen()} wide</span><button type="button" data-k="del" title="Delete (Del)">🗑</button></div>
        <div class="skc-row"><span title="Curb return where it meets a lot or another aisle, and at curb cuts">Turn radius</span>${num('r', o.r ?? 15, 0, 60, 1, 42)}<span>${uLen()}</span>
</div>
        <div class="skc-row"><span title="Flared apron and depressed curb where an end leaves all paving (at the street)">Curb cut</span>
          <label class="skc-chk" title="The end you started drawing from (marked S)"><input type="checkbox" data-k="cut0"${cutsOf(o)[0] ? ' checked' : ''}> start</label>
          <label class="skc-chk" title="The end you finished drawing at (marked E)"><input type="checkbox" data-k="cut1"${cutsOf(o)[1] ? ' checked' : ''}> end</label></div>
        <div class="skc-row"><label class="skc-chk" title="Traffic one way — arrows on the aisle"><input type="checkbox" data-k="oneWay"${o.oneWay ? ' checked' : ''}> One way</label>
          ${o.oneWay ? '<button type="button" data-k="flipDir" title="Turn the arrows around">⇄ reverse</button>' : ''}</div>
        <div class="skc-row skc-read" data-o="read"></div>`;
    }
    if (kind === 'revit') return `<div class="skc-row"><b>${escapeHtml(o.name || 'Revit building')}</b><span class="skc-read">from Revit ${escapeHtml(o.at || '')}</span><button type="button" data-k="del" title="Remove it from the site (Del)">🗑</button></div>
        <div class="skc-row"><span>Use</span><select data-k="use">${scheme().uses.map(u => `<option value="${u.key}"${u.key === o.use ? ' selected' : ''}>${escapeHtml(u.label)}</option>`).join('')}</select>
          <span>floor area</span>${num('gfa', o.gfa || 0, 0, 1e7, 100, 80)}<span>sf</span></div>
        <div class="skc-row skc-note">${o.gfa ? `${o.floors || '?'} floor levels with ${Math.round(o.gfa).toLocaleString()} sf of floors in Revit.` : 'No floors in what was sent — type the floor area for parking.'} Placed where Revit puts it, relative to the site's placement in that model.</div>${rvWhere(o)}`;
    if (kind === 'walk') {
      const gr = o.grade;
      return `<div class="skc-row"><span>Sidewalk</span>${num('w', o.w || 5, 2, 40, 0.5, 42)}<span>${uLen()} wide</span><button type="button" data-k="del" title="Delete (Del)">🗑</button></div>
        <div class="skc-row seg seg-dark" title="Graded: the ground along the walk is graded to a set slope (a Slope in Site design)"><label><input type="radio" name="skc-wg" value="ground"${gr ? '' : ' checked'}><span>Follows ground</span></label><label><input type="radio" name="skc-wg" value="slope"${gr ? ' checked' : ''}><span>Graded slope</span></label></div>
        ${gr ? `<div class="skc-row"><span>Slope</span><select data-k="wmode">${[['exact', 'exactly'], ['max', 'at most'], ['min', 'at least']].map(([k, l]) => `<option value="${k}"${(gr.mode || 'exact') === k ? ' selected' : ''}>${l}</option>`).join('')}</select>${num('wslope', gr.slope ?? 2, 0, 25, 0.1, 42)}<span>%</span>
          <button type="button" data-k="wflip" title="Run the slope the other way (it falls from the start, S)">⇄</button></div>
        <div class="skc-row skc-note">Falls from its start (S) at this slope; the ground beside it ties back in. It's a Slope in Site design, kept in step with this walk.</div>` : ''}
        <div class="skc-row skc-read" data-o="read"></div>`;
    }
    if (kind === 'plant') return `<div class="skc-row"><span>Planting</span><button type="button" data-k="del" title="Delete (Del)">🗑</button></div><div class="skc-row skc-read" data-o="read"></div>`;
    if (kind === 'tree') return `<div class="skc-row"><select data-k="form">${[['broadleaf', 'Broadleaf'], ['pine', 'Pine'], ['cedar', 'Cedar']].map(([k, l]) => `<option value="${k}"${(o.form || 'broadleaf') === k ? ' selected' : ''}>${l}</option>`).join('')}</select><span>crown ⌀</span>${num('d', o.d, 3, 120, 1, 42)}<span>height</span>${num('h', o.h, 5, 150, 1, 42)}<span>${uLen()}</span><button type="button" data-k="del" title="Delete (Del)">🗑</button></div>`;
    return `<div class="skc-row"><span>Planter island</span><button type="button" data-k="del" title="Delete (Del)">🗑</button></div>
      <div class="skc-row skc-note">Round its corners with the Radius tool (F).</div><div class="skc-row skc-read" data-o="read"></div>`;
  }
  function card() {
    const o = findSel();
    if (!o || !sk.active || !sk.site || sk.drag || sk.draw || sk.op || (sk.set === 'sketch' && sk.tool !== 'select') || (sk.set === 'diagram' && sk.tool !== 'select' && !(sk.tool === 'label' && o.type === 'label')) || (sk.v3 && !sk.v3.visible)) { cardEl.hidden = true; return; }
    const kind = sk.sel.kind;
    let x1 = -Infinity, y0 = Infinity;
    const pts = kind === 'mass' ? o.v.map(p => P3(o, p)) : kind === 'note' ? (noteScreen(o) || []) : kind === 'revit' ? [scr(rvInfo(o).bb.slice(0, 2))] : o.pts.map(p => scr(p, handleZ(kind, o)(p)));
    for (const q of pts) { if (!q) continue; if (q[0] > x1) x1 = q[0]; if (q[1] < y0) y0 = q[1]; }
    if (!Number.isFinite(x1)) { cardEl.hidden = true; return; }
    const W = cardEl.parentElement.clientWidth, H = cardEl.parentElement.clientHeight;
    const sig = `${kind}:${o.id}:${sk.sel2?.id || ''}:${sk.cardVer || 0}:${!!o.prm}:${kind === 'mass' && info(o).sheet}:${JSON.stringify([o.prm, o.stall, o.endIslands, o.ftf, o.setback, o.islandEvery, o.w, o.use, o.color, o.stand, o.curve, o.size, o.r, o.cut, o.oneWay, o.grade, o.islandR, !!o.accAt, o.d, o.h, o.form, o.gfa])}`;
    if (cardEl.dataset.sig !== sig && !cardEl.contains(document.activeElement)) { cardEl.dataset.sig = sig; cardEl.innerHTML = cardHtml(kind, o); }
    const read = cardEl.querySelector('[data-o="read"]') || {};
    if (kind === 'note') { /* nothing to read out */ } else if (kind === 'mass') {
      const I = info(o), fl = cardEl.querySelector('[data-o="floors"]');
      if (fl) fl.textContent = String(I.floors);
      read.textContent = I.sheet ? fmtArea(area(I.foot) * sfPerNative2()) : `${fmtArea(massGfa(o))} total · ${I.floors ? `${fmtArea(I.P[0].area * sfPerNative2())} ground floor · ` : ''}${fmtLen(I.zmax)} tall`;
    } else if (kind === 'lot') {
      const Lr = lotLayout(o);
      read.textContent = `${Lr.total} spaces (${Lr.acc} accessible${Lr.van ? `, ${Lr.van} van` : ''}) · ${Math.round(area(o.pts) * sfPerNative2() / Math.max(1, Lr.total))} sf per space`;
    } else if (kind === 'tree' || kind === 'revit') { /* nothing to read out */
    } else if (kind === 'drive' || kind === 'walk') {
      let Ln = 0; for (let i = 1; i < o.pts.length; i++) Ln += Math.hypot(o.pts[i][0] - o.pts[i - 1][0], o.pts[i][1] - o.pts[i - 1][1]);
      read.textContent = kind === 'walk' ? `${fmtLen(Ln)} long · ${fmtArea(Ln * (o.w || 5) * perFt() * sfPerNative2())}` : `${fmtLen(Ln)} long · stalls it crosses are cleared`;
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
    if (k === 'accAuto') { before(); delete o.accAt; changed(true); }
    if (k === 'wflip') { before(); o.pts = o.pts.slice().reverse(); changed(true); }
    if (k === 'flipDir') { before(); o.pts = o.pts.slice().reverse(); if (Array.isArray(o.cut)) o.cut = [o.cut[1], o.cut[0]]; changed(true); }
    if (k === 'rv-fit' || k === 'rv-ground') {
      const I = rvInfo(o), [x0, y0, x1, y1] = I.bb, box = ctx.siteBox?.();
      before();
      o.origin = o.origin.slice();
      if (k === 'rv-fit' && box) { o.origin[0] += (box.xmin + box.xmax) / 2 - (x0 + x1) / 2; o.origin[1] += (box.ymin + box.ymax) / 2 - (y0 + y1) / 2; }
      sk.rvCache?.delete(o.id);
      const I2 = rvInfo(o), [a0, b0, a1, b1] = I2.bb, cx = (a0 + a1) / 2, cy = (b0 + b1) / 2;
      if (k === 'rv-ground' || Math.abs(I2.zmin - zGround([cx, cy])) > 10 * outPerFt()) {
        const g = Math.min(...[[cx, cy], [a0, b0], [a1, b0], [a1, b1], [a0, b1]].map(p => zGround(p)));
        if (Number.isFinite(g)) o.origin[2] += g - I2.zmin;
        sk.rvCache?.delete(o.id);
      }
      cardEl.dataset.sig = ''; changed(true);
    }
    if (k === 'flip') { before(); o.prm.roof = { ...o.prm.roof, flip: !o.prm.roof?.flip }; regen(o); changed(true); }
    if (k.startsWith('rot') || k.startsWith('sh')) {
      before();
      const cur = o.angle ?? longestEdgeAngle(o.pts);
      if (k === 'rot-') o.angle = cur - Math.PI / 36; if (k === 'rot+') o.angle = cur + Math.PI / 36; if (k === 'rot0') o.angle = null;
      if (k === 'sh-') o.shift = (o.shift || 0) - 3; if (k === 'sh+') o.shift = (o.shift || 0) + 3;
      changed(true);
    }
  });
  // First-floor slider: live while dragging, one undo step.
  cardEl.addEventListener('input', e => {
    const t = e.target; if (t.dataset.k !== 'ff') return;
    const o = findSel(); if (!o) return;
    if (!sk.ffPushed) { before(); sk.ffPushed = true; }
    o.ff = Number(t.value) || 0;
    const out = cardEl.querySelector('[data-o="ff"]'); if (out) out.textContent = `${o.ff > 0 ? '+' : ''}${o.ff} ft`;
    const avg = avgGrade(info(o).foot), rd = cardEl.querySelector('[data-o="ffel"]'); if (rd) rd.textContent = `FF ${(avg + o.ff * outPerFt()).toFixed(1)} · average grade ${avg.toFixed(1)}`;
    draw(); live();
  });
  cardEl.addEventListener('change', e => {
    if (e.target.dataset.k === 'ff') { sk.ffPushed = false; changed(true); return; }
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
    if (k === 'w') o.w = sk.sel.kind === 'walk' ? Math.max(2, Math.min(40, v || 5)) : Math.max(10, Math.min(60, v || 24));
    if (k === 'd' && sk.sel.kind === 'tree') o.d = Math.max(3, Math.min(120, v || o.d));
    if (k === 'h' && sk.sel.kind === 'tree') o.h = Math.max(5, Math.min(150, v || o.h));
    if (k === 'form' && sk.sel.kind === 'tree') { o.form = t.value; sk.treeForm = t.value; }
    if (k === 'gfa' && sk.sel.kind === 'revit') o.gfa = Math.max(0, v || 0);
    if (k === 'r') o.r = Math.max(0, Number.isFinite(v) ? v : 0);
    if (k === 'cut0' || k === 'cut1') { const c = cutsOf(o); c[k === 'cut0' ? 0 : 1] = t.checked; o.cut = c; }
    if (k === 'oneWay') { o.oneWay = t.checked; t.blur(); }
    if (t.name === 'skc-wg') { o.grade = t.value === 'slope' ? { slope: o.grade?.slope ?? 2, mode: o.grade?.mode || 'exact' } : null; t.blur(); }
    if (k === 'wslope' && o.grade) o.grade = { ...o.grade, slope: Math.max(0, Math.min(25, Number.isFinite(v) ? v : 2)) };
    if (k === 'wmode' && o.grade) o.grade = { ...o.grade, mode: t.value };
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
  function pickElement(ev, only) {
    let best = null;
    const ms = only ? sk.model.masses.filter(m => m.id === only) : sk.model.masses;
    for (const m of ms) {
      m.v.forEach((p, i) => { const q = P3(m, p); if (!q) return; const d = Math.hypot(q[0] - ev.sx, q[1] - ev.sy); if (d < 9 && (!best || d < best.d)) best = { id: m.id, t: 'v', i, d }; });
    }
    if (best) return best;
    for (const m of ms) for (const [a, b] of info(m).edges) {
      const p = P3(m, m.v[a]), q = P3(m, m.v[b]); if (!p || !q) continue;
      const d = distSeg([ev.sx, ev.sy], p, q);
      if (d < 6 && (!best || d < best.d)) best = { id: m.id, t: 'e', a, b, d };
    }
    if (best) return best;
    const f = pickFace(ev);
    return f ? { id: f.id, t: 'f', fi: f.fi, p: f.p } : null;
  }
  /** Edge of an outline object under the cursor (screen px): { i, d, t (0..1 along it) }. */
  function edgeHit(kind, o, ev, tol = 6) {
    const P = outline(o), n = P.length, zf = handleZ(kind, o); let best = null;
    for (let i = 0; i < (closed(kind) ? n : n - 1); i++) {
      const pa = P[i], pb = P[(i + 1) % n], a = scr(pa, zf(pa)), b = scr(pb, zf(pb)); if (!a || !b) continue;
      const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1, t = Math.max(0, Math.min(1, ((ev.sx - a[0]) * dx + (ev.sy - a[1]) * dy) / L2));
      const d = Math.hypot(ev.sx - a[0] - dx * t, ev.sy - a[1] - dy * t);
      if (d < tol && (!best || d < best.d)) best = { i, d, t };
    }
    return best;
  }
  const editable = (kind, o) => kind !== 'tree' && kind !== 'revit' && (kind !== 'mass' || !!o.prm);
  /** The edge the Add point tool would split: any outline object or block edge. → { kind, id, i | a,b, t } */
  function pointTarget(ev) {
    let best = null;
    const consider = (r, d) => { if (r && (!best || d < best.d)) best = { ...r, d }; };
    for (const kind of ['lot', 'island', 'drive', 'walk', 'plant', 'mass']) for (const o of list(kind)) {
      if (kind === 'mass' && !o.prm) {
        for (const [a, b] of info(o).edges) {
          const pa = P3(o, o.v[a]), pb = P3(o, o.v[b]); if (!pa || !pb) continue;
          const dx = pb[0] - pa[0], dy = pb[1] - pa[1], L2 = dx * dx + dy * dy || 1, t = Math.max(0, Math.min(1, ((ev.sx - pa[0]) * dx + (ev.sy - pa[1]) * dy) / L2));
          const d = Math.hypot(ev.sx - pa[0] - dx * t, ev.sy - pa[1] - dy * t);
          if (d < 8) consider({ kind, id: o.id, a, b, t }, d);
        }
        continue;
      }
      const e = edgeHit(kind, o, ev, 8); if (e) consider({ kind, id: o.id, i: e.i, t: e.t }, e.d);
    }
    // Not right on a corner (that's a corner already).
    return best && best.t > 0.02 && best.t < 0.98 ? best : null;
  }
  function addPoint(ev) {
    const T = pointTarget(ev);
    if (!T) { flash('Click on an edge to add a corner.'); return; }
    before();
    const o = list(T.kind).find(q => q.id === T.id);
    if (T.a != null) {                                    // free-form block: a new vertex on that edge, ready to drag
      const p = SO.add(o.v[T.a], SO.mul(SO.sub(o.v[T.b], o.v[T.a]), T.t)), vi = SO.splitEdge(o, T.a, T.b, p);
      sk.infos.delete(o.id); sk.sel = { kind: 'mass', id: o.id };
      startOp('move', o, { el: { t: 'v', i: vi, id: o.id }, p0: p.slice(), d: 0 }, ev);
      sk.op.keepUndo = true; return;
    }
    const P = outline(o), n = P.length, a = P[T.i], b = P[(T.i + 1) % n], q = [a[0] + (b[0] - a[0]) * T.t, a[1] + (b[1] - a[1]) * T.t];
    P.splice(T.i + 1, 0, q);
    if (o.rad) o.rad = Object.fromEntries(Object.entries(o.rad).map(([k, r]) => [+k > T.i ? +k + 1 : +k, r]));      // rounded corners keep their place
    if (o.prm) regen(o);
    sk.sel = { kind: T.kind, id: o.id };
    // Keep the button held to drag the new corner straight away.
    const z = handleZ(T.kind, o)(q), start = ev.at?.(z) || ev.xy || q;
    sk.drag = { kind: T.kind, id: o.id, h: { t: 'v', i: T.i + 1 }, z, start, orig: JSON.stringify(o), carry: [], pushed: true, sx: ev.sx, sy: ev.sy };
    sk.hovE = null; changed(true);
  }
  /** The corner the Radius tool would round: a drive-aisle curb return, or a corner of a lot / island / planting bed
   *  (picked at the corner or on its arc when it's already rounded). */
  function radiusTarget(ev) {
    let best = null;
    const consider = (q, r, tol = 14) => { if (!q) return; const d = Math.hypot(q[0] - ev.sx, q[1] - ev.sy); if (d < tol && (!best || d < best.d)) best = { ...r, d, q }; };
    for (const c of joins().corners) {
      const d = sk.model.drives[c.di], key = `${Math.round(c.p[0])},${Math.round(c.p[1])}`;
      consider(scr(c.p), { type: 'joint', di: c.di, p: c.p, key, r: d.rj?.[key] ?? d.r ?? 15 });
    }
    for (const kind of ['island', 'lot', 'plant']) for (const o of list(kind)) {
      const P = o.pts, n = P.length, zf = handleZ(kind, o), def = kind === 'island' ? (o.r ?? 3) : 0;
      P.forEach((p, i) => {
        const r = o.rad?.[i] ?? def, info0 = { type: 'vertex', kind, id: o.id, i, p, r };
        consider(scr(p, zf(p)), info0);
        if (r > 0) {                                     // the middle of its arc
          const arc = roundEach([P[(i - 1 + n) % n], p, P[(i + 1) % n]], k => (k === 1 ? r * perFt() : 0));
          const m = arc[Math.floor(arc.length / 2)]; consider(scr(m, zf(m)), { ...info0, p: m });
        }
      });
    }
    return best;
  }
  function setCornerR(T, r) {
    if (T.type === 'joint') { const d = sk.model.drives[T.di]; d.rj = { ...(d.rj || {}), [T.key]: r }; return; }
    const o = list(T.kind).find(q => q.id === T.id); if (!o) return;
    o.rad = { ...(o.rad || {}), [T.i]: r };
  }
  function applyRadius(ev) {
    const T = radiusTarget(ev);
    if (!T) { flash('Click a corner of a lot, island or planting bed, or a curb return where an aisle meets the lot or the street.'); return; }
    // A sharp corner takes the radius in the box; a rounded one keeps its radius — either way the box opens to type a new one.
    before();
    if (!(T.r > 0)) { setCornerR(T, sk.radius); T.r = sk.radius; }
    sk.hovR = null; changed();
    openRadiusPop(T);
  }
  // A small box at the corner to type its radius.
  const rpop = document.createElement('div');
  rpop.className = 'sk-rpop'; rpop.hidden = true;
  rpop.innerHTML = '<span>Radius</span><input type="number" min="0" max="500" step="1"><span class="sk-u"></span><button type="button" data-rp="ok" title="Enter">✓</button><button type="button" data-rp="x" title="Make it sharp">0</button>';
  L.DomEvent.disableClickPropagation(rpop); L.DomEvent.disableScrollPropagation(rpop);
  function openRadiusPop(T) {
    (sk.v3 ? sk.v3.el.parentElement : map.getContainer()).appendChild(rpop);
    const q = scr(T.p, T.type === 'vertex' ? handleZ(T.kind, list(T.kind).find(o => o.id === T.id))(T.p) : undefined) || T.q;
    rpop.style.left = `${Math.round(q[0] + 14)}px`; rpop.style.top = `${Math.round(q[1] - 16)}px`;
    rpop.querySelector('.sk-u').textContent = uLen();
    const inp = rpop.querySelector('input'); inp.value = String(+T.r.toFixed(1));
    rpop.hidden = false; rpop.T = T;
    setTimeout(() => { inp.focus(); inp.select(); }, 0);
  }
  const closeRadiusPop = () => { rpop.hidden = true; rpop.T = null; };
  sk.rpopClose = closeRadiusPop;
  const commitRadius = v => {
    const T = rpop.T; if (!T) return;
    const r = Math.max(0, Math.min(500, Number(v)));
    if (!Number.isFinite(r) || r === T.r) { closeRadiusPop(); return; }
    before(); setCornerR(T, r); T.r = r; sk.radius = r || sk.radius;
    const inp = bar.querySelector('[data-fly="radius"]'); if (inp && r) inp.value = String(r);
    changed(); closeRadiusPop();
  };
  rpop.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') commitRadius(e.target.value); if (e.key === 'Escape') closeRadiusPop(); });
  rpop.addEventListener('click', e => { const b = e.target.closest('[data-rp]'); if (!b) return; commitRadius(b.dataset.rp === 'x' ? 0 : rpop.querySelector('input').value); });
  map.on('movestart zoomstart', closeRadiusPop);
  function drawRadiusHover(g) {
    const T = sk.hovR; if (!T || sk.tool !== 'radius') return;
    const q = T.q; if (!q) return;
    g.save(); g.beginPath(); g.arc(q[0], q[1], 9, 0, Math.PI * 2); g.strokeStyle = ORANGE; g.lineWidth = 2.5; g.stroke(); g.restore();
    tag(g, q, T.r > 0 ? `R ${+T.r.toFixed(1)} ${uLen()} — click to change` : `round · R ${sk.radius} ${uLen()}`);
  }
  function drawEdgeHover(g) {
    const e = sk.hovE; if (!e) return;
    const o = list(e.kind)?.find(q => q.id === e.id); if (!o) return;
    let a, b;
    if (e.a != null) { a = P3(o, o.v[e.a]); b = P3(o, o.v[e.b]); }
    else { const P = outline(o), zf = handleZ(e.kind, o), pa = P[e.i], pb = P[(e.i + 1) % P.length]; a = scr(pa, zf(pa)); b = scr(pb, zf(pb)); }
    if (!a || !b) return;
    g.save(); g.beginPath(); g.moveTo(...a); g.lineTo(...b); g.strokeStyle = ORANGE; g.lineWidth = 4; g.globalAlpha = 0.85; g.stroke();
    if (sk.tool === 'point') { const x = a[0] + (b[0] - a[0]) * e.t, y = a[1] + (b[1] - a[1]) * e.t; g.globalAlpha = 1; g.beginPath(); g.rect(x - 5, y - 5, 10, 10); g.fillStyle = '#fff'; g.fill(); g.strokeStyle = ORANGE; g.lineWidth = 2; g.stroke(); }
    g.restore();
  }
  function hit(ev) {
    const o = findSel();
    if (o) for (const h of handles(sk.sel.kind, o)) { const q = scr(h.p, h.z); if (q && Math.hypot(q[0] - ev.sx, q[1] - ev.sy) < (h.t === 'r' || h.t === 's' ? 10 : 7)) return { kind: sk.sel.kind, id: o.id, h, z: h.z }; }
    // An edge of the selection: drag it to reshape.
    if (o && sk.sel.kind !== 'note' && editable(sk.sel.kind, o)) { const e = edgeHit(sk.sel.kind, o, ev); if (e) { const P = outline(o); return { kind: sk.sel.kind, id: o.id, h: { t: 'e', i: e.i }, z: handleZ(sk.sel.kind, o)(P[e.i]) }; } }
    if (sk.v3) { const p = sk.v3.pickSketch(ev.sx, ev.sy); if (p && p.id) return { kind: 'mass', id: p.id, z: p.at[2] }; }
    const xy = ev.xy; if (!xy) return null;
    const zg = zGround(xy);
    if (!sk.v3) {
      const ms = sk.model.masses.slice().sort((a, b) => massTop(b) - massTop(a));
      for (const m of ms) if (info(m).top(...xy)) return { kind: 'mass', id: m.id, z: 0 };
    }
    const tol = sk.v3 ? 0 : 4 / ctx.affine(sk.site).scale;
    const rb = rvHit(xy); if (rb) return { kind: 'revit', id: rb.id, z: zg };
    for (const t of sk.model.trees) if (Math.hypot(xy[0] - t.pts[0][0], xy[1] - t.pts[0][1]) < Math.max(t.d / 2 * perFt(), tol * 2)) return { kind: 'tree', id: t.id, z: zg };
    for (const w of sk.model.walks) for (let i = 0; i < w.pts.length - 1; i++) if (distSeg(xy, w.pts[i], w.pts[i + 1]) < (w.w || 5) * perFt() / 2 + tol) return { kind: 'walk', id: w.id, z: zg };
    for (const d of sk.model.drives) for (let i = 0; i < d.pts.length - 1; i++) if (distSeg(xy, d.pts[i], d.pts[i + 1]) < (d.w || 24) * perFt() / 2 + tol) return { kind: 'drive', id: d.id, z: zg };
    for (const i of sk.model.islands) if (inPoly(i.pts, ...xy)) return { kind: 'island', id: i.id, z: zg };
    for (const l of sk.model.lots) if (inPoly(l.pts, ...xy)) return { kind: 'lot', id: l.id, z: zg };
    for (const pl of sk.model.plants) if (inPoly(pl.pts, ...xy)) return { kind: 'plant', id: pl.id, z: zg };
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
    for (const w of sk.model.walks) if (w.id !== exclude) {
      ring(w.pts, 'sidewalk', false);
      for (const [a, b] of walkEdges(w)) segs.push({ a, b, t: 'sidewalk edge' });
    }
    for (const pl of sk.model.plants) if (pl.id !== exclude) ring(pl.pts, 'planting');
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
    if (isLine(kind)) {
      let Ln = 0; for (let i = 1; i < pts.length; i++) Ln += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      if (pts.length < 2 || Ln / perFt() < (kind === 'walk' ? 3 : 10)) { draw(); return; }
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
      else if (kind === 'walk') o.w = sk.walkW;
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
      if (d < 12 && (!best || best.t !== 'v' || d < best.d)) best = { t: 'v', i, p: m.v[i].slice(), d, outer: L === m.f[fi].o };
    }
    if (best) return best;
    for (const L of SO.faceLoops(m, fi)) for (let k = 0; k < L.length; k++) {
      const a = L[k], b = L[(k + 1) % L.length], sa = P3(m, m.v[a]), sb = P3(m, m.v[b]); if (!sa || !sb) continue;
      const d = distSeg(q, sa, sb);
      if (d < 14 && (!best || d < best.d)) {
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
    const prev = d.pts?.length && !d.pending ? d.pts[d.pts.length - 1].p : d.pts?.[0]?.p;
    let res = s;
    if (!s.t && prev && !ev.alt) {
      const F = SO.faceFrame(m, d.fi), w = SO.sub(p, prev), cu = SO.dot(w, F.u), cv = SO.dot(w, F.v);
      const ang = Math.atan2(Math.abs(cv), Math.abs(cu));
      if (ev.shift || ang < 3 * Math.PI / 180 || ang > 87 * Math.PI / 180) {
        const alongU = Math.abs(cu) >= Math.abs(cv);
        res = { p: SO.add(prev, SO.mul(alongU ? F.u : F.v, alongU ? cu : cv)), axis: true };
      }
    }
    // A line never runs past the face: it stops on the edge where it would leave (a strong snap to the edge).
    if (!res.t && !SO.inFace(m, d.fi, res.p)) return faceClamp(m, d.fi, prev, res.p);
    return res;
  }
  /** Where a line from prev toward p first meets the face's boundary (or the boundary point nearest p). */
  function faceClamp(m, fi, prev, p) {
    const F = SO.faceFrame(m, fi), O = m.v[m.f[fi].o[0]];
    const to2 = q => [SO.dot(SO.sub(q, O), F.u), SO.dot(SO.sub(q, O), F.v)];
    const P1 = to2(p), P0 = prev ? to2(prev) : null;
    let best = null;
    for (const L of SO.faceLoops(m, fi)) for (let k = 0; k < L.length; k++) {
      const a = L[k], b = L[(k + 1) % L.length], A = to2(m.v[a]), B = to2(m.v[b]), outer = L === m.f[fi].o;
      const ex = B[0] - A[0], ey = B[1] - A[1];
      if (P0) {
        const rx = P1[0] - P0[0], ry = P1[1] - P0[1], den = rx * ey - ry * ex;
        if (Math.abs(den) > 1e-12) {
          const t = ((A[0] - P0[0]) * ey - (A[1] - P0[1]) * ex) / den, u = ((A[0] - P0[0]) * ry - (A[1] - P0[1]) * rx) / den;
          if (t > 1e-6 && t <= 1 + 1e-9 && u >= -1e-9 && u <= 1 + 1e-9 && (!best || best.cross === undefined || t < best.cross)) best = { cross: t, a, b, u, outer };
          continue;
        }
      }
      if (best?.cross !== undefined) continue;
      const L2 = ex * ex + ey * ey || 1, u = Math.max(0, Math.min(1, ((P1[0] - A[0]) * ex + (P1[1] - A[1]) * ey) / L2));
      const dd = Math.hypot(P1[0] - A[0] - ex * u, P1[1] - A[1] - ey * u);
      if (!best || dd < best.dd) best = { dd, a, b, u, outer };
    }
    if (!best) return { p };
    const { a, b, u, outer } = best, Lab = SO.len(SO.sub(m.v[b], m.v[a])) || 1;
    if (u * Lab < 0.5 * perFt()) return { t: 'v', i: a, p: m.v[a].slice(), outer };
    if ((1 - u) * Lab < 0.5 * perFt()) return { t: 'v', i: b, p: m.v[b].slice(), outer };
    return { t: 'e', a, b, p: SO.add(m.v[a], SO.mul(SO.sub(m.v[b], m.v[a]), u)), outer };
  }
  /** A drag from one outer edge to another splits the face (a line), rather than drawing a rectangle. */
  const splitDrag = d => { const a = d.pts[0], b = d.b; return !!(a?.t && b?.t && a.outer && b.outer && !(a.t === 'e' && b.t === 'e' && a.a === b.a && a.b === b.b) && !(a.t === 'v' && b.t === 'v' && a.i === b.i)); };
  function penRect(d, m) {
    const F = SO.faceFrame(m, d.fi), a = d.pts[0].p, b = d.b.p;
    const du = SO.dot(SO.sub(b, a), F.u), dv = SO.dot(SO.sub(b, a), F.v);
    return [a, SO.add(a, SO.mul(F.u, du)), SO.add(SO.add(a, SO.mul(F.u, du)), SO.mul(F.v, dv)), SO.add(a, SO.mul(F.v, dv))];
  }
  function drawPenFace(g, d) {
    const m = massById(d.id); if (!m) return;
    if (facePath(g, m, d.fi)) { g.fillStyle = 'rgba(232,145,63,0.12)'; g.fill('evenodd'); }
    const asLine = d.rect && splitDrag(d), asRect = d.rect && !asLine;
    const P = asLine ? [d.pts[0].p, d.b.p] : asRect ? penRect(d, m) : [...d.pts.map(s => s.p), ...(d.hover ? [d.hover.p] : [])];
    const Q = P.map(p => P3(m, p));
    if (Q.length > 1 && Q.every(Boolean)) {
      g.beginPath(); Q.forEach((q, i) => (i ? g.lineTo(...q) : g.moveTo(...q))); if (asRect) g.closePath();
      const ok = !asRect || P.every(p => SO.inFace(m, d.fi, p));
      g.setLineDash([6, 4]); g.strokeStyle = ok ? ORANGE : '#ef4444'; g.lineWidth = 2; g.stroke(); g.setLineDash([]);
    }
    for (const s of [...d.pts, ...(d.hover ? [d.hover] : []), ...(d.rect && d.b ? [d.b] : [])]) {
      const q = P3(m, s.p); if (!q) continue;
      g.beginPath();
      if (s.t === 'v') g.rect(q[0] - 5, q[1] - 5, 10, 10); else g.arc(q[0], q[1], s.t === 'e' ? 5 : 3.5, 0, Math.PI * 2);
      g.fillStyle = s.t === 'v' ? '#22c55e' : s.t === 'e' ? (s.mid ? '#06b6d4' : '#ef4444') : ORANGE; g.fill();
    }
    if (asLine) tag(g, P3(m, d.b.p), `split · ${fmtLen(SO.len(SO.sub(d.b.p, d.pts[0].p)))}`);
    else if (asRect) { const R = penRect(d, m); const w = SO.len(SO.sub(R[1], R[0])), h = SO.len(SO.sub(R[3], R[0])); tag(g, P3(m, d.b.p), `${fmtLen(w)} × ${fmtLen(h)}`); }
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
    if (!op.moved) { resetOp(m); if (op.keepUndo) { sk.infos.delete(m.id); changed(); } else { sk.undo.pop(); draw(); card(); } return; }
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
    if (k === 'b' || k === 'r') return dgs().bldg;
    if (k === 't') return dgs().tree;
    return colorOf(scheme(), k === 'i' || k === 'g' ? 'green' : k === 'w' ? 'plaza' : 'lot');
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
      if (h?.kind === 'revit') return { key: `r:${h.id}` };
    }
    const xy = ev.xy; if (!xy) return null;
    if (!sk.v3) { const ms = sk.model.masses.slice().sort((a, b) => massTop(b) - massTop(a)); for (const m of ms) if (info(m).top(...xy)) return { key: `m:${m.id}` }; }
    if (!sk.v3) { const rb = rvHit(xy); if (rb) return { key: `r:${rb.id}` }; }
    const tree = !sk.v3 && ctx.pickContext?.(xy, 'tree'); if (tree) return { key: `t:${tree}` };
    for (const t of sk.model.trees) if (Math.hypot(xy[0] - t.pts[0][0], xy[1] - t.pts[0][1]) < t.d / 2 * perFt()) return { key: `t:${treeKeyOf(t)}` };
    for (const i of sk.model.islands) if (inPoly(shapeOf(i, 'island'), ...xy)) return { key: `i:${i.id}` };
    for (const w of sk.model.walks) for (let i = 0; i < w.pts.length - 1; i++) if (distSeg(xy, w.pts[i], w.pts[i + 1]) < (w.w || 5) * perFt() / 2) return { key: `w:${w.id}` };
    for (const d of sk.model.drives) for (let i = 0; i < d.pts.length - 1; i++) if (distSeg(xy, d.pts[i], d.pts[i + 1]) < (d.w || 24) * perFt() / 2) return { key: `d:${d.id}` };
    for (const l of sk.model.lots) if (inPoly(l.pts, ...xy)) return { key: `l:${l.id}` };
    const b = !sk.v3 && ctx.pickContext?.(xy, 'bldg'); if (b) return { key: `b:${b}` };
    for (const pl of sk.model.plants) if (inPoly(pl.pts, ...xy)) return { key: `g:${pl.id}` };
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
    // The selected free-form block: its corners and edges drag without Ctrl.
    if (t === 'select' && !ev.alt && sk.sel?.kind === 'mass') {
      const m = massById(sk.sel.id);
      if (m && !m.prm) {
        const el = pickElement(ev, m.id);
        if (el && el.t !== 'f') { before(); const p0 = el.t === 'v' ? m.v[el.i].slice() : SO.add(m.v[el.a], SO.mul(SO.sub(m.v[el.b], m.v[el.a]), 0.5)); startOp('move', m, { el, p0, d: 0 }, ev); return true; }
      }
    }
    if (t === 'point') { addPoint(ev); return true; }
    if (t === 'radius') { applyRadius(ev); return true; }
    if (t === 'tree') { const xy = groundSnap(ev, null); if (!xy) return true; sk.draw = { treeDraw: true, c: xy, r: sk.treeD / 2 * perFt(), cp: [ev.sx, ev.sy] }; draw(); return true; }
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
        if (!isLine(sk.draw.kind) && sk.draw.pts.length >= 3 && q && Math.hypot(q[0] - ev.sx, q[1] - ev.sy) < 10) { finishDraw(sk.draw.pts); return true; }
        let xy = groundSnap(ev, sk.draw.pts.at(-1), { own: sk.draw.pts }); if (!xy) return true;
        if (sk.draw.pts.length === 1) xy = perpSnap(sk.draw, xy, ev);
        sk.draw.pts.push(xy);
        draw(); return true;
      }
      const xy = groundSnap(ev, null); if (!xy) return true;
      sk.draw = { kind, shape: t === 'mass' ? sk.shape : 'box', a: xy, b: xy, cp: [ev.sx, ev.sy], rect: false, pending: true, frame: isLine(kind) ? 0 : frameNear(xy), perpN: null };
      if (kind === 'drive' && !ev.alt) { const we = walkEdgeNormal(xy); if (we) { sk.draw.perpN = we.n; sk.draw.a = sk.draw.b = we.p; } }
      card();
      return true;
    }
    // Accessible spaces: drag them along the rows (the lot re-lays itself around them).
    if (!ev.alt && !ev.shift && ev.xy) for (const l of sk.model.lots) {
      if (!lotLayout(l).stalls.some(st => (st.acc || st.aisle) && inPoly(st.pts, ...ev.xy))) continue;
      before(); sk.drag = { kind: 'lot', id: l.id, accLot: true, pushed: true, sx: ev.sx, sy: ev.sy };
      sk.sel = { kind: 'lot', id: l.id }; draw(); panel(); card(); return true;
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
      if (P.length > (closed(h.kind) ? 3 : 2)) { before(); P.splice(h.h.i, 1); if (src.rad) src.rad = Object.fromEntries(Object.entries(src.rad).filter(([k]) => +k !== h.h.i).map(([k, r]) => [+k > h.h.i ? +k - 1 : +k, r])); if (src.prm) regen(src); changed(); }
      return true;
    }
    if (h.kind === 'revit') { sk.sel = { kind: 'revit', id: h.id }; draw(); panel(); card(); return true; }   // placed by Revit: select only
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
    if (d?.treeDraw) {
      if (!d.sized && Math.hypot(ev.sx - d.cp[0], ev.sy - d.cp[1]) > 6) d.sized = true;
      if (d.sized && ev.xy) d.r = Math.max(1.5 * perFt(), Math.hypot(ev.xy[0] - d.c[0], ev.xy[1] - d.c[1]));
      draw(); return;
    }
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
        let b = isLine(d.kind) ? groundSnap(ev, d.a, { own: [d.a] }) : groundSnap({ ...ev, shift: false }, null);
        if (!b) return;
        b = perpSnap(d, b, ev);
        d.b = b; d.square = ev.shift && !isLine(d.kind); draw();
      }
      return;
    }
    if (d?.pts) { let xy = groundSnap(ev, d.pts.at(-1), { own: d.pts }); if (xy) { if (d.pts.length === 1) xy = perpSnap(d, xy, ev); d.hover = xy; draw(); } return; }
    if (!sk.drag && sk.tool === 'radius') {
      const T = radiusTarget(ev), k = T ? JSON.stringify([T.type, T.id, T.di, T.i, T.key, Math.round(T.q[0]), Math.round(T.q[1])]) : '';
      if (k !== (sk.hovRKey || '')) { sk.hovR = T; sk.hovRKey = k; draw(); }
      return;
    }
    if (!sk.drag) {                                   // hover feedback for the face tools / Ctrl-move / the selection's edges
      const so = sk.tool === 'select' && !ev.ctrl ? findSel() : null;
      if (sk.tool === 'point' || (so && sk.sel.kind !== 'note' && editable(sk.sel.kind, so))) {
        const e = sk.tool === 'point' ? pointTarget(ev) : (() => { const x = edgeHit(sk.sel.kind, so, ev); return x && { kind: sk.sel.kind, id: so.id, i: x.i, t: x.t }; })();
        const k2 = e ? JSON.stringify([e.kind, e.id, e.i, e.a, e.b, sk.tool === 'point' ? Math.round(e.t * 50) : 0]) : '';
        if (k2 !== (sk.hovEKey || '')) { sk.hovE = e; sk.hovEKey = k2; draw(); }
        if (sk.tool === 'point') return;
      } else if (sk.hovE) { sk.hovE = null; sk.hovEKey = ''; draw(); }
      const freeSel = sk.tool === 'select' && !ev.ctrl && sk.sel?.kind === 'mass' && !massById(sk.sel.id)?.prm;
      const want = sk.tool === 'push' || sk.tool === 'slope' || sk.tool === 'pen' || (sk.tool === 'select' && ev.ctrl) || freeSel;
      let h = want ? (sk.tool === 'select' ? pickElement(ev, freeSel ? sk.sel.id : null) : (() => { const f = pickFace(ev); return f && { id: f.id, t: 'f', fi: f.fi }; })()) : null;
      if (freeSel && h?.t === 'f') h = null;
      const key = h ? JSON.stringify([h.id, h.t, h.fi, h.i, h.a, h.b]) : '';
      // Before the first click, show what the start point would snap to.
      const pre = ['mass', 'lot', 'island', 'drive', 'walk', 'plant', 'tree'].includes(sk.tool) || (sk.tool === 'pen' && !h);
      const had = !!sk.snap;
      if (pre) groundSnap(ev, null); else sk.snap = null;
      if (key !== (sk.hovKey || '') || pre || had) { sk.hov = h; sk.hovKey = key; draw(); }
      return;
    }
    const g = sk.drag, o = list(g.kind).find(q => q.id === g.id);
    if (!o) return;
    if (g.accLot) { if (ev.xy && Math.hypot(ev.sx - g.sx, ev.sy - g.sy) > 3) { o.accAt = ev.xy.slice(); g.moved = true; sk.layouts.delete?.(o.id); dragged(); } return; }
    const cur = ev.at(g.z); if (!cur) return;
    if (!g.pushed) { before(); g.pushed = true; }
    const dx = cur[0] - g.start[0], dy = cur[1] - g.start[1];
    const orig = JSON.parse(g.orig);
    for (const k of ['pts', 'v', 'f', 'prm', 'angle']) if (k in orig) o[k] = orig[k];
    const P = outline(o), n = P.length, t = g.h?.t;
    if (t === 'e') {
      // Edge: slides square to itself (Shift = any direction); the far corner snaps.
      const i = g.h.i, j = (i + 1) % n, a = P[i], b = P[j];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, nx = -(b[1] - a[1]) / L, ny = (b[0] - a[0]) / L;
      let mx = dx, my = dy;
      if (!ev.shift) { const k = dx * nx + dy * ny; mx = nx * k; my = ny * k; }
      if (!ev.alt && (!sk.v3 || g.kind !== 'mass')) {
        const S = snapCands(g.kind, o.id), sn = snapMove([[a[0] + mx, a[1] + my], [b[0] + mx, b[1] + my]], S.C, q => scr(q));
        if (sn) { if (ev.shift) { mx += sn.dx; my += sn.dy; } else { const k = sn.dx * nx + sn.dy * ny; mx += nx * k; my += ny * k; } sk.snap = { p: sn.p, t: 'corner', label: sn.label, guides: [] }; } else sk.snap = null;
      }
      P[i] = [a[0] + mx, a[1] + my]; P[j] = [b[0] + mx, b[1] + my];
      if (o.prm) regen(o);
    } else if (t === 'v') {
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
    if (d?.treeDraw) {
      sk.draw = null; before();
      const D = Math.round(d.r * 2 / perFt());
      const o = { id: uid(), pts: [d.c.slice()], d: D, h: Math.round(Math.max(12, Math.min(80, D * 1.2))), form: sk.treeForm || 'broadleaf' };
      sk.model.trees.push(o); if (d.sized) sk.treeD = D;
      const inp = bar.querySelector('[data-fly="treeD"]'); if (inp) inp.value = String(sk.treeD);
      changed(); return;
    }
    if (d?.face) {
      if (d.rect) { if (splitDrag(d)) { d.pts = [d.pts[0], d.b]; penFinish('split'); } else penFinish('rect'); return; }
      if (d.pending) { d.pending = false; draw(); }       // a click: carry on clicking points
      return;
    }
    if (d && !d.pts) {
      if (d.rect && d.kind === 'drive') { sk.draw = { kind: d.kind, shape: d.shape, pts: [d.a, d.b], perpN: d.perpN }; flash('Click to bend the aisle — double-click, Enter or Esc to finish.'); draw(); return; }
      if (d.rect) { finishDraw(drawPts()); return; }
      sk.draw = { kind: d.kind, shape: d.shape, pts: [d.a], perpN: d.perpN }; draw(); return;   // a click without dragging starts an outline
    }
    if (sk.drag) { const { moved, accLot } = sk.drag; sk.drag = null; if (moved) changed(true); else { if (accLot) sk.undo.pop(); card(); } }
  }
  function finishOutline() {
    if (sk.set === 'diagram') { finishNoteOutline(); return; }
    const d = sk.draw;
    if (d?.face) { if (d.pts.length >= 3 && !d.pts[0].t) penFinish('loop'); return; }
    if (!d?.pts) return;
    const P = d.pts.slice();
    if (P.length > 2 && Math.hypot(P.at(-1)[0] - P.at(-2)[0], P.at(-1)[1] - P.at(-2)[1]) < 1e-6) P.pop();
    if (P.length >= (isLine(d.kind) ? 2 : 3)) finishDraw(P);
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
    if (e.key === 'Escape' && sk.rpopClose && !rpop.hidden) { sk.rpopClose(); return true; }
    if (typing(e)) { if (e.key === 'Escape' || e.key === 'Enter') e.target.blur(); return false; }
    const k = e.key;
    if (k === 'Escape') {
      if (sk.op) { const m = massById(sk.op.id); if (m) resetOp(m); sk.op = null; sk.baseLock = null; sk.undo.pop(); changed(true); }
      else if (sk.draw?.kind === 'drive' && sk.draw.pts?.length >= 2) finishOutline();
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
      <p class="hint sk-req-src">${(() => { const c = sk.model.ratioSrc?.id && CODES.find(x => x.id === sk.model.ratioSrc.id); return c ? `Required spaces: ${escapeHtml(c.place)}, ${c.state} code${sk.model.ratioSrc.edited ? ' (edited)' : ''} <span class="qm" data-tip-text="${escapeHtml(`${c.title}. ${c.amended}. Checked ${c.checked}.`)}">?</span> — <button type="button" class="linkish" data-settings="sketch" data-focus="sk-ratios">ratios</button>` : `Required spaces use example ratios — ${jurName() ? `no verified code for ${escapeHtml(jurName())} yet` : 'no verified code for this site'}. <button type="button" class="linkish" data-settings="sketch" data-focus="sk-ratios">Set ratios</button>`; })()}</p>
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
      ...sk.model.walks.map(w => ({ kind: 'walk', o: w, t: `Sidewalk · ${w.w || 5} ${uLen()} wide`, c: colorOf(scheme(), 'plaza') })),
      ...sk.model.plants.map(pl => ({ kind: 'plant', o: pl, t: `Planting · ${fmtArea(area(pl.pts) * sfPerNative2())}`, c: colorOf(scheme(), 'green') })),
      ...sk.model.rvbs.map(o => ({ kind: 'revit', o, t: `Revit · ${o.name || 'building'}${o.gfa ? ` · ${fmtArea(o.gfa)}` : ''}`, c: '#94a3b8' })),
      ...(sk.model.trees.length ? [{ kind: 'tree', o: sk.model.trees[0], t: `Trees · ${sk.model.trees.length} new`, c: '#3f8a4a' }] : []),
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
    const src = sk.model.ratioSrc, code = src?.id ? CODES.find(c => c.id === src.id) || null : null;
    const J = sk.jur, nm = jurName();
    const fmtD = d => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    let head;
    if (code) {
      const tip = `${code.title}. ${code.amended}. Checked ${fmtD(code.checked)}.\n\n${code.notes.join('\n')}`;
      head = `<div class="sk-rsrc ok"><span>From the <b>${escapeHtml(code.place)}, ${code.state}</b> code${src.edited ? ' <em>(edited)</em>' : ''} <span class="qm" data-tip-title="Parking code" data-tip-text="${escapeHtml(tip)}">?</span></span>
        <a href="${code.url}" target="_blank" rel="noopener">Source ↗</a>${src.edited ? '<button type="button" class="linkish" data-rcode>Reset to code</button>' : ''}</div>`;
    } else if (J?.loading) head = '<div class="sk-rsrc">Looking up the site\'s city…</div>';
    else if (J?.err) head = '<div class="sk-rsrc warn">Couldn\'t look up the site\'s city (US Census TIGERweb didn\'t answer). These ratios are examples, not from any code — enter the local requirement.</div>';
    else head = `<div class="sk-rsrc warn">${nm ? `The site is in <b>${escapeHtml(nm)}</b>` : 'The site is outside any incorporated city (county rules apply)'} — the app doesn't have a verified parking code for it yet. These ratios are examples, not from any code; enter the local requirement.</div>`;
    const html = head + scheme().uses.map(u => {
      const r = sk.model.ratios[u.key] || { mode: 'ksf', r: 0 };
      const R = code?.uses[u.key];
      const info = R ? `<span class="qm" data-tip-title="Where this ratio comes from" data-tip-text="${escapeHtml(`${R.text}\n\nSource: ${code.title}.`)}">?</span>` : '';
      return `<div class="sk-ratio${r.need ? ' need' : ''}" data-use="${u.key}"><i style="background:${u.color}"></i><span>${escapeHtml(u.label)}${info}</span>
        <input type="number" min="0" step="0.1" value="${r.need ? '' : +Number(r.r).toFixed(2)}" placeholder="${r.need ? 'enter' : ''}" data-f="r" aria-label="Spaces">
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
      if (f === 'r') { delete r.need; delete r.tiers; }
      sk.model.ratioSrc = { ...(sk.model.ratioSrc || { id: null }), edited: true };
      if (r.mode === 'unit' && !r.unitSf) r.unitSf = 900;
      $('sk-ratios').dataset.html = ''; changed(true);
    });
    $('dg-colors')?.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.dgk) setDg(b.dataset.dgk, b.dataset.dgc);
      if ('dgclear' in b.dataset) { before(); sk.model.paint = {}; changed(); }
    });
    $('dg-colors')?.addEventListener('change', e => { if (e.target.type === 'color') setDg(e.target.dataset.dgk, e.target.value); });
    $('sk-ratios').addEventListener('click', e => { if (e.target.closest('[data-rcode]') && sk.jur?.code) { sk.model.ratioSrc = null; applyCode(sk.jur.code); } });
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
    }).concat(sk.model.rvbs.map(o => {
      const I = rvInfo(o), [x0, y0, x1, y1] = I.bb, ring = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
      return { ring, massRing: ring, base: I.zmin, top: I.zmax, roofAt: I.roofAt, sketch: true, revit: true };
    }));
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
    const lines = [], acc = [], islands = [], drives = [], marks = [], extra = [], lotPave = [];
    /** A flat outline draped on the ground: triangles split until they follow it (≤ 8 ft sides). */
    const tess = (P, arr, lift) => {
      const maxL = 8 * perFt();
      const sub = (a, b, c, depth) => {
        const L = Math.max(Math.hypot(a[0] - b[0], a[1] - b[1]), Math.hypot(b[0] - c[0], b[1] - c[1]), Math.hypot(c[0] - a[0], c[1] - a[1]));
        if (L <= maxL || depth > 7) { for (const q of [a, b, c]) arr.push(q[0], q[1], zGround(q) + 0.15 + lift); return; }
        const ab = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], bc = [(b[0] + c[0]) / 2, (b[1] + c[1]) / 2], ca = [(c[0] + a[0]) / 2, (c[1] + a[1]) / 2];
        sub(a, ab, ca, depth + 1); sub(ab, b, bc, depth + 1); sub(ca, bc, c, depth + 1); sub(ab, bc, ca, depth + 1);
      };
      if (P.length >= 3) for (const [i, j, k] of ctx.triangulate(P)) sub(P[i], P[j], P[k], 0);
    };
    /** Painted items (diagram) get their own mesh and colour. */
    const own = (key, def) => { if (!diagramOn() || !sk.model.paint?.[key]) return def; const arr = []; extra.push({ tris: arr, color: resolveC(sk.model.paint[key]), role: { l: 'paving', d: 'paving', i: 'island', w: 'walk', g: 'planting' }[key[0]] }); return arr; };
    const z = (x, y) => zGround([x, y]) + 0.15;
    const curb = 0.5 * outPerFt();
    const planter = (P, out = islands) => {
      if (P.length < 3) return;
      const top = Math.max(...P.map(p => zGround(p))) + curb;
      for (const [i, j, k] of ctx.triangulate(P)) out.push(...P[i], top, ...P[j], top, ...P[k], top);
      for (let i = 0; i < P.length; i++) { const a = P[i], b = P[(i + 1) % P.length], za = zGround(a) - 0.2, zb = zGround(b) - 0.2; out.push(...a, za, ...b, zb, ...b, top, ...a, za, ...b, top, ...a, top); }
    };
    // A strip a→b, w wide, cut into short pieces so it follows the ground.
    const drape = (a, b, w, outArr, mk = true) => {
      const Ln = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(1, Math.ceil(Ln / (8 * perFt())));
      const nx = -(b[1] - a[1]) / (Ln || 1) * w / 2, ny = (b[0] - a[0]) / (Ln || 1) * w / 2;
      for (let i = 0; i < n; i++) {
        const p = [a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n], q = [a[0] + (b[0] - a[0]) * (i + 1) / n, a[1] + (b[1] - a[1]) * (i + 1) / n];
        const c = [[p[0] + nx, p[1] + ny], [q[0] + nx, q[1] + ny], [q[0] - nx, q[1] - ny], [p[0] - nx, p[1] - ny]].map(r => [...r, z(...r) + 0.05]);
        outArr.push(...c[0], ...c[1], ...c[2], ...c[0], ...c[2], ...c[3]);
        if (mk && i % 2 === 0) marks.push(...p, z(...p) + 0.12, ...q, z(...q) + 0.12);
      }
    };
    for (const l of sk.model.lots) {
      const Lr = lotLayout(l);
      const P = shapeOf(l);
      tess(P, own(`l:${l.id}`, lotPave), -0.07);                 // paving, just under the stall lines
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
    for (const isl of sk.model.islands) planter(shapeOf(isl, 'island'), own(`i:${isl.id}`, islands));
    for (const d of sk.model.drives) { const out = own(`d:${d.id}`, drives); for (let i = 0; i < d.pts.length - 1; i++) drape(d.pts[i], d.pts[i + 1], (d.w || 24) * perFt(), out); }
    const J = joins();
    for (const W of J.wedges) for (let i = 1; i < W.length - 1; i++) for (const q of [W[0], W[i], W[i + 1]]) drives.push(q[0], q[1], z(...q) + 0.05);
    // Sidewalks (draped strips) and planting beds (tessellated so they follow the ground).
    for (const w of sk.model.walks) {
      const arr = []; extra.push({ tris: arr, color: siteColor(`w:${w.id}`, 'plaza'), role: 'walk' });
      for (let i = 0; i < w.pts.length - 1; i++) drape(w.pts[i], w.pts[i + 1], (w.w || 5) * perFt(), arr, false);
    }
    for (const pl of sk.model.plants) {
      const arr = []; extra.push({ tris: arr, color: siteColor(`g:${pl.id}`, 'green'), role: 'planting' });
      tess(shapeOf(pl), arr, 0.08);
    }
    for (const [a, b] of J.cuts) lines.push(a[0], a[1], z(...a) + 0.1, b[0], b[1], z(...b) + 0.1);
    for (const d of sk.model.drives) if (d.oneWay) for (const ar of driveArrows(d)) for (let i = 0; i < ar.length - 1; i++) { const [p, q] = [ar[i], ar[i + 1]]; lines.push(p[0], p[1], z(...p) + 0.1, q[0], q[1], z(...q) + 0.1); }
    if (lotPave.length) extra.unshift({ tris: lotPave, color: colorOf(scheme(), 'lot'), role: 'paving' });
    return { lines, acc, islands, drives, marks, extra, stripe: colorOf(scheme(), 'stripe'), accColor: colorOf(scheme(), 'accessible'), lotColor: colorOf(scheme(), 'lot'), greenColor: colorOf(scheme(), 'green') };
  }

  /**
   * What's drawn here, for Revit: blocks (true heights, by use) and the site surfaces as triangle soups —
   * { blocks: [{ id, name, use, color, v: flat [x, y, z] (native XY, output Z), f: [[a, b, c]…] }],
   *   surfaces: { paving, island, walk, planting: flat [x, y, z…] triangles }, colors: { … } }.
   */
  function exportShapes() {
    const blocks = sk.model.masses.filter(m => !info(m).sheet).map(m => {
      const I = info(m), v = [];
      for (const p of m.v) v.push(p[0], p[1], I.base + p[2] / kz());
      return { id: m.id, name: `${useLabel(m)} block · ${I.floors} fl`, use: m.use, color: colorOf(scheme(), m.use), v, f: I.tris.map(t => [t.a, t.b, t.c]), gfa: Math.round(massGfa(m)) };
    });
    const P = parking3d();
    const surfaces = { paving: [...P.drives], island: [...P.islands], walk: [], planting: [] };
    for (const x of P.extra) (surfaces[x.role] || surfaces.paving).push(...x.tris);
    return { blocks, surfaces, colors: { paving: colorOf(scheme(), 'lot'), island: colorOf(scheme(), 'green'), walk: colorOf(scheme(), 'plaza'), planting: colorOf(scheme(), 'green') } };
  }
  /** New trees for the 3D view (same form as lidar trees): { x, y, z (ground), h (output units), r (native), sketch }. */
  function trees3d() {
    return sk.model.trees.map(t => ({ x: t.pts[0][0], y: t.pts[0][1], z: zGround(t.pts[0]), h: t.h * outPerFt(), r: t.d / 2 * perFt(), form: t.form || 'broadleaf', sketch: true }));
  }
  /** Parking paving (lots, drive aisles and their curb returns) and the planted areas inside it (islands, beds). */
  function pavedAreas() {
    const paved = [], keep = [], J = joins();
    for (const l of sk.model.lots) paved.push(shapeOf(l));
    for (const d of sk.model.drives) for (let i = 0; i < d.pts.length - 1; i++) paved.push(lanePoly(d.pts[i], d.pts[i + 1], (d.w || 24) * perFt()));
    for (const W of J.wedges) paved.push(W);
    for (const i of sk.model.islands) keep.push(shapeOf(i, 'island'));
    for (const pl of sk.model.plants) keep.push(shapeOf(pl));
    for (const l of sk.model.lots) for (const isl of lotLayout(l).islands || []) keep.push(islandShape(isl, l.islandR));
    return { paved, keep };
  }
  return {
    trees3d, exportShapes, revit3d, pavedAreas,
    /** A building from Revit replaces the one sent before (one per site for now). */
    setRevitBuilding(o) { before(); const prev = sk.model.rvbs[0]; if (prev) o.use = prev.use || o.use; sk.model.rvbs = [o]; sk.rvCache?.clear(); sk.sel = { kind: 'revit', id: o.id }; changed(); },
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
