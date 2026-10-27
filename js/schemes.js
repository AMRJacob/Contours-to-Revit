// Colour schemes for the Sketch tools: what each building use, site use and diagram element looks like.
// Different projects need different palettes, so schemes are editable, can be duplicated, and travel with a
// saved project (the project keeps a full copy of the scheme it uses).

const uses = list => list.map(([key, label, color]) => ({ key, label, color }));

/** Built-in schemes (never edited in place — editing one makes a copy). */
export const BUILTIN_SCHEMES = [
  {
    id: 'diagram', name: 'Diagram — warm', builtin: true,
    uses: uses([
      ['residential', 'Residential', '#f2b84b'], ['office', 'Office', '#5b8def'], ['retail', 'Retail', '#e4572e'],
      ['civic', 'Civic / institutional', '#8e6fd8'], ['hospitality', 'Hospitality', '#ec7aa8'], ['mixed', 'Mixed use', '#2bb3a3'],
      ['industrial', 'Industrial', '#94a3b8'], ['parking', 'Parking structure', '#6b7280'],
    ]),
    site: uses([
      ['lot', 'Parking lot', '#9aa3ad'], ['stripe', 'Stall lines', '#ffffff'], ['accessible', 'Accessible spaces', '#2563eb'],
      ['green', 'Green / open space', '#8cc084'], ['plaza', 'Plaza / hardscape', '#e8dcc6'], ['arrow', 'Arrows', '#e8913f'],
      ['region', 'Regions', '#f4a261'], ['label', 'Labels', '#1f2937'],
    ]),
  },
  {
    id: 'mono', name: 'Monochrome', builtin: true,
    uses: uses([
      ['residential', 'Residential', '#f3f4f6'], ['office', 'Office', '#d1d5db'], ['retail', 'Retail', '#9ca3af'],
      ['civic', 'Civic / institutional', '#6b7280'], ['hospitality', 'Hospitality', '#e5e7eb'], ['mixed', 'Mixed use', '#bfc5cc'],
      ['industrial', 'Industrial', '#4b5563'], ['parking', 'Parking structure', '#374151'],
    ]),
    site: uses([
      ['lot', 'Parking lot', '#a8adb3'], ['stripe', 'Stall lines', '#ffffff'], ['accessible', 'Accessible spaces', '#4b5563'],
      ['green', 'Green / open space', '#c7cdc4'], ['plaza', 'Plaza / hardscape', '#eceae6'], ['arrow', 'Arrows', '#111827'],
      ['region', 'Regions', '#6b7280'], ['label', 'Labels', '#111827'],
    ]),
  },
  {
    id: 'pastel', name: 'Pastel', builtin: true,
    uses: uses([
      ['residential', 'Residential', '#fde68a'], ['office', 'Office', '#bfdbfe'], ['retail', 'Retail', '#fecaca'],
      ['civic', 'Civic / institutional', '#ddd6fe'], ['hospitality', 'Hospitality', '#fbcfe8'], ['mixed', 'Mixed use', '#a7f3d0'],
      ['industrial', 'Industrial', '#e2e8f0'], ['parking', 'Parking structure', '#cbd5e1'],
    ]),
    site: uses([
      ['lot', 'Parking lot', '#cfd5dc'], ['stripe', 'Stall lines', '#ffffff'], ['accessible', 'Accessible spaces', '#93c5fd'],
      ['green', 'Green / open space', '#bbf7d0'], ['plaza', 'Plaza / hardscape', '#f5efe3'], ['arrow', 'Arrows', '#fb923c'],
      ['region', 'Regions', '#fdba74'], ['label', 'Labels', '#334155'],
    ]),
  },
  {
    id: 'bold', name: 'Bold', builtin: true,
    uses: uses([
      ['residential', 'Residential', '#facc15'], ['office', 'Office', '#2563eb'], ['retail', 'Retail', '#dc2626'],
      ['civic', 'Civic / institutional', '#7c3aed'], ['hospitality', 'Hospitality', '#db2777'], ['mixed', 'Mixed use', '#059669'],
      ['industrial', 'Industrial', '#475569'], ['parking', 'Parking structure', '#1f2937'],
    ]),
    site: uses([
      ['lot', 'Parking lot', '#64748b'], ['stripe', 'Stall lines', '#f8fafc'], ['accessible', 'Accessible spaces', '#1d4ed8'],
      ['green', 'Green / open space', '#16a34a'], ['plaza', 'Plaza / hardscape', '#d6c7a1'], ['arrow', 'Arrows', '#ea580c'],
      ['region', 'Regions', '#f97316'], ['label', 'Labels', '#0f172a'],
    ]),
  },
];

const KEY = 'c2r-schemes';
const clone = o => JSON.parse(JSON.stringify(o));

/** The user's own schemes (saved in this browser). */
export function userSchemes() { try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; } }
function saveUser(list) { try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* ignore */ } }
export const allSchemes = () => [...BUILTIN_SCHEMES, ...userSchemes()];
export const schemeById = id => allSchemes().find(s => s.id === id) || null;

/** Store a user scheme (new or updated). A built-in scheme is copied first. Returns the stored scheme. */
export function saveScheme(sc) {
  const list = userSchemes();
  const s = clone(sc);
  if (s.builtin) { s.id = `u${Date.now().toString(36)}`; s.builtin = false; s.name = `${s.name} (copy)`; }
  const i = list.findIndex(x => x.id === s.id);
  if (i >= 0) list[i] = s; else list.push(s);
  saveUser(list);
  return s;
}
export function deleteScheme(id) { saveUser(userSchemes().filter(s => s.id !== id)); }
export function duplicateScheme(sc, name) {
  const s = clone(sc); s.id = `u${Date.now().toString(36)}`; s.builtin = false; s.name = name || `${sc.name} (copy)`;
  return saveScheme(s);
}

/** Colour of a use / site key in a scheme (falls back to grey). */
export function colorOf(sc, key) {
  return (sc.uses.find(u => u.key === key) || sc.site.find(u => u.key === key))?.color || '#9ca3af';
}
export const hexRgb = h => { const n = parseInt(h.slice(1), 16); return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]; };
