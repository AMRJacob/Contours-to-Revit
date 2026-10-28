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
  // Per season: all hours by sector and speed bin, plus by local hour of day (sector counts, speed sums, calms).
  const mk = () => ({ n: 0, calm: 0, sum: 0, sec: Array.from({ length: SECTORS }, () => new Array(nb).fill(0)),
    hn: new Array(24).fill(0), hcalm: new Array(24).fill(0), hsec: Array.from({ length: 24 }, () => new Array(SECTORS).fill(0)),
    hspd: Array.from({ length: 24 }, () => new Array(SECTORS).fill(0)) });
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
    const hr = new Date(Date.UTC(+Y, +Mo - 1, +D, +h, 30)).getHours();      // reports are UTC; hour in this computer's zone
    const season = SEASONS.winter.includes(month) ? 'winter' : SEASONS.spring.includes(month) ? 'spring' : SEASONS.summer.includes(month) ? 'summer' : 'fall';
    const calm = code === 'C' || v < SPEED_BINS[0];
    if (!calm && (dir === '999' || code === 'V' || !'01459'.includes(dq))) continue;     // variable / unknown direction
    const sec = calm ? -1 : Math.round(Number(dir) / (360 / SECTORS)) % SECTORS;
    let b = 0; while (b < nb - 1 && v >= SPEED_BINS[b + 1]) b++;
    for (const s of [S.all, S[season]]) {
      s.n++; s.sum += v; s.hn[hr]++;
      if (calm) { s.calm++; s.hcalm[hr]++; continue; }
      s.sec[sec][b]++; s.hsec[hr][sec]++; s.hspd[hr][sec] += v;
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
    const key = `c2r-wind2:${st.id}`;
    try { const c = JSON.parse(localStorage.getItem(key) || 'null'); if (c && Date.now() - c.t < 30 * 864e5) return { ...c.rose, station: { ...c.rose.station, km: st.km } }; } catch { /* ignore */ }
    try {
      const rose = await roseFor(st, onStatus);
      try { localStorage.setItem(key, JSON.stringify({ t: Date.now(), rose })); } catch { /* ignore */ }
      return rose;
    } catch (e) { errs.push(`${st.name}: ${e.message || e}`); }
  }
  throw new Error(errs.join('; '));
}

/**
 * Share of hours (0–1) from each sector, the prevailing sector, calm share and mean speed (m/s) for one season of
 * a rose — over the whole day, or for one local hour of the day (0–23). spd: mean speed (m/s) per sector.
 */
export function roseSummary(s, hour = null) {
  let frac, spd, calm, tot;
  if (hour == null) {
    tot = s.n || 1;
    frac = s.sec.map(b => b.reduce((a, v) => a + v, 0) / tot);
    spd = s.sec.map(b => { let c = 0, w = 0; b.forEach((n, k) => { c += n; w += n * ((SPEED_BINS[k] + (SPEED_BINS[k + 1] || SPEED_BINS[k] * 1.3)) / 2); }); return c ? w / c : 0; });
    calm = s.calm / tot;
  } else {
    tot = s.hn[hour] || 1;
    frac = s.hsec[hour].map(c => c / tot);
    spd = s.hspd[hour].map((v, i) => (s.hsec[hour][i] ? v / s.hsec[hour][i] : 0));
    calm = s.hcalm[hour] / tot;
  }
  let best = 0; frac.forEach((f, i) => { if (f > frac[best]) best = i; });
  const mean = frac.reduce((a, f, i) => a + f * spd[i], 0) / Math.max(1e-9, 1 - calm);
  return { frac, spd, prevailing: best, calm, mean, n: tot };
}

export const sectorName = i => ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'][i % 16];

/**
 * Streaks drifting across the site box (native units). setFlows([{ from (degrees, true north), w (weight), v (m/s),
 * color: [r, g, b] 0–1 }]): each streak follows one flow, picked by weight, in straight parallel lines — one flow
 * gives a calm, uniform drift. conv: grid convergence.
 */
export class WindField {
  constructor(box, conv = 0, n = 450) {
    this.box = box; this.n = n; this.conv = conv;
    this.px = new Float32Array(n); this.py = new Float32Array(n); this.ox = new Float32Array(n); this.oy = new Float32Array(n);
    this.vx = new Float32Array(n); this.vy = new Float32Array(n); this.age = new Float32Array(n); this.life = new Float32Array(n);
    this.fi = new Int16Array(n); this.u0 = new Float32Array(n);
    this.speed = 1;
    this.flowAt = null;            // (flow index, x, y) → [u, v] (open wind = 1) or null inside a building
    this.flows = [];
  }
  setFlows(flows) {
    this.flows = flows.filter(f => f.w > 0);
    this.total = this.flows.reduce((a, f) => a + f.w, 0);
    for (let p = 0; p < this.n; p++) this.spawn(p, true);
  }
  spawn(p, anywhere) {
    const b = this.box, w = b.xmax - b.xmin, h = b.ymax - b.ymin, size = Math.max(w, h);
    if (!this.total) { this.px[p] = this.ox[p] = this.py[p] = this.oy[p] = NaN; this.vx[p] = this.vy[p] = 0; this.fi[p] = -1; return; }
    let r = Math.random() * this.total, i = 0;
    while (i < this.flows.length - 1 && r > this.flows[i].w) { r -= this.flows[i].w; i++; }
    const f = this.flows[i];
    const from = (f.from + (Math.random() - 0.5) * 4 + this.conv) * Math.PI / 180;            // grid azimuth the wind comes from
    const u = size / 220 * (0.5 + Math.min(f.v, 12) / 8);                                        // native units per frame
    this.vx[p] = -Math.sin(from) * u; this.vy[p] = -Math.cos(from) * u;                          // blows toward the opposite side
    this.u0[p] = u;
    const cx = (b.xmin + b.xmax) / 2, cy = (b.ymin + b.ymax) / 2;
    // Start on a line across the flow, upwind of the site (or anywhere on the first fill), so streaks run parallel.
    const ux = this.vx[p] / u, uy = this.vy[p] / u, across = (Math.random() - 0.5) * size * 1.5;
    const back = anywhere ? (Math.random() - 0.5) * size * 1.4 : -size * (0.7 + Math.random() * 0.15);
    const x = cx + -uy * across + ux * back, y = cy + ux * across + uy * back;
    this.px[p] = this.ox[p] = x; this.py[p] = this.oy[p] = y;
    this.age[p] = 0; this.life[p] = 400; this.fi[p] = i;
    // Started inside a building (flow mode): try another spot.
    if (this.flowAt && !this.flowAt(i, x, y) && (this._tries = (this._tries || 0) + 1) < 8) { this.spawn(p, anywhere); return; }
    this._tries = 0;
  }
  step() {
    const b = this.box, pad = Math.max(b.xmax - b.xmin, b.ymax - b.ymin) * 0.8;
    for (let p = 0; p < this.n; p++) {
      this.ox[p] = this.px[p]; this.oy[p] = this.py[p];
      if (this.flowAt && this.fi[p] >= 0) {
        const q = this.flowAt(this.fi[p], this.px[p], this.py[p]);
        if (!q) { this.spawn(p, false); continue; }
        this.vx[p] = q[0] * this.u0[p]; this.vy[p] = q[1] * this.u0[p];
      }
      this.px[p] += this.vx[p] * this.speed; this.py[p] += this.vy[p] * this.speed;
      this.age[p]++;
      const x = this.px[p], y = this.py[p];
      if (!(this.age[p] <= this.life[p]) || x < b.xmin - pad || x > b.xmax + pad || y < b.ymin - pad || y > b.ymax + pad) this.spawn(p, false);
    }
  }
  inBox(p) { const b = this.box; return this.px[p] >= b.xmin && this.px[p] <= b.xmax && this.py[p] >= b.ymin && this.py[p] <= b.ymax; }
  color(p) { return this.flows[this.fi[p]]?.color || [1, 1, 1]; }
}

// =====================================================================================================
// Wind around buildings and trees on the site — a quick approximation for early design, not a CFD study.
//   • Direction: 2D potential flow around the buildings (stream function, solid footprints) — streaks bend around
//     them and speed up past corners. Trees are porous: they don't turn the flow, they slow it.
//   • Shelter: wind speed behind an obstacle as a share of open wind, from the windbreak measurements in
//     J. R. Brandle, X. Zhou & L. Hodges, "How Windbreaks Work", University of Nebraska–Lincoln Extension EC1763,
//     Figure 2 (5H…30H downwind of a windbreak of height H). Those are for long windbreaks across the wind; how much a
//     lone tree or a short building counts is scaled by how much of a crosswind window ±H wide it blocks — Claude's
//     rule of thumb, not from the source. Deciduous trees use the 25–35 % curve in winter (leafless) and the
//     40–60 % curve otherwise; evergreens the 40–60 % curve; buildings the solid-fence curve (assumptions).
//   • Faces: ASCE 7 external pressure coefficients for walls (windward +0.8, side walls −0.7, leeward −0.5 for
//     L/B ≤ 1) and the exposure-B velocity-pressure profile Kz = 2.01 (z / 1200 ft)^(2/7), z ≥ 15 ft — values
//     quoted from memory, not checked against the standard (the app says so in its legend).
// =====================================================================================================
export const SHELTER = {
  deciduous: { label: 'Deciduous, 25–35 % dense', s: [0.50, 0.65, 0.80, 0.85, 1.00] },
  conifer: { label: 'Conifer, 40–60 % dense', s: [0.30, 0.50, 0.60, 0.75, 0.95] },
  dense: { label: 'Multi-row, 60–80 % dense', s: [0.25, 0.35, 0.65, 0.85, 0.95] },
  solid: { label: 'Solid fence, 100 %', s: [0.25, 0.70, 0.90, 0.95, 1.00] },
};
export const SHELTER_SRC = 'Brandle, Zhou & Hodges, "How Windbreaks Work", Univ. of Nebraska–Lincoln Extension EC1763, Fig. 2';
export const SHELTER_URL = 'https://extensionpubs.unl.edu/publication/ec1763/2006/pdf/view/ec1763-2006.pdf';
const SH_X = [5, 10, 15, 20, 30];
const TYPES = [null, 'solid', 'conifer', 'deciduous'];
/** Share of open wind speed at x = distance / H behind a barrier of this type (the 5H value holds closer in). */
export function shelterAt(type, x) {
  const s = SHELTER[type].s;
  if (x <= SH_X[0]) return s[0];
  for (let i = 1; i < SH_X.length; i++) if (x <= SH_X[i]) { const t = (x - SH_X[i - 1]) / (SH_X[i] - SH_X[i - 1]); return s[i - 1] + (s[i] - s[i - 1]) * t; }
  return 1;
}
/** Wall pressure coefficient for a face whose outward normal is `deg` away from the direction the wind comes from
 *  (0 = facing the wind). ASCE 7 wall values; the blend between them is linear (Claude's choice). */
export function wallCp(deg) {
  const P = [[0, 0.8], [40, 0.8], [70, -0.7], [110, -0.7], [140, -0.5], [180, -0.5]];
  for (let i = 1; i < P.length; i++) if (deg <= P[i][0]) { const t = (deg - P[i - 1][0]) / (P[i][0] - P[i - 1][0]); return P[i - 1][1] + (P[i][1] - P[i - 1][1]) * t; }
  return -0.5;
}
/** Velocity pressure relative to 33 ft (10 m) above ground, exposure B (z in feet). */
export function kzRel(zFt) { const kz = z => 2.01 * Math.pow(Math.max(15, z) / 1200, 2 / 7); return kz(zFt) / kz(33); }

/**
 * The flow around obstacles over the site.
 * obstacles: [{ cells: (i, j) => height in native units or 0 — via ring/roofAt/tree below }]; built from
 *   { ring, base, top, roofAt? } buildings and { x, y, r, h, ev } trees (h in native units, like the ring).
 * opts: { box, winter, maxSide }
 */
export class WindFlow {
  constructor(box, buildings, trees, opts = {}) {
    const W0 = box.xmax - box.xmin, H0 = box.ymax - box.ymin, m = Math.max(W0, H0) * 0.3;
    const x0 = box.xmin - m, y0 = box.ymin - m, W = W0 + 2 * m, H = H0 + 2 * m;
    const N = opts.maxSide || 150, c = Math.max(W, H) / N;
    const nx = Math.ceil(W / c), ny = Math.ceil(H / c);
    Object.assign(this, { x0, y0, c, nx, ny, dirs: new Map() });
    const n = nx * ny, hgt = new Float32Array(n), typ = new Uint8Array(n);
    const inRing = (r, x, y) => { let k = false; for (let a = 0, b = r.length - 1; a < r.length; b = a++) { const [xa, ya] = r[a], [xb, yb] = r[b]; if ((ya > y) !== (yb > y) && x < (xb - xa) * (y - ya) / (yb - ya) + xa) k = !k; } return k; };
    for (const b of buildings) {
      const R = b.ring; if (!R?.length) continue;
      let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
      for (const [x, y] of R) { bx0 = Math.min(bx0, x); by0 = Math.min(by0, y); bx1 = Math.max(bx1, x); by1 = Math.max(by1, y); }
      const i0 = Math.max(0, Math.floor((bx0 - x0) / c)), i1 = Math.min(nx - 1, Math.floor((bx1 - x0) / c)), j0 = Math.max(0, Math.floor((by0 - y0) / c)), j1 = Math.min(ny - 1, Math.floor((by1 - y0) / c));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const x = x0 + (i + 0.5) * c, y = y0 + (j + 0.5) * c;
        if (!inRing(R, x, y)) continue;
        let top = b.top;
        if (b.roofAt) { const t = b.roofAt(x, y); if (!Number.isFinite(t)) continue; top = t; }
        const h = (top - b.base) * (b.hScale || 1), q = j * nx + i;
        if (h > 1e-3 && h > hgt[q] * (typ[q] === 1 ? 1 : 0)) { hgt[q] = h; typ[q] = 1; }
      }
    }
    for (const t of trees) {
      const i0 = Math.max(0, Math.floor((t.x - t.r - x0) / c)), i1 = Math.min(nx - 1, Math.floor((t.x + t.r - x0) / c)), j0 = Math.max(0, Math.floor((t.y - t.r - y0) / c)), j1 = Math.min(ny - 1, Math.floor((t.y + t.r - y0) / c));
      const tp = t.ev ? 2 : opts.winter ? 3 : 2;
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const q = j * nx + i; if (typ[q] === 1) continue;
        if (Math.hypot(x0 + (i + 0.5) * c - t.x, y0 + (j + 0.5) * c - t.y) > Math.max(t.r, c * 0.6)) continue;
        if (t.h > hgt[q]) { hgt[q] = t.h; typ[q] = tp; }
      }
    }
    // Solid footprints, grouped (each building keeps one streamline value).
    const lab = new Int32Array(n).fill(-1); let ncomp = 0; const stack = [];
    for (let q = 0; q < n; q++) {
      if (typ[q] !== 1 || lab[q] >= 0) continue;
      lab[q] = ncomp; stack.push(q);
      while (stack.length) { const p = stack.pop(), i = p % nx, j = (p / nx) | 0; for (const [a, b] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const ii = i + a, jj = j + b; if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue; const r = jj * nx + ii; if (typ[r] === 1 && lab[r] < 0) { lab[r] = ncomp; stack.push(r); } } }
      ncomp++;
    }
    Object.assign(this, { hgt, typ, lab, ncomp });
  }
  /** Wind toward grid azimuth: blowing FROM `fromDeg` (grid azimuth, degrees). Cached per 1°. */
  dir(fromDeg) {
    const key = Math.round(((fromDeg % 360) + 360) % 360);
    if (this.dirs.has(key)) return this.dirs.get(key);
    const { nx, ny, c, typ, hgt, lab, ncomp } = this, n = nx * ny, a = key * Math.PI / 180;
    const wx = -Math.sin(a), wy = -Math.cos(a);                     // the way it blows
    // Stream function: ψ = wx·y − wy·x in open air (u = ∂ψ/∂y, v = −∂ψ/∂x); constant inside each building.
    const psi = new Float32Array(n), fixed = new Uint8Array(n);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { const q = j * nx + i; psi[q] = wx * (j - ny / 2) - wy * (i - nx / 2); if (i === 0 || j === 0 || i === nx - 1 || j === ny - 1) fixed[q] = 1; }
    if (ncomp) {
      const sum = new Float64Array(ncomp), cnt = new Float64Array(ncomp);
      for (let q = 0; q < n; q++) if (lab[q] >= 0) { sum[lab[q]] += psi[q]; cnt[lab[q]]++; }
      for (let q = 0; q < n; q++) if (lab[q] >= 0) { psi[q] = sum[lab[q]] / cnt[lab[q]]; fixed[q] = 1; }
      const w = 1.9, iters = Math.max(200, Math.round(2.2 * Math.max(nx, ny)));
      for (let it = 0; it < iters; it++) for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
        const q = j * nx + i; if (fixed[q]) continue;
        psi[q] += w * ((psi[q - 1] + psi[q + 1] + psi[q - nx] + psi[q + nx]) / 4 - psi[q]);
      }
    }
    // Shelter: walk upwind from each cell; each obstacle met at distance d (height H) slows it to the windbreak curve,
    // weighted by how much of a crosswind window ±H wide around that point is blocked.
    const block = new Float32Array(n);
    for (let q = 0; q < n; q++) {
      if (!typ[q]) continue;
      const i = q % nx, j = (q / nx) | 0, hc = Math.max(1, Math.min(30, Math.round(hgt[q] / c)));
      let k = 0, tot = 0;
      for (let s = -hc; s <= hc; s++) { const ii = Math.round(i - wy * s), jj = Math.round(j + wx * s); tot++; if (ii >= 0 && jj >= 0 && ii < nx && jj < ny && typ[jj * nx + ii]) k++; }
      block[q] = k / tot;
    }
    let hmax = 0; for (let q = 0; q < n; q++) if (hgt[q] > hmax) hmax = hgt[q];
    const maxSteps = Math.min(Math.ceil(30 * hmax / c), nx + ny);
    const S = new Float32Array(n), u = new Float32Array(n), v = new Float32Array(n);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const q = j * nx + i;
      if (typ[q] === 1) { S[q] = 0; continue; }
      S[q] = this._shelter(i + 0.5, j + 0.5, wx, wy, maxSteps, block, false);
      const P = (ii, jj) => psi[Math.max(0, Math.min(ny - 1, jj)) * nx + Math.max(0, Math.min(nx - 1, ii))];
      const solid = (ii, jj) => ii < 0 || jj < 0 || ii >= nx || jj >= ny || typ[jj * nx + ii] === 1;
      const dy = solid(i, j + 1) ? P(i, j) - P(i, j - 1) : solid(i, j - 1) ? P(i, j + 1) - P(i, j) : (P(i, j + 1) - P(i, j - 1)) / 2;
      const dx = solid(i + 1, j) ? P(i, j) - P(i - 1, j) : solid(i - 1, j) ? P(i + 1, j) - P(i, j) : (P(i + 1, j) - P(i - 1, j)) / 2;
      u[q] = dy; v[q] = -dx;
    }
    const d = { from: key, wx, wy, S, u, v, block, maxSteps };
    this.dirs.set(key, d);
    return d;
  }
  /** Share of open wind at cell coords (fi, fj) for wind (wx, wy); skipOwn: ignore the obstacle the point sits against. */
  _shelter(fi, fj, wx, wy, maxSteps, block, skipOwn) {
    const { nx, ny, c, typ, hgt } = this;
    let best = 1, own = skipOwn;
    for (let s = 1; s <= maxSteps; s++) {
      const i = Math.floor(fi - wx * s), j = Math.floor(fj - wy * s);
      if (i < 0 || j < 0 || i >= nx || j >= ny) break;
      const q = j * nx + i, t = typ[q];
      if (own) { if (t && s <= 3) continue; if (!t) { if (s > 3) own = false; continue; } own = false; }
      if (!t) continue;
      const f = block[q], val = 1 - f * (1 - shelterAt(TYPES[t], s * c / Math.max(c, hgt[q])));
      if (val < best) best = val;
    }
    return best;
  }
  /** Shelter at a native point for direction d (for building faces: skips the face's own building). */
  shelterAtPoint(d, x, y, skipOwn = true) { return this._shelter((x - this.x0) / this.c, (y - this.y0) / this.c, d.wx, d.wy, d.maxSteps, d.block, skipOwn); }
  /** Flow (open-wind = 1) at a native point: [u, v] or null inside a building. */
  vel(d, x, y) {
    const fi = (x - this.x0) / this.c - 0.5, fj = (y - this.y0) / this.c - 0.5;
    const i = Math.floor(fi), j = Math.floor(fj);
    if (i < 0 || j < 0 || i >= this.nx - 1 || j >= this.ny - 1) return [d.wx, d.wy];
    const q = j * this.nx + i, tx = fi - i, ty = fj - j;
    const ii = Math.round(fi), jj = Math.round(fj); if (this.typ[jj * this.nx + ii] === 1) return null;
    const L = (A) => (A[q] * (1 - tx) + A[q + 1] * tx) * (1 - ty) + (A[q + this.nx] * (1 - tx) + A[q + this.nx + 1] * tx) * ty;
    const s = L(d.S);
    return [L(d.u) * s, L(d.v) * s];
  }
  /** Ground speed / open wind per cell, weighted over flows [{ from (grid deg), w }]. */
  groundRatio(flows) {
    const n = this.nx * this.ny, out = new Float32Array(n); let W = 0;
    for (const f of flows) {
      const d = this.dir(f.from); W += f.w;
      for (let q = 0; q < n; q++) out[q] += f.w * Math.hypot(d.u[q], d.v[q]) * d.S[q];
    }
    if (W) for (let q = 0; q < n; q++) out[q] /= W;
    for (let q = 0; q < n; q++) if (this.typ[q] === 1) out[q] = NaN;
    return out;
  }
}
