// Parking ratios by jurisdiction, each with its source. The Sketch tab looks up which city the site is in
// (US Census TIGERweb incorporated places) and uses that city's off-street parking minimums when they're in this
// table. Every number here was read from the jurisdiction's own code; anything not verified is left out (null)
// rather than guessed, and the app says so.
//
// Ratio: { mode: 'ksf' (spaces per 1,000 sf GFA) | 'unit' (spaces per dwelling unit / guest room), r, tiers?, text }
// tiers: step-downs for large buildings — [[upToSf, share], …] applied per block (share of the base ratio).

const LR_TIERS = [[10000, 1], [20000, 0.95], [30000, 0.9], [40000, 0.85], [1e12, 0.8]];

export const CODES = [
  {
    id: 'ar-little-rock', place: 'Little Rock', state: 'AR', stateName: 'Arkansas', stateFips: '05',
    title: 'Little Rock Code of Ordinances, Ch. 36 Zoning, Art. VIII, Sec. 36-502 "Required off-street parking"',
    url: 'https://library.municode.com/ar/little_rock/codes/code_of_ordinances?nodeId=COOR_CH36ZO_ARTVIIIOREPALO',
    amended: 'History through Ord. No. 22,647 (Aug. 19, 2025)', checked: '2026-10-28', round: 'down',
    notes: [
      'Fractions are rounded down to the nearest whole space — Sec. 36-502(a).',
      'Spaces for two or more uses on one site add up — Sec. 36-503.',
      'Downtown UU Urban Use district: "No off-street parking shall be required", and the Sec. 36-502 minimums become the maximum allowed — Sec. 36-342.1, Parking requirements. The app can\'t tell the zoning district; set the ratios to 0 for a UU site.',
      'Uses not listed take the ratio of the most similar listed use — Sec. 36-502(c).',
    ],
    uses: {
      residential: { mode: 'unit', r: 1.5, text: 'Multifamily (other than elderly housing): 1.5 spaces per unit. Elderly housing 0.5; single-family 1.0 — Sec. 36-502(b)(1).' },
      office: { mode: 'ksf', r: 2, tiers: LR_TIERS, text: 'Business and professional office: 1 space per 500 sf GFA; above 10,000 sf the remaining area steps down to 95 / 90 / 85 / 80 % — Sec. 36-502(b)(2)g.' },
      retail: { mode: 'ksf', r: 2.5, tiers: LR_TIERS, text: 'General business and retail: 1 space per 400 sf GFA up to 10,000 sf, then 95 / 90 / 85 / 80 % of the remaining area — Sec. 36-502(b)(3)a. (Restaurants 1 per 100 sf; shopping centers 1 per 300 sf GLA.)' },
      hospitality: { mode: 'unit', r: 1.1, text: 'Hotels and motels: 1 space per guest room, plus 10 % more for developments over 20 rooms — Sec. 36-502(b)(1)d. (Set the unit size to the gross sf per room.)' },
      industrial: { mode: 'ksf', r: 1000 / 600, text: 'Manufacturing, processing and wholesaling: 1 space per 600 sf GFA — Sec. 36-502(b)(4)a. (Warehouse: 5 + 1 per 2,000 sf up to 50,000 sf.)' },
      civic: { mode: 'ksf', r: null, text: 'No single ratio — depends on the use: college 1 per 300 sf or 1 per 4 students; churches 1 per 5 seats; auditoriums 1 per 5 seats; hospitals 1 per bed — Sec. 36-502(b)(2). Enter the one that applies.' },
      mixed: { mode: 'ksf', r: null, text: 'Mixed use: each use is computed separately and added together — Sec. 36-503. Model the uses as separate blocks, or enter a blended ratio.' },
      parking: { mode: 'ksf', r: 0, text: 'A parking structure provides spaces rather than requiring them.' },
    },
  },
];

/** The code for a place ({ name, stateFips } or { name, state }), or null. */
export function codeFor(place) {
  if (!place?.name) return null;
  const n = place.name.replace(/\s+(city|town|village)$/i, '').trim().toLowerCase();
  return CODES.find(c => c.place.toLowerCase() === n && (c.stateFips === place.stateFips || c.state === place.state || c.stateName === place.stateName)) || null;
}

/**
 * The incorporated place (city / town) containing a point, from the US Census Bureau's TIGERweb service.
 * → { name, stateFips, geoid, source } | { name: null } when the point is outside any incorporated place.
 * Throws when the service can't be reached.
 */
export async function placeAt(lat, lon) {
  try { return await tigerPlace(lat, lon); } catch (e) {
    // Fallback: OpenStreetMap's reverse geocoder (city / town / village of the address — usually, not always, the
    // incorporated place).
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=jsonv2&zoom=14&addressdetails=1`);
    const j = await r.json(), ad = j.address || {};
    const name = ad.city || ad.town || ad.village || null;
    return { name, stateName: ad.state, source: `OpenStreetMap Nominatim (Census lookup failed: ${e.message})` };
  }
}
async function tigerPlace(lat, lon) {
  const u = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Places_CouSub_ConCity_SubMCD/MapServer/4/query?' + new URLSearchParams({
    geometry: `${lon},${lat}`, geometryType: 'esriGeometryPoint', inSR: '4326', spatialRel: 'esriSpatialRelIntersects',
    outFields: 'NAME,BASENAME,STATE,GEOID,LSADC', returnGeometry: 'false', f: 'json',
  });
  const r = await fetch(u);
  if (!r.ok) throw new Error(`TIGERweb ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || 'TIGERweb error');
  const a = j.features?.[0]?.attributes;
  return a ? { name: a.BASENAME || a.NAME, full: a.NAME, stateFips: a.STATE, geoid: a.GEOID, source: 'US Census TIGERweb (incorporated places)' } : { name: null, source: 'US Census TIGERweb (incorporated places)' };
}

/** Spaces required for one block of `sf` GFA under ratio R (before rounding). */
export function spacesFor(R, sf) {
  if (!R || R.r == null) return 0;
  if (R.mode === 'unit') return (sf / Math.max(1, R.unitSf || 1)) * R.r;
  if (!R.tiers) return sf / 1000 * R.r;
  let n = 0, lo = 0;
  for (const [hi, share] of R.tiers) { const top = hi == null ? Infinity : hi, part = Math.max(0, Math.min(sf, top) - lo); n += part / 1000 * R.r * share; lo = top; if (sf <= top) break; }
  return n;
}
