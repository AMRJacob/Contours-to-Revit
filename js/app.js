// Contours to Revit — UI and pipeline.
/* global L, JSZip */
import { ZONES, zoneByCode, zoneUnitsPerMeter, zoneUnitLabel, projector, detectZone, reverseGeocode, geocode, convergence } from './geo.js?v=0.50.0';
import { fetchElevation, sample } from './dem.js?v=0.50.0';
import { buildGrid, gridStats, smooth, contourLines, contourLevels, isMajor, labelPositions } from './contours.js?v=0.50.0';
import { Dxf } from './dxf.js?v=0.50.0';
import { Design, FEATURE_NAMES, contourSegments, designKey, parseDesignKey, f32ToB64, b64ToF32, smoothClosed, smoothOpen } from './design.js?v=0.50.0';
import { drawMap, hillshade, formatElev } from './render.js?v=0.50.0';
import { Flow } from './flow.js?v=0.50.0';
import { createSketch } from './sketch.js?v=0.50.0';
import { initTips, coachFrom, setTipDelay } from './tips.js?v=0.50.0';
import { sunPosition, sunTimes, heightRaster, sunVector, shadeRaster, strideFor, surfaceSamples, sunHours, hoursColor, compass } from './sun.js?v=0.50.0';
import { windRose, roseSummary, sectorName, WindField, WIND_CREDIT } from './wind.js?v=0.50.0';
import { IMAGERY_SOURCES, STATE_LIST, sourceById, registerSource, customSource, candidates as imgCandidates, probe as imgProbe, rank as imgRank, fetchBox, emptyFraction, fmtIn } from './imagery.js?v=0.50.0';
import { combineBuildings, orthogonalize, prismMass } from './massing.js?v=0.50.0';
import { loadLidar, applyLidar } from './lidar.js?v=0.50.0';
import { findTrees } from './trees.js?v=0.50.0';
import { initRevit, revitSiteChanged } from './revit.js?v=0.50.0';
import { fetchBuildings, fetchBuildingsMs, fetchBuildingsOsm, BUILDING_SOURCES, fetchArdotWidths, prepareWidths, fetchOsmAreas, prepareOsmAreas, hostedContextIndex, ctxIndexReset, fetchRoadsAny, prepareContext, triangulate, fetchParcels, fetchFlood, prepareOverlays, hatchPolygon, densify } from './context.js?v=0.50.0';

const VERSION = '0.50.0';
document.getElementById('app-ver').textContent = `v${VERSION}`;
document.getElementById('foot-ver').textContent = `Web app v${VERSION}`;
const MAX_POINTS_WARN = 50000;
const MAX_POINTS_HARD = 400000;
const ACRES_WARN = 640;
const ACRES_HARD = 6400;   // 10 square miles
const SQFT_PER_ACRE = 43560;

const OPTIONS = {
  ft: { spacing: [1, 3, 5, 10, 25, 50, 100], spacingDefault: 5, interval: [1, 2, 5], intervalDefault: 2, label: 'ft', tick: '′' },
  m: { spacing: [0.5, 1, 1.5, 3, 5, 10, 25], spacingDefault: 1.5, interval: [0.25, 0.5, 1, 2], intervalDefault: 0.5, label: 'm', tick: ' m' },
};

const $ = id => document.getElementById(id);
const state = {
  rect: null,         // L.Rectangle
  autoZone: null,     // {zone, method}
  result: null,       // last generated site
  contourLayer: null,
};

// ---------- Settings persistence (per-browser convenience only) ----------
const store = {
  get() { try { return JSON.parse(localStorage.getItem('c2r-settings') || '{}'); } catch { return {}; } },
  set(v) { try { localStorage.setItem('c2r-settings', JSON.stringify(v)); } catch { /* ignore */ } projTouch(); },
};

// ---------- Map ----------
// Remembered per browser: last map view, site boundary and picked origin (survive a refresh).
const session = {
  get(k) { try { return JSON.parse(localStorage.getItem('c2r-' + k) || 'null'); } catch { return null; } },
  set(k, v) { try { if (v === null) localStorage.removeItem('c2r-' + k); else localStorage.setItem('c2r-' + k, JSON.stringify(v)); } catch { /* ignore */ } if (k !== 'view') projTouch(); },
};
const savedView = session.get('view');
const map = L.map('map', { zoomControl: true, preferCanvas: true })
  .setView(savedView ? [savedView.lat, savedView.lng] : [34.7465, -92.2896], savedView ? savedView.zoom : 15);
map.on('moveend', () => { const c = map.getCenter(); session.set('view', { lat: c.lat, lng: c.lng, zoom: map.getZoom() }); });
// Wheel-drag pans the map (as in Revit), whatever tool the left button is doing; no browser auto-scroll.
{
  const el = map.getContainer();
  let last = null;
  el.addEventListener('mousedown', e => { if (e.button !== 1) return; e.preventDefault(); last = [e.clientX, e.clientY]; el.classList.add('mid-pan'); });
  window.addEventListener('mousemove', e => { if (!last) return; map.panBy([last[0] - e.clientX, last[1] - e.clientY], { animate: false }); last = [e.clientX, e.clientY]; });
  window.addEventListener('mouseup', e => { if (e.button === 1 && last) { last = null; el.classList.remove('mid-pan'); } });
  el.addEventListener('auxclick', e => { if (e.button === 1) e.preventDefault(); });
}
// Leaflet only notices window resizes. Inside the Revit plugin the map's box can change size without one (window shown,
// docked, moved to a monitor with another scale), which leaves tiles laid out for the old size — re-measure on any change.
if ('ResizeObserver' in window) {
  let rz = 0;
  new ResizeObserver(() => { cancelAnimationFrame(rz); rz = requestAnimationFrame(() => map.invalidateSize({ pan: false })); }).observe(document.getElementById('map'));
}
window.addEventListener('focus', () => map.invalidateSize({ pan: false }));
const aerial = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
  maxZoom: 20, maxNativeZoom: 19, attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics',
}).addTo(map);
const streets = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 20, maxNativeZoom: 19, attribution: '&copy; OpenStreetMap contributors',
});
const labels = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', {
  maxZoom: 20, maxNativeZoom: 19,
});
L.control.layers({ Aerial: aerial, Streets: streets }, { 'Place labels': labels }, { position: 'topright' }).addTo(map);
L.control.scale({ imperial: true, metric: true }).addTo(map);

const drawn = new L.FeatureGroup().addTo(map);
const drawControl = new L.Control.Draw({
  position: 'topleft',
  draw: { polyline: false, polygon: false, circle: false, marker: false, circlemarker: false,
    rectangle: { shapeOptions: { color: '#e8913f', weight: 2, fillOpacity: 0.08 }, showArea: false } },
  edit: { featureGroup: drawn, edit: false, remove: true },
});
// The boundary stays editable: corner handles (rectangle) or vertex handles (polygon; drag a midpoint to add a
// corner) are always shown on the Existing site tab. Leaflet.draw hides them while the layer is off the map
// (Site design tab) and brings them back with it.
function onBoundaryEdited() {
  saveRect(); onSiteChanged(true);
  if (state.result) setStatus('Boundary changed — click Survey the site to update it.');
}
// (Leaflet.draw fires 'edit' on the shape without bubbling, so listen on the layer itself.)
drawn.on('layeradd', e => { try { e.layer.on('edit', onBoundaryEdited); e.layer.editing?.enable(); } catch { /* not editable */ } });
drawn.on('layerremove', e => { try { e.layer.off('edit', onBoundaryEdited); e.layer.editing?.disable(); } catch { /* ignore */ } });
map.addControl(drawControl);
let rectDrawer = null;

map.on(L.Draw.Event.CREATED, e => {
  drawn.clearLayers();
  state.rect = e.layer;
  drawn.addLayer(e.layer);
  saveRect();
  onSiteChanged(true);
});
map.on(L.Draw.Event.EDITED, () => { saveRect(); onSiteChanged(true); });
function saveRect() {
  const b = state.rect?.getBounds();
  session.set('rect', b ? [[b.getSouth(), b.getWest()], [b.getNorth(), b.getEast()]] : null);
  session.set('poly', sitePolyLL());
}
/** The boundary's corners [[lat, lng], …] when it is a polygon, else null (rectangle). */
function sitePolyLL() {
  const l = state.rect;
  if (!l || l instanceof L.Rectangle) return null;
  const ring = l.getLatLngs()[0] || [];
  return ring.length >= 3 ? ring.map(p => [p.lat, p.lng]) : null;
}
/** Boundary layer from saved data: polygon corners if given, else the rectangle bounds. */
function boundaryLayer(rect, poly) {
  const opt = drawControl.options.draw.rectangle.shapeOptions;
  return poly?.length >= 3 ? L.polygon(poly, opt) : L.rectangle(rect, opt);
}
/** Polygon boundary in native zone coordinates, or null for a rectangle. */
function siteMask(zone) {
  const ll = sitePolyLL();
  if (!ll) return null;
  const p = projector(zone);
  return ll.map(([lat, lng]) => p.fwd([lng, lat]));
}
const polyArea = R => { let a = 0; for (let i = 0, k = R.length - 1; i < R.length; k = i++) a += (R[k][0] + R[i][0]) * (R[k][1] - R[i][1]); return Math.abs(a) / 2; };
/** Grid nodes outside the polygon become NaN (no point, no contour). Returns how many were masked. */
function maskGrid(g, R) {
  let n = 0;
  for (let j = 0; j < g.ny; j++) {
    const y = g.y0 + j * g.s;
    const xs = [];
    for (let a = 0, k = R.length - 1; a < R.length; k = a++) {
      const [ax, ay] = R[a], [bx, by] = R[k];
      if ((ay > y) !== (by > y)) xs.push(ax + (y - ay) / (by - ay) * (bx - ax));
    }
    xs.sort((p, q) => p - q);
    let m = 0;
    for (let i = 0; i < g.nx; i++) {
      const x = g.x0 + i * g.s;
      while (m < xs.length && xs[m] < x) m++;
      if (m % 2 === 0) { const q = j * g.nx + i; if (!Number.isNaN(g.z[q])) { g.z[q] = NaN; n++; } }
    }
  }
  return n;
}
map.on('draw:editmove draw:editresize draw:editvertex', () => onSiteChanged(false));
map.on(L.Draw.Event.DELETED, () => {
  state.rect = drawn.getLayers()[0] || null;
  saveRect();
  onSiteChanged(true);
});

let polyDrawer = null;
$('draw-btn').addEventListener('click', () => {
  polyDrawer?.disable();
  if (!rectDrawer) rectDrawer = new L.Draw.Rectangle(map, drawControl.options.draw.rectangle);
  rectDrawer.enable();
});
$('draw-poly-btn').addEventListener('click', () => {
  rectDrawer?.disable();
  if (!polyDrawer) polyDrawer = new L.Draw.Polygon(map, { shapeOptions: drawControl.options.draw.rectangle.shapeOptions, allowIntersection: false, showArea: false, guidelineDistance: 12 });
  polyDrawer.enable();
  setStatus('Click each corner of the boundary; click the first point (or double-click) to finish. Esc cancels.');
});

// ---------- Search ----------
$('search-form').addEventListener('submit', async e => {
  e.preventDefault();
  const q = $('search').value.trim();
  if (!q) return;
  const list = $('search-results');
  list.hidden = false;
  list.innerHTML = '<li><button disabled>Searching…</button></li>';
  try {
    const hits = await geocode(q);
    list.innerHTML = '';
    if (!hits.length) { list.innerHTML = '<li><button disabled>No matches</button></li>'; return; }
    for (const h of hits) {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = h.label;
      b.addEventListener('click', () => {
        map.setView([h.lat, h.lon], 18);
        list.hidden = true;
      });
      li.appendChild(b);
      list.appendChild(li);
    }
    if (hits.length === 1) { map.setView([hits[0].lat, hits[0].lon], 18); }
  } catch (err) {
    list.innerHTML = `<li><button disabled>Search failed: ${escapeHtml(err.message)}</button></li>`;
  }
});

// ---------- Options ----------
function units() { return document.querySelector('input[name="units"]:checked').value; }

function fillSelect(sel, values, def, tick) {
  const prev = Number(sel.value);
  sel.innerHTML = '';
  for (const v of values) {
    const o = document.createElement('option');
    o.value = String(v);
    o.textContent = `${v}${tick}`;
    sel.appendChild(o);
  }
  sel.value = String(values.includes(prev) ? prev : def);
}

function fillUnitOptions() {
  const o = OPTIONS[units()];
  fillSelect($('spacing'), o.spacing, o.spacingDefault, o.tick);
  fillSelect($('interval'), o.interval, o.intervalDefault, o.tick);
}

function fillZones() {
  const sel = $('zone');
  const byState = new Map();
  for (const z of ZONES) {
    const st = z.state.split(/ (east|west|north|onshore|offshore|mainland)\b/i)[0];
    if (!byState.has(st)) byState.set(st, []);
    byState.get(st).push(z);
  }
  sel.innerHTML = '<option value="auto">Auto-detect</option>';
  for (const st of [...byState.keys()].sort()) {
    const g = document.createElement('optgroup');
    g.label = st;
    for (const z of byState.get(st)) {
      const o = document.createElement('option');
      o.value = String(z.code);
      o.textContent = `${z.name} — EPSG:${z.code}${z.unit === 'ft' ? ' (intl ft)' : ''}`;
      g.appendChild(o);
    }
    sel.appendChild(g);
  }
}

function selectedZone() {
  const v = $('zone').value;
  if (v === 'auto') return state.autoZone?.zone || null;
  return zoneByCode(v);
}

function updateZoneHint() {
  const v = $('zone').value;
  const hint = $('zone-hint');
  const z = selectedZone();
  if (!z) { hint.textContent = state.rect ? 'Detecting zone…' : 'Draw a site to detect the zone.'; return; }
  const unit = zoneUnitLabel(z);
  if (v === 'auto') {
    hint.innerHTML = `<strong>${escapeHtml(z.name)}</strong> (EPSG:${z.code}, ${unit}) — ${escapeHtml(state.autoZone.method)}.`;
  } else {
    const auto = state.autoZone?.zone;
    hint.textContent = `Manual: ${z.name} (EPSG:${z.code}, ${unit}).` + (auto && auto.code !== z.code ? ` Auto-detect suggests ${auto.name}.` : '');
  }
  if (z.note) hint.innerHTML += ` <br>EPSG has no feet version of this zone; using ${escapeHtml(z.note)}.`;
}

function saveSettings() {
  store.set({
    units: units(), spacing: $('spacing').value, interval: $('interval').value,
    localOrigin: $('local-origin').checked, smooth: $('smooth').checked,
    zone: $('zone').value, bldgMode: $('bldg-mode').value, bldgFfe: $('bldg-ffe').value, bldgH: $('bldg-h').value,
    bldgLidar: $('bldg-lidar').checked, bldgLidarRes: $('bldg-lidar-res').value, bldgStyle: $('bldg-style').value, trees: $('trees-lidar').checked,
  });
}

function restoreSettings() {
  const s = store.get();
  if (s.units) { const r = document.querySelector(`input[name="units"][value="${s.units}"]`); if (r) r.checked = true; }
  fillUnitOptions();
  if (s.spacing && [...$('spacing').options].some(o => o.value === s.spacing)) $('spacing').value = s.spacing;
  if (s.interval && [...$('interval').options].some(o => o.value === s.interval)) $('interval').value = s.interval;
  if (typeof s.localOrigin === 'boolean') $('local-origin').checked = s.localOrigin;
  if (typeof s.smooth === 'boolean') $('smooth').checked = s.smooth;
  if (s.zone && [...$('zone').options].some(o => o.value === s.zone)) $('zone').value = s.zone;
  if (['off', 'pad', 'block'].includes(s.bldgMode)) $('bldg-mode').value = s.bldgMode;
  if (s.bldgFfe != null) $('bldg-ffe').value = s.bldgFfe;
  if (s.bldgH != null) $('bldg-h').value = s.bldgH;
  $('bldg-lidar').checked = !!s.bldgLidar;
  if (['1', '2', '5'].includes(String(s.bldgLidarRes))) $('bldg-lidar-res').value = String(s.bldgLidarRes);
  if (['clean', 'planes'].includes(s.bldgStyle)) $('bldg-style').value = s.bldgStyle;
  if (typeof s.trees === 'boolean') $('trees-lidar').checked = s.trees;
  bldgUi();
}
/** Building massing style: 'clean' (squared footprints, simple roofs) or 'planes' (lidar roof planes). */
const massStyle = () => $('bldg-style')?.value === 'planes' ? 'planes' : 'clean';
function bldgUi() {
  const m = $('bldg-mode').value;
  $('bldg-pad-row').hidden = m !== 'pad';
  $('bldg-h-row').hidden = m !== 'block';
  $('bldg-lidar-row').hidden = !$('bldg-lidar').checked || massStyle() !== 'planes';
  $('bldg-hint').textContent = m === 'off' ? ''
    : m === 'pad' ? 'Each footprint becomes a level pad (the CSV, contours and design surface all use it). Uses the building layer shown on the map — Microsoft, OpenStreetMap or FEMA. Assumed, not surveyed.'
    : 'Each footprint is raised to its roof (data height where known). Good for 3D views and water flow around buildings; for a Revit Toposolid you usually want pads or bare earth.';
}

document.querySelectorAll('input[name="units"]').forEach(r => r.addEventListener('change', () => {
  fillUnitOptions(); onSiteChanged(false); saveSettings(); invalidate();
}));
$('local-origin').addEventListener('change', () => { saveSettings(); applyOrigin(); });
$('bldg-mode').addEventListener('change', bldgUi);
$('bldg-lidar').addEventListener('change', bldgUi);
$('bldg-style').addEventListener('change', bldgUi);
['spacing', 'interval', 'smooth', 'bldg-mode', 'bldg-ffe', 'bldg-h', 'bldg-lidar', 'bldg-lidar-res', 'bldg-style', 'trees-lidar'].forEach(id => $(id).addEventListener('change', () => {
  onSiteChanged(false); saveSettings(); invalidate();
}));
$('zone').addEventListener('change', () => { updateZoneHint(); onSiteChanged(false); saveSettings(); invalidate(); });

function updateTopoSummary() {
  const t = OPTIONS[units()].tick;
  $('sum-topo').textContent = `pts ${$('spacing').value}${t} · contours ${$('interval').value}${t}`;
}

function invalidate() {
  if (state.result) setStatus('Options changed — generate again to update the downloads.');
}

// ---------- Site measurement ----------
function siteBox(zone) {
  const b = state.rect.getBounds();
  const p = projector(zone);
  const mask = siteMask(zone);
  if (mask) {
    const xs = mask.map(q => q[0]), ys = mask.map(q => q[1]);
    return { xmin: Math.min(...xs), xmax: Math.max(...xs), ymin: Math.min(...ys), ymax: Math.max(...ys) };
  }
  // Inscribed axis-aligned box in grid coordinates, so every grid node lies inside the drawn rectangle.
  const sw = p.fwd([b.getWest(), b.getSouth()]), se = p.fwd([b.getEast(), b.getSouth()]);
  const nw = p.fwd([b.getWest(), b.getNorth()]), ne = p.fwd([b.getEast(), b.getNorth()]);
  return {
    xmin: Math.max(sw[0], nw[0]), xmax: Math.min(se[0], ne[0]),
    ymin: Math.max(sw[1], se[1]), ymax: Math.min(nw[1], ne[1]),
  };
}

function fallbackZoneFor(lon, lat) {
  return detectZone(lon, lat)?.zone || null;
}

let detectSeq = 0;
async function onSiteChanged(redetect) {
  const has = !!state.rect;
  $('site-stats').hidden = !has;
  $('step-site').classList.toggle('done', has);
  if (!has) $('sum-site').textContent = 'Draw a boundary';
  updateTopoSummary();
  $('generate').disabled = !has;
  $('site-warning').hidden = true;
  if (!has) { updateZoneHint(); return; }
  const c = state.rect.getBounds().getCenter();
  if (redetect) {
    const seq = ++detectSeq;
    state.autoZone = detectZone(c.lng, c.lat);
    updateZoneHint();
    const place = await reverseGeocode(c.lat, c.lng);
    if (seq !== detectSeq) return;
    const det = detectZone(c.lng, c.lat, place);
    if (det) state.autoZone = det;
    updateZoneHint();
  }
  const zone = selectedZone() || fallbackZoneFor(c.lng, c.lat);
  if (!zone) {
    showWarning('This location is outside the State Plane zones this tool supports (US only).');
    $('generate').disabled = true;
    return;
  }
  const box = siteBox(zone);
  const u = units();
  const toOut = u === 'ft' ? 1 : 1 / zoneUnitsPerMeter(zone);
  const wOut = (box.xmax - box.xmin) * toOut, hOut = (box.ymax - box.ymin) * toOut;
  const spacing = Number($('spacing').value);
  const mask = siteMask(zone);
  const frac = mask ? Math.min(1, polyArea(mask) / ((box.xmax - box.xmin) * (box.ymax - box.ymin))) : 1;
  const nPts = Math.round((Math.floor(wOut / spacing) + 1) * (Math.floor(hOut / spacing) + 1) * frac);
  const sqft = (box.xmax - box.xmin) * (box.ymax - box.ymin) * frac * (zone.unit === 'ft' ? 1 : (1200 / 3937 / 0.3048) ** 2);
  const acres = sqft / SQFT_PER_ACRE;
  $('st-size').textContent = `${fmt(wOut, 0)} × ${fmt(hOut, 0)} ${u}`;
  $('sum-site').textContent = `${fmt(wOut, 0)} × ${fmt(hOut, 0)} ${u} · ${fmt(acres, acres < 10 ? 2 : 1)} ac`;
  $('st-area').textContent = `${fmt(acres, acres < 10 ? 2 : 1)} ac`;
  $('st-points').textContent = fmt(nPts, 0);
  const warns = [];
  if (acres > ACRES_HARD) warns.push(`This area is very large (${fmt(acres, 0)} acres). Draw a smaller site — the limit is ${fmt(ACRES_HARD, 0)} acres.`);
  else if (acres > ACRES_WARN) warns.push(`Large area (${fmt(acres, 0)} acres). Generation may be slow; a smaller boundary is recommended.`);
  if (nPts > MAX_POINTS_HARD) warns.push(`${fmt(nPts, 0)} points is too many. Choose a coarser point spacing.`);
  else if (nPts > MAX_POINTS_WARN) {
    const better = OPTIONS[u].spacing.find(sp => (Math.floor(wOut / sp) + 1) * (Math.floor(hOut / sp) + 1) <= MAX_POINTS_WARN);
    warns.push(`${fmt(nPts, 0)} points is more than Revit handles comfortably (~50,000).` + (better ? ` Try ${better}${OPTIONS[u].tick} spacing.` : ' Try a coarser spacing or smaller site.'));
  }
  if (warns.length) showWarning(warns.join(' '));
  $('generate').disabled = acres > ACRES_HARD || nPts > MAX_POINTS_HARD;
}

function showWarning(msg) {
  const el = $('site-warning');
  el.textContent = msg;
  el.hidden = false;
}

// ---------- Generate ----------
function setStatus(msg, isError = false) {
  const el = $('status');
  el.textContent = msg;
  el.classList.toggle('error', isError);
}

$('generate').addEventListener('click', async () => {
  const btn = $('generate');
  btn.disabled = true;
  try {
    await generate();
  } catch (err) {
    console.error(err);
    setStatus(err.message || String(err), true);
  } finally {
    btn.disabled = !state.rect;
  }
});

/** The building source used for the surface: the one shown on the map for a reopened project, else the most detailed. */
function pickBuildingKey(c, failed) {
  const order = ['bldgBest', 'bldgMs', 'bldgOsm', 'buildings'];
  const len = k => (k === 'buildings' ? c.buildings : c[k] || []).length;
  const ok = order.filter(k => !failed?.[k] && len(k) > 0);
  return (state.keepLayers && ok.find(k => visibility[k])) || ok[0] || null;
}
/** Set every grid node inside a footprint to that building's target elevation. */
function burnBuildings(g, list, targets) {
  list.forEach((b, n) => {
    const t = targets[n];
    const f = typeof t === 'function' ? t : null; // per-point height (lidar roof surface)
    if (!f && !Number.isFinite(t)) return;
    const R = b.ring;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of R) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    const i0 = Math.max(0, Math.ceil((x0 - g.x0) / g.s)), i1 = Math.min(g.nx - 1, Math.floor((x1 - g.x0) / g.s));
    const j0 = Math.max(0, Math.ceil((y0 - g.y0) / g.s)), j1 = Math.min(g.ny - 1, Math.floor((y1 - g.y0) / g.s));
    for (let j = j0; j <= j1; j++) {
      const y = g.y0 + j * g.s;
      // Crossings of this row with the ring (even-odd fill).
      const xs = [];
      for (let a = 0, k = R.length - 1; a < R.length; k = a++) {
        const [ax, ay] = R[a], [bx, by] = R[k];
        if ((ay > y) !== (by > y)) xs.push(ax + (y - ay) / (by - ay) * (bx - ax));
      }
      xs.sort((p, q) => p - q);
      for (let m = 0; m + 1 < xs.length; m += 2) {
        const ia = Math.max(i0, Math.ceil((xs[m] - g.x0) / g.s)), ib = Math.min(i1, Math.floor((xs[m + 1] - g.x0) / g.s));
        for (let i = ia; i <= ib; i++) { const v = f ? f(g.x0 + i * g.s, y) : t; if (Number.isFinite(v)) g.z[j * g.nx + i] = v; }
      }
    }
  });
}

async function generate() {
  const c = state.rect.getBounds().getCenter();
  const zone = selectedZone() || fallbackZoneFor(c.lng, c.lat);
  if (!zone) throw new Error('No State Plane zone selected.');
  const p = projector(zone);
  const u = units();
  const nativePerM = zoneUnitsPerMeter(zone);
  const toOut = u === 'ft' ? 1 : 1 / nativePerM;        // native XY -> output XY
  const zPerM = u === 'ft' ? nativePerM : 1;             // DEM meters -> output Z
  const spacingOut = Number($('spacing').value);
  const interval = Number($('interval').value);
  const box = siteBox(zone);
  const sNative = spacingOut / toOut;

  // Lon/lat extent of the grid box (densified), plus a margin of a few DEM pixels.
  const ll = [];
  for (let i = 0; i <= 10; i++) {
    const t = i / 10;
    ll.push(p.inv([box.xmin + (box.xmax - box.xmin) * t, box.ymin]), p.inv([box.xmin + (box.xmax - box.xmin) * t, box.ymax]),
      p.inv([box.xmin, box.ymin + (box.ymax - box.ymin) * t]), p.inv([box.xmax, box.ymin + (box.ymax - box.ymin) * t]));
  }
  const margin = 0.00006;
  const bbox = [Math.min(...ll.map(q => q[0])) - margin, Math.min(...ll.map(q => q[1])) - margin,
    Math.max(...ll.map(q => q[0])) + margin, Math.max(...ll.map(q => q[1])) + margin];

  // Fetch every context layer up front; the map's Layers panel decides what is shown and exported.
  const inArkansas = /^arkansas/i.test(zone.state);
  const wantB = true, wantR = true, wantF = true, wantP = inArkansas;
  const ctxFetch = (wantB || wantR || wantP || wantF)
    ? Promise.allSettled([
      wantB ? fetchBuildings(bbox) : Promise.resolve([]),
      wantR ? fetchRoadsAny(bbox) : Promise.resolve({ roads: [], source: '' }),
      wantP ? fetchParcels(bbox) : Promise.resolve([]),
      wantF ? fetchFlood(bbox) : Promise.resolve(null),
      fetchBuildingsMs(bbox),
      fetchBuildingsOsm(bbox),
      inArkansas ? fetchArdotWidths(bbox) : Promise.resolve([]),
      fetchOsmAreas(bbox),
    ])
    : null;
  const dem = await fetchElevation(bbox, 1, msg => setStatus(msg));

  setStatus('Building point grid…');
  await tick();
  const zAt = (x, y) => sample(dem, ...p.inv([x, y])) * zPerM;
  const pts = buildGrid(box, sNative, zAt);
  let pStats = gridStats(pts);

  setStatus('Tracing contours…');
  await tick();
  const cellsBudget = 1.2e6;
  const area = (box.xmax - box.xmin) * (box.ymax - box.ymin);
  // Contours are traced on their own grid (~3 ft / 1 m, or the point spacing if finer), capped for speed.
  const cTarget = u === 'ft' ? 3 : nativePerM;
  const cNative = Math.max(Math.min(sNative, cTarget), Math.sqrt(area / cellsBudget));
  let cgrid = buildGrid(box, cNative, zAt);
  if ($('smooth').checked) {
    const demPxNative = Math.max(dem.pixelMeters.x, dem.pixelMeters.y) * nativePerM;
    cgrid = smooth(cgrid, Math.max(0.8, demPxNative / cNative));
  }
  // Polygon boundary: everything outside it is dropped (no CSV points, no contours, no design surface).
  const mask = siteMask(zone);
  let maskedPts = 0;
  if (mask) { maskedPts = maskGrid(pts, mask); maskGrid(cgrid, mask); pStats = gridStats(pts); }
  let cStats = gridStats(cgrid);
  let levels = contourLevels(cStats.min, cStats.max, interval);
  let contours = contourLines(cgrid, levels);

  let context = null;
  let floodFailed = false, parcelsFailed = false, bldgFailed = {}, widthsFailed = false, areasFailed = false;
  let roadsSource = '';
  const contextNotes = [];
  if (!inArkansas) contextNotes.push('Parcels are only available for sites in Arkansas (statewide data from the Arkansas GIS Office).');
  if (ctxFetch) {
    setStatus('Adding site context…');
    const [bRes, rRes, pRes, fRes, msRes, osmRes, wRes, aRes] = await ctxFetch;
    if (aRes.status === 'rejected') contextNotes.push(aRes.reason?.message || String(aRes.reason));
    areasFailed = aRes.status === 'rejected';
    if (wRes.status === 'rejected') contextNotes.push(wRes.reason?.message || String(wRes.reason));
    widthsFailed = wRes.status === 'rejected';
    if (bRes.status === 'rejected') contextNotes.push(`USA Structures footprints unavailable: ${bRes.reason?.message || bRes.reason}`);
    for (const r of [msRes, osmRes]) if (r.status === 'rejected') contextNotes.push(r.reason?.message || String(r.reason));
    bldgFailed = { buildings: bRes.status === 'rejected', bldgMs: msRes.status === 'rejected', bldgOsm: osmRes.status === 'rejected' };
    if (rRes.status === 'rejected') contextNotes.push(`Roads unavailable: ${rRes.reason?.message || rRes.reason}`);
    else if (rRes.value.note) contextNotes.push(rRes.value.note);
    roadsSource = rRes.status === 'fulfilled' ? rRes.value.source : '';
    context = prepareContext(
      { buildings: bRes.status === 'fulfilled' ? bRes.value : [], roads: rRes.status === 'fulfilled' ? rRes.value.roads : [] },
      { fwd: p.fwd, box, zAt, nativePerM, zPerM });
    // Other footprint sources go through the same projection / draping.
    context.bldgMs = prepareContext({ buildings: msRes.status === 'fulfilled' ? msRes.value : [] }, { fwd: p.fwd, box, zAt, nativePerM, zPerM }).buildings;
    Object.assign(context, prepareOsmAreas(aRes.status === 'fulfilled' ? aRes.value : null, { fwd: p.fwd, box, zAt, nativePerM }));
    context.areasSource = aRes.status === 'fulfilled' ? aRes.value : null;
    context.widths = prepareWidths(wRes.status === 'fulfilled' ? wRes.value : [], { fwd: p.fwd, box, zAt, nativePerM, ftToNative: nativePerM * 0.3048 });
    context.bldgOsm = prepareContext({ buildings: osmRes.status === 'fulfilled' ? osmRes.value : [] }, { fwd: p.fwd, box, zAt, nativePerM, zPerM }).buildings;
    // One layer from all three: hand-mapped OSM outlines first, then Microsoft, then FEMA; heights borrowed across.
    context.bldgBest = combineBuildings(context);
    if (pRes.status === 'rejected') contextNotes.push(pRes.reason?.message || String(pRes.reason));
    if (fRes.status === 'rejected') contextNotes.push(`${fRes.reason?.message || fRes.reason} — flood zones are NOT included; generate again to retry.`);
    floodFailed = fRes.status === 'rejected';
    parcelsFailed = pRes.status === 'rejected';
    // BFE values from FEMA are in their own unit (normally feet, NAVD88); convert to the output Z unit.
    const bfeToOut = (v, unit) => {
      const meters = /met/i.test(unit) ? v : v * 1200 / 3937;
      return meters * zPerM;
    };
    Object.assign(context, prepareOverlays(
      { parcels: pRes.status === 'fulfilled' ? pRes.value : [], flood: fRes.status === 'fulfilled' ? fRes.value : null },
      { fwd: p.fwd, box, zAt, nativePerM, bfeToOut }));
    // Flood-zone hatching as real linework: floodway cross-hatched, other SFHA zones single hatch,
    // shaded X (0.2% chance) sparse. Spacing scales with the site so the pattern reads at any size.
    const hs = Math.max(Math.max(box.xmax - box.xmin, box.ymax - box.ymin) / 70, 4 * nativePerM / 3.2808);
    for (const z of context.floodZones) {
      if (!z.sfha && !z.shadedX) { z.hatch = []; continue; }
      const angles = z.floodway ? [45, 135] : [45];
      const sp = z.shadedX ? hs * 2.2 : hs;
      z.hatch = angles.flatMap(a => hatchPolygon(z.rings, a, sp, box));
      z.hatch3d = z.hatch.map(seg => densify(seg, 1.5 * nativePerM).map(([x, y]) => [x, y, zAt(x, y)]).filter(q => Number.isFinite(q[2]))).filter(l => l.length > 1);
    }
    await tick();
  }

  // Optional: building heights and roof shapes measured in the USGS lidar point cloud.
  let lidarInfo = null;
  if ($('bldg-lidar').checked && context) {
    try {
      // Only the lidar near buildings (12 m around each footprint, for the ground beside it) is downloaded.
      const lidList = ['bldgBest', 'buildings', 'bldgMs', 'bldgOsm'].filter(k => k === 'bldgBest' || visibility[k])
        .flatMap(k => (k === 'buildings' ? context.buildings : context[k]) || []);
      const pad = 12 * nativePerM;
      const focus = lidList.filter(b => b.ring?.length).map(b => {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const [x, y] of b.ring) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
        const a = p.inv([x0 - pad, y0 - pad]), c = p.inv([x1 + pad, y1 + pad]);
        return [Math.min(a[0], c[0]), Math.min(a[1], c[1]), Math.max(a[0], c[0]), Math.max(a[1], c[1])];
      });
      if (!focus.length) throw new Error('no buildings on this site');
      const lid = await loadLidar(bbox, p.fwd, msg => setStatus(msg), focus);
      setStatus('Fitting roofs to the lidar…');
      await tick();
      lidarInfo = { cellFt: Number($('bldg-lidar-res').value) || 1, name: lid.name, year: lid.year, n: lid.n, mb: lid.mb, hasBuildingClass: lid.hasBuildingClass, counts: {} };
      // The combined layer always; the single-source layers only if they are switched on (saves time).
      for (const k of ['bldgBest', 'buildings', 'bldgMs', 'bldgOsm']) {
        if (k !== 'bldgBest' && !visibility[k]) continue;
        const list = k === 'buildings' ? context.buildings : context[k];
        if (list?.length) lidarInfo.counts[k] = await applyLidar(list, lid, { zAt, zPerM, nativePerM, cellFt: Number($('bldg-lidar-res').value) || 1, style: massStyle(), tris: triangulate });
      }
    } catch (err) {
      console.error(err);
      lidarInfo = { error: err.message || String(err) };
      contextNotes.push(`Lidar building heights unavailable: ${lidarInfo.error}. Buildings use their dataset heights.`);
    }
  }

  // Existing trees found in the lidar canopy (a lighter whole-site read: ~1–2 points per m² is enough for crowns).
  if ($('trees-lidar').checked && context) {
    try {
      const lidT = await loadLidar(bbox, p.fwd, msg => setStatus(msg.replace('Reading lidar', 'Reading lidar for trees')), null, { maxSpacing: 0.7 });
      setStatus('Finding trees in the lidar canopy…');
      await tick();
      const rings = ['bldgBest', 'buildings', 'bldgMs', 'bldgOsm'].flatMap(k => ((k === 'buildings' ? context.buildings : context[k]) || []).map(b => b.ring)).filter(r => r?.length > 2);
      const T = findTrees(lidT, box, nativePerM, rings);
      context.trees = T.trees.map(t => ({ x: t.x, y: t.y, z: zAt(t.x, t.y), h: t.h * zPerM, hM: t.h, r: t.r * nativePerM, rM: t.r })).filter(t => Number.isFinite(t.z));
      context.treeInfo = { name: lidT.name, year: lidT.year, canopy: T.canopy, hasGround: T.hasGround, mb: lidT.mb };
    } catch (err) {
      console.error(err);
      context.trees = [];
      context.treeInfo = { error: err.message || String(err) };
      contextNotes.push(`Trees from lidar unavailable: ${context.treeInfo.error}.`);
    }
  }

  // Clean massing: every building without lidar massing gets a squared-up footprint extruded to its height.
  if (context && massStyle() === 'clean') {
    for (const k of ['bldgBest', 'buildings', 'bldgMs', 'bldgOsm']) {
      for (const b of (k === 'buildings' ? context.buildings : context[k]) || []) {
        if (b.mass || !b.ring || b.ring.length < 3) continue;
        const ring = orthogonalize(b.ring, 0.6 * nativePerM);
        b.mass = prismMass(ring, b.base, b.top, triangulate);
        b.massRing = ring;
      }
    }
  }

  // Optional: existing buildings burned into the surface (flat pads at an assumed floor, or raised to the roof).
  let bldgSurface = null;
  const bmode = $('bldg-mode').value;
  if (bmode !== 'off' && context) {
    const key = pickBuildingKey(context, bldgFailed);
    const list = key ? (key === 'buildings' ? context.buildings : context[key]) : [];
    if (list.length) {
      setStatus('Adding buildings to the surface…');
      await tick();
      const ftOut = u === 'ft' ? 1 : 0.3048;
      const ffe = (Number($('bldg-ffe').value) || 0) * ftOut, hAss = (Number($('bldg-h').value) || 15) * ftOut;
      const targets = list.map(b => {
        if (bmode === 'block') return b.roofAt || (b.heightKnown ? b.top : b.base + hAss);
        let hi = -Infinity;
        for (const [x, y] of densify([...b.ring, b.ring[0]], nativePerM)) { const z = zAt(x, y); if (z > hi) hi = z; }
        return hi + ffe;
      });
      burnBuildings(pts, list, targets);
      burnBuildings(cgrid, list, targets);
      if (mask) { maskGrid(pts, mask); maskGrid(cgrid, mask); }
      pStats = gridStats(pts);
      cStats = gridStats(cgrid);
      levels = contourLevels(cStats.min, cStats.max, interval);
      contours = contourLines(cgrid, levels);
      bldgSurface = { mode: bmode, key, count: list.length, known: list.filter(b => b.heightKnown).length,
        label: BUILDING_SOURCES.find(s => s.key === key)?.short || key, ffe: Number($('bldg-ffe').value) || 0, h: Number($('bldg-h').value) || 15 };
    }
  }

  setStatus('Fetching aerial imagery…');
  const { bitmap: imagery, credit: imageryCredit, src: imagerySrc, how: imageryHow, notes: imageryNotes, probe: imageryProbe } = await fetchImagery(zone, box);

  const conv = convergence(zone, c.lng, c.lat);
  const shade = hillshade(cgrid, 1 / toOut); // z (output units) -> native XY units
  const base = baseFor(zone, toOut, pts);
  const now = new Date();
  const site = {
    zone, units: u, toOut, zPerM, spacingOut, interval, box, pts, pStats, grid: cgrid, stats: cStats, shade,
    contours, context, contextNotes, roadsSource, lidar: lidarInfo, ctxInclude: { b: wantB, r: wantR, p: wantP, f: wantF }, floodFailed, parcelsFailed, bldgFailed, widthsFailed, areasFailed, imagery, imageryCredit, imagerySrc, imageryHow, imageryNotes, imageryProbe, bldgSurface, mask, maskedPts, convergence: conv, outUnit: u, dem, base, center: c, generated: now, bbox,
    tinted: false,
  };
  site.meta = buildMeta(site);
  state.result = site;
  sketch.onSite(site, sketchPending); sketchPending = null;

  showResults(site);
  drawContoursOnMap(site);
  if ($('panel').classList.contains('mode-design')) dzEnsure();
  applyOrigin();
  drawUnderlayThumb();
  renderPreview();
  v3Dirty();
  flowKick();
  imgUi();
  siteImgDraw();
  revitSiteChanged();
  const missing = pStats.missing - maskedPts;
  setStatus(missing
    ? `Done, but ${fmt(missing, 0)} grid points had no elevation data and were left out of the CSV/DXF.`
    : `Done — ${fmt(pts.nx * pts.ny - pStats.missing, 0)} points, ${levels.length} contour levels.`);
}

const tick = () => new Promise(r => setTimeout(r, 0));

/**
 * Imagery choice: id = 'auto', a source id (catalog or a flight found at a site), or 'custom' (pasted URL);
 * prefer = 'sharp' (most detail) or 'new' (newest source at most 1.5× coarser than the sharpest);
 * states = local catalogs to check (state codes).
 */
const imgChoice = { id: 'auto', custom: '', prefer: 'sharp', states: STATE_LIST.map(s => s.code) };
try {
  imgChoice.id = localStorage.getItem('c2r-imgsrc') || 'auto';
  imgChoice.custom = localStorage.getItem('c2r-imgcustom') || '';
  imgChoice.prefer = localStorage.getItem('c2r-imgprefer') === 'new' ? 'new' : 'sharp';
  const st = JSON.parse(localStorage.getItem('c2r-imgstates') || 'null');
  if (Array.isArray(st)) imgChoice.states = st.filter(c => STATE_LIST.some(s => s.code === c));
} catch { /* ignore */ }

// Probe results per site (sources checked, coverage, measured detail). Kept for the session and, without the
// pixels, in localStorage for a week so reopening a project doesn't re-check every service.
const PROBE_TTL = 7 * 864e5;
const probeMem = new Map();
const probeKey = (zone, box) => `${zone.code}|${[box.xmin, box.ymin, box.xmax, box.ymax].map(v => Math.round(v)).join(',')}|${imgChoice.states.join('+')}|${imgChoice.custom}`;
function probeLoad(key) {
  if (probeMem.has(key)) return probeMem.get(key);
  try {
    const all = JSON.parse(localStorage.getItem('c2r-imgprobe') || '{}');
    const e = all[key];
    if (e && Date.now() - e.t < PROBE_TTL) {
      for (const r of e.p.results) r.src = registerSource(r.src);
      probeMem.set(key, e.p);
      return e.p;
    }
  } catch { /* ignore */ }
  return null;
}
function probeSave(key, p) {
  probeMem.set(key, p);
  try {
    const all = JSON.parse(localStorage.getItem('c2r-imgprobe') || '{}');
    for (const k of Object.keys(all)) if (Date.now() - all[k].t > PROBE_TTL) delete all[k];
    all[key] = { t: Date.now(), p: { ...p, order: undefined } };
    const keys = Object.keys(all).sort((a, b) => all[b].t - all[a].t);
    for (const k of keys.slice(20)) delete all[k];
    localStorage.setItem('c2r-imgprobe', JSON.stringify(all));
  } catch { /* ignore */ }
}
function probeForget(zone, box) {
  const key = probeKey(zone, box);
  probeMem.delete(key);
  try { const all = JSON.parse(localStorage.getItem('c2r-imgprobe') || '{}'); delete all[key]; localStorage.setItem('c2r-imgprobe', JSON.stringify(all)); } catch { /* ignore */ }
}

/** Check the imagery sources at this site (cached), then return the order to try them in. */
async function imgPlanFor(zone, box) {
  const key = probeKey(zone, box);
  let p = probeLoad(key);
  if (!p) {
    setStatus('Checking aerial imagery sources…');
    const c = await imgCandidates(zone, box, { states: imgChoice.states, custom: customSource(imgChoice.custom) });
    p = await imgProbe(zone, box, c.list, {
      onProgress: (d, n, stage) => setStatus(stage === 'coverage'
        ? `Checking which imagery sources cover the site (${d} of ${n})…` : `Measuring detail in each source (${d} of ${n})…`),
    });
    p.notes = c.notes;
    p.checked = new Date().toISOString();
    probeSave(key, p);
  }
  const steps = imgRank(p.results, imgChoice.prefer);
  // Sources that failed only with an error may answer on a second try; they go last. Blank ones never.
  for (const r of p.results) if (r.status === 'error') steps.push([r.src, r.how]);
  const first = [];
  if (imgChoice.id === 'custom') {
    const cs = p.results.filter(r => r.src.id === 'custom').map(r => [r.src, r.how]);
    first.push(...(cs.length ? cs : customSource(imgChoice.custom) ? [[customSource(imgChoice.custom), 'export']] : []));
  } else if (imgChoice.id !== 'auto') {
    const mine = p.results.filter(r => r.src.id === imgChoice.id).sort((a, b) => (a.status === 'ok' ? 0 : 1) - (b.status === 'ok' ? 0 : 1)).map(r => [r.src, r.how]);
    const s0 = sourceById(imgChoice.id);
    if (mine.length) first.push(...mine);
    else if (s0) first.push([s0, s0.kind === 'tiles' ? 'tiles' : 'export']);
  }
  const seen = new Set();
  const order = [...first, ...steps].filter(([q, h]) => { const k = `${q.id}:${h}`; if (seen.has(k)) return false; seen.add(k); return true; });
  return { order, probe: p };
}

/** A fetched image that is mostly blank (no photos there after all) is thrown away. */
function blankCheck(canvas) {
  const f = emptyFraction(canvas);
  if (f > 0.15) { canvas.width = canvas.height = 0; throw new Error(`came back ${Math.round(f * 100)} % blank`); }
  return canvas;
}

/** Site imagery for the map preview, PNG and 3D view: about 0.5 ft/px, at most 4096 px on the long side. */
async function fetchImagery(zone, box) {
  const nativePerFt = zoneUnitsPerMeter(zone) * 0.3048;
  const wFt = (box.xmax - box.xmin) / nativePerFt, hFt = (box.ymax - box.ymin) / nativePerFt;
  const ftPerPx = Math.max(0.5, Math.max(wFt, hFt) / 4096);
  const W = Math.max(1, Math.round(wFt / ftPerPx)), H = Math.max(1, Math.round(hFt / ftPerPx));
  const notes = [];
  let plan;
  try { plan = await imgPlanFor(zone, box); }
  catch (e) { notes.push(`Checking sources failed: ${e.message || e}`); plan = { order: [], probe: null }; }
  for (const [src, how] of plan.order) {
    try {
      setStatus(`Fetching aerial imagery — ${src.label}…`);
      const canvas = blankCheck(await fetchBox(src, how, zone, box, W, H, {
        onTile: (d, n) => { if (n > 1) setStatus(`Fetching aerial imagery — ${src.label} (${d} of ${n})…`); },
      }));
      return { bitmap: canvas, credit: src.credit, src, how, notes, probe: plan.probe };
    } catch (e) { notes.push(`${src.label}${how === 'tiles' && src.kind !== 'tiles' ? ' (tiles)' : ''}: ${e.message || 'failed'}`); }
  }
  return { bitmap: null, credit: '', src: null, how: null, notes, probe: plan.probe };
}
/** The probe row for the source a site ended up using. */
const imgRow = site => site?.imageryProbe?.results.find(r => site.imagerySrc && r.src.id === site.imagerySrc.id && r.how === site.imageryHow) || null;
const AERIAL_RES = [
  { v: 0, label: 'Maximum detail (about 0.25 ft/px)' },
  { v: 0.5, label: '0.5 ft/px' },
  { v: 1, label: '1 ft/px' },
  { v: 2, label: '2 ft/px (small file)' },
];
const AERIAL_MAX_PX = 64e6;   // total pixels (~8000 x 8000) — keeps the browser and Revit responsive
const AERIAL_TILE = 2048;     // per-request size; the services allow 4096 but smaller requests are far more reliable
let aerialRes = (() => { try { const v = parseFloat(localStorage.getItem('c2r-aerial-res')); return AERIAL_RES.some(o => o.v === v) ? v : 0; } catch { return 0; } })();

/**
 * Clean aerial for Revit/CAD: the site box exactly, grid-north up, at the chosen resolution.
 * Large images are requested as a grid of tiles in the State Plane zone and stitched, so pixels line up exactly.
 * Cached per generated site and resolution. Returns { blob, w, h, credit, ftPerPx }.
 */
async function fetchAerialExport(site) {
  if (site._aerial && site._aerial.res === aerialRes && site._aerial.rot === (site.rot || 0)) return site._aerial;
  const { zone, box } = site;
  const toReq = zone.note ? 1 / zoneUnitsPerMeter(zone) : 1;
  const w = box.xmax - box.xmin, h = box.ymax - box.ymin;
  const nativePerFt = zoneUnitsPerMeter(zone) * 0.3048;
  const wFt = w / nativePerFt, hFt = h / nativePerFt;
  let ftPerPx = aerialRes || 0.25;
  if ((wFt / ftPerPx) * (hFt / ftPerPx) > AERIAL_MAX_PX) ftPerPx = Math.sqrt(wFt * hFt / AERIAL_MAX_PX);
  const W = Math.max(1, Math.round(wFt / ftPerPx)), H = Math.max(1, Math.round(hFt / ftPerPx));
  const fails = [];
  // The source that served the map imagery first, then the usual order.
  const steps = (await imgPlanFor(zone, box)).order;
  if (site.imagerySrc) { const i = steps.findIndex(([q, h]) => q.id === site.imagerySrc.id && h === site.imageryHow); if (i > 0) steps.unshift(...steps.splice(i, 1)); }
  for (const [src, how] of steps) {
    let canvas;
    try {
      canvas = blankCheck(await fetchBox(src, how, zone, box, W, H, { tile: AERIAL_TILE, onTile: (d, n) => setStatus(`Downloading aerial (${src.label}) — ${d} of ${n}…`) }));
    } catch (e) { fails.push(src.label); continue; }
    let out = canvas, OW = W, OH = H;
    if (site.rot) {
      setStatus('Turning aerial to project north…');
      out = rotateToProject(site, canvas, W, H);
      OW = out.width; OH = out.height;
      canvas.width = canvas.height = 0;
    }
    setStatus('Saving aerial JPG…');
    const blob = await new Promise(res => out.toBlob(res, 'image/jpeg', 0.92));
    out.width = out.height = 0;
    if (!blob) throw new Error('image too large for this browser — choose a coarser aerial resolution');
    site._aerial = { blob, w: OW, h: OH, credit: src.credit, ftPerPx: wFt / W, res: aerialRes, rot: site.rot || 0 };
    setStatus(`Aerial: ${fmt(OW, 0)} × ${fmt(OH, 0)} px, ${(wFt / W).toFixed(2)} ft/px${site.rot ? ', turned to project north' : ''}.`);
    return site._aerial;
  }
  throw new Error('aerial imagery service did not respond');
}

/**
 * Redraw a grid-north-up site image (W x H px covering site.box) so project north is up, on a white canvas
 * exactly covering aerialExtent(site). Each source pixel is mapped with one affine transform, so the result
 * lines up with the DXF frame and world file to the pixel.
 */
function rotateToProject(site, src, W, H) {
  const e = aerialExtent(site);
  const b = site.box, t = site.toOut;
  const sx = (b.xmax - b.xmin) * t / W, sy = (b.ymax - b.ymin) * t / H; // output units per source pixel
  let px = Math.min(sx, sy);
  let OW = Math.ceil(e.w / px), OH = Math.ceil(e.h / px);
  const cap = AERIAL_MAX_PX * 1.6;
  if (OW * OH > cap) { const k = Math.sqrt(OW * OH / cap); OW = Math.ceil(OW / k); OH = Math.ceil(OH / k); }
  const pX = e.w / OW, pY = e.h / OH;
  const r = site.rot * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
  const bx0 = b.xmin * t - site.base[0], by1 = b.ymax * t - site.base[1]; // pre-rotation NW corner
  const out = document.createElement('canvas');
  out.width = OW; out.height = OH;
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, OW, OH);
  ctx.imageSmoothingQuality = 'high';
  // Source pixel (i, j) -> output pixel: see outXY for the rotation, rows count down from the north edge.
  ctx.setTransform(c * sx / pX, -s * sx / pY, s * sy / pX, c * sy / pY,
    (c * bx0 - s * by1 - e.x0) / pX, (e.y1 - s * bx0 - c * by1) / pY);
  ctx.drawImage(src, 0, 0);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return out;
}

{
  const sel = $('aerial-res');
  sel.innerHTML = AERIAL_RES.map(o => `<option value="${o.v}"${o.v === aerialRes ? ' selected' : ''}>${o.label}</option>`).join('');
  sel.addEventListener('change', () => {
    aerialRes = parseFloat(sel.value);
    try { localStorage.setItem('c2r-aerial-res', String(aerialRes)); } catch { /* ignore */ }
  });
}

// ---------- Underlay processing (desaturate + wash toward white) ----------
// Colour >100% boosts saturation to offset the wash (USGS imagery is already muted).
const UL_DEFAULT = { sat: 110, wash: 40 };
const ulSettings = (() => { try { return { ...UL_DEFAULT, ...JSON.parse(localStorage.getItem('c2r-underlay2') || '{}') }; } catch { return { ...UL_DEFAULT }; } })();

/** In-place: keep `sat` of the colour (0..1 around luminance), then blend `wash` (0..1) toward white. */
function underlayPixels(data, sat, wash) {
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const y = 0.299 * r + 0.587 * g + 0.114 * b;
    const c = v => 255 - (255 - Math.max(0, Math.min(255, y + (v - y) * sat))) * (1 - wash);
    data[i] = c(r); data[i + 1] = c(g); data[i + 2] = c(b);
  }
}

async function makeUnderlayBlob(blob) {
  const bmp = await createImageBitmap(blob);
  const c = document.createElement('canvas');
  c.width = bmp.width; c.height = bmp.height;
  const ctx = c.getContext('2d');
  ctx.drawImage(bmp, 0, 0);
  bmp.close?.();
  const img = ctx.getImageData(0, 0, c.width, c.height);
  underlayPixels(img.data, ulSettings.sat / 100, ulSettings.wash / 100);
  ctx.putImageData(img, 0, 0);
  return new Promise(res => c.toBlob(res, 'image/jpeg', 0.9));
}

function drawUnderlayThumb() {
  $('ul-sat-v').textContent = `${ulSettings.sat}%`;
  $('ul-wash-v').textContent = `${ulSettings.wash}%`;
  const c = $('underlay-thumb'), ctx = c.getContext('2d');
  const src = state.result?.imagery;
  ctx.clearRect(0, 0, c.width, c.height);
  if (!src) return;
  // Fit the site image into the thumbnail, then draw a few sample lines so readability can be judged.
  const k = Math.max(c.width / src.width, c.height / src.height);
  ctx.drawImage(src, (c.width - src.width * k) / 2, (c.height - src.height * k) / 2, src.width * k, src.height * k);
  const img = ctx.getImageData(0, 0, c.width, c.height);
  underlayPixels(img.data, ulSettings.sat / 100, ulSettings.wash / 100);
  ctx.putImageData(img, 0, 0);
  ctx.strokeStyle = '#111'; ctx.lineWidth = 1;
  ctx.strokeRect(30, 22, 50, 34);
  ctx.beginPath(); ctx.moveTo(8, 75); ctx.bezierCurveTo(40, 60, 70, 85, 112, 66); ctx.stroke();
  ctx.fillStyle = '#111'; ctx.font = '600 9px system-ui, sans-serif'; ctx.fillText('BLDG A', 38, 43);
}

for (const [id, key] of [['ul-sat', 'sat'], ['ul-wash', 'wash']]) {
  $(id).value = ulSettings[key];
  $(id).addEventListener('input', e => {
    ulSettings[key] = Number(e.target.value);
    try { localStorage.setItem('c2r-underlay2', JSON.stringify(ulSettings)); } catch { /* ignore */ }
    drawUnderlayThumb();
  });
}
$('ul-reset').addEventListener('click', () => {
  Object.assign(ulSettings, UL_DEFAULT);
  $('ul-sat').value = ulSettings.sat; $('ul-wash').value = ulSettings.wash;
  try { localStorage.removeItem('c2r-underlay2'); } catch { /* ignore */ }
  drawUnderlayThumb();
});

/** Image extents in output coordinates (same frame as the CSV/DXF, after any local origin). */
function aerialExtent(site) {
  // With a rotation the image is turned to project north, so its frame is the box around the rotated site.
  const b = site.box;
  const cs = [[b.xmin, b.ymin], [b.xmax, b.ymin], [b.xmax, b.ymax], [b.xmin, b.ymax]].map(([x, y]) => outXY(site, x, y));
  const x0 = Math.min(...cs.map(q => q[0])), x1 = Math.max(...cs.map(q => q[0]));
  const y0 = Math.min(...cs.map(q => q[1])), y1 = Math.max(...cs.map(q => q[1]));
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
}

/** ESRI world file (.jgw): pixel size and the centre of the upper-left pixel, in output coordinates. */
function makeWorldFile(site, img) {
  const e = aerialExtent(site);
  const px = e.w / img.w, py = e.h / img.h;
  return [px, 0, 0, -py, e.x0 + px / 2, e.y1 - py / 2].map(v => v.toFixed(6)).join('\r\n') + '\r\n';
}

function buildMeta(site) {
  const z = site.zone;
  const u = site.units;
  const sources = site.dem.contributions.map(ct => `${ct.tier.label} (${fmt(ct.share * 100, ct.share < 0.995 ? 1 : 0)}%)`).join(', ');
  return {
    title: `Preliminary topography — ${fmtLatLon(site.center.lat, site.center.lng)}`,
    lines: [
      `Elevation: USGS 3DEP — ${sources}`,
      `Coordinates: NAD83 State Plane ${z.name} (EPSG:${z.code})${u === 'm' ? ', meters' : `, ${zoneUnitLabel(z)}`}`,
      `Vertical datum: NAVD88, ${u === 'm' ? 'meters' : zoneUnitLabel(z)}`,
      `Contour interval: ${site.interval}${OPTIONS[u].tick} (index every ${site.interval * 5}${OPTIONS[u].tick})`,
      `Elevation range: ${fmt(site.pStats.min, 1)} – ${fmt(site.pStats.max, 1)} ${u}`,
      `North arrow: grid north; true north is ${fmt(Math.abs(site.convergence), 2)}° ${site.convergence >= 0 ? 'east' : 'west'} of grid north`,
      `Imagery: ${site.imagery ? site.imageryCredit + imgDetailNote(site) : 'not available — hillshade shown'}`,
      `Generated ${site.generated.toISOString().slice(0, 10)} by Contours to Revit ${VERSION}`,
      ...(site.context ? [[BUILDING_SOURCES.filter(b => (site.vis || { buildings: true })[b.key]).map(b => `Buildings: ${b.short} (${(site.context[b.key] || []).length})`).join('; '), (site.vis || {}).roads !== false && site.ctxInclude.r ? `Roads: ${site.roadsSource === 'tiger' ? 'US Census TIGER' : '© OpenStreetMap contributors'}` : '', (site.vis || {}).parcels !== false && site.ctxInclude.p ? 'Parcels: Arkansas GIS Office' : '', (site.vis || {}).flood !== false ? 'Flood: FEMA NFHL' : ''].filter(Boolean).join('; ')] : []),
    ],
  };
}

// ---------- Results UI ----------
function showResults(site) {
  $('dxf-units-note').innerHTML = `In Revit, set <strong>Import units: ${site.units === 'm' ? 'Meters' : 'Feet'}</strong> when linking the DXF (don't use Auto-Detect).`;
  $('step-results').hidden = false;
  const u = site.units;
  $('rs-min').textContent = `${fmt(site.pStats.min, 1)} ${u}`;
  $('rs-max').textContent = `${fmt(site.pStats.max, 1)} ${u}`;
  $('rs-points').textContent = fmt(site.pts.nx * site.pts.ny - site.pStats.missing, 0);
  // (masked nodes outside a polygon boundary count as missing, so this is the real point count)
  const src = $('source');
  const finest = site.dem.contributions[0]?.tier;
  let html = '<div style="margin-bottom:6px;font-weight:600;color:var(--ink)">Elevation source (USGS 3DEP)</div>';
  for (const ct of site.dem.contributions) {
    const coarse = ct.tier.key !== '1m';
    html += `<div class="tier${coarse ? ' coarse' : ''}"><span class="bar"><i style="width:${(ct.share * 100).toFixed(1)}%"></i></span>${escapeHtml(ct.tier.label)} — ${fmt(ct.share * 100, ct.share < 0.995 ? 1 : 0)}%</div>`;
  }
  if (finest && finest.key !== '1m') {
    html += `<div class="warn" style="margin-top:8px">1 m lidar is not available here. Using ${escapeHtml(finest.label)} — expect smoother, less detailed contours.</div>`;
  }
  html += `<div style="margin:10px 0 4px;font-weight:600;color:var(--ink)">Aerial imagery</div><div id="src-imagery">${imgUsedText(site)}</div>`;
  if (site.bldgSurface) {
    const b = site.bldgSurface;
    html += `<div class="warn" style="margin-top:8px">${b.count} ${escapeHtml(b.label)} buildings are in the surface — ${b.mode === 'pad' ? `flat pads at the highest adjacent ground + ${b.ffe} ft` : `raised to the roof (${b.known} with data heights, others ${b.h} ft)`}. Assumed, not surveyed.</div>`;
  }
  const items = site.dem.contributions.flatMap(ct => ct.items);
  if (items.length) {
    html += '<details><summary>Datasets &amp; collection dates</summary><ul>';
    for (const it of items) html += `<li>${escapeHtml(it.title)}${it.start || it.end ? ` — collected ${escapeHtml(dateRange(it.start, it.end))}` : ''}</li>`;
    html += '</ul></details>';
  }
  if (site.context) {
    const nb = site.context.buildings.length;
    const nh = site.context.buildings.filter(b => b.heightKnown).length;
    const nr = site.context.roads.filter(r => r.kind === 'road').length;
    const dates = [...new Set(site.context.buildings.map(b => b.imageDate).filter(Boolean))].sort();
    html += `<div style="margin:10px 0 4px;font-weight:600;color:var(--ink)">Site context</div>`;
    const np = site.context.roads.length - nr;
    if (site.ctxInclude.b) html += `<div>Footprints — USA Structures: ${nb}${dates.length ? ` (imagery ${escapeHtml(dates[0].slice(0, 4))}${dates.length > 1 && dates.at(-1).slice(0, 4) !== dates[0].slice(0, 4) ? '–' + escapeHtml(dates.at(-1).slice(0, 4)) : ''})` : ''}, ${nh} with heights · Microsoft: ${(site.context.bldgMs || []).length}, ${(site.context.bldgMs || []).filter(b => b.heightKnown).length} with estimated heights · OpenStreetMap: ${(site.context.bldgOsm || []).length}, ${(site.context.bldgOsm || []).filter(b => b.heightKnown).length} with heights</div>`;
    if (site.lidar) html += `<div>${lidarSummary(site, true)}</div>`;
    const ti = site.context.treeInfo;
    if (ti) html += `<div>${ti.error ? `Trees: not found (${escapeHtml(ti.error)})` : `${(site.context.trees || []).length} trees from USGS lidar ${escapeHtml(ti.name)} — ${Math.round(ti.canopy * 100)}% canopy cover; positions, heights and crown spread are estimates`}</div>`;
    if (site.ctxInclude.r) html += `<div>${nr} road segment${nr === 1 ? '' : 's'}${np ? `, ${np} path${np === 1 ? '' : 's'}` : ''} (${site.roadsSource === 'tiger' ? 'US Census TIGER' : 'OpenStreetMap'}) — centerlines only; no source publishes pavement edges</div>`;
    if (site.ctxInclude.p) {
      const npc = site.context.parcels.length;
      html += `<div>${npc} parcel${npc === 1 ? '' : 's'} (Arkansas GIS Office)</div>`;
    }
    if (site.ctxInclude.f) {
      const fz = site.context.floodZones;
      const sfha = fz.filter(z => z.sfha);
      const zones = [...new Set(fz.map(z => z.zone + (z.floodway ? ' floodway' : z.shadedX ? ' (0.2%)' : '')))].sort();
      html += site.floodFailed
        ? ''
        : fz.length
        ? `<div>${sfha.length ? '<strong style="color:var(--warn)">Site is partly in a FEMA Special Flood Hazard Area.</strong> ' : ''}Flood zones: ${escapeHtml(zones.join(', '))}${site.context.bfes.length ? ` · ${site.context.bfes.length} BFE line${site.context.bfes.length === 1 ? '' : 's'}` : ''} (FEMA NFHL)</div>`
        : '<div>No mapped FEMA flood zones on this site (NFHL) — the area may be unmapped; check the FIRM panel.</div>';
    }
    for (const n of site.contextNotes) html += `<div class="warn" style="margin-top:6px">${escapeHtml(n)}</div>`;
  }
  src.innerHTML = html;
  document.querySelector('.tab[data-view="preview"]').disabled = false;
  document.querySelector('.tab[data-view="3d"]').disabled = false;
  $('flow-toggle').disabled = false;
  $('sun-toggle').disabled = false;
  $('wind-toggle').disabled = false;
}

// ---------- Layer visibility (map "Layers" panel drives the map, preview, PNG and DXF) ----------
const LAYERS = [
  { key: 'siteImage', label: 'Site aerial (sharper)', swatch: 'linear-gradient(135deg,#6b8f5e,#c9b98f)', note: 'map only' },
  { key: 'contours', label: 'Contours', swatch: '#ffb347' },
  ...BUILDING_SOURCES.map(b => ({ key: b.key, label: b.label, swatch: b.color })),
  { key: 'roads', label: 'Roads', swatch: '#ffe066' },
  { key: 'roadWidths', label: 'Road widths · ArDOT', swatch: '#fde68a' },
  { key: 'roadEdges', label: 'Road edges · ArDOT', swatch: '#facc15' },
  { key: 'streetAreas', label: 'Street surfaces · OSM', swatch: '#f59e0b' },
  { key: 'parking', label: 'Parking lots · OSM', swatch: '#cbd5e1' },
  { key: 'sidewalks', label: 'Sidewalks · OSM', swatch: '#f8fafc' },
  { key: 'trees', label: 'Trees · lidar', swatch: '#16a34a' },
  { key: 'parcels', label: 'Parcels', swatch: '#ff4fd8' },
  { key: 'flood', label: 'Flood zones', swatch: '#3b82f6' },
  { key: 'labels', label: 'Labels', swatch: '#ffffff', note: 'preview · PNG · DXF' },
  { key: 'imageFrame', label: 'Aerial image frame', swatch: '#93c5fd', note: 'DXF only' },
  { key: 'points', label: 'Grid points', swatch: '#7bd88f', note: 'DXF only' },
];
const visibility = (() => {
  const v = { trees: true, siteImage: true, contours: true, bldgBest: true, buildings: false, bldgMs: false, bldgOsm: false, roads: true, roadWidths: true, roadEdges: true, streetAreas: true, parking: true, sidewalks: true, imageFrame: true, parcels: true, flood: true, labels: true, points: false };
  try { Object.assign(v, JSON.parse(localStorage.getItem('c2r-layers') || '{}')); } catch { /* ignore */ }
  return v;
})();
function vis() { return { ...visibility }; }
// The Layers panel groups the layers: one switch per group, the individual layers in a dropdown under it.
const LAYER_GROUPS = [
  { key: 'ground', label: 'Ground & aerial', icon: '<path d="M2 17l5-7 4 5 3-4 6 6z"/>', keys: ['siteImage', 'contours', 'points', 'imageFrame'] },
  { key: 'bldg', label: 'Buildings', icon: '<path d="M4 20V9l6-4 6 4v11M16 20V12h4v8M8 20v-5h4v5"/>', keys: BUILDING_SOURCES.map(b => b.key), pick: true },
  { key: 'roads', label: 'Roads & paving', icon: '<path d="M7 21L10 3M17 21L14 3M12 6v2M12 11v2M12 16v2"/>', keys: ['roads', 'roadWidths', 'roadEdges', 'streetAreas', 'parking', 'sidewalks'] },
  { key: 'trees', label: 'Trees', icon: '<path d="M12 21v-6"/><circle cx="12" cy="10" r="6"/>', keys: ['trees'] },
  { key: 'property', label: 'Property & flood', icon: '<path d="M4 6l8-3 8 3v7c0 4-4 7-8 8-4-1-8-4-8-8z"/>', keys: ['parcels', 'flood'] },
  { key: 'labels', label: 'Labels', icon: '<path d="M5 6h14M12 6v13"/>', keys: ['labels'] },
];
const lpOpen = (() => { try { return new Set(JSON.parse(localStorage.getItem('c2r-lp-open') || '[]')); } catch { return new Set(); } })();
const lpMem = {};                         // layers that were on when a group was switched off

const LayersControl = L.Control.extend({
  options: { position: 'topright' },
  onAdd() {
    const el = L.DomUtil.create('div', 'layers-panel leaflet-bar');
    el.hidden = true; // shown once a site has been generated
    const row = l => `
      <label class="lp-row" data-key="${l.key}">
        <input type="checkbox" ${visibility[l.key] ? 'checked' : ''}>
        <span class="lp-sw" style="background:${l.swatch}"></span>
        <span class="lp-name">${l.label}</span>
        <span class="lp-count">${l.note || ''}</span>
      </label>`;
    el.innerHTML = '<div class="lp-title"><span>Layers</span></div>' + LAYER_GROUPS.map(g => {
      const ls = g.keys.map(k => LAYERS.find(l => l.key === k)).filter(Boolean);
      const single = ls.length === 1;
      return `<div class="lp-group${single ? ' lp-single' : ''}${lpOpen.has(g.key) ? ' open' : ''}" data-group="${g.key}">
        <div class="lp-ghead"><input type="checkbox" class="lp-gchk" aria-label="${g.label}"><svg class="lp-gic" viewBox="0 0 24 24" aria-hidden="true">${g.icon}</svg>
          <span class="lp-gname">${g.label}</span><span class="lp-gsum"></span>${single ? '' : '<button type="button" class="lp-caret" aria-label="Show the layers in this group">▾</button>'}</div>
        <div class="lp-items">${ls.map(row).join('')}</div></div>`;
    }).join('') + '<div class="lp-foot">Shown layers go into the preview, PNG &amp; DXF</div>';
    L.DomEvent.disableClickPropagation(el);
    L.DomEvent.disableScrollPropagation(el);
    el.querySelectorAll('.lp-row').forEach(row => row.querySelector('input').addEventListener('change', e => {
      visibility[row.dataset.key] = e.target.checked;
      try { localStorage.setItem('c2r-layers', JSON.stringify(visibility)); } catch { /* ignore */ }
      projTouch();
      applyVisibility();
      siteImgDraw();
      v3Dirty();
      lpSync();
    }));
    el.querySelectorAll('.lp-group').forEach(gEl => {
      const g = LAYER_GROUPS.find(x => x.key === gEl.dataset.group);
      const toggleOpen = () => { gEl.classList.toggle('open'); if (gEl.classList.contains('open')) lpOpen.add(g.key); else lpOpen.delete(g.key); try { localStorage.setItem('c2r-lp-open', JSON.stringify([...lpOpen])); } catch { /* ignore */ } };
      gEl.querySelector('.lp-caret')?.addEventListener('click', toggleOpen);
      gEl.querySelector('.lp-gname').addEventListener('click', () => (gEl.querySelector('.lp-caret') ? toggleOpen() : gEl.querySelector('.lp-gchk').click()));
      gEl.querySelector('.lp-gchk').addEventListener('change', e => {
        const avail = g.keys.filter(k => !el.querySelector(`.lp-row[data-key="${k}"]`)?.hidden);
        if (!e.target.checked) { lpMem[g.key] = avail.filter(k => visibility[k]); for (const k of g.keys) visibility[k] = false; }
        else {
          // Back to what was on before; buildings show one source (they overlap), the others everything found.
          const back = (lpMem[g.key] || []).filter(k => avail.includes(k));
          const on = back.length ? back : g.pick ? avail.slice(0, 1) : avail;
          for (const k of on) visibility[k] = true;
        }
        el.querySelectorAll('.lp-row').forEach(r => { r.querySelector('input').checked = !!visibility[r.dataset.key]; });
        try { localStorage.setItem('c2r-layers', JSON.stringify(visibility)); } catch { /* ignore */ }
        projTouch(); applyVisibility(); siteImgDraw(); v3Dirty(); lpSync();
      });
    });
    return el;
  },
});
map.addControl(new LayersControl());
setTimeout(() => lpSync());
/** Group switches (all / some / none on), short summaries, and groups with nothing on this site hidden. */
function lpSync() {
  const el = document.querySelector('.layers-panel'); if (!el) return;
  el.querySelectorAll('.lp-group').forEach(gEl => {
    const rows = [...gEl.querySelectorAll('.lp-row')].filter(r => !r.hidden);
    const on = rows.filter(r => visibility[r.dataset.key]);
    gEl.hidden = !rows.length;
    const chk = gEl.querySelector('.lp-gchk');
    chk.checked = on.length > 0; chk.indeterminate = on.length > 0 && on.length < rows.length && gEl.dataset.group !== 'bldg';
    // Summary: the count of the main layer that's on (or how many are on).
    const first = on[0], raw = first?.querySelector('.lp-count').textContent || '', cnt = /\d/.test(raw) && !raw.includes('·') ? raw : 'on';
    gEl.querySelector('.lp-gsum').textContent = !on.length ? 'off' : gEl.classList.contains('lp-single') || gEl.dataset.group === 'bldg' ? cnt : `${on.length} of ${rows.length}`;
  });
}

function updateLayerCounts(site) {
  const c = site?.context;
  const counts = {
    contours: site ? `${site.contours.length} levels` : '',
    buildings: c ? (site.bldgFailed?.buildings ? 'failed' : String(c.buildings.length)) : '',
    bldgMs: c ? (site.bldgFailed?.bldgMs ? 'failed' : String((c.bldgMs || []).length)) : '',
    bldgBest: c ? String((c.bldgBest || []).length) : '',
    bldgOsm: c ? (site.bldgFailed?.bldgOsm ? 'failed' : String((c.bldgOsm || []).length)) : '',
    roads: c ? String(c.roads.length) : '',
    roadWidths: c ? (!site.ctxInclude.p ? 'AR only' : site.widthsFailed ? 'failed' : String((c.widths || []).length)) : '',
    streetAreas: c ? (site.areasFailed ? 'failed' : String((c.streetAreas || []).length)) : '',
    parking: c ? (site.areasFailed ? 'failed' : String((c.parking || []).length)) : '',
    sidewalks: c ? (site.areasFailed ? 'failed' : String((c.sidewalks || []).length)) : '',
    roadEdges: c ? (!site.ctxInclude.p ? 'AR only' : site.widthsFailed ? 'failed' : String((c.widths || []).length)) : '',
    parcels: c ? (!site.ctxInclude.p ? 'AR only' : site.parcelsFailed ? 'failed' : String(c.parcels.length)) : '',
    trees: c ? (c.treeInfo?.error ? 'failed' : c.trees ? String(c.trees.length) : 'off') : '',
    flood: c ? (site.floodFailed ? 'failed' : c.floodZones.length ? String(c.floodZones.length) : 'none') : '',
    points: site ? `${fmt(site.pts.nx * site.pts.ny - site.pStats.missing, 0)} · DXF only` : 'DXF only',
    labels: 'preview · PNG · DXF',
    siteImage: site ? (site.imagery ? (site.imagerySrc?.label || 'yes').replace(/ —.*$/, '') : 'none') : '',
    imageFrame: 'DXF only',
  };
  // New site: turn on the most detailed building source that has footprints here (Microsoft, then OSM, then
  // FEMA/ORNL), the others off. A project being opened keeps the layers it was saved with.
  if (site && c && layerDefaultsFor !== site) {
    layerDefaultsFor = site;
    if (state.keepLayers) state.keepLayers = false;
    else {
      const order = ['bldgBest', 'bldgMs', 'bldgOsm', 'buildings'];
      const best = order.find(k => /^\d+$/.test(counts[k]) && Number(counts[k]) > 0);
      if (best) {
        for (const k of order) visibility[k] = k === best;
        try { localStorage.setItem('c2r-layers', JSON.stringify(visibility)); } catch { /* ignore */ }
      }
    }
  }
  const panel = document.querySelector('.layers-panel');
  if (panel) panel.hidden = !site;
  // Layers with nothing on this site are hidden rather than listed with a 0 (failed fetches stay visible).
  document.querySelectorAll('.layers-panel .lp-row').forEach(row => {
    const k = row.dataset.key;
    row.querySelector('.lp-count').textContent = counts[k];
    row.hidden = !!site && ['0', 'none', 'AR only'].includes(counts[k]);
    row.querySelector('input').checked = !!visibility[k];
  });
  lpSync();
}
let layerDefaultsFor = null;

function applyVisibility() {
  for (const [key, group] of Object.entries(state.mapGroups || {})) {
    const designOwns = key === 'contours' && $('panel').classList.contains('mode-design');
    if (visibility[key] && !designOwns) group.addTo(map); else map.removeLayer(group);
  }
  if (!$('preview').hidden) renderPreview();
}

// ----- Diagram colours for existing buildings and trees (category defaults + paint bucket, from the sketch model) -----
let dgRefs = { trees: [], bldgs: [] };
const treeKey = t => `${Math.round(t.x)},${Math.round(t.y)}`;
/** A building's key: its footprint centre (stable when the site is generated again). */
function bldgKey(b) {
  const R = b.ring || b.wall?.ring; if (!R?.length) return '';
  let x = 0, y = 0; for (const p of R) { x += p[0]; y += p[1]; }
  return `${Math.round(x / R.length)},${Math.round(y / R.length)}`;
}
const inRingXY = (r, x, y) => { let c = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const [xi, yi] = r[i], [xj, yj] = r[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c; } return c; };
/** Existing tree or building (shown layers only) at a plan point → its key, or null. */
function pickContext([x, y], kind) {
  const site = state.result; if (!site?.context) return null;
  if (kind === 'tree') {
    if (!visibility.trees) return null;
    let best = null;
    for (const t of site.context.trees || []) { const d = Math.hypot(t.x - x, t.y - y); if (d < t.r && (!best || d < best.d)) best = { d, t }; }
    return best ? treeKey(best.t) : null;
  }
  for (const src of BUILDING_SOURCES) {
    if (!visibility[src.key]) continue;
    for (const b of site.context[src.key] || []) if (b.ring && inRingXY(b.ring, x, y)) return bldgKey(b);
  }
  return null;
}
/** Plan: existing buildings and trees take the diagram colours in the Diagram tab, their layer colours elsewhere. */
function dgMapStyle() {
  try { if (!sketch) return; } catch { return; }            // (before the sketch module is set up)
  const on = sketch.diagram, C = sketch.dgColors();
  for (const r of dgRefs.bldgs) r.poly.setStyle(on ? { color: '#57534e', weight: 1, fillColor: C.fill('b', r.key), fillOpacity: 0.95 } : r.base);
  for (const r of dgRefs.trees) {
    const f = on && C.fill('t', r.key);
    r.poly.setStyle(on ? { color: shadeHex(f, 0.6), weight: 1, opacity: 0.9, fillColor: f, fillOpacity: 0.9 } : r.base);
  }
}
function shadeHex(h, k) { const n = parseInt(h.slice(1), 16); const c = v => Math.round(v * k).toString(16).padStart(2, '0'); return `#${c(n >> 16 & 255)}${c(n >> 8 & 255)}${c(n & 255)}`; }

function drawContoursOnMap(site) {
  for (const g of Object.values(state.mapGroups || {})) map.removeLayer(g);
  const p = projector(site.zone);
  const renderer = L.canvas({ padding: 0.3 });
  const ll = ([x, y]) => { const [lon, lat] = p.inv([x, y]); return [lat, lon]; };
  dgRefs = { trees: [], bldgs: [] };
  const groups = { contours: L.layerGroup(), roads: L.layerGroup(), roadWidths: L.layerGroup(), roadEdges: L.layerGroup(), streetAreas: L.layerGroup(), parking: L.layerGroup(), sidewalks: L.layerGroup(), parcels: L.layerGroup(), flood: L.layerGroup(), trees: L.layerGroup() };
  for (const src of BUILDING_SOURCES) groups[src.key] = L.layerGroup();
  for (const c of site.contours) {
    const major = isMajor(c.level, site.interval);
    for (const line of c.lines) {
      L.polyline(line.map(ll), { renderer, color: major ? '#ffb347' : '#ffffff', weight: major ? 2 : 0.8, opacity: major ? 0.95 : 0.7, interactive: false }).addTo(groups.contours);
    }
  }
  if (site.context) {
    for (const z of site.context.floodZones || []) {
      if (!z.sfha && !z.shadedX) continue;
      L.polygon(z.rings.map(r => r.map(ll)), { renderer, color: '#8ec5ff', weight: 2, fill: false, interactive: false }).addTo(groups.flood);
      for (const seg of z.hatch || []) L.polyline(seg.map(ll), { renderer, color: '#8ec5ff', weight: 0.9, opacity: 0.85, interactive: false }).addTo(groups.flood);
    }
    for (const pc of site.context.parcels || []) {
      for (const l of pc.lines) L.polyline(l.map(ll), { renderer, color: '#ff4fd8', weight: 1.4, interactive: false }).addTo(groups.parcels);
    }
    for (const r of site.context.roads) {
      // Centerlines dashed; edges (solid) only if a source ever provides real ones.
      L.polyline(r.center.map(ll), { renderer, color: r.kind === 'road' ? '#ffe066' : '#9be7ff', weight: r.kind === 'road' ? 2 : 1.2, dashArray: r.kind === 'road' ? '10 6' : '3 4', interactive: false }).addTo(groups.roads);
      for (const e of r.edges) L.polyline(e.map(ll), { renderer, color: '#ffe066', weight: 1.4, interactive: false }).addTo(groups.roads);
    }
    for (const a of site.context.parking || []) L.polygon(a.rings.map(r => r.map(ll)), { renderer, color: '#cbd5e1', weight: 1.4, fillColor: '#cbd5e1', fillOpacity: 0.15, interactive: false }).addTo(groups.parking);
    for (const a of site.context.streetAreas || []) L.polygon(a.rings.map(r => r.map(ll)), { renderer, color: '#f59e0b', weight: 1.4, fillColor: '#f59e0b', fillOpacity: 0.1, interactive: false }).addTo(groups.streetAreas);
    for (const sw of site.context.sidewalks || []) L.polyline(sw.line.map(ll), { renderer, color: '#f8fafc', weight: 1.2, opacity: 0.9, interactive: false }).addTo(groups.sidewalks);
    // Trees: crown outlines (a slightly wobbly circle reads as a tree) and a trunk dot.
    for (const t of site.context.trees || []) {
      const ring = Array.from({ length: 18 }, (_, k) => { const a = k / 18 * 2 * Math.PI, w = 1 + 0.07 * Math.sin(5 * a + t.x); return [t.x + t.r * w * Math.cos(a), t.y + t.r * w * Math.sin(a)]; });
      const tSty = { color: '#4ade80', weight: 1, opacity: 0.9, fillColor: '#16a34a', fillOpacity: 0.28 };
      dgRefs.trees.push({ poly: L.polygon(ring.map(ll), { renderer, ...tSty, interactive: false }).addTo(groups.trees), key: treeKey(t), base: tSty });
      L.circleMarker(ll([t.x, t.y]), { renderer, radius: 1.5, color: '#bbf7d0', weight: 0, fillOpacity: 0.9, interactive: false }).addTo(groups.trees);
    }
    for (const w of site.context.widths || []) {
      // Recorded widths: ArDOT's own centerline, hover for the record.
      L.polyline(w.center.map(ll), { color: '#fde68a', weight: 5, opacity: 0.35, interactive: true }).bindTooltip(`${w.text}<br><small>${w.source}</small>`, { sticky: true }).addTo(groups.roadWidths);
      for (const e of w.roadEdges) L.polyline(e.map(ll), { renderer, color: '#facc15', weight: 1.6, interactive: false }).addTo(groups.roadEdges);
      for (const e of w.surfaceEdges) L.polyline(e.map(ll), { renderer, color: '#facc15', weight: 0.8, opacity: 0.7, interactive: false }).addTo(groups.roadEdges);
    }
    for (const src of BUILDING_SOURCES) {
      for (const b of site.context[src.key] || []) {
        const bSty = { color: src.color, weight: 1.5, fillColor: src.color, fillOpacity: 0.12 };
        dgRefs.bldgs.push({ poly: L.polygon(b.ring.map(ll), { renderer, ...bSty, interactive: false }).addTo(groups[src.key]), key: bldgKey(b), base: bSty });
      }
    }
  }
  state.mapGroups = groups;
  dgMapStyle();
  updateLayerCounts(site);
  applyVisibility();
}

function renderPreview() {
  const site = state.result;
  if (!site) return;
  const canvas = $('preview-canvas');
  const r = canvas.getBoundingClientRect();
  if (!r.width || !r.height) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(r.width * dpr);
  canvas.height = Math.round(r.height * dpr);
  site.tinted = document.querySelector('input[name="pv"]:checked').value === 'tint';
  site.vis = vis();
  drawMap(canvas, site, 'preview');
}

const curView = () => document.querySelector('.tab[data-view].active')?.dataset.view || 'map';
document.querySelectorAll('.tab[data-view]').forEach(t => t.addEventListener('click', () => {
  if (t.disabled) return;
  document.querySelectorAll('.tab[data-view]').forEach(o => { o.classList.toggle('active', o === t); o.setAttribute('aria-selected', String(o === t)); });
  const v = t.dataset.view;
  $('preview').hidden = v !== 'preview';
  $('view3d').hidden = v !== '3d';
  if (v === 'preview') renderPreview();
  else if (v === 'map') map.invalidateSize();
  if (v === '3d') v3Open(); else { v3?.show(false); sketch.attach3d(null); }
  // The Layers panel follows into the 3D view (same toggles: they drape on the ground and switch the massing).
  const lp = document.querySelector('.layers-panel');
  if (lp) {
    if (v === '3d') { $('view3d').appendChild(lp); lp.classList.add('lp-3d'); }
    else if (lp.classList.contains('lp-3d')) { lp.classList.remove('lp-3d'); map._controlCorners.topright.appendChild(lp); }
  }
  flowKick();
}));
document.querySelectorAll('input[name="pv"]').forEach(r => r.addEventListener('change', renderPreview));
window.addEventListener('resize', () => { if (!$('preview').hidden) renderPreview(); });

// ---------- Outputs ----------
/**
 * Native zone XY -> output XY: scale to output units, subtract the local origin, then rotate about it so the
 * building's project-north bearing (site.rot, ° clockwise from grid north) points straight up (+Y).
 */
function outXY(site, x, y) {
  const X = x * site.toOut - site.base[0], Y = y * site.toOut - site.base[1];
  if (!site.rot) return [X, Y];
  const r = site.rot * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
  return [X * c - Y * s, X * s + Y * c];
}
/** Elevation datum subtracted from every output Z (0 = real NAVD88 elevations). */
const datumOf = site => site.datum || 0;

function makeCsv(site) {
  const { pts } = site;
  const rows = [];
  for (let j = 0; j < pts.ny; j++) {
    for (let i = 0; i < pts.nx; i++) {
      const zv = pts.z[j * pts.nx + i];
      if (Number.isNaN(zv)) continue;
      const [x, y] = outXY(site, pts.x0 + i * pts.s, pts.y0 + j * pts.s);
      rows.push(`${x.toFixed(3)},${y.toFixed(3)},${(zv - datumOf(site)).toFixed(3)}`);
    }
  }
  return rows.join('\r\n') + '\r\n';
}

function labelHeight(site) {
  const ext = Math.max(site.box.xmax - site.box.xmin, site.box.ymax - site.box.ymin) * site.toOut;
  return Math.max(site.units === 'ft' ? 1 : 0.3, Math.min(ext / 120, site.units === 'ft' ? 12 : 4));
}

// ---- DXF label layout (model units), so labels from the contour and context DXFs don't pile up ----
const textW = (str, h) => str.length * h * 0.62;
const dxfBox = (x, y, w, h, ang = 0) => {
  const a = ang * Math.PI / 180, c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a));
  const hw = (w * c + h * s) / 2 + h * 0.3, hh = (w * s + h * c) / 2 + h * 0.2;
  return { x0: x - hw, x1: x + hw, y0: y - hh, y1: y + hh };
};
const overlaps = (b, list) => list.some(o => b.x0 < o.x1 && b.x1 > o.x0 && b.y0 < o.y1 && b.y1 > o.y0);

/** Positions for flood-zone, parcel and BFE labels (output units) for the visible layers, nudged apart. */
function contextLabels(site, v) {
  const h = labelHeight(site);
  const items = [], boxes = [];
  if (v.labels === false) return { items, boxes };
  const place = (lines, x, y, z, optional = false) => {
    // lines: [{text, size, dy}] stacked around (x, y); try the anchor, then offsets below/above/sideways.
    const w = Math.max(...lines.map(l => textW(l.text, l.size)));
    const hh = lines.reduce((a, l) => a + l.size * 1.4, 0);
    const dirs = [[0, 0], [0, -1], [0, 1], [1, 0], [-1, 0], [1, -1], [-1, -1], [1, 1], [-1, 1]];
    for (let ring = 0; ring <= (optional ? 1 : 5); ring++) {
      for (const [dx, dy] of dirs) {
        if ((ring === 0) !== (!dx && !dy)) continue;
        const cx = x + dx * ring * w * 0.6, cy = y + dy * ring * hh;
        const b = dxfBox(cx, cy, w, hh);
        if (!overlaps(b, boxes)) { boxes.push(b); items.push({ lines, x: cx, y: cy, z, ax: x, ay: y }); return; }
      }
    }
    if (optional) return; // no room: drop (parcel labels on dense lots)
    const b = dxfBox(x, y, w, hh); boxes.push(b); items.push({ lines, x, y, z, ax: x, ay: y });
  };
  if (site.context) {
    if (site.ctxInclude.f && v.flood) {
      for (const z of site.context.floodZones) {
        if (!z.label || !Number.isFinite(z.label.z)) continue;
        const [x, y] = outXY(site, z.label.x, z.label.y);
        place([{ text: z.text, size: h, layer: 'C-FLOD-TEXT' }], x, y, z.label.z);
      }
      for (const b of site.context.bfes) {
        const mid = b.line[Math.floor(b.line.length / 2)];
        const [x, y] = outXY(site, mid[0], mid[1]);
        place([{ text: `BFE ${b.elev}`, size: h * 0.8, layer: 'C-FLOD-TEXT' }], x, y + h, b.elevOut);
      }
    }
    if (v.roadWidths) {
      for (const w of site.context.widths || []) {
        const m = w.center[Math.floor(w.center.length / 2)];
        if (!m) continue;
        const [x, y] = outXY(site, m[0], m[1]);
        place([{ text: w.text, size: h * 0.6, layer: 'C-ROAD-WDTH' }], x, y, m[2], true);
      }
    }
    if (site.ctxInclude.p && v.parcels) {
      for (const pc of site.context.parcels) {
        if (!pc.label || !Number.isFinite(pc.label.z)) continue;
        const [x, y] = outXY(site, pc.label.x, pc.label.y);
        const lines = [];
        if (pc.id) lines.push({ text: pc.id, size: h * 0.8, layer: 'C-PROP-TEXT' });
        if (pc.owner) lines.push({ text: pc.owner.slice(0, 60), size: h * 0.6, layer: 'C-PROP-TEXT' });
        if (lines.length) place(lines, x, y, pc.label.z, true);
      }
    }
  }
  return { items, boxes };
}

/** One DXF with every layer currently shown in the map's Layers panel. */
function makeDxf(site, v) {
  const d = new Dxf(site.units, datumOf(site));
  const labels = contextLabels(site, v);
  if (v.contours) addContours(d, site, labels.boxes, v.labels !== false);
  if (site.context) addContext(d, site, v, labels);
  if (v.points) addPoints(d, site);
  if (v.imageFrame) {
    // Exact extent of the aerial JPG, for snapping the image corner in Revit.
    const e = aerialExtent(site), z = site.pStats.min, h = labelHeight(site);
    d.layer('C-IMAG-BNDY', 140);
    d.polyline3d('C-IMAG-BNDY', [[e.x0, e.y0, z], [e.x1, e.y0, z], [e.x1, e.y1, z], [e.x0, e.y1, z]], true);
    if (v.labels !== false) {
      const t = `AERIAL IMAGE EXTENT ${e.w.toFixed(2)} x ${e.h.toFixed(2)} ${site.units === 'm' ? 'M' : 'FT'} - LOWER-LEFT CORNER`;
      d.text('C-IMAG-BNDY', e.x0 + textW(t, h * 0.6) / 2 + h, e.y0 + h, z, h * 0.6, t);
    }
  }
  if (site.base[0] || site.base[1]) {
    // Origin marker at (0,0): a cross and circle on C-ORIG, at ground level, labelled with its State Plane values.
    const h = labelHeight(site);
    const ox = site.base[0] / site.toOut, oy = site.base[1] / site.toOut;
    const [lon, lat] = projector(site.zone).inv([ox, oy]);
    let z = sample(site.dem, lon, lat) * site.zPerM;
    if (!Number.isFinite(z)) z = site.pStats.min;
    d.layer('C-ORIG', 1);
    const r = h * 2;
    d.polyline3d('C-ORIG', [[-r * 2, 0, z], [r * 2, 0, z]]);
    d.polyline3d('C-ORIG', [[0, -r * 2, z], [0, r * 2, z]]);
    const circ = []; for (let i = 0; i < 24; i++) { const a = i / 24 * Math.PI * 2; circ.push([r * Math.cos(a), r * Math.sin(a), z]); }
    d.polyline3d('C-ORIG', circ, true);
    if (v.labels !== false) {
      d.text('C-ORIG', r * 2.2 + textW('LOCAL ORIGIN 0,0', h) / 2, r * 0.9, z, h, 'LOCAL ORIGIN 0,0');
      const t2 = `= E ${site.base[0].toFixed(3)} N ${site.base[1].toFixed(3)} (EPSG:${site.zone.code})`;
      d.text('C-ORIG', r * 2.2 + textW(t2, h * 0.7) / 2, -r * 0.4, z, h * 0.7, t2);
      const lines = [];
      if (site.rot) lines.push(`PROJECT NORTH (UP) = ${bearingText(site.rot)} OF GRID NORTH`);
      if (datumOf(site)) lines.push(`Z = ELEVATION - ${datumOf(site).toFixed(2)} (DATUM = 0)`);
      lines.forEach((t, i) => d.text('C-ORIG', r * 2.2 + textW(t, h * 0.7) / 2, -r * 0.4 - h * 1.2 * (i + 1), z, h * 0.7, t));
    }
    // North arrows from the origin: grid north (survey / State Plane) and true north, in this file's frame.
    d.layer('C-ORIG-NRTH', 1);
    const len = r * 6;
    const arrow = (bearing, label) => {
      const a = (bearing - (site.rot || 0)) * Math.PI / 180; // bearing in the grid frame -> drawing frame
      const ux = Math.sin(a), uy = Math.cos(a), px = -uy, py = ux;
      const tip = [ux * len, uy * len];
      d.polyline3d('C-ORIG-NRTH', [[ux * r, uy * r, z], [tip[0], tip[1], z]]);
      d.polyline3d('C-ORIG-NRTH', [[tip[0] - ux * r + px * r * 0.4, tip[1] - uy * r + py * r * 0.4, z], [tip[0], tip[1], z],
        [tip[0] - ux * r - px * r * 0.4, tip[1] - uy * r - py * r * 0.4, z]]);
      if (v.labels !== false) d.text('C-ORIG-NRTH', tip[0] + ux * h * 1.5, tip[1] + uy * h * 1.5, z, h * 0.7, label, -((bearing - (site.rot || 0))));
    };
    arrow(0, 'GRID N');
    if (Math.abs(site.convergence) > 0.01) arrow(site.convergence, 'TRUE N');
  }
  return d.toString();
}

const TOPO_LAYERS = { majr: 'C-TOPO-MAJR', minr: 'C-TOPO-MINR', text: 'C-TOPO-TEXT', cMaj: 30, cMin: 8, cTxt: 7 };
function addContours(d, site, avoid, labelsOn = true, contours = site.contours, L = TOPO_LAYERS) {
  d.layer(L.majr, L.cMaj).layer(L.minr, L.cMin);
  if (labelsOn) d.layer(L.text, L.cTxt);
  const h = labelHeight(site);
  const taken = [...avoid]; // keep clear of parcel / flood labels
  for (const c of contours) {
    const major = isMajor(c.level, site.interval);
    const layer = major ? L.majr : L.minr;
    for (const line of c.lines) {
      const out = line.map(([x, y]) => [...outXY(site, x, y), c.level]);
      const closed = line.length > 3 && line[0][0] === line[line.length - 1][0] && line[0][1] === line[line.length - 1][1];
      d.polyline3d(layer, closed ? out.slice(0, -1) : out, closed);
      if (major && labelsOn) {
        const str = formatElev(c.level, site.interval);
        let last = null;
        for (const p of labelPositions(out.map(q => [q[0], q[1]]), h * 13, h * 8)) {
          if (last && Math.hypot(p.x - last.x, p.y - last.y) < h * 34) continue;
          const b = dxfBox(p.x, p.y, textW(str, h), h, p.angle);
          if (overlaps(b, taken)) continue;
          d.text(L.text, p.x, p.y, c.level, h, str, p.angle);
          taken.push(b);
          last = p;
        }
      }
    }
  }
}

/** One line about the lidar building heights (html: escaped for the Data sources panel). */
function lidarSummary(site, html) {
  const L = site.lidar, e = html ? escapeHtml : t => t;
  if (L.error) return `Lidar building heights unavailable (${e(L.error)}) — buildings use their dataset heights.`;
  const name = { bldgBest: 'Combined', buildings: 'USA Structures', bldgMs: 'Microsoft', bldgOsm: 'OpenStreetMap' };
  const parts = Object.entries(L.counts).map(([k, c]) => `${name[k]} ${c.used} of ${c.used + c.skipped} (${c.flat} flat, ${c.shaped} pitched or stepped${c.rejected ? `; ${c.rejected} too tree-covered to trust` : ''})`);
  return `Heights & roofs from USGS lidar ${e(L.name)}${L.year ? ` (flown ${L.year})` : ''}: ${parts.join(' · ') || 'no footprints'}. Others keep their dataset height.`;
}

/** Footprint outlines (closed 3D polylines at the lowest ground point) and massing (3DFACE walls + flat roof). */
function addBuildings(d, list, otln, mass, P) {
  for (const b of list) {
    const ring = b.ring;
    d.polyline3d(otln, ring.map(([x, y]) => P(x, y, b.base)), true);
    if (b.mass) {
      // Lidar massing: blocks per roof plane (faces are triangles or quads).
      for (const fc of b.mass.f) d.face3d(mass, fc.map(i => P(...b.mass.v[i])));
      continue;
    }
    const W = b.wall?.ring || ring, tz = i => (b.wall ? b.wall.top[i] : b.ringTop ? b.ringTop[i] : b.top);
    for (let i = 0; i < W.length; i++) {
      const i2 = (i + 1) % W.length, [x0, y0] = W[i], [x1, y1] = W[i2];
      d.face3d(mass, [P(x0, y0, b.base), P(x1, y1, b.base), P(x1, y1, tz(i2)), P(x0, y0, tz(i))]);
    }
    if (b.roof) for (const [i, j, k] of b.roof.tris) d.face3d(mass, [P(...b.roof.pts[i]), P(...b.roof.pts[j]), P(...b.roof.pts[k])]);
    else for (const [i, j, k] of triangulate(ring)) d.face3d(mass, [P(...ring[i], b.top), P(...ring[j], b.top), P(...ring[k], b.top)]);
  }
}

function addContext(d, site, v, labels) {
  const P = (x, y, z) => [...outXY(site, x, y), z];
  if (v.trees && site.context.trees?.length) {
    // Trees: crown outline at the ground, a trunk point, and the height as text (lidar estimate).
    const h = labelHeight(site) * 0.6, u = site.units === 'm' ? 'M' : "'";
    d.layer('L-PLNT-TREE', 3);
    if (v.labels !== false) d.layer('L-PLNT-TEXT', 3);
    for (const t of site.context.trees) {
      d.polyline3d('L-PLNT-TREE', Array.from({ length: 16 }, (_, k) => P(t.x + t.r * Math.cos(k / 16 * 2 * Math.PI), t.y + t.r * Math.sin(k / 16 * 2 * Math.PI), t.z)), true);
      d.point('L-PLNT-TREE', ...P(t.x, t.y, t.z));
      if (v.labels !== false && t.r > h * 2) { const [x, y] = outXY(site, t.x, t.y); d.text('L-PLNT-TEXT', x, y + h * 0.7, t.z, h, `${Math.round(t.h)}${u}`); }
    }
  }
  for (const src of BUILDING_SOURCES) {
    if (!v[src.key]) continue;
    const otln = `C-BLDG-OTLN-${src.tag}`, mass = `A-MASS-${src.tag}`;
    d.layer(otln, src.tag === 'FEMA' ? 4 : src.tag === 'MSFT' ? 3 : 6).layer(mass, 9);
    addBuildings(d, site.context[src.key] || [], otln, mass, P);
  }
  const h = labelHeight(site);
  if (site.ctxInclude.p && v.parcels) {
    d.layer('C-PROP-LINE', 6);
    if (v.labels !== false) d.layer('C-PROP-TEXT', 6);
    for (const pc of site.context.parcels) {
      for (const l of pc.lines) d.polyline3d('C-PROP-LINE', l.map(([x, y, z]) => P(x, y, z)));
    }
  }
  if (v.roadWidths && v.labels !== false && (site.context.widths || []).length) d.layer('C-ROAD-WDTH', 2);
  if (site.ctxInclude.f && v.flood) {
    d.layer('C-FLOD-ZONE', 5).layer('C-FLOD-PATT', 5).layer('C-FLOD-BFE', 4);
    if (v.labels !== false) d.layer('C-FLOD-TEXT', 5);
    for (const z of site.context.floodZones) for (const l of z.hatch3d || []) d.polyline3d('C-FLOD-PATT', l.map(([x, y, zz]) => P(x, y, zz)));
    for (const z of site.context.floodZones) {
      for (const l of z.lines) d.polyline3d('C-FLOD-ZONE', l.map(([x, y, zz]) => P(x, y, zz)));
    }
    for (const b of site.context.bfes) {
      d.polyline3d('C-FLOD-BFE', b.line.map(([x, y, z]) => P(x, y, z)));
    }
  }
  // Parcel / flood / BFE labels, nudged apart; a leader line marks labels moved off their anchor.
  for (const it of labels.items) {
    const total = it.lines.reduce((a, l) => a + l.size * 1.4, 0);
    let y = it.y + total / 2;
    for (const l of it.lines) { y -= l.size * 0.7; d.text(l.layer, it.x, y, it.z, l.size, l.text); y -= l.size * 0.7; }
    if (Math.hypot(it.x - it.ax, it.y - it.ay) > h) {
      d.polyline3d(it.lines[0].layer, [[it.ax, it.ay, it.z], [it.x, it.y + (it.y > it.ay ? -total / 2 : total / 2), it.z]]);
    }
  }
  if (v.roadEdges && (site.context.widths || []).length) {
    d.layer('C-ROAD-EDGE-ARDOT', 2).layer('C-ROAD-PAVE-ARDOT', 52);
    for (const w of site.context.widths) {
      for (const e of w.roadEdges) d.polyline3d('C-ROAD-EDGE-ARDOT', e.map(([x, y, z]) => P(x, y, z)));
      for (const e of w.surfaceEdges) d.polyline3d('C-ROAD-PAVE-ARDOT', e.map(([x, y, z]) => P(x, y, z)));
    }
  }
  const osmLines = (on, layer, color, list, get) => {
    if (!on || !list?.length) return;
    d.layer(layer, color);
    for (const it of list) for (const l of get(it)) d.polyline3d(layer, l.map(([x, y, z]) => P(x, y, z)));
  };
  osmLines(v.parking, 'C-PRKG-OTLN', 8, site.context.parking, a => a.lines);
  osmLines(v.streetAreas, 'C-ROAD-AREA-OSM', 40, site.context.streetAreas, a => a.lines);
  osmLines(v.sidewalks, 'C-WALK-SDWK', 254, site.context.sidewalks, sw => [sw.line]);
  if (v.roads) d.layer('C-ROAD-CNTR', 2).layer('C-WALK-CNTR', 5);
  for (const r of v.roads ? site.context.roads : []) {
    const layer = r.kind === 'road' ? 'C-ROAD-CNTR' : 'C-WALK-CNTR';
    if (r.center.length > 1) d.polyline3d(layer, r.center.map(([x, y, z]) => P(x, y, z)));
    for (const e of r.edges) { d.layer('C-ROAD-EDGE', 7); d.polyline3d('C-ROAD-EDGE', e.map(([x, y, z]) => P(x, y, z))); }
  }
}

function addPoints(d, site) {
  d.layer('C-TOPO-PNTS', 3);
  const { pts } = site;
  for (let j = 0; j < pts.ny; j++) {
    for (let i = 0; i < pts.nx; i++) {
      const zv = pts.z[j * pts.nx + i];
      if (Number.isNaN(zv)) continue;
      const [x, y] = outXY(site, pts.x0 + i * pts.s, pts.y0 + j * pts.s);
      d.point('C-TOPO-PNTS', x, y, zv);
    }
  }
}

async function makePng(site, v) {
  const g = site.grid;
  const landscape = (g.nx >= g.ny);
  const canvas = document.createElement('canvas');
  canvas.width = landscape ? 3300 : 2550;
  canvas.height = landscape ? 2550 : 3300;
  const tinted = site.tinted;
  site.tinted = false;
  site.vis = v;
  site.meta = buildMeta(site);
  drawMap(canvas, site, 'print');
  site.tinted = tinted;
  return new Promise(res => canvas.toBlob(res, 'image/png'));
}

function makeReadme(site, v = vis()) {
  const z = site.zone;
  const u = site.units;
  const unitName = u === 'm' ? 'meters' : zoneUnitLabel(z);
  const [w, s, e, n] = [site.box.xmin, site.box.ymin, site.box.xmax, site.box.ymax];
  const p = projector(z);
  const llSW = p.inv([w, s]), llNE = p.inv([e, n]);
  const lines = [];
  const L_ = (...a) => lines.push(...a);
  L_('CONTOURS TO REVIT — PRELIMINARY TOPOGRAPHY',
    '==========================================',
    '',
    '*** PRELIMINARY — NOT SURVEY DATA ***',
    'Bare-earth surface from USGS 3DEP. Elevations are interpolated under buildings and',
    'trees and may differ substantially from field conditions. Use for feasibility and',
    'early design only. Obtain a boundary/topographic survey before design development.',
    '',
    `Generated:            ${site.generated.toISOString()}`,
    `Tool:                 Contours to Revit ${VERSION} (https://amrjacob.github.io/Contours-to-Revit/)`,
    '',
    'SOURCE DATA',
    '-----------',
    'Provider:             USGS 3D Elevation Program (3DEP), The National Map',
    `Service:              ${'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer'}`,
    'Resolution used (share of site area):');
  for (const ct of site.dem.contributions) L_(`  - ${ct.tier.label}: ${(ct.share * 100).toFixed(1)}%`);
  L_('Datasets:');
  const items = site.dem.contributions.flatMap(ct => ct.items);
  if (!items.length) L_('  (default 3DEP mosaic — dataset not reported by the service)');
  for (const it of items) {
    L_(`  - ${it.title}`);
    if (it.start || it.end) L_(`      Collection: ${dateRange(it.start, it.end)}`);
    if (it.published) L_(`      Published:  ${it.published}`);
  }
  L_(`Sampling:             Server-side bilinear resampling to ~${fmt(site.dem.pixelMeters.x, 2)} m, then bilinear interpolation to the point grid.`,
    '',
    'COORDINATES',
    '-----------',
    `Horizontal:           NAD83 State Plane ${z.name}, EPSG:${z.code}`,
    `Horizontal units:     ${unitName}`,
    `Vertical datum:       NAVD88 (as delivered by 3DEP)`,
    `Vertical units:       ${unitName}`);
  if (z.note) L_(`Note:                 ${z.note}.`);
  if (site.base[0] || site.base[1]) {
    L_(`LOCAL ORIGIN:         X/Y have the base point (${site.base[0].toFixed(3)}, ${site.base[1].toFixed(3)}) ${u} SUBTRACTED.`,
      `                      ${state.origin && site.originPicked ? `Picked on the map: ${state.origin.label} (${state.origin.lat.toFixed(7)}, ${state.origin.lon.toFixed(7)}).` : 'South-west corner of the site, rounded down to 100.'}`,
      '                      (0,0) in these files = that point. Add the base point back to recover true State Plane',
      '                      coordinates. In Revit: link/import "Auto - Origin to Origin" so (0,0) lands on the Internal',
      '                      Origin; to report real coordinates, set the Survey Point to the base point values above.',
      '                      The DXF marks the origin on layer C-ORIG.');
  } else {
    L_('Local origin:         none — X/Y are true State Plane coordinates.');
  }
  if (site.rot) {
    L_(`ROTATION:             X/Y are ROTATED about the local origin so project north points up (+Y).`,
      `                      Project north = ${bearingText(site.rot, 4)} of grid north (${site.rot.toFixed(4)}° clockwise).`,
      '                      The aerial JPG is turned the same way; layer C-ORIG-NRTH shows grid and true north.');
  }
  if (datumOf(site)) {
    L_(`ELEVATION DATUM:      ${datumOf(site).toFixed(3)} ${u} SUBTRACTED from every Z (CSV and DXF). Z = 0 is elevation ${datumOf(site).toFixed(2)}.`);
  }
  const rtx = revitText(site);
  if (rtx) L_('', ...rtx.split('\r\n'), '');
  L_(`Grid north vs true:   true north is ${Math.abs(site.convergence).toFixed(3)}° ${site.convergence >= 0 ? 'east' : 'west'} of grid north at the site centre.`,
    '',
    'SITE',
    '----',
    `Bounding box (${unitName}, before any local-origin shift):`,
    `  X ${(w * site.toOut).toFixed(2)} to ${(e * site.toOut).toFixed(2)}`,
    `  Y ${(s * site.toOut).toFixed(2)} to ${(n * site.toOut).toFixed(2)}`,
    `Bounding box (WGS84): SW ${llSW[1].toFixed(6)}, ${llSW[0].toFixed(6)}  NE ${llNE[1].toFixed(6)}, ${llNE[0].toFixed(6)}`,
    `Point grid:           ${site.pts.nx} x ${site.pts.ny} at ${site.spacingOut} ${u} spacing (${(site.pts.nx * site.pts.ny - site.pStats.missing)} points)`,
    `Elevation range:      ${site.pStats.min.toFixed(2)} to ${site.pStats.max.toFixed(2)} ${u}`,
    `Contours:             ${site.interval} ${u} interval; index (major) every ${site.interval * 5} ${u}${$('smooth').checked ? '; lightly smoothed' : ''}`,
    ...(site.bldgSurface ? [`Buildings in surface:  ${site.bldgSurface.count} ${site.bldgSurface.label} footprints ${site.bldgSurface.mode === 'pad'
      ? `as flat pads at the highest ground along each footprint + ${site.bldgSurface.ffe} ft (ASSUMED floor elevations)`
      : `raised to the roof (${site.bldgSurface.known} with data heights, the rest assumed ${site.bldgSurface.h} ft)`} — not surveyed`] : []),
    '',
    'FILES',
    '-----',
    `Layers included in the DXF and PNG (as shown in the app's Layers panel): ${LAYERS.filter(l => v[l.key] && (l.key !== 'points')).map(l => l.label).join(', ') || 'none'}${v.points ? ', Grid points (DXF only)' : ''}${v.labels === false ? ' (labels off)' : ''}.`,
    '*_points.csv     X,Y,Z, comma-delimited, no header. Revit: Massing & Site > Toposolid >',
    '                 Create from Import > Specify Points File (Toposurface in Revit 2023 and',
    '                 earlier). Choose the same units as this file when prompted. Always the full terrain grid.',
    '*.dxf            AutoCAD R12 DXF with the layers shown in the app. 3D polylines carry true Z on every vertex.',
    ...(v.contours ? ['                 C-TOPO-MAJR / C-TOPO-MINR  index / intermediate contours; C-TOPO-TEXT labels'] : []),
    ...(v.points ? ['                 C-TOPO-PNTS  the CSV grid as 3D POINT entities'] : []),
    ...BUILDING_SOURCES.filter(b => v[b.key]).map(b => `                 C-BLDG-OTLN-${b.tag} / A-MASS-${b.tag}  ${b.short}: footprints at the lowest ground point / massing (3DFACE)`),
    ...(v.roads ? ['                 C-ROAD-CNTR  road centerlines (OSM/TIGER), draped; C-WALK-CNTR paths'] : []),
    ...(v.roadEdges ? ['                 C-ROAD-EDGE-ARDOT / C-ROAD-PAVE-ARDOT  edges from ArDOT RECORDED widths (traveled way / paved), draped'] : []),
    ...(v.roadWidths && v.labels !== false ? ['                 C-ROAD-WDTH  ArDOT lanes / widths labels'] : []),
    ...(v.parcels && site.ctxInclude.p ? ['                 C-PROP-LINE  parcel lines draped on terrain; C-PROP-TEXT parcel ID / owner'] : []),
    ...(v.trees && site.context?.trees?.length ? ['                 L-PLNT-TREE  existing trees from lidar: crown outline at the ground + trunk point; L-PLNT-TEXT height (estimate, not a tree survey)'] : []),
    ...(v.flood ? ['                 C-FLOD-ZONE  flood zone boundaries draped; C-FLOD-PATT hatch (floodway cross-hatched,', '                 SFHA single hatch, shaded X sparse); C-FLOD-TEXT labels; C-FLOD-BFE lines AT the BFE'] : []),
    `                 REVIT: Insert > Link CAD (or Import CAD) > set "Import units" to ${u === 'm' ? 'METERS' : 'FEET'} — do not rely on`,
    '                 Auto-Detect (older DXF readers default to inches). Positioning: "Auto - Origin to Origin"',
    '                 unless you have set up shared coordinates.',
    '*_map.png        Printable map over aerial imagery with the same layers, grid-north up.',
    ...(() => {
      const e = aerialExtent(site), uu = u === 'm' ? 'm' : 'ft', img = site._aerial;
      return [
        `*_aerial.jpg     Clean aerial photo of the site box, ${site.rot ? 'turned so project north is up (white corners)' : 'grid-north up'}, no linework` + (img ? ` (${img.w} x ${img.h} px, ${img.ftPerPx.toFixed(2)} ft/px; ${img.credit})` : '') + '.',
        '*_aerial.jgw     World file: places the JPG automatically in AutoCAD / Civil 3D / GIS (same coordinates as the DXF).',
        `*_aerial_underlay.jpg / .jgw   Same image processed as a drawing underlay: ${ulSettings.sat}% colour, ${ulSettings.wash}% washed toward white.`,
        `                 Image extent: ${e.w.toFixed(3)} x ${e.h.toFixed(3)} ${uu}`,
        `                 Lower-left corner: X ${e.x0.toFixed(3)}, Y ${e.y0.toFixed(3)}   Upper-right: X ${e.x1.toFixed(3)}, Y ${e.y1.toFixed(3)}`,
        '                 REVIT (Insert > Image does not read world files):',
        '                   1. Link the DXF (Origin to Origin) so layer C-IMAG-BNDY shows the image frame.',
        '                   2. In a plan view: Insert > Image, place it anywhere.',
        `                   3. Properties: check Lock Proportions, set Width = ${e.w.toFixed(3)} ${uu}.`,
        '                   4. Move the image by its lower-left corner onto the frame\'s lower-left corner (or use the',
        '                      coordinates above). Set Draw Layer = Background to keep it under the model.',
        site.rot ? '                 The image is already turned to project north — no rotation needed in Revit.' : '                 Grid north is up; set a project north in the app to get a pre-turned image.',
      ];
    })(),
    '',
    `Map imagery: ${site.imagery ? site.imageryCredit + imgDetailNote(site) : 'none (hillshade shown)'}.`,
    ...imgReadmeLines(site),
    '');
  if (site.context && (BUILDING_SOURCES.some(b => v[b.key]) || v.roads || v.parking || v.streetAreas || v.sidewalks || v.roadWidths || v.roadEdges || v.parcels || v.flood)) {
    const bs = site.context.buildings;
    const dates = [...new Set(bs.map(b => b.imageDate).filter(Boolean))].sort();
    const roads = site.context.roads.filter(r => r.kind === 'road');
    L_('SITE CONTEXT (approximate — verify in the field)',
      '-------------------------------------------------');
    if (v.buildings) {
      L_(`Buildings:            ${bs.length} footprints from FEMA/ORNL USA Structures`,
        '                      https://gis-fema.hub.arcgis.com/pages/usa-structures',
        `Footprint imagery:    ${dates.length ? (dates.length > 1 ? `${dates[0]} to ${dates.at(-1)}` : dates[0]) : 'not reported'} (newer buildings may be missing)`,
        `Heights:              ${bs.filter(b => b.heightKnown).length} of ${bs.length} from the dataset (meters; lidar-derived where`,
        '                      available, otherwise modelled by ORNL). Missing heights use 3.5 m (one storey).',
        '                      Massing is a flat-roofed extrusion from the LOWEST ground point under each footprint.');
    }
    if (v.bldgBest) {
      const cb = site.context.bldgBest || [];
      const from = k => cb.filter(b => b.combinedFrom === k).length;
      L_(`Buildings (BEST):     ${cb.length} combined footprints — ${from('bldgOsm')} OpenStreetMap, ${from('bldgMs')} Microsoft, ${from('buildings')} FEMA/ORNL`,
        '                      (a footprint is skipped when a better source already maps it; FEMA/ORNL footprints, which include',
        '                      demolished buildings, only when the site has no OSM or Microsoft ones). Heights: lidar where measured,',
        `                      else the footprint's own or an overlapping dataset height; ${cb.filter(b => !b.heightKnown).length} use 3.5 m. ${massStyle() === 'clean' ? 'Footprints squared up' : 'Footprints as mapped'}.`);
    }
    if (v.bldgMs) {
      const ms = site.context.bldgMs || [];
      const mh = ms.filter(b => b.heightKnown).length;
      L_(`Buildings (MSFT):     ${ms.length} footprints from Microsoft Building Footprints (machine-detected from imagery).`,
        mh ? `                      Heights: ${mh} of ${ms.length} are Microsoft's machine-learning estimates (Global ML Building Footprints, ODbL),`
          : '                      Esri-hosted copy, no heights.',
        mh ? '                      not measured; others use 3.5 m. Flat roofs — roof shapes are not in the data.'
          : '                      Massing uses 3.5 m (one storey).');
    }
    if (site.lidar) L_(`Building lidar:       ${lidarSummary(site, false)}`,
      '                      Heights are measured against the lidar ground beside each footprint; roofs are a',
      `                      ${site.lidar.cellFt || 5} ft grid fitted to the returns. The lidar has roughly one return per 2–3 ft, so a`,
      '                      finer grid is interpolated between them; small dormers, parapets and equipment are smoothed.');
    const ti = site.context.treeInfo;
    if (v.trees && ti && !ti.error) L_(`Trees:                ${(site.context.trees || []).length} from USGS 3DEP lidar (${ti.name}${ti.year ? `, flown ${ti.year}` : ''}), ${Math.round(ti.canopy * 100)}% canopy cover.`,
      '                      Canopy height above the lidar\'s own ground at 1 m cells; treetops are local highs and crowns are grown',
      '                      down from each top. Positions, heights and crown spread are estimates (dense groves may merge or split;',
      '                      leaf-off flights show smaller crowns). Not a tree survey: species, trunk size and condition are not known.');
    if (v.bldgOsm) {
      const os = site.context.bldgOsm || [];
      L_(`Buildings (OSM):      ${os.length} footprints from OpenStreetMap (© OpenStreetMap contributors, ODbL; hand-mapped).`,
        `                      Heights: ${os.filter(b => b.heightKnown).length} of ${os.length} from height= or building:levels × 3.2 m; others use 3.5 m.`);
    }
    if (v.roads) {
      L_(`Roads:                ${roads.length} segments, ${site.context.roads.length - roads.length} paths, from ${site.roadsSource === 'tiger' ? 'US Census TIGER/Line (public domain)' : 'OpenStreetMap (© OpenStreetMap contributors, ODbL), via Esri\'s hosted OSM North America layer'}`,
        '                      CENTERLINES ONLY. None of these sources publish pavement edges, so no edge lines are drawn;',
        '                      city/county GIS or a survey may have edge-of-pavement data. Bridges are draped on the ground.');
    }
    if (v.parking || v.streetAreas || v.sidewalks) {
      L_(`OSM areas:            ${site.areasFailed ? 'NOT INCLUDED — Overpass did not respond; regenerate to retry' : `${(site.context.parking || []).length} parking lots, ${(site.context.streetAreas || []).length} street-surface areas, ${(site.context.sidewalks || []).length} sidewalk lines`}`,
        `                      from OpenStreetMap (© OpenStreetMap contributors, ODbL), hand-mapped; coverage varies by town.`,
        `                      Data: ${site.context.areasSource?.source === 'site' ? `weekly Arkansas extract (Geofabrik), OSM data as of ${site.context.areasSource.dataDate}` : 'live Overpass query'}.`,
        '                      Layers: C-PRKG-OTLN parking outlines, C-ROAD-AREA-OSM street surfaces, C-WALK-SDWK sidewalks (draped).');
    }
    if ((v.roadWidths || v.roadEdges) && site.ctxInclude.p) {
      const ws = site.context.widths || [];
      L_(`Road widths:          ${site.widthsFailed ? 'NOT INCLUDED — ArDOT service did not respond' : `${ws.length} segment(s) with a RECORDED roadway width (feet), from ArDOT:`}`,
        '                      live Road Inventory (state highway system) + 2019 full inventory copy (ADEM) for other roads.');
      for (const t of [...new Set(ws.map(w => `${w.text}  [${w.source}]`))]) L_(`                      - ${t}`);
      if (v.roadEdges) L_('                      Edge lines (C-ROAD-EDGE-ARDOT = traveled way, C-ROAD-PAVE-ARDOT = paved incl. shoulders) are',
        '                      offset from ArDOT\'s centerline by half the recorded width — assumes the road is centred on it.',
        '                      Roads without a recorded width get no edge lines.');
    }
    if (v.parcels && site.ctxInclude.p) {
      L_(`Parcels:              ${site.context.parcels.length} from the Arkansas GIS Office statewide parcel layer (CAMP / county assessor data).`,
        '                      Assessor parcel lines are NOT boundary survey lines; offsets of several feet are common.');
    }
    if (v.flood) {
      const fz = site.context.floodZones;
      const dfirms = [...new Set(fz.map(z => z.dfirm).filter(Boolean))];
      L_(`Flood zones:          ${site.floodFailed ? 'NOT INCLUDED — the FEMA service did not respond; regenerate to retry' : fz.length ? [...new Set(fz.map(z => z.text))].join('; ') : 'none mapped on this site'}`,
        '                      Source: FEMA National Flood Hazard Layer (NFHL), https://hazards.fema.gov/',
        `                      ${dfirms.length ? `FIRM database(s): ${dfirms.join(', ')}. ` : ''}Confirm against the effective FIRM panel and any LOMRs.`,
        `                      BFE lines: ${site.context.bfes.length}${site.context.bfes.length ? ` (values as published, ${site.context.bfes[0].unit || 'feet'} ${site.context.bfes[0].datum || ''}`.trimEnd() + ')' : ''}.`);
    }
    for (const n of site.contextNotes) L_(`Note:                 ${n}`);
    L_('');
  }
  return lines.join('\r\n');
}

function baseName(site) {
  const { lat, lng } = site.center;
  const d = site.generated.toISOString().slice(0, 10).replace(/-/g, '');
  return `topo_${Math.abs(lat).toFixed(4)}${lat >= 0 ? 'N' : 'S'}_${Math.abs(lng).toFixed(4)}${lng >= 0 ? 'E' : 'W'}_${d}`;
}

const MAKERS = {
  csv: (s, v) => ({ name: `${baseName(s)}_points.csv`, data: makeCsv(s), type: 'text/csv' }),
  dxf: (s, v) => ({ name: `${baseName(s)}.dxf`, data: makeDxf(s, v), type: 'application/dxf' }),
  png: async (s, v) => ({ name: `${baseName(s)}_map.png`, data: await makePng(s, v), type: 'image/png' }),
  readme: (s, v) => ({ name: `${baseName(s)}_README.txt`, data: makeReadme(s, v), type: 'text/plain' }),
  jpg: async (s, v) => { const a = await fetchAerialExport(s); return { name: `${baseName(s)}_aerial.jpg`, data: a.blob, type: 'image/jpeg' }; },
  jgw: async (s, v) => { const a = await fetchAerialExport(s); return { name: `${baseName(s)}_aerial.jgw`, data: makeWorldFile(s, a), type: 'text/plain' }; },
  ulJpg: async (s, v) => { const a = await fetchAerialExport(s); return { name: `${baseName(s)}_aerial_underlay.jpg`, data: await makeUnderlayBlob(a.blob), type: 'image/jpeg' }; },
  ulJgw: async (s, v) => { const a = await fetchAerialExport(s); return { name: `${baseName(s)}_aerial_underlay.jgw`, data: makeWorldFile(s, a), type: 'text/plain' }; },
};

// ---------- Project folder: overwrite fixed file names so Revit links can simply Reload ----------
// Chromium browsers (Chrome, Edge) only. The folder handle is kept in IndexedDB; the browser asks again for
// permission in each new session, on the first download click.
const FOLDER_OK = 'showDirectoryPicker' in window;
const idb = {
  open() { return new Promise((res, rej) => { const r = indexedDB.open('c2r', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); },
  async get(k) { const db = await this.open(); return new Promise(res => { const q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => res(undefined); }); },
  async keys() { const db = await this.open(); return new Promise(res => { const q = db.transaction('kv').objectStore('kv').getAllKeys(); q.onsuccess = () => res(q.result || []); q.onerror = () => res([]); }); },
  async set(k, v) { const db = await this.open(); return new Promise(res => { const t = db.transaction('kv', 'readwrite'); if (v === undefined) t.objectStore('kv').delete(k); else t.objectStore('kv').put(v, k); t.oncomplete = res; t.onerror = res; }); },
};
const folder = { handle: null, prefix: (() => { try { return localStorage.getItem('c2r-prefix') || 'site'; } catch { return 'site'; } })() };

/** Fixed names in the project folder, by output kind. */
function folderName(kind) {
  const p = (folder.prefix || 'site').replace(/[\\/:*?"<>|]+/g, '-');
  return { csv: `${p}_points.csv`, dxf: `${p}_existing.dxf`, png: `${p}_map.png`, readme: `${p}_README.txt`,
    jpg: `${p}_aerial.jpg`, jgw: `${p}_aerial.jgw`, ulJpg: `${p}_aerial_underlay.jpg`, ulJgw: `${p}_aerial_underlay.jgw`, revit: `${p}_revit-coordinates.txt`,
    newDxf: `${p}_new.dxf`, newCsv: `${p}_new_points.csv`, design: `${p}_design.json` }[kind];
}

function updateFolderUi() {
  const box = $('folder-box');
  if (!FOLDER_OK) {
    $('folder-hint').textContent = 'Saving into a fixed project folder needs Chrome or Edge. In this browser, files go to your Downloads folder.';
    $('folder-pick').hidden = true; $('folder-off').hidden = true; $('folder-prefix-row').hidden = true;
    $('sum-export').textContent = '→ Downloads';
    $('folder-sum').textContent = '— Chrome or Edge only';
    return;
  }
  box.classList.toggle('on', !!folder.handle);
  $('sum-export').textContent = folder.handle ? `→ ${folder.handle.name}` : '→ Downloads';
  $('folder-sum').textContent = folder.handle ? `— ${folder.handle.name}` : '— off (Downloads)';
  $('folder-pick').textContent = folder.handle ? `📁 ${folder.handle.name}` : 'Choose folder…';
  $('folder-off').hidden = !folder.handle;
  $('folder-prefix-row').hidden = !folder.handle;
  $('folder-hint').innerHTML = folder.handle
    ? `Downloads replace <code>${escapeHtml(folderName('dxf'))}</code>, <code>${escapeHtml(folderName('jpg'))}</code> and the rest in this folder. In Revit, link them from here once; after a change, download again and click <strong>Reload</strong> in Manage Links.`
    : 'Optional. Normally Chrome drops each download into Downloads, and a second download becomes “site (1).dxf”. Choose your project folder here and every download is written there under the same name, replacing the old one — so you link it in Revit once and just click Reload in Manage Links after changes. Chrome asks permission once per folder.';
}

$('folder-pick').addEventListener('click', async () => {
  try {
    folder.handle = await window.showDirectoryPicker({ id: 'c2r-project', mode: 'readwrite' });
    await idb.set('folder', folder.handle);
    updateFolderUi();
    setStatus(`Downloads will be saved into “${folder.handle.name}”.`);
  } catch (err) { if (err?.name !== 'AbortError') setStatus(`Couldn't use that folder: ${err.message}`, true); }
});
$('folder-off').addEventListener('click', async () => { folder.handle = null; await idb.set('folder', undefined); updateFolderUi(); setStatus('Back to normal downloads.'); });
$('folder-prefix').value = folder.prefix;
$('folder-prefix').addEventListener('change', e => {
  folder.prefix = e.target.value.trim() || 'site';
  e.target.value = folder.prefix;
  try { localStorage.setItem('c2r-prefix', folder.prefix); } catch { /* ignore */ }
  updateFolderUi();
});
if (FOLDER_OK) idb.get('folder').then(h => { if (h) { folder.handle = h; updateFolderUi(); } }).catch(() => {});
updateFolderUi();

/** Ask for write access to the project folder (needs the click that started the download). */
async function folderReady() {
  if (!folder.handle) return false;
  const opts = { mode: 'readwrite' };
  if ((await folder.handle.queryPermission(opts)) === 'granted') return true;
  return (await folder.handle.requestPermission(opts)) === 'granted';
}

async function writeToFolder(kind, data, type) {
  const name = folderName(kind);
  const fh = await folder.handle.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(data instanceof Blob ? data : new Blob([data], { type }));
  await w.close();
  return name;
}

function saveBlob(name, data, type) {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

document.querySelectorAll('.dl, .dl-link').forEach(b => b.addEventListener('click', async () => {
  const site = state.result;
  if (!site) return;
  const kind = b.dataset.out;
  const label = (b.querySelector('.dl-name') || b).textContent.replace(/ only$/, '');
  const v = vis();
  // Permission must be asked while the click still counts as a user gesture, so before any other work.
  let toFolder = false;
  try { toFolder = await folderReady(); } catch { toFolder = false; }
  if (folder.handle && !toFolder) setStatus('No permission for the project folder — using normal downloads.', true);
  setStatus(`Preparing ${label}…`);
  await tick();
  try {
    if (toFolder) {
      const kinds = kind === 'zip' ? ['csv', 'dxf', 'png', 'jpg', 'jgw', 'ulJpg', 'ulJgw', 'readme']
        : kind === 'jpg' ? ['jpg', 'jgw', 'ulJpg', 'ulJgw'] : [kind];
      const written = [];
      for (const k of kinds) {
        const f = await MAKERS[k](site, v);
        if (f) written.push(await writeToFolder(k, f.data, f.type));
      }
      const rt = revitText(site);
      if (rt && (kind === 'dxf' || kind === 'zip')) written.push(await writeToFolder('revit', rt, 'text/plain'));
      setStatus(`Saved to “${folder.handle.name}”: ${written.join(', ')}.${kind === 'dxf' || kind === 'jpg' || kind === 'zip' ? ' In Revit: Manage Links › Reload.' : ''}`);
      return;
    }
    if (kind === 'zip') {
      const zip = new JSZip();
      const zdir = zip.folder(baseName(site));
      for (const k of ['csv', 'dxf', 'png', 'jpg', 'jgw', 'ulJpg', 'ulJgw', 'readme']) {
        const f = await MAKERS[k](site, v);
        if (f) zdir.file(f.name, f.data);
      }
      const rt = revitText(site);
      if (rt) zdir.file(`${baseName(site)}_revit-coordinates.txt`, rt);
      saveBlob(`${baseName(site)}.zip`, await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' }));
    } else {
      const f = await MAKERS[kind](site, v);
      if (!f) throw new Error('nothing to export');
      saveBlob(f.name, f.data, f.type);
      if (kind === 'jpg') {
        // Also deliver the world file and the underlay version (with its own world file).
        const extra = [await MAKERS.jgw(site, v), await MAKERS.ulJpg(site, v), await MAKERS.ulJgw(site, v)];
        extra.forEach((x, i) => setTimeout(() => saveBlob(x.name, x.data, x.type), 400 * (i + 1)));
      }
    }
    setStatus(`Downloaded ${label}.`);
  } catch (err) {
    console.error(err);
    setStatus(`Couldn't create ${label}: ${err.message}`, true);
  }
}));

// ---------- Local origin: pick on the map with snapping ----------
state.origin = null; // { lat, lon, label }
let originMarker = null;

/** Base point (output units) subtracted from X/Y. */
function baseFor(zone, toOut, pts) {
  if (!$('local-origin').checked) return [0, 0];
  if (state.origin) {
    const [x, y] = projector(zone).fwd([state.origin.lon, state.origin.lat]);
    return [x * toOut, y * toOut];
  }
  return [Math.floor(pts.x0 * toOut / 100) * 100, Math.floor(pts.y0 * toOut / 100) * 100];
}

// ---------- Building alignment: project-north rotation + elevation datum ----------
// rot: bearing of the building's "up" direction, ° clockwise from grid north. datum: Z subtracted (output units).
const align = { rot: 0, datum: null, northRef: 'grid', zeroAtOrigin: false, ...(session.get('align') || {}) };
const saveAlign = () => session.set('align', align);
const normDeg = a => { let x = ((a % 360) + 540) % 360 - 180; if (Object.is(x, -0) || Math.abs(x) < 1e-9) x = 0; return x; };
/** "12.50° EAST" / "3.00° WEST" — clockwise positive. */
function bearingText(a, dec = 2) {
  const x = normDeg(a);
  return x === 0 ? '0°' : `${Math.abs(x).toFixed(dec)}° ${x > 0 ? 'EAST' : 'WEST'}`;
}

function setRot(a, why) {
  align.rot = Math.round(normDeg(Number(a) || 0) * 1e4) / 1e4;
  saveAlign();
  $('rot-deg').value = String(align.rot);
  applyOrigin();
  if (why) setStatus(why);
}
$('rot-deg').addEventListener('change', e => setRot(e.target.value, 'Project north updated — downloads use it, no need to generate again.'));
$('rot-90').addEventListener('click', () => setRot(align.rot + 90, 'Project north turned 90°.'));
$('rot-0').addEventListener('click', () => setRot(0, 'Rotation cleared — grid north is up.'));
$('datum').addEventListener('change', e => {
  const v = e.target.value.trim();
  align.datum = v === '' || !Number.isFinite(Number(v)) ? null : Number(v);
  align.zeroAtOrigin = false; // a typed datum replaces "ground at origin = 0"
  saveAlign(); applyOrigin();
});
$('origin-zero').addEventListener('change', e => {
  align.zeroAtOrigin = e.target.checked;
  if (!align.zeroAtOrigin) { align.datum = null; $('datum').value = ''; }
  saveAlign(); applyOrigin();
  if (align.zeroAtOrigin) setStatus(state.result && align.datum != null ? `Elevation ${align.datum.toFixed(2)} at the origin becomes 0 in the files.` : 'The ground at the origin will become 0 once the site is generated.');
});
$('datum-ground').addEventListener('click', () => {
  const site = state.result;
  const z = site && originGround(site);
  if (!Number.isFinite(z)) { setStatus('Survey the site first so the ground elevation at the origin is known.', true); return; }
  align.datum = Math.round(z * 100) / 100;
  align.zeroAtOrigin = true;
  $('datum').value = align.datum.toFixed(2);
  saveAlign(); applyOrigin();
  setStatus(`Datum set to the ground at the origin: ${align.datum.toFixed(2)} ${site.units}.`);
});
/** Ground elevation (output units) at the local origin, from the DEM. */
function originGround(site) {
  if (!site.originNative) return NaN;
  const [lon, lat] = projector(site.zone).inv(site.originNative);
  return sample(site.dem, lon, lat) * site.zPerM;
}

function applyOrigin() {
  const on = $('local-origin').checked;
  $('reset-origin').hidden = !state.origin;
  const site = state.result;
  if (site) {
    site.base = baseFor(site.zone, site.toOut, site.pts);
    site.originPicked = !!state.origin && on;
    site.originNative = on ? [site.base[0] / site.toOut, site.base[1] / site.toOut] : null;
    site.rot = on ? align.rot : 0;       // rotating about true State Plane (0,0) would be meaningless
    // "Ground at the origin = 0": follow the origin wherever it's picked.
    if (on && align.zeroAtOrigin) {
      const z = originGround(site);
      if (Number.isFinite(z)) { align.datum = Math.round(z * 100) / 100; saveAlign(); $('datum').value = align.datum.toFixed(2); }
    }
    site.datum = align.datum;
  }
  $('origin-zero').checked = !!align.zeroAtOrigin;
  $('origin-zero').disabled = !on;
  document.querySelector('.origin-zero').classList.toggle('disabled', !on);
  $('datum-sum').textContent = align.datum != null ? `— ${align.datum.toFixed(2)} = 0` : '— none';
  $('pn-sum').textContent = !on ? '— needs a local origin' : align.rot ? `— ${bearingText(align.rot).toLowerCase()} of grid north` : '— grid north up';
  $('align-box').classList.toggle('disabled', !on);
  $('rot-hint').textContent = !on
    ? 'Turn on the local origin to rotate — the files rotate about it.'
    : align.rot
    ? `Project north (up in Revit) is ${bearingText(align.rot).toLowerCase()} of grid north. Files are turned so it points up.`
    : '0 = grid north up. Pick the origin on a building corner, then pick a point along a wall or grid line that should run straight up in your Revit plan.';
  $('datum-hint').textContent = align.datum != null
    ? `Z in the files = elevation − ${align.datum.toFixed(2)}. That elevation becomes 0 (Level 1).`
    : 'Enter the finished floor elevation (e.g. 512.50) to make it 0 in the files, so Level 1 can stay at 0′.';
  updateRevitCard();
  revitSiteChanged();
  drawNorthIndicator();
  $('sum-place').textContent = !on ? 'State Plane coordinates'
    : [state.origin ? 'origin picked' : 'SW corner', align.rot ? `PN ${bearingText(align.rot, 1).replace('EAST', 'E').replace('WEST', 'W')}` : '', align.datum != null ? `datum ${align.datum.toFixed(2)}` : ''].filter(Boolean).join(' · ');
  $('step-place').classList.toggle('done', on && !!state.origin);
  const u = site ? site.units : units();
  if (!on) $('origin-hint').textContent = 'Off — X/Y are true State Plane coordinates.';
  else if (state.origin) {
    $('origin-hint').textContent = site
      ? `Origin: ${state.origin.label} — E ${fmt(site.base[0], 3)}, N ${fmt(site.base[1], 3)} ${u} (State Plane).`
      : `Origin: ${state.origin.label} (${state.origin.lat.toFixed(6)}, ${state.origin.lon.toFixed(6)}).`;
  } else {
    $('origin-hint').textContent = site
      ? `Origin: south-west corner, rounded — E ${fmt(site.base[0], 0)}, N ${fmt(site.base[1], 0)} ${u}.`
      : 'Origin: south-west corner of the site, rounded to 100.';
  }
  if (originMarker) { map.removeLayer(originMarker); originMarker = null; }
  if (on && (state.origin || site)) {
    let ll = state.origin ? [state.origin.lat, state.origin.lon] : null;
    if (!ll && site) { const [lon, lat] = projector(site.zone).inv(site.originNative); ll = [lat, lon]; }
    if (ll) {
      originMarker = L.marker(ll, { interactive: false, keyboard: false, icon: L.divIcon({ className: 'origin-icon', iconSize: [28, 28], iconAnchor: [14, 14],
        html: '<svg width="28" height="28" viewBox="0 0 28 28"><circle cx="14" cy="14" r="6" fill="none" stroke="#fff" stroke-width="3"/><circle cx="14" cy="14" r="6" fill="none" stroke="#e8913f" stroke-width="1.6"/><path d="M14 0v9M14 19v9M0 14h9M19 14h9" stroke="#e8913f" stroke-width="1.6"/></svg>' }) }).addTo(map);
    }
  }
  if (!$('preview').hidden) renderPreview();
}

// ---------- Revit coordinates card ----------
/** Values for Revit's Manage > Coordinates > Specify Coordinates at Point, picked at the local origin. */
function revitValues(site) {
  if (!site || !site.originNative) return null;
  const u = site.units === 'm' ? 'm' : 'ft';
  const toward = align.northRef === 'true' ? (site.convergence || 0) : 0; // "true north" Revit should use, as a grid bearing
  const ang = normDeg(toward - (site.rot || 0));                          // from project north to that north, clockwise +
  return {
    u, ns: site.base[1], ew: site.base[0],
    elev: datumOf(site),
    ang, angText: ang === 0 ? '0.00°' : `${Math.abs(ang).toFixed(2)}° ${ang > 0 ? 'East' : 'West'}`,
    ground: originGround(site),
    label: site.originPicked && state.origin ? state.origin.label : 'South-west corner of the site (not a building point — pick one on the map)',
  };
}

function revitSteps(rv) {
  return [
    `Model the building with this reference point at Revit's internal origin${rv.elev ? `, and Level 1 at 0′ (= ${rv.elev.toFixed(2)} real)` : ' — files keep real elevations, so set Level 1 to its real elevation'}.`,
    `Insert › Link CAD › the DXF: Positioning "Auto – Origin to Origin", Import units ${rv.u === 'm' ? 'Meters' : 'Feet'}.`,
    'Manage › Coordinates › Specify Coordinates at Point › click the reference point › enter the values above.',
    'When placement changes: update origin / north here, download into the project folder again, then Manage Links › Reload and repeat step 3.',
  ];
}

function updateRevitCard() {
  const body = $('revit-card-body');
  if (!body) return;
  const site = state.result;
  const rv = revitValues(site);
  $('revit-copy').hidden = !rv;
  $('revit-sum').textContent = rv ? `— elev. ${fmt(rv.elev, 2)}, ${rv.angText}` : '';
  if (!rv) {
    body.innerHTML = `<p class="hint">${site ? 'Turn on <strong>Use a local origin</strong> (and pick it on a building corner) to get the values for Revit.' : 'Survey the site to see the values.'}</p>`;
    return;
  }
  const n = (v, d = 3) => fmt(v, d);
  body.innerHTML = `
    <p class="rc-ref">At: <strong>${escapeHtml(rv.label)}</strong></p>
    <dl class="rc-vals">
      <div><dt>North/South</dt><dd>${n(rv.ns)} ${rv.u}</dd></div>
      <div><dt>East/West</dt><dd>${n(rv.ew)} ${rv.u}</dd></div>
      <div><dt>Elevation</dt><dd>${n(rv.elev, 2)} ${rv.u}</dd></div>
      <div><dt>Angle to ${align.northRef === 'true' ? 'true' : 'grid'} north</dt><dd>${rv.angText}</dd></div>
    </dl>
    <div class="rc-north seg" role="radiogroup" aria-label="North used in Revit">
      <label><input type="radio" name="north-ref" value="grid" ${align.northRef !== 'true' ? 'checked' : ''}><span>Grid north <small>(survey)</small></span></label>
      <label><input type="radio" name="north-ref" value="true" ${align.northRef === 'true' ? 'checked' : ''}><span>True north</span></label>
    </div>
    <p class="hint">${align.northRef === 'true'
      ? `True north is ${n(Math.abs(site.convergence), 2)}° ${site.convergence >= 0 ? 'east' : 'west'} of grid north here.`
      : 'Civil and survey drawings in State Plane use grid north.'}${Number.isFinite(rv.ground) ? ` Ground at the reference point: ${n(rv.ground, 2)} ${rv.u}.` : ''}</p>
    <ol class="rc-steps">${revitSteps(rv).map(t => `<li>${escapeHtml(t)}</li>`).join('')}</ol>`;
  body.querySelectorAll('input[name="north-ref"]').forEach(r => r.addEventListener('change', e => {
    align.northRef = e.target.value; saveAlign(); updateRevitCard();
  }));
}

function revitText(site) {
  const rv = revitValues(site);
  if (!rv) return '';
  return [
    'REVIT — Manage > Coordinates > Specify Coordinates at Point',
    `Reference point: ${rv.label}`,
    `  North/South: ${rv.ns.toFixed(3)} ${rv.u}`,
    `  East/West:   ${rv.ew.toFixed(3)} ${rv.u}`,
    `  Elevation:   ${rv.elev.toFixed(2)} ${rv.u}`,
    `  Angle from Project North to ${align.northRef === 'true' ? 'True' : 'Grid'} North: ${rv.angText}`,
    `  (NAD83 State Plane ${site.zone.name}, EPSG:${site.zone.code}; ${align.northRef === 'true' ? 'true north' : 'grid north — matches State Plane survey/civil drawings'})`,
    ...revitSteps(rv).map((t, i) => `${i + 1}. ${t}`),
  ].join('\r\n');
}

$('revit-copy').addEventListener('click', async () => {
  const t = revitText(state.result);
  if (!t) return;
  try { await navigator.clipboard.writeText(t); setStatus('Revit values copied.'); } catch { setStatus('Couldn\'t copy — select the values by hand.', true); }
});

// Project-north indicator on the map: an arrow from the origin in the building's "up" direction.
let northMarker = null;
function originLatLng() {
  if (state.origin) return L.latLng(state.origin.lat, state.origin.lon);
  const site = state.result;
  if (site?.originNative) { const [lon, lat] = projector(site.zone).inv(site.originNative); return L.latLng(lat, lon); }
  return null;
}
function drawNorthIndicator() {
  if (northMarker) { map.removeLayer(northMarker); northMarker = null; }
  const ll = originLatLng();
  if (!ll || !$('local-origin').checked || !align.rot) return;
  // Screen up is true north; true north is `conv` east of grid north, so the bearing on screen is rot - conv.
  const conv = state.result?.convergence || 0;
  const ang = align.rot - conv;
  northMarker = L.marker(ll, { interactive: false, keyboard: false, icon: L.divIcon({ className: 'pn-icon', iconSize: [120, 120], iconAnchor: [60, 60],
    html: `<svg width="120" height="120" viewBox="0 0 120 120" style="transform:rotate(${ang}deg)"><path d="M60 52V8" stroke="#fff" stroke-width="4"/><path d="M60 52V8" stroke="#38bdf8" stroke-width="2"/><path d="M52 18L60 4L68 18Z" fill="#38bdf8" stroke="#fff" stroke-width="1.2"/><text x="72" y="16" font-size="11" font-weight="700" fill="#38bdf8" stroke="#0b1215" stroke-width="3" paint-order="stroke">PN</text></svg>` }) }).addTo(map);
}

const pick = { active: false, mode: 'origin', corners: [], segs: [], hover: null, dot: null, guide: null };

/** Snap targets from the visible layers of the last result, in lat/lon. */
function buildSnapTargets() {
  pick.corners = []; pick.segs = [];
  const site = state.result;
  if (!site?.context) return;
  const p = projector(site.zone);
  const ll = ([x, y]) => { const [lon, lat] = p.inv([x, y]); return L.latLng(lat, lon); };
  const v = vis();
  const addRing = (ring, label, closed = true) => {
    const pts = ring.map(ll);
    pts.forEach(q => pick.corners.push({ ll: q, label: `Corner — ${label}` }));
    for (let i = 0; i < pts.length - (closed ? 0 : 1); i++) pick.segs.push({ a: pts[i], b: pts[(i + 1) % pts.length], label: `Edge — ${label}` });
  };
  for (const src of BUILDING_SOURCES) if (v[src.key]) for (const b of site.context[src.key] || []) addRing(b.ring, src.label);
  if (v.parcels) for (const pc of site.context.parcels || []) for (const r of pc.rings) addRing(r, `Parcel ${pc.id || ''}`.trim());
  if (v.parking) for (const a of site.context.parking || []) for (const r of a.rings) addRing(r, 'Parking lot (OSM)');
  if (v.streetAreas) for (const a of site.context.streetAreas || []) for (const r of a.rings) addRing(r, 'Street surface (OSM)');
  if (v.sidewalks) for (const sw of site.context.sidewalks || []) {
    const pts = sw.line.map(ll);
    for (let i = 0; i + 1 < pts.length; i++) pick.segs.push({ a: pts[i], b: pts[i + 1], label: 'Sidewalk (OSM)' });
  }
  if (v.roadEdges) for (const w of site.context.widths || []) for (const e of [...w.roadEdges, ...w.surfaceEdges]) {
    const pts = e.map(ll);
    for (let i = 0; i + 1 < pts.length; i++) pick.segs.push({ a: pts[i], b: pts[i + 1], label: `Road edge (ArDOT) — ${w.label}` });
  }
  if (v.roads) for (const r of site.context.roads) {
    const pts = r.center.map(ll);
    for (let i = 0; i + 1 < pts.length; i++) pick.segs.push({ a: pts[i], b: pts[i + 1], label: `Road centerline${r.name ? ' — ' + r.name : ''}` });
  }
}

function snapAt(cp) {
  const P = q => map.latLngToContainerPoint(q);
  let best = null, bd = 12;
  for (const c of pick.corners) { const d = P(c.ll).distanceTo(cp); if (d < bd) { bd = d; best = { ll: c.ll, label: c.label }; } }
  if (best) return best;
  bd = 8;
  for (const sg of pick.segs) {
    const a = P(sg.a), b = P(sg.b);
    const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy;
    const t = L2 ? Math.max(0, Math.min(1, ((cp.x - a.x) * dx + (cp.y - a.y) * dy) / L2)) : 0;
    const q = L.point(a.x + t * dx, a.y + t * dy);
    const d = q.distanceTo(cp);
    if (d < bd) { bd = d; best = { ll: map.containerPointToLatLng(q), label: sg.label }; }
  }
  return best;
}

function startPick(mode = 'origin') {
  if (pick.active) { const same = pick.mode === mode; stopPick(); if (same) return; }
  if (mode === 'dir' && !(originLatLng() && $('local-origin').checked)) {
    setStatus('Set a local origin first (Pick on map) — project north is measured from it.', true);
    return;
  }
  if (curView() !== 'map') document.querySelector('.tab[data-view="map"]').click();
  pick.active = true;
  pick.mode = mode;
  buildSnapTargets();
  map.getContainer().classList.add('picking');
  $(mode === 'dir' ? 'pick-dir' : 'pick-origin').classList.add('active');
  const snaps = pick.corners.length || pick.segs.length;
  setStatus(mode === 'dir'
    ? 'Click a second point along the wall or grid line that should point UP in Revit (e.g. the next corner along the building). Esc to cancel.'
    : snaps
    ? 'Click the map to set the origin — snaps to corners and lines of the shown layers. Esc to cancel.'
    : 'Click the map to set the origin (generate first to snap to buildings, parcels and roads). Esc to cancel.');
}

function stopPick() {
  pick.active = false;
  map.getContainer().classList.remove('picking');
  $('pick-origin').classList.remove('active');
  $('pick-dir').classList.remove('active');
  if (pick.dot) { map.removeLayer(pick.dot); pick.dot = null; }
  if (pick.guide) { map.removeLayer(pick.guide); pick.guide = null; }
}

/** Grid bearing (° clockwise from grid north) from the origin to a lat/lon, in the site's zone. */
function gridBearingTo(ll) {
  const o = originLatLng();
  const c = state.rect?.getBounds().getCenter();
  const zone = state.result?.zone || selectedZone() || (c && fallbackZoneFor(c.lng, c.lat));
  if (!o || !zone) return null;
  const p = projector(zone);
  const a = p.fwd([o.lng, o.lat]), b = p.fwd([ll.lng, ll.lat]);
  if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-6) return null;
  return Math.atan2(b[0] - a[0], b[1] - a[1]) * 180 / Math.PI;
}

map.on('mousemove', e => {
  if (!pick.active) return;
  const snap = snapAt(e.containerPoint);
  pick.hover = snap;
  const at = snap ? snap.ll : e.latlng;
  if (!pick.dot) pick.dot = L.circleMarker(at, { radius: 6, color: '#e8913f', weight: 2, fillColor: '#fff', fillOpacity: 0.9, interactive: false }).addTo(map);
  pick.dot.setLatLng(at);
  pick.dot.unbindTooltip();
  let tip = snap ? snap.label : '';
  if (pick.mode === 'dir') {
    const o = originLatLng();
    if (!pick.guide) pick.guide = L.polyline([o, at], { color: '#38bdf8', weight: 2, dashArray: '6 4', interactive: false }).addTo(map);
    pick.guide.setLatLngs([o, at]);
    const brg = gridBearingTo(at);
    if (brg != null) tip = `Project north ${bearingText(brg).toLowerCase()} of grid${tip ? ' · ' + tip : ''}`;
  }
  if (tip) pick.dot.bindTooltip(tip, { permanent: true, direction: 'right', offset: [8, 0], className: 'snap-tip' }).openTooltip();
});

map.on('click', e => {
  if (!pick.active) return;
  const snap = snapAt(e.containerPoint);
  const at = snap ? snap.ll : e.latlng;
  if (pick.mode === 'dir') {
    const brg = gridBearingTo(at);
    stopPick();
    if (brg == null) { setStatus('That point is on the origin — pick a point farther along the building.', true); return; }
    setRot(brg, `Project north set to ${bearingText(brg).toLowerCase()} of grid north. Downloads are turned so it points up.`);
    return;
  }
  state.origin = { lat: at.lat, lon: at.lng, label: snap ? snap.label : 'Picked point (no snap)' };
  session.set('origin', state.origin);
  $('local-origin').checked = true;
  saveSettings();
  stopPick();
  applyOrigin();
  setStatus('Origin set. Downloads now use it as (0,0) — no need to generate again.');
});

document.addEventListener('keydown', e => { if (e.key === 'Escape' && pick.active) { stopPick(); setStatus('Origin pick cancelled.'); } });
$('pick-origin').addEventListener('click', () => startPick('origin'));
$('pick-dir').addEventListener('click', () => startPick('dir'));
$('reset-origin').addEventListener('click', () => { state.origin = null; session.set('origin', null); applyOrigin(); setStatus('Origin reset to the south-west corner of the site.'); });

// =====================================================================================================
// ---------- Site design: sculpt a proposed surface, live contours, earthwork, new-construction export ----------
// =====================================================================================================
const SHAPES = ['slope', 'wall', 'pad', 'swale'];
const PATHS = ['slope', 'swale'];
const BRUSHES = ['raise', 'lower', 'flatten', 'smooth'];
const DZ_DEFAULTS = { amount: 2, size: 25, soft: 60, strength: 50, slope: 2, width: 20, wheight: 4, wthick: 1, shelf: 10, front: 5, wside: 'left', wmode: 'fill', welev: 'ground', ratio: 3, pshape: 'rect', psmooth: false, path: 'line', sslope: 1, swidth: 10, sdepth: 1, smode: 'exact' };
const dz = {
  mode: 'existing', tool: 'raise', design: null, site: null,
  exist: null, prop: null, raster: null,
  lastContour: 0, raf: 0, contourVer: -1,
  cursor: null, stroking: false, last: null, spaceDown: false,
  params: (() => { try { return { ...DZ_DEFAULTS, ...JSON.parse(localStorage.getItem('c2r-dz') || '{}') }; } catch { return { ...DZ_DEFAULTS }; } })(),
  target: null, slopeStart: null, padElev: null, swaleStart: null,
  wallElev: { tw0: null, tw1: null, bw0: null, bw1: null },
  poly: null,           // polygon pad being clicked out: { pts }
  showExist: true, showCf: true, showLabels: true, showCursor: true,
  sel: null,            // selected feature id
  drawing: null,        // { kind, a, b } while dragging out a new shape
  edit: null,           // { id, handle, from, geom0, moved } while dragging a feature or its handle
  pan: null,            // middle-button pan
  fieldCheckpoint: false,
};
const saveDzParams = () => { try { localStorage.setItem('c2r-dz', JSON.stringify(dz.params)); } catch { /* ignore */ } };

// ----- Site aerial on the map: the generated (sharper, State Plane) imagery drawn inside the site box -----
// Leaflet image overlays must be lat/lng-aligned; the box is grid-aligned, so it is drawn on a canvas in its own
// pane (above the basemap, below the vector layers) with the same affine mapping the design canvas uses.
map.createPane('siteImg').style.zIndex = 250;
const siteImgCanvas = L.DomUtil.create('canvas', 'site-img-canvas', map.getPane('siteImg'));
siteImgCanvas.style.pointerEvents = 'none';
function siteImgDraw() {
  const site = state.result, ctx = siteImgCanvas.getContext('2d');
  const cont = map.getContainer(), dpr = window.devicePixelRatio || 1;
  const W = cont.clientWidth, H = cont.clientHeight;
  if (siteImgCanvas.width !== Math.round(W * dpr) || siteImgCanvas.height !== Math.round(H * dpr)) {
    siteImgCanvas.width = Math.round(W * dpr); siteImgCanvas.height = Math.round(H * dpr);
    siteImgCanvas.style.width = W + 'px'; siteImgCanvas.style.height = H + 'px';
  }
  L.DomUtil.setPosition(siteImgCanvas, map.containerPointToLayerPoint([0, 0]));
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, siteImgCanvas.width, siteImgCanvas.height);
  if (!site?.imagery || !visibility.siteImage) return;
  ctx.save();
  const M = dzAffine(site), b = site.box, img = site.imagery;
  if (site.mask) { // polygon boundary: only show the imagery inside it
    ctx.beginPath();
    site.mask.forEach(([x, y], i) => { const [sx, sy] = toScreen(M, x, y); ctx[i ? 'lineTo' : 'moveTo'](sx * dpr, sy * dpr); });
    ctx.closePath(); ctx.clip();
  }
  const sx = (b.xmax - b.xmin) / img.width, sy = (b.ymax - b.ymin) / img.height;
  // image pixel (i, j) -> native (xmin + i·sx, ymax − j·sy) -> screen
  ctx.setTransform(dpr * M.a * sx, dpr * M.b * sx, -dpr * M.c * sy, -dpr * M.d * sy,
    dpr * (M.a * b.xmin + M.c * b.ymax + M.e), dpr * (M.b * b.xmin + M.d * b.ymax + M.f));
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0);
  ctx.restore();
}
map.on('moveend zoomend resize viewreset', siteImgDraw);
map.on('zoomstart', () => { siteImgCanvas.style.visibility = 'hidden'; });
map.on('zoomend', () => { siteImgCanvas.style.visibility = ''; });

// ----- Canvas layer drawn straight onto the map (fast enough to redraw on every brush dab and pan) -----
const dzCanvas = document.createElement('canvas');
dzCanvas.className = 'design-canvas';
dzCanvas.hidden = true;
map.getContainer().appendChild(dzCanvas);

/** Affine native(State Plane) -> container pixels, from three projected corners of the site box. */
function dzAffine(site) {
  const p = projector(site.zone), b = site.box;
  const pt = (x, y) => { const [lon, lat] = p.inv([x, y]); return map.latLngToContainerPoint([lat, lon]); };
  const A = pt(b.xmin, b.ymax), B = pt(b.xmax, b.ymax), C = pt(b.xmin, b.ymin);
  const W = b.xmax - b.xmin, H = b.ymax - b.ymin;
  const a = (B.x - A.x) / W, bb = (B.y - A.y) / W, c = -(C.x - A.x) / H, d = -(C.y - A.y) / H;
  return { a, b: bb, c, d, e: A.x - a * b.xmin - c * b.ymax, f: A.y - bb * b.xmin - d * b.ymax, scale: Math.hypot(a, bb) };
}
const toScreen = (M, x, y) => [M.a * x + M.c * y + M.e, M.b * x + M.d * y + M.f];

// ----- Sketch tab (js/sketch.js): massing and parking brainstorming on the generated site -----
var sketchPending = null;           // a project's sketch, applied when its site has been generated
function siteGroundAt(site, x, y) {
  const g = site.grid, fx = (x - g.x0) / g.s, fy = (y - g.y0) / g.s;
  const i = Math.max(0, Math.min(g.nx - 2, Math.floor(fx))), j = Math.max(0, Math.min(g.ny - 2, Math.floor(fy)));
  const tx = Math.max(0, Math.min(1, fx - i)), ty = Math.max(0, Math.min(1, fy - j)), q = j * g.nx + i, z = g.z;
  const v = (z[q] * (1 - tx) + z[q + 1] * tx) * (1 - ty) + (z[q + g.nx] * (1 - tx) + z[q + g.nx + 1] * tx) * ty;
  return Number.isFinite(v) ? v : (site.stats?.min ?? 0);
}
const sketch = createSketch({
  map, $, escapeHtml, toScreen, triangulate, idb,
  affine: site => dzAffine(site),
  toNative: ll => projector(state.result.zone).fwd([ll.lng, ll.lat]),
  zAt: (x, y) => (state.result ? siteGroundAt(state.result, x, y) : 0),
  unitsPerFt: site => zoneUnitsPerMeter(site.zone) * 0.3048,
  mode: () => dz.mode,
  onChange: () => { projTouch(); v3Dirty(); if (sunS?.on) sunLater(); dgMapStyle(); },
  // Diagram paint bucket: keys for existing trees and buildings, and what's under a plan point.
  treeKey: t => treeKey(t),
  pickContext: (xy, kind) => pickContext(xy, kind),
  // While dragging in 3D: just the sketch geometry (the full rebuild waits for the drag to pause).
  onLive: () => { if (v3 && curView() === '3d' && state.result) { v3.setSketch(sketch.tris(v3.ex || 1), sketch.parking3d()); v3.setNotes(sketch.notes3d()); } },
  ex3d: () => v3?.ex || 1,
  // Site lines the sketch tools snap to: parcel lines, building footprints and road edges (cached per site).
  contextSegs: () => {
    const site = state.result; if (!site?.context) return [];
    if (ctxSnap.site === site) return ctxSnap.list;
    const list = [];
    for (const pc of site.context.parcels || []) for (const l of pc.lines || []) list.push({ pts: l, t: 'parcel', closed: false });
    for (const b of site.context.buildings || []) if (b.ring?.length > 2) list.push({ pts: b.ring, t: 'building', closed: true });
    for (const r of site.context.roads || []) for (const e of r.edges || []) list.push({ pts: e, t: 'road edge', closed: false });
    ctxSnap.site = site; ctxSnap.list = list;
    return list;
  },
});
var ctxSnap = { site: null, list: [] };
sketch.wirePanel();

// ----- Diagram tab: the same sketch with annotation tools, a faded / white ground and image export -----
const dg = { fade: 0.75 };
try { const v = Number(localStorage.getItem('c2r-dgfade')); if (v >= 0 && v <= 1 && localStorage.getItem('c2r-dgfade') !== null) dg.fade = v; } catch { /* ignore */ }
function dgFade() {
  map.getContainer().style.setProperty('--dg-fade', String(1 - dg.fade));
  if ($('dg-fade')) { $('dg-fade').value = String(Math.round(dg.fade * 100)); $('dg-fade-v').textContent = `${Math.round(dg.fade * 100)}%`; }
}
$('dg-fade').addEventListener('input', e => {
  dg.fade = Number(e.target.value) / 100; dgFade();
  try { localStorage.setItem('c2r-dgfade', String(dg.fade)); } catch { /* ignore */ }
  v3Dirty();
});
$('dg-labels').addEventListener('change', e => { sketch.setShowLabels(e.target.checked); });
$('dg-export').addEventListener('click', dgExport);
/** Save the current diagram view (map plan or 3D) as a PNG. */
async function dgExport() {
  const site = state.result; if (!site) return;
  const view = curView();
  let W, H, out;
  if (view === '3d' && v3) {
    const gl = v3.snapshot(); W = gl.width; H = gl.height;
    out = document.createElement('canvas'); out.width = W; out.height = H;
    const g = out.getContext('2d'); g.drawImage(gl, 0, 0);
    g.drawImage(sketch.overlay(), 0, 0, W, H);
  } else {
    const cont = map.getContainer(), dpr = window.devicePixelRatio || 1, r0 = cont.getBoundingClientRect();
    W = Math.round(cont.clientWidth * dpr); H = Math.round(cont.clientHeight * dpr);
    out = document.createElement('canvas'); out.width = W; out.height = H;
    const g = out.getContext('2d');
    g.fillStyle = '#fafaf7'; g.fillRect(0, 0, W, H);
    // Our own canvases only (basemap tiles from other sites can't be copied into an image): site aerial, map layers
    // (contours, buildings, roads), then the sketch and annotations.
    const layers = [...cont.querySelectorAll('.leaflet-siteImg-pane canvas, .leaflet-overlay-pane canvas, .leaflet-sunImg-pane canvas')];
    for (const c of layers) {
      const r = c.getBoundingClientRect();
      try {
        g.globalAlpha = c.closest('.leaflet-siteImg-pane') ? 1 - dg.fade : 1;
        g.drawImage(c, (r.left - r0.left) * dpr, (r.top - r0.top) * dpr, r.width * dpr, r.height * dpr);
      } catch { /* a tainted canvas — skip it */ }
    }
    g.globalAlpha = 1;
    g.drawImage(sketch.overlay(), 0, 0, W, H);
  }
  const a = document.createElement('a');
  a.download = `${(PROJ.list.find(p => p.id === PROJ.current)?.name || 'site').replace(/[^\w-]+/g, '_')}_diagram.png`;
  a.href = out.toDataURL('image/png');
  a.click();
}

const FEAT_COLOR = { pad: '#f8fafc', wall: '#cbd5e1', slope: '#22d3ee' };
const SEL_COLOR = '#e8913f';

/** Handle points (native) of a feature, for drawing and dragging. */
function featHandles(f) {
  if (f.type === 'pad') {
    const g = f.geom;
    if (g.shape === 'poly') return g.pts;
    if (g.shape === 'circle') return [g.c, [g.c[0] + g.r, g.c[1]]];
    return Design.padCorners(g, f.p.rot);
  }
  if (f.geom.pts) return f.geom.pts;
  return [f.geom.a, f.geom.b];
}
/** Centre line of a wall / slope / swale (smoothed for curved paths). */
const featPath = f => (f.type === 'pad' ? Design.padOutline(f.geom, f.p.rot) : Design.pathPoints(f.geom));
const pathMid = pts => {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const half = cum.at(-1) / 2;
  for (let i = 1; i < pts.length; i++) if (cum[i] >= half) {
    const t = (half - cum[i - 1]) / ((cum[i] - cum[i - 1]) || 1);
    return { pt: [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t], dir: [pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]] };
  }
  return { pt: pts[0], dir: [1, 0] };
};
/** Rotate handle for a selected feature: pivot (native, centre of its extent) and the grip's screen position. */
function rotInfo(f, M) {
  if (f.type === 'pad' && f.geom.shape === 'circle') return null;
  const pts = featPath(f);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, top = Infinity;
  for (const q of pts) { x0 = Math.min(x0, q[0]); y0 = Math.min(y0, q[1]); x1 = Math.max(x1, q[0]); y1 = Math.max(y1, q[1]); top = Math.min(top, toScreen(M, ...q)[1]); }
  const pivot = [(x0 + x1) / 2, (y0 + y1) / 2];
  const [sx] = toScreen(M, ...pivot);
  return { pivot, ax: sx, ay: top, hx: sx, hy: top - 34 };
}
/** Rotate geometry (and a rectangle pad's frame) clockwise by `deg` about `pivot`. */
function rotateFeature(geom0, p0, type, pivot, deg) {
  const th = deg * Math.PI / 180, c = Math.cos(th), s = Math.sin(th);
  const R = q => { const dx = q[0] - pivot[0], dy = q[1] - pivot[1]; return [pivot[0] + dx * c + dy * s, pivot[1] - dx * s + dy * c]; };
  const g = { ...geom0 };
  if (g.a) g.a = R(g.a);
  if (g.b) g.b = R(g.b);
  if (g.pts) g.pts = g.pts.map(R);
  if (g.c) g.c = R(g.c);
  const p = type === 'pad' && (geom0.shape || 'rect') === 'rect' ? { rot: ((p0.rot || 0) + deg) % 360 } : null;
  return { geom: g, p };
}
const bearingOf = (from, to) => Math.atan2(to[0] - from[0], to[1] - from[1]) * 180 / Math.PI;

/** Geometry of the shape being dragged out. */
function drawingGeom(d) {
  if (d.kind === 'pad' && d.shape === 'circle') return { shape: 'circle', c: d.a, r: Math.max(Math.hypot(d.b[0] - d.a[0], d.b[1] - d.a[1]), 1e-6) };
  if (d.kind === 'pad') return { shape: 'rect', a: d.a, b: d.b };
  return { a: d.a, b: d.b };
}
const centroidOf = pts => [pts.reduce((a, c) => a + c[0], 0) / pts.length, pts.reduce((a, c) => a + c[1], 0) / pts.length];

function dzDraw() {
  if ((dz.sel || null) !== dzPopId) dzPopBuild(); else dzPopPlace();
  const site = dz.site, des = dz.design;
  const cont = map.getContainer();
  const dpr = window.devicePixelRatio || 1;
  const W = cont.clientWidth, H = cont.clientHeight;
  if (dzCanvas.width !== Math.round(W * dpr) || dzCanvas.height !== Math.round(H * dpr)) {
    dzCanvas.width = Math.round(W * dpr); dzCanvas.height = Math.round(H * dpr);
    dzCanvas.style.width = W + 'px'; dzCanvas.style.height = H + 'px';
  }
  const ctx = dzCanvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, dzCanvas.width, dzCanvas.height);
  if (!site || !des) return;
  const M = dzAffine(site);
  const native = () => ctx.setTransform(M.a * dpr, M.b * dpr, M.c * dpr, M.d * dpr, M.e * dpr, M.f * dpr);
  const screen = () => ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const px = 1 / M.scale;
  const g = site.grid;
  native();
  if (dz.showCf && dz.raster && des.changed) {
    ctx.globalAlpha = 0.6;
    ctx.save();
    ctx.translate(g.x0 - g.s / 2, g.y0 + (g.ny - 1) * g.s + g.s / 2);
    ctx.scale(1, -1); // raster row 0 is north
    ctx.drawImage(dz.raster, 0, 0, g.nx * g.s, g.ny * g.s);
    ctx.restore();
    ctx.globalAlpha = 1;
  }
  const strokeSegs = (arr, color, width) => {
    if (!arr?.length) return;
    ctx.beginPath();
    for (let k = 0; k < arr.length; k += 4) { ctx.moveTo(arr[k], arr[k + 1]); ctx.lineTo(arr[k + 2], arr[k + 3]); }
    ctx.strokeStyle = color; ctx.lineWidth = width * px; ctx.stroke();
  };
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  if (dz.showExist && dz.exist) {
    strokeSegs(dz.exist.minor, 'rgba(200,205,210,0.35)', 0.8);
    strokeSegs(dz.exist.major, 'rgba(200,205,210,0.6)', 1.3);
  }
  if (dz.prop) {
    strokeSegs(dz.prop.minor, 'rgba(255,255,255,0.85)', 1);
    strokeSegs(dz.prop.major, '#ffb347', 2.2);
  }
  ctx.strokeStyle = 'rgba(232,145,63,0.9)'; ctx.lineWidth = 1.5 * px; ctx.setLineDash([6 * px, 4 * px]);
  ctx.strokeRect(site.box.xmin, site.box.ymin, site.box.xmax - site.box.xmin, site.box.ymax - site.box.ymin);
  ctx.setLineDash([]);

  // Features, then the one being drawn.
  const labels = [];
  const drawFeature = (f, sel, preview) => {
    native();
    const col = sel ? SEL_COLOR : FEAT_COLOR[f.type];
    if (preview) ctx.setLineDash([6 * px, 4 * px]);
    if (f.type === 'pad') {
      const cs = Design.padOutline(f.geom, f.p.rot);
      ctx.beginPath(); cs.forEach((c, i) => (i ? ctx.lineTo(...c) : ctx.moveTo(...c))); ctx.closePath();
      ctx.fillStyle = sel ? 'rgba(232,145,63,0.12)' : 'rgba(248,250,252,0.08)'; ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = 4 * px; ctx.stroke();
      ctx.strokeStyle = col; ctx.lineWidth = 2 * px; ctx.stroke();
      const [cx, cy] = centroidOf(cs);
      const e = f.out?.elev ?? f.p.elev;
      labels.push([cx, cy, Number.isFinite(e) ? `PAD ${e.toFixed(2)}` : 'PAD', col]);
    } else if (f.type === 'wall') {
      const [a, b] = [f.geom.a, f.geom.b];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L, sg = f.p.side === 'right' ? -1 : 1;
      const nx = -uy * sg, ny = ux * sg;
      ctx.beginPath(); ctx.moveTo(...a); ctx.lineTo(...b);
      ctx.strokeStyle = 'rgba(0,0,0,0.7)'; ctx.lineWidth = Math.max(f.p.thick / site.toOut, 5 * px) + 3 * px; ctx.stroke();
      ctx.strokeStyle = col; ctx.lineWidth = Math.max(f.p.thick / site.toOut, 5 * px); ctx.stroke();
      // Ticks on the high side.
      const step = 14 * px, tk = 7 * px;
      ctx.beginPath();
      for (let t = step / 2; t < L; t += step) { const x = a[0] + ux * t, y = a[1] + uy * t; ctx.moveTo(x + nx * 3 * px, y + ny * 3 * px); ctx.lineTo(x + nx * tk, y + ny * tk); }
      ctx.strokeStyle = col; ctx.lineWidth = 1.5 * px; ctx.stroke();
      const m = f.out?.ends?.[1];
      const en = f.out?.ends;
      const rng = (k) => Math.abs(en[0][k] - en[2][k]) > 0.05 ? `${en[0][k].toFixed(1)}–${en[2][k].toFixed(1)}` : m[k].toFixed(1);
      labels.push([(a[0] + b[0]) / 2 - nx * 12 * px, (a[1] + b[1]) / 2 - ny * 12 * px, m ? `TW ${rng('tw')} / BW ${rng('bw')}` : `WALL ${f.p.height}`, col]);
    } else {
      // Slope run or swale along a path.
      const pts = Design.pathPoints(f.geom);
      const hw = f.p.width / 2 / site.toOut;
      const offset = sgn => pts.map((q, i) => {
        const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
        const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        return [q[0] - (b[1] - a[1]) / L * hw * sgn, q[1] + (b[0] - a[0]) / L * hw * sgn];
      });
      const line = arr => { ctx.beginPath(); arr.forEach((q, i) => (i ? ctx.lineTo(...q) : ctx.moveTo(...q))); };
      const swale = f.type === 'swale';
      const c = swale ? (sel ? SEL_COLOR : '#60a5fa') : col;
      for (const sgn of [1, -1]) { line(offset(sgn)); ctx.strokeStyle = c; ctx.globalAlpha = swale ? 0.85 : 0.5; ctx.lineWidth = (swale ? 1.4 : 1) * px; if (swale) ctx.setLineDash([5 * px, 3 * px]); ctx.stroke(); ctx.setLineDash(preview ? [6 * px, 4 * px] : []); ctx.globalAlpha = 1; }
      line(pts);
      const b = pts.at(-1), a = pts.at(-2) || pts[0];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L, ah = 12 * px;
      ctx.moveTo(b[0] - ux * ah - uy * ah * 0.5, b[1] - uy * ah + ux * ah * 0.5); ctx.lineTo(...b); ctx.lineTo(b[0] - ux * ah + uy * ah * 0.5, b[1] - uy * ah - ux * ah * 0.5);
      ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = 4.5 * px; ctx.stroke();
      ctx.strokeStyle = c; ctx.lineWidth = 2.2 * px; ctx.stroke();
      const o = f.out, mid = pathMid(pts);
      const pct = `${swale ? '' : SMODE_SIGN[f.p.mode || 'exact']}${(f.p.slope * 100).toFixed(f.p.slope * 100 % 1 ? 2 : 1)}%`;
      labels.push([mid.pt[0], mid.pt[1], swale ? `SWALE ${pct}${o ? `  FL ${o.fA.toFixed(1)}→${o.fB.toFixed(1)}` : ''}` : `${pct}${o ? `  ${o.zA.toFixed(1)}→${o.zB.toFixed(1)}` : ''}`, c]);
    }
    ctx.setLineDash([]);
    if (sel && f.type !== 'pad') {
      screen();
      ctx.font = '700 11px "IBM Plex Sans", system-ui, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const hp = featHandles(f);
      [['A', hp[0], hp[1]], ['B', hp.at(-1), hp.at(-2)]].forEach(([t, p0, p1]) => {
        const [sx, sy] = toScreen(M, ...p0), [ox, oy] = toScreen(M, ...p1);
        const L = Math.hypot(sx - ox, sy - oy) || 1, lx = sx + (sx - ox) / L * 16, ly = sy + (sy - oy) / L * 16;
        ctx.fillStyle = SEL_COLOR; ctx.beginPath(); ctx.arc(lx, ly, 8, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#fff'; ctx.fillText(t, lx, ly + 0.5);
      });
    }
    if (sel) {
      screen();
      for (const h of featHandles(f)) {
        const [sx, sy] = toScreen(M, ...h);
        ctx.fillStyle = '#fff'; ctx.strokeStyle = SEL_COLOR; ctx.lineWidth = 2;
        ctx.fillRect(sx - 5, sy - 5, 10, 10); ctx.strokeRect(sx - 5, sy - 5, 10, 10);
      }
      const ri = !preview && rotInfo(f, M);
      if (ri) {
        const rot = dz.edit?.handle === 'rot' && dz.edit.id === f.id;
        const [px0, py0] = toScreen(M, ...(rot ? dz.edit.pivot : ri.pivot));
        if (rot) { ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(px0, py0); ctx.lineTo(dz.edit.cursorS[0], dz.edit.cursorS[1]); ctx.strokeStyle = SEL_COLOR; ctx.lineWidth = 1.2; ctx.stroke(); ctx.setLineDash([]); ctx.beginPath(); ctx.arc(px0, py0, 3, 0, Math.PI * 2); ctx.fillStyle = SEL_COLOR; ctx.fill(); }
        else { ctx.beginPath(); ctx.moveTo(ri.ax, ri.ay - 4); ctx.lineTo(ri.hx, ri.hy + 9); ctx.strokeStyle = SEL_COLOR; ctx.lineWidth = 1.5; ctx.stroke(); }
        const [gx, gy] = rot ? dz.edit.cursorS : [ri.hx, ri.hy];
        ctx.beginPath(); ctx.arc(gx, gy, 9, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill(); ctx.strokeStyle = SEL_COLOR; ctx.lineWidth = 2; ctx.stroke();
        ctx.beginPath(); ctx.arc(gx, gy, 4.5, -Math.PI * 0.95, Math.PI * 0.45); ctx.strokeStyle = SEL_COLOR; ctx.lineWidth = 1.6; ctx.stroke();
        const ex = gx + 4.5 * Math.cos(Math.PI * 0.45), ey = gy + 4.5 * Math.sin(Math.PI * 0.45);
        ctx.beginPath(); ctx.moveTo(ex - 3.2, ey - 0.5); ctx.lineTo(ex, ey); ctx.lineTo(ex + 0.6, ey - 3.2); ctx.stroke();
      }
    }
  };
  for (const f of des.features) drawFeature(f, f.id === dz.sel, false);
  if (dz.drawing) {
    const d = dz.drawing;
    drawFeature({ type: d.kind, geom: drawingGeom(d), p: dzShapeParams(d.kind) }, false, true);
  }
  if (dz.poly?.pts.length) {
    native();
    const pts = dz.cursor ? [...dz.poly.pts, dz.cursor] : dz.poly.pts;
    const closed = dz.poly.kind === 'pad';
    const smooth = closed ? dz.params.psmooth : dz.params.path === 'curve';
    const shown = smooth && pts.length >= 3 ? (closed ? smoothClosed(pts, 10) : smoothOpen(pts, 10)) : pts;
    if (!closed && pts.length >= 2) {
      const tmp = { type: dz.poly.kind, geom: { pts, smooth }, p: dzShapeParams(dz.poly.kind) };
      drawFeature(tmp, false, true); native();
    }
    ctx.beginPath(); shown.forEach((c, i) => (i ? ctx.lineTo(...c) : ctx.moveTo(...c)));
    if (closed && pts.length >= 3) ctx.closePath();
    ctx.fillStyle = 'rgba(248,250,252,0.08)'; if (closed && pts.length >= 3) ctx.fill();
    ctx.setLineDash([6 * px, 4 * px]); ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = 4 * px; ctx.stroke();
    ctx.strokeStyle = SEL_COLOR; ctx.lineWidth = 2 * px; ctx.stroke(); ctx.setLineDash([]);
    screen();
    dz.poly.pts.forEach((q, i) => {
      const [sx, sy] = toScreen(M, ...q);
      ctx.fillStyle = i === 0 ? SEL_COLOR : '#fff'; ctx.strokeStyle = SEL_COLOR; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(sx, sy, i === 0 ? 6 : 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    });
  }
  // Labels in screen space.
  screen();
  ctx.font = '600 11px "IBM Plex Mono", ui-monospace, monospace';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const [x, y, t, col] of labels) {
    const [sx, sy] = toScreen(M, x, y);
    ctx.lineWidth = 3.5; ctx.strokeStyle = 'rgba(11,18,21,0.85)'; ctx.strokeText(t, sx, sy);
    ctx.fillStyle = col; ctx.fillText(t, sx, sy);
  }
  // Contour labels on index contours, spread out in screen space.
  if (dz.showLabels && dz.prop?.majorLv?.length) {
    screen();
    ctx.font = '600 10.5px "IBM Plex Mono", ui-monospace, monospace';
    const cell = 150, used = new Set(), seg = dz.prop.major, lv = dz.prop.majorLv;
    const Wc = W, Hc = H;
    for (let k = 0, n = 0; k < seg.length; k += 4, n++) {
      const [x1, y1] = toScreen(M, seg[k], seg[k + 1]), [x2, y2] = toScreen(M, seg[k + 2], seg[k + 3]);
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
      if (mx < 20 || my < 20 || mx > Wc - 20 || my > Hc - 20 || Math.hypot(x2 - x1, y2 - y1) < 1.5) continue;
      const key = `${Math.floor(mx / cell)},${Math.floor(my / cell)},${lv[n]}`;
      const area = `${Math.floor(mx / cell)},${Math.floor(my / cell)}`;
      if (used.has(key) || used.has(area + 'n')) continue;
      used.add(key);
      if ([...used].filter(u => u.startsWith(area + ',')).length > 2) used.add(area + 'n');
      let ang = Math.atan2(y2 - y1, x2 - x1);
      if (ang > Math.PI / 2) ang -= Math.PI; else if (ang < -Math.PI / 2) ang += Math.PI;
      const t = formatElev(lv[n], dz.site.interval);
      ctx.save(); ctx.translate(mx, my); ctx.rotate(ang);
      ctx.lineWidth = 3.5; ctx.strokeStyle = 'rgba(11,18,21,0.9)'; ctx.strokeText(t, 0, 0);
      ctx.fillStyle = '#ffd59a'; ctx.fillText(t, 0, 0);
      ctx.restore();
    }
  }
  // Elevation at the cursor.
  if (dz.showCursor && dz.cursor && !dz.pan) {
    const ex = des.existingAt(...dz.cursor), pr = des.proposedAt(...dz.cursor);
    if (Number.isFinite(pr)) {
      screen();
      const [sx, sy] = toScreen(M, ...dz.cursor);
      const d = pr - ex;
      const main = pr.toFixed(2), sub = Math.abs(d) >= 0.01 ? ` ${d > 0 ? '+' : '−'}${Math.abs(d).toFixed(2)}` : '';
      ctx.font = '600 12px "IBM Plex Mono", ui-monospace, monospace';
      ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      const w1 = ctx.measureText(main).width, w2 = sub ? ctx.measureText(sub).width : 0;
      const bxp = sx + 16, byp = sy + 14;
      ctx.fillStyle = 'rgba(11,18,21,0.82)';
      ctx.beginPath(); ctx.roundRect ? ctx.roundRect(bxp - 5, byp - 3, w1 + w2 + 10, 20, 4) : ctx.rect(bxp - 5, byp - 3, w1 + w2 + 10, 20); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.fillText(main, bxp, byp);
      if (sub) { ctx.fillStyle = d > 0 ? '#4ade80' : '#f87171'; ctx.fillText(sub, bxp + w1, byp); }
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    }
  }
  // Brush cursor
  native();
  if (dz.cursor && BRUSHES.includes(dz.tool) && !dz.spaceDown && !dz.pan) {
    const R = dz.params.size / site.toOut;
    const col = { raise: '#4ade80', lower: '#f87171', flatten: '#facc15', smooth: '#e5e7eb' }[dz.tool];
    ctx.beginPath(); ctx.arc(dz.cursor[0], dz.cursor[1], R, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = 3.5 * px; ctx.stroke();
    ctx.strokeStyle = col; ctx.lineWidth = 1.8 * px; ctx.stroke();
    const hard = R * (1 - Math.max(0.02, dz.params.soft / 100));
    if (dz.tool !== 'smooth' && hard > 2 * px) {
      ctx.beginPath(); ctx.arc(dz.cursor[0], dz.cursor[1], hard, 0, Math.PI * 2);
      ctx.setLineDash([4 * px, 4 * px]); ctx.strokeStyle = col; ctx.lineWidth = 1 * px; ctx.stroke(); ctx.setLineDash([]);
    }
  }
}

// ----- On-map editor for the selected feature -----
const dzPop = document.createElement('div');
dzPop.className = 'dz-pop';
dzPop.hidden = true;
map.getContainer().appendChild(dzPop);
L.DomEvent.disableClickPropagation(dzPop);
L.DomEvent.disableScrollPropagation(dzPop);
dzPop.addEventListener('mousedown', e => e.stopPropagation());
let dzPopId = null;
// Where the user dragged the editor to (container px), kept for later openings; null = follow the feature.
let dzPopPin = (() => { try { return JSON.parse(localStorage.getItem('c2r-poppin') || 'null'); } catch { return null; } })();
const saveDzPopPin = () => { try { if (dzPopPin) localStorage.setItem('c2r-poppin', JSON.stringify(dzPopPin)); else localStorage.removeItem('c2r-poppin'); } catch { /* ignore */ } };

function popAnchor(f) {
  if (f.type === 'pad') return centroidOf(Design.padOutline(f.geom, f.p.rot));
  return pathMid(featPath(f)).pt;
}

function dzPopClose() { dz.sel = null; dzApplyTool(); dzFeatureList(); dzPopBuild(); dzDraw(); }

function dzPopBuild() {
  const f = dz.sel && dz.design?.feature(dz.sel);
  dzPopId = f ? f.id : null;
  if (!f || dz.mode !== 'design') { dzPop.hidden = true; return; }
  const u = dz.site.units;
  const num = (k, label) => `<label>${label}<input type="number" step="0.01" data-k="${k}" inputmode="decimal"></label>`;
  let body = '';
  const ratioSel = `<label>Side slope<select data-k="ratio"><option value="2">2:1</option><option value="3">3:1</option><option value="4">4:1</option></select></label>`;
  if (f.type === 'wall') {
    body = `<div class="pop-grid"><span></span><b>A start</b><b>B end</b>
      <span>TW</span><input type="number" step="0.01" data-k="tw0" inputmode="decimal"><input type="number" step="0.01" data-k="tw1" inputmode="decimal">
      <span>BW</span><input type="number" step="0.01" data-k="bw0" inputmode="decimal"><input type="number" step="0.01" data-k="bw1" inputmode="decimal"></div>
      <div class="pop-row">${num('thick', `Thick (${u})`)}${num('shelf', `Level behind`)}${num('front', `Level front`)}</div>
      <div class="pop-row">${ratioSel}<label>High side<button type="button" class="pop-btn" data-act="flip">⇄ Flip</button></label></div>`;
  } else if (f.type === 'pad') {
    body = `<div class="pop-row">${num('elev', `Elevation (${u})`)}${ratioSel}</div>
      ${f.geom.shape === 'poly' ? '<label class="pop-check"><input type="checkbox" data-k="smooth"> Curved through the points</label>' : ''}`;
  } else if (f.type === 'swale') {
    body = `<div class="pop-row">${num('za', `Flowline A (${u})`)}${num('zb', `Flowline B (${u})`)}</div>
      <div class="pop-row">${num('pct', 'Slope %')}${num('width', `Top width`)}${num('depth', `Depth`)}</div>
      <div class="pop-row">${ratioSel}</div>
      ${f.geom.pts?.length > 2 ? '<label class="pop-check"><input type="checkbox" data-k="smooth"> Curved through the points</label>' : ''}`;
  } else {
    body = `<div class="pop-row"><label>Slope is<select data-k="mode"><option value="exact">Exactly</option><option value="max">At most ≤</option><option value="min">At least ≥</option></select></label>${num('pct', 'Slope %')}</div>
      <div class="pop-row">${num('za', `Start A (${u})`)}${num('zb', `End B (${u})`)}${num('width', `Width`)}</div>
      ${f.p.mode && f.p.mode !== 'exact' && f.out ? `<p class="pop-note">${f.p.mode === 'max' ? `Steepest ${(f.out.steep * 100).toFixed(2)}%` : `Flattest fall ${(f.out.flat * 100).toFixed(2)}%`} · end B follows the ground</p>` : ''}
      ${f.geom.pts?.length > 2 ? '<label class="pop-check"><input type="checkbox" data-k="smooth"> Curved through the points</label>' : ''}`;
  }
  dzPop.innerHTML = `<div class="pop-head" title="Drag to move · double-click to keep it beside the feature"><span><i class="pop-grip" aria-hidden="true">⠿</i>${FEATURE_NAMES[f.type]}</span><button type="button" class="pop-x" title="Close (Esc)">×</button></div>${body}
    <div class="pop-foot"><button type="button" class="pop-btn pop-del" data-act="del">Delete</button></div>`;
  dzPop.querySelector('.pop-x').addEventListener('click', dzPopClose);
  const head = dzPop.querySelector('.pop-head');
  head.addEventListener('mousedown', e => {
    if (e.button !== 0 || e.target.closest('.pop-x')) return;
    e.preventDefault();
    const box = map.getContainer().getBoundingClientRect(), r = dzPop.getBoundingClientRect();
    const off = [e.clientX - r.left, e.clientY - r.top];
    dzPop.classList.add('dragging');
    const move = ev => { dzPopPin = { x: ev.clientX - box.left - off[0], y: ev.clientY - box.top - off[1] }; dzPopPlace(); };
    const up = () => { document.removeEventListener('mousemove', move, true); document.removeEventListener('mouseup', up, true); dzPop.classList.remove('dragging'); saveDzPopPin(); };
    document.addEventListener('mousemove', move, true);
    document.addEventListener('mouseup', up, true);
  });
  head.addEventListener('dblclick', e => { if (e.target.closest('.pop-x')) return; dzPopPin = null; saveDzPopPin(); dzPopPlace(); });
  dzPop.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () => {
    const ff = dz.sel && dz.design.feature(dz.sel);
    if (!ff) return;
    if (b.dataset.act === 'del') { dz.design.removeFeature(ff.id); dz.sel = null; dzApplyTool(); dzAfterChange(); dzPopBuild(); return; }
    if (b.dataset.act === 'flip') {
      dz.design.checkpoint();
      const side = ff.p.side === 'right' ? 'left' : 'right';
      dz.params.wside = side;
      dz.design.updateFeature(ff.id, { p: { side } });
      dzAfterChange(); dzSyncUi();
    }
  }));
  dzPop.querySelectorAll('[data-k]').forEach(el => {
    if (el.type === 'checkbox') { el.addEventListener('change', () => dzPopInput(el.dataset.k, el.checked)); return; }
    el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', () => dzPopInput(el.dataset.k, el.value));
    el.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); el.blur(); }
      else if (e.key === 'Escape') { el.blur(); dzPopClose(); }
      e.stopPropagation();
    });
    el.addEventListener('blur', () => { dz.popCheckpoint = false; });
  });
  dzPop.hidden = false;
  dzPopRefresh();
  dzPopPlace();
}

/** Put current values into the editor's inputs (except the one being typed in). */
function dzPopRefresh() {
  const f = dz.sel && dz.design?.feature(dz.sel);
  if (!f || dzPop.hidden) return;
  const o = f.out || {};
  const v = {};
  if (f.type === 'wall' && o.ends) Object.assign(v, { tw0: o.ends[0].tw, tw1: o.ends[2].tw, bw0: o.ends[0].bw, bw1: o.ends[2].bw, thick: f.p.thick, shelf: f.p.shelf, front: f.p.front ?? 5, ratio: f.p.ratio });
  if (f.type === 'pad') Object.assign(v, { elev: o.elev, ratio: f.p.ratio, smooth: !!f.geom.smooth });
  if (f.type === 'slope' && o.zA != null) Object.assign(v, { za: o.zA, zb: o.zB, pct: f.p.slope * 100, width: f.p.width, smooth: !!f.geom.smooth, mode: f.p.mode || 'exact' });
  if (f.type === 'swale' && o.fA != null) Object.assign(v, { za: o.fA, zb: o.fB, pct: f.p.slope * 100, width: f.p.width, depth: f.p.depth, ratio: f.p.ratio, smooth: !!f.geom.smooth });
  dzPop.querySelectorAll('[data-k]').forEach(el => {
    const val = v[el.dataset.k];
    if (el.type === 'checkbox') { el.checked = !!val; return; }
    if (el.dataset.k === 'mode') { el.value = val || 'exact'; return; }
    if (document.activeElement === el || val == null || !Number.isFinite(+val)) return;
    el.value = el.tagName === 'SELECT' ? String(val) : (+val).toFixed(2);
  });
}

/** Keep the editor beside its feature as the map moves. */
function dzPopPlace() {
  const f = dz.sel && dz.design?.feature(dz.sel);
  if (!f || dzPop.hidden) return;
  const M = dzAffine(dz.site);
  const [sx, sy] = toScreen(M, ...popAnchor(f));
  const W = map.getContainer().clientWidth, H = map.getContainer().clientHeight;
  const pw = dzPop.offsetWidth || 220, ph = dzPop.offsetHeight || 120;
  let x = sx + 24, y = sy - ph / 2;
  if (x + pw > W - 8) x = sx - pw - 24;
  if (dzPopPin) { x = dzPopPin.x; y = dzPopPin.y; }
  x = Math.max(8, Math.min(W - pw - 8, x)); y = Math.max(8, Math.min(H - ph - 8, y));
  dzPop.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
}

/** A value typed in the editor: change the feature (one undo step per field). */
function dzPopInput(k, raw) {
  const f = dz.sel && dz.design?.feature(dz.sel);
  if (!f) return;
  if (k === 'mode') {
    dz.design.checkpoint();
    dz.params.smode = raw;
    dz.design.updateFeature(f.id, { p: { mode: raw } });
    dzAfterChange(); dzSyncUi(); dzPopBuild();
    return;
  }
  if (k === 'smooth') {
    dz.design.checkpoint();
    if (f.type === 'pad') dz.params.psmooth = !!raw; else dz.params.path = raw ? 'curve' : 'poly';
    dz.design.updateFeature(f.id, { geom: { smooth: !!raw } });
    dzAfterChange(); dzSyncUi();
    return;
  }
  const val = Number(raw);
  if (raw === '' || !Number.isFinite(val)) return;
  if (!dz.popCheckpoint) { dz.design.checkpoint(); dz.popCheckpoint = true; }
  const o = f.out || {};
  let patch = null;
  if (f.type === 'wall') {
    if (k === 'thick') patch = { thick: Math.max(0.1, val) };
    else if (k === 'shelf' || k === 'front') { patch = { [k]: Math.max(0, val) }; dz.params[k] = patch[k]; }
    else if (k === 'ratio') { patch = { ratio: val }; dz.params.ratio = val; }
    else {
      // Any end value switches the wall to set elevations, keeping the others where they stand now.
      const en = o.ends || [{}, {}, {}];
      const keep = (pv, cur) => (Number.isFinite(pv) && f.p.elevMode === 'set' ? pv : cur);
      const cur = { tw0: keep(f.p.tw0, en[0].tw), tw1: keep(f.p.tw1, en[2].tw), bw0: keep(f.p.bw0, en[0].bw), bw1: keep(f.p.bw1, en[2].bw) };
      for (const kk in cur) cur[kk] = Math.round(cur[kk] * 100) / 100;
      cur[k] = val;
      patch = { elevMode: 'set', ...cur };
      dz.params.welev = 'set';
      dz.wallElev = { ...cur };
    }
  } else if (f.type === 'pad') {
    if (k === 'elev') { patch = { elev: val }; dz.padElev = val; } else { patch = { ratio: val }; dz.params.ratio = val; }
  } else if (f.type === 'swale') {
    const len = o.len || 1, fa = Number.isFinite(f.p.startElev) ? f.p.startElev : o.fA;
    if (k === 'za') patch = { startElev: val };
    else if (k === 'zb') patch = { startElev: fa, slope: (fa - val) / len };
    else if (k === 'pct') patch = { startElev: fa, slope: val / 100 };
    else if (k === 'width') patch = { width: Math.max(1, val) };
    else if (k === 'depth') patch = { depth: Math.max(0.1, val) };
    else if (k === 'ratio') patch = { ratio: val };
    if (patch.slope != null) dz.params.sslope = +(patch.slope * 100).toFixed(3);
    if (patch.startElev != null) dz.swaleStart = patch.startElev;
    if (patch.width != null) dz.params.swidth = patch.width;
    if (patch.depth != null) dz.params.sdepth = patch.depth;
    if (patch.ratio != null) dz.params.ratio = patch.ratio;
  } else {
    const len = o.len || 1, za = Number.isFinite(f.p.startElev) ? f.p.startElev : o.zA;
    if (k === 'za') patch = { startElev: val };
    else if (k === 'zb') { patch = { startElev: za, slope: (za - val) / len, mode: 'exact' }; dz.params.smode = 'exact'; }
    else if (k === 'pct') patch = { startElev: za, slope: val / 100 };
    else patch = { width: Math.max(1, val) };
    if (patch.slope != null) dz.params.slope = +(patch.slope * 100).toFixed(3);
    if (patch.startElev != null) dz.slopeStart = patch.startElev;
    if (patch.width != null) dz.params.width = patch.width;
  }
  dz.design.updateFeature(f.id, { p: patch });
  dzAfterChange();
  dzSyncUi();
}

/** Colour scale for cut / fill: full colour at ±scale (output units). */
function dzScale() { return Math.max(dz.site?.units === 'm' ? 1.5 : 5, (dz.params.amount || 0)); }

function dzUpdateRaster(full) {
  const des = dz.design, g = dz.site.grid;
  if (!dz.raster || dz.raster.width !== g.nx || dz.raster.height !== g.ny) {
    dz.raster = document.createElement('canvas');
    dz.raster.width = g.nx; dz.raster.height = g.ny;
    full = true;
  }
  const box = full ? { i0: 0, j0: 0, i1: g.nx - 1, j1: g.ny - 1 } : des.dirty;
  des.dirty = null;
  if (!box) return;
  const ctx = dz.raster.getContext('2d');
  const w = box.i1 - box.i0 + 1, h = box.j1 - box.j0 + 1;
  const img = ctx.createImageData(w, h);
  const sc = dzScale(), D = des.delta;
  for (let j = box.j0; j <= box.j1; j++) {
    const row = box.j1 - j; // image rows count down from the north edge of the box
    for (let i = box.i0; i <= box.i1; i++) {
      const d = D[j * g.nx + i], o = (row * w + (i - box.i0)) * 4;
      if (!d || Math.abs(d) < 0.01) { img.data[o + 3] = 0; continue; }
      const t = Math.min(1, Math.abs(d) / sc);
      if (d < 0) { img.data[o] = 239; img.data[o + 1] = 68; img.data[o + 2] = 68; } else { img.data[o] = 34; img.data[o + 1] = 197; img.data[o + 2] = 94; }
      img.data[o + 3] = Math.round(70 + 185 * t);
    }
  }
  ctx.putImageData(img, box.i0, g.ny - 1 - box.j1);
}

function dzLevels(grid) {
  const st = gridStats(grid);
  return Number.isFinite(st.min) ? contourLevels(st.min, st.max, dz.site.interval) : [];
}

/** Recompute what changed and redraw; contours (and feature re-application) at most every ~120 ms mid-gesture. */
function dzRefresh(force = false) {
  if (dz.raf) return;
  dz.raf = requestAnimationFrame(() => {
    dz.raf = 0;
    if (!dz.design) { dzDraw(); return; }
    const busy = dz.stroking || !!dz.edit;
    const now = performance.now();
    const due = force || !busy || now - dz.lastContour > 120;
    if (dz.design.stale && due) dz.design.rebuild();
    dzUpdateRaster(false);
    if (dz.contourVer !== dz.design.version && due) {
      const pg = dz.design.grid();
      dz.prop = contourSegments(pg, dzLevels(pg), L => isMajor(L, dz.site.interval));
      dz.contourVer = dz.design.version;
      dz.lastContour = performance.now();
    }
    dzDraw();
    if (busy || dz.contourVer !== dz.design.version || dz.design.stale) dzRefresh();
  });
}

// ----- Design lifecycle -----
async function dzEnsure() {
  const site = state.result;
  $('dz-empty').hidden = !!site;
  $('dz-body').hidden = !site;
  if (!site) { dz.design = null; dz.site = null; dz.sel = null; return; }
  if (dz.site === site && dz.design) return;
  dz.site = site;
  dz.sel = null;
  dz.design = new Design(site.grid);
  dz.exist = contourSegments(site.grid, dzLevels(site.grid), L => isMajor(L, site.interval));
  dz.prop = dz.exist; dz.contourVer = dz.design.version;
  dz.raster = null;
  try {
    const key = designKey(site.grid, site.zone.code);
    const saved = await idb.get(key);
    let ok = saved && dz.site === site && dz.design.load(saved);
    // A project's design saved on a slightly different grid (boundary or settings changed): fit it to this one.
    const pend = PROJ?.pending;
    if (!ok && pend && dz.site === site && pend.key !== key) {
      const og = parseDesignKey(pend.key);
      if (og && og.zone === site.zone.code && dz.design.loadResampled(pend.design, og)) ok = true;
    }
    if (pend) PROJ.pending = null;
    if (ok) { dz.contourVer = -1; setStatus('Restored your saved design for this site.'); }
  } catch { /* ignore */ }
  dzUpdateRaster(true);
  dzSyncUi();
  dzAfterChange(false);
}

let dzSaveTimer = 0;
function dzSave() {
  clearTimeout(dzSaveTimer);
  dzSaveTimer = setTimeout(() => {
    const des = dz.design, site = dz.site;
    if (!des || !site) return;
    idb.set(designKey(site.grid, site.zone.code), des.changed ? des.serialize() : undefined).catch(() => {});
    projTouch();
  }, 600);
}

/** After any edit: earthwork, feature list, autosave, redraw. */
function dzAfterChange(save = true) {
  if (!dz.design) return;
  v3Dirty();
  if (dz.sel && !dz.design.feature(dz.sel)) dz.sel = null;
  setTimeout(dzPopRefresh, 0);
  dzEarthwork();
  dzFeatureList();
  if (save) dzSave();
  dzUpdateRaster(true);
  dzRefresh(true);
  revitSiteChanged();
}

function dzEarthwork() {
  const des = dz.design, site = dz.site;
  if (!des || !site) return;
  const u = site.units;
  const cell = (site.grid.s * site.toOut) ** 2;
  const ew = des.earthwork(cell);
  const vol = v => u === 'm' ? `${fmt(v, 0)} m³` : `${fmt(v / 27, 0)} yd³`;
  $('ew-cut').textContent = vol(ew.cut);
  $('ew-fill').textContent = vol(ew.fill);
  const net = ew.fill - ew.cut;
  $('ew-net').textContent = (net > 0 ? '+' : net < 0 ? '−' : '') + vol(Math.abs(net));
  $('ew-more').textContent = des.changed
    ? `${net > 0 ? `Import ${vol(net)} needed` : net < 0 ? `Export ${vol(-net)} needed` : 'Balanced'}. Deepest cut ${fmt(ew.maxCut, 1)} ${u}, highest fill ${fmt(ew.maxFill, 1)} ${u}, over ${u === 'm' ? `${fmt(ew.area, 0)} m²` : `${fmt(ew.area / SQFT_PER_ACRE, 2)} ac`}. Preliminary — grid-based, no shrink/swell.`
    : 'No changes yet — pick a tool and drag on the map.';
  $('sum-earth').textContent = des.changed ? `C ${vol(ew.cut)} · F ${vol(ew.fill)}` : 'no changes';
  $('dz-undo').disabled = !des.undo.length;
  $('dz-redo').disabled = !des.redo.length;
  $('dz-reset').disabled = !des.changed;
}

function featSummary(f) {
  const u = dz.site.units, o = f.out;
  if (f.type === 'pad') {
    if (!o) return 'outside the site';
    const sh = f.geom.shape === 'circle' ? `⌀${fmt(f.geom.r * 2 * dz.site.toOut, 0)} ${u}` : f.geom.shape === 'poly' ? `${f.geom.smooth ? 'curved' : `${f.geom.pts.length}-sided`}, ${u === 'm' ? fmt(o.area, 0) + ' m²' : fmt(o.area, 0) + ' sf'}` : `${fmt(o.w, 0)} × ${fmt(o.h, 0)} ${u}`;
    return `${sh} at ${o.elev.toFixed(2)}${Number.isFinite(f.p.elev) ? '' : ' (ground)'} · ${f.p.ratio}:1`;
  }
  if (f.type === 'wall') {
    if (!o) return 'outside the site';
    const e = o.ends, r = k => Math.abs(e[0][k] - e[2][k]) > 0.05 ? `${e[0][k].toFixed(1)}–${e[2][k].toFixed(1)}` : e[1][k].toFixed(1);
    return f.p.elevMode === 'set' ? `TW ${r('tw')} / BW ${r('bw')} · ${fmt(o.len, 0)} ${u}` : `${f.p.height} ${u} ${f.p.mode === 'cut' ? 'cut' : 'fill'} · ${fmt(o.len, 0)} ${u} · TW ${r('tw')}`;
  }
  const pct = `${f.type === 'slope' ? SMODE_SIGN[f.p.mode || 'exact'] : ''}${(f.p.slope * 100).toFixed(2).replace(/\.?0+$/, '')}%`;
  const shape = f.geom.pts ? (f.geom.smooth ? 'curved, ' : `${f.geom.pts.length} pts, `) : '';
  if (f.type === 'swale') return o ? `${pct} · ${shape}${fmt(o.len, 0)} ${u} · ${f.p.width}×${f.p.depth} ${u} · FL ${o.fA.toFixed(1)} → ${o.fB.toFixed(1)}` : 'outside the site';
  return o ? `${pct} · ${shape}${fmt(o.len, 0)} ${u} · ${o.zA.toFixed(1)} → ${o.zB.toFixed(1)}` : 'outside the site';
}

function dzFeatureList() {
  const ul = $('feat-list'), des = dz.design;
  const counts = {};
  ul.innerHTML = des.features.map(f => {
    counts[f.type] = (counts[f.type] || 0) + 1;
    return `<li class="feat${f.id === dz.sel ? ' sel' : ''}" data-id="${f.id}">
      <button type="button" class="feat-main"><span class="feat-dot ${f.type}"></span><b>${FEATURE_NAMES[f.type]} ${counts[f.type]}</b><span>${escapeHtml(featSummary(f))}</span></button>
      <button type="button" class="feat-del" title="Remove" aria-label="Remove">×</button></li>`;
  }).join('') || '<li class="feat-empty">None yet — use Slope, Wall or Pad.</li>';
  $('sum-feat').textContent = des.features.length ? `${des.features.length} feature${des.features.length === 1 ? '' : 's'}` : 'none';
  ul.querySelectorAll('.feat').forEach(li => {
    const id = Number(li.dataset.id);
    li.querySelector('.feat-main').addEventListener('click', () => dzSelect(id, true));
    li.querySelector('.feat-del').addEventListener('click', () => { if (des.removeFeature(id)) { if (dz.sel === id) dz.sel = null; dzAfterChange(); } });
  });
}

/** Select a feature: switch to its tool and show its numbers in the fields (edits then apply to it). */
function dzSelect(id, fromList = false) {
  dz.sel = id;
  dz.fieldCheckpoint = false;
  const f = id && dz.design.feature(id);
  if (f) {
    dz.tool = f.type;
    if (f.type === 'pad') { dz.padElev = Number.isFinite(f.p.elev) ? f.p.elev : null; Object.assign(dz.params, { ratio: f.p.ratio, pshape: f.geom.shape || 'rect', psmooth: !!f.geom.smooth }); }
    if (f.type === 'wall') {
      Object.assign(dz.params, { wheight: f.p.height, wthick: f.p.thick, shelf: f.p.shelf, front: f.p.front ?? 5, wside: f.p.side, wmode: f.p.mode, ratio: f.p.ratio, welev: f.p.elevMode || 'ground' });
      const fin = v => (Number.isFinite(v) ? v : null);
      dz.wallElev = { tw0: fin(f.p.tw0), tw1: fin(f.p.tw1), bw0: fin(f.p.bw0), bw1: fin(f.p.bw1) };
    }
    if (f.type === 'slope') { Object.assign(dz.params, { slope: +(f.p.slope * 100).toFixed(3), width: f.p.width, smode: f.p.mode || 'exact' }); dz.slopeStart = Number.isFinite(f.p.startElev) ? f.p.startElev : null; }
    if (f.type === 'swale') { Object.assign(dz.params, { sslope: +(f.p.slope * 100).toFixed(3), swidth: f.p.width, sdepth: f.p.depth, ratio: f.p.ratio }); dz.swaleStart = Number.isFinite(f.p.startElev) ? f.p.startElev : null; }
    if (PATHS.includes(f.type)) dz.params.path = !f.geom.pts ? 'line' : f.geom.smooth ? 'curve' : 'poly';
    if (fromList) {
      const [lon, lat] = projector(dz.site.zone).inv(featHandles(f)[0]);
      if (!map.getBounds().contains([lat, lon])) map.panTo([lat, lon]);
    }
  }
  dzSyncUi(); dzApplyTool(); dzFeatureList(); dzDraw();
}

// ----- Mode switching -----
function setMode(mode) {
  if (pick.active) stopPick();
  dz.mode = mode;
  projTouch();
  $('panel').classList.toggle('mode-design', mode === 'design');
  $('panel').classList.toggle('mode-sketch', mode === 'sketch');
  $('panel').classList.toggle('mode-diagram', mode === 'diagram');
  document.body.dataset.mode = mode;
  const diagramOn = mode === 'diagram';
  const sketchOn = mode === 'sketch' || diagramOn;
  map.getContainer().classList.toggle('diagram-view', diagramOn);
  dgFade();
  map.getContainer().classList.toggle('sketch-mode', sketchOn);
  document.querySelectorAll('.mode').forEach(b => { const on = b.dataset.mode === mode; b.classList.toggle('active', on); b.setAttribute('aria-selected', String(on)); });
  const design = mode === 'design';
  if (design && !$('preview').hidden) document.querySelector('.tab[data-view="map"]').click();
  document.querySelector('.tab[data-view="preview"]').hidden = design;
  dzCanvas.hidden = !design;
  if (state.mapGroups?.contours) { if (design) map.removeLayer(state.mapGroups.contours); else if (visibility.contours) state.mapGroups.contours.addTo(map); }
  if (drawn) { if (design || sketchOn) map.removeLayer(drawn); else drawn.addTo(map); }
  map.getContainer().classList.toggle('design-mode', design);
  if (design || sketchOn) map.doubleClickZoom.disable(); else { map.doubleClickZoom.enable(); dz.poly = null; }
  sketch.setActive(sketchOn, diagramOn ? 'diagram' : 'sketch');
  dgMapStyle();
  if (design) dzEnsure().then(() => { dzApplyTool(); dzRefresh(true); v3Dirty(); });
  else { map.dragging.enable(); map.getContainer().classList.remove('sculpting'); $('dz-readout').hidden = true; dzPop.hidden = true; dzPopId = null; v3Dirty(); }
  flowKick();
}
document.querySelectorAll('.mode').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));

// ----- Tools & parameters -----
function dzShapeParams(kind) {
  const p = dz.params, k = dz.site?.toOut || 1;
  if (kind === 'pad') return { elev: dz.padElev, ratio: Number(p.ratio), rot: $('local-origin').checked ? align.rot : 0, k };
  if (kind === 'wall') return { height: Number(p.wheight), thick: Number(p.wthick), shelf: Number(p.shelf), front: Number(p.front), side: p.wside, mode: p.wmode, ratio: Number(p.ratio), k,
    elevMode: p.welev, ...dz.wallElev };
  if (kind === 'swale') return { slope: Number(p.sslope) / 100, startElev: dz.swaleStart, width: Number(p.swidth), depth: Number(p.sdepth), ratio: Number(p.ratio), k };
  return { slope: Number(p.slope) / 100, mode: p.smode || 'exact', startElev: dz.slopeStart, width: Number(p.width), soft: p.soft / 100, k };
}
const SMODE_SIGN = { exact: '', max: '≤ ', min: '≥ ' };

function dzSyncUi() {
  const u = dz.site?.units || units();
  const p = dz.params;
  const setv = (id, v) => { const el = $(id); if (document.activeElement !== el) el.value = v ?? ''; };
  setv('dz-amount', p.amount);
  document.querySelectorAll('#dz-amount-u, #dz-target-u, #dz-pelev-u, #dz-width-u').forEach(el => { el.textContent = u; });
  $('dz-size').max = u === 'm' ? 75 : 250;
  $('dz-size').min = u === 'm' ? 1 : 3;
  $('dz-size').value = p.size;
  $('dz-size-v').textContent = `${fmt(p.size, 0)} ${u}`;
  $('dz-soft').value = p.soft;
  $('dz-soft-v').textContent = `${p.soft}%`;
  $('dz-strength').value = p.strength;
  $('dz-strength-v').textContent = `${p.strength}%`;
  setv('dz-target', dz.target != null ? dz.target.toFixed(2) : '');
  setv('dz-slope', p.slope); setv('dz-width', p.width);
  setv('dz-start', dz.slopeStart != null ? dz.slopeStart.toFixed(2) : '');
  setv('dz-wheight', p.wheight); setv('dz-wthick', p.wthick); setv('dz-shelf', p.shelf); setv('dz-front', p.front);
  for (const kk of ['tw0', 'tw1', 'bw0', 'bw1']) setv(`dz-${kk}`, dz.wallElev[kk] != null ? dz.wallElev[kk].toFixed(2) : '');
  document.querySelectorAll('input[name="welev"]').forEach(r => { r.checked = r.value === p.welev; });
  $('f-wall-ground').hidden = p.welev === 'set';
  $('f-wall-set').hidden = p.welev !== 'set';
  $('f-front').hidden = p.welev !== 'set';
  document.querySelectorAll('input[name="pshape"]').forEach(r => { r.checked = r.value === p.pshape; });
  $('f-psmooth').hidden = p.pshape !== 'poly';
  $('dz-psmooth').checked = !!p.psmooth;
  $('pshape-hint').innerHTML = { rect: 'Drag from corner to corner.', poly: 'Click each corner. Double-click, press <kbd>Enter</kbd> or click the first point to close. <kbd>Backspace</kbd> removes the last point.', circle: 'Drag from the centre outward.' }[p.pshape];
  document.querySelectorAll('input[name="wside"]').forEach(r => { r.checked = r.value === p.wside; });
  document.querySelectorAll('input[name="wmode"]').forEach(r => { r.checked = r.value === p.wmode; });
  $('dz-ratio').value = String(p.ratio);
  setv('dz-pelev', dz.padElev != null ? dz.padElev.toFixed(2) : '');
  document.querySelectorAll('#slope-chips button').forEach(b => b.classList.toggle('on', Number(b.dataset.v) === Number(p.slope) && b.dataset.m === (p.smode || 'exact')));
  document.querySelectorAll('input[name="smode"]').forEach(r => { r.checked = r.value === (p.smode || 'exact'); });
  $('smode-hint').textContent = { exact: 'A uniform plane falling at exactly this slope.', max: 'Follows the ground but never steeper than this, uphill or down — for accessible routes.', min: 'Always falls at least this much; cuts where the ground is flatter — for drainage.' }[p.smode || 'exact'];
  document.querySelectorAll('#sslope-chips button').forEach(b => b.classList.toggle('on', Number(b.dataset.v) === Number(p.sslope)));
  setv('dz-sslope', p.sslope); setv('dz-swidth', p.swidth); setv('dz-sdepth', p.sdepth);
  setv('dz-sstart', dz.swaleStart != null ? dz.swaleStart.toFixed(2) : '');
  document.querySelectorAll('input[name="path"]').forEach(r => { r.checked = r.value === p.path; });
  $('path-hint').innerHTML = p.path === 'line' ? 'Drag from the start to the end.' : 'Click each point from the start. Double-click or press <kbd>Enter</kbd> to finish; <kbd>Backspace</kbd> or right-click removes the last point.';
  $('pad-hint').textContent = $('local-origin').checked && align.rot ? `Pads line up with your project north (${bearingText(align.rot).toLowerCase()} of grid).` : 'Pads line up with grid north (set a project north on the Existing site tab to rotate them).';
  $('cf-scale').textContent = `±${fmt(dzScale(), 1)} ${u}`;
}

const TOOL_HINTS = {
  raise: 'Drag to raise the ground — at most the height change per stroke.',
  lower: 'Drag to lower the ground — at most the height change per stroke.',
  flatten: 'Drag to flatten to the target elevation. First click (or Alt+click) samples it.',
  smooth: 'Drag to soften bumps and hard edges.',
  slope: 'Drag from the high end to the low end of the run. Click a run to edit it.',
  wall: 'Drag along the wall line. Ticks show the high side. Click a wall to edit it.',
  pad: 'Draw the pad (rectangle, polygon or circle), then type its elevation. Click a pad to edit it.',
  swale: 'Draw the swale from its high end. The flowline falls at the slope set here; blank start = ground less the depth.',
};

function dzApplyTool() {
  const t = dz.tool;
  document.querySelectorAll('.tool').forEach(b => { const on = b.dataset.tool === t; b.classList.toggle('active', on); b.setAttribute('aria-checked', String(on)); });
  const brush = BRUSHES.includes(t);
  $('f-amount').hidden = !(t === 'raise' || t === 'lower');
  $('f-target').hidden = t !== 'flatten';
  $('f-strength').hidden = t !== 'smooth';
  $('f-size').hidden = !brush;
  $('f-soft').hidden = !(brush || t === 'slope');
  $('f-slope').hidden = t !== 'slope';
  $('f-swale').hidden = t !== 'swale';
  $('f-path').hidden = !PATHS.includes(t);
  $('f-wall').hidden = t !== 'wall';
  $('f-pad').hidden = t !== 'pad';
  $('f-ratio').hidden = !(t === 'wall' || t === 'pad' || t === 'swale');
  const selF = dz.sel && dz.design?.feature(dz.sel);
  $('tool-hint').innerHTML = selF && selF.type === t
    ? `<strong>Editing ${FEATURE_NAMES[t]} — changes apply to it.</strong> Drag its handles or body to move it. <kbd>Esc</kbd> to stop editing.`
    : TOOL_HINTS[t];
  const sculpt = dz.mode === 'design' && !dz.spaceDown && !!dz.design;
  if (sculpt) map.dragging.disable(); else map.dragging.enable();
  map.getContainer().classList.toggle('sculpting', sculpt);
  const u = dz.site?.units || 'ft';
  $('sum-tool').textContent = {
    raise: `raise ${dz.params.amount} ${u}`, lower: `lower ${dz.params.amount} ${u}`,
    flatten: dz.target != null ? `flatten to ${dz.target.toFixed(1)}` : 'flatten', smooth: 'smooth',
    slope: `slope ${SMODE_SIGN[dz.params.smode || 'exact']}${dz.params.slope}%`, swale: `swale ${dz.params.sslope}% · ${dz.params.swidth} ${u} wide`, wall: `wall ${dz.params.wheight} ${u}`, pad: dz.padElev != null ? `pad at ${dz.padElev.toFixed(1)}` : 'pad',
  }[t];
  dzDraw();
}
document.querySelectorAll('.tool').forEach(b => b.addEventListener('click', () => {
  if (dz.sel && dz.design?.feature(dz.sel)?.type !== b.dataset.tool) dz.sel = null;
  dz.tool = b.dataset.tool;
  dzApplyTool(); dzFeatureList();
}));

/** Field edits: update the selected feature live (one undo step per editing session), else set defaults. */
function dzFieldsChanged() {
  saveDzParams();
  const f = dz.sel && dz.design?.feature(dz.sel);
  if (f && f.type === dz.tool) {
    if (!dz.fieldCheckpoint) { dz.design.checkpoint(); dz.fieldCheckpoint = true; }
    const p = dzShapeParams(f.type);
    if (f.type === 'pad') p.rot = f.p.rot; // keep the pad's own orientation
    dz.design.updateFeature(f.id, { p });
    dzAfterChange();
  }
  dzSyncUi(); dzApplyTool();
}
const numParam = (id, key) => $(id).addEventListener('input', e => {
  const v = Number(e.target.value);
  if (e.target.value === '' || !Number.isFinite(v)) return;
  dz.params[key] = v; dzFieldsChanged();
});
numParam('dz-amount', 'amount'); numParam('dz-size', 'size'); numParam('dz-soft', 'soft'); numParam('dz-strength', 'strength');
numParam('dz-slope', 'slope'); numParam('dz-width', 'width'); numParam('dz-wheight', 'wheight'); numParam('dz-wthick', 'wthick'); numParam('dz-shelf', 'shelf');
const optNum = (id, key) => $(id).addEventListener('input', e => {
  const v = Number(e.target.value);
  dz[key] = e.target.value === '' || !Number.isFinite(v) ? null : v;
  dzFieldsChanged();
});
optNum('dz-target', 'target'); optNum('dz-start', 'slopeStart'); optNum('dz-pelev', 'padElev');
$('dz-ratio').addEventListener('change', e => { dz.params.ratio = Number(e.target.value); dzFieldsChanged(); });
document.querySelectorAll('input[name="wside"]').forEach(r => r.addEventListener('change', () => { dz.params.wside = r.value; dzFieldsChanged(); }));
document.querySelectorAll('input[name="wmode"]').forEach(r => r.addEventListener('change', () => { dz.params.wmode = r.value; dzFieldsChanged(); }));
numParam('dz-front', 'front');
numParam('dz-sslope', 'sslope'); numParam('dz-swidth', 'swidth'); numParam('dz-sdepth', 'sdepth');
$('dz-sstart').addEventListener('input', e => { const v = Number(e.target.value); dz.swaleStart = e.target.value === '' || !Number.isFinite(v) ? null : v; dzFieldsChanged(); });
document.querySelectorAll('#sslope-chips button').forEach(b => b.addEventListener('click', () => { dz.params.sslope = Number(b.dataset.v); dzFieldsChanged(); }));
document.querySelectorAll('input[name="path"]').forEach(r => r.addEventListener('change', () => {
  dz.params.path = r.value; dz.poly = null; dz.drawing = null;
  const f = dz.sel && dz.design?.feature(dz.sel);
  // On a selected polyline run, Polyline / Curved switches its curve; otherwise it applies to the next one.
  if (f && PATHS.includes(f.type) && f.geom.pts && r.value !== 'line') { dz.design.checkpoint(); dz.design.updateFeature(f.id, { geom: { smooth: r.value === 'curve' } }); dzAfterChange(); }
  else if (f && PATHS.includes(f.type)) { dz.sel = null; dzFeatureList(); }
  saveDzParams(); dzSyncUi(); dzApplyTool();
}));
/** Fill blank TW/BW values of the selected wall from where it currently stands, so editing one keeps the others. */
function dzPrefillWallElev() {
  const f = dz.sel && dz.design?.feature(dz.sel);
  const en = f?.type === 'wall' && f.out?.ends;
  if (!en) return;
  const r2 = v => Math.round(v * 100) / 100;
  const we = dz.wallElev;
  if (we.tw0 == null) we.tw0 = r2(en[0].tw);
  if (we.tw1 == null) we.tw1 = r2(en[2].tw);
  if (we.bw0 == null) we.bw0 = r2(en[0].bw);
  if (we.bw1 == null) we.bw1 = r2(en[2].bw);
}
document.querySelectorAll('input[name="welev"]').forEach(r => r.addEventListener('change', () => {
  dz.params.welev = r.value;
  if (r.value === 'set') dzPrefillWallElev();
  dzFieldsChanged();
}));
for (const kk of ['tw0', 'tw1', 'bw0', 'bw1']) $(`dz-${kk}`).addEventListener('input', e => {
  const v = Number(e.target.value);
  if (dz.sel) dzPrefillWallElev();
  dz.wallElev[kk] = e.target.value === '' || !Number.isFinite(v) ? null : v;
  dzFieldsChanged();
});
document.querySelectorAll('input[name="pshape"]').forEach(r => r.addEventListener('change', () => {
  dz.params.pshape = r.value; dz.poly = null; dz.drawing = null;
  const f = dz.sel && dz.design?.feature(dz.sel);
  if (f?.type === 'pad' && (f.geom.shape || 'rect') !== r.value) dz.sel = null; // shape applies to the next pad
  saveDzParams(); dzSyncUi(); dzApplyTool(); dzFeatureList();
}));
$('dz-psmooth').addEventListener('change', e => {
  dz.params.psmooth = e.target.checked; saveDzParams();
  const f = dz.sel && dz.design?.feature(dz.sel);
  if (f?.type === 'pad' && f.geom.shape === 'poly') { dz.design.checkpoint(); dz.design.updateFeature(f.id, { geom: { smooth: e.target.checked } }); dzAfterChange(); }
  dzSyncUi(); dzDraw();
});
$('dz-show-labels').addEventListener('change', e => { dz.showLabels = e.target.checked; dzDraw(); });
$('dz-show-cursor').addEventListener('change', e => { dz.showCursor = e.target.checked; dzDraw(); });
document.querySelectorAll('#slope-chips button').forEach(b => b.addEventListener('click', () => { dz.params.slope = Number(b.dataset.v); if (b.dataset.m) dz.params.smode = b.dataset.m; dzFieldsChanged(); }));
document.querySelectorAll('input[name="smode"]').forEach(r => r.addEventListener('change', () => { dz.params.smode = r.value; dzFieldsChanged(); }));
document.querySelectorAll('#dz-body input, #dz-body select').forEach(el => el.addEventListener('blur', () => { dz.fieldCheckpoint = false; }));
$('dz-show-exist').addEventListener('change', e => { dz.showExist = e.target.checked; dzDraw(); });
$('dz-show-cf').addEventListener('change', e => { dz.showCf = e.target.checked; dzDraw(); });
$('dz-undo').addEventListener('click', () => { if (dz.design?.doUndo()) dzAfterChange(); });
$('dz-redo').addEventListener('click', () => { if (dz.design?.doRedo()) dzAfterChange(); });
$('dz-reset').addEventListener('click', () => { if (dz.design?.reset()) { dz.sel = null; dzAfterChange(); setStatus('Design reset — Undo brings it back.'); } });

// ----- Mouse on the map -----
function dzNative(e) {
  const ll = e.latlng || map.mouseEventToLatLng(e);
  return projector(dz.site.zone).fwd([ll.lng, ll.lat]);
}
function dzReadout(xy) {
  const el = $('dz-readout');
  const des = dz.design, u = dz.site.units;
  const ex = des.existingAt(xy[0], xy[1]), pr = des.proposedAt(xy[0], xy[1]);
  if (!Number.isFinite(ex)) { el.hidden = true; return; }
  const d = pr - ex;
  let extra = '';
  if (dz.drawing) {
    const L = Math.hypot(dz.drawing.b[0] - dz.drawing.a[0], dz.drawing.b[1] - dz.drawing.a[1]) * dz.site.toOut;
    extra = dz.drawing.kind === 'pad' && dz.drawing.shape === 'circle' ? ` · ⌀ ${fmt(L * 2, 0)} ${u}` : dz.drawing.kind === 'pad' ? (() => { const cs = Design.padCorners({ a: dz.drawing.a, b: dz.drawing.b }, dzShapeParams('pad').rot); return ` · ${fmt(Math.hypot(cs[1][0] - cs[0][0], cs[1][1] - cs[0][1]) * dz.site.toOut, 0)} × ${fmt(Math.hypot(cs[3][0] - cs[0][0], cs[3][1] - cs[0][1]) * dz.site.toOut, 0)} ${u}`; })() : ` · ${fmt(L, 0)} ${u}`;
  }
  if (dz.edit?.handle === 'rot' && dz.edit.moved) extra = ` · rotated ${dz.edit.angle >= 0 ? '' : '−'}${Math.abs(dz.edit.angle).toFixed(1)}° ${dz.edit.angle >= 0 ? 'clockwise' : 'counter-clockwise'}${Math.abs(dz.edit.angle) % 15 === 0 ? '' : ' (Shift: 15° steps)'}`;
  else if (dz.poly) extra = dz.poly.kind === 'pad'
    ? ` · ${dz.poly.pts.length} corner${dz.poly.pts.length === 1 ? '' : 's'} — double-click or Enter to close`
    : ` · ${dz.poly.pts.length} point${dz.poly.pts.length === 1 ? '' : 's'}, ${fmt(dz.poly.pts.reduce((a, q, i, arr) => a + (i ? Math.hypot(q[0] - arr[i - 1][0], q[1] - arr[i - 1][1]) : 0), 0) * dz.site.toOut, 0)} ${u} — double-click or Enter to finish`;
  el.hidden = false;
  el.innerHTML = `Existing <b>${ex.toFixed(2)}</b> · Proposed <b>${pr.toFixed(2)}</b> · ${Math.abs(d) < 0.01 ? 'no change' : `<span class="${d > 0 ? 'fill' : 'cut'}">${d > 0 ? 'Fill +' : 'Cut −'}${Math.abs(d).toFixed(2)}</span>`}${extra}`;
}
function dzStrokeTo(xy) {
  const R = dz.params.size / dz.site.toOut;
  const step = Math.max(R / 5, dz.site.grid.s / 2);
  const [x0, y0] = dz.last || xy;
  const L = Math.hypot(xy[0] - x0, xy[1] - y0);
  const n = Math.max(1, Math.ceil(L / step));
  for (let k = dz.last ? 1 : 0; k <= n; k++) dz.design.dab(x0 + (xy[0] - x0) * k / n, y0 + (xy[1] - y0) * k / n);
  dz.last = xy;
}

/** Hit-test features near a container point: a handle of the selected feature first, then any feature body. */
function dzHit(cp) {
  const des = dz.design, M = dzAffine(dz.site);
  const sel = dz.sel && des.feature(dz.sel);
  if (sel) {
    const ri = rotInfo(sel, M);
    if (ri && Math.hypot(ri.hx - cp.x, ri.hy - cp.y) < 11) return { f: sel, handle: 'rot', edge: true, pivot: ri.pivot };
    const hs = featHandles(sel);
    for (let i = 0; i < hs.length; i++) { const [sx, sy] = toScreen(M, ...hs[i]); if (Math.hypot(sx - cp.x, sy - cp.y) < 9) return { f: sel, handle: i, edge: true }; }
  }
  const segDist = ([ax, ay], [bx, by]) => {
    const L2 = (bx - ax) ** 2 + (by - ay) ** 2;
    const t = L2 ? Math.max(0, Math.min(1, ((cp.x - ax) * (bx - ax) + (cp.y - ay) * (by - ay)) / L2)) : 0;
    return Math.hypot(ax + t * (bx - ax) - cp.x, ay + t * (by - ay) - cp.y);
  };
  for (let n = des.features.length - 1; n >= 0; n--) {
    const f = des.features[n];
    const pts = (f.type === 'pad' ? Design.padOutline(f.geom, f.p.rot) : []).map(q => toScreen(M, ...q));
    if (f.type === 'pad') {
      let inside = false, near = Infinity;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [xi, yi] = pts[i], [xj, yj] = pts[j];
        if ((yi > cp.y) !== (yj > cp.y) && cp.x < (xj - xi) * (cp.y - yi) / (yj - yi) + xi) inside = !inside;
        near = Math.min(near, segDist(pts[j], pts[i]));
      }
      if (near < 7) return { f, handle: -1, edge: true };
      if (inside) return { f, handle: -1, edge: false };
    } else {
      const pp = featPath(f).map(q => toScreen(M, ...q));
      for (let i = 1; i < pp.length; i++) if (segDist(pp[i - 1], pp[i]) < 8) return { f, handle: -1, edge: true };
    }
  }
  return null;
}

// Right-click a feature (any tool, pad interiors too): select it and open its editor.
map.getContainer().addEventListener('contextmenu', e => {
  if (dz.mode !== 'design' || !dz.design || !dz.site) return;
  e.preventDefault();
  if (dz.poly) { dz.poly.pts.pop(); if (!dz.poly.pts.length) dz.poly = null; dzDraw(); return; }
  const hit = dz.design.features.length ? dzHit(map.mouseEventToContainerPoint(e)) : null;
  if (hit) { dzSelect(hit.f.id); setTimeout(() => dzPop.querySelector('input')?.focus(), 0); }
});

// Ctrl + wheel: brush size (brush tools) or corridor width (Slope tool), instead of zooming.
map.getContainer().addEventListener('wheel', e => {
  if (dz.mode !== 'design' || !e.ctrlKey || !dz.design || !(BRUSHES.includes(dz.tool) || PATHS.includes(dz.tool))) return;
  e.preventDefault(); e.stopPropagation();
  const k = Math.pow(1.1, -Math.sign(e.deltaY) * Math.min(3, Math.max(1, Math.abs(e.deltaY) / 100)));
  if (PATHS.includes(dz.tool)) {
    const key = dz.tool === 'swale' ? 'swidth' : 'width';
    dz.params[key] = Math.max(1, Math.min(500, Math.round(dz.params[key] * k * 10) / 10));
    dzFieldsChanged();
  } else {
    const mn = Number($('dz-size').min), mx = Number($('dz-size').max);
    dz.params.size = Math.max(mn, Math.min(mx, Math.round(dz.params.size * k * 10) / 10));
    saveDzParams(); dzSyncUi(); dzApplyTool();
  }
}, { passive: false, capture: true });

// Middle-button (wheel-click) drag pans the map in every tool.
map.getContainer().addEventListener('mousedown', e => {
  if (e.button !== 1) return;
  e.preventDefault();
  dz.pan = { x: e.clientX, y: e.clientY };
  map.getContainer().classList.add('panning');
}, true);
document.addEventListener('mousemove', e => {
  if (!dz.pan) return;
  map.panBy([dz.pan.x - e.clientX, dz.pan.y - e.clientY], { animate: false });
  dz.pan = { x: e.clientX, y: e.clientY };
});
document.addEventListener('mouseup', e => { if (e.button === 1 && dz.pan) { dz.pan = null; map.getContainer().classList.remove('panning'); } });
map.getContainer().addEventListener('auxclick', e => { if (e.button === 1) e.preventDefault(); });

map.on('mousedown', e => {
  if (dz.mode !== 'design' || !dz.design || dz.spaceDown || e.originalEvent.button !== 0) return;
  const xy = dzNative(e);
  const shapeTool = SHAPES.includes(dz.tool);
  // Polygon pad in progress: each click adds a corner; clicking the first corner closes it.
  if (dz.poly) {
    const M = dzAffine(dz.site), [fx, fy] = toScreen(M, ...dz.poly.pts[0]);
    if (dz.poly.kind === 'pad' && dz.poly.pts.length >= 3 && Math.hypot(fx - e.containerPoint.x, fy - e.containerPoint.y) < 10) dzFinishPoly();
    else dz.poly.pts.push(e.originalEvent.shiftKey ? orthoSnap(dz.poly.pts.at(-1), xy) : xy);
    dzDraw();
    return;
  }
  // Features: drag a handle of the selected one, or (with a shape tool) select / move one.
  const hit = dz.design.features.length ? dzHit(e.containerPoint) : null;
  if (hit && (shapeTool || hit.edge)) {
    if (dz.sel !== hit.f.id) dzSelect(hit.f.id);
    dz.edit = { id: hit.f.id, handle: hit.handle, from: xy, geom0: JSON.parse(JSON.stringify(hit.f.geom)), p0: { ...hit.f.p }, moved: false, pivot: hit.pivot, cursorS: [e.containerPoint.x, e.containerPoint.y], angle: 0 };
    return;
  }
  if (shapeTool) {
    if (dz.sel) { dz.sel = null; dzApplyTool(); dzFeatureList(); }
    if (dz.tool === 'pad' && dz.params.pshape === 'poly') { dz.poly = { kind: 'pad', pts: [xy] }; dzDraw(); return; }
    if (PATHS.includes(dz.tool) && dz.params.path !== 'line') { dz.poly = { kind: dz.tool, pts: [xy] }; dzDraw(); return; }
    dz.drawing = { kind: dz.tool, shape: dz.tool === 'pad' ? dz.params.pshape : null, a: xy, b: xy };
    dzDraw();
    return;
  }
  if (dz.sel) { dz.sel = null; dzApplyTool(); dzFeatureList(); }
  if (dz.tool === 'flatten' && (e.originalEvent.altKey || dz.target == null)) {
    const z = dz.design.proposedAt(xy[0], xy[1]);
    if (Number.isFinite(z)) { dz.target = Math.round(z * 100) / 100; dzSyncUi(); dzApplyTool(); setStatus(`Flatten target set to ${dz.target.toFixed(2)} ${dz.site.units}${e.originalEvent.altKey ? '' : ' (sampled here — Alt+click to sample again)'}.`); }
    if (e.originalEvent.altKey) return;
  }
  dz.design.begin(dz.tool, { amount: dz.params.amount, target: dz.target, soft: dz.params.soft / 100, radius: dz.params.size / dz.site.toOut, strength: dz.params.strength / 100 });
  dz.stroking = true; dz.last = null;
  dzStrokeTo(xy);
  dzRefresh();
});

/** Shift held: lock the direction from `from` to `to` to the project axes (project north if set, else grid). */
function orthoSnap(from, to) {
  const r = ($('local-origin').checked ? align.rot : 0) * Math.PI / 180;
  const ex = [Math.cos(r), -Math.sin(r)], ey = [Math.sin(r), Math.cos(r)];
  const dx = to[0] - from[0], dy = to[1] - from[1];
  let u = dx * ex[0] + dy * ex[1], v = dx * ey[0] + dy * ey[1];
  if (Math.abs(u) >= Math.abs(v)) v = 0; else u = 0;
  return [from[0] + u * ex[0] + v * ey[0], from[1] + u * ex[1] + v * ey[1]];
}

/** Move the feature (or one of its handles) being dragged so the grabbed point follows xy (Shift = orthogonal). */
function dzEditMove(xy, shift = false) {
  const ed = dz.edit, f = dz.design.feature(ed.id);
  if (!f) return;
  if (ed.handle === 'rot') {
    const M = dzAffine(dz.site);
    ed.cursorS = toScreen(M, ...xy);
    let deg = bearingOf(ed.pivot, xy) - bearingOf(ed.pivot, ed.from);
    deg = ((deg + 540) % 360) - 180;
    if (shift) deg = Math.round(deg / 15) * 15;
    if (!ed.moved && Math.abs(deg) < 0.05) return;
    if (!ed.moved) { dz.design.checkpoint(); ed.moved = true; }
    ed.angle = deg;
    const r = rotateFeature(ed.geom0, ed.p0, f.type, ed.pivot, deg);
    f.geom = r.geom;
    if (r.p) f.p = { ...f.p, ...r.p };
    dz.design.stale = true;
    return;
  }
  if (shift) {
    const g = ed.geom0;
    if (ed.handle < 0) xy = orthoSnap(ed.from, xy);
    else if (f.type !== 'pad' && g.pts) xy = orthoSnap(g.pts[ed.handle === 0 ? 1 : ed.handle - 1], xy);
    else if (f.type !== 'pad') xy = orthoSnap(ed.handle === 0 ? g.b : g.a, xy);
    else if (g.shape === 'poly') xy = orthoSnap(g.pts[(ed.handle - 1 + g.pts.length) % g.pts.length], xy);
  }
  const dx = xy[0] - ed.from[0], dy = xy[1] - ed.from[1];
  if (!ed.moved && Math.hypot(dx, dy) < 1e-9) return;
  if (!ed.moved) { dz.design.checkpoint(); ed.moved = true; }
  const g0 = ed.geom0;
  let geom;
  const sh = f.type === 'pad' ? (g0.shape || 'rect') : g0.pts ? 'poly' : null;
  if (sh === 'poly') {
    geom = ed.handle < 0 ? { pts: g0.pts.map(q => [q[0] + dx, q[1] + dy]) } : { pts: g0.pts.map((q, i) => (i === ed.handle ? xy : q.slice())) };
  } else if (sh === 'circle') {
    if (ed.handle === 1) geom = { r: Math.max(Math.hypot(xy[0] - g0.c[0], xy[1] - g0.c[1]), dz.site.grid.s) };
    else geom = { c: [g0.c[0] + dx, g0.c[1] + dy] };
  } else if (ed.handle < 0) geom = { a: [g0.a[0] + dx, g0.a[1] + dy], b: [g0.b[0] + dx, g0.b[1] + dy] };
  else if (sh === 'rect') {
    const cs = Design.padCorners(g0, f.p.rot);
    geom = { a: cs[(ed.handle + 2) % 4], b: xy }; // opposite corner stays put
  } else geom = ed.handle === 0 ? { a: xy } : { b: xy };
  f.geom = { ...f.geom, ...geom };
  dz.design.stale = true;
}

map.on('mousemove', e => {
  if (dz.mode !== 'design' || !dz.design || dz.pan) return;
  const xy = dzNative(e);
  const shift = e.originalEvent?.shiftKey;
  dz.cursor = dz.poly && shift ? orthoSnap(dz.poly.pts.at(-1), xy) : xy;
  if (dz.stroking) dzStrokeTo(xy);
  else if (dz.drawing) dz.drawing.b = shift && dz.drawing.kind !== 'pad' ? orthoSnap(dz.drawing.a, xy) : xy;
  else if (dz.edit) dzEditMove(xy, shift);
  else if (dz.design.features.length) {
    const hit = dzHit(e.containerPoint);
    map.getContainer().classList.toggle('over-handle', !!hit && hit.handle >= 0);
    map.getContainer().classList.toggle('over-rotate', !!hit && hit.handle === 'rot');
    map.getContainer().classList.toggle('over-feature', !!hit && hit.handle < 0 && (hit.edge || SHAPES.includes(dz.tool)));
  }
  dzReadout(xy);
  dzRefresh();
});
map.on('mouseout', () => { if (dz.mode === 'design') { dz.cursor = null; dzDraw(); } });

/** Close the polygon pad being clicked out (needs 3+ distinct corners). */
function dzFinishPoly() {
  const pts = [];
  for (const q of dz.poly?.pts || []) if (!pts.length || Math.hypot(q[0] - pts.at(-1)[0], q[1] - pts.at(-1)[1]) > dz.site.grid.s / 2) pts.push(q);
  const kind = dz.poly?.kind || 'pad';
  dz.poly = null;
  if (kind !== 'pad') {
    if (pts.length < 2) { setStatus(`A ${FEATURE_NAMES[kind].toLowerCase()} needs at least 2 points.`, true); dzDraw(); return; }
    const f = dz.design.addFeature(kind, { pts, smooth: dz.params.path === 'curve' && pts.length > 2 }, dzShapeParams(kind));
    dzSelect(f.id);
    dzAfterChange();
    return;
  }
  if (pts.length > 2 && Math.hypot(pts[0][0] - pts.at(-1)[0], pts[0][1] - pts.at(-1)[1]) < dz.site.grid.s / 2) pts.pop();
  if (pts.length < 3) { setStatus('A polygon pad needs at least 3 corners.', true); dzDraw(); return; }
  const f = dz.design.addFeature('pad', { shape: 'poly', pts, smooth: !!dz.params.psmooth }, dzShapeParams('pad'));
  dzSelect(f.id);
  dzAfterChange();
  if (!Number.isFinite(f.p.elev)) { setStatus(`Pad set to the ground at its centre (${f.out?.elev?.toFixed(2)}). Type an elevation to change it.`); $('dz-pelev').focus(); }
}
map.on('dblclick', () => { if (dz.mode === 'design' && dz.poly) dzFinishPoly(); });

document.addEventListener('mouseup', e => {
  if (e.button !== 0) return;
  // Shapes end exactly where the button is released (not at the last mouse-move).
  if ((dz.drawing || dz.edit) && dz.site) {
    try {
      const xy = dzNative(e);
      if (xy.every(Number.isFinite)) {
        if (dz.drawing) dz.drawing.b = e.shiftKey && dz.drawing.kind !== 'pad' ? orthoSnap(dz.drawing.a, xy) : xy;
        else dzEditMove(xy, e.shiftKey);
      }
    } catch { /* keep the last mouse-move position */ }
  }
  if (dz.stroking) {
    dz.stroking = false; dz.last = null;
    if (dz.design.end()) dzAfterChange();
  } else if (dz.drawing) {
    const d = dz.drawing;
    dz.drawing = null;
    const L = Math.hypot(d.b[0] - d.a[0], d.b[1] - d.a[1]);
    if (L < dz.site.grid.s * 2) { dzDraw(); return; }
    if (d.kind === 'pad' && d.shape === 'rect') {
      const cs = Design.padCorners({ a: d.a, b: d.b }, dzShapeParams('pad').rot);
      if (Math.hypot(cs[1][0] - cs[0][0], cs[1][1] - cs[0][1]) < dz.site.grid.s || Math.hypot(cs[3][0] - cs[0][0], cs[3][1] - cs[0][1]) < dz.site.grid.s) { dzDraw(); return; }
    }
    const f = dz.design.addFeature(d.kind, drawingGeom(d), dzShapeParams(d.kind));
    dzSelect(f.id);
    dzAfterChange();
    if (d.kind === 'pad' && !Number.isFinite(f.p.elev)) { setStatus(`Pad set to the ground at its centre (${f.out?.elev?.toFixed(2)}). Type an elevation to change it.`); $('dz-pelev').focus(); }
  } else if (dz.edit) {
    const moved = dz.edit.moved;
    dz.edit = null;
    if (moved) { dz.design.rebuild(); dzAfterChange(); }
  }
});

map.on('move zoom resize viewreset', () => { if (dz.mode === 'design') dzDraw(); });
map.on('zoomstart', () => { if (dz.mode === 'design') dzCanvas.style.visibility = 'hidden'; });
map.on('zoomend', () => { dzCanvas.style.visibility = ''; if (dz.mode === 'design') dzDraw(); });
const typing = e => /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName) && e.target.type !== 'range' && e.target.type !== 'checkbox' && e.target.type !== 'radio';
document.addEventListener('keydown', e => {
  if (dz.mode !== 'design') return;
  if (e.key === 'Escape') { if (dz.poly) { dz.poly = null; dzDraw(); } else if (dz.drawing) { dz.drawing = null; dzDraw(); } else if (dz.sel) { dz.sel = null; dzApplyTool(); dzFeatureList(); } if (typing(e)) e.target.blur(); return; }
  if (typing(e)) { if (e.key === 'Enter') e.target.blur(); return; }
  if (e.code === 'Space' && !dz.spaceDown) { dz.spaceDown = true; dzApplyTool(); e.preventDefault(); return; }
  if (dz.poly && e.key === 'Enter') { e.preventDefault(); dzFinishPoly(); return; }
  if (dz.poly && e.key === 'Backspace') { e.preventDefault(); dz.poly.pts.pop(); if (!dz.poly.pts.length) dz.poly = null; dzDraw(); return; }
  if ((e.key === 'Delete' || e.key === 'Backspace') && dz.sel) { e.preventDefault(); if (dz.design.removeFeature(dz.sel)) { dz.sel = null; dzApplyTool(); dzAfterChange(); } return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey ? dz.design?.doRedo() : dz.design?.doUndo()) dzAfterChange(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); if (dz.design?.doRedo()) dzAfterChange(); return; }
  if (e.key === '[' || e.key === ']') {
    const p = dz.params, mn = Number($('dz-size').min), mx = Number($('dz-size').max);
    p.size = Math.max(mn, Math.min(mx, Math.round(p.size * (e.key === ']' ? 1.2 : 1 / 1.2)) || mn));
    saveDzParams(); dzSyncUi(); dzApplyTool();
  }
});
document.addEventListener('keyup', e => { if (e.code === 'Space' && dz.spaceDown) { dz.spaceDown = false; dzApplyTool(); } });

// ----- Design files: save / open (.json), into the project folder when one is chosen -----
function dzFileData() {
  const site = dz.site, des = dz.design, b = state.rect.getBounds();
  return JSON.stringify({
    app: 'contours-to-revit', kind: 'site-design', version: 2, saved: new Date().toISOString(), tool: VERSION,
    key: designKey(site.grid, site.zone.code),
    site: { rect: [[b.getSouth(), b.getWest()], [b.getNorth(), b.getEast()]], poly: sitePolyLL(), zone: site.zone.code, units: site.units, spacing: site.spacingOut, interval: site.interval },
    grid: { x0: site.grid.x0, y0: site.grid.y0, s: site.grid.s, nx: site.grid.nx, ny: site.grid.ny },
    features: des.serialize().features, brush: f32ToB64(des.brush),
  });
}
$('dz-save').addEventListener('click', async () => {
  if (!dz.design) return;
  let toFolder = false;
  try { toFolder = await folderReady(); } catch { toFolder = false; }
  const data = dzFileData();
  try {
    if (toFolder) { const name = await writeToFolder('design', data, 'application/json'); setStatus(`Design saved to “${folder.handle.name}”: ${name}.`); }
    else { saveBlob(`${baseName(dz.site)}_design.json`, data, 'application/json'); setStatus('Design file downloaded.'); }
  } catch (err) { setStatus(`Couldn't save the design: ${err.message}`, true); }
});
$('dz-open').addEventListener('click', () => $('dz-file').click());
$('dz-file').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  let d;
  try { d = JSON.parse(await file.text()); } catch { setStatus('That file isn\'t a design file.', true); return; }
  if (d?.kind !== 'site-design' || !d.brush) { setStatus('That file isn\'t a Contours to Revit design.', true); return; }
  const saved = { v: 2, brush: b64ToF32(d.brush), features: d.features || [] };
  if (dz.site && d.key === designKey(dz.site.grid, dz.site.zone.code)) {
    dz.design.checkpoint();
    dz.design.load(saved);
    dz.sel = null;
    dzAfterChange();
    setStatus(`Opened “${file.name}”.`);
    return;
  }
  // Different (or no) site: keep the design for that site, put its boundary and settings back, and ask to generate.
  await idb.set(d.key, saved);
  const s = d.site || {};
  if (s.units) { const r = document.querySelector(`input[name="units"][value="${s.units}"]`); if (r) { r.checked = true; fillUnitOptions(); } }
  if (s.spacing != null) $('spacing').value = String(s.spacing);
  if (s.interval != null) $('interval').value = String(s.interval);
  if (s.zone) $('zone').value = String(s.zone);
  saveSettings();
  if (s.rect) {
    drawn.clearLayers();
    state.rect = boundaryLayer(s.rect, s.poly);
    drawn.addLayer(state.rect);
    saveRect();
    saveRect();
    map.fitBounds(state.rect.getBounds(), { padding: [30, 30] });
    onSiteChanged(true);
  }
  setMode('existing');
  setStatus(`“${file.name}” is for a different site — its boundary and settings are restored. Click Survey the site; the design opens in Site design.`);
});

// ----- New-construction exports -----
function dzDeltaAt(x, y) {
  const g = dz.site.grid, des = dz.design;
  const cx = Math.min(Math.max(x, g.x0), g.x0 + (g.nx - 1) * g.s - 1e-6), cy = Math.min(Math.max(y, g.y0), g.y0 + (g.ny - 1) * g.s - 1e-6);
  const v = des.sample(des.delta, cx, cy);
  return Number.isFinite(v) ? v : 0;
}

function makeNewDxf(site, v) {
  const des = dz.design;
  if (!des || dz.site !== site) throw new Error('open the Site design tab first');
  const d = new Dxf(site.units, datumOf(site));
  const pg = des.grid();
  const prop = contourLines(pg, dzLevels(pg));
  addContours(d, site, [], v.labels !== false, prop, { majr: 'C-TOPO-PROP-MAJR', minr: 'C-TOPO-PROP-MINR', text: 'C-TOPO-PROP-TEXT', cMaj: 30, cMin: 7, cTxt: 7 });
  if ($('dz-dxf-exist').checked) addContours(d, site, [], false, site.contours, { majr: 'C-TOPO-EXST-MAJR', minr: 'C-TOPO-EXST-MINR', text: 'C-TOPO-EXST-TEXT', cMaj: 252, cMin: 253, cTxt: 252 });
  const h = labelHeight(site), g = site.grid;
  const P = (x, y, z) => [...outXY(site, x, y), z];
  const zAt = (x, y) => { const z = des.proposedAt(x, y); return Number.isFinite(z) ? z : site.pStats.min; };
  if (des.changed) {
    // Limits of grading where the change is at least 0.05 (output units), draped on the proposed surface.
    const mag = { ...g, z: des.delta.map(Math.abs) };
    d.layer('C-GRAD-LIMT', 1);
    for (const c of contourLines(mag, [0.05])) for (const line of c.lines) d.polyline3d('C-GRAD-LIMT', line.map(([x, y]) => P(x, y, zAt(x, y))));
    let iMax = 0, iMin = 0;
    des.delta.forEach((dv, k) => { if (dv > des.delta[iMax]) iMax = k; if (dv < des.delta[iMin]) iMin = k; });
    d.layer('C-GRAD-TEXT', 1);
    for (const [k, word] of [[iMax, 'FILL'], [iMin, 'CUT']]) {
      const dv = des.delta[k];
      if (Math.abs(dv) < 0.05) continue;
      const x = g.x0 + (k % g.nx) * g.s, y = g.y0 + Math.floor(k / g.nx) * g.s;
      d.text('C-GRAD-TEXT', ...P(x, y, des.z[k]), h * 0.8, `MAX ${word} ${Math.abs(dv).toFixed(2)}`);
    }
  }
  // Features
  for (const f of des.features) {
    const o = f.out;
    if (!o) continue;
    if (f.type === 'pad') {
      d.layer('C-PAD', 4).layer('C-PAD-TEXT', 4);
      d.polyline3d('C-PAD', o.outline.map(([x, y]) => P(x, y, o.elev)), true);
      const [cx, cy] = centroidOf(o.outline);
      const t = `PAD EL ${o.elev.toFixed(2)}`;
      d.text('C-PAD-TEXT', ...P(cx, cy, o.elev), h, t);
    } else if (f.type === 'wall') {
      d.layer('C-WALL', 7).layer('C-WALL-TEXT', 7);
      const [a, b] = [f.geom.a, f.geom.b];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L, hw = f.p.thick / 2 / site.toOut;
      const [ta, tb] = [o.ends[0].tw, o.ends[2].tw];
      const ring = [[a[0] - uy * hw, a[1] + ux * hw, ta], [b[0] - uy * hw, b[1] + ux * hw, tb], [b[0] + uy * hw, b[1] - ux * hw, tb], [a[0] + uy * hw, a[1] - ux * hw, ta]];
      d.polyline3d('C-WALL', ring.map(([x, y, z]) => P(x, y, z)), true);
      const m = o.ends[1], mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
      const ang = Math.atan2(...(() => { const [p1, p2] = [outXY(site, ...a), outXY(site, ...b)]; return [p2[1] - p1[1], p2[0] - p1[0]]; })()) * 180 / Math.PI;
      const up = ang > 90 || ang < -90 ? ang + 180 : ang;
      const e0 = o.ends[0], e2 = o.ends[2];
      const rg = k => Math.abs(e0[k] - e2[k]) > 0.005 ? `${e0[k].toFixed(2)}-${e2[k].toFixed(2)}` : m[k].toFixed(2);
      const what = f.p.elevMode === 'set' ? 'RETAINING WALL' : `${f.p.height}' ${f.p.mode === 'cut' ? 'CUT' : 'FILL'} WALL`;
      d.text('C-WALL-TEXT', ...P(mx, my, m.tw), h * 0.7, `TW ${rg('tw')} / BW ${rg('bw')}  (${what}, ${f.p.thick}' THK)`, up);
      // Top / bottom of wall at each end.
      for (const [pt, en] of [[a, e0], [b, e2]]) d.text('C-WALL-TEXT', ...P(pt[0], pt[1], en.tw), h * 0.55, `TW ${en.tw.toFixed(2)} BW ${en.bw.toFixed(2)}`, up);
    } else {
      // Slope runs and swales: 3D centre line along the path (flowline for swales), arrow at the low end, label.
      const swale = f.type === 'swale';
      const pts = Design.pathPoints(f.geom);
      const z0 = swale ? o.fA : o.zA, z1 = swale ? o.fB : o.zB;
      const cum = [0];
      for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
      const tot = cum.at(-1) || 1, zAt = i => z0 + (z1 - z0) * cum[i] / tot;
      const [ly, lt] = swale ? ['C-SWAL-FLOW', 'C-SWAL-TEXT'] : ['C-GRAD-ARRW', 'C-GRAD-ARRW-TEXT'];
      d.layer(ly, swale ? 150 : 5).layer(lt, swale ? 150 : 5);
      d.polyline3d(ly, pts.map((q, i) => P(q[0], q[1], zAt(i))));
      const b = pts.at(-1), a = pts.at(-2), L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L, ah = h * 1.5 / site.toOut;
      d.polyline3d(ly, [P(b[0] - ux * ah - uy * ah * 0.5, b[1] - uy * ah + ux * ah * 0.5, z1), P(...b, z1), P(b[0] - ux * ah + uy * ah * 0.5, b[1] - uy * ah - ux * ah * 0.5, z1)]);
      if (swale) {
        // Top of bank both sides, draped on the proposed surface.
        d.layer('C-SWAL-BANK', 150);
        const hw = f.p.width / 2 / site.toOut;
        for (const sgn of [1, -1]) d.polyline3d('C-SWAL-BANK', pts.map((q, i) => {
          const pa = pts[Math.max(0, i - 1)], pb = pts[Math.min(pts.length - 1, i + 1)];
          const LL = Math.hypot(pb[0] - pa[0], pb[1] - pa[1]) || 1;
          const x = q[0] - (pb[1] - pa[1]) / LL * hw * sgn, y = q[1] + (pb[0] - pa[0]) / LL * hw * sgn;
          return P(x, y, zAt(i) + o.depth);
        }));
      }
      const mid = pathMid(pts);
      const [p1, p2] = [outXY(site, 0, 0), outXY(site, mid.dir[0], mid.dir[1])];
      let ang = Math.atan2(p2[1] - p1[1], p2[0] - p1[0]) * 180 / Math.PI;
      if (ang > 90 || ang < -90) ang += 180;
      const DL = Math.hypot(...mid.dir) || 1, nx = -mid.dir[1] / DL, ny = mid.dir[0] / DL;
      const pct = `${swale ? '' : { exact: '', max: 'MAX ', min: 'MIN ' }[f.p.mode || 'exact']}${(f.p.slope * 100).toFixed(2).replace(/\.?0+$/, '')}%`;
      const txt = swale ? `SWALE ${pct}  FL ${z0.toFixed(2)} TO ${z1.toFixed(2)}  (${f.p.width}' W x ${f.p.depth}' D)` : pct;
      d.text(lt, ...P(mid.pt[0] + nx * h / site.toOut, mid.pt[1] + ny * h / site.toOut, (z0 + z1) / 2), h * 0.7, txt, ang);
      if (swale) for (const [q, z] of [[pts[0], z0], [b, z1]]) d.text(lt, ...P(q[0], q[1], z), h * 0.55, `FL ${z.toFixed(2)}`, ang);
    }
  }
  return d.toString();
}

function makeNewCsv(site) {
  if (!dz.design || dz.site !== site) throw new Error('open the Site design tab first');
  const { pts } = site;
  const rows = [];
  for (let j = 0; j < pts.ny; j++) for (let i = 0; i < pts.nx; i++) {
    const zv = pts.z[j * pts.nx + i];
    if (Number.isNaN(zv)) continue;
    const x = pts.x0 + i * pts.s, y = pts.y0 + j * pts.s;
    const [ox, oy] = outXY(site, x, y);
    rows.push(`${ox.toFixed(3)},${oy.toFixed(3)},${(zv + dzDeltaAt(x, y) - datumOf(site)).toFixed(3)}`);
  }
  return rows.join('\r\n') + '\r\n';
}
MAKERS.newDxf = (s, v) => ({ name: `${baseName(s)}_new.dxf`, data: makeNewDxf(s, v), type: 'application/dxf' });
MAKERS.newCsv = (s, v) => ({ name: `${baseName(s)}_new_points.csv`, data: makeNewCsv(s), type: 'text/csv' });

// =====================================================================================================
// ---------- Projects: named, saved work sessions kept in this browser (IndexedDB) ----------
// =====================================================================================================
// Saving is manual: Save overwrites the open project, Save as new makes another. Changes since the last save are
// flagged in the bar. Opening another project first offers to save the current work, then zooms to the project.
var PROJ = { current: null, list: [], dirty: false, opening: false, savedAt: null, confirmDel: null, renaming: null, pending: null, recover: null };

async function projLoadList() {
  try { PROJ.list = (await idb.get('projects')) || []; } catch { PROJ.list = []; }
  PROJ.list.sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));
  return PROJ.list;
}
async function projStoreList() { try { await idb.set('projects', PROJ.list); } catch { /* ignore */ } }
const projDataKey = id => `project:${id}`;

/** Everything needed to put the work back. */
function projSnapshot() {
  const b = state.rect?.getBounds();
  const c = map.getCenter();
  const site = state.result;
  const des = dz.design && dz.site === site ? dz.design : null;
  return {
    rect: b ? [[b.getSouth(), b.getWest()], [b.getNorth(), b.getEast()]] : null,
    poly: sitePolyLL(),
    settings: store.get(),
    origin: state.origin ? { ...state.origin } : null,
    align: { ...align },
    layers: { ...visibility },
    prefix: folder.prefix,
    mode: dz.mode,
    view: { lat: c.lat, lng: c.lng, zoom: map.getZoom() },
    designKey: des ? designKey(site.grid, site.zone.code) : null,
    design: des && des.changed ? des.serialize() : null,
    summary: des ? { features: des.features.length } : null,
    sketch: JSON.parse(JSON.stringify(sketch.model)),
  };
}

/** Something changed since the last save or open. */
function projTouch() {
  if (!PROJ || PROJ.opening) return;
  if (!PROJ.dirty) { PROJ.dirty = true; projRender(); }
}

/** Write the current work into project `id` (manual save / overwrite). */
async function projWrite(id) {
  const meta = PROJ.list.find(p => p.id === id);
  if (!meta) return;
  const snap = projSnapshot();
  // A design not yet loaded in this session (site not generated since opening): keep the saved one.
  if (!snap.designKey && PROJ.current === id) {
    const old = await idb.get(projDataKey(id)).catch(() => null);
    if (old?.designKey && JSON.stringify(old.rect) === JSON.stringify(snap.rect)) { snap.designKey = old.designKey; snap.design = old.design; snap.summary = old.summary; }
  }
  await idb.set(projDataKey(id), snap).catch(() => {});
  meta.updated = new Date().toISOString();
  meta.place = state.rect ? fmtLatLon(state.rect.getBounds().getCenter().lat, state.rect.getBounds().getCenter().lng) : '';
  meta.rect = snap.rect;
  meta.features = snap.summary?.features ?? meta.features ?? 0;
  await projStoreList();
  PROJ.current = id;
  try { localStorage.setItem('c2r-project', id); } catch { /* ignore */ }
  PROJ.dirty = false;
  PROJ.savedAt = new Date();
  projRender();
}

async function projSaveAs(name) {
  name = (name || '').trim() || `Site ${new Date().toLocaleDateString()}`;
  await projLoadList();
  const id = `p${Date.now().toString(36)}`;
  PROJ.list.unshift({ id, name, created: new Date().toISOString(), updated: new Date().toISOString(), place: '', features: 0 });
  await projWrite(id);
  setStatus(`Saved as project “${name}”.`);
}

async function projSave() {
  const meta = PROJ.list.find(p => p.id === PROJ.current);
  if (!meta) return;
  await projWrite(meta.id);
  setStatus(`Saved “${meta.name}”.`);
}

/** Ask what to do with unsaved work before leaving it. Resolves to true to continue, false to cancel. */
function projAskSave(nextLabel) {
  if (!PROJ.dirty || !state.rect) return Promise.resolve(true);
  const meta = PROJ.list.find(p => p.id === PROJ.current);
  const box = $('proj-ask');
  box.innerHTML = `<div class="pa-title">Save your current work first?</div>
    <p class="pa-text">You have unsaved changes${meta ? ` to “${escapeHtml(meta.name)}”` : ''}. ${escapeHtml(nextLabel)}</p>
    <div class="proj-save-row"><input type="text" class="pa-name" placeholder="New project name" spellcheck="false"><button type="button" class="btn" data-a="new">Save as new</button></div>
    <div class="pa-btns">${meta ? `<button type="button" class="btn" data-a="over">Overwrite “${escapeHtml(meta.name)}”</button>` : ''}<button type="button" class="btn btn-quiet" data-a="skip">Don't save</button><button type="button" class="btn btn-quiet" data-a="cancel">Cancel</button></div>`;
  box.hidden = false;
  box.querySelector('.pa-name').focus();
  return new Promise(resolve => {
    const done = async a => {
      if (a === 'new') await projSaveAs(box.querySelector('.pa-name').value);
      if (a === 'over' && meta) await projWrite(meta.id);
      box.hidden = true;
      resolve(a !== 'cancel');
    };
    box.querySelectorAll('[data-a]').forEach(b => b.addEventListener('click', () => done(b.dataset.a)));
    box.querySelector('.pa-name').addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') done('new'); if (e.key === 'Escape') done('cancel'); });
  });
}

async function projOpen(id) {
  const meta = PROJ.list.find(p => p.id === id);
  const snap = await idb.get(projDataKey(id)).catch(() => null);
  if (!meta || !snap) { setStatus('That project could not be opened.', true); return; }
  PROJ.opening = true;
  PROJ.current = id;
  try { localStorage.setItem('c2r-project', id); } catch { /* ignore */ }
  try {
    if (pick.active) stopPick();
    if (dz.mode === 'design' || dz.mode === 'sketch' || dz.mode === 'diagram') setMode('existing');
    sketchPending = snap.sketch || null;
    // Design: stored under its key, and kept as "pending" so it can be fitted to a slightly different grid.
    PROJ.pending = snap.designKey && snap.design ? { key: snap.designKey, design: snap.design } : null;
    if (PROJ.pending) await idb.set(snap.designKey, snap.design);
    store.set(snap.settings || {});
    restoreSettings();
    state.origin = snap.origin || null; session.set('origin', state.origin);
    Object.assign(align, { rot: 0, datum: null, northRef: 'grid' }, snap.align || {}); saveAlign();
    $('rot-deg').value = String(align.rot || 0); $('datum').value = align.datum != null ? String(align.datum) : '';
    if (snap.layers) {
      Object.assign(visibility, snap.layers);
      state.keepLayers = true;
      try { localStorage.setItem('c2r-layers', JSON.stringify(visibility)); } catch { /* ignore */ }
      document.querySelectorAll('.layers-panel .lp-row').forEach(row => { row.querySelector('input').checked = !!visibility[row.dataset.key]; });
      lpSync();
    }
    if (snap.prefix) { folder.prefix = snap.prefix; $('folder-prefix').value = snap.prefix; try { localStorage.setItem('c2r-prefix', snap.prefix); } catch { /* ignore */ } updateFolderUi(); }
    drawn.clearLayers();
    state.result = null;
    sketch.onSite(null);
    for (const g of Object.values(state.mapGroups || {})) map.removeLayer(g);
    state.mapGroups = {};
    $('step-results').hidden = true;
    if (snap.rect) { state.rect = boundaryLayer(snap.rect, snap.poly); drawn.addLayer(state.rect); saveRect(); }
    else state.rect = null;
    saveRect();
    // Zoom to the project's extents.
    if (state.rect) map.fitBounds(state.rect.getBounds(), { padding: [30, 30], animate: false });
    else if (snap.view) map.setView([snap.view.lat, snap.view.lng], snap.view.zoom, { animate: false });
    await onSiteChanged(true);
    applyOrigin();
    PROJ.dirty = false;
    projRender();
    if (state.rect) {
      setStatus(`Opening “${meta.name}” — generating the site…`);
      $('generate').disabled = true;
      try { await generate(); } catch (err) { console.error(err); setStatus(`Opened “${meta.name}”, but generating failed: ${err.message || err}. Click Survey the site to try again.`, true); }
      finally { $('generate').disabled = !state.rect; }
      if (state.result && snap.mode === 'design') { setMode('design'); await dzEnsure(); }
      if (state.result && (snap.mode === 'sketch' || snap.mode === 'diagram')) setMode(snap.mode);
      if (state.result) setStatus(`Opened “${meta.name}”.`);
    } else setStatus(`Opened “${meta.name}” (no site boundary yet).`);
  } finally {
    PROJ.opening = false;
    PROJ.dirty = false;
    projRender();
  }
}

/** Click on a project: offer to save the current work, then open it (zooming to its extents). */
async function projRequestOpen(id) {
  const meta = PROJ.list.find(p => p.id === id);
  if (!meta) return;
  $('proj-menu').hidden = true;
  if (!(await projAskSave(`Opening “${meta.name}” replaces what's on the map.`))) return;
  await projOpen(id);
}

async function projDelete(id) {
  const meta = PROJ.list.find(p => p.id === id);
  PROJ.list = PROJ.list.filter(p => p.id !== id);
  await idb.set(projDataKey(id), undefined).catch(() => {});
  await projStoreList();
  if (PROJ.current === id) { PROJ.current = null; try { localStorage.removeItem('c2r-project'); } catch { /* ignore */ } }
  PROJ.confirmDel = null;
  projRender();
  if (meta) setStatus(`Deleted project “${meta.name}”. Your current work on the map is unchanged.`);
}

async function projRename(id, name) {
  const meta = PROJ.list.find(p => p.id === id);
  name = (name || '').trim();
  PROJ.renaming = null;
  if (meta && name) { meta.name = name; await projStoreList(); }
  projRender();
}

/** Leave the open project without saving (it stays as last saved); work continues as unsaved. */
function projDetach() {
  PROJ.current = null;
  try { localStorage.removeItem('c2r-project'); } catch { /* ignore */ }
  projRender();
}

// ----- Recovering autosaved designs that aren't in a saved project -----
async function projFindOrphans() {
  const keys = (await idb.keys().catch(() => [])).filter(k => typeof k === 'string' && k.startsWith('design:'));
  const used = new Set();
  for (const p of PROJ.list) { const snap = await idb.get(projDataKey(p.id)).catch(() => null); if (snap?.designKey) used.add(snap.designKey); }
  const out = [];
  for (const key of keys) {
    if (used.has(key)) continue;
    const g = parseDesignKey(key), zone = g && zoneByCode(g.zone);
    if (!zone) continue;
    const saved = await idb.get(key).catch(() => null);
    if (!saved) continue;
    const pr = projector(zone);
    const corners = [[g.x0, g.y0], [g.x0 + (g.nx - 1) * g.s, g.y0], [g.x0 + (g.nx - 1) * g.s, g.y0 + (g.ny - 1) * g.s], [g.x0, g.y0 + (g.ny - 1) * g.s]].map(q => pr.inv(q));
    const lons = corners.map(q => q[0]), lats = corners.map(q => q[1]);
    const pad = 0.00002;
    const rect = [[Math.min(...lats) - pad, Math.min(...lons) - pad], [Math.max(...lats) + pad, Math.max(...lons) + pad]];
    const feats = saved.features?.length || 0, brushed = (saved.brush || []).some?.(v => v !== 0);
    if (!feats && !brushed) continue;
    out.push({ key, g, zone, rect, feats, brushed, saved });
  }
  return out;
}

async function projRecover(o) {
  const name = `Recovered ${fmtLatLon((o.rect[0][0] + o.rect[1][0]) / 2, (o.rect[0][1] + o.rect[1][1]) / 2)}`;
  const id = `p${Date.now().toString(36)}`;
  const k = o.saved.features?.find(f => f.p?.k)?.p.k;
  const settings = { ...store.get(), zone: String(o.zone.code), units: k && Math.abs(k - 1) > 1e-6 ? 'm' : 'ft' };
  const snap = { rect: o.rect, settings, origin: null, align: { ...align }, layers: { ...visibility }, prefix: folder.prefix, mode: 'design', view: null, designKey: o.key, design: o.saved, summary: { features: o.feats } };
  await idb.set(projDataKey(id), snap);
  PROJ.list.unshift({ id, name, created: new Date().toISOString(), updated: new Date().toISOString(), place: fmtLatLon((o.rect[0][0] + o.rect[1][0]) / 2, (o.rect[0][1] + o.rect[1][1]) / 2), rect: o.rect, features: o.feats });
  await projStoreList();
  PROJ.recover = null;
  projRender();
  setStatus(`Made “${name}” from an autosaved design. Click it to open (rename it with ✎).`);
}

// ----- Bar / menu -----
let projOutline = null;
function projShowOutline(rect) {
  if (projOutline) { map.removeLayer(projOutline); projOutline = null; }
  if (rect) projOutline = L.rectangle(rect, { color: '#38bdf8', weight: 2, dashArray: '6 4', fill: false, interactive: false }).addTo(map);
}

function projRender() {
  if (!$('proj-name')) return;
  const meta = PROJ.list.find(p => p.id === PROJ.current);
  $('proj-name').textContent = meta ? meta.name : 'Unsaved work';
  $('proj-bar').classList.toggle('has-project', !!meta);
  $('proj-bar').classList.toggle('dirty', !!PROJ.dirty && !!state.rect);
  $('proj-state').textContent = meta
    ? (PROJ.dirty ? '● unsaved changes' : PROJ.savedAt ? `saved ${PROJ.savedAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : 'saved')
    : (state.rect ? 'not saved' : '');
  $('proj-save').hidden = !meta;
  $('proj-save').textContent = meta ? `Save “${meta.name}”` : 'Save';
  const ul = $('proj-list');
  const when = iso => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); };
  ul.innerHTML = PROJ.list.length ? PROJ.list.map(p => {
    const cur = p.id === PROJ.current;
    const name = PROJ.renaming === p.id
      ? `<input class="proj-rename" value="${escapeHtml(p.name)}" data-id="${p.id}">`
      : `<button type="button" class="proj-open" data-id="${p.id}" title="Open and zoom to this project"><b>${escapeHtml(p.name)}${cur ? ' <i class="proj-cur">open</i>' : ''}</b><span>${escapeHtml([p.place, p.features ? `${p.features} feature${p.features === 1 ? '' : 's'}` : '', when(p.updated)].filter(Boolean).join(' · '))}</span></button>`;
    return `<li class="proj-item${cur ? ' cur' : ''}" data-id="${p.id}">${name}
      <button type="button" class="proj-act" data-act="rename" data-id="${p.id}" title="Rename">✎</button>
      <button type="button" class="proj-act proj-del${PROJ.confirmDel === p.id ? ' confirm' : ''}" data-act="delete" data-id="${p.id}" title="Delete">${PROJ.confirmDel === p.id ? 'Delete?' : '🗑'}</button></li>`;
  }).join('') : '<li class="proj-empty">No saved projects yet.</li>';
  ul.querySelectorAll('.proj-open').forEach(b => b.addEventListener('click', () => projRequestOpen(b.dataset.id)));
  ul.querySelectorAll('.proj-item').forEach(li => {
    const p = PROJ.list.find(q => q.id === li.dataset.id);
    li.addEventListener('mouseenter', () => projShowOutline(p?.rect));
    li.addEventListener('mouseleave', () => projShowOutline(null));
  });
  ul.querySelectorAll('.proj-act').forEach(b => b.addEventListener('click', () => {
    const id = b.dataset.id;
    if (b.dataset.act === 'rename') { PROJ.renaming = id; PROJ.confirmDel = null; projRender(); const i = ul.querySelector('.proj-rename'); i?.focus(); i?.select(); return; }
    if (PROJ.confirmDel === id) projDelete(id); else { PROJ.confirmDel = id; projRender(); setTimeout(() => { if (PROJ.confirmDel === id) { PROJ.confirmDel = null; projRender(); } }, 4000); }
  }));
  const ri = ul.querySelector('.proj-rename');
  if (ri) {
    ri.addEventListener('keydown', e => { if (e.key === 'Enter') projRename(ri.dataset.id, ri.value); else if (e.key === 'Escape') { PROJ.renaming = null; projRender(); } e.stopPropagation(); });
    ri.addEventListener('blur', () => projRename(ri.dataset.id, ri.value));
  }
  // Recovery list
  const rl = $('proj-recover-list');
  if (PROJ.recover) {
    rl.hidden = false;
    rl.innerHTML = PROJ.recover.length ? PROJ.recover.map((o, i) => `<li class="proj-item"><button type="button" class="proj-open" data-i="${i}" title="Make this into a project"><b>${escapeHtml(fmtLatLon((o.rect[0][0] + o.rect[1][0]) / 2, (o.rect[0][1] + o.rect[1][1]) / 2))}</b><span>${o.feats} feature${o.feats === 1 ? '' : 's'}${o.brushed ? ' + brush grading' : ''} · ${escapeHtml(o.zone.name)}</span></button><button type="button" class="proj-act" data-i="${i}" title="Make project">＋</button></li>`).join('')
      : '<li class="proj-empty">Nothing to recover — every autosaved design is in a project.</li>';
    rl.querySelectorAll('[data-i]').forEach(b => b.addEventListener('click', () => projRecover(PROJ.recover[+b.dataset.i])));
    rl.querySelectorAll('.proj-item').forEach((li, i) => {
      li.addEventListener('mouseenter', () => projShowOutline(PROJ.recover[i]?.rect));
      li.addEventListener('mouseleave', () => projShowOutline(null));
    });
  } else rl.hidden = true;
}

$('proj-toggle').addEventListener('click', async () => {
  const menu = $('proj-menu');
  if (menu.hidden) { await projLoadList(); PROJ.recover = null; projRender(); }
  menu.hidden = !menu.hidden;
  if (menu.hidden) projShowOutline(null);
});
document.addEventListener('mousedown', e => { if (!$('proj-menu').hidden && !e.target.closest('#proj-bar')) { $('proj-menu').hidden = true; projShowOutline(null); } });
$('proj-save').addEventListener('click', async () => { await projSave(); $('proj-menu').hidden = true; });
$('proj-save-as').addEventListener('click', async () => {
  const meta = PROJ.list.find(p => p.id === PROJ.current);
  const name = $('proj-new-name').value || (meta ? `${meta.name} copy` : '');
  $('proj-new-name').value = '';
  await projSaveAs(name);
  $('proj-menu').hidden = true;
});
$('proj-new-name').addEventListener('keydown', e => { if (e.key === 'Enter') $('proj-save-as').click(); e.stopPropagation(); });
$('proj-new').addEventListener('click', async () => {
  $('proj-menu').hidden = true;
  if (!(await projAskSave('Starting a new project clears the map.'))) return;
  projDetach();
  if (dz.mode === 'design' || dz.mode === 'sketch' || dz.mode === 'diagram') setMode('existing');
  clearAll();
  PROJ.dirty = false; projRender();
  setStatus('Started a new blank project. Draw a site boundary to begin.');
});
$('proj-recover').addEventListener('click', async () => {
  $('proj-recover').disabled = true;
  try { PROJ.recover = await projFindOrphans(); } finally { $('proj-recover').disabled = false; }
  projRender();
});

(async () => {
  await projLoadList();
  try { const id = localStorage.getItem('c2r-project'); if (id && PROJ.list.some(p => p.id === id)) PROJ.current = id; } catch { /* ignore */ }
  // Older saves didn't keep the boundary in the index; fill it in for the hover outline.
  for (const p of PROJ.list) if (!p.rect) { const snap = await idb.get(projDataKey(p.id)).catch(() => null); if (snap?.rect) p.rect = snap.rect; }
  PROJ.dirty = false;
  projRender();
})();

// ---------- Utils ----------
function fmt(v, dec = 0) {
  return Number(v).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}
function fmtLatLon(lat, lon) {
  return `${Math.abs(lat).toFixed(5)}°${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(5)}°${lon >= 0 ? 'E' : 'W'}`;
}
function dateRange(a, b) { return a && b && a !== b ? `${a} to ${b}` : (a || b); }
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

// ---------- Init ----------
fillZones();
restoreSettings();
// ---------- Clear all (map control) ----------
function clearAll() {
  if (pick.active) stopPick();
  drawn.clearLayers();
  state.rect = null;
  saveRect();
  for (const g of Object.values(state.mapGroups || {})) map.removeLayer(g);
  state.mapGroups = {};
  state.origin = null;
  session.set('origin', null);
  align.rot = 0; align.datum = null; saveAlign();
  $('rot-deg').value = '0'; $('datum').value = '';
  state.result = null;
  sketch.onSite(null);
  $('step-results').hidden = true;
  if (curView() !== 'map') document.querySelector('.tab[data-view="map"]').click();
  document.querySelector('.tab[data-view="preview"]').disabled = true;
  document.querySelector('.tab[data-view="3d"]').disabled = true;
  flowSet(false); $('flow-toggle').disabled = true;
  sunSet(false); $('sun-toggle').disabled = true;
  windSet(false); $('wind-toggle').disabled = true;
  updateLayerCounts(null);
  siteImgDraw();
  onSiteChanged(false);
  applyOrigin();
  if (dz.mode === 'design') { dzEnsure(); dzDraw(); }
  setStatus('Cleared. Draw a new site boundary to start again.');
}
const ClearControl = L.Control.extend({
  options: { position: 'topleft' },
  onAdd() {
    const el = L.DomUtil.create('div', 'leaflet-bar clear-control');
    el.innerHTML = '<a href="#" role="button" title="Clear site, layers and origin" aria-label="Clear all">Clear</a>';
    L.DomEvent.disableClickPropagation(el);
    el.querySelector('a').addEventListener('click', e => { e.preventDefault(); clearAll(); if (PROJ.current) { const n = PROJ.list.find(p => p.id === PROJ.current)?.name; projDetach(); setStatus(`Cleared. “${n}” is unchanged — open it from Projects.`); } });
    return el;
  },
});
map.addControl(new ClearControl());

// ---------- Hosted map data (settings) ----------
async function refreshHostedList() {
  const idx = await hostedContextIndex();
  const ul = $('hosted-states');
  if (!idx?.states?.length) { ul.innerHTML = '<li><span>No hosted data yet — the public OpenStreetMap servers are used everywhere.</span></li>'; return; }
  const title = id => id.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  ul.innerHTML = idx.states.map(st => `<li><span><strong>${escapeHtml(title(st.id))}</strong> — ${fmt(st.n.p, 0)} lots, ${fmt(st.n.w, 0)} sidewalks${st.n.m ? `, ${fmt(st.n.m, 0)} Microsoft buildings (${fmt(st.n.mh, 0)} with heights)` : ''}</span><span>OSM ${escapeHtml(st.src)} · ${st.mb} MB</span></li>`).join('');
}
refreshHostedList();

// ---------- Data refresh status + "Update data" (GitHub Actions) ----------
const GH = { repo: 'AMRJacob/Contours-to-Revit', wf: 'site.yml' };
const ghPage = `https://github.com/${GH.repo}/actions/workflows/${GH.wf}`;
const ghToken = () => { try { return localStorage.getItem('c2r-gh') || ''; } catch { return ''; } };
async function gh(path, opts = {}) {
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  const t = ghToken();
  if (t) headers.Authorization = `Bearer ${t}`;
  const r = await fetch(`https://api.github.com/repos/${GH.repo}${path}`, { ...opts, headers: { ...headers, ...(opts.headers || {}) } });
  if (!r.ok && r.status !== 204) throw new Error(`GitHub ${r.status}${r.status === 401 || r.status === 403 ? ' (token missing permission?)' : ''}`);
  return r.status === 204 ? null : r.json();
}

async function checkDataStatus() {
  const el = $('data-status'), btn = $('update-data');
  const problems = [];
  let info = '';
  try {
    const idx = await hostedContextIndex();
    const built = idx?.states?.[0]?.built;
    if (built) {
      const age = Math.floor((Date.now() - Date.parse(built)) / 864e5);
      info = `Data built ${built} (${age === 0 ? 'today' : age === 1 ? 'yesterday' : `${age} days ago`}).`;
      if (age > 9) problems.push(`Data is ${age} days old.`);
    } else problems.push('No hosted data yet.');
  } catch { /* index missing */ }
  try {
    const wf = await gh(`/actions/workflows/${GH.wf}`);
    if (wf.state !== 'active') problems.push('The weekly refresh is paused (GitHub pauses it after 60 days without repository activity).');
    const runs = await gh(`/actions/workflows/${GH.wf}/runs?per_page=1`);
    const last = runs.workflow_runs?.[0];
    if (last?.status && last.status !== 'completed') info += ' An update is running now.';
    else if (last?.conclusion && last.conclusion !== 'success') problems.push(`The last update ${last.conclusion}.`);
  } catch (err) { info += ' (Couldn\'t reach GitHub to check the refresh job.)'; }
  el.className = 'data-status ' + (problems.length ? 'stale' : 'ok');
  el.textContent = problems.length ? `${problems.join(' ')} ${info}` : `${info} Weekly refresh is on.`;
  btn.classList.toggle('attention', problems.length > 0);
}

async function updateData() {
  const btn = $('update-data'), el = $('data-status');
  if (!ghToken()) { window.open(ghPage, '_blank', 'noopener'); el.textContent = 'Opened the job on GitHub — click "Run workflow" (and "Enable workflow" if shown). Data refreshes in about 3 minutes.'; return; }
  btn.disabled = true;
  try {
    const wf = await gh(`/actions/workflows/${GH.wf}`);
    if (wf.state !== 'active') await gh(`/actions/workflows/${GH.wf}/enable`, { method: 'PUT' });
    const started = Date.now();
    await gh(`/actions/workflows/${GH.wf}/dispatches`, { method: 'POST', body: JSON.stringify({ ref: 'main' }) });
    el.className = 'data-status'; el.textContent = 'Update started on GitHub — this takes about 3 minutes…';
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 10000));
      const runs = await gh(`/actions/workflows/${GH.wf}/runs?per_page=1&event=workflow_dispatch`);
      const run = runs.workflow_runs?.[0];
      if (!run || Date.parse(run.created_at) < started - 60000) continue;
      el.textContent = `Update ${run.status === 'completed' ? run.conclusion : run.status.replace('_', ' ')}…`;
      if (run.status === 'completed') {
        if (run.conclusion !== 'success') throw new Error(`the update ${run.conclusion} — see ${run.html_url}`);
        await new Promise(r => setTimeout(r, 20000)); // let Pages finish publishing
        ctxIndexReset();
        break;
      }
    }
  } catch (err) {
    el.className = 'data-status stale'; el.textContent = `Couldn't update: ${err.message}`;
    btn.disabled = false;
    return;
  }
  btn.disabled = false;
  await refreshHostedList();
  await checkDataStatus();
}

$('update-data').addEventListener('click', updateData);
$('gh-token').value = ghToken() ? '••••••••' : '';
$('gh-save').addEventListener('click', () => {
  const v = $('gh-token').value.trim();
  if (!v || v.startsWith('•')) return;
  try { localStorage.setItem('c2r-gh', v); } catch { /* ignore */ }
  $('gh-token').value = '••••••••';
  checkDataStatus();
});
$('gh-forget').addEventListener('click', () => { try { localStorage.removeItem('c2r-gh'); } catch { /* ignore */ } $('gh-token').value = ''; checkDataStatus(); });
// Admin tools (data status, Update data, state list) only with ?admin in the address.
const isAdmin = new URLSearchParams(location.search).has('admin');
document.querySelectorAll('.admin-only').forEach(el => { el.hidden = !isAdmin; });
if (isAdmin) checkDataStatus();

// Restore the last site boundary and picked origin (map view is restored when the map is created).
state.origin = session.get('origin');
const savedRect = session.get('rect');
if (savedRect) {
  const r = boundaryLayer(savedRect, session.get('poly'));
  drawn.addLayer(r);
  state.rect = r;
  onSiteChanged(true);
}
$('rot-deg').value = String(align.rot || 0);
$('datum').value = align.datum != null ? String(align.datum) : '';
updateTopoSummary();
applyOrigin();
updateZoneHint();
// ---------- Aerial imagery source (Settings) ----------
function imgDetailNote(site) {
  const r = imgRow(site);
  return r?.effIn ? ` — about ${fmtIn(r.effIn)} per pixel of real detail${r.year ? `, flown ${r.year}` : ''}` : '';
}
/** README: which sources were checked at this site and why the one used was picked. */
function imgReadmeLines(site) {
  const p = site.imageryProbe;
  if (!p?.results?.length) return [];
  const lab = r => `${r.src.label}${r.how === 'tiles' && r.src.kind !== 'tiles' ? ' (tiles)' : ''}`;
  const lines = ['Imagery sources checked at this site (detail measured from sample pixels; blank or patchy sources are not used):'];
  for (const r of p.results) {
    const used = site.imagerySrc && r.src.id === site.imagerySrc.id && r.how === site.imageryHow;
    lines.push(`  ${used ? '*' : '-'} ${lab(r)}${r.year ? ` (${r.year})` : ''}: ${r.status === 'ok' ? `about ${fmtIn(r.effIn)} per pixel` : r.why}${used ? '  <- used' : ''}`);
  }
  lines.push(`  Rule: ${imgChoice.prefer === 'new' ? 'newest source that is at most 1.5x coarser than the sharpest' : 'sharpest source (within 10 %, the newer one)'}${imgChoice.id !== 'auto' ? '; a source was chosen by hand in Settings' : ''}.`);
  return lines;
}
function imgUsedText(site) {
  if (!site) return 'Survey a site to see which sources cover it.';
  if (!site.imagerySrc) return `No imagery service returned photos for this site — hillshade shown.${site.imageryNotes?.length ? ` (${escapeHtml(site.imageryNotes.join('; '))})` : ''}`;
  const s = site.imagerySrc, r = imgRow(site);
  const asked = imgChoice.id === 'auto' ? '' : imgChoice.id === 'custom' ? (s.id === 'custom' ? '' : ' — the custom service failed, so the next best was used')
    : s.id === imgChoice.id ? '' : ' — your chosen source failed or has no photos here, so the next best was used';
  return `${escapeHtml(s.label)}${site.imageryHow === 'tiles' && s.kind !== 'tiles' ? ' (map tiles)' : ''}${r?.effIn ? ` · about ${fmtIn(r.effIn)}/px` : ''}${r?.year ? ` · ${r.year}` : ''}${asked}.`;
}
function imgUi() {
  const sel = $('img-src');
  const site = state.result;
  const flights = (site?.imageryProbe?.results || []).map(r => r.src).filter((s, i, a) => s.parent && a.findIndex(q => q.id === s.id) === i);
  const opt = s => `<option value="${s.id}">${escapeHtml(s.label)}${s.auto === false ? ' — not picked automatically' : ''}</option>`;
  const html = '<option value="auto">Automatic — best photos here</option>'
    + (flights.length ? `<optgroup label="Found at this site">${flights.map(opt).join('')}</optgroup>` : '')
    + STATE_LIST.map(st => `<optgroup label="${escapeHtml(st.name)}">${IMAGERY_SOURCES.filter(s => imgStateOf(s) === st.code && !s.flights).map(opt).join('')}</optgroup>`).join('')
    + `<optgroup label="National">${IMAGERY_SOURCES.filter(s => !imgStateOf(s)).map(opt).join('')}</optgroup>`
    + '<option value="custom">Custom ArcGIS service…</option>';
  if (sel.dataset.html !== html) { sel.innerHTML = html; sel.dataset.html = html; }
  sel.value = [...sel.options].some(o => o.value === imgChoice.id) ? imgChoice.id : 'auto';
  $('img-custom-row').hidden = imgChoice.id !== 'custom';
  if (document.activeElement !== $('img-custom')) $('img-custom').value = imgChoice.custom;
  for (const r of document.querySelectorAll('input[name="img-prefer"]')) r.checked = r.value === imgChoice.prefer;
  const box = $('img-states');
  if (!box.childElementCount) {
    box.innerHTML = STATE_LIST.map(st => `<label class="check"><input type="checkbox" value="${st.code}"> ${escapeHtml(st.name)} <span class="img-muted">(${st.count} services)</span></label>`).join('');
  }
  for (const c of box.querySelectorAll('input')) c.checked = imgChoice.states.includes(c.value);
  $('img-used').innerHTML = `This site: ${imgUsedText(site)}`;
  // Every source checked at this site, best first.
  const p = site?.imageryProbe, tb = $('img-table');
  if (!p?.results?.length) { tb.hidden = true; $('img-recheck').hidden = !site; }
  else {
    const order = imgRank(p.results, imgChoice.prefer).map(([q, h]) => `${q.id}:${h}`);
    const rows = p.results.slice().sort((a, b) => {
      const ia = order.indexOf(`${a.src.id}:${a.how}`), ib = order.indexOf(`${b.src.id}:${b.how}`);
      return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
    });
    tb.innerHTML = '<thead><tr><th>Source</th><th>Year</th><th title="Real detail measured from sample pixels">Detail</th><th></th></tr></thead><tbody>'
      + rows.map(r => {
        const used = site.imagerySrc && r.src.id === site.imagerySrc.id && r.how === site.imageryHow;
        const tl = r.how === 'tiles' && r.src.kind !== 'tiles' ? ' (tiles)' : '';
        const st = r.status === 'ok' ? `${fmtIn(r.effIn)}${r.nativeIn && r.measuredIn && r.measuredIn > r.nativeIn * 1.15 ? `<span class="img-muted" title="Published pixel size ${fmtIn(r.nativeIn)}"> (pub. ${fmtIn(r.nativeIn)})</span>` : ''}`
          : `<span class="img-muted">${escapeHtml(r.why)}</span>`;
        return `<tr class="${used ? 'used' : ''} ${r.status === 'ok' ? '' : 'bad'}" title="${escapeHtml(r.src.publisher || '')}"><td>${used ? '✓ ' : ''}${escapeHtml(r.src.label + tl)}</td><td>${r.year || '—'}</td><td>${st}</td>`
          + `<td>${r.status === 'ok' && !used ? `<button type="button" class="img-link" data-imguse="${escapeHtml(r.src.id)}">Use</button>` : ''}</td></tr>`;
      }).join('') + '</tbody>';
    tb.hidden = false;
    $('img-recheck').hidden = false;
  }
  $('img-checked').textContent = p?.checked ? `Checked ${new Date(p.checked).toLocaleString()}${p.notes?.length ? ` · ${p.notes.join('; ')}` : ''}.` : '';
  const si = $('src-imagery'); if (si) si.innerHTML = imgUsedText(site);
}
const imgStateOf = s => s.state || null;
let imgBusy = 0;
async function refreshImagery() {
  imgUi();
  const site = state.result;
  if (!site) return;
  const seq = ++imgBusy;
  $('img-used').textContent = 'This site: loading…';
  const r = await fetchImagery(site.zone, site.box);
  if (seq !== imgBusy || state.result !== site) return;
  Object.assign(site, { imagery: r.bitmap, imageryCredit: r.credit, imagerySrc: r.src, imageryHow: r.how, imageryNotes: r.notes, imageryProbe: r.probe });
  site._aerial = null;
  site.meta = buildMeta(site);
  drawUnderlayThumb();
  renderPreview();
  v3Dirty();
  imgUi();
  siteImgDraw();
  updateLayerCounts(site);
  setStatus(r.src ? `Aerial imagery: ${r.src.label}${imgDetailNote(site)}.` : 'No imagery service returned photos for this site.', !r.src);
}
function imgSetChoice(id) {
  imgChoice.id = id;
  try { localStorage.setItem('c2r-imgsrc', imgChoice.id); } catch { /* ignore */ }
  imgUi();
  if (imgChoice.id !== 'custom' || customSource(imgChoice.custom)) refreshImagery();
}
$('img-src').addEventListener('change', e => imgSetChoice(e.target.value));
$('img-table').addEventListener('click', e => { const b = e.target.closest('[data-imguse]'); if (b) imgSetChoice(b.dataset.imguse); });
for (const r of document.querySelectorAll('input[name="img-prefer"]')) {
  r.addEventListener('change', () => {
    imgChoice.prefer = r.value === 'new' ? 'new' : 'sharp';
    try { localStorage.setItem('c2r-imgprefer', imgChoice.prefer); } catch { /* ignore */ }
    refreshImagery();
  });
}
$('img-states').addEventListener('change', () => {
  imgChoice.states = [...$('img-states').querySelectorAll('input:checked')].map(c => c.value);
  try { localStorage.setItem('c2r-imgstates', JSON.stringify(imgChoice.states)); } catch { /* ignore */ }
  refreshImagery();
});
$('img-recheck').addEventListener('click', () => {
  const site = state.result;
  if (!site) return;
  probeForget(site.zone, site.box);
  refreshImagery();
});
$('img-custom').addEventListener('change', e => {
  const v = e.target.value.trim();
  if (v && !customSource(v)) { $('img-custom-msg').textContent = 'Paste an ArcGIS address ending in /MapServer or /ImageServer (https).'; return; }
  $('img-custom-msg').textContent = '';
  imgChoice.custom = v;
  try { localStorage.setItem('c2r-imgcustom', v); } catch { /* ignore */ }
  refreshImagery();
});
imgUi();

// ---------- 3D view ----------
// three.js is only downloaded the first time the 3D tab is opened.
var v3 = null, v3Loading = null, v3Timer = 0, v3ExistSegs = null;
const v3Design = () => { const site = state.result; return site && dz.site === site && dz.design?.changed ? dz.design : null; };
const v3Surf = () => (document.querySelector('input[name="v3s"]:checked')?.value === 'exist' || !v3Design() ? 'exist' : 'prop');

async function v3Open() {
  if (!state.result) return;
  if (!v3) {
    const msg = $('v3-msg');
    msg.hidden = false; msg.textContent = 'Loading the 3D viewer…';
    try {
      v3Loading = v3Loading || import(`./view3d.js?v=${VERSION}`);
      const m = await v3Loading;
      if (!v3) { v3 = new m.SiteView3D($('v3-stage')); v3.setExaggeration(Number($('v3-ex').value)); v3.setSpeed(Number($('v3-speed').value)); }
      msg.hidden = true;
    } catch (e) {
      console.error(e);
      msg.textContent = 'The 3D view could not start — this browser may have WebGL turned off.';
      return;
    }
  }
  if (curView() !== '3d') return;
  v3.show(true);
  v3Build();
  sketch.attach3d(v3);          // the sketch toolbar and tools carry on in 3D
  flowKick();
}

function v3Dirty() {
  if (!v3 || curView() !== '3d') return;
  clearTimeout(v3Timer);
  v3Timer = setTimeout(() => { v3Build(); flowKick(); }, 120);
}

function v3Build(resetView = false) {
  const site = state.result;
  if (!v3 || !site) return;
  const des = v3Design();
  const seg = $('v3-surf');
  seg.hidden = !des; // nothing to compare until the site design has changes
  const prop = v3Surf() === 'prop';
  if (!prop && (!v3ExistSegs || v3ExistSegs.site !== site)) {
    v3ExistSegs = { site, ...contourSegments(site.grid, contourLevels(site.stats.min, site.stats.max, site.interval), L => isMajor(L, site.interval)) };
  }
  let segs = prop ? dz.prop : v3ExistSegs;
  if (prop && dz.contourVer !== des.version) {
    const pg = des.grid();
    segs = contourSegments(pg, dzLevels(pg), L => isMajor(L, site.interval));
  }
  const fresh = v3.site !== site;
  v3.setSurface({
    g: site.grid, z: prop ? des.z : site.grid.z, delta: prop && dz.showCf ? des.delta : null, box: site.box, k: site.toOut,
    image: v3Texture(site), cutFillScale: dz.site === site ? dzScale() : 5, major: visibility.contours ? segs?.major : null, majorLv: segs?.majorLv,
    resetZ: fresh, resetView: fresh || resetView,
  });
  v3.site = site;
  v3.setFeatures(prop ? v3Features(des, site) : []);
  const vb = v3Buildings(site);
  v3.setBuildings(vb, { keys: vb.keys, colors: vb.colors });
  v3.setSketch(sketch.tris(v3.ex || 1), sketch.parking3d());
  v3.setDiagram(dz.mode === 'diagram');
  const dgC = sketch.dgColors();
  v3.setTrees(visibility.trees ? site.context?.trees : null, { base: dgC.tree, paint: t => dgC.painted('t', treeKey(t)) });
  v3.setNotes(sketch.notes3d());
  sunApply3d();
}

/** Ground image for the 3D view: the aerial plus the map layers that are switched on (cached per site + layers). */
let v3Tex = null;
function v3Texture(site) {
  if (!site.imagery) return null;
  const fade = dz.mode === 'diagram' ? dg.fade : 0;
  const key = JSON.stringify([vis(), fade]);
  if (v3Tex && v3Tex.site === site && v3Tex.key === key) return v3Tex.canvas;
  const c = document.createElement('canvas');
  c.width = site.imagery.width; c.height = site.imagery.height;
  drawMap(c, { ...site, tinted: false, vis: vis() }, 'texture');
  if (fade) { const g = c.getContext('2d'); g.fillStyle = `rgba(250,250,247,${fade})`; g.fillRect(0, 0, c.width, c.height); }   // diagram: fade toward white
  v3Tex = { site, key, canvas: c };
  return c;
}

/** Massing of the building layers shown on the map, as triangles (lidar roofs where measured). Heights are kept at
 *  true scale on the exaggerated ground, so the vertical exaggeration doesn't stretch the buildings. */
function v3Buildings(site, exOverride) {
  const ex = exOverride || v3?.ex || 1;
  const out = [], keys = [], cols = [], dgOn = sketch.diagram, C = dgOn && sketch.dgColors();
  for (const src of BUILDING_SOURCES) {
    if (!visibility[src.key]) continue;
    const list = src.key === 'buildings' ? site.context?.buildings : site.context?.[src.key];
    for (const b of list || []) {
      const n0 = out.length;
      if (b.mass) {
        for (const fc of b.mass.f) for (let t = 1; t + 1 < fc.length; t++) out.push(...b.mass.v[fc[0]], ...b.mass.v[fc[t]], ...b.mass.v[fc[t + 1]]);
      } else {
        const R = b.wall?.ring || b.ring, n = R?.length;
        if (!R || n < 3) continue;
        const tz = i => (b.wall ? b.wall.top[i] : b.ringTop ? b.ringTop[i] : b.top);
        for (let i = 0; i < n; i++) {
          const i2 = (i + 1) % n, [x0, y0] = R[i], [x1, y1] = R[i2];
          out.push(x0, y0, b.base, x1, y1, b.base, x1, y1, tz(i2), x0, y0, b.base, x1, y1, tz(i2), x0, y0, tz(i));
        }
        if (b.roof) for (const t of b.roof.tris) for (const q of t) out.push(...b.roof.pts[q]);
        else for (const t of triangulate(R)) for (const q of t) out.push(R[q][0], R[q][1], b.top);
      }
      // True-scale height above this building's base (the view multiplies every height by the exaggeration).
      if (ex !== 1) for (let i = n0 + 2; i < out.length; i += 3) out[i] = b.base + (out[i] - b.base) / ex;
      const key = bldgKey(b), fill = dgOn ? C.fill('b', key) : null;
      for (let i = n0; i < out.length; i += 9) { keys.push(key); if (dgOn) cols.push(fill); }
    }
  }
  out.keys = keys; out.colors = dgOn ? cols : null;
  return out;
}

/** Design features for the 3D view: walls as panels, everything else as lines draped on the proposed grade. */
function v3Features(des, site) {
  const g = site.grid, k = site.toOut;
  const zAt = (x, y) => {
    const fx = (x - g.x0) / g.s, fy = (y - g.y0) / g.s, i = Math.max(0, Math.min(g.nx - 2, Math.floor(fx))), j = Math.max(0, Math.min(g.ny - 2, Math.floor(fy)));
    const tx = Math.max(0, Math.min(1, fx - i)), ty = Math.max(0, Math.min(1, fy - j)), q = j * g.nx + i, z = des.z;
    return (z[q] * (1 - tx) + z[q + 1] * tx) * (1 - ty) + (z[q + g.nx] * (1 - tx) + z[q + g.nx + 1] * tx) * ty;
  };
  const dense = (pts, step) => {
    const out = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay] = pts[i - 1], [bx, by] = pts[i], n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
      for (let t = 1; t <= n; t++) out.push([ax + (bx - ax) * t / n, ay + (by - ay) * t / n]);
    }
    return out;
  };
  const items = [];
  for (const f of des.features) {
    const path = featPath(f);
    if (!path?.length) continue;
    if (f.type === 'wall') {
      const pts = dense(path, g.s), half = (Number(f.p.thick) || 1) / 2 / k + g.s;
      const bot = [], top = [];
      for (let i = 0; i < pts.length; i++) {
        const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
        const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, nx = -(b[1] - a[1]) / L, ny = (b[0] - a[0]) / L;
        const zs = [zAt(pts[i][0], pts[i][1]), zAt(pts[i][0] + nx * half, pts[i][1] + ny * half), zAt(pts[i][0] - nx * half, pts[i][1] - ny * half)].filter(Number.isFinite);
        if (!zs.length) continue;
        bot.push([pts[i][0], pts[i][1], Math.min(...zs)]);
        top.push([pts[i][0], pts[i][1], Math.max(...zs)]);
      }
      if (bot.length > 1) items.push({ kind: 'wall', pts: bot, top });
    } else if (f.type === 'pad') {
      const el = f.out?.elev;
      items.push({ kind: 'line', closed: true, color: 0xffffff, pts: dense(path, g.s * 2).map(([x, y]) => [x, y, Number.isFinite(el) ? el : zAt(x, y)]) });
    } else {
      items.push({ kind: 'line', color: f.type === 'swale' ? 0x60a5fa : 0x22d3ee, pts: dense(path, g.s).map(([x, y]) => [x, y, zAt(x, y)]).filter(p => Number.isFinite(p[2])) });
    }
  }
  return items;
}

try { const ex = parseFloat(localStorage.getItem('c2r-v3ex')); if (ex >= 1 && ex <= 5) { $('v3-ex').value = String(ex); $('v3-ex-v').textContent = `${ex}×`; } } catch { /* ignore */ }
$('v3-ex').addEventListener('input', e => {
  $('v3-ex-v').textContent = `${e.target.value}×`;
  try { localStorage.setItem('c2r-v3ex', e.target.value); } catch { /* ignore */ }
  if (v3) { v3.setExaggeration(Number(e.target.value)); v3Build(); }
});
document.querySelectorAll('input[name="v3s"]').forEach(r => r.addEventListener('change', () => { v3Build(); flowKick(); }));
$('v3-reset').addEventListener('click', () => v3?.resetView());
try { const sp = parseFloat(localStorage.getItem('c2r-v3speed')); if (sp >= 0.2 && sp <= 2) { $('v3-speed').value = String(sp); $('v3-speed-v').textContent = `${sp}×`; } } catch { /* ignore */ }
$('v3-speed').addEventListener('input', e => {
  $('v3-speed-v').textContent = `${e.target.value}×`;
  v3?.setSpeed(Number(e.target.value));
  try { localStorage.setItem('c2r-v3speed', e.target.value); } catch { /* ignore */ }
});

// ---------- Water flow ----------
// Particles follow the steepest-descent direction of the surface (proposed grade in Site design, otherwise existing),
// leaving short fading streaks; low spots that would hold water are circled.
var flow = { on: false, f: null, site: null, z: null, ver: -1, t: 0, raf: 0, M: null };
var flowCanvas = document.createElement('canvas');
flowCanvas.className = 'flow-canvas';
flowCanvas.hidden = true;
map.getContainer().appendChild(flowCanvas);

function flowSurface() {
  const site = state.result, des = site && dz.site === site ? dz.design : null;
  const useProp = curView() === '3d' ? v3Surf() === 'prop' : dz.mode === 'design' && des;
  return useProp && des ? { z: des.z, ver: des.version, prop: true } : { z: site.grid.z, ver: -1, prop: false };
}

/** Keep the Flow object in step with the site and the surface being shown. */
function flowSync() {
  const site = state.result;
  if (!site) { flow.f = null; return null; }
  const s = flowSurface(), now = performance.now();
  if (!flow.f || flow.site !== site) {
    flow.f = new Flow(site.grid, s.z, site.toOut);
    flow.f.speed = flowSpeed();
    flow.f.seed(Math.round(Math.max(600, Math.min(5000, site.grid.nx * site.grid.ny / 18))));
    flow.site = site; flow.z = s.z; flow.ver = s.ver; flow.t = now; flow.prop = s.prop;
    flowNote();
  } else if (flow.z !== s.z || (flow.ver !== s.ver && now - flow.t > 250)) {
    flow.f.setSurface(s.z);
    flow.z = s.z; flow.ver = s.ver; flow.t = now; flow.prop = s.prop;
    flowNote();
  }
  return flow.f;
}
const flowSinks = () => flow.f?.sinks(flow.site?.units === 'm' ? 0.05 : 0.15) || [];
function flowNote() {
  const n = flowSinks().length;
  $('flow-note').textContent = `${flow.prop ? 'Proposed' : 'Existing'} grade · ${n ? `${n} low spot${n === 1 ? '' : 's'}` : 'no low spots'}`;
}

function flowSet(on) {
  flow.on = on;
  $('flow-toggle').setAttribute('aria-pressed', String(on));
  $('flow-legend').hidden = !on;
  $('set-flow').checked = on;
  try { localStorage.setItem('c2r-flow', on ? '1' : ''); } catch { /* ignore */ }
  flowKick();
}
$('flow-toggle').addEventListener('click', () => { if (state.result) flowSet(!flow.on); });

/** Start / stop whichever animation fits the current view. */
function flowKick() {
  const view = curView();
  const map2d = flow.on && !!state.result && view === 'map';
  flowCanvas.hidden = !map2d;
  if (!map2d) { cancelAnimationFrame(flow.raf); flow.raf = 0; flowClear(); }
  else if (!flow.raf) { flow.M = null; flow.raf = requestAnimationFrame(flowFrame); }
  if (v3) {
    const f = flow.on && view === '3d' && state.result ? flowSync() : null;
    v3.setFlow(f, f ? flowSinks() : null);
  }
  sunKick();
  windKick();
}
function flowClear() { flowCanvas.getContext('2d').clearRect(0, 0, flowCanvas.width, flowCanvas.height); }

function flowFrame() {
  flow.raf = 0;
  const site = state.result;
  if (!flow.on || !site || curView() !== 'map') { flowClear(); return; }
  const f = flowSync();
  const cont = map.getContainer(), dpr = window.devicePixelRatio || 1;
  const W = Math.round(cont.clientWidth * dpr), H = Math.round(cont.clientHeight * dpr);
  if (flowCanvas.width !== W || flowCanvas.height !== H) {
    flowCanvas.width = W; flowCanvas.height = H;
    flowCanvas.style.width = cont.clientWidth + 'px'; flowCanvas.style.height = cont.clientHeight + 'px';
  }
  if (!flow.M) flow.M = dzAffine(site);
  const M = flow.M, ctx = flowCanvas.getContext('2d');
  // Fade the previous frame so each particle leaves a short tapering streak.
  ctx.globalCompositeOperation = 'destination-out';
  ctx.fillStyle = 'rgba(0,0,0,0.045)'; // slow fade = long trails
  ctx.fillRect(0, 0, W, H);
  ctx.globalCompositeOperation = 'source-over';
  f.step();
  ctx.strokeStyle = 'rgba(125,211,252,0.95)';
  ctx.lineWidth = 1.7 * dpr;
  ctx.lineCap = 'round';
  ctx.beginPath();
  for (let p = 0; p < f.n; p++) {
    if (f.age[p] < 2) continue;
    const [ax, ay] = toScreen(M, f.ox[p], f.oy[p]), [bx, by] = toScreen(M, f.px[p], f.py[p]);
    ctx.moveTo(ax * dpr, ay * dpr); ctx.lineTo(bx * dpr, by * dpr);
  }
  ctx.stroke();
  // Ponding spots (redrawn every frame so they stay solid through the fade).
  const px = M.scale * dpr;
  for (const s of flowSinks()) {
    const [x, y] = toScreen(M, s.x, s.y);
    const r = Math.max(5 * dpr, Math.min(40 * dpr, (1.5 + Math.min(4, s.depth) * 2) * site.grid.s * px));
    ctx.beginPath(); ctx.arc(x * dpr, y * dpr, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(37,99,235,0.08)'; ctx.fill();
    ctx.strokeStyle = 'rgba(147,197,253,0.9)'; ctx.lineWidth = 1.5 * dpr; ctx.stroke();
  }
  flow.raf = requestAnimationFrame(flowFrame);
}
map.on('move zoom resize viewreset', () => { if (flow.on) { flow.M = null; flowClear(); } });
try { if (localStorage.getItem('c2r-flow')) flow.on = true; } catch { /* ignore */ }
if (flow.on) { $('flow-toggle').setAttribute('aria-pressed', 'true'); $('flow-legend').hidden = false; $('set-flow').checked = true; }
$('set-flow').addEventListener('change', e => flowSet(e.target.checked));
function flowSpeed() { return Number($('flow-speed').value) || 1; }
try { const v = parseFloat(localStorage.getItem('c2r-flowspeed')); if (v >= 0.25 && v <= 3) $('flow-speed').value = String(v); } catch { /* ignore */ }
$('flow-speed-v').textContent = `${flowSpeed()}×`;
$('flow-speed').addEventListener('input', e => {
  $('flow-speed-v').textContent = `${e.target.value}×`;
  if (flow.f) flow.f.speed = flowSpeed();
  try { localStorage.setItem('c2r-flowspeed', e.target.value); } catch { /* ignore */ }
});


// ---------- Sun (view only) ----------
// Shadows at a chosen moment (3D: real cast shadows; map: shade drawn over the site) or hours of direct sun over the
// chosen day (3D: ground and buildings coloured; map: heat over the site). Ground and building masses only.
// Height raster for shadows: up to this many cells per side (~3 ft cells up to ~1 mile across).
const SUN_RASTER = 1800;
var sunS = { on: false, mode: 'time', R: null, Rkey: '', hours: null, hKey: '', busy: 0, play: 0, msg: '' };
map.createPane('sunImg').style.zIndex = 255;
const sunCanvas = L.DomUtil.create('canvas', 'sun-canvas', map.getPane('sunImg'));
sunCanvas.style.pointerEvents = 'none';
const pad2 = n => String(n).padStart(2, '0');
const dateStr = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const fmtClock = d => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
$('sun-date').value = dateStr(new Date());
function sunWhen() {
  const [y, m, d] = ($('sun-date').value || dateStr(new Date())).split('-').map(Number), min = Number($('sun-time').value);
  return new Date(y, m - 1, d, Math.floor(min / 60), min % 60);
}
function sunBuildings(site) {
  const out = [...sketch.buildings()];
  // Trees as solid crowns (a dome from the crown base up to the top) — real canopies let some light through.
  if (visibility.trees) for (const t of site.context?.trees || []) {
    const base = t.z + t.h * 0.38, half = t.h * 0.62;
    out.push({ ring: [[t.x - t.r, t.y - t.r], [t.x + t.r, t.y - t.r], [t.x + t.r, t.y + t.r], [t.x - t.r, t.y + t.r]], base: t.z, top: t.z + t.h, tree: true,
      roofAt: (x, y) => { const d2 = ((x - t.x) ** 2 + (y - t.y) ** 2) / (t.r * t.r); return d2 > 1 ? NaN : base + half * Math.sqrt(1 - d2); } });
  }
  for (const src of BUILDING_SOURCES) {
    if (!visibility[src.key]) continue;
    for (const b of (src.key === 'buildings' ? site.context?.buildings : site.context?.[src.key]) || []) out.push(b);
  }
  return out;
}
/** Height raster of ground + visible buildings for the current site (cached per site, layers and size). */
function sunRaster(site, maxSide) {
  const key = `${maxSide}|${BUILDING_SOURCES.map(b => (visibility[b.key] ? 1 : 0)).join('')}|${visibility.trees ? 1 : 0}|${site.generated?.getTime()}|${sketch.version}`;
  if (sunS.R && sunS.Rsite === site && sunS.Rkey === key) return sunS.R;
  sunS.R = heightRaster(site, sunBuildings(site), maxSide); sunS.Rsite = site; sunS.Rkey = key;
  return sunS.R;
}
function sunSet(on) {
  sunS.on = on;
  $('sun-toggle').setAttribute('aria-pressed', String(on));
  $('sun-panel').hidden = !on;
  if (!on) sunStop();
  sunKick();
}
$('sun-toggle').addEventListener('click', () => { if (state.result) sunSet(!sunS.on); });
function sunStop() { clearInterval(sunS.play); sunS.play = 0; $('sun-play').textContent = '▶'; }
function sunReadout() {
  const site = state.result;
  if (!site) return;
  const when = sunWhen(), { lat, lng } = site.center;
  const p = sunPosition(when, lat, lng), t = sunTimes(when, lat, lng);
  $('sun-time-v').textContent = fmtClock(when);
  const rs = t.rise && t.set ? `sunrise ${fmtClock(t.rise)}, sunset ${fmtClock(t.set)}` : '';
  $('sun-read').textContent = sunS.mode === 'hours' ? rs
    : p.alt > 0 ? `${Math.round(p.alt)}° up, from the ${compass(p.az)} (${Math.round(p.az)}°) · ${rs}` : `below the horizon · ${rs}`;
}
/** Image for the map: shade (time) or sun-hour heat (hours), one pixel per evaluated cell (grid nx × ny). */
function sunImage(gr, vals, mode, max) {
  const c = document.createElement('canvas'); c.width = gr.nx; c.height = gr.ny;
  const g = c.getContext('2d'), img = g.createImageData(gr.nx, gr.ny), d = img.data;
  for (let j = 0; j < gr.ny; j++) for (let i = 0; i < gr.nx; i++) {
    const q = j * gr.nx + i, o = ((gr.ny - 1 - j) * gr.nx + i) * 4;
    if (mode === 'time') { if (!vals[q]) { d[o] = 12; d[o + 1] = 18; d[o + 2] = 38; d[o + 3] = 125; } }
    else { const [r, gg, b] = hoursColor(vals[q] / (max || 1)); d[o] = r * 255; d[o + 1] = gg * 255; d[o + 2] = b * 255; d[o + 3] = 170; }
  }
  g.putImageData(img, 0, 0);
  return c;
}
function sunMapDraw() {
  const site = state.result, ctx = sunCanvas.getContext('2d');
  const cont = map.getContainer(), dpr = window.devicePixelRatio || 1, W = cont.clientWidth, H = cont.clientHeight;
  if (sunCanvas.width !== Math.round(W * dpr) || sunCanvas.height !== Math.round(H * dpr)) {
    sunCanvas.width = Math.round(W * dpr); sunCanvas.height = Math.round(H * dpr);
    sunCanvas.style.width = W + 'px'; sunCanvas.style.height = H + 'px';
  }
  L.DomUtil.setPosition(sunCanvas, map.containerPointToLayerPoint([0, 0]));
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, sunCanvas.width, sunCanvas.height);
  const im = sunS.img;
  if (!sunS.on || !site || !im || im.site !== site || curView() !== 'map') return;
  const M = dzAffine(site), R = im.R, s2 = R.s * (im.stride || 1), rows = im.canvas.height;
  ctx.save();
  if (site.mask) { ctx.beginPath(); site.mask.forEach(([x, y], i) => { const [sx, sy] = toScreen(M, x, y); ctx[i ? 'lineTo' : 'moveTo'](sx * dpr, sy * dpr); }); ctx.closePath(); ctx.clip(); }
  const x0 = R.x0 - s2 / 2, y1 = R.y0 + (rows - 1) * s2 + s2 / 2;
  ctx.setTransform(dpr * M.a * s2, dpr * M.b * s2, -dpr * M.c * s2, -dpr * M.d * s2, dpr * (M.a * x0 + M.c * y1 + M.e), dpr * (M.b * x0 + M.d * y1 + M.f));
  ctx.imageSmoothingEnabled = im.mode === 'hours';
  ctx.drawImage(im.canvas, 0, 0);
  ctx.restore();
}
map.on('moveend zoomend resize viewreset', () => { if (sunS.on) sunMapDraw(); });
map.on('zoomstart', () => { sunCanvas.style.visibility = 'hidden'; });
map.on('zoomend', () => { sunCanvas.style.visibility = ''; });

/** Scene direction toward the sun (x east, y up, z −north, grid axes) for the 3D view. */
function sunDir3d(site, p) {
  const a = (p.az + (site.convergence || 0)) * Math.PI / 180, h = Math.max(0.5, p.alt) * Math.PI / 180;
  return [Math.sin(a) * Math.cos(h), Math.sin(h), -Math.cos(a) * Math.cos(h)];
}
function sunApply3d() {
  if (!v3) return;
  const site = state.result;
  if (!sunS.on || !site || curView() !== '3d') { if (v3.sunMode && v3.sunMode !== 'off') { const was = v3.sunMode; v3.setSun('off'); if (was === 'hours' && site) setTimeout(() => v3Build(), 0); } return; }
  if (sunS.mode === 'time') {
    const was = v3.sunMode;
    const p = sunPosition(sunWhen(), site.center.lat, site.center.lng);
    v3.setSun('time', { dir: sunDir3d(site, p), alt: p.alt });
    if (was === 'hours') setTimeout(() => v3Build(), 0);            // put the aerial colours back on the ground and buildings
  } else if (sunS.hours && sunS.hours.site === site && sunS.hours.key === sunHoursKey(site)) {
    const H = sunS.hours, R = H.R, res = H.res, st = res.stride, max = res.hoursMax || 1;
    const colorAt = (x, y) => {
      const i = Math.round((x - R.x0) / (R.s * st)), j = Math.round((y - R.y0) / (R.s * st));
      return hoursColor(i < 0 || j < 0 || i >= res.nx || j >= res.ny ? 0 : res.cells[j * res.nx + i] / max);
    };
    const col = new Float32Array(res.pts.length * 3);
    res.pts.forEach((h, v) => { const c = hoursColor(h / max); col[v * 3] = c[0]; col[v * 3 + 1] = c[1]; col[v * 3 + 2] = c[2]; });
    v3.setSun('hours', { colorAt, surf: { S: H.surf.S, idx: H.surf.idx, col } });
  } else v3.setSun('off');
}
const sunHoursKey = site => `${$('sun-date').value}|${BUILDING_SOURCES.map(b => (visibility[b.key] ? 1 : 0)).join('')}|${visibility.trees ? 1 : 0}|${site.generated?.getTime()}|${v3?.ex || 1}|${sketch.version}`;
async function sunComputeHours(site) {
  const key = sunHoursKey(site);
  if (sunS.hours && sunS.hours.site === site && sunS.hours.key === key) return true;
  const seq = ++sunS.busy;
  const R = sunRaster(site, SUN_RASTER);
  const skT = sketch.tris(1).tris, skS = sketch.tris(v3?.ex || 1).tris;
  const surf = surfaceSamples([...v3Buildings(site, 1), ...skT], [...v3Buildings(site), ...skS], site.toOut);
  const t0 = performance.now();
  $('sun-msg').textContent = 'Working out the sun hours…';
  const res = await sunHours(R, surf, sunWhen(), site, {
    stepMin: 20, stride: strideFor(R, 90000), isStale: () => seq !== sunS.busy || !sunS.on || sunS.mode !== 'hours' || state.result !== site,
    onProgress: f => { $('sun-msg').textContent = `Working out the sun hours… ${Math.round(f * 100)} %`; },
  });
  if (!res) return false;
  sunS.hours = { site, key, R, res, surf };
  $('sun-msg').textContent = `${res.steps} sun positions, every 20 min from sunrise to sunset · ${surf.n.toLocaleString()} points on roofs and walls, about ${surf.d.toFixed(1)} ${site.zone.unit === 'm' ? 'm' : 'ft'} apart · ${((performance.now() - t0) / 1000).toFixed(1)} s.`;
  return true;
}
async function sunKick() {
  const site = state.result;
  $('sun-time-row').hidden = sunS.mode === 'hours';
  $('sun-legend').hidden = sunS.mode !== 'hours';
  if (!sunS.on || !site) { sunS.img = null; sunMapDraw(); sunApply3d(); return; }
  sunReadout();
  const view = curView();
  if (sunS.mode === 'time') {
    $('sun-msg').textContent = '';
    if (view === 'map') {
      const p = sunPosition(sunWhen(), site.center.lat, site.center.lng);
      const R = sunRaster(site, SUN_RASTER);
      const gr = shadeRaster(R, sunVector(p, site.convergence || 0, site.toOut), strideFor(R, 160000));
      sunS.img = { site, R, mode: 'time', stride: gr.stride, canvas: sunImage(gr, gr.lit, 'time') };
      sunMapDraw();
    } else sunMapDraw();
    sunApply3d();
  } else {
    const seq = sunS.busy;
    const ok = await sunComputeHours(site);
    if (!ok || state.result !== site || !sunS.on || sunS.mode !== 'hours' || (seq !== sunS.busy && sunS.hours?.key !== sunHoursKey(site))) return;
    const H = sunS.hours, max = H.res.hoursMax || 1;
    $('sun-legend-max').textContent = `${max.toFixed(1)} h (sunrise to sunset)`;
    sunS.img = { site, R: H.R, mode: 'hours', stride: H.res.stride, canvas: sunImage(H.res, H.res.cells, 'hours', max) };
    sunMapDraw();
    sunApply3d();
  }
}
let sunT = 0;
const sunLater = () => { clearTimeout(sunT); sunT = setTimeout(sunKick, 60); };
$('sun-time').addEventListener('input', () => { sunReadout(); sunLater(); });
$('sun-date').addEventListener('change', sunLater);
document.querySelectorAll('[data-sd]').forEach(b => b.addEventListener('click', () => { $('sun-date').value = `${sunWhen().getFullYear()}-${b.dataset.sd}`; sunLater(); }));
document.querySelectorAll('input[name="sun-mode"]').forEach(r => r.addEventListener('change', () => { sunS.mode = r.value; sunStop(); sunKick(); }));
$('sun-play').addEventListener('click', () => {
  if (sunS.play) { sunStop(); return; }
  const site = state.result;
  if (!site) return;
  $('sun-play').textContent = '❚❚';
  sunS.play = setInterval(() => {
    const t = sunTimes(sunWhen(), site.center.lat, site.center.lng), el = $('sun-time');
    const lo = t.rise ? t.rise.getHours() * 60 + t.rise.getMinutes() - 20 : 300, hi = t.set ? t.set.getHours() * 60 + t.set.getMinutes() + 20 : 1200;
    let v = Number(el.value) + 10;
    if (v > hi || v < lo) v = Math.max(Number(el.min), lo);
    el.value = String(v);
    sunReadout();
    sunKick();
  }, curView() === '3d' ? 120 : 220);
});

document.querySelectorAll('.env-title').forEach(b => b.addEventListener('click', () => b.closest('.env-panel').classList.toggle('collapsed')));

// ---------- Wind (view only) ----------
// A wind rose from the nearest NOAA station's last five years of hourly observations, and streaks that drift
// across the site with directions and speeds drawn from it.
var windS = { on: false, rose: null, site: null, err: '', loading: false, field: null, raf: 0, M: null };
var windCanvas = document.createElement('canvas');
windCanvas.className = 'wind-canvas';
windCanvas.hidden = true;
map.getContainer().appendChild(windCanvas);
function windSet(on) {
  windS.on = on;
  $('wind-toggle').setAttribute('aria-pressed', String(on));
  $('wind-panel').hidden = !on;
  windKick();
}
$('wind-toggle').addEventListener('click', () => { if (state.result) windSet(!windS.on); });
const windCtl = () => { $('wind-hour').disabled = $('wind-allday').checked; $('wind-thr-row').hidden = windShow() !== 'thr'; windRefresh(); };
const windShow = () => document.querySelector('input[name="wind-show"]:checked')?.value || 'prev';
const windHour = () => ($('wind-allday').checked ? null : Number($('wind-hour').value));
const fmtHour = h => `${(h % 12) || 12} ${h < 12 ? 'am' : 'pm'}`;
$('wind-season').addEventListener('change', windCtl);
$('wind-allday').addEventListener('change', windCtl);
$('wind-hour').addEventListener('input', windCtl);
$('wind-thr').addEventListener('input', windCtl);
document.querySelectorAll('input[name="wind-show"]').forEach(r => r.addEventListener('change', windCtl));
/** Colour for a direction's share of hours between the cutoff and the most common direction (light blue → orange). */
function windRamp(t) {
  const st = [[0, [0.576, 0.773, 0.992]], [0.5, [0.992, 0.878, 0.278]], [1, [0.976, 0.451, 0.086]]];
  t = Math.max(0, Math.min(1, t));
  const i = t <= 0.5 ? 1 : 2, [a, ca] = st[i - 1], [b, cb] = st[i], u = (t - a) / (b - a);
  return [ca[0] + (cb[0] - ca[0]) * u, ca[1] + (cb[1] - ca[1]) * u, ca[2] + (cb[2] - ca[2]) * u];
}
const rgbCss = c => `rgb(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)})`;
/** What to draw for the current season / hour / mode: the summary and the flows for the streaks. */
function windState() {
  const r = windS.rose;
  if (!r) return null;
  const s = r.seasons[$('wind-season').value] || r.seasons.all, sum = roseSummary(s, windHour());
  const mx = Math.max(...sum.frac), thr = Number($('wind-thr').value) / 100;
  const cols = sum.frac.map(f => (windShow() === 'prev' ? null : f >= thr ? windRamp(mx > thr ? (f - thr) / (mx - thr) : 1) : null));
  const flows = windShow() === 'prev'
    ? (sum.frac[sum.prevailing] > 0 ? [{ from: sum.prevailing * 22.5, w: 1, v: sum.spd[sum.prevailing], color: [0.95, 0.97, 1] }] : [])
    : sum.frac.map((f, i) => (cols[i] ? { from: i * 22.5, w: f, v: sum.spd[i], color: cols[i] } : null)).filter(Boolean);
  return { sum, mx, thr, cols, flows };
}
function windRefresh() {
  const ws = windState();
  if (windS.field && ws) windS.field.setFlows(ws.flows);
  windPanel();
}
const windMph = site => (site?.outUnit || 'ft') !== 'm';
const spd = (v, site) => windMph(site) ? `${Math.round(v * 2.23694)} mph` : `${v.toFixed(1)} m/s`;
function windPanel() {
  const site = state.result, r = windS.rose;
  const cv = $('wind-rose'), dpr = window.devicePixelRatio || 1;
  cv.width = 200 * dpr; cv.height = 200 * dpr;
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, 200, 200);
  $('wind-hour-v').textContent = windHour() == null ? 'all day' : fmtHour(windHour());
  $('wind-thr-v').textContent = `${$('wind-thr').value} %`;
  if (windS.loading || windS.err || !r) {
    $('wind-read').textContent = windS.err ? `Wind data not available: ${windS.err}` : windS.msg || 'Loading…';
    $('wind-src').textContent = ''; $('wind-key').innerHTML = '';
    return;
  }
  const { sum, mx, thr, cols } = windState();
  const cx = 100, cy = 102, R0 = 82, top = Math.max(mx, 0.01);
  const ring = top > 0.16 ? 0.05 : top > 0.08 ? 0.04 : 0.02;
  g.strokeStyle = 'rgba(255,255,255,0.14)'; g.fillStyle = '#9aa3a9'; g.font = '9px sans-serif'; g.lineWidth = 1;
  for (let f = ring; f <= top + 1e-9; f += ring) { g.beginPath(); g.arc(cx, cy, R0 * f / top, 0, Math.PI * 2); g.stroke(); g.fillText(`${Math.round(f * 100)}%`, cx + 2, cy - R0 * f / top + 9); }
  if (windShow() === 'thr' && thr < top) { g.setLineDash([3, 3]); g.strokeStyle = 'rgba(253,224,71,0.6)'; g.beginPath(); g.arc(cx, cy, R0 * thr / top, 0, Math.PI * 2); g.stroke(); g.setLineDash([]); }
  g.fillStyle = '#e7e4dd'; g.font = 'bold 11px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  [['N', 0], ['E', 90], ['S', 180], ['W', 270]].forEach(([t, a]) => { const q = a * Math.PI / 180; g.fillText(t, cx + Math.sin(q) * (R0 + 10), cy - Math.cos(q) * (R0 + 10)); });
  const w = Math.PI * 2 / 16 * 0.42;
  sum.frac.forEach((f, i) => {
    if (!f) return;
    const a = i * Math.PI / 8 - Math.PI / 2;
    g.beginPath(); g.moveTo(cx, cy); g.arc(cx, cy, f / top * R0, a - w, a + w); g.closePath();
    g.fillStyle = windShow() === 'prev' ? (i === sum.prevailing ? '#f1f5f9' : 'rgba(148,163,184,0.35)') : cols[i] ? rgbCss(cols[i]) : 'rgba(148,163,184,0.22)';
    g.fill();
  });
  const when = `${$('wind-season').selectedOptions[0].textContent.replace(/ \(.*\)/, '').toLowerCase()}${windHour() == null ? '' : `, around ${fmtHour(windHour())}`}`;
  if (windShow() === 'thr') {
    const shown = sum.frac.filter(f => f >= thr).length;
    $('wind-key').innerHTML = `<span>${$('wind-thr').value} %</span><i></i><span>${Math.round(mx * 100)} %</span>`;
    $('wind-read').textContent = shown
      ? `${shown} direction${shown === 1 ? '' : 's'} with at least ${$('wind-thr').value} % of hours (${when}) — colour shows how often. Calm ${Math.round(sum.calm * 100)} %.`
      : `No direction reaches ${$('wind-thr').value} % of hours (${when}). Lower the cutoff.`;
  } else {
    $('wind-key').innerHTML = '';
    $('wind-read').textContent = sum.frac[sum.prevailing] > 0
      ? `Prevailing from the ${sectorName(sum.prevailing)} — ${Math.round(sum.frac[sum.prevailing] * 100)} % of hours (${when}), averaging ${spd(sum.spd[sum.prevailing], site)} from there. Calm ${Math.round(sum.calm * 100)} %.`
      : `Calm (${when}).`;
  }
  const st = r.station;
  $('wind-src').textContent = `Petals point where the wind comes from; N is true north. ${st.name}${st.icao ? ` (${st.icao})` : ''}, ${st.km.toFixed(0)} km away · ${r.years[0]}–${r.years[1]}, ${r.n.toLocaleString()} hourly reports · ${WIND_CREDIT}. Hours in this computer's time zone. Station winds, ~10 m above open ground — buildings and trees change them locally.`;
}
async function windLoad(site) {
  windS.loading = true; windS.err = ''; windS.msg = 'Finding the nearest weather station…'; windPanel();
  try {
    const rose = await windRose(site.center.lat, site.center.lng, { onStatus: m => { windS.msg = m; windPanel(); } });
    if (state.result !== site) return;
    windS.rose = rose; windS.site = site; windS.field = null;
  } catch (e) { windS.err = e.message || String(e); windS.site = site; }
  windS.loading = false;
  windPanel();
  windKick();
}
function windKick() {
  const site = state.result, view = curView();
  const on = windS.on && !!site;
  if (on && windS.site !== site && !windS.loading) { windS.rose = null; windS.field = null; windLoad(site); }
  const ready = on && windS.rose && windS.site === site;
  if (ready && !windS.field) { windS.field = new WindField(site.box, site.convergence || 0); windS.field.setFlows(windState().flows); }
  const map2d = ready && view === 'map';
  windCanvas.hidden = !map2d;
  if (!map2d) { cancelAnimationFrame(windS.raf); windS.raf = 0; windCanvas.getContext('2d').clearRect(0, 0, windCanvas.width, windCanvas.height); }
  else if (!windS.raf) { windS.M = null; windS.raf = requestAnimationFrame(windFrame); }
  if (v3) {
    if (ready && view === '3d') {
      const g2 = site.grid, z = g2.z;
      const zAt = (x, y) => { const i = Math.round((x - g2.x0) / g2.s), j = Math.round((y - g2.y0) / g2.s); return i < 0 || j < 0 || i >= g2.nx || j >= g2.ny ? NaN : z[j * g2.nx + i]; };
      if (v3._windField !== windS.field) { v3.setWind(windS.field, zAt); v3._windField = windS.field; }
    } else if (v3._windField) { v3.setWind(null); v3._windField = null; }
  }
  if (on) windPanel();
}
function windFrame() {
  windS.raf = 0;
  const site = state.result, f = windS.field;
  if (!windS.on || !site || !f || curView() !== 'map') return;
  const cont = map.getContainer(), dpr = window.devicePixelRatio || 1;
  const W = Math.round(cont.clientWidth * dpr), H = Math.round(cont.clientHeight * dpr);
  if (windCanvas.width !== W || windCanvas.height !== H) {
    windCanvas.width = W; windCanvas.height = H;
    windCanvas.style.width = cont.clientWidth + 'px'; windCanvas.style.height = cont.clientHeight + 'px';
  }
  if (!windS.M) windS.M = dzAffine(site);
  const M = windS.M, ctx = windCanvas.getContext('2d');
  ctx.globalCompositeOperation = 'destination-out';
  ctx.fillStyle = 'rgba(0,0,0,0.08)';
  ctx.fillRect(0, 0, W, H);
  ctx.globalCompositeOperation = 'source-over';
  f.step();
  ctx.lineWidth = 1.5 * dpr; ctx.lineCap = 'round';
  f.flows.forEach((fl, fi) => {
    ctx.strokeStyle = rgbCss(fl.color);
    ctx.beginPath();
    for (let p = 0; p < f.n; p++) {
      if (f.fi[p] !== fi || f.age[p] < 2 || !f.inBox(p)) continue;
      const [ax, ay] = toScreen(M, f.ox[p], f.oy[p]), [bx, by] = toScreen(M, f.px[p], f.py[p]);
      ctx.moveTo(ax * dpr, ay * dpr); ctx.lineTo(bx * dpr, by * dpr);
    }
    ctx.stroke();
  });
  windS.raf = requestAnimationFrame(windFrame);
}
map.on('move zoom resize viewreset', () => { if (windS.on) { windS.M = null; windCanvas.getContext('2d').clearRect(0, 0, windCanvas.width, windCanvas.height); } });

// ---------- Revit plugin bridge (js/revit.js): only what it needs from here ----------
/** A site/design snapshot from a Revit model opened as a local project (one mirror project per model). */
async function projImport(snap, name, key) {
  if (!(await projAskSave('Then the site saved in the Revit model opens.'))) return false;
  await projLoadList();
  let meta = key ? PROJ.list.find(p => p.revitKey === key) : null;
  const now = new Date().toISOString();
  if (!meta) {
    meta = { id: `p${Date.now().toString(36)}`, name, created: now, updated: now, place: '', features: 0, revitKey: key || null };
    PROJ.list.unshift(meta);
  }
  meta.updated = now; meta.rect = snap.rect || null; meta.features = snap.summary?.features ?? 0;
  if (snap.rect) { const c = L.latLngBounds(snap.rect).getCenter(); meta.place = fmtLatLon(c.lat, c.lng); }
  const clean = { ...snap }; delete clean.savedAt; delete clean.app;
  // The brush layer travels as base64 text in the model (JSON can't hold a Float32Array).
  if (clean.design && typeof clean.design.brush === 'string') clean.design = { ...clean.design, brush: b64ToF32(clean.design.brush) };
  await idb.set(projDataKey(meta.id), clean).catch(() => {});
  await projStoreList();
  PROJ.dirty = false;
  await projOpen(meta.id);
  return true;
}

function originLL(site) {
  if (!site) return null;
  if (state.origin && $('local-origin').checked) return { ...state.origin };
  if (!site.originNative) return null;
  const [lon, lat] = projector(site.zone).inv(site.originNative);
  return { lat, lon, label: 'South-west corner of the site' };
}

let revitDesignLoading = null;
initRevit({
  version: VERSION,
  align,
  site: () => state.result,
  setStatus,
  outXY,
  datum: datumOf,
  revitValues,
  /** Aerial for Revit: at most 0.5 ft/px (finer images make Revit views slow); a coarser chosen resolution is kept. */
  aerial: async site => {
    const prev = aerialRes;
    if (!aerialRes || aerialRes < 0.5) aerialRes = 0.5;
    try { return await fetchAerialExport(site); } finally { aerialRes = prev; }
  },
  aerialExtent,
  makeDxf: site => makeDxf(site, vis()),
  makeNewDxf: site => makeNewDxf(site, vis()),
  prefix: () => (folder.prefix || 'site').replace(/[\\/:*?"<>|]+/g, '-'),
  snapshot: () => {
    const snap = projSnapshot();
    if (snap.design?.brush instanceof Float32Array) snap.design = { ...snap.design, brush: f32ToB64(snap.design.brush) };
    return snap;
  },
  openSnapshot: projImport,
  /** The site's design when it has changes (loads the saved design for this site the first time). */
  design: site => {
    if (!site) return null;
    if (dz.site !== site && !revitDesignLoading) revitDesignLoading = dzEnsure().finally(() => { revitDesignLoading = null; revitSiteChanged(); });
    return dz.site === site && dz.design?.changed ? dz.design : null;
  },
  /** The local origin as a point: picked origin, else the south-west corner (null when the local origin is off). */
  origin: site => (site && $('local-origin').checked ? originLL(site) : null),
  /** Turn the local origin on and make it a fixed point (so it can't move when the boundary changes). */
  fixOrigin: site => {
    if (!$('local-origin').checked) { $('local-origin').checked = true; saveSettings(); applyOrigin(); }
    if (!state.origin) { const o = originLL(site); if (o) { state.origin = o; session.set('origin', o); } }
    applyOrigin();
  },
  setPlacement: ({ origin, rot, datum, northRef }) => {
    if (origin) { state.origin = { lat: origin.lat, lon: origin.lon, label: origin.label || 'Origin from the Revit model' }; session.set('origin', state.origin); }
    $('local-origin').checked = true; saveSettings();
    align.rot = Math.round(normDeg(Number(rot) || 0) * 1e4) / 1e4;
    align.datum = datum ?? null; align.zeroAtOrigin = false; align.northRef = northRef || 'grid';
    saveAlign();
    $('rot-deg').value = String(align.rot); $('datum').value = align.datum != null ? String(align.datum) : '';
    applyOrigin();
    projTouch();
  },
  toNative: (site, ll) => projector(site.zone).fwd([ll.lon, ll.lat]),
  fromNative: (site, xy) => { const [lon, lat] = projector(site.zone).inv(xy); return { lat, lon }; },
  distanceToSite: (site, ll) => {
    const p = projector(site.zone), [x, y] = p.fwd([ll.lon, ll.lat]);
    const cx = (site.box.xmin + site.box.xmax) / 2, cy = (site.box.ymin + site.box.ymax) / 2;
    return Math.hypot(x - cx, y - cy) / (zoneUnitsPerMeter(site.zone) * 0.3048);
  },
  /** Buildings of the layers shown on the map: [{ b, src, tag }]. */
  buildings: site => BUILDING_SOURCES.filter(src => visibility[src.key]).flatMap(src =>
    ((src.key === 'buildings' ? site?.context?.buildings : site?.context?.[src.key]) || []).map(b => ({ b, src: src.short, tag: src.tag }))),
  triangulate,
  revealPlace: () => { const d = $('step-place'); d.open = true; d.scrollIntoView({ behavior: 'smooth', block: 'start' }); },
}).catch(err => console.error('Revit bridge:', err));

window.c2r = { state, map, makers: MAKERS, dz, get v3() { return v3; }, flow }; // for debugging in the console


// ---------- Interface: task colours, hover help, tool notes, settings drawer ----------
document.body.dataset.mode = dz.mode || 'existing';
initTips();
for (const [id, m] of [['sk-hint', 'sketch'], ['dg-hint', 'diagram'], ['tool-hint', 'design']]) coachFrom($(id), m);
{
  const pref = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : v === '1'; } catch { return d; } };
  const setPref = (k, v) => { try { localStorage.setItem(k, v ? '1' : '0'); } catch { /* ignore */ } };
  const apply = () => { document.body.classList.toggle('no-tips', !$('set-tips').checked); document.body.classList.toggle('no-coach', !$('set-coach').checked); };
  $('set-tips').checked = pref('c2r-tips', true); $('set-coach').checked = pref('c2r-coach', true); apply();
  $('set-tips').addEventListener('change', e => { setPref('c2r-tips', e.target.checked); apply(); });
  $('set-coach').addEventListener('change', e => { setPref('c2r-coach', e.target.checked); apply(); });
  // Interface style: 'legend' (painted backdrops, framed menus) or 'classic'.
  { let ui = 'legend'; try { ui = localStorage.getItem('c2r-ui') || 'legend'; } catch { /* ignore */ }
    $('set-ui').value = ui;
    $('set-ui').addEventListener('change', e => { document.body.classList.toggle('theme-legend', e.target.value === 'legend'); try { localStorage.setItem('c2r-ui', e.target.value); } catch { /* ignore */ } }); }
  const delay = v => { setTipDelay(v * 1000); $('set-tipdelay-v').textContent = `${v} s`; };
  { let v = 4; try { const x = Number(localStorage.getItem('c2r-tipdelay')); if (x >= 0.5 && x <= 6) v = x; } catch { /* ignore */ } $('set-tipdelay').value = String(v); delay(v); }
  $('set-tipdelay').addEventListener('input', e => { const v = Number(e.target.value); delay(v); try { localStorage.setItem('c2r-tipdelay', String(v)); } catch { /* ignore */ } });
  const drawer = $('settings');
  const showSec = sec => {
    drawer.querySelectorAll('.set-tab').forEach(t => t.classList.toggle('on', t.dataset.sec === sec));
    drawer.querySelectorAll('.set-sec').forEach(x => { x.hidden = x.dataset.sec !== sec; });
    try { localStorage.setItem('c2r-setsec', sec); } catch { /* ignore */ }
  };
  const modeSec = { existing: 'topo', design: 'design', sketch: 'sketch', diagram: 'sketch' };
  const openSettings = (sec, focus) => {
    drawer.hidden = false;
    let last = null; try { last = localStorage.getItem('c2r-setsec'); } catch { /* ignore */ }
    showSec(sec || last || modeSec[dz.mode] || 'general');
    if (focus) $(focus)?.scrollIntoView({ block: 'center' });
  };
  $('settings-open').addEventListener('click', () => (drawer.hidden ? openSettings() : (drawer.hidden = true)));
  $('settings-close').addEventListener('click', () => { drawer.hidden = true; });
  drawer.querySelector('.set-tabs').addEventListener('click', e => { const t = e.target.closest('.set-tab'); if (t) showSec(t.dataset.sec); });
  document.addEventListener('click', e => { const b = e.target.closest('[data-settings]'); if (b) openSettings(b.dataset.settings, b.dataset.focus); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !drawer.hidden && !e.defaultPrevented) drawer.hidden = true; });
}
