// Contours to Revit — UI and pipeline.
/* global L, JSZip */
import { ZONES, zoneByCode, zoneUnitsPerMeter, zoneUnitLabel, projector, detectZone, reverseGeocode, geocode, convergence } from './geo.js?v=0.9.0';
import { fetchElevation, sample } from './dem.js?v=0.9.0';
import { buildGrid, gridStats, smooth, contourLines, contourLevels, isMajor, labelPositions } from './contours.js?v=0.9.0';
import { Dxf } from './dxf.js?v=0.9.0';
import { drawMap, hillshade, formatElev } from './render.js?v=0.9.0';
import { fetchBuildings, fetchBuildingsMs, fetchBuildingsOsm, BUILDING_SOURCES, fetchArdotWidths, prepareWidths, fetchRoadsAny, prepareContext, triangulate, fetchParcels, fetchFlood, prepareOverlays, hatchPolygon, densify } from './context.js?v=0.9.0';

const VERSION = '0.9.0';
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
  let floodFailed = false, parcelsFailed = false, bldgFailed = {}, widthsFailed = false;
  let roadsSource = '';
  const contextNotes = [];
  if (!inArkansas) contextNotes.push('Parcels are only available for sites in Arkansas (statewide data from the Arkansas GIS Office).');
  if (ctxFetch) {
    setStatus('Adding site context…');
    const [bRes, rRes, pRes, fRes, msRes, osmRes, wRes] = await ctxFetch;
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
    contours, context, contextNotes, roadsSource, ctxInclude: { b: wantB, r: wantR, p: wantP, f: wantF }, floodFailed, parcelsFailed, bldgFailed, widthsFailed, imagery, imageryCredit, convergence: conv, outUnit: u, dem, base, center: c, generated: now, bbox,
    tinted: false,
  };
  site.meta = buildMeta(site);
  state.result = site;

  showResults(site);
  drawContoursOnMap(site);
  applyOrigin();
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
    { url: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/export', long: 2400, credit: 'USGS The National Map: Orthoimagery (public domain)' },
    { url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export', long: 1600, credit: 'Esri World Imagery (Esri, Maxar, Earthstar Geographics)' },
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

/**
 * Clean aerial for Revit/CAD: the site box exactly, grid-north up, ~0.5 ft/px (max 4096 px).
 * Cached per generated site. Returns { blob, w, h, credit, ftPerPx }.
 */
async function fetchAerialExport(site) {
  if (site._aerial) return site._aerial;
  const { zone, box } = site;
  const toReq = zone.note ? 1 / zoneUnitsPerMeter(zone) : 1;
  const w = box.xmax - box.xmin, h = box.ymax - box.ymin;
  const nativePerFt = zoneUnitsPerMeter(zone) * 0.3048;
  const want = Math.min(4096, Math.max(1200, Math.ceil(Math.max(w, h) / nativePerFt / 0.5)));
  const tries = [
    { url: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/export', long: want, credit: 'USGS The National Map: Orthoimagery (public domain)' },
    { url: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/export', long: Math.min(want, 2400), credit: 'USGS The National Map: Orthoimagery (public domain)' },
    { url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export', long: Math.min(want, 2000), credit: 'Esri World Imagery (Esri, Maxar, Earthstar Geographics)' },
  ];
  for (const t of tries) {
    const size = w >= h ? [t.long, Math.max(1, Math.round(t.long * h / w))] : [Math.max(1, Math.round(t.long * w / h)), t.long];
    const params = new URLSearchParams({
      bbox: [box.xmin * toReq, box.ymin * toReq, box.xmax * toReq, box.ymax * toReq].join(','),
      bboxSR: String(zone.code), imageSR: String(zone.code), size: size.join(','), format: 'jpg', f: 'image',
    });
    try {
      const r = await fetch(`${t.url}?${params}`, { signal: AbortSignal.timeout(45000) });
      if (!r.ok || !(r.headers.get('content-type') || '').startsWith('image/')) continue;
      const blob = await r.blob();
      const bmp = await createImageBitmap(blob);
      site._aerial = { blob, w: bmp.width, h: bmp.height, credit: t.credit, ftPerPx: (w / nativePerFt) / bmp.width };
      bmp.close?.();
      return site._aerial;
    } catch { /* try next */ }
  }
  throw new Error('aerial imagery service did not respond');
}

/** Image extents in output coordinates (same frame as the CSV/DXF, after any local origin). */
function aerialExtent(site) {
  const [x0, y0] = outXY(site, site.box.xmin, site.box.ymin);
  const [x1, y1] = outXY(site, site.box.xmax, site.box.ymax);
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
  { key: 'parcels', label: 'Parcels', swatch: '#ff4fd8' },
  { key: 'flood', label: 'Flood zones', swatch: '#3b82f6' },
  { key: 'labels', label: 'Labels', swatch: '#ffffff', note: 'preview · PNG · DXF' },
  { key: 'imageFrame', label: 'Aerial image frame', swatch: '#93c5fd', note: 'DXF only' },
  { key: 'points', label: 'Grid points', swatch: '#7bd88f', note: 'DXF only' },
];
const visibility = (() => {
  const v = { contours: true, buildings: true, bldgMs: false, bldgOsm: false, roads: true, roadWidths: true, roadEdges: true, imageFrame: true, parcels: true, flood: true, labels: true, points: false };
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
    if (visibility[key]) group.addTo(map); else map.removeLayer(group);
  }
  if (!$('preview').hidden) renderPreview();
}

function drawContoursOnMap(site) {
  for (const g of Object.values(state.mapGroups || {})) map.removeLayer(g);
  const p = projector(site.zone);
  const renderer = L.canvas({ padding: 0.3 });
  const ll = ([x, y]) => { const [lon, lat] = p.inv([x, y]); return [lat, lon]; };
  const groups = { contours: L.layerGroup(), roads: L.layerGroup(), roadWidths: L.layerGroup(), roadEdges: L.layerGroup(), parcels: L.layerGroup(), flood: L.layerGroup() };
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
function outXY(site, x, y) {
  return [x * site.toOut - site.base[0], y * site.toOut - site.base[1]];
}

function makeCsv(site) {
  const { pts } = site;
  const rows = [];
  for (let j = 0; j < pts.ny; j++) {
    for (let i = 0; i < pts.nx; i++) {
      const zv = pts.z[j * pts.nx + i];
      if (Number.isNaN(zv)) continue;
      const [x, y] = outXY(site, pts.x0 + i * pts.s, pts.y0 + j * pts.s);
      rows.push(`${x.toFixed(3)},${y.toFixed(3)},${zv.toFixed(3)}`);
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
  const d = new Dxf(site.units);
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
    }
  }
  return d.toString();
}

function addContours(d, site, avoid, labelsOn = true) {
  d.layer('C-TOPO-MAJR', 30).layer('C-TOPO-MINR', 8);
  if (labelsOn) d.layer('C-TOPO-TEXT', 7);
  const h = labelHeight(site);
  const taken = [...avoid]; // keep clear of parcel / flood labels
  for (const c of site.contours) {
    const major = isMajor(c.level, site.interval);
    const layer = major ? 'C-TOPO-MAJR' : 'C-TOPO-MINR';
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
          d.text('C-TOPO-TEXT', p.x, p.y, c.level, h, str, p.angle);
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
        '*_aerial.jpg     Clean aerial photo of the site box, grid-north up, no linework' + (img ? ` (${img.w} x ${img.h} px, ${img.ftPerPx.toFixed(2)} ft/px; ${img.credit})` : '') + '.',
        '*_aerial.jgw     World file: places the JPG automatically in AutoCAD / Civil 3D / GIS (same coordinates as the DXF).',
        `                 Image extent: ${e.w.toFixed(3)} x ${e.h.toFixed(3)} ${uu}`,
        `                 Lower-left corner: X ${e.x0.toFixed(3)}, Y ${e.y0.toFixed(3)}   Upper-right: X ${e.x1.toFixed(3)}, Y ${e.y1.toFixed(3)}`,
        '                 REVIT (Insert > Image does not read world files):',
        '                   1. Link the DXF (Origin to Origin) so layer C-IMAG-BNDY shows the image frame.',
        '                   2. In a plan view: Insert > Image, place it anywhere.',
        `                   3. Properties: check Lock Proportions, set Width = ${e.w.toFixed(3)} ${uu}.`,
        '                   4. Move the image by its lower-left corner onto the frame\'s lower-left corner (or use the',
        '                      coordinates above). Set Draw Layer = Background to keep it under the model.',
        '                 Grid north is up; if your project north is rotated, rotate the image with the model.',
      ];
    })(),
    '',
    `Map imagery: ${site.imagery ? site.imageryCredit : 'none (hillshade shown)'}.`,
    '');
  if (site.context && (BUILDING_SOURCES.some(b => v[b.key]) || v.roads || v.roadWidths || v.roadEdges || v.parcels || v.flood)) {
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
};

function saveBlob(name, data, type) {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

document.querySelectorAll('.dl').forEach(b => b.addEventListener('click', async () => {
  const site = state.result;
  if (!site) return;
  const kind = b.dataset.out;
  const label = b.querySelector('.dl-name').textContent;
  const v = vis();
  setStatus(`Preparing ${label}…`);
  await tick();
  try {
    if (kind === 'zip') {
      const zip = new JSZip();
      const folder = zip.folder(baseName(site));
      for (const k of ['csv', 'dxf', 'png', 'jpg', 'jgw', 'readme']) {
        const f = await MAKERS[k](site, v);
        if (f) folder.file(f.name, f.data);
      }
      saveBlob(`${baseName(site)}.zip`, await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' }));
    } else {
      const f = await MAKERS[kind](site, v);
      if (!f) throw new Error('nothing to export');
      saveBlob(f.name, f.data, f.type);
      if (kind === 'jpg') { const wf = await MAKERS.jgw(site, v); setTimeout(() => saveBlob(wf.name, wf.data, wf.type), 400); }
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

function applyOrigin() {
  const on = $('local-origin').checked;
  $('reset-origin').hidden = !state.origin;
  const site = state.result;
  if (site) {
    site.base = baseFor(site.zone, site.toOut, site.pts);
    site.originPicked = !!state.origin && on;
    site.originNative = on ? [site.base[0] / site.toOut, site.base[1] / site.toOut] : null;
  }
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

const pick = { active: false, corners: [], segs: [], hover: null, dot: null };

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

function startPick() {
  if (pick.active) return stopPick();
  if (!$('preview').hidden) document.querySelector('.tab[data-view="map"]').click();
  pick.active = true;
  buildSnapTargets();
  map.getContainer().classList.add('picking');
  $('pick-origin').classList.add('active');
  setStatus(pick.corners.length || pick.segs.length
    ? 'Click the map to set the origin — snaps to corners and lines of the shown layers. Esc to cancel.'
    : 'Click the map to set the origin (generate first to snap to buildings, parcels and roads). Esc to cancel.');
}

function stopPick() {
  pick.active = false;
  map.getContainer().classList.remove('picking');
  $('pick-origin').classList.remove('active');
  if (pick.dot) { map.removeLayer(pick.dot); pick.dot = null; }
}

map.on('mousemove', e => {
  if (!pick.active) return;
  const snap = snapAt(e.containerPoint);
  pick.hover = snap;
  const at = snap ? snap.ll : e.latlng;
  if (!pick.dot) pick.dot = L.circleMarker(at, { radius: 6, color: '#e8913f', weight: 2, fillColor: '#fff', fillOpacity: 0.9, interactive: false }).addTo(map);
  pick.dot.setLatLng(at);
  pick.dot.unbindTooltip();
  if (snap) pick.dot.bindTooltip(snap.label, { permanent: true, direction: 'right', offset: [8, 0], className: 'snap-tip' }).openTooltip();
});

map.on('click', e => {
  if (!pick.active) return;
  const snap = snapAt(e.containerPoint);
  const at = snap ? snap.ll : e.latlng;
  state.origin = { lat: at.lat, lon: at.lng, label: snap ? snap.label : 'Picked point (no snap)' };
  session.set('origin', state.origin);
  $('local-origin').checked = true;
  saveSettings();
  stopPick();
  applyOrigin();
  setStatus('Origin set. Downloads now use it as (0,0) — no need to generate again.');
});

document.addEventListener('keydown', e => { if (e.key === 'Escape' && pick.active) { stopPick(); setStatus('Origin pick cancelled.'); } });
$('pick-origin').addEventListener('click', startPick);
$('reset-origin').addEventListener('click', () => { state.origin = null; session.set('origin', null); applyOrigin(); setStatus('Origin reset to the south-west corner of the site.'); });

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
  state.result = null;
  $('step-results').hidden = true;
  if (!$('preview').hidden) document.querySelector('.tab[data-view="map"]').click();
  document.querySelector('.tab[data-view="preview"]').disabled = true;
  updateLayerCounts(null);
  onSiteChanged(false);
  applyOrigin();
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

// Restore the last site boundary and picked origin (map view is restored when the map is created).
state.origin = session.get('origin');
const savedRect = session.get('rect');
if (savedRect) {
  const r = L.rectangle(savedRect, drawControl.options.draw.rectangle.shapeOptions);
  drawn.addLayer(r);
  state.rect = r;
  onSiteChanged(true);
}
applyOrigin();
updateZoneHint();
window.c2r = { state, map, makers: MAKERS }; // for debugging in the console
