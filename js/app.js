// Contours to Revit — UI and pipeline.
/* global L, JSZip */
import { ZONES, zoneByCode, zoneUnitsPerMeter, zoneUnitLabel, projector, detectZone, reverseGeocode, geocode, convergence } from './geo.js?v=0.1.1';
import { fetchElevation, sample } from './dem.js?v=0.1.1';
import { buildGrid, gridStats, smooth, contourLines, contourLevels, isMajor, labelPositions } from './contours.js?v=0.1.1';
import { Dxf } from './dxf.js?v=0.1.1';
import { drawMap, hillshade, formatElev } from './render.js?v=0.1.1';

const VERSION = '0.1.1';
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
const map = L.map('map', { zoomControl: true, preferCanvas: true }).setView([34.7465, -92.2896], 15);
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
  onSiteChanged(true);
});
map.on(L.Draw.Event.EDITED, () => onSiteChanged(true));
map.on('draw:editmove draw:editresize', () => onSiteChanged(false));
map.on(L.Draw.Event.DELETED, () => {
  state.rect = drawn.getLayers()[0] || null;
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
['spacing', 'interval', 'local-origin', 'smooth'].forEach(id => $(id).addEventListener('change', () => {
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

  setStatus('Fetching aerial imagery for the map…');
  const { bitmap: imagery, credit: imageryCredit } = await fetchImagery(zone, box);

  const conv = convergence(zone, c.lng, c.lat);
  const shade = hillshade(cgrid, 1 / toOut); // z (output units) -> native XY units
  let base = [0, 0];
  if ($('local-origin').checked) {
    base = [Math.floor(pts.x0 * toOut / 100) * 100, Math.floor(pts.y0 * toOut / 100) * 100];
  }
  const now = new Date();
  const site = {
    zone, units: u, toOut, zPerM, spacingOut, interval, box, pts, pStats, grid: cgrid, stats: cStats, shade,
    contours, imagery, imageryCredit, convergence: conv, outUnit: u, dem, base, center: c, generated: now, bbox,
    tinted: false,
  };
  site.meta = buildMeta(site);
  state.result = site;

  showResults(site);
  drawContoursOnMap(site);
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
    ],
  };
}

// ---------- Results UI ----------
function showResults(site) {
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
  src.innerHTML = html;
  document.querySelector('.tab[data-view="preview"]').disabled = false;
}

function drawContoursOnMap(site) {
  if (state.contourLayer) map.removeLayer(state.contourLayer);
  const p = projector(site.zone);
  const layer = L.layerGroup();
  const renderer = L.canvas({ padding: 0.3 });
  for (const c of site.contours) {
    const major = isMajor(c.level, site.interval);
    for (const line of c.lines) {
      const latlngs = line.map(([x, y]) => { const [lon, lat] = p.inv([x, y]); return [lat, lon]; });
      L.polyline(latlngs, { renderer, color: major ? '#ffb347' : '#ffffff', weight: major ? 2 : 0.8, opacity: major ? 0.95 : 0.7, interactive: false }).addTo(layer);
    }
  }
  layer.addTo(map);
  state.contourLayer = layer;
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

function makeContourDxf(site) {
  const d = new Dxf().layer('C-TOPO-MAJR', 30).layer('C-TOPO-MINR', 8).layer('C-TOPO-TEXT', 7);
  const h = labelHeight(site);
  for (const c of site.contours) {
    const major = isMajor(c.level, site.interval);
    const layer = major ? 'C-TOPO-MAJR' : 'C-TOPO-MINR';
    for (const line of c.lines) {
      const out = line.map(([x, y]) => [...outXY(site, x, y), c.level]);
      const closed = line.length > 3 && line[0][0] === line[line.length - 1][0] && line[0][1] === line[line.length - 1][1];
      d.polyline3d(layer, closed ? out.slice(0, -1) : out, closed);
      if (major) {
        for (const p of labelPositions(out.map(q => [q[0], q[1]]), h * 40, h * 8)) {
          d.text('C-TOPO-TEXT', p.x, p.y, c.level, h, formatElev(c.level, site.interval), p.angle);
        }
      }
    }
  }
  return d.toString();
}

function makePointDxf(site) {
  const d = new Dxf().layer('C-TOPO-PNTS', 3);
  const { pts } = site;
  for (let j = 0; j < pts.ny; j++) {
    for (let i = 0; i < pts.nx; i++) {
      const zv = pts.z[j * pts.nx + i];
      if (Number.isNaN(zv)) continue;
      const [x, y] = outXY(site, pts.x0 + i * pts.s, pts.y0 + j * pts.s);
      d.point('C-TOPO-PNTS', x, y, zv);
    }
  }
  return d.toString();
}

async function makePng(site) {
  const g = site.grid;
  const landscape = (g.nx >= g.ny);
  const canvas = document.createElement('canvas');
  canvas.width = landscape ? 3300 : 2550;
  canvas.height = landscape ? 2550 : 3300;
  const tinted = site.tinted;
  site.tinted = false;
  drawMap(canvas, site, 'print');
  site.tinted = tinted;
  return new Promise(res => canvas.toBlob(res, 'image/png'));
}

function makeReadme(site) {
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
    L_(`LOCAL ORIGIN:         X/Y have the base point (${site.base[0]}, ${site.base[1]}) ${u} SUBTRACTED.`,
      '                      Add it back to recover true State Plane coordinates.',
      '                      In Revit, you can place the Survey Point at this base point.');
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
    '*_points.csv     X,Y,Z, comma-delimited, no header. Revit: Massing & Site > Toposolid >',
    '                 Create from Import > Specify Points File (Toposurface in Revit 2023 and',
    '                 earlier). Choose the same units as this file when prompted.',
    '*_contours.dxf   AutoCAD R12 DXF. 3D polylines with true Z on every vertex.',
    '                 Layers: C-TOPO-MAJR (index), C-TOPO-MINR (intermediate), C-TOPO-TEXT (labels).',
    '                 Can be linked into Revit and used for Toposolid > Create from Import > Select Import Instance.',
    '*_points.dxf     AutoCAD R12 DXF. The CSV grid as 3D POINT entities on layer C-TOPO-PNTS.',
    '*_map.png        Printable contour map over aerial imagery, grid-north up.',
    '',
    `Map imagery: ${site.imagery ? site.imageryCredit : 'none (hillshade shown)'}.`,
    '');
  return lines.join('\r\n');
}

function baseName(site) {
  const { lat, lng } = site.center;
  const d = site.generated.toISOString().slice(0, 10).replace(/-/g, '');
  return `topo_${Math.abs(lat).toFixed(4)}${lat >= 0 ? 'N' : 'S'}_${Math.abs(lng).toFixed(4)}${lng >= 0 ? 'E' : 'W'}_${d}`;
}

const MAKERS = {
  csv: s => ({ name: `${baseName(s)}_points.csv`, data: makeCsv(s), type: 'text/csv' }),
  'dxf-contours': s => ({ name: `${baseName(s)}_contours.dxf`, data: makeContourDxf(s), type: 'application/dxf' }),
  'dxf-points': s => ({ name: `${baseName(s)}_points.dxf`, data: makePointDxf(s), type: 'application/dxf' }),
  png: async s => ({ name: `${baseName(s)}_map.png`, data: await makePng(s), type: 'image/png' }),
  readme: s => ({ name: `${baseName(s)}_README.txt`, data: makeReadme(s), type: 'text/plain' }),
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
  setStatus(`Preparing ${label}…`);
  await tick();
  try {
    if (kind === 'zip') {
      const zip = new JSZip();
      const folder = zip.folder(baseName(site));
      for (const k of Object.keys(MAKERS)) {
        const f = await MAKERS[k](site);
        folder.file(f.name, f.data);
      }
      saveBlob(`${baseName(site)}.zip`, await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' }));
    } else {
      const f = await MAKERS[kind](site);
      saveBlob(f.name, f.data, f.type);
    }
    setStatus(`Downloaded ${label}.`);
  } catch (err) {
    console.error(err);
    setStatus(`Couldn't create ${label}: ${err.message}`, true);
  }
}));

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
updateZoneHint();
window.c2r = { state, map, makers: MAKERS }; // for debugging in the console
