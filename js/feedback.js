// "Suggest or report": requests and issues from anyone using the app, kept in a small hosted table.
// Anyone can add one. An item appears in the list (Settings › Requests) once it has been looked at; until then the
// browser that sent it shows it from its own copy. Status and replies are set outside the app.

const API = 'https://keoxhzjfhxkgwavorhgk.supabase.co/rest/v1/c2r_feedback';
const KEY = 'sb_publishable_2SkBpC4idsE6DKA6QiHxog_yhBhHBDk'; // publishable key: may only add items and read reviewed ones
const HEAD = { apikey: KEY, 'Content-Type': 'application/json' };

export const STATUS = {
  new: 'New', under_review: 'Under review', planned: 'Planned', in_progress: 'In progress',
  complete: 'Complete – closed', infeasible: 'Infeasible – closed', duplicate: 'Duplicate – closed', wont_do: 'Won’t do – closed',
};
const CLOSED = ['complete', 'infeasible', 'duplicate', 'wont_do'];
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const mine = () => { try { return JSON.parse(localStorage.getItem('c2r-fb-mine') || '[]'); } catch { return []; } };
const saveMine = a => { try { localStorage.setItem('c2r-fb-mine', JSON.stringify(a.slice(0, 60))); } catch { /* ignore */ } };
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, c => (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16)));

export async function addFeedback(f) {
  const row = { id: uuid(), kind: f.kind, title: f.title.trim().slice(0, 200), details: f.details?.trim().slice(0, 4000) || null, name: f.name?.trim().slice(0, 80) || null,
    page: f.page?.slice(0, 120) || null, app_version: f.version?.slice(0, 20) || null, agent: navigator.userAgent.slice(0, 300) };
  const r = await fetch(API, { method: 'POST', headers: { ...HEAD, Prefer: 'return=minimal' }, body: JSON.stringify(row) });
  if (!r.ok) { let m = `HTTP ${r.status}`; try { m = (await r.json()).message || m; } catch { /* ignore */ } throw new Error(m); }
  saveMine([{ id: row.id, kind: row.kind, title: row.title, details: row.details, page: row.page, status: 'new', created_at: new Date().toISOString() }, ...mine()]);
  return row;
}
export async function listFeedback() {
  const r = await fetch(`${API}?select=id,kind,title,details,status,notes,page,app_version,created_at,closed_at&order=created_at.desc&limit=300`, { headers: HEAD });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const rows = await r.json(), seen = new Set(rows.map(x => x.id));
  // This browser's own items that haven't been looked at yet.
  return [...mine().filter(m => !seen.has(m.id)).map(m => ({ ...m, own: true })), ...rows].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}

/**
 * Wire up the header button, the pop-over form and the list in Settings.
 * ctx: { where() -> "Site design · 3D", version }
 */
export function initFeedback(ctx) {
  const btn = document.getElementById('fb-open'), pop = document.getElementById('fb-pop'), list = document.getElementById('fb-list');
  if (!btn || !pop) return;
  let kind = 'request', show = 'open', items = null, openId = null;
  const form = () => {
    const where = ctx.where();
    pop.innerHTML = `<div class="fb-head"><b>Suggest or report</b><button type="button" class="fb-x" aria-label="Close">✕</button></div>
      <div class="fb-kind" role="radiogroup" aria-label="Type"><button type="button" role="radio" data-k="request" aria-checked="${kind === 'request'}" class="${kind === 'request' ? 'on' : ''}">Request</button><button type="button" role="radio" data-k="issue" aria-checked="${kind === 'issue'}" class="${kind === 'issue' ? 'on' : ''}">Something’s wrong</button></div>
      <input id="fb-title" maxlength="200" aria-label="Title" placeholder="${kind === 'request' ? 'What would help? e.g. “Curved retaining walls”' : 'What went wrong? e.g. “Contours missing after I move a pad”'}">
      <textarea id="fb-details" rows="4" maxlength="4000" aria-label="Details" placeholder="${kind === 'request' ? 'Details, examples, how it should work (optional)' : 'What you did, what you expected, what happened (optional)'}"></textarea>
      <input id="fb-name" maxlength="80" aria-label="Your name" placeholder="Your name (optional — not shown in the list)">
      <div class="fb-from">From: ${esc(where)} · v${esc(ctx.version)}</div>
      <div class="fb-actions"><button type="button" class="btn btn-primary" id="fb-add" disabled>Add</button><button type="button" class="btn" id="fb-cancel">Cancel</button></div>
      <div class="fb-err" id="fb-err" hidden></div>`;
    try { pop.querySelector('#fb-name').value = localStorage.getItem('c2r-fb-name') || ''; } catch { /* ignore */ }
    const title = pop.querySelector('#fb-title'), add = pop.querySelector('#fb-add');
    title.addEventListener('input', () => { add.disabled = !title.value.trim(); });
    setTimeout(() => title.focus(), 0);
  };
  const close = () => { pop.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
  btn.addEventListener('click', () => { if (pop.hidden) { form(); pop.hidden = false; btn.setAttribute('aria-expanded', 'true'); } else close(); });
  pop.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Escape') close(); });   // typing here must not trigger tool hotkeys
  pop.addEventListener('click', async e => {
    const k = e.target.closest('[data-k]');
    if (k) { const t = pop.querySelector('#fb-title').value, d = pop.querySelector('#fb-details').value; kind = k.dataset.k; form(); pop.querySelector('#fb-title').value = t; pop.querySelector('#fb-details').value = d; pop.querySelector('#fb-add').disabled = !t.trim(); return; }
    if (e.target.closest('.fb-x, #fb-cancel, #fb-done')) { close(); return; }
    if (e.target.closest('#fb-all')) { close(); return; }                                              // (its data-settings attribute opens the list)
    if (!e.target.closest('#fb-add')) return;
    const add = pop.querySelector('#fb-add'), err = pop.querySelector('#fb-err'), name = pop.querySelector('#fb-name').value;
    add.disabled = true; add.textContent = 'Adding…'; err.hidden = true;
    try {
      await addFeedback({ kind, title: pop.querySelector('#fb-title').value, details: pop.querySelector('#fb-details').value, name, page: ctx.where(), version: ctx.version });
      try { localStorage.setItem('c2r-fb-name', name.trim()); } catch { /* ignore */ }
      pop.innerHTML = `<div class="fb-head"><b>Sent — thanks</b><button type="button" class="fb-x" aria-label="Close">✕</button></div>
        <p class="fb-sent">It’s in <button type="button" class="link" id="fb-all" data-settings="requests">Settings › Requests</button>. Everyone else sees it there once it has been looked at.</p>
        <div class="fb-actions"><button type="button" class="btn" id="fb-done">Close</button></div>`;
      items = null; if (list && !list.closest('.set-sec')?.hidden) load();
    } catch (x) { err.textContent = `Couldn’t send it (${x.message}). Your text is still here.`; err.hidden = false; add.disabled = false; add.textContent = 'Add'; }
  });

  // ----- the list (Settings › Requests) -----
  if (!list) return;
  const draw = () => {
    if (!items) { list.innerHTML = '<p class="fb-empty">Loading…</p>'; return; }
    const nOpen = items.filter(f => !CLOSED.includes(f.status)).length, nClosed = items.length - nOpen;
    const vis = items.filter(f => show === 'all' || (show === 'closed') === CLOSED.includes(f.status));
    list.innerHTML = `<div class="fb-tabs" role="tablist">${[['open', `Open (${nOpen})`], ['closed', `Closed (${nClosed})`], ['all', 'All']].map(([k, t]) => `<button type="button" role="tab" data-show="${k}" aria-selected="${show === k}" class="${show === k ? 'on' : ''}">${t}</button>`).join('')}</div>`
      + (vis.length ? `<ul class="fb-items">${vis.map(f => {
        const ex = openId === f.id, closed = CLOSED.includes(f.status);
        return `<li class="fb-item${closed ? ' closed' : ''}"><div class="fb-row"><span class="fb-check${closed ? ' done' : ''}" aria-hidden="true">${f.status === 'complete' ? '✓' : closed ? '–' : ''}</span>
          <button type="button" class="fb-title" data-id="${esc(f.id)}" aria-expanded="${ex}"><span class="fb-tag ${esc(f.kind)}">${f.kind === 'request' ? 'Request' : 'Issue'}</span>${esc(f.title)}</button>
          <span class="fb-status s-${esc(f.status)}">${esc(STATUS[f.status] || f.status)}</span></div>
          ${f.notes && !ex ? `<p class="fb-note">${esc(f.notes)}</p>` : ''}
          ${ex ? `<div class="fb-body">${f.details ? `<p>${esc(f.details)}</p>` : ''}${f.notes ? `<p class="fb-note">${esc(f.notes)}</p>` : ''}<p class="fb-meta">Added ${new Date(f.created_at).toLocaleDateString()}${f.page ? ` from ${esc(f.page)}` : ''}${f.app_version ? ` · v${esc(f.app_version)}` : ''}${f.closed_at ? ` · closed ${new Date(f.closed_at).toLocaleDateString()}` : ''}${f.own ? ' · sent from this browser, not looked at yet' : ''}</p></div>` : ''}</li>`;
      }).join('')}</ul>` : '<p class="fb-empty">Nothing here.</p>');
  };
  const load = () => { draw(); listFeedback().then(x => { items = x; draw(); }).catch(x => { list.innerHTML = `<p class="fb-empty">Couldn’t load the list (${esc(x.message)}).</p>`; }); };
  list.addEventListener('click', e => {
    const t = e.target.closest('[data-show]'); if (t) { show = t.dataset.show; draw(); return; }
    const b = e.target.closest('.fb-title'); if (b) { openId = openId === b.dataset.id ? null : b.dataset.id; draw(); }
  });
  // Load whenever the Requests section comes into view.
  const sec = list.closest('.set-sec');
  new MutationObserver(() => { if (!sec.hidden && !document.getElementById('settings').hidden) load(); }).observe(sec, { attributes: true, attributeFilter: ['hidden'] });
  new MutationObserver(() => { if (!sec.hidden && !document.getElementById('settings').hidden) load(); }).observe(document.getElementById('settings'), { attributes: true, attributeFilter: ['hidden'] });
  document.getElementById('fb-new')?.addEventListener('click', () => { if (pop.hidden) btn.click(); });
}
