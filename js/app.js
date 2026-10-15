// Contours to Revit — UI and pipeline.
/* global L, JSZip */
import { ZONES, zoneByCode, zoneUnitsPerMeter, zoneUnitLabel, projector, detectZone, reverseGeocode, geocode, convergence } from './geo.js?v=0.16.0';
import { fetchElevation, sample } from './dem.js?v=0.16.0';
import { buildGrid, gridStats, smooth, contourLines, contourLevels, isMajor, labelPositions } from './contours.js?v=0.16.0';
import { Dxf } from './dxf.js?v=0.16.0';
import { Design, FEATURE_NAMES, contourSegments, designKey, f32ToB64, b64ToF32 } from './design.js?v=0.16.0';
import { drawMap, hillshade, formatElev } from './render.js?v=0.16.0';
import { fetchBuildings, fetchBuildingsMs, fetchBuildingsOsm, BUILDING_SOURCES, fetchArdotWidths, prepareWidths, fetchOsmAreas, prepareOsmAreas, hostedContextIndex, ctxIndexReset, fetchRoadsAny, prepareContext, triangulate, fetchParcels, fetchFlood, prepareOverlays, hatchPolygon, densify } from './context.js?v=0.16.0';

const VERSION = '0.16.0';
const MAX_POINTS_WARN = 50000;
const MAX_POINTS_HARD = 400000;
const ACRES_WARN = 640;
const ACRES_HARD = 3000;
const SQFT_PER_ACRE = 43560;

const OPTIONS = {
  ft: { spacing: [1, 3, 5, 10], spacingDefault: 5, interval: [1, 2, 5], intervalDefault: 2, label: 'ft', tick: '′' },
  m: { spacing: [0.5, 1, 1.5, 3], spacingDefault: 1.5, interval: [0.25, 0.5, 1, 2], intervalDefault: 0.5, label: 'm', tick: ' m' },
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
  set(v) { try { localStorage.setItem('c2r-settings', JSON.stringify(v)); } catch { /* ignore */ } },
};

// ---------- Map ----------
// Remembered per browser: last map view, site boundary and picked origin (survive a refresh).
const session = {
  get(k) { try { return JSON.parse(localStorage.getItem('c2r-' + k) || 'null'); } catch { return null; } },
  set(k, v) { try { if (v === null) localStorage.removeItem('c2r-' + k); else localStorage.setItem('c2r-' + k, JSON.stringify(v)); } catch { /* ignore */ } },
};
const savedView = session.get('view');
const map = L.map('map', { zoomControl: true, preferCanvas: true })
  .setView(savedView ? [savedView.lat, savedView.lng] : [34.7465, -92.2896], savedView ? savedView.zoom : 15);
map.on('moveend', () => { const c = map.getCenter(); session.set('view', { lat: c.lat, lng: c.lng, zoom: map.getZoom() }); });
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
  edit: { featureGroup: drawn, remove: true },
});
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
}
map.on('draw:editmove draw:editresize', () => onSiteChanged(false));
map.on(L.Draw.Event.DELETED, () => {
  state.rect = drawn.getLayers()[0] || null;
  saveRect();
  onSiteChanged(true);
});

$('draw-btn').addEventListener('click', () => {
  if (!rectDrawer) rectDrawer = new L.Draw.Rectangle(map, drawControl.options.draw.rectangle);
  rectDrawer.enable();
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
    zone: $('zone').value,
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
}

document.querySelectorAll('input[name="units"]').forEach(r => r.addEventListener('change', () => {
  fillUnitOptions(); onSiteChanged(false); saveSettings(); invalidate();
}));
$('local-origin').addEventListener('change', () => { saveSettings(); applyOrigin(); });
['spacing', 'interval', 'smooth'].forEach(id => $(id).addEventListener('change', () => {
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
  const nPts = (Math.floor(wOut / spacing) + 1) * (Math.floor(hOut / spacing) + 1);
  const sqft = (box.xmax - box.xmin) * (box.ymax - box.ymin) * (zone.unit === 'ft' ? 1 : (1200 / 3937 / 0.3048) ** 2);
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
  const pStats = gridStats(pts);

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
  const cStats = gridStats(cgrid);
  const levels = contourLevels(cStats.min, cStats.max, interval);
  const contours = contourLines(cgrid, levels);

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

  setStatus('Fetching aerial imagery for the map…');
  const { bitmap: imagery, credit: imageryCredit } = await fetchImagery(zone, box);

  const conv = convergence(zone, c.lng, c.lat);
  const shade = hillshade(cgrid, 1 / toOut); // z (output units) -> native XY units
  const base = baseFor(zone, toOut, pts);
  const now = new Date();
  const site = {
    zone, units: u, toOut, zPerM, spacingOut, interval, box, pts, pStats, grid: cgrid, stats: cStats, shade,
    contours, context, contextNotes, roadsSource, ctxInclude: { b: wantB, r: wantR, p: wantP, f: wantF }, floodFailed, parcelsFailed, bldgFailed, widthsFailed, areasFailed, imagery, imageryCredit, convergence: conv, outUnit: u, dem, base, center: c, generated: now, bbox,
    tinted: false,
  };
  site.meta = buildMeta(site);
  state.result = site;

  showResults(site);
  drawContoursOnMap(site);
  if ($('panel').classList.contains('mode-design')) dzEnsure();
  applyOrigin();
  drawUnderlayThumb();
  renderPreview();
  const missing = pStats.missing;
  setStatus(missing
    ? `Done, but ${fmt(missing, 0)} grid points had no elevation data and were left out of the CSV/DXF.`
    : `Done — ${fmt(pts.nx * pts.ny, 0)} points, ${levels.length} contour levels.`);
}

const tick = () => new Promise(r => setTimeout(r, 0));

async function fetchImagery(zone, box) {
  // Request imagery already reprojected to the State Plane zone so it aligns exactly with the grid.
  const toReq = zone.note ? 1 / zoneUnitsPerMeter(zone) : 1; // converted zones are requested in their metric EPSG units
  const w = box.xmax - box.xmin, h = box.ymax - box.ymin;
  const sources = [
    { url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export', long: 2400, credit: 'Esri World Imagery (Esri, Maxar, Earthstar Geographics)' },
    { url: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/export', long: 2400, credit: 'USGS The National Map: Orthoimagery (public domain)' },
  ];
  for (const src of sources) {
    const size = w >= h ? [src.long, Math.max(1, Math.round(src.long * h / w))] : [Math.max(1, Math.round(src.long * w / h)), src.long];
    const params = new URLSearchParams({
      bbox: [box.xmin * toReq, box.ymin * toReq, box.xmax * toReq, box.ymax * toReq].join(','),
      bboxSR: String(zone.code), imageSR: String(zone.code), size: size.join(','), format: 'jpg', f: 'image',
    });
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 20000);
    try {
      const r = await fetch(`${src.url}?${params}`, { signal: ac.signal });
      if (!r.ok || !(r.headers.get('content-type') || '').startsWith('image/')) continue;
      return { bitmap: await createImageBitmap(await r.blob()), credit: src.credit };
    } catch { /* try next */ } finally { clearTimeout(timer); }
  }
  return { bitmap: null, credit: '' };
}

/** Aerial download resolution, ft per pixel (0 = finest the source offers, ~0.25 ft/px). */
const AERIAL_RES = [
  { v: 0, label: 'Maximum detail (about 0.25 ft/px)' },
  { v: 0.5, label: '0.5 ft/px' },
  { v: 1, label: '1 ft/px' },
  { v: 2, label: '2 ft/px (small file)' },
];
const AERIAL_MAX_PX = 64e6;   // total pixels (~8000 x 8000) — keeps the browser and Revit responsive
const AERIAL_TILE = 2048;     // per-request size; the services allow 4096 but smaller requests are far more reliable
let aerialRes = (() => { try { const v = parseFloat(localStorage.getItem('c2r-aerial-res')); return AERIAL_RES.some(o => o.v === v) ? v : 0; } catch { return 0; } })();

const AERIAL_SOURCES = [
  // Esri World Imagery: 3-6 in. imagery in most US towns (tested downtown Little Rock: real detail to ~0.25 ft/px).
  { url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export', credit: 'Esri World Imagery (Esri, Maxar, Earthstar Geographics)' },
  // USGS NAIP-based orthoimagery: public domain but much softer (about 1 m).
  { url: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/export', credit: 'USGS The National Map: Orthoimagery (public domain)' },
];

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
  const nx = Math.ceil(W / AERIAL_TILE), ny = Math.ceil(H / AERIAL_TILE);
  const fails = [];
  for (const src of AERIAL_SOURCES) {
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    const jobs = [];
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) jobs.push([i, j]);
    let done = 0, ok = true;
    const one = async ([i, j]) => {
      const px0 = i * AERIAL_TILE, py0 = j * AERIAL_TILE;
      const tw = Math.min(AERIAL_TILE, W - px0), th = Math.min(AERIAL_TILE, H - py0);
      // Tile bbox in native zone units; pixel rows count down from the north edge.
      const x0 = box.xmin + px0 / W * w, x1 = box.xmin + (px0 + tw) / W * w;
      const y1 = box.ymax - py0 / H * h, y0 = box.ymax - (py0 + th) / H * h;
      const params = new URLSearchParams({
        bbox: [x0 * toReq, y0 * toReq, x1 * toReq, y1 * toReq].join(','),
        bboxSR: String(zone.code), imageSR: String(zone.code), size: `${tw},${th}`, format: 'jpg', f: 'image',
      });
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const r = await fetch(`${src.url}?${params}`, { signal: AbortSignal.timeout(60000) });
          if (!r.ok || !(r.headers.get('content-type') || '').startsWith('image/')) throw new Error(`HTTP ${r.status}`);
          const bmp = await createImageBitmap(await r.blob());
          ctx.drawImage(bmp, px0, py0, tw, th);
          bmp.close?.();
          setStatus(`Downloading aerial — ${++done} of ${jobs.length} tiles…`);
          return;
        } catch { await new Promise(res => setTimeout(res, 800 * (attempt + 1))); }
      }
      ok = false;
    };
    // 4 requests at a time.
    const queue = jobs.slice();
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => { while (ok && queue.length) await one(queue.shift()); }));
    if (!ok) { fails.push(src.credit); continue; }
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
      `Imagery: ${site.imagery ? site.imageryCredit : 'not available — hillshade shown'}`,
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
    if (site.ctxInclude.b) html += `<div>Footprints — USA Structures: ${nb}${dates.length ? ` (imagery ${escapeHtml(dates[0].slice(0, 4))}${dates.length > 1 && dates.at(-1).slice(0, 4) !== dates[0].slice(0, 4) ? '–' + escapeHtml(dates.at(-1).slice(0, 4)) : ''})` : ''}, ${nh} with heights · Microsoft: ${(site.context.bldgMs || []).length} (no heights) · OpenStreetMap: ${(site.context.bldgOsm || []).length}, ${(site.context.bldgOsm || []).filter(b => b.heightKnown).length} with heights</div>`;
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
}

// ---------- Layer visibility (map "Layers" panel drives the map, preview, PNG and DXF) ----------
const LAYERS = [
  { key: 'contours', label: 'Contours', swatch: '#ffb347' },
  ...BUILDING_SOURCES.map(b => ({ key: b.key, label: b.label, swatch: b.color })),
  { key: 'roads', label: 'Roads', swatch: '#ffe066' },
  { key: 'roadWidths', label: 'Road widths · ArDOT', swatch: '#fde68a' },
  { key: 'roadEdges', label: 'Road edges · ArDOT', swatch: '#facc15' },
  { key: 'streetAreas', label: 'Street surfaces · OSM', swatch: '#f59e0b' },
  { key: 'parking', label: 'Parking lots · OSM', swatch: '#cbd5e1' },
  { key: 'sidewalks', label: 'Sidewalks · OSM', swatch: '#f8fafc' },
  { key: 'parcels', label: 'Parcels', swatch: '#ff4fd8' },
  { key: 'flood', label: 'Flood zones', swatch: '#3b82f6' },
  { key: 'labels', label: 'Labels', swatch: '#ffffff', note: 'preview · PNG · DXF' },
  { key: 'imageFrame', label: 'Aerial image frame', swatch: '#93c5fd', note: 'DXF only' },
  { key: 'points', label: 'Grid points', swatch: '#7bd88f', note: 'DXF only' },
];
const visibility = (() => {
  const v = { contours: true, buildings: true, bldgMs: false, bldgOsm: false, roads: true, roadWidths: true, roadEdges: true, streetAreas: true, parking: true, sidewalks: true, imageFrame: true, parcels: true, flood: true, labels: true, points: false };
  try { Object.assign(v, JSON.parse(localStorage.getItem('c2r-layers') || '{}')); } catch { /* ignore */ }
  return v;
})();
function vis() { return { ...visibility }; }

const LayersControl = L.Control.extend({
  options: { position: 'topright' },
  onAdd() {
    const el = L.DomUtil.create('div', 'layers-panel leaflet-bar');
    el.innerHTML = '<div class="lp-title">Layers</div>' + LAYERS.map(l => `
      <label class="lp-row" data-key="${l.key}">
        <input type="checkbox" ${visibility[l.key] ? 'checked' : ''}>
        <span class="lp-sw" style="background:${l.swatch}"></span>
        <span class="lp-name">${l.label}</span>
        <span class="lp-count">${l.note || ''}</span>
      </label>`).join('') + '<div class="lp-foot">Shown layers go into the preview, PNG &amp; DXF</div>';
    L.DomEvent.disableClickPropagation(el);
    L.DomEvent.disableScrollPropagation(el);
    el.querySelectorAll('.lp-row').forEach(row => row.querySelector('input').addEventListener('change', e => {
      visibility[row.dataset.key] = e.target.checked;
      try { localStorage.setItem('c2r-layers', JSON.stringify(visibility)); } catch { /* ignore */ }
      applyVisibility();
    }));
    return el;
  },
});
map.addControl(new LayersControl());

function updateLayerCounts(site) {
  const c = site?.context;
  const counts = {
    contours: site ? `${site.contours.length} levels` : '',
    buildings: c ? (site.bldgFailed?.buildings ? 'failed' : String(c.buildings.length)) : '',
    bldgMs: c ? (site.bldgFailed?.bldgMs ? 'failed' : String((c.bldgMs || []).length)) : '',
    bldgOsm: c ? (site.bldgFailed?.bldgOsm ? 'failed' : String((c.bldgOsm || []).length)) : '',
    roads: c ? String(c.roads.length) : '',
    roadWidths: c ? (!site.ctxInclude.p ? 'AR only' : site.widthsFailed ? 'failed' : String((c.widths || []).length)) : '',
    streetAreas: c ? (site.areasFailed ? 'failed' : String((c.streetAreas || []).length)) : '',
    parking: c ? (site.areasFailed ? 'failed' : String((c.parking || []).length)) : '',
    sidewalks: c ? (site.areasFailed ? 'failed' : String((c.sidewalks || []).length)) : '',
    roadEdges: c ? (!site.ctxInclude.p ? 'AR only' : site.widthsFailed ? 'failed' : String((c.widths || []).length)) : '',
    parcels: c ? (!site.ctxInclude.p ? 'AR only' : site.parcelsFailed ? 'failed' : String(c.parcels.length)) : '',
    flood: c ? (site.floodFailed ? 'failed' : c.floodZones.length ? String(c.floodZones.length) : 'none') : '',
    points: site ? `${fmt(site.pts.nx * site.pts.ny - site.pStats.missing, 0)} · DXF only` : 'DXF only',
    labels: 'preview · PNG · DXF',
    imageFrame: 'DXF only',
  };
  document.querySelectorAll('.layers-panel .lp-row').forEach(row => { row.querySelector('.lp-count').textContent = counts[row.dataset.key]; });
}

function applyVisibility() {
  for (const [key, group] of Object.entries(state.mapGroups || {})) {
    const designOwns = key === 'contours' && $('panel').classList.contains('mode-design');
    if (visibility[key] && !designOwns) group.addTo(map); else map.removeLayer(group);
  }
  if (!$('preview').hidden) renderPreview();
}

function drawContoursOnMap(site) {
  for (const g of Object.values(state.mapGroups || {})) map.removeLayer(g);
  const p = projector(site.zone);
  const renderer = L.canvas({ padding: 0.3 });
  const ll = ([x, y]) => { const [lon, lat] = p.inv([x, y]); return [lat, lon]; };
  const groups = { contours: L.layerGroup(), roads: L.layerGroup(), roadWidths: L.layerGroup(), roadEdges: L.layerGroup(), streetAreas: L.layerGroup(), parking: L.layerGroup(), sidewalks: L.layerGroup(), parcels: L.layerGroup(), flood: L.layerGroup() };
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
    for (const w of site.context.widths || []) {
      // Recorded widths: ArDOT's own centerline, hover for the record.
      L.polyline(w.center.map(ll), { color: '#fde68a', weight: 5, opacity: 0.35, interactive: true }).bindTooltip(`${w.text}<br><small>${w.source}</small>`, { sticky: true }).addTo(groups.roadWidths);
      for (const e of w.roadEdges) L.polyline(e.map(ll), { renderer, color: '#facc15', weight: 1.6, interactive: false }).addTo(groups.roadEdges);
      for (const e of w.surfaceEdges) L.polyline(e.map(ll), { renderer, color: '#facc15', weight: 0.8, opacity: 0.7, interactive: false }).addTo(groups.roadEdges);
    }
    for (const src of BUILDING_SOURCES) {
      for (const b of site.context[src.key] || []) {
        L.polygon(b.ring.map(ll), { renderer, color: src.color, weight: 1.5, fillColor: src.color, fillOpacity: 0.12, interactive: false }).addTo(groups[src.key]);
      }
    }
  }
  state.mapGroups = groups;
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

document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
  if (t.disabled) return;
  document.querySelectorAll('.tab').forEach(o => { o.classList.toggle('active', o === t); o.setAttribute('aria-selected', String(o === t)); });
  const pv = t.dataset.view === 'preview';
  $('preview').hidden = !pv;
  if (pv) renderPreview(); else map.invalidateSize();
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

/** Footprint outlines (closed 3D polylines at the lowest ground point) and massing (3DFACE walls + flat roof). */
function addBuildings(d, list, otln, mass, P) {
  for (const b of list) {
    const ring = b.ring;
    d.polyline3d(otln, ring.map(([x, y]) => P(x, y, b.base)), true);
    for (let i = 0; i < ring.length; i++) {
      const [x0, y0] = ring[i], [x1, y1] = ring[(i + 1) % ring.length];
      d.face3d(mass, [P(x0, y0, b.base), P(x1, y1, b.base), P(x1, y1, b.top), P(x0, y0, b.top)]);
    }
    for (const [i, j, k] of triangulate(ring)) d.face3d(mass, [P(...ring[i], b.top), P(...ring[j], b.top), P(...ring[k], b.top)]);
  }
}

function addContext(d, site, v, labels) {
  const P = (x, y, z) => [...outXY(site, x, y), z];
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
    `Map imagery: ${site.imagery ? site.imageryCredit : 'none (hillshade shown)'}.`,
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
    if (v.bldgMs) {
      const ms = site.context.bldgMs || [];
      L_(`Buildings (MSFT):     ${ms.length} footprints from Microsoft Building Footprints (machine-detected from imagery;`,
        '                      Esri-hosted copy). No heights or capture dates: massing uses 3.5 m (one storey).');
    }
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
    return;
  }
  box.classList.toggle('on', !!folder.handle);
  $('sum-export').textContent = folder.handle ? `→ ${folder.handle.name}` : '→ Downloads';
  $('folder-pick').textContent = folder.handle ? `📁 ${folder.handle.name}` : 'Choose folder…';
  $('folder-off').hidden = !folder.handle;
  $('folder-prefix-row').hidden = !folder.handle;
  $('folder-hint').innerHTML = folder.handle
    ? `Downloads replace <code>${escapeHtml(folderName('dxf'))}</code>, <code>${escapeHtml(folderName('jpg'))}</code> and the rest in this folder. In Revit, link them from here once; after a change, download again and click <strong>Reload</strong> in Manage Links.`
    : 'Choose a folder and downloads are saved there with fixed names, replacing the previous version. Link them in Revit once; after a change, download again and use Reload in Manage Links.';
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
const align = { rot: 0, datum: null, northRef: 'grid', ...(session.get('align') || {}) };
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
  saveAlign(); applyOrigin();
});
$('datum-ground').addEventListener('click', () => {
  const site = state.result;
  const z = site && originGround(site);
  if (!Number.isFinite(z)) { setStatus('Generate first so the ground elevation at the origin is known.', true); return; }
  align.datum = Math.round(z * 100) / 100;
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
    site.datum = align.datum;
  }
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
  if (!rv) {
    body.innerHTML = `<p class="hint">${site ? 'Turn on <strong>Use a local origin</strong> (and pick it on a building corner) to get the values for Revit.' : 'Generate to see the values.'}</p>`;
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
  if (!$('preview').hidden) document.querySelector('.tab[data-view="map"]').click();
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
const SHAPES = ['slope', 'wall', 'pad'];
const BRUSHES = ['raise', 'lower', 'flatten', 'smooth'];
const DZ_DEFAULTS = { amount: 2, size: 25, soft: 60, strength: 50, slope: 2, width: 20, wheight: 4, wthick: 1, shelf: 10, wside: 'left', wmode: 'fill', ratio: 3 };
const dz = {
  mode: 'existing', tool: 'raise', design: null, site: null,
  exist: null, prop: null, raster: null,
  lastContour: 0, raf: 0, contourVer: -1,
  cursor: null, stroking: false, last: null, spaceDown: false,
  params: (() => { try { return { ...DZ_DEFAULTS, ...JSON.parse(localStorage.getItem('c2r-dz') || '{}') }; } catch { return { ...DZ_DEFAULTS }; } })(),
  target: null, slopeStart: null, padElev: null,
  showExist: true, showCf: true,
  sel: null,            // selected feature id
  drawing: null,        // { kind, a, b } while dragging out a new shape
  edit: null,           // { id, handle, from, geom0, moved } while dragging a feature or its handle
  pan: null,            // middle-button pan
  fieldCheckpoint: false,
};
const saveDzParams = () => { try { localStorage.setItem('c2r-dz', JSON.stringify(dz.params)); } catch { /* ignore */ } };

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

const FEAT_COLOR = { pad: '#f8fafc', wall: '#cbd5e1', slope: '#22d3ee' };
const SEL_COLOR = '#e8913f';

/** Handle points (native) of a feature, for drawing and dragging. */
function featHandles(f) {
  if (f.type === 'pad') return Design.padCorners(f.geom, f.p.rot);
  return [f.geom.a, f.geom.b];
}

function dzDraw() {
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
      const cs = Design.padCorners(f.geom, f.p.rot);
      ctx.beginPath(); cs.forEach((c, i) => (i ? ctx.lineTo(...c) : ctx.moveTo(...c))); ctx.closePath();
      ctx.fillStyle = sel ? 'rgba(232,145,63,0.12)' : 'rgba(248,250,252,0.08)'; ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = 4 * px; ctx.stroke();
      ctx.strokeStyle = col; ctx.lineWidth = 2 * px; ctx.stroke();
      const cx = cs.reduce((a, c) => a + c[0], 0) / 4, cy = cs.reduce((a, c) => a + c[1], 0) / 4;
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
      labels.push([(a[0] + b[0]) / 2 - nx * 12 * px, (a[1] + b[1]) / 2 - ny * 12 * px, m ? `TW ${m.tw.toFixed(1)} / BW ${m.bw.toFixed(1)}` : `WALL ${f.p.height}`, col]);
    } else {
      const [a, b] = [f.geom.a, f.geom.b];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L;
      const hw = f.p.width / 2 / site.toOut;
      ctx.beginPath();
      ctx.moveTo(a[0] - uy * hw, a[1] + ux * hw); ctx.lineTo(b[0] - uy * hw, b[1] + ux * hw);
      ctx.moveTo(a[0] + uy * hw, a[1] - ux * hw); ctx.lineTo(b[0] + uy * hw, b[1] - ux * hw);
      ctx.strokeStyle = col; ctx.globalAlpha = 0.5; ctx.lineWidth = 1 * px; ctx.stroke(); ctx.globalAlpha = 1;
      ctx.beginPath(); ctx.moveTo(...a); ctx.lineTo(...b);
      const ah = 12 * px;
      ctx.moveTo(b[0] - ux * ah - uy * ah * 0.5, b[1] - uy * ah + ux * ah * 0.5); ctx.lineTo(...b); ctx.lineTo(b[0] - ux * ah + uy * ah * 0.5, b[1] - uy * ah - ux * ah * 0.5);
      ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = 4.5 * px; ctx.stroke();
      ctx.strokeStyle = col; ctx.lineWidth = 2.2 * px; ctx.stroke();
      const o = f.out;
      labels.push([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, `${(f.p.slope * 100).toFixed(f.p.slope * 100 % 1 ? 2 : 1)}%${o ? `  ${o.zA.toFixed(1)}→${o.zB.toFixed(1)}` : ''}`, col]);
    }
    ctx.setLineDash([]);
    if (sel) {
      screen();
      for (const h of featHandles(f)) {
        const [sx, sy] = toScreen(M, ...h);
        ctx.fillStyle = '#fff'; ctx.strokeStyle = SEL_COLOR; ctx.lineWidth = 2;
        ctx.fillRect(sx - 5, sy - 5, 10, 10); ctx.strokeRect(sx - 5, sy - 5, 10, 10);
      }
    }
  };
  for (const f of des.features) drawFeature(f, f.id === dz.sel, false);
  if (dz.drawing) {
    const d = dz.drawing;
    drawFeature({ type: d.kind, geom: { a: d.a, b: d.b }, p: dzShapeParams(d.kind) }, false, true);
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
    const saved = await idb.get(designKey(site.grid, site.zone.code));
    if (saved && dz.site === site && dz.design.load(saved)) { dz.contourVer = -1; setStatus('Restored your saved design for this site.'); }
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
  }, 600);
}

/** After any edit: earthwork, feature list, autosave, redraw. */
function dzAfterChange(save = true) {
  if (!dz.design) return;
  if (dz.sel && !dz.design.feature(dz.sel)) dz.sel = null;
  dzEarthwork();
  dzFeatureList();
  if (save) dzSave();
  dzUpdateRaster(true);
  dzRefresh(true);
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
  if (f.type === 'pad') return o ? `${fmt(o.w, 0)} × ${fmt(o.h, 0)} ${u} at ${o.elev.toFixed(2)}${Number.isFinite(f.p.elev) ? '' : ' (ground)'} · ${f.p.ratio}:1` : 'outside the site';
  if (f.type === 'wall') return o ? `${f.p.height} ${u} ${f.p.mode === 'cut' ? 'cut' : 'fill'} · ${fmt(o.len, 0)} ${u} long · TW ${o.ends[1].tw.toFixed(1)}` : 'outside the site';
  return o ? `${(f.p.slope * 100).toFixed(2).replace(/\.?0+$/, '')}% · ${fmt(o.len, 0)} ${u} · ${o.zA.toFixed(1)} → ${o.zB.toFixed(1)}` : 'outside the site';
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
    if (f.type === 'pad') { dz.padElev = Number.isFinite(f.p.elev) ? f.p.elev : null; dz.params.ratio = f.p.ratio; }
    if (f.type === 'wall') Object.assign(dz.params, { wheight: f.p.height, wthick: f.p.thick, shelf: f.p.shelf, wside: f.p.side, wmode: f.p.mode, ratio: f.p.ratio });
    if (f.type === 'slope') { Object.assign(dz.params, { slope: +(f.p.slope * 100).toFixed(3), width: f.p.width }); dz.slopeStart = Number.isFinite(f.p.startElev) ? f.p.startElev : null; }
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
  $('panel').classList.toggle('mode-design', mode === 'design');
  document.querySelectorAll('.mode').forEach(b => { const on = b.dataset.mode === mode; b.classList.toggle('active', on); b.setAttribute('aria-selected', String(on)); });
  const design = mode === 'design';
  if (design && !$('preview').hidden) document.querySelector('.tab[data-view="map"]').click();
  document.querySelector('.tab[data-view="preview"]').hidden = design;
  dzCanvas.hidden = !design;
  if (state.mapGroups?.contours) { if (design) map.removeLayer(state.mapGroups.contours); else if (visibility.contours) state.mapGroups.contours.addTo(map); }
  if (drawn) { if (design) map.removeLayer(drawn); else drawn.addTo(map); }
  map.getContainer().classList.toggle('design-mode', design);
  if (design) dzEnsure().then(() => { dzApplyTool(); dzRefresh(true); });
  else { map.dragging.enable(); map.getContainer().classList.remove('sculpting'); $('dz-readout').hidden = true; }
}
document.querySelectorAll('.mode').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));

// ----- Tools & parameters -----
function dzShapeParams(kind) {
  const p = dz.params, k = dz.site?.toOut || 1;
  if (kind === 'pad') return { elev: dz.padElev, ratio: Number(p.ratio), rot: $('local-origin').checked ? align.rot : 0, k };
  if (kind === 'wall') return { height: Number(p.wheight), thick: Number(p.wthick), shelf: Number(p.shelf), side: p.wside, mode: p.wmode, ratio: Number(p.ratio), k };
  return { slope: Number(p.slope) / 100, startElev: dz.slopeStart, width: Number(p.width), soft: p.soft / 100, k };
}

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
  setv('dz-wheight', p.wheight); setv('dz-wthick', p.wthick); setv('dz-shelf', p.shelf);
  document.querySelectorAll('input[name="wside"]').forEach(r => { r.checked = r.value === p.wside; });
  document.querySelectorAll('input[name="wmode"]').forEach(r => { r.checked = r.value === p.wmode; });
  $('dz-ratio').value = String(p.ratio);
  setv('dz-pelev', dz.padElev != null ? dz.padElev.toFixed(2) : '');
  document.querySelectorAll('#slope-chips button').forEach(b => b.classList.toggle('on', Number(b.dataset.v) === Number(p.slope)));
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
  pad: 'Drag a rectangle, then type the pad elevation. Click a pad to edit it.',
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
  $('f-wall').hidden = t !== 'wall';
  $('f-pad').hidden = t !== 'pad';
  $('f-ratio').hidden = !(t === 'wall' || t === 'pad');
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
    slope: `slope ${dz.params.slope}%`, wall: `wall ${dz.params.wheight} ${u}`, pad: dz.padElev != null ? `pad at ${dz.padElev.toFixed(1)}` : 'pad',
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
document.querySelectorAll('#slope-chips button').forEach(b => b.addEventListener('click', () => { dz.params.slope = Number(b.dataset.v); dzFieldsChanged(); }));
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
    extra = dz.drawing.kind === 'pad' ? (() => { const cs = Design.padCorners({ a: dz.drawing.a, b: dz.drawing.b }, dzShapeParams('pad').rot); return ` · ${fmt(Math.hypot(cs[1][0] - cs[0][0], cs[1][1] - cs[0][1]) * dz.site.toOut, 0)} × ${fmt(Math.hypot(cs[3][0] - cs[0][0], cs[3][1] - cs[0][1]) * dz.site.toOut, 0)} ${u}`; })() : ` · ${fmt(L, 0)} ${u}`;
  }
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
    const hs = featHandles(sel);
    for (let i = 0; i < hs.length; i++) { const [sx, sy] = toScreen(M, ...hs[i]); if (Math.hypot(sx - cp.x, sy - cp.y) < 9) return { f: sel, handle: i }; }
  }
  for (let n = des.features.length - 1; n >= 0; n--) {
    const f = des.features[n];
    const pts = (f.type === 'pad' ? Design.padCorners(f.geom, f.p.rot) : [f.geom.a, f.geom.b]).map(q => toScreen(M, ...q));
    if (f.type === 'pad') {
      let inside = false;
      for (let i = 0, j = 3; i < 4; j = i++) {
        const [xi, yi] = pts[i], [xj, yj] = pts[j];
        if ((yi > cp.y) !== (yj > cp.y) && cp.x < (xj - xi) * (cp.y - yi) / (yj - yi) + xi) inside = !inside;
      }
      if (inside) return { f, handle: -1 };
    } else {
      const [[ax, ay], [bx, by]] = pts;
      const L2 = (bx - ax) ** 2 + (by - ay) ** 2;
      const t = L2 ? Math.max(0, Math.min(1, ((cp.x - ax) * (bx - ax) + (cp.y - ay) * (by - ay)) / L2)) : 0;
      if (Math.hypot(ax + t * (bx - ax) - cp.x, ay + t * (by - ay) - cp.y) < 8) return { f, handle: -1 };
    }
  }
  return null;
}

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
  // Features: drag a handle of the selected one, or (with a shape tool) select / move one.
  const hit = (shapeTool || dz.sel) ? dzHit(e.containerPoint) : null;
  if (hit && (shapeTool || hit.handle >= 0)) {
    if (dz.sel !== hit.f.id) dzSelect(hit.f.id);
    dz.edit = { id: hit.f.id, handle: hit.handle, from: xy, geom0: JSON.parse(JSON.stringify(hit.f.geom)), moved: false };
    return;
  }
  if (shapeTool) {
    if (dz.sel) { dz.sel = null; dzApplyTool(); dzFeatureList(); }
    dz.drawing = { kind: dz.tool, a: xy, b: xy };
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

map.on('mousemove', e => {
  if (dz.mode !== 'design' || !dz.design || dz.pan) return;
  const xy = dzNative(e);
  dz.cursor = xy;
  if (dz.stroking) dzStrokeTo(xy);
  else if (dz.drawing) dz.drawing.b = xy;
  else if (dz.edit) {
    const ed = dz.edit, f = dz.design.feature(ed.id);
    if (f) {
      if (!ed.moved) { dz.design.checkpoint(); ed.moved = true; }
      const dx = xy[0] - ed.from[0], dy = xy[1] - ed.from[1];
      const g0 = ed.geom0;
      let geom;
      if (ed.handle < 0) geom = { a: [g0.a[0] + dx, g0.a[1] + dy], b: [g0.b[0] + dx, g0.b[1] + dy] };
      else if (f.type === 'pad') {
        const cs = Design.padCorners(g0, f.p.rot);
        geom = { a: cs[(ed.handle + 2) % 4], b: xy }; // opposite corner stays put
      } else geom = ed.handle === 0 ? { a: xy } : { b: xy };
      f.geom = { ...f.geom, ...geom };
      dz.design.stale = true;
    }
  } else if (SHAPES.includes(dz.tool) || dz.sel) {
    const hit = dzHit(e.containerPoint);
    map.getContainer().classList.toggle('over-handle', !!hit && hit.handle >= 0);
    map.getContainer().classList.toggle('over-feature', !!hit && hit.handle < 0 && SHAPES.includes(dz.tool));
  }
  dzReadout(xy);
  dzRefresh();
});
map.on('mouseout', () => { if (dz.mode === 'design') { dz.cursor = null; dzDraw(); } });

document.addEventListener('mouseup', e => {
  if (e.button !== 0) return;
  if (dz.stroking) {
    dz.stroking = false; dz.last = null;
    if (dz.design.end()) dzAfterChange();
  } else if (dz.drawing) {
    const d = dz.drawing;
    dz.drawing = null;
    const L = Math.hypot(d.b[0] - d.a[0], d.b[1] - d.a[1]);
    if (L < dz.site.grid.s * 2) { dzDraw(); return; }
    if (d.kind === 'pad' && d.a[0] !== d.b[0]) {
      const cs = Design.padCorners({ a: d.a, b: d.b }, dzShapeParams('pad').rot);
      if (Math.hypot(cs[1][0] - cs[0][0], cs[1][1] - cs[0][1]) < dz.site.grid.s || Math.hypot(cs[3][0] - cs[0][0], cs[3][1] - cs[0][1]) < dz.site.grid.s) { dzDraw(); return; }
    }
    const f = dz.design.addFeature(d.kind, { a: d.a, b: d.b }, dzShapeParams(d.kind));
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
  if (e.key === 'Escape') { if (dz.drawing) { dz.drawing = null; dzDraw(); } else if (dz.sel) { dz.sel = null; dzApplyTool(); dzFeatureList(); } if (typing(e)) e.target.blur(); return; }
  if (typing(e)) { if (e.key === 'Enter') e.target.blur(); return; }
  if (e.code === 'Space' && !dz.spaceDown) { dz.spaceDown = true; dzApplyTool(); e.preventDefault(); return; }
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
    site: { rect: [[b.getSouth(), b.getWest()], [b.getNorth(), b.getEast()]], zone: site.zone.code, units: site.units, spacing: site.spacingOut, interval: site.interval },
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
    state.rect = L.rectangle(s.rect, drawControl.options.draw.rectangle.shapeOptions);
    drawn.addLayer(state.rect);
    saveRect();
    map.fitBounds(state.rect.getBounds(), { padding: [30, 30] });
    onSiteChanged(true);
  }
  setMode('existing');
  setStatus(`“${file.name}” is for a different site — its boundary and settings are restored. Click Generate; the design opens in Site design.`);
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
      d.polyline3d('C-PAD', o.corners.map(([x, y]) => P(x, y, o.elev)), true);
      const cx = o.corners.reduce((a, c) => a + c[0], 0) / 4, cy = o.corners.reduce((a, c) => a + c[1], 0) / 4;
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
      d.text('C-WALL-TEXT', ...P(mx, my, m.tw), h * 0.7, `TW ${m.tw.toFixed(2)} / BW ${m.bw.toFixed(2)}  (${f.p.height}' ${f.p.mode === 'cut' ? 'CUT' : 'FILL'} WALL, ${f.p.thick}' THK)`, up);
    } else {
      d.layer('C-GRAD-ARRW', 5).layer('C-GRAD-ARRW-TEXT', 5);
      const [a, b] = [f.geom.a, f.geom.b];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L, ah = h * 1.5 / site.toOut;
      d.polyline3d('C-GRAD-ARRW', [P(...a, o.zA), P(...b, o.zB)]);
      d.polyline3d('C-GRAD-ARRW', [P(b[0] - ux * ah - uy * ah * 0.5, b[1] - uy * ah + ux * ah * 0.5, o.zB), P(...b, o.zB), P(b[0] - ux * ah + uy * ah * 0.5, b[1] - uy * ah - ux * ah * 0.5, o.zB)]);
      const [p1, p2] = [outXY(site, ...a), outXY(site, ...b)];
      let ang = Math.atan2(p2[1] - p1[1], p2[0] - p1[0]) * 180 / Math.PI;
      if (ang > 90 || ang < -90) ang += 180;
      d.text('C-GRAD-ARRW-TEXT', ...P((a[0] + b[0]) / 2 - uy * h / site.toOut, (a[1] + b[1]) / 2 + ux * h / site.toOut, (o.zA + o.zB) / 2), h * 0.7, `${(f.p.slope * 100).toFixed(2).replace(/\.?0+$/, '')}%`, ang);
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
  $('step-results').hidden = true;
  if (!$('preview').hidden) document.querySelector('.tab[data-view="map"]').click();
  document.querySelector('.tab[data-view="preview"]').disabled = true;
  updateLayerCounts(null);
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
    el.querySelector('a').addEventListener('click', e => { e.preventDefault(); clearAll(); });
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
  ul.innerHTML = idx.states.map(st => `<li><span><strong>${escapeHtml(title(st.id))}</strong> — ${fmt(st.n.p, 0)} lots, ${fmt(st.n.w, 0)} sidewalks</span><span>OSM ${escapeHtml(st.src)} · ${st.mb} MB</span></li>`).join('');
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
  const r = L.rectangle(savedRect, drawControl.options.draw.rectangle.shapeOptions);
  drawn.addLayer(r);
  state.rect = r;
  onSiteChanged(true);
}
$('rot-deg').value = String(align.rot || 0);
$('datum').value = align.datum != null ? String(align.datum) : '';
updateTopoSummary();
applyOrigin();
updateZoneHint();
window.c2r = { state, map, makers: MAKERS, dz }; // for debugging in the console
