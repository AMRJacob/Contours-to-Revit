// Prevailing wind: a wind rose from the nearest NOAA weather station's hourly observations. View only.
//
// Data: NOAA National Centers for Environmental Information (NCEI), Global Surface Hourly (Integrated Surface
// Database), through NCEI's Access Data Service; station list from NCEI's isd-history.csv. A U.S. Government work —
// NCEI asks that it be cited as "NOAA National Centers for Environmental Information, Global Surface Hourly".
// (Open-Meteo was considered but its free API is for non-commercial use only.)
//
// The station is the nearest one (preferring airports) whose record runs to recent years and goes back at least
// five years; the rose uses its last five full calendar years. NCEI froze this product in August 2025 (its
// successor, GHCN-hourly, ships every weather variable in ~9 MB per station-year), so the years end in 2024 for
// now — fine for a prevailing-wind rose, which barely changes from year to year. Winds are reported at the station (usually an airport,
// 10 m above open ground) — buildings, trees and terrain at the site change local wind a lot.

const ISD = 'https://www.ncei.noaa.gov/pub/data/noaa/isd-history.csv';
const ADS = 'https://www.ncei.noaa.gov/access/services/data/v1';
export const WIND_CREDIT = 'NOAA National Centers for Environmental Information, Global Surface Hourly (ISD)';

export const SECTORS = 16;
export const SPEED_BINS = [0.5, 3, 5.5, 8, 11];            // m/s edges: calm < 0.5, then 0.5–3, 3–5.5, 5.5–8, 8–11, 11+
export const SEASONS = { all: null, winter: [12, 1, 2], spring: [3, 4, 5], summer: [6, 7, 8], fall: [9, 10, 11] };

let stationsP = null;
/** NCEI station list (fetched once per page). */
function stations() {
  if (!stationsP) {
    stationsP = fetch(ISD, { signal: AbortSignal.timeout(30000) }).then(r => { if (!r.ok) throw new Error(`station list: HTTP ${r.status}`); return r.text(); })
      .then(txt => {
        const out = [];
        for (const line of txt.split('\n').slice(1)) {
          const f = line.split('","').map(s => s.replace(/^"|"$/g, ''));
          if (f.length < 11 || f[3] !== 'US') continue;
          const lat = parseFloat(f[6]), lon = parseFloat(f[7]);
          if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) continue;
          out.push({ id: f[0] + f[1], name: f[2].trim(), state: f[4], icao: f[5].trim(), lat, lon, begin: f[9], end: f[10].trim() });
        }
        return out;
      })
      .catch(e => { stationsP = null; throw e; });
  }
  return stationsP;
}

const km = (a, b, c, d) => { const R = 6371, p = Math.PI / 180, x = (d - b) * p * Math.cos((a + c) / 2 * p), y = (c - a) * p; return R * Math.hypot(x, y); };

/** Candidate stations near lat/lon, best first (current record, ≥ 5 years, airports preferred, then distance). */
export async function nearStations(lat, lon, n = 4) {
  const y = new Date().getFullYear();
  const recent = '20250101', old = `${Math.min(y - 1, 2025) - 6}0101`;      // record ends in 2025 or later (see top)
  const list = (await stations()).filter(s => s.end.replace(/\D/g, '') >= recent && s.begin <= old)
    .map(s => ({ ...s, km: km(lat, lon, s.lat, s.lon) })).filter(s => s.km < 120);
  // An airport within 1.5× the distance of the nearest station is preferred (their records are the most complete).
  list.sort((a, b) => (a.km * (a.icao ? 1 : 1.5)) - (b.km * (b.icao ? 1 : 1.5)));
  return list.slice(0, n);
}

/**
 * Hourly winds for one station over the last five full years, binned into a rose per season.
 * Returns { station, years: [y0, y1], n, seasons: { all|winter|…: { n, calm, sec: [SECTORS][bins] counts, mean: m/s } } }.
 */
async function roseFor(st, onStatus) {
  const end = st.end.replace(/\D/g, '');
  const y1 = Math.min(new Date().getFullYear() - 1, Number(end.slice(0, 4)) - (end.slice(4) >= '1231' ? 0 : 1)), y0 = y1 - 4;
  onStatus?.(`Downloading ${y0}–${y1} hourly winds from ${st.name}${st.icao ? ` (${st.icao})` : ''}…`);
  const p = new URLSearchParams({ dataset: 'global-hourly', stations: st.id, startDate: `${y0}-01-01`, endDate: `${y1}-12-31`, dataTypes: 'WND', format: 'csv' });
  const r = await fetch(`${ADS}?${p}`, { signal: AbortSignal.timeout(90000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const txt = await r.text();
  const nb = SPEED_BINS.length;                        // bins 0..nb-1 above calm (last = above the top edge)
  const mk = () => ({ n: 0, calm: 0, sum: 0, sec: Array.from({ length: SECTORS }, () => new Array(nb).fill(0)) });
  const S = { all: mk(), winter: mk(), spring: mk(), summer: mk(), fall: mk() };
  const seen = new Set();
  for (const line of txt.split('\n')) {
    // "STATION","DATE","SOURCE","REPORT_TYPE","CALL_SIGN","QUALITY_CONTROL","WND"
    const m = line.match(/^"[^"]*","(\d{4})-(\d\d)-(\d\d)T(\d\d):\d\d:\d\d","[^"]*","([^"]*)",.*"(\d{3}),(\d),(\w),(\d{4}),(\d)"\s*$/);
    if (!m) continue;
    const [, Y, Mo, D, h, type, dir, dq, code, spd, sq] = m;
    if (!/FM-15|FM-12|SAO|SY-MT|AUTO|SOD/.test(type) && type.trim()) continue;      // routine hourly reports, not specials
    const key = `${Y}${Mo}${D}${h}`;
    if (seen.has(key)) continue;                                                    // one report per hour
    seen.add(key);
    if (!'01459'.includes(sq) || spd === '9999') continue;
    const v = Number(spd) / 10;
    const month = Number(Mo);
    const season = SEASONS.winter.includes(month) ? 'winter' : SEASONS.spring.includes(month) ? 'spring' : SEASONS.summer.includes(month) ? 'summer' : 'fall';
    for (const s of [S.all, S[season]]) {
      s.n++; s.sum += v;
      if (code === 'C' || v < SPEED_BINS[0]) { s.calm++; continue; }
      if (dir === '999' || code === 'V' || !'01459'.includes(dq)) { s.n--; s.sum -= v; continue; }   // variable / unknown direction
      const sec = Math.round(Number(dir) / (360 / SECTORS)) % SECTORS;
      let b = 0; while (b < nb - 1 && v >= SPEED_BINS[b + 1]) b++;
      s.sec[sec][b]++;
    }
  }
  if (S.all.n < 5000) throw new Error(`only ${S.all.n} usable hours`);
  for (const s of Object.values(S)) { s.mean = s.n ? s.sum / s.n : 0; delete s.sum; }
  return { station: { id: st.id, name: st.name, icao: st.icao, lat: st.lat, lon: st.lon, km: st.km }, years: [y0, y1], n: S.all.n, seasons: S };
}

/**
 * Wind rose for a site (cached in localStorage for 30 days per nearest station). Tries the nearest few stations
 * until one has a usable five-year record.
 */
export async function windRose(lat, lon, { onStatus } = {}) {
  onStatus?.('Finding the nearest weather station…');
  const cands = await nearStations(lat, lon);
  if (!cands.length) throw new Error('no NOAA station with a current five-year record within 120 km');
  const errs = [];
  for (const st of cands) {
    const key = `c2r-wind:${st.id}`;
    try { const c = JSON.parse(localStorage.getItem(key) || 'null'); if (c && Date.now() - c.t < 30 * 864e5) return { ...c.rose, station: { ...c.rose.station, km: st.km } }; } catch { /* ignore */ }
    try {
      const rose = await roseFor(st, onStatus);
      try { localStorage.setItem(key, JSON.stringify({ t: Date.now(), rose })); } catch { /* ignore */ }
      return rose;
    } catch (e) { errs.push(`${st.name}: ${e.message || e}`); }
  }
  throw new Error(errs.join('; '));
}

/** Share of hours (0–1) from each sector, and the prevailing sector, for one season of a rose. */
export function roseSummary(s) {
  const tot = s.n || 1;
  const frac = s.sec.map(b => b.reduce((a, v) => a + v, 0) / tot);
  let best = 0; frac.forEach((f, i) => { if (f > frac[best]) best = i; });
  return { frac, prevailing: best, calm: s.calm / tot, mean: s.mean };
}

export const sectorName = i => ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'][i % 16];

/**
 * Particles drifting with the wind across the site box (native units): each one picks a direction and speed drawn
 * from the rose (so frequent winds show up as more streaks), drifts, and respawns upwind. conv: grid convergence.
 */
export class WindField {
  constructor(box, season, conv = 0, n = 700) {
    this.box = box; this.n = n; this.conv = conv;
    this.px = new Float32Array(n); this.py = new Float32Array(n); this.ox = new Float32Array(n); this.oy = new Float32Array(n);
    this.vx = new Float32Array(n); this.vy = new Float32Array(n); this.age = new Float32Array(n); this.life = new Float32Array(n);
    this.speed = 1;
    this.setSeason(season);
  }
  setSeason(s) {
    // Cumulative table of (sector, bin) weighted by hours.
    this.table = [];
    let acc = 0;
    s.sec.forEach((bins, i) => bins.forEach((c, b) => { if (c) { acc += c; this.table.push([acc, i, b]); } }));
    this.total = acc;
    for (let p = 0; p < this.n; p++) this.spawn(p, true);
  }
  spawn(p, anywhere) {
    const b = this.box, w = b.xmax - b.xmin, h = b.ymax - b.ymin;
    if (!this.total) { this.px[p] = this.ox[p] = b.xmin; this.py[p] = this.oy[p] = b.ymin; this.vx[p] = this.vy[p] = 0; return; }
    const r = Math.random() * this.total;
    let lo = 0, hi = this.table.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (this.table[m][0] < r) lo = m + 1; else hi = m; }
    const [, sec, bin] = this.table[lo];
    const from = (sec * (360 / SECTORS) + (Math.random() - 0.5) * (360 / SECTORS) + this.conv) * Math.PI / 180;   // grid azimuth the wind comes from
    const v = (SPEED_BINS[bin] + (SPEED_BINS[bin + 1] || SPEED_BINS[bin] * 1.3)) / 2;                       // m/s, bin middle
    const size = Math.max(w, h), u = size / 160 * (0.4 + v / 6);                                             // native units per frame
    this.vx[p] = -Math.sin(from) * u; this.vy[p] = -Math.cos(from) * u;                                      // blows toward the opposite direction
    let x = b.xmin + Math.random() * w, y = b.ymin + Math.random() * h;
    if (!anywhere) { // start on the upwind edge region
      const back = Math.random() * size * 0.5;
      x -= this.vx[p] / u * back; y -= this.vy[p] / u * back;
    }
    this.px[p] = this.ox[p] = x; this.py[p] = this.oy[p] = y;
    this.age[p] = 0; this.life[p] = 60 + Math.random() * 120;
  }
  step() {
    const b = this.box, pad = Math.max(b.xmax - b.xmin, b.ymax - b.ymin) * 0.6;
    for (let p = 0; p < this.n; p++) {
      this.ox[p] = this.px[p]; this.oy[p] = this.py[p];
      this.px[p] += this.vx[p] * this.speed; this.py[p] += this.vy[p] * this.speed;
      this.age[p]++;
      const x = this.px[p], y = this.py[p];
      if (this.age[p] > this.life[p] || x < b.xmin - pad || x > b.xmax + pad || y < b.ymin - pad || y > b.ymax + pad) this.spawn(p, false);
    }
  }
  inBox(p) { const b = this.box; return this.px[p] >= b.xmin && this.px[p] <= b.xmax && this.py[p] >= b.ymin && this.py[p] <= b.ymax; }
}
