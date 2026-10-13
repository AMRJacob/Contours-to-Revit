// USGS 3DEP elevation: catalog lookup, tiered fetch (finest first), and sampling.
/* global GeoTIFF */

export const SERVICE = 'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer';
const NODATA = -9999;

// Resolution tiers, finest first. `match` tests the catalog item's title.
const TIERS = [
  { key: '1m', label: '1 m lidar DEM', meters: 1, match: t => /one meter|\b1 meter\b/i.test(t) },
  { key: '19', label: '1/9 arc-second DEM (~3 m)', meters: 3, match: t => /1\/9 arc/i.test(t) },
  { key: '13', label: '1/3 arc-second DEM (~10 m)', meters: 10, match: t => /1\/3 arc/i.test(t) },
  { key: '1s', label: '1 arc-second DEM (~30 m)', meters: 30, match: t => /\b1 arc[ -]second/i.test(t) },
];

/** fetch with retries: USGS occasionally returns transient errors (which arrive without CORS headers). */
async function fetchRetry(url, tries = 3) {
  let last;
  for (let k = 0; k < tries; k++) {
    try {
      const r = await fetch(url);
      if (r.status < 500) return r;
      last = new Error(`HTTP ${r.status}`);
    } catch (err) {
      last = err;
    }
    await new Promise(res => setTimeout(res, 1000 * (k + 1)));
  }
  throw new Error(`USGS elevation service did not respond (${last?.message || last}). Try again in a minute.`);
}

function tierOf(item) {
  const t = item.title || item.Name || '';
  return TIERS.find(tr => tr.match(t)) || null;
}

function ymd(v) {
  if (v === null || v === undefined || v === '') return '';
  const s = String(v);
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  if (/^\d{4}$/.test(s)) return s;
  return s;
}

/** Catalog items (primary datasets only) intersecting a lon/lat box [w,s,e,n]. */
export async function queryCatalog([w, s, e, n]) {
  const params = new URLSearchParams({
    geometry: `${w},${s},${e},${n}`,
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    where: 'Category = 1',
    outFields: 'OBJECTID,Name,title,LowPS,StartDate,EndDate,AcquisitionDate,pubdate,VerticalDatum,URL',
    returnGeometry: 'false',
    f: 'json',
  });
  const r = await fetchRetry(`${SERVICE}/query?${params}`);
  if (!r.ok) throw new Error(`3DEP catalog query failed (HTTP ${r.status})`);
  const j = await r.json();
  if (j.error) throw new Error(`3DEP catalog query failed: ${j.error.message}`);
  return (j.features || []).map(f => {
    const a = f.attributes;
    return {
      id: a.OBJECTID,
      name: a.Name,
      title: a.title || a.Name,
      tier: tierOf(a),
      start: ymd(a.StartDate),
      end: ymd(a.EndDate),
      published: ymd(a.pubdate),
      datum: a.VerticalDatum || '',
      url: a.URL || '',
    };
  });
}

/** Fetch a Float32 elevation raster (meters) on a lon/lat grid. lockIds = null for the default mosaic. */
async function exportRaster(bbox, w, h, lockIds) {
  const params = new URLSearchParams({
    bbox: bbox.join(','),
    bboxSR: '4326',
    imageSR: '4326',
    size: `${w},${h}`,
    format: 'tiff',
    pixelType: 'F32',
    noData: String(NODATA),
    interpolation: 'RSP_BilinearInterpolation',
    adjustAspectRatio: 'false',
    f: 'image',
  });
  if (lockIds) {
    params.set('mosaicRule', JSON.stringify({ mosaicMethod: 'esriMosaicLockRaster', lockRasterIds: lockIds }));
  }
  const r = await fetchRetry(`${SERVICE}/exportImage?${params}`);
  const type = r.headers.get('content-type') || '';
  if (!r.ok || !type.includes('tiff')) {
    let msg = `HTTP ${r.status}`;
    try { const j = await r.json(); msg = j.error?.message || msg; } catch { /* ignore */ }
    throw new Error(`3DEP elevation request failed: ${msg}`);
  }
  const tiff = await GeoTIFF.fromArrayBuffer(await r.arrayBuffer());
  const img = await tiff.getImage();
  const [band] = await img.readRasters();
  const data = new Float32Array(band.length);
  for (let i = 0; i < band.length; i++) {
    const v = band[i];
    data[i] = (!Number.isFinite(v) || v <= -1000 || v > 10000) ? NaN : v;
  }
  return { data, w: img.getWidth(), h: img.getHeight(), bbox: img.getBoundingBox() };
}

/**
 * Build a composite elevation raster: finest tier first, gaps filled from coarser tiers,
 * then from the service's default mosaic. Reports which tiers contributed.
 * onProgress(msg) is called with status text.
 */
export async function fetchElevation(bbox, targetMeters, onProgress = () => {}) {
  const [w, s, e, n] = bbox;
  const midLat = (s + n) / 2;
  const mPerDegLat = 111320;
  const mPerDegLon = 111320 * Math.cos(midLat * Math.PI / 180);
  let pw = Math.ceil(((e - w) * mPerDegLon) / targetMeters);
  let ph = Math.ceil(((n - s) * mPerDegLat) / targetMeters);
  const MAX = 4000;
  const scale = Math.max(1, pw / MAX, ph / MAX);
  pw = Math.max(2, Math.ceil(pw / scale));
  ph = Math.max(2, Math.ceil(ph / scale));

  onProgress('Looking up available 3DEP datasets…');
  let items = [];
  try {
    items = await queryCatalog(bbox);
  } catch (err) {
    console.warn('Catalog lookup failed; using the default mosaic', err);
  }

  let comp = null;
  const contributions = [];
  const countMissing = d => d.reduce((acc, v) => acc + (Number.isNaN(v) ? 1 : 0), 0);

  for (const tier of TIERS) {
    const tierItems = items.filter(it => it.tier === tier);
    if (!tierItems.length) continue;
    onProgress(`Requesting ${tier.label}…`);
    let r;
    try {
      r = await exportRaster(bbox, pw, ph, tierItems.map(i => i.id));
    } catch (err) {
      console.warn(err);
      continue;
    }
    let filled = 0;
    if (!comp) {
      comp = r;
      filled = r.data.length - countMissing(r.data);
    } else {
      for (let i = 0; i < comp.data.length; i++) {
        if (Number.isNaN(comp.data[i]) && !Number.isNaN(r.data[i])) { comp.data[i] = r.data[i]; filled++; }
      }
    }
    if (filled > 0) {
      contributions.push({ tier, share: filled / comp.data.length, items: tierItems });
    }
    if (countMissing(comp.data) === 0) break;
  }

  if (!comp || countMissing(comp.data) > 0) {
    onProgress('Filling remaining gaps from the default 3DEP mosaic…');
    const r = await exportRaster(bbox, pw, ph, null);
    let filled = 0;
    if (!comp) { comp = r; filled = r.data.length - countMissing(r.data); } else {
      for (let i = 0; i < comp.data.length; i++) {
        if (Number.isNaN(comp.data[i]) && !Number.isNaN(r.data[i])) { comp.data[i] = r.data[i]; filled++; }
      }
    }
    if (filled > 0) contributions.push({ tier: { key: 'mosaic', label: '3DEP best-available mosaic (resolution not reported)', meters: null }, share: filled / comp.data.length, items: [] });
  }

  const missing = countMissing(comp.data);
  if (missing === comp.data.length) throw new Error('No 3DEP elevation data is available for this area.');
  comp.missingShare = missing / comp.data.length;
  comp.contributions = contributions;
  comp.pixelMeters = { x: ((e - w) * mPerDegLon) / comp.w, y: ((n - s) * mPerDegLat) / comp.h };
  return comp;
}

/** Bilinear sample (meters) at lon/lat. Pixel centres are at half-pixel offsets. Returns NaN outside/no data. */
export function sample(dem, lon, lat) {
  const [w, s, e, n] = dem.bbox;
  const fx = ((lon - w) / (e - w)) * dem.w - 0.5;
  const fy = ((n - lat) / (n - s)) * dem.h - 0.5;
  const x0 = Math.max(0, Math.min(dem.w - 2, Math.floor(fx)));
  const y0 = Math.max(0, Math.min(dem.h - 2, Math.floor(fy)));
  const tx = Math.max(0, Math.min(1, fx - x0));
  const ty = Math.max(0, Math.min(1, fy - y0));
  const d = dem.data, W = dem.w;
  const a = d[y0 * W + x0], b = d[y0 * W + x0 + 1], c = d[(y0 + 1) * W + x0], dd = d[(y0 + 1) * W + x0 + 1];
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + dd * tx) * ty;
}
