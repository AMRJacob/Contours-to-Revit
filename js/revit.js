// Contours to Revit — Revit plugin bridge.
// Inside the Revit 2026 plugin this page runs in a WebView2 window; window.chrome.webview carries messages to
// the plugin. All placement math lives here, so the web app can change without reinstalling the plugin: the plugin
// receives points, outlines and positions already in Revit internal feet, placed at the Project Base Point.

// ?host=mock simulates the plugin in an ordinary browser (for testing the panel and the numbers it sends).
const MOCK = /[?&]host=mock\b/.test(location.search);
const WV = MOCK ? mockHost() : (window.chrome?.webview || null);
export const IN_REVIT = !!WV;
const RELEASES = 'https://api.github.com/repos/AMRJacob/Contours-to-Revit/releases?per_page=30';
export const PLUGIN_DOWNLOAD = 'https://github.com/AMRJacob/Contours-to-Revit/releases/latest/download/ContoursToRevit-Setup.exe';
const FT_PER_M = 1 / 0.3048;

let api = null;          // functions and state handed over by app.js
let host = null;         // { version, revit, ... } from the plugin
let model = null;        // getModel result
let modelErr = '';
let latest = null;       // { version, url } newest plugin release
let busy = false;
let lastResult = null;
let changing = false;    // placement chooser reopened
let seq = 0;
const pending = new Map();

// ---------------------------------------------------------------- messaging
if (WV) {
  WV.addEventListener('message', e => {
    const m = e.data;
    if (!m || typeof m !== 'object') return;
    if (m.type === 'reply' && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      if (m.ok) p.res(m.result); else p.rej(new Error(m.error || 'Revit error'));
    } else if (m.type === 'event' && m.event === 'documentChanged') {
      lastResult = null; changing = false;
      refresh();
    }
  });
}

function call(type, data = {}, timeoutMs = 15 * 60 * 1000) {
  if (!WV) return Promise.reject(new Error('not running inside Revit'));
  const id = ++seq;
  return new Promise((res, rej) => {
    const t = setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('Revit did not answer — is a dialog open in Revit?')); } }, timeoutMs);
    pending.set(id, { res: v => { clearTimeout(t); res(v); }, rej: e => { clearTimeout(t); rej(e); } });
    WV.postMessage({ ...data, id, type });
  });
}

/** Send a Blob/Uint8Array/string to the plugin in base64 chunks; resolves to the file id. */
async function upload(data, label, onProgress) {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data)
    : data instanceof Uint8Array ? data : new Uint8Array(await data.arrayBuffer());
  const fid = `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  const CH = 1536 * 1024;
  const n = Math.max(1, Math.ceil(bytes.length / CH));
  for (let i = 0; i < n; i++) {
    await call('chunk', { fid, i, n, b64: b64(bytes.subarray(i * CH, Math.min(bytes.length, (i + 1) * CH))) }, 120000);
    onProgress?.(`Sending ${label} to Revit… ${Math.round((i + 1) / n * 100)}%`);
  }
  return fid;
}
function b64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}

// ---------------------------------------------------------------- helpers
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const json = s => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
const normDeg = a => { let x = ((a % 360) + 540) % 360 - 180; if (Math.abs(x) < 1e-9) x = 0; return x; };
const verCmp = (a, b) => { const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d; } return 0; };
const docKey = () => model?.doc?.key || '';
const optsKey = () => `c2r-revit:${docKey()}`;
function loadOpts() { try { return JSON.parse(localStorage.getItem(optsKey()) || '{}'); } catch { return {}; } }
function saveOpts(o) { try { localStorage.setItem(optsKey(), JSON.stringify(o)); } catch { /* ignore */ } }
const TOLS = { ft: [0.1, 0.25, 0.5, 1], m: [0.03, 0.08, 0.15, 0.3] };

function storedPlacement() { return json(model?.stored?.placement); }
function storedSnapshot() { return json(model?.stored?.snapshot); }
function tagged(role) { return (model?.elements || []).filter(e => e.role === role); }
function taggedOne(role) { return tagged(role)[0] || null; }

/** Output units (ft / m) → Revit internal feet. */
const kOf = site => site.units === 'm' ? FT_PER_M : 1;

/** The app's current placement, in a form that is stored in the model and compared later. */
function appPlacement(site) {
  const o = api.origin(site);
  const a = api.align;
  return {
    v: 1, zone: site.zone.code, units: site.units,
    origin: o ? { lat: o.lat, lon: o.lon, label: o.label || '' } : null,
    rot: a.rot || 0, datum: a.datum ?? null, northRef: a.northRef || 'grid',
  };
}

function placementDiffs(p, site) {
  if (!p) return [];
  const a = appPlacement(site);
  const out = [];
  if (p.zone !== a.zone) out.push(`coordinate zone (model: EPSG ${p.zone})`);
  if (p.units !== a.units) out.push(`units (model: ${p.units})`);
  if (p.origin && a.origin) {
    const [x1, y1] = api.toNative(site, p.origin), [x2, y2] = api.toNative(site, a.origin);
    if (Math.hypot(x1 - x2, y1 - y2) * site.toOut > 0.01) out.push('origin');
  } else if (!!p.origin !== !!a.origin) out.push('origin');
  if (Math.abs(normDeg((p.rot || 0) - (a.rot || 0))) > 0.0005) out.push('project north');
  if (Math.abs((p.datum ?? 0) - (a.datum ?? 0)) > 0.005 || (p.datum == null) !== (a.datum == null)) out.push('elevation datum');
  return out;
}

/** Put a placement (from the model) into the app: origin, project north, datum. */
function applyPlacement(p, site) {
  api.setPlacement({ origin: p.origin, rot: p.rot || 0, datum: p.datum ?? null, northRef: p.northRef || 'grid' });
  if (site && (p.zone !== site.zone.code || p.units !== site.units)) {
    api.setStatus(`This model's site uses State Plane EPSG ${p.zone} in ${p.units}. Change Topography › coordinate system / units to match, then Generate.`, true);
  }
}

/** Placement read from the model's own shared coordinates (assumes they are State Plane in this zone). */
function placementFromModel(site, northRef) {
  const ps = model.pbpShared, toUnits = site.units === 'm' ? 0.3048 : 1; // Revit feet → output units
  const xN = ps.ew * toUnits / site.toOut, yN = ps.ns * toUnits / site.toOut;   // native zone units
  const ll = api.fromNative(site, [xN, yN]);
  const [dx, dy] = model.sharedNorthDelta;
  const b = Math.atan2(dx, dy) * 180 / Math.PI;                                  // project north, clockwise from shared north
  const rot = normDeg(northRef === 'true' ? b + (site.convergence || 0) : b);
  const dist = api.distanceToSite(site, ll);                                     // feet from the site centre
  return { p: { v: 1, zone: site.zone.code, units: site.units, origin: { lat: ll.lat, lon: ll.lon, label: 'Project Base Point (from the model)' }, rot: Math.round(rot * 1e4) / 1e4, datum: Math.round(ps.elev * toUnits * 1000) / 1000, northRef }, dist };
}

const hasSharedCoords = () => model && (Math.abs(model.pbpShared.ew) > 1 || Math.abs(model.pbpShared.ns) > 1 || Math.abs(model.pbpShared.angle) > 1e-6 || Math.abs(model.pbpShared.elev) > 0.001);

// ---------------------------------------------------------------- surface points
/**
 * Adaptive thinning of a regular grid: a coarse lattice plus every node where the surface departs from the
 * coarse bilinear surface by more than `tol` (output units). Nodes next to gaps (polygon edge) are always kept.
 * Returns flat [x, y, z, ...] in native XY / output Z.
 */
function thin(g, tol, maxPts = 60000) {
  const { nx, ny, s, x0, y0, z } = g;
  const N = nx * ny;
  const k = Math.max(2, Math.round(Math.sqrt(N / 4000)));
  const keep = new Uint8Array(N);
  const isC = (i, n) => i % k === 0 || i === n - 1;
  const c0 = (i, n) => { const a = Math.floor(i / k) * k; return a >= n - 1 ? Math.max(0, n - 1 - k) : a; };
  const c1 = (a, n) => Math.min(a + k, n - 1);
  let t = tol, count = 0;
  for (let attempt = 0; attempt < 8; attempt++) {
    keep.fill(0); count = 0;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const id = j * nx + i, v = z[id];
      if (!Number.isFinite(v)) continue;
      if (isC(i, nx) && isC(j, ny)) { keep[id] = 1; count++; continue; }
      const i0 = c0(i, nx), i1 = c1(i0, nx), j0 = c0(j, ny), j1 = c1(j0, ny);
      const a = z[j0 * nx + i0], b = z[j0 * nx + i1], c = z[j1 * nx + i0], d = z[j1 * nx + i1];
      if (![a, b, c, d].every(Number.isFinite)) { keep[id] = 1; count++; continue; }
      const u = i1 > i0 ? (i - i0) / (i1 - i0) : 0, w = j1 > j0 ? (j - j0) / (j1 - j0) : 0;
      const zi = a * (1 - u) * (1 - w) + b * u * (1 - w) + c * (1 - u) * w + d * u * w;
      if (Math.abs(v - zi) > t) { keep[id] = 1; count++; }
    }
    if (count <= maxPts) break;
    t *= 1.6;
  }
  const out = new Float64Array(count * 3);
  let n = 0;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const id = j * nx + i;
    if (!keep[id]) continue;
    out[n++] = x0 + i * s; out[n++] = y0 + j * s; out[n++] = z[id];
  }
  return { pts: out, count, tol: t, coarse: k };
}

/** Native XY / output Z points → Revit internal feet at the Project Base Point. */
function toInternal(site, flat) {
  const k = kOf(site), d = api.datum(site), p = model.pbp;
  const out = new Array(flat.length);
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (let i = 0; i < flat.length; i += 3) {
    const [x, y] = api.outXY(site, flat[i], flat[i + 1]);
    const X = p.x + x * k, Y = p.y + y * k, Z = p.z + (flat[i + 2] - d) * k;
    out[i] = Math.round(X * 1e4) / 1e4; out[i + 1] = Math.round(Y * 1e4) / 1e4; out[i + 2] = Math.round(Z * 1e4) / 1e4;
    if (X < minx) minx = X; if (X > maxx) maxx = X; if (Y < miny) miny = Y; if (Y > maxy) maxy = Y;
  }
  return { pts: out, extent: [minx, miny, maxx, maxy] };
}

function profileOf(site) {
  if (!site.mask?.length) return null;
  const k = kOf(site), p = model.pbp;
  return site.mask.map(([x, y]) => { const [X, Y] = api.outXY(site, x, y); return [p.x + X * k, p.y + Y * k]; });
}

function surfaces(site, tol) {
  const ex = thin(site.grid, tol);
  const des = api.design(site);
  const pr = des ? thin(des.grid(), tol) : null;
  return { ex, pr, des };
}

// ---------------------------------------------------------------- UI
function ensurePanel() {
  if (!$('rv-settings')) {
    const box = document.createElement('div');
    box.id = 'rv-settings';
    const body = $('step-settings')?.querySelector('.step-body');
    if (body) { body.prepend(box); box.addEventListener('click', onClick); }
  }
  if ($('step-revit')) return;
  const sec = document.createElement('details');
  sec.className = 'step';
  sec.id = 'step-revit';
  sec.open = true;
  sec.dataset.tone = 'revit';
  sec.innerHTML = `<summary><span class="num">R</span><span class="st-title">Send to Revit</span><span class="st-sum" id="rv-sum"></span></summary><div class="step-body" id="rv-body"></div>`;
  const before = $('step-settings');
  before.parentNode.insertBefore(sec, before);
  sec.addEventListener('click', onClick);
  sec.addEventListener('change', onChange);
}

function renderSettings() {
  const box = $('rv-settings');
  if (!box) return;
  const u = host?.update, pend = u?.pending, busyU = /checking|downloading|installing/.test(u?.state || '');
  const cr = !!host?.compatibleRendering;
  box.innerHTML = `<h4 class="set-h">Revit plugin</h4>
    <p class="rv-ver">Running <strong>${esc(host?.version || '?')}</strong>${pend ? ` · <strong>${esc(pend)}</strong> installed — restart Revit to use it` : ''}</p>
    <button type="button" class="btn btn-primary btn-block" data-rv="check-update" ${busyU ? 'disabled' : ''}>${busyU ? 'Updating…' : 'Check for updates and install'}</button>
    ${updNote ? `<p class="hint rv-upd">${esc(updNote)}</p>` : ''}
    <p class="hint">Updates also install by themselves when Revit starts. Revit can stay open; a new version loads the next time Revit starts.</p>
    <button type="button" class="btn btn-block" data-rv="rendering">${cr ? 'Compatible rendering is on — turn off' : 'Map looks scrambled? Use compatible rendering'}</button>`;
}

function render() {
  renderSettings();
  const body = $('rv-body');
  if (!body) return;
  const site = api.site();
  const banner = updateBanner();
  if (!model?.doc) {
    $('rv-sum').textContent = model?.family ? '— family open' : '— no model';
    body.innerHTML = `${banner}<p class="hint">${modelErr ? esc(modelErr) : model?.family ? 'A family is active. Switch to a project model to send the site.' : 'Open a Revit project, then click Refresh.'}</p>
      <div class="align-row"><button type="button" class="btn btn-quiet" data-rv="refresh">Refresh</button></div>${footer()}`;
    return;
  }
  const snap = storedSnapshot();
  const snapBtn = snap ? `<button type="button" class="btn btn-quiet" data-rv="open-snap" title="Open the site and design that were last sent to this model">Open the site saved in this model</button>` : '';
  $('rv-sum').textContent = `— ${model.doc.title}`;
  if (!site) {
    body.innerHTML = `${banner}<p class="rv-model"><strong>${esc(model.doc.title)}</strong></p>
      <p class="hint">${snap ? 'This model already has a site from Contours to Revit. Open it to keep working on it, or draw a new boundary and Generate.' : 'Draw a boundary and click Generate, then send the site to this model.'}</p>
      <div class="align-row">${snapBtn}<button type="button" class="btn btn-quiet" data-rv="refresh">Refresh</button></div>${footer()}`;
    return;
  }
  const P = storedPlacement();
  if (!P || changing) { body.innerHTML = banner + placementChooser(site, P) + footer(); return; }
  body.innerHTML = banner + sendForm(site, P, snapBtn) + footer();
  updateCounts();
}

function footer() {
  const cr = !!host?.compatibleRendering;
  const pend = host?.update?.pending;
  return `<p class="hint rv-foot">Plugin ${esc(host?.version || '?')}${pend ? ` <strong>(${esc(pend)} installed — restart Revit)</strong>` : ''} · Revit ${esc(host?.revit || '?')}
    · <a href="#" data-rv="settings">Plugin settings &amp; updates</a></p>`;
}

function updateBanner() {
  const u = host?.update;
  if (renderNote) return `<div class="rv-banner">${esc(renderNote)}</div>`;
  if (u && /checking|downloading|installing/.test(u.state)) return `<div class="rv-banner">${{ checking: 'Checking for a plugin update…', downloading: 'Downloading the plugin update…', installing: 'Installing the plugin update…' }[u.state]}</div>`;
  if (u?.pending) return `<div class="rv-banner">Plugin ${esc(u.pending)} is installed — <strong>restart Revit</strong> to start using it.</div>`;
  if (u?.state === 'error' && u.error) return `<div class="rv-banner rv-banner-warn">${esc(u.error)} <button type="button" class="btn btn-xs" data-rv="update">Try again</button></div>`;
  const v = u?.latest || latest?.version;
  if (!v || !host?.version || verCmp(v, host.version) <= 0) return '';
  if (!u) return `<div class="rv-banner">Plugin update ${esc(v)} is available. <button type="button" class="btn btn-xs" data-rv="download">Download</button><span class="hint"> Run it, then restart Revit.</span></div>`;
  return `<div class="rv-banner">Plugin update ${esc(v)} is available. <button type="button" class="btn btn-xs" data-rv="update">Install now</button><span class="hint"> Revit stays open; the update loads when Revit restarts.</span></div>`;
}
let renderNote = '';
let updNote = '';

function fmtPlacement(p, site) {
  const u = p.units || site.units;
  const pn = !p.rot ? 'grid north up' : `${Math.abs(p.rot).toFixed(2)}° ${p.rot > 0 ? 'east' : 'west'} of grid north`;
  const dat = p.datum != null ? `elevation ${p.datum.toFixed(2)} = 0` : 'real elevations (no datum)';
  return `${esc(p.origin?.label || 'origin')} · project north ${pn} · ${dat}${u !== site.units ? ` · ${u}` : ''}`;
}

function placementChooser(site, P) {
  const a = appPlacement(site);
  const shared = hasSharedCoords();
  const fromModel = shared ? placementFromModel(site, api.align.northRef || 'grid') : null;
  const far = fromModel && fromModel.dist > 26400;
  const rv = api.revitValues(site);
  const pick = changing && P?.mode === 'shared' ? 'shared' : 'pbp';
  return `<p class="rv-model"><strong>${esc(model.doc.title)}</strong></p>
  <p class="rv-q">${P ? 'Change where the site goes in this model' : 'Where should the site go in this model?'}</p>
  <label class="rv-opt"><input type="radio" name="rv-place" value="pbp" ${pick === 'pbp' ? 'checked' : ''}>
    <span><strong>At the Project Base Point</strong> — the app's origin goes on the Project Base Point, its project north points up in Revit's plan, and its datum is elevation 0 there.
    <small class="rv-cur">Now: ${fmtPlacement(a, site)}. <a href="#" data-rv="goto-place">Change origin / north / datum</a></small>
    <label class="check rv-sub"><input type="checkbox" id="rv-setcoords" ${shared ? '' : 'checked'}>
      <span>Also set this model's shared coordinates there (Specify Coordinates at Point): N ${rv ? fmtN(rv.ns) : '—'}, E ${rv ? fmtN(rv.ew) : '—'}, elevation ${rv ? rv.elev.toFixed(2) : '—'}, ${esc(rv?.angText || '0°')} to ${api.align.northRef === 'true' ? 'true' : 'grid'} north.
      ${shared ? '<em class="rv-warn">This model already has shared coordinates; they would be replaced.</em>' : ''}</span></label>
    ${!a.origin ? '<small class="rv-warn">No origin is picked: the south-west corner of the site will be used. Pick a building corner first if you know it.</small>' : ''}
  </span></label>
  ${shared ? `<label class="rv-opt"><input type="radio" name="rv-place" value="shared" ${pick === 'shared' ? 'checked' : ''}>
    <span><strong>Use this model's shared coordinates</strong> — they already hold State Plane ${esc(site.zone.name || site.zone.code)} values, so the app takes its origin, project north and datum from the model.
    <small class="rv-cur">Model: Project Base Point at N ${fmtN(model.pbpShared.ns)}, E ${fmtN(model.pbpShared.ew)}, elevation ${model.pbpShared.elev.toFixed(2)}.</small>
    ${far ? `<small class="rv-warn">That point is ${(fromModel.dist / 5280).toFixed(1)} miles from the site — the model's coordinates probably aren't State Plane ${esc(site.zone.code)} ${esc(site.units)}.</small>` : ''}
    <span class="seg rv-north" role="radiogroup"><label><input type="radio" name="rv-mnorth" value="grid" ${api.align.northRef !== 'true' ? 'checked' : ''}><span>Model uses grid north</span></label><label><input type="radio" name="rv-mnorth" value="true" ${api.align.northRef === 'true' ? 'checked' : ''}><span>true north</span></label></span>
  </span></label>` : ''}
  <div class="align-row"><button type="button" class="btn btn-primary" data-rv="place-ok">${P ? 'Use this placement' : 'Continue'}</button>${P ? '<button type="button" class="btn btn-quiet" data-rv="place-cancel">Cancel</button>' : ''}</div>
  <p class="hint">Saved in the model, so every later send — by you or a coworker — lands in the same spot. You can change it later.</p>`;
}

const fmtN = v => Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function sendForm(site, P, snapBtn) {
  const o = { ...defaults(site), ...loadOpts() };
  const diffs = placementDiffs(P, site);
  const exist = taggedOne('existing'), prop = taggedOne('proposed'), img = taggedOne('aerial'), dxf = taggedOne('dxf-existing'), pdxf = taggedOne('dxf-proposed');
  const des = api.design(site);
  const u = site.units;
  const sel = (name, list, val, extra = '') => `<select id="rv-${name}">${extra}${list.map(x => `<option value="${x.id}" ${String(x.id) === String(val) ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>`;
  const phases = model.phases;
  const folder = o.folder || model.stored.folder || model.defaultFolder;
  const resultHtml = lastResult ? resultList(lastResult) : '';
  return `<p class="rv-model"><strong>${esc(model.doc.title)}</strong> <button type="button" class="btn btn-quiet btn-xs" data-rv="refresh" title="Read the model again">↻</button></p>
  <p class="hint rv-place">At the Project Base Point: ${fmtPlacement(P, site)}${P.setCoords ? ' · shared coordinates set' : ''}. <a href="#" data-rv="change-place">Change…</a></p>
  ${diffs.length ? `<div class="rv-banner rv-banner-warn">The app's ${diffs.join(', ')} differ${diffs.length === 1 ? 's' : ''} from what this model uses — the site would land in the wrong spot.
    <div class="align-row"><button type="button" class="btn btn-xs" data-rv="use-model">Use the model's</button><button type="button" class="btn btn-quiet btn-xs" data-rv="change-place">Change the model's…</button></div></div>` : ''}
  <div class="rv-items">
    <label class="check"><input type="checkbox" id="rv-exist" ${o.exist ? 'checked' : ''}><span><strong>Existing ground</strong> — Toposolid <small id="rv-exist-n"></small>
      ${exist ? `<small class="rv-state">In the model. <label class="rv-inline"><input type="checkbox" id="rv-exist-replace"> Replace it</label> <span id="rv-exist-why"></span></small>` : '<small class="rv-state">New.</small>'}</span></label>
    <label class="check"><input type="checkbox" id="rv-prop" ${o.prop && des ? 'checked' : ''} ${des ? '' : 'disabled'}><span><strong>Proposed grading</strong> — Toposolid <small id="rv-prop-n"></small>
      <small class="rv-state">${des ? (prop ? 'Replaces the one sent before.' : 'New.') : 'Make changes in Site design first (pads, walls, slopes, grading).'}</small></span></label>
    <label class="check"><input type="checkbox" id="rv-img" ${o.img ? 'checked' : ''}><span><strong>Aerial image</strong> in plan view ${sel('view', model.views, o.viewId)}
      <small class="rv-state">${img ? 'Updates the one placed before.' : 'Linked JPG, drawn in the background of that view.'}</small></span></label>
    ${host?.features?.includes('drape')
      ? `<label class="check"><input type="checkbox" id="rv-drape" ${o.drape ? 'checked' : ''}><span><strong>Aerial on the Toposolids</strong> — render material
      <small class="rv-state">Painted on the top of the existing and proposed Toposolids, for Realistic views and renderings.</small></span></label>`
      : `<p class="hint rv-state">Update the plugin to drape the aerial on the Toposolids as a material.</p>`}
    ${host?.features?.includes('masses') ? (() => {
      const bl = api.buildings(site), lid = bl.filter(x => x.b.hSrc === 'lidar').length;
      return `<label class="check"><input type="checkbox" id="rv-masses" ${o.masses ? 'checked' : ''} ${bl.length ? '' : 'disabled'}><span><strong>Existing buildings</strong> — masses
      <small class="rv-state">${bl.length ? `${bl.length} from the building layer${new Set(bl.map(x => x.tag)).size > 1 ? 's' : ''} shown on the map${lid ? `, ${lid} with lidar roofs` : ''}. Replaces masses sent before.` : 'Turn on a building layer on the map first.'}</small></span></label>`;
    })() : ''}
    <label class="check"><input type="checkbox" id="rv-dxf" ${o.dxf ? 'checked' : ''}><span><strong>Contours &amp; context</strong> — DXF link (the map's shown layers)
      <small class="rv-state">${dxf ? 'Reloads the existing link.' : 'Linked and pinned at the Project Base Point.'}</small></span></label>
    <label class="check"><input type="checkbox" id="rv-pdxf" ${o.pdxf && des ? 'checked' : ''} ${des ? '' : 'disabled'}><span><strong>Proposed contours</strong> — DXF link
      <small class="rv-state">${pdxf ? 'Reloads the existing link.' : 'Grading limits, pads, walls, slope arrows.'}</small></span></label>
  </div>
  <details class="sub-details menu-line" id="rv-more">
    <summary>Options <span class="sub" id="rv-more-sum"></span></summary>
    <div class="field"><label for="rv-type">Toposolid type</label>${sel('type', model.toposolidTypes, o.typeId)}</div>
    <div class="field"><label for="rv-level">Level</label>${sel('level', model.levels, o.levelId)}</div>
    <div class="field"><label for="rv-phE">Existing ground: phase created / demolished</label><p class="hint">Demolished only when proposed grading is in the model too — otherwise the site would vanish from New Construction views.</p><div class="align-row">${sel('phE', phases, o.phaseE)}${sel('phD', phases, o.phaseD, '<option value="">not demolished</option>')}</div></div>
    <div class="field"><label for="rv-phP">Proposed grading: phase created</label>${sel('phP', phases, o.phaseP)}</div>
    <div class="field"><label for="rv-tol">Surface detail</label><select id="rv-tol">${TOLS[u].map(t => `<option value="${t}" ${t === o.tol ? 'selected' : ''}>within ${t} ${u}</option>`).join('')}</select>
      <p class="hint">Points are kept where the ground bends, so flat areas use few points. Finer detail = more points, slower in Revit.</p></div>
    <div class="field"><label>Folder for the aerial and DXF files</label>
      <p class="rv-folder" id="rv-folder" title="${esc(folder)}">${esc(folder)}</p>
      <div class="align-row"><button type="button" class="btn btn-quiet btn-xs" data-rv="folder">Change…</button><button type="button" class="btn btn-quiet btn-xs" data-rv="open-folder">Open</button></div>
      ${model.doc.cloud || /Documents\\Contours to Revit/i.test(folder) ? '<p class="hint rv-warn">Coworkers can only reload these links if the folder is on a shared drive.</p>' : ''}</div>
  </details>
  <button type="button" class="btn btn-primary btn-block" id="rv-send" data-rv="send" ${busy ? 'disabled' : ''}>${busy ? 'Sending…' : 'Send to Revit'}</button>
  <p class="hint">One undo step in Revit (Ctrl+Z). The site and design are saved in the model too.</p>
  ${resultHtml}
  ${snapBtn ? `<div class="align-row">${snapBtn}</div>` : ''}`;
}

function defaults(site) {
  const ph = model.phases;
  const lvl = model.levels.find(l => /level\s*1\b/i.test(l.name)) || model.levels[0];
  const av = model.activeView?.image ? model.activeView.id : (model.views.find(v => /site/i.test(v.name)) || model.views[0])?.id;
  const type = model.toposolidTypes.find(t => /site|topo|existing/i.test(t.name)) || model.toposolidTypes[0];
  return {
    exist: true, prop: true, img: true, drape: true, masses: false, dxf: true, pdxf: false,
    typeId: type?.id, levelId: lvl?.id, viewId: av,
    phaseE: ph[0]?.id, phaseD: ph.length > 1 ? ph[ph.length - 1].id : '', phaseP: ph[ph.length - 1]?.id,
    tol: TOLS[site.units][2],
  };
}

function readForm() {
  const site = api.site();
  const o = loadOpts();
  const v = id => $(id)?.value;
  // A disabled box (no design yet) keeps the remembered choice instead of saving "off".
  const c = (id, key) => { const el = $(id); return !el || el.disabled ? (o[key] ?? defaults(site)[key]) : el.checked; };
  Object.assign(o, {
    exist: c('rv-exist', 'exist'), prop: c('rv-prop', 'prop'), img: c('rv-img', 'img'), drape: c('rv-drape', 'drape'), masses: c('rv-masses', 'masses'), dxf: c('rv-dxf', 'dxf'), pdxf: c('rv-pdxf', 'pdxf'),
    typeId: v('rv-type'), levelId: v('rv-level'), viewId: v('rv-view'),
    phaseE: v('rv-phE'), phaseD: v('rv-phD'), phaseP: v('rv-phP'),
    tol: Number(v('rv-tol')) || TOLS[site.units][2],
  });
  saveOpts(o);
  return { ...defaults(site), ...o };
}

let countTimer = 0;
function updateCounts() {
  clearTimeout(countTimer);
  countTimer = setTimeout(() => {
    const site = api.site();
    if (!site || !$('rv-exist-n')) return;
    const o = { ...defaults(site), ...loadOpts() };
    const tol = Number($('rv-tol')?.value) || o.tol;
    const { ex, pr } = surfaces(site, tol);
    $('rv-exist-n').textContent = `(${ex.count.toLocaleString()} points)`;
    if ($('rv-prop-n')) $('rv-prop-n').textContent = pr ? `(${pr.count.toLocaleString()} points)` : '';
    $('rv-more-sum').textContent = `— within ${ex.tol.toFixed(2)} ${site.units}`;
    const old = taggedOne('existing');
    if (old && $('rv-exist-replace')) {
      const why = replaceReason(site, ex, tol, json(old.meta));
      $('rv-exist-why').textContent = why ? `(${why})` : '(unchanged — kept as is)';
      if (!$('rv-exist-replace').dataset.touched) $('rv-exist-replace').checked = !!why;
    }
  }, 60);
}

/** Why the existing Toposolid in the model should be replaced, or '' to keep it. */
function replaceReason(site, ex, tol, meta) {
  if (!meta) return 'no details stored';
  const { extent } = toInternal(site, ex.pts);
  const e0 = meta.extent || [0, 0, 0, 0], m = 1;
  if (extent[0] < e0[0] - m || extent[1] < e0[1] - m || extent[2] > e0[2] + m || extent[3] > e0[3] + m) return 'site is larger';
  if (Math.abs(extent[0] - e0[0]) > 5 || Math.abs(extent[2] - e0[2]) > 5 || Math.abs(extent[1] - e0[1]) > 5 || Math.abs(extent[3] - e0[3]) > 5) return 'site size changed';
  if (meta.s && site.grid.s * kOf(site) < meta.s - 0.01) return 'finer data';
  if (meta.tol && tol * kOf(site) < meta.tol - 1e-6) return 'more detail';
  if (meta.bldg !== (site.bldgSurface ? site.bldgSurface.mode : 'off')) return 'buildings setting changed';
  if (meta.dem && meta.dem !== demLabel(site)) return 'different elevation data';
  const wantDemo = !!($('rv-prop')?.checked && api.design(site)) || !!taggedOne('proposed');
  const o = loadOpts();
  if ((meta.demolished ?? true) !== (wantDemo && o.phaseD !== '')) return wantDemo ? 'to demolish it under the proposed grading' : 'so it shows in New Construction views';
  return '';
}
const demLabel = site => (site.dem?.contributions || []).map(c => c.tier?.label).join('+');

function resultList(r) {
  const name = { masses: 'Existing buildings', drape: 'Aerial on the Toposolids', coordinates: 'Shared coordinates', existing: 'Existing Toposolid', proposed: 'Proposed Toposolid', aerial: 'Aerial image', 'dxf-existing': 'Contours DXF', 'dxf-proposed': 'Proposed DXF', state: 'Site saved in the model' };
  const ids = r.results.filter(x => x.ok && x.id).map(x => x.id);
  const items = r.results.map(x => `<li class="${x.ok ? 'ok' : 'bad'}">${esc(name[x.role] || x.role)}: ${x.ok
    ? (x.kept ? 'already in the model — kept as is'
      : x.role === 'existing' || x.role === 'proposed' ? `${x.replaced ? 'replaced' : 'created'}, ${Number(x.points).toLocaleString()} points${x.profile ? ', boundary outline' : ''}`
      : x.role === 'coordinates' ? (x.check > 0.9999 ? 'set and checked' : 'set — check the angle')
      : x.role === 'aerial' ? `${x.reloaded ? 'reloaded' : 'placed'} in “${esc(x.view)}”`
      : x.role === 'masses' ? `${x.made} building mass${x.made === 1 ? '' : 'es'}${x.failed ? `, ${x.failed} failed` : ''}${x.removed ? ` (replaced ${x.removed})` : ''}`
      : x.role === 'drape' ? `material “${esc(x.material)}” on ${x.painted} Toposolid${x.painted === 1 ? '' : 's'} (${x.faces} face${x.faces === 1 ? '' : 's'})`
      : x.role.startsWith('dxf') ? (x.reloaded ? 'reloaded' : 'linked') : 'done')
    : esc(x.error)}</li>`).join('');
  const warn = r.warnings?.length ? `<details class="sub-details rv-warns"><summary>${r.warnings.length} Revit warning${r.warnings.length === 1 ? '' : 's'}</summary><ul>${r.warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul></details>` : '';
  return `<div class="rv-result"><ul>${items}</ul>${warn}${ids.length ? `<button type="button" class="btn btn-quiet btn-xs" data-rv="select" data-ids="${ids.join(',')}">Select in Revit</button>` : ''}</div>`;
}

// ---------------------------------------------------------------- actions
async function onClick(e) {
  const b = e.target.closest('[data-rv]');
  if (!b) return;
  e.preventDefault();
  const a = b.dataset.rv;
  const site = api.site();
  try {
    if (a === 'refresh') await refresh();
    else if (a === 'settings') { const d = $('step-settings'); d.open = true; d.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    else if (a === 'download') call('openUrl', { url: latest?.url || PLUGIN_DOWNLOAD });
    else if (a === 'update' || a === 'check-update') {
      if (!host?.update) { await checkUpdates(); render(); return; }       // plugin 0.1.0: no built-in updater
      // One click does it all: check, and install when there is something newer.
      host.update = { ...host.update, state: 'checking' }; updNote = 'Checking for a plugin update…'; render();
      let u = await call('checkUpdate', {}, 120000);
      if (u.available) {
        host.update = { ...u, state: 'downloading' }; updNote = `Downloading and installing plugin ${u.latest}…`; render();
        u = await call('installUpdate', {}, 10 * 60 * 1000);
      }
      host.update = u;
      updNote = u.state === 'error' ? `Update failed: ${u.error || 'unknown error'}`
        : u.pending ? `Plugin ${u.pending} is installed. Restart Revit to use it (this window shows ${host.version} until then).`
        : `The plugin is up to date (${host.version}).`;
      api.setStatus(updNote, u.state === 'error');
      render();
    } else if (a === 'rendering') {
      if (host?.compatibleRendering === undefined) { api.setStatus('Update the plugin first — this option arrived in plugin 0.2.0.', true); return; }
      const on = !host.compatibleRendering;
      await call('setRendering', { compatible: on });
      host.compatibleRendering = on;
      renderNote = on ? 'Compatible rendering is on — restart Revit for it to take effect. If the map still looks wrong, turn it off again here.' : 'Compatible rendering is off — restart Revit for it to take effect.';
      render();
    }
    else if (a === 'goto-place') api.revealPlace();
    else if (a === 'change-place') { changing = true; render(); }
    else if (a === 'place-cancel') { changing = false; render(); }
    else if (a === 'place-ok') await choosePlacement(site);
    else if (a === 'use-model') { applyPlacement(storedPlacement(), site); render(); api.setStatus("Using this model's origin, project north and datum."); }
    else if (a === 'folder') {
      const o = loadOpts();
      const f = await call('pickFolder', { start: o.folder || model.stored.folder || model.defaultFolder });
      if (f) { o.folder = f; saveOpts(o); render(); }
    } else if (a === 'open-folder') call('openFolder', { path: loadOpts().folder || model.stored.folder || model.defaultFolder });
    else if (a === 'send') await send();
    else if (a === 'select') await call('select', { ids: b.dataset.ids.split(',').map(Number) });
    else if (a === 'open-snap') {
      const snap = storedSnapshot();
      if (snap) await api.openSnapshot(snap, `${model.doc.title} (Revit model)`, docKey());
    }
  } catch (err) {
    console.error(err);
    api.setStatus(err.message || String(err), true);
  }
}

function onChange(e) {
  const id = e.target.id;
  if (id === 'rv-exist-replace') e.target.dataset.touched = '1';
  if (e.target.closest('#rv-body') && id?.startsWith('rv-') && id !== 'rv-setcoords') { readForm(); if (id === 'rv-tol' || id === 'rv-prop' || id === 'rv-phD') updateCounts(); }
}

async function choosePlacement(site) {
  const mode = document.querySelector('input[name="rv-place"]:checked')?.value || 'pbp';
  let P;
  if (mode === 'shared') {
    const nr = document.querySelector('input[name="rv-mnorth"]:checked')?.value || 'grid';
    P = { ...placementFromModel(site, nr).p, mode: 'shared', setCoords: false };
    applyPlacement(P, site);
  } else {
    api.fixOrigin(site); // make the origin explicit (SW corner → a fixed point), and turn on the local origin
    P = { ...appPlacement(site), mode: 'pbp', setCoords: !!$('rv-setcoords')?.checked };
  }
  P.set = new Date().toISOString();
  P.pending = true;       // written into the model with the next send
  P.docKey = model.doc.key;
  pendingPlacement = P;
  changing = false;
  // Show the form with the new placement right away (it is stored by the next Send).
  model.stored.placement = JSON.stringify(P);
  render();
  api.setStatus(mode === 'shared' ? "Placement taken from the model's shared coordinates. Click Send to Revit." : 'Placement chosen. Click Send to Revit.');
}
let pendingPlacement = null;

async function send() {
  const site = api.site();
  if (!site || !model?.doc) return;
  const P = storedPlacement();
  if (!P) { changing = true; render(); return; }
  const diffs = placementDiffs(P, site);
  if (diffs.length) { api.setStatus(`The app's ${diffs.join(', ')} differ from this model's — use the model's or change the model's placement first.`, true); return; }
  const o = readForm();
  const k = kOf(site);
  const status = m => api.setStatus(m);
  busy = true; render();
  try {
    await refreshModelOnly();                       // fresh element ids and base point
    const job = { units: site.units, folder: o.folder || model.stored.folder || model.defaultFolder, prefix: api.prefix(), toposolids: [], dxfs: [] };
    const date = new Date().toISOString().slice(0, 10);

    if (P.setCoords && P.pending) {
      const rv = api.revitValues(site);
      const toward = P.northRef === 'true' ? (site.convergence || 0) : 0;
      const b = (P.rot - toward) * Math.PI / 180;   // project north, clockwise from the shared north
      job.coords = { ...model.pbp, ew: rv.ew * k, ns: rv.ns * k, elev: rv.elev * k, angle: rv.ang, expectNorth: [Math.sin(b), Math.cos(b)] };
    }

    const { ex, pr, des } = surfaces(site, o.tol);
    const profile = profileOf(site);
    const meta = (t, extent) => JSON.stringify({ v: 1, extent, s: site.grid.s * site.toOut * k, tol: o.tol * k, n: t.count, bldg: site.bldgSurface ? site.bldgSurface.mode : 'off', dem: demLabel(site), date, zone: site.zone.code });
    const oldEx = taggedOne('existing');
    // Existing ground is only demolished (hidden in "Show Complete" New Construction views) when proposed grading
    // replaces it; with no proposed Toposolid it must stay visible.
    const hasProposed = !!((o.prop && pr) || taggedOne('proposed'));
    if (o.exist && (!oldEx || $('rv-exist-replace')?.checked)) {
      status('Preparing the existing Toposolid…');
      const t = toInternal(site, ex.pts);
      job.toposolids.push({ role: 'existing', points: t.pts, profile, typeId: Number(o.typeId), levelId: Number(o.levelId), phaseCreated: Number(o.phaseE) || null, phaseDemolished: hasProposed ? Number(o.phaseD) || null : null, replaceId: oldEx?.id ?? null, meta: JSON.stringify({ ...JSON.parse(meta(ex, t.extent)), demolished: hasProposed && !!Number(o.phaseD) }), comment: `Contours to Revit — existing ground (${date})` });
    }
    if (o.prop && pr) {
      status('Preparing the proposed Toposolid…');
      const t = toInternal(site, pr.pts);
      job.toposolids.push({ role: 'proposed', points: t.pts, profile, typeId: Number(o.typeId), levelId: Number(o.levelId), phaseCreated: Number(o.phaseP) || null, phaseDemolished: null, replaceId: taggedOne('proposed')?.id ?? null, meta: meta(pr, t.extent), comment: `Contours to Revit — proposed grading (${date})` });
    }
    if (o.masses && host?.features?.includes('masses')) {
      const list = api.buildings(site);
      if (list.length) {
        status(`Preparing ${list.length} building masses…`);
        const d = api.datum(site), P0 = model.pbp, r4 = v => Math.round(v * 1e4) / 1e4;
        const T = (x, y, z) => { const [X, Y] = api.outXY(site, x, y); return [r4(P0.x + X * k), r4(P0.y + Y * k), r4(P0.z + (z - d) * k)]; };
        job.masses = { phaseCreated: Number(o.phaseE) || null, buildings: list.map(({ b, src, tag }, n) => {
          const R = b.ring, N = R.length, v = [], f = [];
          const tz = i => (b.ringTop ? b.ringTop[i] : b.top);
          R.forEach(([x, y]) => v.push(...T(x, y, b.base)));
          R.forEach(([x, y], i) => v.push(...T(x, y, tz(i))));
          for (let i = 0; i < N; i++) f.push([i, (i + 1) % N, N + (i + 1) % N, N + i]);
          const tri = api.triangulate(R);
          if (b.roof) { const off = v.length / 3; b.roof.pts.forEach(p => v.push(...T(...p))); b.roof.tris.forEach(t => f.push(t.map(q => q + off))); }
          else tri.forEach(t => f.push(t.map(q => N + q)));
          tri.forEach(t => f.push([t[2], t[1], t[0]]));
          const how = b.hSrc === 'lidar' ? `lidar ${site.lidar?.year || ''}`.trim() : b.heightKnown ? 'data height' : 'assumed height';
          return { id: `${tag}-${n}`, name: `Existing building (${tag})`, v, f, comment: `Contours to Revit — ${src}, ${how}`,
            meta: JSON.stringify({ src: tag, h: r4((b.top - b.base) * k), how }) };
        }) };
      }
    }
    const drape = o.drape && host?.features?.includes('drape');
    let aerialFid = null, aerialImg = null;
    const e = api.aerialExtent(site);
    if (o.img || drape) {
      status('Preparing the aerial…');
      aerialImg = await api.aerial(site);
      aerialFid = await upload(aerialImg.blob, 'aerial', status);
    }
    if (drape) {
      // The JPG covers aerialExtent (project-north up), so in Revit it spans these internal coordinates.
      job.drape = { fid: aerialFid, file: `${api.prefix()}_aerial.jpg`, name: `Site aerial - ${api.prefix()}`,
        x0: model.pbp.x + e.x0 * k, y0: model.pbp.y + e.y0 * k, w: e.w * k, h: e.h * k, roles: ['existing', 'proposed'] };
    }
    if (o.img) {
      if (!o.viewId) throw new Error('This model has no plan view for the aerial — add a floor plan or untick Aerial image.');
      const a = aerialImg, fid = aerialFid;
      job.image = { fid, file: `${api.prefix()}_aerial.jpg`, viewId: Number(o.viewId), cx: model.pbp.x + (e.x0 + e.x1) / 2 * k, cy: model.pbp.y + (e.y0 + e.y1) / 2 * k, w: e.w * k, h: e.h * k, replaceId: taggedOne('aerial')?.id ?? null, meta: JSON.stringify({ v: 1, date, px: [a.w, a.h] }) };
    }
    const dxfAt = { ox: model.pbp.x, oy: model.pbp.y, oz: model.pbp.z, unit: site.units };
    if (o.dxf) {
      status('Preparing the contour DXF…');
      const fid = await upload(api.makeDxf(site), 'contour DXF', status);
      job.dxfs.push({ role: 'dxf-existing', fid, file: `${api.prefix()}_existing.dxf`, ...dxfAt, replaceId: taggedOne('dxf-existing')?.id ?? null, meta: JSON.stringify({ v: 1, date }) });
    }
    if (o.pdxf && des) {
      status('Preparing the proposed DXF…');
      const fid = await upload(api.makeNewDxf(site), 'proposed DXF', status);
      job.dxfs.push({ role: 'dxf-proposed', fid, file: `${api.prefix()}_new.dxf`, ...dxfAt, replaceId: taggedOne('dxf-proposed')?.id ?? null, meta: JSON.stringify({ v: 1, date }) });
    }
    const placement = { ...P }; delete placement.pending; delete placement.docKey;
    const snap = api.snapshot();
    job.state = { placement: JSON.stringify(placement), snapshot: JSON.stringify({ ...snap, savedAt: new Date().toISOString(), app: api.version }) };

    status('Revit is building the site…');
    const r = await call('import', job);
    if (o.exist && oldEx && !job.toposolids.some(t => t.role === 'existing')) r.results.unshift({ role: 'existing', ok: true, kept: true });
    lastResult = r;
    pendingPlacement = null;
    const bad = r.results.filter(x => !x.ok);
    api.setStatus(bad.length ? `Sent with ${bad.length} problem${bad.length === 1 ? '' : 's'} — see Send to Revit.` : 'Sent to Revit.', !!bad.length);
    if (o.folder == null) { const oo = loadOpts(); oo.folder = r.folder; saveOpts(oo); }
  } finally {
    busy = false;
    await refreshModelOnly().catch(() => {});
    render();
  }
}

// ---------------------------------------------------------------- lifecycle
async function refreshModelOnly() {
  try { model = await call('getModel'); modelErr = ''; }
  catch (e) { model = null; modelErr = e.message; }
  // A placement chosen in this session but not sent yet wins over the stored one (same model only).
  if (pendingPlacement && model?.doc && model.doc.key === pendingPlacement.docKey) model.stored.placement = JSON.stringify(pendingPlacement);
}

async function refresh() {
  await refreshModelOnly();
  render();
}

async function checkUpdates() {
  try {
    const r = await fetch(RELEASES, { headers: { Accept: 'application/vnd.github+json' } });
    if (!r.ok) return;
    const list = await r.json();
    const rel = list.find(x => !x.draft && !x.prerelease && /^revit-v\d/.test(x.tag_name));
    if (!rel) return;
    const asset = rel.assets.find(x => x.name === 'ContoursToRevit-Setup.exe') || rel.assets[0];
    latest = { version: rel.tag_name.replace(/^revit-v/, ''), url: asset?.browser_download_url || rel.html_url };
    render();
  } catch { /* offline: ignore */ }
}

/** Called by app.js once at startup. */
export async function initRevit(appApi) {
  api = appApi;
  if (!IN_REVIT) {
    // In a normal browser: offer the plugin download next to the Place in Revit step.
    const card = document.getElementById('step-place')?.querySelector('.step-body');
    if (card && !document.getElementById('rv-get')) {
      const p = document.createElement('p');
      p.className = 'hint rv-get';
      p.id = 'rv-get';
      p.innerHTML = `Using Revit 2026? <a href="${PLUGIN_DOWNLOAD}">Get the Revit plugin</a> — it puts the site in your model as a Toposolid with one click.`;
      card.appendChild(p);
    }
    return;
  }
  document.documentElement.classList.add('in-revit');
  ensurePanel();
  try { host = await call('hello', {}, 10000); } catch { host = null; }
  await refresh();
  checkUpdates();
  // The plugin may finish a background update while this page is open: pick up its status now and then.
  setInterval(async () => {
    if (busy || document.hidden) return;
    try {
      const h = await call('hello', {}, 10000);
      const changed = JSON.stringify(h?.update) !== JSON.stringify(host?.update);
      host = { ...h, compatibleRendering: host?.compatibleRendering ?? h.compatibleRendering };
      if (changed && !document.activeElement?.closest?.('#rv-body')) render();
    } catch { /* ignore */ }
  }, 60000);
}

/** app.js calls this after Generate, when the design changes, and when origin/north/datum change. */
let siteTimer = 0;
export function revitSiteChanged() {
  if (!IN_REVIT || !api) return;
  clearTimeout(siteTimer);
  siteTimer = setTimeout(() => { if (!busy && !document.activeElement?.closest?.('#rv-body')) render(); }, 400);
}

// ---------------------------------------------------------------- mock plugin (?host=mock)
function mockHost() {
  const listeners = [];
  const stored = { placement: '', snapshot: '', folder: '' };
  const elements = [];
  let nextId = 900000;
  const jobs = [];
  const model = () => ({
    doc: { title: 'Mock model', path: 'C:\\Projects\\Mock\\Mock model.rvt', cloud: false, workshared: false, key: 'mock', units: 'autodesk.unit.unit:feetFractionalInches-1.0.1', metric: false },
    pbp: { x: 10, y: 20, z: 0 },
    pbpShared: stored.placement && JSON.parse(stored.placement).setCoords ? mockShared() : { ew: 0, ns: 0, elev: 0, angle: 0 },
    survey: { x: 0, y: 0, z: 0 },
    sharedNorthDelta: [0, 100], sharedEastDelta: [100, 0],
    phases: [{ id: 1, name: 'Existing' }, { id: 2, name: 'New Construction' }],
    toposolidTypes: [{ id: 11, name: 'Toposolid 12"' }, { id: 12, name: 'Site - Existing' }],
    levels: [{ id: 21, name: 'Level 1', elev: 0, projElev: 0 }, { id: 22, name: 'Level 2', elev: 12, projElev: 12 }],
    views: [{ id: 31, name: 'Level 1', level: 'Level 1' }, { id: 32, name: 'Site', level: 'Level 1' }],
    activeView: { id: 31, name: 'Level 1', type: 'FloorPlan', image: true },
    stored: { ...stored },
    defaultFolder: 'C:\\Projects\\Mock\\Mock model site',
    elements: elements.map(e => ({ ...e })),
  });
  let shared = null;
  const mockShared = () => shared || { ew: 0, ns: 0, elev: 0, angle: 0 };
  const reply = (id, ok, result, error) => Promise.resolve().then(() => listeners.forEach(f => f({ data: { type: 'reply', id, ok, result, error } }))); // no timers: hidden tabs throttle them
  window.c2rMock = { jobs, elements, stored, fireDocChanged: () => listeners.forEach(f => f({ data: { type: 'event', event: 'documentChanged' } })) };
  return {
    addEventListener: (t, f) => { if (t === 'message') listeners.push(f); },
    postMessage(m) {
      const { id, type } = m;
      if (type === 'hello') return reply(id, true, { host: 'mock', version: '0.0.1', revit: '2026 (mock)', features: ['drape', 'masses'], compatibleRendering: false, update: { current: '0.0.1', state: 'idle', auto: true } });
      if (type === 'checkUpdate') return reply(id, true, { current: '0.0.1', latest: '0.3.0', available: !window.c2rMock.installed, pending: window.c2rMock.installed || null, state: 'idle' });
      if (type === 'installUpdate') { window.c2rMock.installed = '0.3.0'; return reply(id, true, { current: '0.0.1', latest: '0.3.0', available: false, pending: '0.3.0', state: 'installed' }); }
      if (type === 'setRendering') return reply(id, true, { compatibleRendering: m.compatible, restart: true });
      if (type === 'getModel') return reply(id, true, model());
      if (type === 'chunk') return reply(id, true, { fid: m.fid, bytes: m.b64.length * 0.75 });
      if (type === 'pickFolder') return reply(id, true, 'D:\\Shared\\Mock site');
      if (type === 'openFolder' || type === 'openUrl' || type === 'select') return reply(id, true, true);
      if (type === 'import') {
        jobs.push(m);
        const results = [];
        if (m.coords) { shared = { ew: m.coords.ew, ns: m.coords.ns, elev: m.coords.elev, angle: m.coords.angle }; results.push({ role: 'coordinates', ok: true, check: 1 }); }
        const put = (role, meta, extra) => {
          const old = elements.findIndex(e => e.role === role);
          if (old >= 0) elements.splice(old, 1);
          const el = { id: nextId++, role, meta, category: role, name: role, viewId: -1 };
          elements.push(el);
          results.push({ role, ok: true, id: el.id, replaced: old >= 0, ...extra });
        };
        for (const t of m.toposolids) put(t.role, t.meta, { points: t.points.length / 3, profile: !!t.profile });
        if (m.image) put('aerial', m.image.meta, { view: 'Level 1', reloaded: false });
        if (m.masses) results.push({ role: 'masses', ok: true, made: m.masses.buildings.length, failed: 0, removed: 0 });
        if (m.drape) results.push({ role: 'drape', ok: true, material: m.drape.name, painted: elements.filter(e => m.drape.roles.includes(e.role)).length, faces: 1 });
        for (const d of m.dxfs) put(d.role, d.meta, { reloaded: false });
        if (m.state) { stored.placement = m.state.placement; stored.snapshot = m.state.snapshot; stored.folder = m.folder; results.push({ role: 'state', ok: true }); }
        return reply(id, true, { results, warnings: [], folder: m.folder });
      }
      reply(id, false, null, 'unknown ' + type);
    },
  };
}
