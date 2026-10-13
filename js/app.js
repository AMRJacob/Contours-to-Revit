// Contours to Revit — UI and pipeline.
/* global L, JSZip */
import { ZONES, zoneByCode, zoneUnitsPerMeter, zoneUnitLabel, projector, detectZone, reverseGeocode, geocode, convergence } from './geo.js?v=0.4.1';
import { fetchElevation, sample } from './dem.js?v=0.4.1';
import { buildGrid, gridStats, smooth, contourLines, contourLevels, isMajor, labelPositions } from './contours.js?v=0.4.1';
import { Dxf } from './dxf.js?v=0.4.1';
import { drawMap, hillshade, formatElev } from './render.js?v=0.4.1';
import { fetchBuildings, fetchRoadsAny, prepareContext, triangulate, fetchParcels, fetchFlood, prepareOverlays } from './context.js?v=0.4.1';

const VERSION = '0.4.1';
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
    localOrigin: $('local-origin').checked, smooth: $('smooth').checked, ctxBuildings: $('ctx-buildings').checked, ctxRoads: $('ctx-roads').checked, ctxParcels: $('ctx-parcels').checked, ctxFlood: $('ctx-flood').checked,
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
  if (typeof s.ctxBuildings === 'boolean') $('ctx-buildings').checked = s.ctxBuildings;
  if (typeof s.ctxRoads === 'boolean') $('ctx-roads').checked = s.ctxRoads;
  if (typeof s.ctxParcels === 'boolean') $('ctx-parcels').checked = s.ctxParcels;
  if (typeof s.ctxFlood === 'boolean') $('ctx-flood').checked = s.ctxFlood;
  if (s.zone && [...$('zone').options].some(o => o.value === s.zone)) $('zone').value = s.zone;
}

document.querySelectorAll('input[name="units"]').forEach(r => r.addEventListener('change', () => {
  fillUnitOptions(); onSiteChanged(false); saveSettings(); invalidate();
}));
['spacing', 'interval', 'local-origin', 'smooth', 'ctx-buildings', 'ctx-roads', 'ctx-parcels', 'ctx-flood'].forEach(id => $(id).addEventListener('change', () => {
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

  const wantB = $('ctx-buildings').checked, wantR = $('ctx-roads').checked;
  const wantF = $('ctx-flood').checked;
  const inArkansas = /^arkansas/i.test(zone.state);
  const wantP = $('ctx-parcels').checked && inArkansas;
  const ctxFetch = (wantB || wantR || wantP || wantF)
    ? Promise.allSettled([
      wantB ? fetchBuildings(bbox) : Promise.resolve([]),
      wantR ? fetchRoadsAny(bbox) : Promise.resolve({ roads: [], source: '' }),
      wantP ? fetchParcels(bbox) : Promise.resolve([]),
      wantF ? fetchFlood(bbox) : Promise.resolve(null),
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
  let roadsSource = '';
  const contextNotes = [];
  if ($('ctx-parcels').checked && !inArkansas) contextNotes.push('Parcels are only available for sites in Arkansas (statewide data from the Arkansas GIS Office).');
  if (ctxFetch) {
    setStatus('Adding site context…');
    const [bRes, rRes, pRes, fRes] = await ctxFetch;
    if (bRes.status === 'rejected') contextNotes.push(`Building footprints unavailable: ${bRes.reason?.message || bRes.reason}`);
    if (rRes.status === 'rejected') contextNotes.push(`Roads unavailable: ${rRes.reason?.message || rRes.reason}`);
    else if (rRes.value.note) contextNotes.push(rRes.value.note);
    roadsSource = rRes.status === 'fulfilled' ? rRes.value.source : '';
    context = prepareContext(
      { buildings: bRes.status === 'fulfilled' ? bRes.value : [], roads: rRes.status === 'fulfilled' ? rRes.value.roads : [] },
      { fwd: p.fwd, box, zAt, nativePerM, zPerM });
    if (pRes.status === 'rejected') contextNotes.push(pRes.reason?.message || String(pRes.reason));
    if (fRes.status === 'rejected') contextNotes.push(fRes.reason?.message || String(fRes.reason));
    // BFE values from FEMA are in their own unit (normally feet, NAVD88); convert to the output Z unit.
    const bfeToOut = (v, unit) => {
      const meters = /met/i.test(unit) ? v : v * 1200 / 3937;
      return meters * zPerM;
    };
    Object.assign(context, prepareOverlays(
      { parcels: pRes.status === 'fulfilled' ? pRes.value : [], flood: fRes.status === 'fulfilled' ? fRes.value : null },
      { fwd: p.fwd, box, zAt, nativePerM, bfeToOut }));
    await tick();
  }

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
    contours, context, contextNotes, roadsSource, ctxInclude: { b: wantB, r: wantR, p: wantP, f: wantF }, imagery, imageryCredit, convergence: conv, outUnit: u, dem, base, center: c, generated: now, bbox,
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
      ...(site.context ? [[site.ctxInclude.b ? `Buildings: FEMA/ORNL USA Structures (${site.context.buildings.length})` : '', site.ctxInclude.r ? `Roads: ${site.roadsSource === 'tiger' ? 'US Census TIGER' : '© OpenStreetMap contributors'}` : '', site.ctxInclude.p ? 'Parcels: Arkansas GIS Office' : '', site.ctxInclude.f ? 'Flood: FEMA NFHL' : ''].filter(Boolean).join('; ')] : []),
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
  if (site.context) {
    const nb = site.context.buildings.length;
    const nh = site.context.buildings.filter(b => b.heightKnown).length;
    const nr = site.context.roads.filter(r => r.kind === 'road').length;
    const dates = [...new Set(site.context.buildings.map(b => b.imageDate).filter(Boolean))].sort();
    html += `<div style="margin:10px 0 4px;font-weight:600;color:var(--ink)">Site context</div>`;
    const np = site.context.roads.length - nr;
    if (site.ctxInclude.b) html += `<div>${nb} building footprint${nb === 1 ? '' : 's'} (USA Structures${dates.length ? `, imagery ${escapeHtml(dates[0].slice(0, 4))}${dates.length > 1 && dates.at(-1).slice(0, 4) !== dates[0].slice(0, 4) ? '–' + escapeHtml(dates.at(-1).slice(0, 4)) : ''}` : ''}), ${nh} with height data</div>`;
    if (site.ctxInclude.r) html += `<div>${nr} road segment${nr === 1 ? '' : 's'}${np ? `, ${np} path${np === 1 ? '' : 's'}` : ''} (${site.roadsSource === 'tiger' ? 'US Census TIGER' : 'OpenStreetMap'})</div>`;
    if (site.ctxInclude.p) {
      const npc = site.context.parcels.length;
      html += `<div>${npc} parcel${npc === 1 ? '' : 's'} (Arkansas GIS Office)</div>`;
    }
    if (site.ctxInclude.f) {
      const fz = site.context.floodZones;
      const sfha = fz.filter(z => z.sfha);
      const zones = [...new Set(fz.map(z => z.zone + (z.floodway ? ' floodway' : z.shadedX ? ' (0.2%)' : '')))].sort();
      html += fz.length
        ? `<div>${sfha.length ? '<strong style="color:var(--warn)">Site is partly in a FEMA Special Flood Hazard Area.</strong> ' : ''}Flood zones: ${escapeHtml(zones.join(', '))}${site.context.bfes.length ? ` · ${site.context.bfes.length} BFE line${site.context.bfes.length === 1 ? '' : 's'}` : ''} (FEMA NFHL)</div>`
        : '<div>No mapped FEMA flood zones on this site (NFHL) — the area may be unmapped; check the FIRM panel.</div>';
    }
    for (const n of site.contextNotes) html += `<div class="warn" style="margin-top:6px">${escapeHtml(n)}</div>`;
  }
  src.innerHTML = html;
  document.querySelector('[data-out="dxf-context"]').hidden = !site.context;
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
  if (site.context) {
    const ll = ([x, y]) => { const [lon, lat] = p.inv([x, y]); return [lat, lon]; };
    for (const r of site.context.roads) {
      L.polyline(r.center.map(ll), { renderer, color: r.kind === 'road' ? '#ffe066' : '#9be7ff', weight: r.kind === 'road' ? 2 : 1, dashArray: r.kind === 'road' ? null : '4 4', interactive: false }).addTo(layer);
    }
    for (const b of site.context.buildings) {
      L.polygon(b.ring.map(ll), { renderer, color: '#4fd1ff', weight: 1.5, fillColor: '#4fd1ff', fillOpacity: 0.15, interactive: false }).addTo(layer);
    }
    for (const z of site.context.floodZones || []) {
      if (!z.sfha && !z.shadedX) continue;
      L.polygon(z.rings.map(r => r.map(ll)), { renderer, color: '#3b82f6', weight: 1, fillColor: z.floodway ? '#1d4ed8' : '#3b82f6', fillOpacity: z.shadedX ? 0.12 : 0.3, interactive: false }).addTo(layer);
    }
    for (const pc of site.context.parcels || []) {
      for (const l of pc.lines) L.polyline(l.map(ll), { renderer, color: '#ff4fd8', weight: 1.4, interactive: false }).addTo(layer);
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

// ---- DXF label layout (model units), so labels from the contour and context DXFs don't pile up ----
const textW = (str, h) => str.length * h * 0.62;
const dxfBox = (x, y, w, h, ang = 0) => {
  const a = ang * Math.PI / 180, c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a));
  const hw = (w * c + h * s) / 2 + h * 0.3, hh = (w * s + h * c) / 2 + h * 0.2;
  return { x0: x - hw, x1: x + hw, y0: y - hh, y1: y + hh };
};
const overlaps = (b, list) => list.some(o => b.x0 < o.x1 && b.x1 > o.x0 && b.y0 < o.y1 && b.y1 > o.y0);

/** Positions for flood-zone, parcel and BFE labels (output units), nudged apart. Cached per site. */
function contextLabels(site) {
  if (site._ctxLabels) return site._ctxLabels;
  const h = labelHeight(site);
  const items = [], boxes = [];
  const place = (lines, x, y, z) => {
    // lines: [{text, size, dy}] stacked around (x, y); try the anchor, then offsets below/above/sideways.
    const w = Math.max(...lines.map(l => textW(l.text, l.size)));
    const hh = lines.reduce((a, l) => a + l.size * 1.4, 0);
    const dirs = [[0, 0], [0, -1], [0, 1], [1, 0], [-1, 0], [1, -1], [-1, -1], [1, 1], [-1, 1]];
    for (let ring = 0; ring <= 5; ring++) {
      for (const [dx, dy] of dirs) {
        if ((ring === 0) !== (!dx && !dy)) continue;
        const cx = x + dx * ring * w * 0.6, cy = y + dy * ring * hh;
        const b = dxfBox(cx, cy, w, hh);
        if (!overlaps(b, boxes)) { boxes.push(b); items.push({ lines, x: cx, y: cy, z, ax: x, ay: y }); return; }
      }
    }
    const b = dxfBox(x, y, w, hh); boxes.push(b); items.push({ lines, x, y, z, ax: x, ay: y });
  };
  if (site.context) {
    if (site.ctxInclude.f) {
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
    if (site.ctxInclude.p) {
      for (const pc of site.context.parcels) {
        if (!pc.label || !Number.isFinite(pc.label.z)) continue;
        const [x, y] = outXY(site, pc.label.x, pc.label.y);
        const lines = [];
        if (pc.id) lines.push({ text: pc.id, size: h * 0.8, layer: 'C-PROP-TEXT' });
        if (pc.owner) lines.push({ text: pc.owner.slice(0, 60), size: h * 0.6, layer: 'C-PROP-TEXT' });
        if (lines.length) place(lines, x, y, pc.label.z);
      }
    }
  }
  site._ctxLabels = { items, boxes };
  return site._ctxLabels;
}

function makeContourDxf(site) {
  const d = new Dxf().layer('C-TOPO-MAJR', 30).layer('C-TOPO-MINR', 8).layer('C-TOPO-TEXT', 7);
  const h = labelHeight(site);
  const taken = [...contextLabels(site).boxes]; // keep clear of parcel / flood labels in the context DXF
  for (const c of site.contours) {
    const major = isMajor(c.level, site.interval);
    const layer = major ? 'C-TOPO-MAJR' : 'C-TOPO-MINR';
    for (const line of c.lines) {
      const out = line.map(([x, y]) => [...outXY(site, x, y), c.level]);
      const closed = line.length > 3 && line[0][0] === line[line.length - 1][0] && line[0][1] === line[line.length - 1][1];
      d.polyline3d(layer, closed ? out.slice(0, -1) : out, closed);
      if (major) {
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
  return d.toString();
}

function makeContextDxf(site) {
  const d = new Dxf()
    .layer('C-BLDG-OTLN', 4).layer('A-MASS', 9).layer('C-ROAD-CNTR', 2).layer('C-ROAD-EDGE', 7).layer('C-WALK-CNTR', 5);
  const P = (x, y, z) => [...outXY(site, x, y), z];
  for (const b of site.context.buildings) {
    const ring = b.ring;
    d.polyline3d('C-BLDG-OTLN', ring.map(([x, y]) => P(x, y, b.base)), true);
    // Massing: vertical walls plus a flat roof, as 3D faces (base at the lowest ground point under the footprint).
    for (let i = 0; i < ring.length; i++) {
      const [x0, y0] = ring[i], [x1, y1] = ring[(i + 1) % ring.length];
      d.face3d('A-MASS', [P(x0, y0, b.base), P(x1, y1, b.base), P(x1, y1, b.top), P(x0, y0, b.top)]);
    }
    for (const [i, j, k] of triangulate(ring)) {
      d.face3d('A-MASS', [P(...ring[i], b.top), P(...ring[j], b.top), P(...ring[k], b.top)]);
    }
  }
  const h = labelHeight(site);
  if (site.ctxInclude.p) {
    d.layer('C-PROP-LINE', 6).layer('C-PROP-TEXT', 6);
    for (const pc of site.context.parcels) {
      for (const l of pc.lines) d.polyline3d('C-PROP-LINE', l.map(([x, y, z]) => P(x, y, z)));
    }
  }
  if (site.ctxInclude.f) {
    d.layer('C-FLOD-ZONE', 5).layer('C-FLOD-BFE', 4).layer('C-FLOD-TEXT', 5);
    for (const z of site.context.floodZones) {
      for (const l of z.lines) d.polyline3d('C-FLOD-ZONE', l.map(([x, y, zz]) => P(x, y, zz)));
    }
    for (const b of site.context.bfes) {
      d.polyline3d('C-FLOD-BFE', b.line.map(([x, y, z]) => P(x, y, z)));
    }
  }
  // Parcel / flood / BFE labels, nudged apart; a leader line marks labels moved off their anchor.
  for (const it of contextLabels(site).items) {
    const total = it.lines.reduce((a, l) => a + l.size * 1.4, 0);
    let y = it.y + total / 2;
    for (const l of it.lines) { y -= l.size * 0.7; d.text(l.layer, it.x, y, it.z, l.size, l.text); y -= l.size * 0.7; }
    if (Math.hypot(it.x - it.ax, it.y - it.ay) > h) {
      d.polyline3d(it.lines[0].layer, [[it.ax, it.ay, it.z], [it.x, it.y + (it.y > it.ay ? -total / 2 : total / 2), it.z]]);
    }
  }
  for (const r of site.context.roads) {
    const layer = r.kind === 'road' ? 'C-ROAD-CNTR' : 'C-WALK-CNTR';
    if (r.center.length > 1) d.polyline3d(layer, r.center.map(([x, y, z]) => P(x, y, z)));
    for (const e of r.edges) d.polyline3d('C-ROAD-EDGE', e.map(([x, y, z]) => P(x, y, z)));
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
    '*_context.dxf    AutoCAD R12 DXF of site context (when included):',
    '                 C-BLDG-OTLN  building footprints, closed 3D polylines at the lowest ground point',
    '                 A-MASS       building massing blocks (3DFACE walls + flat roof)',
    '                 C-ROAD-CNTR  road centerlines draped on the terrain',
    '                 C-ROAD-EDGE  estimated road edges (offset from centerline; see widths below)',
    '                 C-WALK-CNTR  footpaths / trails / cycleways (centerlines)',
    '                 C-PROP-LINE  parcel lines draped on terrain; C-PROP-TEXT parcel ID / owner',
    '                 C-FLOD-ZONE  FEMA flood zone boundaries draped on terrain; C-FLOD-TEXT zone labels',
    '                 C-FLOD-BFE   FEMA base flood elevation lines, drawn AT the BFE elevation',
    '*_map.png        Printable contour map over aerial imagery, grid-north up.',
    '',
    `Map imagery: ${site.imagery ? site.imageryCredit : 'none (hillshade shown)'}.`,
    '');
  if (site.context) {
    const bs = site.context.buildings;
    const dates = [...new Set(bs.map(b => b.imageDate).filter(Boolean))].sort();
    const roads = site.context.roads.filter(r => r.kind === 'road');
    L_('SITE CONTEXT (approximate — verify in the field)',
      '-------------------------------------------------');
    if (site.ctxInclude.b) {
      L_(`Buildings:            ${bs.length} footprints from FEMA/ORNL USA Structures`,
        '                      https://gis-fema.hub.arcgis.com/pages/usa-structures',
        `Footprint imagery:    ${dates.length ? (dates.length > 1 ? `${dates[0]} to ${dates.at(-1)}` : dates[0]) : 'not reported'} (newer buildings may be missing)`,
        `Heights:              ${bs.filter(b => b.heightKnown).length} of ${bs.length} from the dataset (meters; lidar-derived where`,
        '                      available, otherwise modelled by ORNL). Missing heights use 3.5 m (one storey).',
        '                      Massing is a flat-roofed extrusion from the LOWEST ground point under each footprint.');
    }
    if (site.ctxInclude.r) {
      L_(`Roads:                ${roads.length} segments, ${site.context.roads.length - roads.length} paths, from ${site.roadsSource === 'tiger' ? 'US Census TIGER/Line (public domain)' : 'OpenStreetMap (© OpenStreetMap contributors, ODbL), via Esri\'s hosted OSM North America layer'}`,
        `                      Edge lines use OSM width/lanes where tagged (${roads.filter(r => r.widthKnown).length} of ${roads.length}); otherwise a typical width`,
        '                      by road type (e.g. residential 8 m, service 5 m, driveway 3.5 m). Bridges are draped on the ground.');
    }
    if (site.ctxInclude.p) {
      L_(`Parcels:              ${site.context.parcels.length} from the Arkansas GIS Office statewide parcel layer (CAMP / county assessor data).`,
        '                      Assessor parcel lines are NOT boundary survey lines; offsets of several feet are common.');
    }
    if (site.ctxInclude.f) {
      const fz = site.context.floodZones;
      const dfirms = [...new Set(fz.map(z => z.dfirm).filter(Boolean))];
      L_(`Flood zones:          ${fz.length ? [...new Set(fz.map(z => z.text))].join('; ') : 'none mapped on this site'}`,
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
  csv: s => ({ name: `${baseName(s)}_points.csv`, data: makeCsv(s), type: 'text/csv' }),
  'dxf-contours': s => ({ name: `${baseName(s)}_contours.dxf`, data: makeContourDxf(s), type: 'application/dxf' }),
  'dxf-context': s => (s.context ? { name: `${baseName(s)}_context.dxf`, data: makeContextDxf(s), type: 'application/dxf' } : null),
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
        if (f) folder.file(f.name, f.data);
      }
      saveBlob(`${baseName(site)}.zip`, await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' }));
    } else {
      const f = await MAKERS[kind](site);
      if (!f) throw new Error('nothing to export');
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
