// Hover help, strategy-game style: hover anything with data-tip (a key in TIPS) or data-tip-text (plain text) and a
// tooltip appears; after a moment it "locks" (the bar along its top fills) so you can move into it and hover the
// highlighted terms for nested tips. Moving away closes it. Also: coach(), a short note at the bottom of the map
// when a tool is picked (replaces the always-on instructions).

const term = (k, w) => `<span class="tip-term" data-tip="${k}">${w}</span>`;
const K = s => s.split(' ').map(k => `<kbd>${k}</kbd>`).join(' ');

/** Help text by key: { t: title, b: body (HTML; terms nest), k: keys line }. */
export const TIPS = {
  // ---- terms (nested)
  '3dep': { t: 'USGS 3DEP', b: 'The U.S. Geological Survey\'s 3D Elevation Program — public bare-earth elevation models from airborne lidar. The app uses the 1 m DEM where it exists and fills gaps with the coarser 1/9″, 1/3″ and 1″ models.' },
  lidar: { t: 'Lidar', b: 'Laser scanning from aircraft: millions of measured points per site, each classified (ground, building, vegetation…). The app reads the USGS point clouds to measure building heights and roofs.' },
  navd88: { t: 'NAVD88', b: 'North American Vertical Datum of 1988 — the elevation reference for 3DEP data. Elevations here are NAVD88 unless you set your own ' + term('datum', 'datum') + '.' },
  datum: { t: 'Elevation datum', b: 'An elevation subtracted from every Z so Revit levels read as you want (for example, finished floor = 0).' },
  stateplane: { t: 'State Plane coordinates', b: 'Flat survey coordinates for each state zone (US survey feet here). Revit and CAD work in flat X/Y, so points are projected from latitude/longitude into the site\'s zone. Pick another zone in Settings › Topography if the auto-detected one is wrong.' },
  origin: { t: 'Local origin', b: 'Revit warns when geometry is miles from its origin, and State Plane coordinates are millions of feet out. A local origin moves (0,0) to a point on the site; the real coordinates stay in the README and the ' + term('revitcoords', 'Revit coordinates') + ' card.' },
  revitcoords: { t: 'Revit coordinates', b: 'The numbers to type into Manage › Coordinates › Specify Coordinates at Point, so the model\'s shared coordinates match State Plane.' },
  pn: { t: 'Project north', b: 'Revit\'s project north can be turned from true/grid north so the building sits square on the sheet. Set the angle here (or pick a direction on the map) and exported geometry is rotated to match.' },
  toposolid: { t: 'Toposolid', b: 'Revit 2024+ topography element. Build it with Create from Import › Specify Points File using the CSV points.' },
  dxfunits: { t: 'DXF units', b: 'When linking the DXF in Revit, set Import units to the export units (Feet or Meters) — Auto-Detect guesses wrong for DXF.' },
  floors: { t: 'How floors are counted', b: 'A block is sliced every floor-to-floor height from its base. A level counts when at least half of its floor still has the full storey above it — so pitched-roof attics don\'t, a tall shed roof might. Floor area is the sum of the floor plates.' },
  snap: { t: 'Snapping', b: 'While drawing, points catch ' + term('snapkinds', 'corners, midpoints and edges') + ' of the sketch and of the site (parcel lines, buildings, road edges). Lines also pull gently square to what\'s already drawn. Hold ' + K('Shift') + ' to lock square; hold ' + K('Alt') + ' to draw freely.' },
  snapkinds: { t: 'Snap markers', b: '<b class="c-g">□</b> corner · <b class="c-c">△</b> midpoint · <b class="c-r">×</b> on an edge · <b class="c-m">— —</b> square / locked to a direction · <b class="c-p">· · ·</b> in line with a corner.' },
  ada: { t: 'Accessible parking count', b: 'Counted per lot from the 2010 ADA Standards for Accessible Design, Table 208.2, with one van space for every six accessible spaces (208.2.4). Spaces pair up on a shared access aisle at the row ends nearest the nearest building.' },
  ratios: { t: 'Parking ratios', b: 'Required spaces = floor area of each use ÷ 1,000 × ratio, or units (floor area ÷ average unit size) × ratio. The starting numbers are examples only — set them to the local code in Settings › Sketch.' },
  solid: { t: 'Solids', b: 'Blocks are made of flat faces, like SketchUp. Quick shapes keep their roof / courtyard / step-back settings until you change them by hand with Draw, Push/Pull, Slope or Ctrl+drag.' },
  scheme: { t: 'Colour scheme', b: 'Colours for building uses and site elements, shared by the Sketch and Diagram tabs. Edit or copy one in Settings › Sketch; each project keeps the scheme it was saved with.' },

  // ---- Existing site
  'mode-existing': { t: 'Existing site', b: 'Pick a site, generate ' + term('3dep', 'USGS 3DEP') + ' topography with buildings, roads and parcels, then export for Revit.' },
  'mode-design': { t: 'Site design', b: 'Sculpt proposed grades — brushes, slopes, walls, pads and swales — with live cut / fill, then export new-construction contours.' },
  'mode-sketch': { t: 'Sketch', b: 'Brainstorm on the real site: massing ' + term('solid', 'solids') + ' with live ' + term('floors', 'floor area') + ', and parking lots with live counts against your ' + term('ratios', 'ratios') + '.' },
  'mode-diagram': { t: 'Diagram', b: 'Site analysis and concept diagrams over a faded site — arrows, lines, regions and labels on the ground or on any block face, flat or standing up.' },
  site: { t: '1 · Site', b: 'Search a place, then drag a rectangle or click a polygon around the site (click the first point to close). Edit the boundary with the pencil tool on the map. Keep it under about 50,000 points for Revit.' },
  rect: { t: 'Rectangle', b: 'Drag a box over the site.' },
  poly: { t: 'Polygon', b: 'Click the corners; click the first point to close. Leaves out areas you don\'t need.' },
  topo: { t: '2 · Topography', b: 'Point spacing and contour interval for the exports. Buildings, roads, parcels (Arkansas) and FEMA flood zones come along automatically — choose what\'s shown in the map\'s Layers panel. Smoothing, buildings in the surface, lidar roofs and the ' + term('stateplane', 'coordinate system') + ' are in Settings › Topography.' },
  spacing: { t: 'Points every', b: 'Grid spacing of the CSV points. Revit handles about 50,000 points comfortably; contours are always drawn from the full-resolution surface.' },
  interval: { t: 'Contours every', b: 'Contour interval; every fifth line is a major (index) contour on its own DXF layer.' },
  place: { t: '3 · Place in Revit', b: 'Where the site lands in Revit: a ' + term('origin', 'local origin') + ', ' + term('pn', 'project north') + ' and an elevation ' + term('datum', 'datum') + '. The ' + term('revitcoords', 'Revit coordinates') + ' card gives the numbers for shared coordinates.' },
  export: { t: '4 · Export', b: 'DXF (3D contours with true Z, buildings and the layers shown), CSV points for a ' + term('toposolid', 'Toposolid') + ', the aerial with an underlay, a printable PNG, and a README. Remember the ' + term('dxfunits', 'DXF import units') + '. More options in Settings › Export.' },
  generate: { t: 'Generate', b: 'Downloads the elevation, imagery and site context for the boundary and builds the surface. Larger sites and lidar roofs take longer.' },
  projects: { t: 'Projects', b: 'Saving is manual — Save overwrites the open project, Save as new makes another. A project keeps the site, options, origin and north, layers, the site design and the sketch, in this browser on this computer. Use Save design (Site design tab) for a file you can move.' },

  // ---- Site design
  grading: { t: '1 · Grading tools', b: 'Brushes raise, lower, flatten and smooth; Slope, Wall, Pad and Swale make editable features. ' + K('Ctrl') + '+wheel brush size · right-click a feature to edit it · ' + K('Shift') + ' locks lines square · ' + K('Ctrl Z') + ' undo · ' + K('Esc') + ' stops. Wheel-drag (or hold ' + K('Space') + ') pans.' },
  earthwork: { t: '2 · Earthwork', b: 'Cut, fill and net volume of the changes so far. Display options (existing contours, labels, cut / fill colours) are in Settings › Site design.' },
  features: { t: '3 · Features', b: 'Pads, walls and slope runs stay editable: click one on the map (with a Slope, Wall or Pad tool) or in this list, change its numbers or drag its handles. ' + K('Del') + ' removes it.' },
  dzexport: { t: '4 · Save & export', b: 'Same origin, project north, datum and project folder as the Existing site tab. In Revit, link the new DXF next to the existing one, or build a second ' + term('toposolid', 'Toposolid') + ' from the CSV and set its phase to New Construction. The design also saves automatically in this browser for this site.' },
  'wall-elev': { t: 'Wall elevations', b: 'Start is where you began dragging. Leave End blank for a level top or bottom; different values make it slope. The high side is graded to TW, the low side to BW.' },

  // ---- Sketch
  sketch: { t: '1 · Sketch', b: 'Live totals for what you\'ve drawn. Tools are on the map\'s toolbar — hover each for its keys. Drawing ' + term('snap', 'snaps') + '. Floors: ' + term('floors', 'how they\'re counted') + '. Accessible spaces: ' + term('ada', 'how they\'re counted') + '. Sketches save with the site and with projects.' },
  'sk-select': { t: 'Select', k: 'V', b: 'Click to edit; drag to move; ⟳ rotate, ⤡ scale; drag corners and edge dots. ' + K('Ctrl') + '+drag a point, edge or face to move it (add ' + K('Shift') + ' for up / down). ' + K('Alt') + '+drag duplicates; ' + K('Alt') + '+click a corner removes it. ' + K('↑ ↓') + ' floors or slide rows · ' + K('Del') + ' delete.' },
  'sk-mass': { t: 'Shapes', k: 'M', b: 'Quick blocks: drag a box, round, L, U or courtyard (' + K('1 2 3 4 5') + '), or click an outline and double-click. ' + K('R') + ' changes the roof. They\'re ' + term('solid', 'solids') + ' you can keep shaping.' },
  'sk-pen': { t: 'Draw', k: 'L', b: 'On the ground: a rectangle or outline becomes a flat shape to pull up. On a face: a rectangle inside it, or a line from edge to edge that splits it. ' + term('snap', 'Snaps') + ' as you go.' },
  'sk-push': { t: 'Push / Pull', k: 'U', b: 'Drag a face in or out. Tops snap to whole floors (' + K('Shift') + ' = free). ' + K('Ctrl') + ' always makes new sides. Type an exact distance in the box beside the tool.' },
  'sk-slope': { t: 'Slope', k: 'S', b: 'Drag across a face toward its high side; it tilts at the pitch in the box (walls lean out). The back edge stays put.' },
  'sk-lot': { t: 'Lot', k: 'P', b: 'Drag or click a parking lot; stalls lay out live with ' + term('ada', 'accessible spaces') + '. ' + K('[ ]') + ' turn the rows, ' + K('↑ ↓') + ' slide them. Buffer, islands and stall angle are on its card.' },
  'sk-island': { t: 'Island', k: 'I', b: 'A planter island — snaps to stall lines, aisles and the lot edge; the stalls under it go away. Corner radius on its card.' },
  'sk-drive': { t: 'Drive aisle', k: 'D', b: 'Drag a straight aisle or click a bent one. Clears the stalls it crosses; curb returns where it meets paving; an end off the paving gets a curb cut. Width and turn radius on its card.' },

  // ---- Diagram
  diagram: { t: '1 · Diagram', b: 'Annotate the site and sketch. Draw on the ground or on any block face; ' + K('F') + ' stands an annotation up (arrows on edge, lines as fences, regions as volumes). Colours come from the project\'s ' + term('scheme', 'colour scheme') + '. Works on the map and in 3D.' },
  'dg-select': { t: 'Select', k: 'V', b: 'Click an annotation to style it; drag to move it; drag its points. ' + K('F') + ' stands it up / lays it flat · ' + K('Alt') + '+drag duplicates · ' + K('Del') + ' deletes.' },
  'dg-arrow': { t: 'Arrow', k: 'A', b: 'Drag a straight arrow, or click points (it curves through them) and double-click.' },
  'dg-line': { t: 'Line', k: 'L', b: 'Drag a straight line, or click points and double-click. Stand it up for a fence or screen.' },
  'dg-region': { t: 'Region', k: 'R', b: 'Drag a rectangle or click an outline. Stand it up for a see-through volume.' },
  'dg-label': { t: 'Label', k: 'T', b: 'Click where it goes, then type in the card.' },
  'dg-export': { t: 'Save image', b: 'Saves the current view — plan or 3D — as a PNG. In plan, the basemap tiles are left out (only the site aerial and the app\'s own layers can be copied into an image).' },

  // ---- Settings
  settings: { t: 'Settings', b: 'All the detailed options, grouped by task. Your choices are remembered in this browser.' },
  imagery: { t: 'Aerial imagery', b: 'Automatic checks every service that might cover the site: blank or patchy ones are skipped, the real detail in each is measured from sample pixels, and the sharpest is used (sources within 10 % count as equal and the newer one wins).' },
  flow: { t: 'Water flow', b: 'Streaks run downhill; circles mark low spots that would pond. Uses the proposed grade in Site design.' },
  hosted: { t: 'Hosted map data', b: 'Parking lots, sidewalks and street surfaces come from OpenStreetMap data this site hosts for the listed states (refreshed weekly). Elsewhere the app asks the public OpenStreetMap servers, which can be busy.' },
  smoothing: { t: 'Smooth contours', b: 'Removes lidar noise from the contour lines; the points stay raw.' },
  'bldg-lidar': { t: 'Building heights & roofs from lidar', b: 'Measures each footprint in the USGS ' + term('lidar', 'lidar') + ' point cloud (flat or sloped roofs). Larger download; footprints the lidar can\'t read keep their data height.' },
  trees: { t: 'Existing trees', b: 'Read from the USGS ' + term('lidar', 'lidar') + ' over the whole site at about 1–2 points per m²: a canopy height model (vegetation height above the lidar\'s own ground), treetops as local highs, and each crown grown down from its top. Gives position, height and crown spread — fine for diagrams, context and shade, not a tree survey (species, trunk size and condition need one). Leaf-off flights show smaller crowns.' },
  'curb-defaults': { t: 'Starting sizes', b: 'Stalls 9×18 ft; aisles 24 ft (90°), 18 ft one-way (60°), 13 ft one-way (45°); islands 9 ft wide with 3 ft corners; drive turn radius 15 ft. Typical starting sizes, not a code — change them per lot or aisle.' },
};

// ---------------------------------------------------------------- tooltip engine
const SHOW_MS = 280, LOCK_MS = 850;
let stack = [];               // [{ el (tooltip), anchor, locked, timer }]
let pending = null;

function content(a) {
  const key = a.dataset.tip, txt = a.dataset.tipText;
  const T = key ? TIPS[key] : null;
  if (!T && !txt) return null;
  const title = T?.t || a.dataset.tipTitle || '';
  const keys = T?.k ? `<span class="tip-keys">${K(T.k)}</span>` : '';
  return `${title ? `<div class="tip-h"><b>${title}</b>${keys}</div>` : ''}<div class="tip-b">${T ? T.b : escape(txt)}</div><i class="tip-lock"></i>`;
}
const escape = s => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

function place(tip, a, level) {
  const r = a.getBoundingClientRect(), tw = tip.offsetWidth, th = tip.offsetHeight, W = innerWidth, H = innerHeight;
  // Panel items open to the right of the panel; everything else beside / below its anchor.
  const panel = a.closest('.panel, .settings-drawer');
  let x, y;
  if (panel && level === 0) { const pr = panel.getBoundingClientRect(); x = pr.right + 8; y = r.top - 6; }
  else { x = r.right + 10; y = r.top - 4; if (x + tw > W - 8) { x = r.left; y = r.bottom + 8; } }
  if (x + tw > W - 8) x = Math.max(8, W - tw - 8);
  if (y + th > H - 8) y = Math.max(8, H - th - 8);
  tip.style.left = `${x}px`; tip.style.top = `${y}px`;
}
function open(a, level) {
  if (document.body.classList.contains('no-tips')) return;
  const html = content(a); if (!html) return;
  closeFrom(level);
  const tip = document.createElement('div');
  tip.className = 'tip'; tip.innerHTML = html;
  const mode = document.body.dataset.mode; if (mode) tip.dataset.mode = mode;
  document.body.appendChild(tip);
  place(tip, a, level);
  requestAnimationFrame(() => tip.classList.add('in'));
  const s = { el: tip, anchor: a, locked: false };
  s.timer = setTimeout(() => { s.locked = true; tip.classList.add('locked'); }, LOCK_MS);
  tip.addEventListener('mouseleave', e => { if (!stack.some(t => t.el.contains(e.relatedTarget))) setTimeout(checkClose, 60); });
  stack.push(s);
}
function closeFrom(level) {
  while (stack.length > level) { const s = stack.pop(); clearTimeout(s.timer); s.el.remove(); }
}
let lastMove = null;
function checkClose() {
  // Keep tips the cursor is over (or whose anchor it's over); a locked tip also keeps its parents.
  const el = lastMove;
  let keep = 0;
  for (let i = 0; i < stack.length; i++) {
    const s = stack[i];
    if (el && (s.el.contains(el) || s.anchor.contains(el))) keep = i + 1;
  }
  closeFrom(keep);
}

export function initTips() {
  document.addEventListener('mouseover', e => {
    lastMove = e.target;
    // Plain title attributes become styled tips too (and the browser's own tooltip goes away).
    const tt = e.target.closest?.('[title]');
    if (tt && !tt.dataset.tip && !tt.closest('.leaflet-control-attribution')) { tt.dataset.tipText = tt.getAttribute('title'); tt.removeAttribute('title'); }
    const a = e.target.closest?.('[data-tip], [data-tip-text]');
    clearTimeout(pending);
    if (!a) { setTimeout(checkClose, 80); return; }
    // Inside a tooltip: nested terms open the next level once that tooltip is locked.
    const host = stack.findIndex(s => s.el.contains(a));
    if (host >= 0) {
      if (!stack[host].locked) return;
      if (stack[host + 1]?.anchor === a) return;
      pending = setTimeout(() => open(a, host + 1), SHOW_MS * 0.6);
      return;
    }
    if (stack[0]?.anchor === a) return;
    pending = setTimeout(() => open(a, 0), SHOW_MS);
  });
  document.addEventListener('mousemove', e => { lastMove = e.target; }, { passive: true });
  document.addEventListener('mousedown', e => { if (!stack.some(s => s.el.contains(e.target))) { clearTimeout(pending); closeFrom(0); } });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeFrom(0); });
  window.addEventListener('blur', () => closeFrom(0));
  // Any title attribute on a tip anchor would double up with the browser's own tooltip.
  for (const a of document.querySelectorAll('[data-tip][title]')) a.removeAttribute('title');
}

// ---------------------------------------------------------------- coach notes
let coachEl = null, coachT = 0;
/** A short note at the bottom of the map (fades after a few seconds; hover keeps it). */
export function coach(text, host = document.querySelector('.stage')) {
  if (!text || document.body.classList.contains('no-coach')) return;
  if (!coachEl) {
    coachEl = document.createElement('div'); coachEl.className = 'coach';
    coachEl.addEventListener('mouseenter', () => clearTimeout(coachT));
    coachEl.addEventListener('mouseleave', () => { coachT = setTimeout(() => coachEl.classList.remove('in'), 1500); });
  }
  if (coachEl.parentElement !== host) host.appendChild(coachEl);
  coachEl.innerHTML = text;
  coachEl.classList.add('in');
  clearTimeout(coachT); coachT = setTimeout(() => coachEl.classList.remove('in'), 5500);
}
/** Show a hint element's text as a coach note whenever it changes (the element itself stays hidden). */
export function coachFrom(el) {
  if (!el) return;
  let last = '';
  new MutationObserver(() => {
    const t = el.innerHTML.trim();
    if (t && t !== last && !el.closest('[hidden]')) coach(t);
    last = t;
  }).observe(el, { childList: true, characterData: true, subtree: true });
}
