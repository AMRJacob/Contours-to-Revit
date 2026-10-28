// Coordinate systems: State Plane zone lookup and projection helpers.
import { ZONES } from './zones.js?v=0.52.0';

/* global proj4 */

export const US_FT_PER_M = 3937 / 1200; // US survey feet per meter
export const INTL_FT_PER_M = 1 / 0.3048; // international feet per meter

export { ZONES };

export function zoneByCode(code) {
  return ZONES.find(z => z.code === Number(code));
}

/** Units-per-meter for a zone's native linear unit. */
export function zoneUnitsPerMeter(zone) {
  return zone.unit === 'ft' ? INTL_FT_PER_M : US_FT_PER_M;
}

export function zoneUnitLabel(zone) {
  return zone.unit === 'ft' ? 'international feet' : 'US survey feet';
}

const projCache = new Map();
/** Returns {fwd([lon,lat]) -> [x,y], inv([x,y]) -> [lon,lat]} in the zone's native feet. */
export function projector(zone) {
  if (!projCache.has(zone.code)) {
    const p = proj4('EPSG:4326', zone.proj4);
    projCache.set(zone.code, { fwd: c => p.forward(c), inv: c => p.inverse(c) });
  }
  return projCache.get(zone.code);
}

function normCounty(s) {
  return (s || '').toLowerCase()
    .replace(/\./g, '')
    .replace(/\s+(county|parish|borough|census area|city and borough|municipality)$/, '')
    .replace(/^saint /, 'st ')
    .trim();
}

function inBbox(z, lon, lat) {
  const [n, w, s, e] = z.bbox;
  return lat <= n && lat >= s && lon >= w && lon <= e;
}

/**
 * Pick the State Plane zone for a point.
 * Uses the zone's EPSG area-of-use county list when the county is known (from reverse geocoding),
 * otherwise the zone whose bounding box contains the point and whose centre is nearest.
 * Returns {zone, method} or null.
 */
export function detectZone(lon, lat, place = {}) {
  let cands = ZONES.filter(z => inBbox(z, lon, lat));
  if (place.state) {
    const st = cands.filter(z => z.state.toLowerCase().startsWith(place.state.toLowerCase()));
    if (st.length) cands = st;
    const stateZones = ZONES.filter(z => z.state.toLowerCase().startsWith(place.state.toLowerCase()));
    if (stateZones.length === 1) return { zone: stateZones[0], method: 'single-zone state' };
    if (place.county) {
      const c = normCounty(place.county);
      const hit = stateZones.find(z => z.counties.some(zc => normCounty(zc) === c));
      if (hit) return { zone: hit, method: `${place.county} is listed in the EPSG area of use` };
    }
  }
  if (!cands.length) return null;
  if (cands.length === 1) return { zone: cands[0], method: 'only zone covering this point' };
  const d = z => {
    const [n, w, s, e] = z.bbox;
    return Math.hypot((w + e) / 2 - lon, (n + s) / 2 - lat);
  };
  cands.sort((a, b) => d(a) - d(b));
  return { zone: cands[0], method: 'nearest zone extent — please confirm' };
}

/** Reverse geocode to {state, county} using OpenStreetMap Nominatim. Never throws. */
export async function reverseGeocode(lat, lon) {
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=jsonv2&zoom=10&addressdetails=1`);
    const j = await r.json();
    return { state: j.address?.state || '', county: j.address?.county || j.address?.city || '' };
  } catch {
    return {};
  }
}

/** Address search: Esri World Geocoder, falling back to Nominatim. Returns [{label, lat, lon}]. */
export async function geocode(q) {
  try {
    const r = await fetch('https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates?' +
      new URLSearchParams({ SingleLine: q, maxLocations: '5', f: 'json', countryCode: 'USA' }));
    const j = await r.json();
    if (j.candidates?.length) {
      return j.candidates.map(c => ({ label: c.address, lat: c.location.y, lon: c.location.x }));
    }
  } catch { /* fall through */ }
  const r = await fetch('https://nominatim.openstreetmap.org/search?' +
    new URLSearchParams({ q, format: 'jsonv2', limit: '5', countrycodes: 'us' }));
  const j = await r.json();
  return j.map(c => ({ label: c.display_name, lat: +c.lat, lon: +c.lon }));
}

/**
 * Grid convergence (degrees): angle from grid north to true north at a point,
 * positive when true north is clockwise (east) of grid north.
 */
export function convergence(zone, lon, lat) {
  const p = projector(zone);
  const a = p.fwd([lon, lat]);
  const b = p.fwd([lon, lat + 0.01]);
  return Math.atan2(b[0] - a[0], b[1] - a[1]) * 180 / Math.PI;
}
