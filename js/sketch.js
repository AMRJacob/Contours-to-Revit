// Sketch tab: a light brainstorming tool on the real site — massing blocks and parking lots so far (arrows,
// regions, labels and trees come next). Everything updates live: floor area, parking provided vs required,
// accessible spaces, and the 3D / sun views. Colours come from an editable scheme that travels with the project.
//
// Hotkeys: V select · M massing · P parking · Esc cancel / select · Del delete · Ctrl+Z / Ctrl+Y undo / redo ·
// ↑ ↓ floors (massing) or slide rows (parking) · [ ] turn parking rows · Enter / double-click finish an outline ·
// Alt+drag duplicate · Shift square corners.
import { layoutLot, longestEdgeAngle, PARK_DEFAULTS } from './parking.js?v=0.41.1';
import { BUILTIN_SCHEMES, allSchemes, schemeById, saveScheme, deleteScheme, duplicateScheme, colorOf } from './schemes.js?v=0.41.1';

const TOOLS = [
  { id: 'select', key: 'V', label: 'Select', icon: '<path d="M5 3l14 8-6 1.5L10 19z"/>' },
  { id: 'mass', key: 'M', label: 'Massing', icon: '<path d="M4 9l8-4 8 4v9l-8 4-8-4z"/><path d="M4 9l8 4 8-4M12 13v9" opacity=".6"/>' },
  { id: 'lot', key: 'P', label: 'Parking', icon: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v6M11 4v6M15 4v6M7 20v-6M11 20v-6M15 20v-6" opacity=".7"/>' },
];
const DEFAULT_RATIOS = {   // examples only — every jurisdiction sets its own
  residential: { mode: 'unit', r: 1.5, unitSf: 900 }, office: { mode: 'ksf', r: 3 }, retail: { mode: 'ksf', r: 4 },
  civic: { mode: 'ksf', r: 2.5 }, hospitality: { mode: 'unit', r: 1, unitSf: 450 }, mixed: { mode: 'ksf', r: 3 },
  industrial: { mode: 'ksf', r: 1 }, parking: { mode: 'ksf', r: 0 },
};

export function createSketch(ctx) {
  const { map, $, escapeHtml } = ctx;
  const sk = {
    model: blank(), tool: 'select', sel: null, drag: null, draw: null, undo: [], redo: [], ver: 0,
    site: null, key: null, layouts: new Map(), active: false,
  };
  function blank() {
    return { v: 1, masses: [], lots: [], scheme: JSON.parse(JSON.stringify(BUILTIN_SCHEMES[0])), ratios: JSON.parse(JSON.stringify(DEFAULT_RATIOS)) };
  }
  const scheme = () => sk.model.scheme;
  const id = () => Math.random().toString(36).slice(2, 9);
  const perFt = () => (sk.site ? ctx.unitsPerFt(sk.site) : 1);           // native units per foot
  const sfPerNative2 = () => 1 / perFt() ** 2;
  const metric = () => sk.site?.outUnit === 'm';
  const fmtArea = sf => (metric() ? `${Math.round(sf * 0.092903).toLocaleString()} m²` : `${Math.round(sf).toLocaleString()} sf`);
  const area = P => { let a = 0; for (let i = 0, j = P.length - 1; i < P.length; j = i++) a += P[j][0] * P[i][1] - P[i][0] * P[j][1]; return Math.abs(a) / 2; };
  const centroid = P => { let x = 0, y = 0; for (const p of P) { x += p[0]; y += p[1]; } return [x / P.length, y / P.length]; };
  const inPoly = (P, x, y) => { let c = false; for (let i = 0, j = P.length - 1; i < P.length; j = i++) { const [xi, yi] = P[i], [xj, yj] = P[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c; } return c; };

  // ---------------------------------------------------------------- model helpers
  const massGfa = m => area(m.pts) * sfPerNative2() * m.floors;
  function massBase(m) {
    let lo = Infinity;
    for (const p of [...m.pts, centroid(m.pts)]) { const z = ctx.zAt(...p); if (Number.isFinite(z) && z < lo) lo = z; }
    return Number.isFinite(lo) ? lo : 0;
  }
  const massTop = m => massBase(m) + m.floors * m.ftf;
  function lotLayout(l) {
    const key = JSON.stringify([l.pts, l.stall, l.shift, l.angle, perFt(), nearestMass(l)]);
    const c = sk.layouts.get(l.id);
    if (c && c.key === key) return c.res;
    const res = layoutLot(l.pts, { stall: l.stall, shift: l.shift, angle: l.angle ?? longestEdgeAngle(l.pts), k: perFt(), accNear: nearestMass(l) });
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
  function snapshot() { return JSON.stringify({ masses: sk.model.masses, lots: sk.model.lots }); }
  function before() { sk.undo.push(snapshot()); if (sk.undo.length > 60) sk.undo.shift(); sk.redo.length = 0; }
  function restore(s) { const o = JSON.parse(s); sk.model.masses = o.masses; sk.model.lots = o.lots; if (sk.sel && !findSel()) sk.sel = null; changed(); }
  function changed(soft = false) {
    sk.ver++;
    draw(); panel(); card();
    clearTimeout(sk.saveT);
    sk.saveT = setTimeout(save, 400);
    if (!soft) ctx.onChange?.();
    else { clearTimeout(sk.softT); sk.softT = setTimeout(() => ctx.onChange?.(), 150); }
  }
  async function save() { if (sk.key) await ctx.idb.set(sk.key, sk.model).catch(() => {}); }
  const findSel = () => (sk.sel ? (sk.sel.kind === 'mass' ? sk.model.masses : sk.model.lots).find(o => o.id === sk.sel.id) : null);

  // ---------------------------------------------------------------- site
  async function onSite(site, pending) {
    sk.site = site; sk.sel = null; sk.draw = null; sk.layouts.clear(); sk.undo = []; sk.redo = [];
    if (!site) { sk.key = null; sk.model = blank(); draw(); panel(); return; }
    const b = site.box;
    sk.key = `sketch:${site.zone.code}:${[b.xmin, b.ymin, b.xmax, b.ymax].map(v => Math.round(v / 10)).join(',')}`;
    let m = pending || await ctx.idb.get(sk.key).catch(() => null);
    if (!m || !m.masses) m = blank();
    if (!m.scheme) m.scheme = JSON.parse(JSON.stringify(BUILTIN_SCHEMES[0]));
    if (!m.ratios) m.ratios = JSON.parse(JSON.stringify(DEFAULT_RATIOS));
    sk.model = m;
    if (pending) save();
    sk.ver++;
    draw(); panel(); ctx.onChange?.();
  }

  // ---------------------------------------------------------------- map canvas
  const canvas = document.createElement('canvas');
  canvas.className = 'sketch-canvas'; canvas.hidden = true;
  map.getContainer().appendChild(canvas);
  const toS = (M, p) => ctx.toScreen(M, p[0], p[1]);
  function draw() {
    const site = sk.site, cont = map.getContainer(), dpr = window.devicePixelRatio || 1;
    const W = cont.clientWidth, H = cont.clientHeight;
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); canvas.style.width = `${W}px`; canvas.style.height = `${H}px`;
    }
    const g = canvas.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, canvas.width, canvas.height);
    if (!site || !showOnMap()) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const M = ctx.affine(site), px = M.scale;                 // screen px per native unit
    const path = P => { g.beginPath(); P.forEach((p, i) => { const [x, y] = toS(M, p); i ? g.lineTo(x, y) : g.moveTo(x, y); }); g.closePath(); };
    // Parking lots
    for (const l of sk.model.lots) {
      const L = lotLayout(l), sel = sk.sel?.id === l.id;
      path(l.pts); g.fillStyle = colorOf(scheme(), 'lot'); g.globalAlpha = 0.75; g.fill(); g.globalAlpha = 1;
      if (px * 9 * perFt() > 2.2) {   // stalls only when they're big enough to see
        g.lineWidth = 1; g.strokeStyle = colorOf(scheme(), 'stripe');
        for (const st of L.stalls) {
          if (st.acc) { path(st.pts); g.fillStyle = colorOf(scheme(), 'accessible'); g.fill(); g.strokeStyle = colorOf(scheme(), 'stripe'); g.stroke(); continue; }
          if (st.aisle) { path(st.pts); g.save(); g.clip(); g.strokeStyle = colorOf(scheme(), 'accessible'); g.lineWidth = 1; const [a] = st.pts.map(p => toS(M, p)); for (let d = -60; d < 60; d += 5) { g.beginPath(); g.moveTo(a[0] + d, a[1] - 40); g.lineTo(a[0] + d + 40, a[1] + 40); g.stroke(); } g.restore(); continue; }
          // Two side lines and the back line, like striping.
          const q = st.pts.map(p => toS(M, p));
          g.beginPath(); g.moveTo(...q[0]); g.lineTo(...q[3]); g.lineTo(...q[2]); g.lineTo(...q[1]); g.stroke();
        }
      }
      path(l.pts); g.lineWidth = sel ? 2.5 : 1.5; g.strokeStyle = sel ? '#e8913f' : 'rgba(30,41,59,0.85)'; g.stroke();
      label(g, M, centroid(l.pts), `${L.total} spaces`, L.acc ? `${L.acc} accessible${L.van ? ` (${L.van} van)` : ''}${L.short ? ` · ${L.short} short` : ''}` : '');
    }
    // Massing
    const ms = sk.model.masses.slice().sort((a, b) => massTop(a) - massTop(b));
    for (const m of ms) {
      const sel = sk.sel?.id === m.id, col = colorOf(scheme(), m.use);
      path(m.pts); g.fillStyle = col; g.globalAlpha = 0.88; g.fill(); g.globalAlpha = 1;
      g.lineWidth = sel ? 2.5 : 1.25; g.strokeStyle = sel ? '#e8913f' : 'rgba(17,24,39,0.8)'; g.stroke();
      const u = scheme().uses.find(x => x.key === m.use);
      label(g, M, centroid(m.pts), `${u?.label || m.use} · ${m.floors} fl`, fmtArea(massGfa(m)));
    }
    // Handles on the selection
    const o = findSel();
    if (o) {
      for (const p of o.pts) { const [x, y] = toS(M, p); g.beginPath(); g.rect(x - 4, y - 4, 8, 8); g.fillStyle = '#fff'; g.fill(); g.strokeStyle = '#e8913f'; g.lineWidth = 1.5; g.stroke(); }
    }
    // Outline being drawn
    if (sk.draw) {
      const P = sk.draw.rect ? rectPts(sk.draw.a, sk.draw.b) : [...sk.draw.pts, ...(sk.draw.hover ? [sk.draw.hover] : [])];
      if (P.length > 1) {
        g.beginPath(); P.forEach((p, i) => { const [x, y] = toS(M, p); i ? g.lineTo(x, y) : g.moveTo(x, y); });
        if (sk.draw.rect || P.length > 2) g.closePath();
        g.fillStyle = sk.draw.kind === 'mass' ? colorOf(scheme(), sk.last?.use || scheme().uses[0].key) : colorOf(scheme(), 'lot');
        g.globalAlpha = 0.45; g.fill(); g.globalAlpha = 1; g.setLineDash([6, 4]); g.strokeStyle = '#e8913f'; g.lineWidth = 2; g.stroke(); g.setLineDash([]);
        const ar = area(P) * sfPerNative2();
        if (ar > 1) label(g, M, centroid(P), fmtArea(ar), sk.draw.kind === 'mass' ? `${sk.last?.floors || 3} floors → ${fmtArea(ar * (sk.last?.floors || 3))}` : '');
      }
      for (const p of sk.draw.pts || []) { const [x, y] = toS(M, p); g.beginPath(); g.arc(x, y, 3.5, 0, Math.PI * 2); g.fillStyle = '#e8913f'; g.fill(); }
    }
  }
  function label(g, M, p, a, b) {
    const [x, y] = toS(M, p);
    g.font = '600 12px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    const w = Math.max(g.measureText(a).width, b ? g.measureText(b).width * 0.92 : 0) + 12, h = b ? 32 : 18;
    g.fillStyle = 'rgba(255,255,255,0.88)'; g.strokeStyle = 'rgba(15,23,42,0.25)'; g.lineWidth = 1;
    g.beginPath(); g.roundRect(x - w / 2, y - h / 2, w, h, 4); g.fill(); g.stroke();
    g.fillStyle = '#111827'; g.fillText(a, x, b ? y - 7 : y);
    if (b) { g.font = '11px system-ui, sans-serif'; g.fillStyle = '#374151'; g.fillText(b, x, y + 8); }
  }
  /** Blocks and lots show on the map in the Sketch tab and on the Existing site tab (not while sculpting grades). */
  function showOnMap() { return sk.active || ctx.mode() === 'existing'; }
  const rectPts = (a, b) => [[a[0], a[1]], [b[0], a[1]], [b[0], b[1]], [a[0], b[1]]];

  // ---------------------------------------------------------------- toolbar
  const bar = document.createElement('div');
  bar.className = 'sketch-bar'; bar.hidden = true;
  bar.innerHTML = TOOLS.map(t => `<button type="button" class="sk-tool" data-tool="${t.id}" title="${t.label} (${t.key})" aria-label="${t.label}"><svg viewBox="0 0 24 24">${t.icon}</svg><kbd>${t.key}</kbd><span>${t.label}</span></button>`).join('')
    + '<div class="sk-sep"></div><button type="button" class="sk-tool sk-mini" data-act="undo" title="Undo (Ctrl+Z)" aria-label="Undo"><svg viewBox="0 0 24 24"><path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 010 12h-3"/></svg><kbd>^Z</kbd></button>'
    + '<button type="button" class="sk-tool sk-mini" data-act="redo" title="Redo (Ctrl+Y)" aria-label="Redo"><svg viewBox="0 0 24 24"><path d="M15 14l5-5-5-5"/><path d="M20 9H10a6 6 0 000 12h3"/></svg><kbd>^Y</kbd></button>';
  map.getContainer().appendChild(bar);
  L.DomEvent.disableClickPropagation(bar); L.DomEvent.disableScrollPropagation(bar);
  bar.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.tool) setTool(b.dataset.tool);
    if (b.dataset.act === 'undo') doUndo();
    if (b.dataset.act === 'redo') doRedo();
  });
  function setTool(t) {
    sk.tool = t; sk.draw = null;
    bar.querySelectorAll('[data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === t));
    map.getContainer().classList.toggle('sk-drawing', t !== 'select');
    const hint = { select: 'Click a block or lot to edit it · drag to move · drag corners to reshape · Alt+drag duplicates.', mass: 'Drag a rectangle, or click corners and double-click to finish. ↑ ↓ change floors.', lot: 'Drag a rectangle, or click corners and double-click to finish. [ ] turn the rows, ↑ ↓ slide them.' }[t];
    if ($('sk-hint')) $('sk-hint').textContent = hint;
    draw();
  }
  function doUndo() { if (!sk.undo.length) return; sk.redo.push(snapshot()); restore(sk.undo.pop()); }
  function doRedo() { if (!sk.redo.length) return; sk.undo.push(snapshot()); restore(sk.redo.pop()); }

  // ---------------------------------------------------------------- floating property card
  const cardEl = document.createElement('div');
  cardEl.className = 'sk-card'; cardEl.hidden = true;
  map.getContainer().appendChild(cardEl);
  L.DomEvent.disableClickPropagation(cardEl); L.DomEvent.disableScrollPropagation(cardEl);
  function card() {
    const o = findSel();
    if (!o || !sk.active || !sk.site || sk.drag) { cardEl.hidden = true; return; }
    const M = ctx.affine(sk.site);
    let x1 = -Infinity, y0 = Infinity;
    for (const p of o.pts) { const [x, y] = toS(M, p); if (x > x1) x1 = x; if (y < y0) y0 = y; }
    const W = map.getContainer().clientWidth;
    const key = `${sk.sel.kind}:${o.id}`;
    if (cardEl.dataset.key !== key || cardEl.dataset.ver !== String(sk.cardVer || 0)) {
      cardEl.dataset.key = key; cardEl.dataset.ver = String(sk.cardVer || 0);
      if (sk.sel.kind === 'mass') {
        cardEl.innerHTML = `<div class="skc-row"><select data-k="use">${scheme().uses.map(u => `<option value="${u.key}"${u.key === o.use ? ' selected' : ''}>${escapeHtml(u.label)}</option>`).join('')}</select>
          <button type="button" data-k="del" title="Delete (Del)">🗑</button></div>
          <div class="skc-row"><span>Floors</span><button type="button" data-k="fl-">−</button><output data-o="floors"></output><button type="button" data-k="fl+">+</button>
          <span>@</span><input type="number" data-k="ftf" min="7" max="40" step="0.5" value="${o.ftf}"><span>${metric() ? 'm' : 'ft'}</span></div>
          <div class="skc-row skc-read" data-o="read"></div>`;
      } else {
        cardEl.innerHTML = `<div class="skc-row seg seg-dark">${[90, 60, 45].map(a => `<label><input type="radio" name="skc-ang" value="${a}"${o.stall === a ? ' checked' : ''}><span>${a}°</span></label>`).join('')}
          <button type="button" data-k="del" title="Delete (Del)">🗑</button></div>
          <div class="skc-row"><span>Rows</span><button type="button" data-k="rot-">⟲</button><button type="button" data-k="rot0" title="Line up with the longest side">auto</button><button type="button" data-k="rot+">⟳</button>
          <button type="button" data-k="sh-" title="Slide rows">▲</button><button type="button" data-k="sh+" title="Slide rows">▼</button></div>
          <div class="skc-row skc-read" data-o="read"></div>`;
      }
    }
    if (sk.sel.kind === 'mass') {
      cardEl.querySelector('[data-o="floors"]').textContent = String(o.floors);
      cardEl.querySelector('[data-o="read"]').textContent = `${fmtArea(area(o.pts) * sfPerNative2())} footprint · ${fmtArea(massGfa(o))} total · ${(o.floors * o.ftf).toFixed(0)} ${metric() ? 'm' : 'ft'} tall`;
    } else {
      const Lr = lotLayout(o);
      cardEl.querySelector('[data-o="read"]').textContent = `${Lr.total} spaces (${Lr.acc} accessible${Lr.van ? `, ${Lr.van} van` : ''}) · ${Math.round(area(o.pts) * sfPerNative2() / Math.max(1, Lr.total))} sf per space`;
    }
    cardEl.hidden = false;
    const cw = cardEl.offsetWidth || 230;
    cardEl.style.left = `${Math.max(8, Math.min(W - cw - 8, x1 + 12))}px`;
    cardEl.style.top = `${Math.max(56, y0 - 4)}px`;
  }
  cardEl.addEventListener('click', e => {
    const b = e.target.closest('[data-k]'); const o = findSel(); if (!b || !o) return;
    const k = b.dataset.k;
    if (k === 'del') { removeSel(); return; }
    if (k === 'fl-' || k === 'fl+') { before(); o.floors = Math.max(1, Math.min(120, o.floors + (k === 'fl+' ? 1 : -1))); sk.last = { use: o.use, floors: o.floors, ftf: o.ftf }; changed(true); }
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
    const t = e.target;
    before();
    if (t.dataset.k === 'use') { o.use = t.value; sk.last = { ...(sk.last || {}), use: o.use, floors: o.floors, ftf: o.ftf }; }
    if (t.dataset.k === 'ftf') o.ftf = Math.max(2, Number(t.value) || o.ftf);
    if (t.name === 'skc-ang') o.stall = Number(t.value);
    changed();
  });
  function removeSel() {
    if (!sk.sel) return;
    before();
    if (sk.sel.kind === 'mass') sk.model.masses = sk.model.masses.filter(m => m.id !== sk.sel.id);
    else sk.model.lots = sk.model.lots.filter(m => m.id !== sk.sel.id);
    sk.sel = null; changed();
  }

  // ---------------------------------------------------------------- pointer
  const native = e => ctx.toNative(e.latlng);
  const screenOf = p => toS(ctx.affine(sk.site), p);
  function hit(e) {
    const xy = native(e), cp = [e.containerPoint.x, e.containerPoint.y];
    const o = findSel();
    if (o) for (let i = 0; i < o.pts.length; i++) { const [x, y] = screenOf(o.pts[i]); if (Math.hypot(x - cp[0], y - cp[1]) < 8) return { kind: sk.sel.kind, id: o.id, vertex: i }; }
    const ms = sk.model.masses.slice().sort((a, b) => massTop(b) - massTop(a));
    for (const m of ms) if (inPoly(m.pts, ...xy)) return { kind: 'mass', id: m.id };
    for (const l of sk.model.lots) if (inPoly(l.pts, ...xy)) return { kind: 'lot', id: l.id };
    return null;
  }
  const ortho = (a, b) => (Math.abs(b[0] - a[0]) > Math.abs(b[1] - a[1]) ? [b[0], a[1]] : [a[0], b[1]]);
  function finishDraw(pts) {
    const kind = sk.draw.kind;
    sk.draw = null;
    if (pts.length < 3 || area(pts) * sfPerNative2() < 50) { draw(); return; }
    before();
    const o = { id: id(), pts };
    if (kind === 'mass') { Object.assign(o, { use: sk.last?.use || scheme().uses[0].key, floors: sk.last?.floors || 3, ftf: sk.last?.ftf || (metric() ? 3.6 : 12) }); sk.model.masses.push(o); }
    else { Object.assign(o, { stall: sk.lastStall || 90, shift: 0, angle: null }); sk.model.lots.push(o); }
    sk.sel = { kind, id: o.id };
    changed();
  }
  function down(e) {
    if (!sk.active || !sk.site || e.originalEvent.button !== 0) return;
    const xy = native(e);
    if (sk.tool === 'mass' || sk.tool === 'lot') {
      if (sk.draw?.pts) {      // polygon in progress
        const [fx, fy] = screenOf(sk.draw.pts[0]);
        if (sk.draw.pts.length >= 3 && Math.hypot(fx - e.containerPoint.x, fy - e.containerPoint.y) < 10) { finishDraw(sk.draw.pts); return; }
        sk.draw.pts.push(e.originalEvent.shiftKey ? ortho(sk.draw.pts.at(-1), xy) : xy);
        draw(); return;
      }
      map.dragging.disable();
      sk.draw = { kind: sk.tool, a: xy, b: xy, cp: [e.containerPoint.x, e.containerPoint.y], rect: false, pending: true };
      return;
    }
    const h = hit(e);
    if (!h) { sk.sel = null; draw(); panel(); card(); return; }
    map.dragging.disable();
    let target = h;
    if (e.originalEvent.altKey && h.vertex == null) {           // Alt+drag: duplicate and move the copy
      const src = (h.kind === 'mass' ? sk.model.masses : sk.model.lots).find(o => o.id === h.id);
      before();
      const copy = JSON.parse(JSON.stringify(src)); copy.id = id();
      (h.kind === 'mass' ? sk.model.masses : sk.model.lots).push(copy);
      target = { kind: h.kind, id: copy.id };
      sk.drag = { ...target, start: xy, orig: JSON.parse(JSON.stringify(copy.pts)), pushed: true };
    } else sk.drag = { ...target, start: xy, orig: JSON.parse(JSON.stringify((h.kind === 'mass' ? sk.model.masses : sk.model.lots).find(o => o.id === h.id).pts)), pushed: false };
    sk.sel = { kind: target.kind, id: target.id };
    draw(); panel(); card();
  }
  function move(e) {
    if (!sk.active || !sk.site) return;
    const xy = native(e);
    if (sk.draw && sk.draw.pending !== undefined && !sk.draw.pts) {
      if (sk.draw.pending && Math.hypot(e.containerPoint.x - sk.draw.cp[0], e.containerPoint.y - sk.draw.cp[1]) > 6) { sk.draw.pending = false; sk.draw.rect = true; }
      if (sk.draw.rect) {
        let b = xy;
        if (e.originalEvent.shiftKey) { const d = Math.max(Math.abs(xy[0] - sk.draw.a[0]), Math.abs(xy[1] - sk.draw.a[1])); b = [sk.draw.a[0] + Math.sign(xy[0] - sk.draw.a[0]) * d, sk.draw.a[1] + Math.sign(xy[1] - sk.draw.a[1]) * d]; }
        sk.draw.b = b; draw();
      }
      return;
    }
    if (sk.draw?.pts) { sk.draw.hover = e.originalEvent.shiftKey ? ortho(sk.draw.pts.at(-1), xy) : xy; draw(); return; }
    if (sk.drag) {
      const o = (sk.drag.kind === 'mass' ? sk.model.masses : sk.model.lots).find(q => q.id === sk.drag.id);
      if (!o) return;
      if (!sk.drag.pushed) { before(); sk.drag.pushed = true; }
      const dx = xy[0] - sk.drag.start[0], dy = xy[1] - sk.drag.start[1];
      if (sk.drag.vertex != null) {
        const n = o.pts.length, i = sk.drag.vertex, P = sk.drag.orig.map(p => p.slice());
        let p = [P[i][0] + dx, P[i][1] + dy];
        if (e.originalEvent.shiftKey) p = ortho(P[(i - 1 + n) % n], p);
        // A rectangle stays a rectangle when a corner is dragged (its two neighbours follow).
        if (n === 4 && isRect(P)) { const a = (i + 1) % 4, c = (i + 3) % 4, opp = P[(i + 2) % 4]; P[i] = p; if (P[a][0] === opp[0]) { P[a] = [opp[0], p[1]]; P[c] = [p[0], opp[1]]; } else { P[a] = [p[0], opp[1]]; P[c] = [opp[0], p[1]]; } o.pts = P; }
        else { P[i] = p; o.pts = P; }
      } else o.pts = sk.drag.orig.map(([x, y]) => [x + dx, y + dy]);
      sk.drag.moved = true;
      draw(); panel();
      clearTimeout(sk.softT); sk.softT = setTimeout(() => ctx.onChange?.(), 120);
    }
  }
  const isRect = P => P.length === 4 && [0, 1, 2, 3].every(i => { const a = P[i], b = P[(i + 1) % 4]; return Math.abs(a[0] - b[0]) < 1e-6 || Math.abs(a[1] - b[1]) < 1e-6; });
  function up(e) {
    if (!sk.active) return;
    if (sk.draw && !sk.draw.pts) {
      map.dragging.enable();
      if (sk.draw.rect) { finishDraw(rectPts(sk.draw.a, sk.draw.b)); return; }
      // A click without dragging starts an outline.
      sk.draw = { kind: sk.draw.kind, pts: [sk.draw.a] }; draw(); return;
    }
    if (sk.drag) { const moved = sk.drag.moved; sk.drag = null; map.dragging.enable(); if (moved) changed(true); else card(); }
    void e;
  }
  map.on('mousedown', down);
  map.on('mousemove', move);
  map.on('mouseup', up);
  document.addEventListener('mouseup', e => { if (sk.drag || (sk.draw && !sk.draw.pts)) up({ originalEvent: e }); });
  map.on('dblclick', () => { if (sk.active && sk.draw?.pts?.length >= 3) { const P = sk.draw.pts.slice(); if (P.length > 3 && Math.hypot(P.at(-1)[0] - P.at(-2)[0], P.at(-1)[1] - P.at(-2)[1]) < 1e-6) P.pop(); finishDraw(P); } });
  map.on('move zoom resize viewreset', () => { if (sk.active) { draw(); card(); } });
  map.on('zoomstart', () => { if (sk.active) canvas.style.visibility = 'hidden'; });
  map.on('zoomend', () => { canvas.style.visibility = ''; if (sk.active) { draw(); card(); } });

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
    if (k === 'Enter' && sk.draw?.pts?.length >= 3) { e.preventDefault(); finishDraw(sk.draw.pts.slice()); return true; }
    if (k === 'Backspace' && sk.draw?.pts) { e.preventDefault(); sk.draw.pts.pop(); if (!sk.draw.pts.length) sk.draw = null; draw(); return true; }
    if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); return true; }
    if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'y') { e.preventDefault(); doRedo(); return true; }
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    const t = TOOLS.find(x => x.key.toLowerCase() === k.toLowerCase());
    if (t) { e.preventDefault(); setTool(t.id); return true; }
    const o = findSel();
    if (!o) return false;
    if (k === 'Delete' || k === 'Backspace') { e.preventDefault(); removeSel(); return true; }
    if (sk.sel.kind === 'mass' && (k === 'ArrowUp' || k === 'ArrowDown')) { e.preventDefault(); before(); o.floors = Math.max(1, Math.min(120, o.floors + (k === 'ArrowUp' ? 1 : -1))); sk.last = { use: o.use, floors: o.floors, ftf: o.ftf }; changed(true); return true; }
    if (sk.sel.kind === 'lot' && (k === 'ArrowUp' || k === 'ArrowDown')) { e.preventDefault(); before(); o.shift = (o.shift || 0) + (k === 'ArrowUp' ? -3 : 3); changed(true); return true; }
    if (sk.sel.kind === 'lot' && (k === '[' || k === ']')) { e.preventDefault(); before(); o.angle = (o.angle ?? longestEdgeAngle(o.pts)) + (k === ']' ? 1 : -1) * Math.PI / 36; changed(true); return true; }
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
    ];
    el.innerHTML = rows.length ? rows.map(r => `<button type="button" class="sk-item${sk.sel?.id === r.o.id ? ' on' : ''}" data-kind="${r.kind}" data-id="${r.o.id}"><i style="background:${r.c}"></i>${escapeHtml(r.t)}</button>`).join('') : '';
  }
  function schemeUi() {
    const sel = $('sk-scheme'); if (!sel) return;
    const cur = scheme();
    const list = allSchemes();
    const opts = list.map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('') + (list.some(s => s.id === cur.id) ? '' : `<option value="${cur.id}">${escapeHtml(cur.name)} (this project)</option>`);
    if (sel.dataset.html !== opts) { sel.innerHTML = opts; sel.dataset.html = opts; }
    sel.value = cur.id;
    const sw = (arr, grp) => arr.map((u, i) => `<label class="sk-sw" title="${escapeHtml(u.label)}"><input type="color" value="${u.color}" data-grp="${grp}" data-i="${i}"><span>${escapeHtml(u.label)}</span></label>`).join('');
    const html = `<div class="sk-swh">Building uses</div>${sw(cur.uses, 'uses')}<div class="sk-swh">Site and diagram</div>${sw(cur.site, 'site')}`;
    if ($('sk-swatches').dataset.html !== html) { $('sk-swatches').innerHTML = html; $('sk-swatches').dataset.html = html; }
    $('sk-scheme-del').hidden = !!cur.builtin || !list.some(s => s.id === cur.id);
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
  /** Massing as building-like objects (for the sun / shadow raster). */
  function buildings() {
    return sk.model.masses.map(m => { const base = massBase(m); return { ring: m.pts, massRing: m.pts, base, top: base + m.floors * m.ftf, sketch: true }; });
  }
  /** Massing triangles (flat [x, y, z × 3 …], native XY, output Z) and a colour per triangle; ex: vertical exaggeration
   *  of the 3D view (heights above each block's base are divided by it so blocks stay true-scale). */
  function tris(ex = 1) {
    const out = [], col = [], lines = [];
    for (const m of sk.model.masses) {
      const base = massBase(m), top = base + (m.floors * m.ftf) / ex, P = m.pts, n = P.length;
      const c = colorOf(scheme(), m.use);
      const push = (a, b, d) => { out.push(...a, ...b, ...d); col.push(c); };
      for (let i = 0; i < n; i++) { const [x0, y0] = P[i], [x1, y1] = P[(i + 1) % n]; push([x0, y0, base], [x1, y1, base], [x1, y1, top]); push([x0, y0, base], [x1, y1, top], [x0, y0, top]); }
      for (const [a, b, d] of ctx.triangulate(P)) push([...P[a], top], [...P[b], top], [...P[d], top]);
      for (let f = 1; f < m.floors; f++) {                       // floor lines on the walls
        const z = base + (f * m.ftf) / ex;
        for (let i = 0; i < n; i++) { const [x0, y0] = P[i], [x1, y1] = P[(i + 1) % n]; lines.push(x0, y0, z, x1, y1, z); }
      }
    }
    return { tris: out, colors: col, lines };
  }
  /** Parking for 3D: stall lines and accessible stalls draped on the ground. */
  function parking3d() {
    const lines = [], acc = [];
    for (const l of sk.model.lots) {
      const Lr = lotLayout(l), z = (x, y) => ctx.zAt(x, y) + 0.15;
      const P = l.pts;
      for (let i = 0; i < P.length; i++) { const a = P[i], b = P[(i + 1) % P.length]; lines.push(a[0], a[1], z(...a), b[0], b[1], z(...b)); }
      for (const st of Lr.stalls) {
        const q = st.pts;
        if (st.acc) { for (const [i, j, k2] of [[0, 1, 2], [0, 2, 3]]) acc.push(...q[i], z(...q[i]), ...q[j], z(...q[j]), ...q[k2], z(...q[k2])); continue; }
        if (st.aisle) continue;
        for (const [i, j] of [[0, 3], [3, 2], [2, 1]]) lines.push(q[i][0], q[i][1], z(...q[i]), q[j][0], q[j][1], z(...q[j]));
      }
    }
    return { lines, acc, stripe: colorOf(scheme(), 'stripe'), accColor: colorOf(scheme(), 'accessible'), lotColor: colorOf(scheme(), 'lot') };
  }

  return {
    get version() { return sk.ver; },
    get model() { return sk.model; },
    onSite,
    setActive(on) {
      sk.active = on; canvas.hidden = !showOnMap(); bar.hidden = !on;
      if (!on) { sk.draw = null; cardEl.hidden = true; map.getContainer().classList.remove('sk-drawing'); }
      else setTool(sk.tool);
      draw(); card(); panel();
    },
    redraw() { draw(); card(); },
    buildings, tris, parking3d, stats, wirePanel, panel,
    hasContent: () => sk.model.masses.length + sk.model.lots.length > 0,
    refreshVisibility() { canvas.hidden = !showOnMap(); draw(); },
    _sk: sk,
  };
}
