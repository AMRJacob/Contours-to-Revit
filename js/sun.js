// Sun: position in the sky, shadows cast by the terrain and the building masses, and hours of direct sun over a day.
// View only — nothing here is exported.
//
// Sun position: NOAA's solar equations (the ones behind NOAA's solar calculator) — accurate to well under a degree,
// plenty for shadows. Azimuth is clockwise from true north; the site's grid convergence turns it to grid north.
//
// Shadows: a height raster of the ground with the building roofs burned in (about 1–2 m cells, at most 360 per side).
// A point is in shade when, marching from it toward the sun, the raster rises above the sun's ray. The march stops
// once the ray clears the highest point on the site, so it is quick except with the sun very low.

const RAD = Math.PI / 180;

/** Sun position for a Date at lat/lon (degrees, west negative). Returns { az, alt } in degrees (az from true north). */
export function sunPosition(date, lat, lon) {
  const jd = date.getTime() / 864e5 + 2440587.5;
  const T = (jd - 2451545) / 36525;
  const L0 = (280.46646 + T * (36000.76983 + T * 0.0003032)) % 360;
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
  const C = Math.sin(M * RAD) * (1.914602 - T * (0.004817 + 0.000014 * T)) + Math.sin(2 * M * RAD) * (0.019993 - 0.000101 * T) + Math.sin(3 * M * RAD) * 0.000289;
  const trueLong = L0 + C;
  const omega = 125.04 - 1934.136 * T;
  const lambda = trueLong - 0.00569 - 0.00478 * Math.sin(omega * RAD);
  const eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(omega * RAD);
  const decl = Math.asin(Math.sin(eps * RAD) * Math.sin(lambda * RAD));
  const y = Math.tan(eps * RAD / 2) ** 2;
  const eqTime = 4 / RAD * (y * Math.sin(2 * L0 * RAD) - 2 * e * Math.sin(M * RAD) + 4 * e * y * Math.sin(M * RAD) * Math.cos(2 * L0 * RAD)
    - 0.5 * y * y * Math.sin(4 * L0 * RAD) - 1.25 * e * e * Math.sin(2 * M * RAD));            // minutes
  const utcMin = date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60;
  let tst = (utcMin + eqTime + 4 * lon) % 1440; if (tst < 0) tst += 1440;                   // true solar time
  const ha = (tst / 4 < 0 ? tst / 4 + 180 : tst / 4 - 180) * RAD;                           // hour angle
  const latR = lat * RAD;
  const cosZ = Math.sin(latR) * Math.sin(decl) + Math.cos(latR) * Math.cos(decl) * Math.cos(ha);
  const zen = Math.acos(Math.max(-1, Math.min(1, cosZ)));
  let az = Math.atan2(Math.sin(ha), Math.cos(ha) * Math.sin(latR) - Math.tan(decl) * Math.cos(latR)) / RAD + 180;
  az = (az + 360) % 360;
  let alt = 90 - zen / RAD;
  // Atmospheric refraction (lifts the sun slightly near the horizon).
  if (alt > -0.575 && alt < 85) {
    const te = Math.tan(alt * RAD);
    alt += (alt > 5 ? 58.1 / te - 0.07 / te ** 3 + 0.000086 / te ** 5 : alt > -0.575 ? 1735 + alt * (-518.2 + alt * (103.4 + alt * (-12.79 + alt * 0.711))) : -20.774 / te) / 3600;
  }
  return { az, alt };
}

/** Sunrise and sunset (Dates) on the local calendar day of `day`, found by scanning; null if none. */
export function sunTimes(day, lat, lon) {
  const d0 = new Date(day); d0.setHours(0, 0, 0, 0);
  let rise = null, set = null, prev = sunPosition(d0, lat, lon).alt;
  for (let m = 5; m <= 1440; m += 5) {
    const t = new Date(d0.getTime() + m * 6e4), a = sunPosition(t, lat, lon).alt;
    if (prev < -0.833 && a >= -0.833 && !rise) rise = t;
    if (prev >= -0.833 && a < -0.833) set = t;
    prev = a;
  }
  return { rise, set };
}

const compass = az => ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'][Math.round(az / 22.5) % 16];
export { compass };

/**
 * Height raster: the ground (site.grid, output units) with the roofs of the given buildings burned in.
 * Returns { x0, y0, s, nx, ny, H, bld (cell -> 1 + building index, 0 = ground), max }; x0/y0/s in native units.
 */
export function heightRaster(site, buildings, maxSide = 360) {
  const g = site.grid;
  const step = Math.max(1, Math.ceil(Math.max(g.nx, g.ny) / maxSide));
  const nx = Math.floor((g.nx - 1) / step) + 1, ny = Math.floor((g.ny - 1) / step) + 1, s = g.s * step;
  const H = new Float32Array(nx * ny), bld = new Int32Array(nx * ny);
  let lo = Infinity;
  for (const v of g.z) if (Number.isFinite(v) && v < lo) lo = v;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const v = g.z[j * step * g.nx + i * step];
    H[j * nx + i] = Number.isFinite(v) ? v : lo;
  }
  const inRing = (R, x, y) => { let c = false; for (let a = 0, b = R.length - 1; a < R.length; b = a++) { const [xa, ya] = R[a], [xb, yb] = R[b]; if ((ya > y) !== (yb > y) && x < (xb - xa) * (y - ya) / (yb - ya) + xa) c = !c; } return c; };
  buildings.forEach((b, bi) => {
    const R = b.massRing || b.ring;
    if (!R || R.length < 3) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of R) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    const i0 = Math.max(0, Math.floor((x0 - g.x0) / s)), i1 = Math.min(nx - 1, Math.ceil((x1 - g.x0) / s));
    const j0 = Math.max(0, Math.floor((y0 - g.y0) / s)), j1 = Math.min(ny - 1, Math.ceil((y1 - g.y0) / s));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const x = g.x0 + i * s, y = g.y0 + j * s;
      if (!inRing(R, x, y)) continue;
      const z = b.roofAt ? b.roofAt(x, y) : b.top;
      const q = j * nx + i;
      if (Number.isFinite(z) && z > H[q]) { H[q] = z; bld[q] = bi + 1; }
    }
  });
  let max = -Infinity;
  for (const v of H) if (v > max) max = v;
  return { x0: g.x0, y0: g.y0, s, nx, ny, H, bld, max };
}

/**
 * Direction toward the sun in native (grid) coordinates: { dx, dy } unit vector and rise per native unit of
 * horizontal distance, in output units (k = output per native). conv = grid convergence (true north is conv°
 * east of grid north when positive).
 */
export function sunVector(pos, conv, k) {
  const a = (pos.az + conv) * RAD;                       // azimuth from grid north
  return { dx: Math.sin(a), dy: Math.cos(a), rise: Math.tan(Math.max(0.5, pos.alt) * RAD) * k, alt: pos.alt };
}

/** Is the point (x, y native; z output units) lit? Marches toward the sun over the raster; skip = native distance to skip first. */
export function litAt(R, sv, x, y, z, skip = 0) {
  if (sv.alt <= 0) return false;
  const st = R.s * 0.7;
  for (let d = Math.max(st, skip); ; d += st) {
    const ray = z + sv.rise * d;
    if (ray > R.max) return true;
    const fi = (x + sv.dx * d - R.x0) / R.s, fj = (y + sv.dy * d - R.y0) / R.s;
    if (fi < 0 || fj < 0 || fi > R.nx - 1 || fj > R.ny - 1) return true;     // left the site: nothing known beyond
    const h = R.H[Math.round(fj) * R.nx + Math.round(fi)];
    if (h > ray) return false;
  }
}

/** Ground sampling step so the evaluated cells stay under maxEval (shadows still march over the full raster). */
export function strideFor(R, maxEval = 120000) { return Math.max(1, Math.ceil(Math.sqrt(R.nx * R.ny / maxEval))); }

/**
 * Lit mask (1 = sun, 0 = shade) on every `stride`-th raster cell for one sun position.
 * Returns { lit, nx, ny, stride } — the mask grid is nx × ny, cell (i, j) at raster cell (i·stride, j·stride).
 */
export function shadeRaster(R, sv, stride = 1) {
  const nx = Math.floor((R.nx - 1) / stride) + 1, ny = Math.floor((R.ny - 1) / stride) + 1;
  const lit = new Uint8Array(nx * ny);
  if (sv.alt > 0) {
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const ri = i * stride, rj = j * stride;
      // A hair above the surface (output units) so flat roofs and ground don't shade themselves.
      lit[j * nx + i] = litAt(R, sv, R.x0 + ri * R.s, R.y0 + rj * R.s, R.H[rj * R.nx + ri] + 0.15, R.s * 0.75) ? 1 : 0;
    }
  }
  return { lit, nx, ny, stride };
}

/**
 * Points on building roofs and walls to test, from the building triangles: every triangle is split into a grid of
 * small triangles about `d` across (d grows on big sites so there are at most maxPts points), so a shadow line
 * falling partway across a roof or wall shows. trisTrue / trisShown: the same triangles (flat [x, y, z × 3 …],
 * native XY, output Z) at true height and as the 3D view draws them (heights scaled for exaggeration).
 * Returns { P (true positions), N (unit normals, roofs up), S (shown positions), idx (triangles), n }.
 */
export function surfaceSamples(trisTrue, trisShown, k, { d = 2, maxPts = 180000 } = {}) {
  const nT = trisTrue.length / 9;
  const V = o => [trisTrue[o], trisTrue[o + 1], trisTrue[o + 2] / k];    // z in native units for geometry
  let area = 0;
  for (let t = 0; t < nT; t++) {
    const [ax, ay, az] = V(t * 9), [bx, by, bz] = V(t * 9 + 3), [cx, cy, cz] = V(t * 9 + 6);
    const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
    area += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
  }
  d = Math.max(d, Math.sqrt(area * 2.2 / maxPts));
  const P = [], N = [], S = [], idx = [];
  for (let t = 0; t < nT; t++) {
    const o = t * 9;
    const A = V(o), B = V(o + 3), C = V(o + 6);
    const ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2], vx = C[0] - A[0], vy = C[1] - A[1], vz = C[2] - A[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const L = Math.hypot(nx, ny, nz);
    if (L < 1e-9) continue;
    nx /= L; ny /= L; nz /= L;
    if (nz < 0) { nx = -nx; ny = -ny; nz = -nz; }
    const edge = Math.max(Math.hypot(ux, uy, uz), Math.hypot(vx, vy, vz), Math.hypot(C[0] - B[0], C[1] - B[1], C[2] - B[2]));
    const n = Math.max(1, Math.min(200, Math.ceil(edge / d)));
    const base = P.length / 3;
    // Barycentric grid: row r has n - r + 1 points; the same weights place the shown copy.
    for (let r = 0; r <= n; r++) for (let c = 0; c <= n - r; c++) {
      const wb = c / n, wc = r / n, wa = 1 - wb - wc;
      for (let q = 0; q < 3; q++) {
        P.push(trisTrue[o + q] * wa + trisTrue[o + 3 + q] * wb + trisTrue[o + 6 + q] * wc);
        S.push(trisShown[o + q] * wa + trisShown[o + 3 + q] * wb + trisShown[o + 6 + q] * wc);
      }
      N.push(nx, ny, nz);
    }
    const id = (r, c) => base + r * (n + 1) - (r * (r - 1)) / 2 + c;
    for (let r = 0; r < n; r++) for (let c = 0; c < n - r; c++) {
      idx.push(id(r, c), id(r, c + 1), id(r + 1, c));
      if (c < n - r - 1) idx.push(id(r, c + 1), id(r + 1, c + 1), id(r + 1, c));
    }
  }
  return { P: Float32Array.from(P), N: Float32Array.from(N), S: Float32Array.from(S), idx: Uint32Array.from(idx), n: P.length / 3, d };
}

/**
 * Hours of direct sun over the local day of `day` (every `stepMin` minutes, sunrise to sunset) on the ground
 * (every `stride`-th raster cell) and on building surface points (from surfaceSamples). Yields to the page now and
 * then; onProgress(fraction). Returns { cells, nx, ny, stride, pts (hours per surface point), steps, hoursMax }
 * or null if isStale() turned true.
 */
export async function sunHours(R, samples, day, site, { stepMin = 15, stride = 1, onProgress, isStale } = {}) {
  const { lat, lng } = site.center, k = site.toOut;
  const { rise, set } = sunTimes(day, lat, lng);
  const gnx = Math.floor((R.nx - 1) / stride) + 1, gny = Math.floor((R.ny - 1) / stride) + 1;
  const cells = new Float32Array(gnx * gny);
  const nP = samples ? samples.n : 0, pts = new Float32Array(nP);
  if (!rise || !set) return { cells, nx: gnx, ny: gny, stride, pts, steps: 0, hoursMax: 0 };
  const steps = [];
  for (let t = rise.getTime(); t <= set.getTime(); t += stepMin * 6e4) steps.push(new Date(t));
  const dt = stepMin / 60, off = R.s * 0.6;
  let lastYield = performance.now();
  for (let si = 0; si < steps.length; si++) {
    if (isStale?.()) return null;
    const pos = sunPosition(steps[si], lat, lng);
    if (pos.alt > 0.5) {
      const sv = sunVector(pos, site.convergence || 0, k);
      const g = shadeRaster(R, sv, stride);
      for (let q = 0; q < g.lit.length; q++) if (g.lit[q]) cells[q] += dt;
      // Sun direction with the vertical in native units (k converts output → native via / k).
      const ca = Math.cos(pos.alt * RAD), sx = sv.dx * ca, sy = sv.dy * ca, sz = Math.sin(pos.alt * RAD);
      const P = samples?.P, N = samples?.N;
      for (let v = 0; v < nP; v++) {
        let nx = N[v * 3], ny = N[v * 3 + 1];
        const nz = N[v * 3 + 2];
        let dot = nx * sx + ny * sy + nz * sz;
        if (nz < 0.2 && dot < 0) { nx = -nx; ny = -ny; dot = nx * sx + ny * sy + nz * sz; }   // walls: the side toward the sun
        if (dot <= 0.02) continue;
        // Start just off the surface on the sunny side, skip the cell it sits in, march toward the sun.
        if (litAt(R, sv, P[v * 3] + nx * off, P[v * 3 + 1] + ny * off, P[v * 3 + 2] + 0.2 + nz * 0.2, R.s * 0.9)) pts[v] += dt;
      }
    }
    onProgress?.((si + 1) / steps.length);
    if (performance.now() - lastYield > 120) { await new Promise(r => setTimeout(r, 0)); lastYield = performance.now(); }
  }
  return { cells, nx: gnx, ny: gny, stride, pts, steps: steps.length, hoursMax: (set - rise) / 36e5 };
}

/** Colour ramp for sun hours, 0 (deep blue-violet) → max (warm yellow). Returns [r, g, b] in 0–1. */
export function hoursColor(f) {
  const stops = [[0, [0.18, 0.16, 0.42]], [0.25, [0.27, 0.35, 0.75]], [0.5, [0.2, 0.68, 0.62]], [0.75, [0.95, 0.72, 0.25]], [1, [1, 0.95, 0.55]]];
  f = Math.max(0, Math.min(1, f));
  for (let i = 1; i < stops.length; i++) if (f <= stops[i][0]) {
    const [a, ca] = stops[i - 1], [b, cb] = stops[i], t = (f - a) / (b - a);
    return [ca[0] + (cb[0] - ca[0]) * t, ca[1] + (cb[1] - ca[1]) * t, ca[2] + (cb[2] - ca[2]) * t];
  }
  return stops[stops.length - 1][1];
}
