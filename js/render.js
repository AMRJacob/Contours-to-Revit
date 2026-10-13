// Canvas rendering for the on-screen preview and the printable PNG contour map.
import { labelPositions, isMajor } from './contours.js?v=0.5.6';

/** Hillshade (0..1) for a grid; azimuth 315°, altitude 45°. */
export function hillshade(g, zFactor = 1) {
  const { nx, ny, z, s } = g;
  const out = new Float32Array(nx * ny);
  // Light from azimuth 315° (north-west), 45° altitude; x east, y north, z up.
  const az = 315 * Math.PI / 180, alt = 45 * Math.PI / 180;
  const Lx = Math.cos(alt) * Math.sin(az), Ly = Math.cos(alt) * Math.cos(az), Lz = Math.sin(alt);
  const at = (i, j) => {
    i = Math.max(0, Math.min(nx - 1, i)); j = Math.max(0, Math.min(ny - 1, j));
    const v = z[j * nx + i];
    return Number.isNaN(v) ? z[Math.max(0, Math.min(ny - 1, j)) * nx + Math.max(0, Math.min(nx - 1, i))] : v;
  };
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const dzdx = ((at(i + 1, j + 1) + 2 * at(i + 1, j) + at(i + 1, j - 1)) - (at(i - 1, j + 1) + 2 * at(i - 1, j) + at(i - 1, j - 1))) / (8 * s);
      const dzdy = ((at(i - 1, j + 1) + 2 * at(i, j + 1) + at(i + 1, j + 1)) - (at(i - 1, j - 1) + 2 * at(i, j - 1) + at(i + 1, j - 1))) / (8 * s);
      const gx = zFactor * dzdx, gy = zFactor * dzdy;
      const v = (-gx * Lx - gy * Ly + Lz) / Math.sqrt(gx * gx + gy * gy + 1);
      out[j * nx + i] = Number.isFinite(v) ? Math.max(0, v) : 0.7;
    }
  }
  return out;
}

const TINT = [[0, [52, 120, 84]], [0.25, [140, 172, 92]], [0.5, [222, 206, 128]], [0.75, [196, 140, 86]], [1, [238, 232, 226]]];
function tint(t) {
  for (let k = 1; k < TINT.length; k++) {
    if (t <= TINT[k][0]) {
      const [t0, a] = TINT[k - 1], [t1, b] = TINT[k];
      const u = (t - t0) / (t1 - t0);
      return a.map((c, i) => c + (b[i] - c) * u);
    }
  }
  return TINT[TINT.length - 1][1];
}

/** Offscreen canvas of the terrain: hillshade alone (for blending over imagery) or tinted. */
function terrainCanvas(g, shade, stats, tinted) {
  const c = document.createElement('canvas');
  c.width = g.nx; c.height = g.ny;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(g.nx, g.ny);
  const range = (stats.max - stats.min) || 1;
  for (let j = 0; j < g.ny; j++) {
    for (let i = 0; i < g.nx; i++) {
      const src = j * g.nx + i;
      const dst = ((g.ny - 1 - j) * g.nx + i) * 4;
      const h = shade[src];
      const zv = g.z[src];
      if (tinted) {
        const [r, gg, b] = tint(Number.isNaN(zv) ? 0 : (zv - stats.min) / range);
        const k = 0.45 + 0.65 * h;
        img.data[dst] = Math.min(255, r * k); img.data[dst + 1] = Math.min(255, gg * k); img.data[dst + 2] = Math.min(255, b * k);
        img.data[dst + 3] = Number.isNaN(zv) ? 0 : 255;
      } else {
        const v = Math.round(255 * Math.min(1, 0.35 + 0.75 * h));
        img.data[dst] = v; img.data[dst + 1] = v; img.data[dst + 2] = v; img.data[dst + 3] = 255;
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function niceLength(target) {
  const steps = [1, 2, 2.5, 5];
  const p = Math.pow(10, Math.floor(Math.log10(target)));
  let best = p;
  for (const s of steps) if (s * p <= target) best = s * p;
  return best;
}

/**
 * Draw the contour map.
 * site: { grid (smoothed contour grid, native units), stats, contours, interval, zone, toOut (native->output scale),
 *         outUnit ('ft'|'m'), imagery (ImageBitmap|null), convergence, meta {title lines}, tinted }
 * mode: 'preview' (fills canvas, no title block) or 'print'
 */
export function drawMap(canvas, site, mode = 'preview') {
  const g = site.grid;
  const xmin = g.x0, ymin = g.y0, xmax = g.x0 + (g.nx - 1) * g.s, ymax = g.y0 + (g.ny - 1) * g.s;
  const W = canvas.width, H = canvas.height;
  const print = mode === 'print';
  const pad = print ? Math.round(W * 0.03) : 0;
  const footer = print ? Math.round(W * 0.16) : 0;
  const availW = W - 2 * pad, availH = H - 2 * pad - footer;
  const k = Math.min(availW / (xmax - xmin), availH / (ymax - ymin));
  const mapW = (xmax - xmin) * k, mapH = (ymax - ymin) * k;
  const ox = pad + (availW - mapW) / 2, oy = pad + (availH - mapH) / 2;
  const X = x => ox + (x - xmin) * k;
  const Y = y => oy + (ymax - y) * k;
  const ctx = canvas.getContext('2d');
  const px = Math.max(1, W / 1400); // stroke scale

  ctx.fillStyle = print ? '#ffffff' : '#1d2124';
  ctx.fillRect(0, 0, W, H);

  // Terrain / imagery
  ctx.save();
  ctx.beginPath(); ctx.rect(ox, oy, mapW, mapH); ctx.clip();
  ctx.imageSmoothingEnabled = true;
  if (site.imagery && !site.tinted) {
    ctx.drawImage(site.imagery, ox, oy, mapW, mapH);
    ctx.globalCompositeOperation = 'multiply';
    ctx.globalAlpha = 0.55;
    ctx.drawImage(terrainCanvas(g, site.shade, site.stats, false), ox, oy, mapW, mapH);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  } else {
    ctx.drawImage(terrainCanvas(g, site.shade, site.stats, true), ox, oy, mapW, mapH);
  }

  // Contours
  const onImagery = site.imagery && !site.tinted;
  const v = site.vis || { contours: true, buildings: true, roads: true, parcels: true, flood: true, labels: true };
  if (v.labels === undefined) v.labels = true;
  const none = [];
  const minorCol = onImagery ? 'rgba(255,255,255,0.85)' : 'rgba(40,30,20,0.55)';
  const majorCol = onImagery ? '#ffb347' : 'rgba(60,30,10,0.95)';
  const halo = onImagery ? 'rgba(0,0,0,0.45)' : 'rgba(255,255,255,0.5)';
  const strokeLine = (line, width, color) => {
    ctx.beginPath();
    line.forEach(([x, y], i) => (i ? ctx.lineTo(X(x), Y(y)) : ctx.moveTo(X(x), Y(y))));
    ctx.lineWidth = width; ctx.strokeStyle = color; ctx.stroke();
  };
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  for (const pass of ['halo', 'line']) {
    for (const c of v.contours ? site.contours : none) {
      const major = isMajor(c.level, site.interval);
      const w = (major ? 2.2 : 1) * px;
      for (const line of c.lines) {
        if (pass === 'halo') strokeLine(line, w + 1.6 * px, halo);
        else strokeLine(line, w, major ? majorCol : minorCol);
      }
    }
  }

  // Site context: road edges/centerlines, then building footprints on top.
  if (site.context) {
    const path = (pts, close) => {
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i ? ctx.lineTo(X(x), Y(y)) : ctx.moveTo(X(x), Y(y))));
      if (close) ctx.closePath();
    };
    ctx.setLineDash([]);
    // FEMA flood zones: hatched (floodway cross-hatch, SFHA single hatch, shaded X sparse) with a solid boundary.
    const floodCol = onImagery ? '#8ec5ff' : '#1d4ed8';
    for (const z of v.flood ? site.context.floodZones || [] : none) {
      if (!z.sfha && !z.shadedX) continue;
      ctx.beginPath();
      for (const seg of z.hatch || []) { ctx.moveTo(X(seg[0][0]), Y(seg[0][1])); ctx.lineTo(X(seg[1][0]), Y(seg[1][1])); }
      // Thin, semi-transparent hatch so it reads without dominating; the boundary stays solid.
      ctx.globalAlpha = 0.85;
      ctx.lineWidth = (z.shadedX ? 0.7 : 0.9) * px; ctx.strokeStyle = floodCol; ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.beginPath();
      for (const r of z.rings) { r.forEach(([x, y], i) => (i ? ctx.lineTo(X(x), Y(y)) : ctx.moveTo(X(x), Y(y)))); ctx.closePath(); }
      ctx.lineWidth = 2 * px; ctx.strokeStyle = floodCol; ctx.stroke();
    }
    // Parcels: magenta property lines.
    for (const pc of v.parcels ? site.context.parcels || [] : none) {
      for (const l of pc.lines) { path(l); ctx.lineWidth = 1.4 * px; ctx.strokeStyle = onImagery ? '#ff4fd8' : '#a3157f'; ctx.stroke(); }
    }
    for (const r of v.roads ? site.context.roads : none) {
      for (const e of r.edges) { path(e); ctx.lineWidth = 1.4 * px; ctx.strokeStyle = onImagery ? 'rgba(255,224,102,0.95)' : 'rgba(90,70,20,0.9)'; ctx.stroke(); }
      path(r.center);
      ctx.setLineDash(r.kind === 'road' ? [10 * px, 6 * px] : [3 * px, 3 * px]);
      ctx.lineWidth = (r.kind === 'road' ? 1.6 : 1.2) * px;
      ctx.strokeStyle = r.kind === 'road' ? (onImagery ? 'rgba(255,224,102,0.8)' : 'rgba(90,70,20,0.7)') : (onImagery ? 'rgba(155,231,255,0.9)' : 'rgba(20,70,110,0.8)');
      ctx.stroke();
      ctx.setLineDash([]);
    }
    for (const b of v.buildings ? site.context.buildings : none) {
      path(b.ring, true);
      ctx.fillStyle = onImagery ? 'rgba(79,209,255,0.22)' : 'rgba(30,40,50,0.28)';
      ctx.fill();
      ctx.lineWidth = 1.8 * px;
      ctx.strokeStyle = onImagery ? '#4fd1ff' : '#1d2a33';
      ctx.stroke();
    }
  }

  // ---- Labels, placed with collision avoidance ----
  // Priority: flood zones, then parcels (nudged to a free spot, with a leader if moved), then contour labels
  // (slid along their contour to open space, or dropped). North arrow and scale bar areas are reserved.
  const placed = [];
  const hits = b => placed.some(o => b.x0 < o.x1 && b.x1 > o.x0 && b.y0 < o.y1 && b.y1 > o.y0);
  const inMap = b => b.x0 >= ox && b.x1 <= ox + mapW && b.y0 >= oy && b.y1 <= oy + mapH;
  placed.push({ x0: ox + mapW - 90 * px, x1: ox + mapW, y0: oy, y1: oy + 110 * px }); // north arrow
  placed.push({ x0: ox, x1: ox + 260 * px, y0: oy + mapH - 52 * px, y1: oy + mapH }); // scale bar
  // Rotated label -> axis-aligned box (pixels), with a little breathing room.
  const boxFor = (cx, cy, w, h, angDeg = 0) => {
    const a = angDeg * Math.PI / 180, c = Math.abs(Math.cos(a)), s2 = Math.abs(Math.sin(a));
    const hw = (w * c + h * s2) / 2 + 3 * px, hh = (w * s2 + h * c) / 2 + 2 * px;
    return { x0: cx - hw, x1: cx + hw, y0: cy - hh, y1: cy + hh };
  };
  const haloText = (text, cx, cy, fg, halo, angDeg = 0) => {
    ctx.save();
    ctx.translate(cx, cy);
    if (angDeg) ctx.rotate(-angDeg * Math.PI / 180);
    ctx.lineWidth = 3 * px; ctx.strokeStyle = halo; ctx.strokeText(text, 0, 0);
    ctx.fillStyle = fg; ctx.fillText(text, 0, 0);
    ctx.restore();
  };
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';

  if (site.context && v.labels) {
    const tags = [];
    for (const z of v.flood ? site.context.floodZones || [] : none) if ((z.sfha || z.shadedX) && z.label) tags.push({ text: z.text, x: z.label.x, y: z.label.y, fg: '#cfe0ff', size: print ? 12 : 10, lead: '#93b4ff' });
    for (const pc of v.parcels ? site.context.parcels || [] : none) if (pc.label && pc.id) tags.push({ text: pc.id, x: pc.label.x, y: pc.label.y, fg: '#ffd1f5', size: print ? 10 : 9, lead: '#ff9ce8' });
    for (const t of tags) {
      ctx.font = `600 ${Math.round(t.size * px)}px "IBM Plex Sans", system-ui, sans-serif`;
      const w = ctx.measureText(t.text).width, h = t.size * px * 1.25;
      const ax = X(t.x), ay = Y(t.y);
      // Try the anchor, then rings of offsets around it (below/above first, then sideways and diagonals).
      let spot = null;
      const dirs = [[0, 0], [0, 1], [0, -1], [1, 0], [-1, 0], [1, 1], [-1, 1], [1, -1], [-1, -1]];
      for (let ring = 0; ring <= 6 && !spot; ring++) {
        for (const [dx, dy] of dirs) {
          if (ring === 0 && (dx || dy)) continue;
          if (ring > 0 && !dx && !dy) continue;
          const cx = ax + dx * ring * (w * 0.6), cy = ay + dy * ring * h * 1.1;
          const b = boxFor(cx, cy, w, h);
          if (!hits(b) && inMap(b)) { spot = { cx, cy, b }; break; }
        }
      }
      if (!spot) spot = { cx: ax, cy: ay, b: boxFor(ax, ay, w, h) }; // nowhere free: keep it at its anchor
      if (Math.hypot(spot.cx - ax, spot.cy - ay) > h * 0.6) {
        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(spot.cx, spot.cy > ay ? spot.b.y0 + 2 * px : spot.b.y1 - 2 * px);
        ctx.lineWidth = 1.2 * px; ctx.strokeStyle = t.lead; ctx.setLineDash([3 * px, 2 * px]); ctx.stroke(); ctx.setLineDash([]);
        ctx.beginPath(); ctx.arc(ax, ay, 2.2 * px, 0, Math.PI * 2); ctx.fillStyle = t.lead; ctx.fill();
      }
      haloText(t.text, spot.cx, spot.cy, t.fg, 'rgba(0,0,0,0.7)');
      placed.push(spot.b);
    }
  }

  // Contour labels on index contours: candidates every third of the spacing; keep those that fit,
  // at least ~one spacing apart along each line.
  const fontPx = Math.round((print ? 13 : 11) * px);
  ctx.font = `600 ${fontPx}px "IBM Plex Sans", system-ui, sans-serif`;
  const spacingUnits = (print ? 420 : 300) * px / k;
  for (const c of v.contours && v.labels ? site.contours : none) {
    if (!isMajor(c.level, site.interval)) continue;
    const label = formatElev(c.level, site.interval);
    const w = ctx.measureText(label).width, h = fontPx * 1.1;
    for (const line of c.lines) {
      let last = null;
      for (const p of labelPositions(line, spacingUnits / 3, 60 * px / k)) {
        if (last && Math.hypot(p.x - last.x, p.y - last.y) < spacingUnits * 0.85) continue;
        const b = boxFor(X(p.x), Y(p.y), w, h, p.angle);
        if (hits(b) || !inMap(b)) continue;
        haloText(label, X(p.x), Y(p.y), onImagery ? '#ffffff' : '#2a1a0a', onImagery ? 'rgba(0,0,0,0.75)' : 'rgba(255,255,255,0.9)', p.angle);
        placed.push(b);
        last = p;
      }
    }
  }
  ctx.restore();

  // Frame
  ctx.strokeStyle = print ? '#222' : 'rgba(255,255,255,0.4)';
  ctx.lineWidth = px;
  ctx.strokeRect(ox, oy, mapW, mapH);

  drawNorthArrow(ctx, ox + mapW - 48 * px, oy + 60 * px, px, site.convergence, onImagery);
  drawScaleBar(ctx, ox + 18 * px, oy + mapH - 26 * px, k, px, site, onImagery);

  if (print) drawFooter(ctx, site, pad, H - footer - pad / 2, W - 2 * pad, footer, px);
  return { k, ox, oy, mapW, mapH };
}

export function formatElev(level, interval) {
  const dec = interval < 1 ? 1 : 0;
  return level.toFixed(dec);
}

function drawNorthArrow(ctx, cx, cy, px, conv, dark) {
  const r = 26 * px;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.fillStyle = dark ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.85)';
  ctx.beginPath(); ctx.arc(0, 0, r + 12 * px, 0, Math.PI * 2); ctx.fill();
  const fg = dark ? '#fff' : '#111';
  // Grid north (up)
  ctx.fillStyle = fg; ctx.strokeStyle = fg; ctx.lineWidth = 1.2 * px;
  ctx.beginPath(); ctx.moveTo(0, -r); ctx.lineTo(8 * px, 10 * px); ctx.lineTo(0, 4 * px); ctx.lineTo(-8 * px, 10 * px); ctx.closePath(); ctx.fill();
  ctx.font = `700 ${Math.round(11 * px)}px system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
  ctx.fillText('N', 0, -r - 1 * px);
  // True north (thin line rotated by convergence)
  if (Math.abs(conv) > 0.01) {
    ctx.save();
    ctx.rotate(conv * Math.PI / 180);
    ctx.setLineDash([3 * px, 2 * px]);
    ctx.beginPath(); ctx.moveTo(0, 8 * px); ctx.lineTo(0, -r + 4 * px); ctx.stroke();
    ctx.restore();
  }
  ctx.font = `500 ${Math.round(8.5 * px)}px system-ui, sans-serif`; ctx.textBaseline = 'top';
  ctx.fillText('GRID', 0, 13 * px);
  ctx.restore();
}

function drawScaleBar(ctx, x, y, k, px, site, dark) {
  const outPerNative = site.toOut;
  const unit = site.outUnit;
  const targetPx = 160 * px;
  const lenOut = niceLength((targetPx / k) * outPerNative);
  const lenPx = (lenOut / outPerNative) * k;
  ctx.save();
  ctx.fillStyle = dark ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.85)';
  ctx.fillRect(x - 8 * px, y - 22 * px, lenPx + 16 * px + 40 * px, 34 * px);
  const fg = dark ? '#fff' : '#111';
  ctx.fillStyle = fg; ctx.strokeStyle = fg; ctx.lineWidth = px;
  for (let i = 0; i < 4; i++) {
    const seg = lenPx / 4;
    if (i % 2 === 0) ctx.fillRect(x + i * seg, y, seg, 5 * px);
    ctx.strokeRect(x + i * seg, y, seg, 5 * px);
  }
  ctx.font = `500 ${Math.round(9.5 * px)}px system-ui, sans-serif`; ctx.textBaseline = 'bottom'; ctx.textAlign = 'center';
  ctx.fillText('0', x, y - 2 * px);
  ctx.fillText(`${lenOut / 2}`, x + lenPx / 2, y - 2 * px);
  ctx.textAlign = 'left';
  ctx.fillText(`${lenOut} ${unit === 'm' ? 'm' : 'ft'}`, x + lenPx - 6 * px, y - 2 * px);
  ctx.restore();
}

function drawFooter(ctx, site, x, y, w, h, px) {
  ctx.save();
  ctx.fillStyle = '#111';
  ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  ctx.font = `700 ${Math.round(24 * px)}px system-ui, sans-serif`;
  ctx.fillText(site.meta.title, x, y);
  ctx.font = `600 ${Math.round(16 * px)}px system-ui, sans-serif`;
  ctx.fillStyle = '#b3261e';
  ctx.fillText('PRELIMINARY — NOT SURVEY DATA. Bare-earth surface is interpolated under buildings and trees.', x, y + 34 * px);
  ctx.fillStyle = '#333';
  ctx.font = `400 ${Math.round(14 * px)}px system-ui, sans-serif`;
  let ly = y + 64 * px;
  const colW = w / 2;
  site.meta.lines.forEach((line, i) => {
    const col = i % 2, row = Math.floor(i / 2);
    ctx.fillText(line, x + col * colW, ly + row * 21 * px, colW - 10 * px);
  });
  ctx.restore();
}
