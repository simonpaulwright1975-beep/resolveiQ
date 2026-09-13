/* Raise a case.

   The company is not optional. A case with no company_id cannot reach a
   customer record — the database refuses it, and rightly — so the form will not
   submit until one is picked. Everything else can be filled in later.

   Loaded as a module so it stays out of the console's global scope; it talks to
   the app through window.RESOLVEIQ_APP. */

const $ = (id) => document.getElementById(id);

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = {
  open: false,
  company: null,
  contacts: [],
  results: [],
  searching: false,
  saving: false,
  error: null,
  searchedFor: ''
};

let searchTimer = null;
let lastFocused = null;

function reset() {
  Object.assign(state, {
    company: null, contacts: [], results: [], searching: false,
    saving: false, error: null, searchedFor: ''
  });
}

/* ---------- search ---------- */

async function search(query) {
  const q = String(query || '').trim();
  if (q.length < 2) {
    state.results = [];
    state.searchedFor = '';
    render();
    return;
  }

  state.searching = true;
  render();

  try {
    const response = await fetch('/api/companies?q=' + encodeURIComponent(q));
    const body = await response.json();
    state.results = Array.isArray(body.companies) ? body.companies : [];
    state.error = response.ok ? null : (body.error || 'Search failed');
  } catch (error) {
    state.results = [];
    state.error = 'Could not search companies — ' + error.message;
  } finally {
    state.searching = false;
    state.searchedFor = q;
    render();
  }
}

async function pickCompany(companyId) {
  state.company = state.results.find((c) => String(c.company_id) === String(companyId)) || null;
  state.results = [];
  state.contacts = [];
  render();
  if (!state.company) return;

  try {
    const response = await fetch('/api/contacts?company_id=' + encodeURIComponent(companyId));
    const body = await response.json();
    state.contacts = Array.isArray(body.contacts) ? body.contacts : [];
  } catch {
    state.contacts = [];   // a case can be raised without naming a person
  }
  render();
}

/* ---------- submit ---------- */

async function submit() {
  if (state.saving) return;

  // Read EVERY field before anything re-renders. render() rebuilds the form
  // from scratch, so a field read afterwards comes back as its default — which
  // silently threw away the priority, the note and the chosen contact.
  const form = {
    subject: $('nc-subject')?.value.trim() ?? '',
    note: $('nc-note')?.value.trim() || null,
    channel: $('nc-channel')?.value || 'Email',
    priority: $('nc-priority')?.value || 'Medium',
    personId: $('nc-contact')?.value || null
  };

  if (!state.company) { state.error = 'Pick a company first.'; render(); return; }
  if (!form.subject) { state.error = 'Give the case a subject.'; render(); return; }

  state.saving = true;
  state.error = null;
  render();

  try {
    const response = await fetch('/api/cases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        case: {
          /* No case_ref: the database issues one, so two agents raising a case
             at the same moment cannot collide on a reference. */
          company_id: state.company.company_id,
          person_id: form.personId ? Number(form.personId) : null,
          account_ref: state.company.account_ref || null,
          subject: form.subject,
          note: form.note,
          channel: form.channel,
          priority: form.priority,
          status: 'new',
          source: 'resolveiq'
        }
      })
    });

    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'HTTP ' + response.status);

    close();
    window.RESOLVEIQ_APP?.reload?.(body.case_ref);
  } catch (error) {
    state.error = error.message;
    state.saving = false;
    render();
    // Put their words back — losing a typed case because the network blipped
    // would be its own small betrayal.
    if ($('nc-subject')) $('nc-subject').value = form.subject;
    if ($('nc-note')) $('nc-note').value = form.note || '';
    if ($('nc-channel')) $('nc-channel').value = form.channel;
    if ($('nc-priority')) $('nc-priority').value = form.priority;
  }
}

/* ---------- render ---------- */

function render() {
  if (!state.open) return;

  const c = state.company;

  $('nc-body').innerHTML = c
    ? `<div class="nc-picked">
         <div>
           <strong>${esc(c.name)}</strong>
           <small>${esc([c.account_ref || 'No Sage 200 account', c.city, c.postcode].filter(Boolean).join(' · '))}</small>
         </div>
         <button type="button" data-nc="change">Change</button>
       </div>

       <label class="nc-field">
         <span class="label">Contact</span>
         <select id="nc-contact">
           <option value="">Not specified</option>
           ${state.contacts.map((p) => `
             <option value="${esc(p.person_id)}">
               ${esc(p.full_name || 'Unnamed')}${p.job_title ? ' — ' + esc(p.job_title) : ''}${p.is_primary ? ' (main)' : ''}
             </option>`).join('')}
         </select>
         ${state.contacts.length === 0
           ? '<small class="nc-hint">No active contacts on record for this company.</small>'
           : ''}
       </label>

       <label class="nc-field">
         <span class="label">What is the problem?</span>
         <input id="nc-subject" type="text" maxlength="200"
                placeholder="Refund not received after 10 days">
       </label>

       <label class="nc-field">
         <span class="label">Detail</span>
         <textarea id="nc-note" rows="3"
                   placeholder="What the customer told you, in their words."></textarea>
       </label>

       <div class="nc-row">
         <label class="nc-field">
           <span class="label">Channel</span>
           <select id="nc-channel">
             <option>Email</option><option>Voice</option><option>Chat</option>
           </select>
         </label>
         <label class="nc-field">
           <span class="label">Priority</span>
           <select id="nc-priority">
             <option>High</option><option selected>Medium</option><option>Low</option>
           </select>
         </label>
       </div>`
    : `<label class="nc-field">
         <span class="label">Which customer?</span>
         <input id="nc-search" type="search" autocomplete="off"
                placeholder="Company name or Sage account code">
         <small class="nc-hint">A case has to belong to a customer — it cannot be saved without one.</small>
       </label>
       ${state.searching ? '<p class="nc-hint">Searching…</p>' : ''}
       ${state.results.length
         ? `<ul class="nc-results">${state.results.map((r) => `
             <li><button type="button" data-nc="pick" data-id="${esc(r.company_id)}">
               <strong>${esc(r.name)}</strong>
               <small>${esc([r.account_ref || 'No Sage 200 account', r.city].filter(Boolean).join(' · '))}</small>
             </button></li>`).join('')}</ul>`
         : (!state.searching && state.searchedFor
             ? `<p class="nc-hint">Nothing matching “${esc(state.searchedFor)}”.</p>`
             : '')}`;

  $('nc-error').textContent = state.error || '';
  $('nc-error').hidden = !state.error;

  const submitBtn = $('nc-submit');
  submitBtn.disabled = !c || state.saving;
  submitBtn.textContent = state.saving ? 'Raising…' : 'Raise case';

  if (!c) {
    const input = $('nc-search');
    if (input) {
      input.addEventListener('input', (e) => {
        clearTimeout(searchTimer);
        const value = e.target.value;
        searchTimer = setTimeout(() => search(value), 250);
      });
      input.focus();
    }
  } else {
    $('nc-subject')?.focus();
  }
}

/* ---------- open / close ---------- */

function open() {
  if (state.open) return;
  lastFocused = document.activeElement;
  reset();
  state.open = true;
  $('new-case').hidden = false;
  $('new-case').classList.add('open');
  $('nc-scrim').classList.add('open');
  render();
}

function close() {
  state.open = false;
  $('new-case').classList.remove('open');
  $('nc-scrim').classList.remove('open');
  $('new-case').hidden = true;
  clearTimeout(searchTimer);
  if (lastFocused?.focus) lastFocused.focus();
}

document.addEventListener('DOMContentLoaded', () => {
  $('new-case-btn')?.addEventListener('click', open);
  $('nc-scrim')?.addEventListener('click', close);

  $('new-case')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-nc]');
    if (!btn) return;
    const action = btn.dataset.nc;
    if (action === 'close') close();
    else if (action === 'submit') submit();
    else if (action === 'pick') pickCompany(btn.dataset.id);
    else if (action === 'change') { state.company = null; state.contacts = []; render(); }
  });

  $('new-case')?.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    /* Enter submits from the subject line, but not from the detail box where a
       newline is what you actually want. */
    if (e.key === 'Enter' && e.target.id === 'nc-subject') { e.preventDefault(); submit(); }
  });
});
