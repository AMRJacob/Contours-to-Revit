// Site context: building footprints (FEMA/ORNL USA Structures) and roads (OpenStreetMap via Overpass).
// Geometry is projected into the State Plane zone and draped on the terrain by the caller.

export const STRUCTURES = 'https://services2.arcgis.com/FiaPA4ga0iQKduv3/ArcGIS/rest/services/USA_Structures_View/FeatureServer/0';
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];

const DEFAULT_HEIGHT_M = 3.5;

/** Building footprints intersecting a lon/lat box. Returns [{rings:[[[lon,lat],...]], heightM, heightKnown, use, address, imageDate}]. */
export async function fetchBuildings([w, s, e, n]) {
  const out = [];
  let offset = 0;
  for (let page = 0; page < 10; page++) {
    const params = new URLSearchParams({
      geometry: `${w},${s},${e},${n}`,
      geometryType: 'esriGeometryEnvelope',
      inSR: '4326',
      outSR: '4326',
      spatialRel: 'esriSpatialRelIntersects',
      outFields: 'BUILD_ID,HEIGHT,OCC_CLS,PRIM_OCC,PROP_ADDR,IMAGE_DATE,SOURCE',
      returnGeometry: 'true',
      geometryPrecision: '8',
      resultOffset: String(offset),
      resultRecordCount: '1000',
      f: 'json',
    });
    const r = await fetch(`${STRUCTURES}/query?${params}`, { signal: AbortSignal.timeout(30000) });
    const j = await r.json();
    if (j.error) throw new Error(`USA Structures: ${j.error.message}`);
    for (const f of j.features || []) {
      if (!f.geometry?.rings?.length) continue;
      const a = f.attributes;
      const h = Number(a.HEIGHT);
      out.push({
        id: a.BUILD_ID,
        rings: f.geometry.rings,
        heightM: h > 0 ? h : DEFAULT_HEIGHT_M,
        heightKnown: h > 0,
        use: a.PRIM_OCC || a.OCC_CLS || '',
        address: a.PROP_ADDR || '',
        imageDate: a.IMAGE_DATE ? new Date(a.IMAGE_DATE).toISOString().slice(0, 10) : '',
        source: a.SOURCE || '',
      });
    }
    if (!j.exceededTransferLimit) break;
    offset += (j.features || []).length;
  }
  return out;
}

// Typical curb-to-curb widths (meters) by OSM highway type, used when the way has no width/lanes tag.
const ROAD_WIDTH_M = {
  motorway: 15, trunk: 13, primary: 12, secondary: 10, tertiary: 9, unclassified: 7, residential: 8,
  living_street: 6, service: 5, motorway_link: 6, trunk_link: 6, primary_link: 6, secondary_link: 6, tertiary_link: 6,
};
const PATH_TYPES = new Set(['footway', 'path', 'cycleway', 'pedestrian', 'steps', 'bridleway', 'track']);
const SKIP_TYPES = new Set(['proposed', 'construction', 'abandoned', 'raceway', 'corridor', 'elevator', 'platform', 'bus_stop']);

function parseWidthM(v) {
  if (!v) return null;
  const s = String(v).trim();
  const ft = s.match(/^([\d.]+)\s*(ft|')$/i);
  if (ft) return parseFloat(ft[1]) * 0.3048;
  const m = parseFloat(s);
  return Number.isFinite(m) && m > 0 ? m : null;
}

/** OSM highways intersecting a lon/lat box. Returns [{kind:'road'|'path', type, name, widthM, widthKnown, coords:[[lon,lat],...]}]. */
export async function fetchRoads([w, s, e, n]) {
  const q = `[out:json][timeout:25];way["highway"](${s},${w},${n},${e});out tags geom;`;
  // Ask both public Overpass servers at once and use whichever answers first (they are often overloaded).
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 20000);
  let j;
  try {
    j = await Promise.any(OVERPASS.map(async url => {
      const r = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: ac.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    }));
  } catch (err) {
    const why = err.errors ? err.errors.map(x => x.name === 'AbortError' ? 'timed out' : x.message).join('; ') : err.message;
    throw new Error(`OpenStreetMap roads unavailable (${why}). Try again in a minute.`);
  } finally {
    clearTimeout(timer);
    ac.abort();
  }
  return (j.elements || [])
    .filter(el => el.type === 'way' && el.geometry?.length > 1 && !SKIP_TYPES.has(el.tags.highway))
    .map(el => osmRoad(el.tags, el.geometry.map(g => [g.lon, g.lat])));
}

// ---------- geometry helpers (native State Plane units) ----------

/** Clip a polyline to an axis-aligned box; returns a list of polylines. */
export function clipPolyline(pts, box) {
  const out = [];
  let cur = [];
  for (let i = 1; i < pts.length; i++) {
    const seg = clipSegment(pts[i - 1], pts[i], box);
    if (!seg) { if (cur.length > 1) out.push(cur); cur = []; continue; }
    const [a, b, aClipped, bClipped] = seg;
    if (!cur.length || aClipped) {
      if (cur.length > 1) out.push(cur);
      cur = [a];
    }
    cur.push(b);
    if (bClipped) { out.push(cur); cur = []; }
  }
  if (cur.length > 1) out.push(cur);
  return out;
}

function clipSegment([x0, y0], [x1, y1], { xmin, ymin, xmax, ymax }) {
  // Liang–Barsky
  const dx = x1 - x0, dy = y1 - y0;
  let t0 = 0, t1 = 1;
  const p = [-dx, dx, -dy, dy], q = [x0 - xmin, xmax - x0, y0 - ymin, ymax - y0];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) { if (q[i] < 0) return null; continue; }
    const t = q[i] / p[i];
    if (p[i] < 0) { if (t > t1) return null; if (t > t0) t0 = t; } else { if (t < t0) return null; if (t < t1) t1 = t; }
  }
  return [[x0 + t0 * dx, y0 + t0 * dy], [x0 + t1 * dx, y0 + t1 * dy], t0 > 0, t1 < 1];
}

/** Insert vertices so no segment is longer than `step`. */
export function densify(pts, step) {
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
    for (let k = 1; k <= n; k++) out.push([ax + (bx - ax) * k / n, ay + (by - ay) * k / n]);
  }
  return out;
}

/** Offset an open polyline by d (positive = left). Mitred joins, limited. */
export function offsetPolyline(pts, d) {
  const n = pts.length;
  const normals = [];
  for (let i = 1; i < n; i++) {
    const dx = pts[i][0] - pts[i - 1][0], dy = pts[i][1] - pts[i - 1][1];
    const L = Math.hypot(dx, dy) || 1;
    normals.push([-dy / L, dx / L]);
  }
  if (!normals.length) return [];
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = normals[Math.max(0, i - 1)], b = normals[Math.min(normals.length - 1, i)];
    let mx = a[0] + b[0], my = a[1] + b[1];
    const ml = Math.hypot(mx, my);
    if (ml < 1e-9) { mx = b[0]; my = b[1]; } else { mx /= ml; my /= ml; }
    const cos = mx * b[0] + my * b[1];
    const scale = d / Math.max(cos, 0.5);
    out.push([pts[i][0] + mx * scale, pts[i][1] + my * scale]);
  }
  return out;
}

/** Remove a duplicated closing vertex. */
export function openRing(r) {
  const a = r[0], b = r[r.length - 1];
  return (a[0] === b[0] && a[1] === b[1]) ? r.slice(0, -1) : r.slice();
}

/** Ear-clipping triangulation of a simple polygon (no holes). Returns index triples. */
export function triangulate(poly) {
  const n = poly.length;
  if (n < 3) return [];
  // Signed area (shoelace, y-up): > 0 means counter-clockwise.
  let area = 0;
  for (let i = 0; i < n; i++) { const [x0, y0] = poly[i], [x1, y1] = poly[(i + 1) % n]; area += x0 * y1 - x1 * y0; }
  const idx = [...Array(n).keys()];
  if (area < 0) idx.reverse();
  const tris = [];
  const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const inside = (p, a, b, c) => cross(a, b, p) >= 0 && cross(b, c, p) >= 0 && cross(c, a, p) >= 0;
  let guard = 0;
  while (idx.length > 3 && guard++ < 10000) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const ia = idx[(i + idx.length - 1) % idx.length], ib = idx[i], ic = idx[(i + 1) % idx.length];
      const a = poly[ia], b = poly[ib], c = poly[ic];
      if (cross(a, b, c) <= 1e-12) continue; // reflex or degenerate
      let ear = true;
      for (const j of idx) {
        if (j === ia || j === ib || j === ic) continue;
        if (inside(poly[j], a, b, c)) { ear = false; break; }
      }
      if (!ear) continue;
      tris.push([ia, ib, ic]);
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break; // self-intersecting or degenerate: stop
  }
  if (idx.length === 3) tris.push([idx[0], idx[1], idx[2]]);
  return tris;
}

/**
 * Project context into the State Plane zone and drape it on the terrain.
 * opts: { fwd([lon,lat]) -> [x,y] native, box (native), zAt(x,y) -> output Z, nativePerM, zPerM }
 * Returns { buildings: [{ring:[[x,y]...], base, top, heightKnown, use, address, imageDate}],
 *           roads: [{kind, type, name, widthNative, widthKnown, center:[[x,y,z]], edges:[[[x,y,z]]...]}] }
 */
export function prepareContext({ buildings = [], roads = [] }, { fwd, box, zAt, nativePerM, zPerM }) {
  const inBox = ([x, y]) => x >= box.xmin && x <= box.xmax && y >= box.ymin && y <= box.ymax;
  const step = 1.5 * nativePerM; // drape vertices every ~1.5 m (~5 ft)
  const outB = [];
  for (const b of buildings) {
    for (const ringLL of b.rings) {
      const ring = openRing(ringLL.map(c => fwd(c)));
      if (ring.length < 3 || !ring.some(inBox)) continue;
      const perim = densify([...ring, ring[0]], step);
      let base = Infinity;
      for (const [x, y] of perim) { const z = zAt(x, y); if (z < base) base = z; }
      if (!Number.isFinite(base)) continue;
      outB.push({ ring, base, top: base + b.heightM * zPerM, heightKnown: b.heightKnown, use: b.use, address: b.address, imageDate: b.imageDate, source: b.source });
      break; // outer ring only (USA Structures footprints are simple polygons)
    }
  }
  const outR = [];
  for (const r of roads) {
    const line = r.coords.map(c => fwd(c));
    const half = (r.widthM * nativePerM) / 2;
    for (const piece of clipPolyline(line, box)) {
      const center = densify(piece, step);
      const drape = pts => pts.map(([x, y]) => [x, y, zAt(x, y)]).filter(q => Number.isFinite(q[2]));
      const edges = r.kind === 'road'
        ? [half, -half].flatMap(d => clipPolyline(offsetPolyline(center, d), box).map(drape))
        : [];
      outR.push({ kind: r.kind, type: r.type, name: r.name, widthNative: half * 2, widthKnown: r.widthKnown, bridge: r.bridge, tunnel: r.tunnel, center: drape(center), edges: edges.filter(e => e.length > 1) });
    }
  }
  return { buildings: outB, roads: outR };
}

// ---------- Census TIGER roads (fallback when Overpass is down) ----------
const TIGER = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Transportation/MapServer';
// MTFCC -> [kind, OSM-like type]
const MTFCC = {
  S1100: ['road', 'primary'], S1200: ['road', 'secondary'], S1400: ['road', 'residential'], S1500: ['road', 'track'],
  S1630: ['road', 'primary_link'], S1640: ['road', 'service'], S1730: ['road', 'service'], S1740: ['road', 'service'],
  S1710: ['path', 'footway'], S1720: ['path', 'steps'], S1820: ['path', 'cycleway'], S1830: ['path', 'bridleway'],
};

export async function fetchRoadsTiger([w, s, e, n]) {
  const params = new URLSearchParams({
    geometry: `${w},${s},${e},${n}`, geometryType: 'esriGeometryEnvelope', inSR: '4326', outSR: '4326',
    spatialRel: 'esriSpatialRelIntersects', outFields: 'NAME,MTFCC', returnGeometry: 'true', f: 'json',
  });
  const layers = [2, 6, 8]; // primary, secondary (large scale), local roads
  const res = await Promise.all(layers.map(id => fetch(`${TIGER}/${id}/query?${params}`, { signal: AbortSignal.timeout(20000) }).then(r => r.json())));
  const out = [];
  const seen = new Set();
  for (const j of res) {
    if (j.error) throw new Error(`TIGER: ${j.error.message}`);
    for (const f of j.features || []) {
      const [kind, type] = MTFCC[f.attributes.MTFCC] || ['road', 'unclassified'];
      for (const path of f.geometry?.paths || []) {
        // The same street can appear in more than one TIGER layer; keep one copy.
        const a = path[0], b = path[path.length - 1];
        const key = [a, b].map(c => c.map(v => v.toFixed(6)).join(',')).sort().join('|') + '|' + path.length;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ kind, type, name: f.attributes.NAME || '', widthM: kind === 'path' ? 2 : (ROAD_WIDTH_M[type] || 6), widthKnown: false, coords: path });
      }
    }
  }
  return out;
}

// ---------- OpenStreetMap roads hosted by Esri (OSM North America, updated continuously) ----------
const ESRI_OSM_HWY = 'https://services6.arcgis.com/Do88DoK2xjTUCXd1/arcgis/rest/services/OSM_NA_Highways/FeatureServer/0';

export async function fetchRoadsEsriOsm([w, s, e, n]) {
  const out = [];
  let offset = 0;
  for (let page = 0; page < 10; page++) {
    const params = new URLSearchParams({
      geometry: `${w},${s},${e},${n}`, geometryType: 'esriGeometryEnvelope', inSR: '4326', outSR: '4326',
      spatialRel: 'esriSpatialRelIntersects', outFields: 'highway,service,name,ref,lanes,width,bridge,tunnel',
      returnGeometry: 'true', geometryPrecision: '8', resultOffset: String(offset), resultRecordCount: '2000', f: 'json',
    });
    const r = await fetch(`${ESRI_OSM_HWY}/query?${params}`, { signal: AbortSignal.timeout(20000) });
    const j = await r.json();
    if (j.error) throw new Error(`OSM (Esri): ${j.error.message}`);
    for (const f of j.features || []) {
      const t = f.attributes;
      if (!t.highway || SKIP_TYPES.has(t.highway)) continue;
      for (const path of f.geometry?.paths || []) {
        if (path.length > 1) out.push(osmRoad(t, path));
      }
    }
    if (!j.exceededTransferLimit) break;
    offset += (j.features || []).length;
  }
  return out;
}

function osmRoad(t, coords) {
  const kind = PATH_TYPES.has(t.highway) ? 'path' : 'road';
  let widthM = parseWidthM(t.width);
  const known = widthM !== null;
  if (!known && t.lanes && kind === 'road') widthM = parseFloat(t.lanes) * 3.6;
  if (!widthM) widthM = kind === 'path' ? 2 : (t.service === 'driveway' ? 3.5 : t.service === 'parking_aisle' ? 7 : (ROAD_WIDTH_M[t.highway] || 6));
  return {
    kind, type: t.highway + (t.service ? `/${t.service}` : ''), name: t.name || t.ref || '', widthM, widthKnown: known || !!t.lanes,
    bridge: !!t.bridge && t.bridge !== 'no', tunnel: !!t.tunnel && t.tunnel !== 'no', coords,
  };
}

/**
 * Roads: OpenStreetMap via Esri's hosted copy (fast), then the public Overpass API, then Census TIGER.
 * Returns {roads, source, note}.
 */
export async function fetchRoadsAny(bbox) {
  const fails = [];
  try {
    return { roads: await fetchRoadsEsriOsm(bbox), source: 'osm' };
  } catch (err) { fails.push(err.message); }
  try {
    return { roads: await fetchRoads(bbox), source: 'osm' };
  } catch (err) { fails.push(err.message); }
  const roads = await fetchRoadsTiger(bbox);
  return { roads, source: 'tiger', note: `OpenStreetMap roads unavailable (${fails.join('; ')}). Used US Census TIGER roads instead (street centerlines only, less precise).` };
}
