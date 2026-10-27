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

/** Lit mask of the raster cells (1 = sun, 0 = shade) for one sun position. */
export function shadeRaster(R, sv) {
  const out = new Uint8Array(R.nx * R.ny);
  if (sv.alt <= 0) return out;
  for (let j = 0; j < R.ny; j++) for (let i = 0; i < R.nx; i++) {
    const q = j * R.nx + i;
    // A hair above the surface (output units) so flat roofs and ground don't shade themselves.
    out[q] = litAt(R, sv, R.x0 + i * R.s, R.y0 + j * R.s, R.H[q] + 0.15, R.s * 0.75) ? 1 : 0;
  }
  return out;
}

/**
 * Hours of direct sun on each raster cell and each building triangle over the local day of `day`, in steps of
 * `stepMin` minutes. tris: flat [x,y,z × 3 …] (native XY, output Z) — the same array the 3D view draws.
 * Calls onProgress(fraction) and yields to the page between time steps. Returns { cells, tris, steps, hoursMax }.
 */
export async function sunHours(R, tris, day, site, { stepMin = 15, onProgress, isStale } = {}) {
  const { lat, lng } = site.center, k = site.toOut;
  const { rise, set } = sunTimes(day, lat, lng);
  const cells = new Float32Array(R.nx * R.ny);
  const nT = tris ? tris.length / 9 : 0, tH = new Float32Array(nT);
  if (!rise || !set) return { cells, tris: tH, steps: 0, hoursMax: 0 };
  // Triangle centroids and normals (normal flipped to point up / outward is not knowable for walls, so both sides
  // are tried: a face is lit if the side facing the sun is unobstructed).
  const C = new Float32Array(nT * 3), N = new Float32Array(nT * 3);
  for (let t = 0; t < nT; t++) {
    const o = t * 9;
    const ax = tris[o], ay = tris[o + 1], az = tris[o + 2] / k, bx = tris[o + 3], by = tris[o + 4], bz = tris[o + 5] / k, cx = tris[o + 6], cy = tris[o + 7], cz = tris[o + 8] / k;
    C[t * 3] = (ax + bx + cx) / 3; C[t * 3 + 1] = (ay + by + cy) / 3; C[t * 3 + 2] = (tris[o + 2] + tris[o + 5] + tris[o + 8]) / 3;
    const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const L = Math.hypot(nx, ny, nz) || 1; nx /= L; ny /= L; nz /= L;
    if (nz < 0) { nx = -nx; ny = -ny; nz = -nz; }                 // roofs: point up
    N[t * 3] = nx; N[t * 3 + 1] = ny; N[t * 3 + 2] = nz;
  }
  const steps = [];
  for (let t = rise.getTime(); t <= set.getTime(); t += stepMin * 6e4) steps.push(new Date(t));
  const dt = stepMin / 60;
  let lastYield = performance.now();
  for (let si = 0; si < steps.length; si++) {
    if (isStale?.()) return null;
    const pos = sunPosition(steps[si], lat, lng);
    if (pos.alt > 0.5) {
      const sv = sunVector(pos, site.convergence || 0, k);
      const lit = shadeRaster(R, sv);
      for (let q = 0; q < lit.length; q++) if (lit[q]) cells[q] += dt;
      // Sun direction in native-XY / native-Z terms for the facing test.
      const ca = Math.cos(pos.alt * RAD), sx = sv.dx * ca, sy = sv.dy * ca, sz = Math.sin(pos.alt * RAD);
      for (let t = 0; t < nT; t++) {
        let nx = N[t * 3], ny = N[t * 3 + 1], nz = N[t * 3 + 2];
        let dot = nx * sx + ny * sy + nz * sz;
        if (nz < 0.05) { if (dot < 0) { nx = -nx; ny = -ny; dot = -dot; } }   // walls: the side toward the sun
        if (dot <= 0.02) continue;
        // Start just off the face (out of the building it belongs to) and march toward the sun.
        const off = R.s * 1.6, x = C[t * 3] + nx * off, y = C[t * 3 + 1] + ny * off;
        if (litAt(R, sv, x, y, C[t * 3 + 2] + 0.1, R.s * 0.5)) tH[t] += dt;
      }
    }
    onProgress?.((si + 1) / steps.length);
    if (performance.now() - lastYield > 120) { await new Promise(r => setTimeout(r, 0)); lastYield = performance.now(); }
  }
  return { cells, tris: tH, steps: steps.length, hoursMax: (set - rise) / 36e5 };
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
