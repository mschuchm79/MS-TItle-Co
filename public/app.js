// MS Title Co – single-page frontend (no build step).

// ------------------------------------------------------------------ helpers

class Raw { constructor(s) { this.s = s; } }
const raw = (s) => new Raw(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (v) => (v instanceof Raw ? v.s : Array.isArray(v) ? v.map(fmt).join('') : v == null || v === false ? '' : esc(v));
// Tagged template that HTML-escapes every interpolated value unless it is already Raw.
const html = (strings, ...vals) => raw(strings.reduce((out, s, i) => out + s + (i < vals.length ? fmt(vals[i]) : ''), ''));

const $app = document.getElementById('app');
const render = (tpl) => { $app.innerHTML = tpl.s; };

const usd = (n) => Number(n || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const usd0 = (n) => Number(n || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const today = () => new Date().toISOString().slice(0, 10);
const niceDate = (d) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—');
const niceDateTime = (d) => (d ? new Date(`${d.replace(' ', 'T')}Z`).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) : '');
const titleCase = (s) => String(s).replaceAll('_', ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const daysUntil = (d) => Math.round((new Date(`${d}T00:00:00`) - new Date(`${today()}T00:00:00`)) / 86400000);

let toastTimer;
function toast(msg, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `show${isError ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, 3500);
}

async function api(method, path, body, headers) {
  const opts = { method, headers: { ...headers } };
  if (body instanceof Blob) opts.body = body;
  else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`/api${path}`, opts);
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.details = data.details;
    throw err;
  }
  return data;
}

const formData = (form) => Object.fromEntries(new FormData(form).entries());

let META = null;
const stageBadge = (key, label) => {
  const cls = key === 'closed' ? 'ok' : ['closing', 'funding'].includes(key) ? 'warn' : '';
  return html`<span class="badge ${cls}">${label}</span>`;
};

// ------------------------------------------------------------------ router

const state = { stageFilter: '', q: '', file: null };

async function route() {
  if (!META) META = await api('GET', '/meta');
  const [, view, id, tab] = location.hash.replace(/^#/, '').split('/');
  try {
    if (view === 'new') return renderNew();
    if (view === 'files' && id) return await renderFile(id, tab || 'tasks');
    return await renderDashboard();
  } catch (e) {
    render(html`<div class="card"><h2>Something went wrong</h2><p class="muted">${e.message}</p><a href="#/">Back to dashboard</a></div>`);
  }
}
window.addEventListener('hashchange', route);

// ------------------------------------------------------------------ dashboard

async function renderDashboard() {
  const params = new URLSearchParams();
  if (state.stageFilter) params.set('stage', state.stageFilter);
  if (state.q) params.set('q', state.q);
  const [dash, files] = await Promise.all([api('GET', '/dashboard'), api('GET', `/transactions?${params}`)]);

  render(html`
    <div class="stats">
      <div class="stat"><div class="n">${dash.activeFiles}</div><div class="l">Active files</div></div>
      <div class="stat"><div class="n">${dash.upcomingClosings.length}</div><div class="l">Closing in next 14 days</div></div>
      <div class="stat"><div class="n" style="color:${dash.overdueTasks.length ? 'var(--danger)' : 'inherit'}">${dash.overdueTasks.length}</div><div class="l">Overdue tasks</div></div>
    </div>

    <div class="card">
      <h2>Pipeline</h2>
      <div class="pipeline">
        ${dash.stages.map((s) => html`
          <button data-action="filter-stage" data-stage="${s.key}" class="${state.stageFilter === s.key ? 'active' : ''}">
            <div class="n">${s.count}</div><div class="l">${s.label}</div>
          </button>`)}
      </div>
    </div>

    <div class="grid grid-2">
      <div class="card">
        <h2>Upcoming closings</h2>
        ${dash.upcomingClosings.length ? html`<table><tbody>
          ${dash.upcomingClosings.map((c) => html`
            <tr class="clickable" data-href="#/files/${c.id}">
              <td><strong>${niceDate(c.closing_date)}</strong><div class="small muted">${daysUntil(c.closing_date) === 0 ? 'Today' : `in ${daysUntil(c.closing_date)} days`}</div></td>
              <td>${c.property_address}<div class="small muted">${c.file_number}</div></td>
              <td>${stageBadge(c.stage, c.stage_label)}</td>
            </tr>`)}
        </tbody></table>` : html`<div class="empty">No closings in the next two weeks.</div>`}
      </div>
      <div class="card">
        <h2>Overdue tasks</h2>
        ${dash.overdueTasks.length ? html`<table><tbody>
          ${dash.overdueTasks.slice(0, 8).map((t) => html`
            <tr class="clickable" data-href="#/files/${t.transaction_id}/tasks">
              <td>${t.title}<div class="small muted">${t.file_number} · ${t.property_address}</div></td>
              <td class="overdue small">${niceDate(t.due_date)}</td>
            </tr>`)}
        </tbody></table>` : html`<div class="empty">Nothing overdue. 🎉</div>`}
      </div>
    </div>

    <div class="card">
      <div class="spread">
        <h2>Files ${state.stageFilter ? html`<span class="muted small">· ${META.stages.find((s) => s.key === state.stageFilter)?.label} <button class="link-btn" data-action="filter-stage" data-stage="">clear</button></span>` : ''}</h2>
        <form data-form="search" class="row" style="min-width:260px">
          <input name="q" type="search" placeholder="Search address, file #, or party…" value="${state.q}">
        </form>
      </div>
      ${files.length ? html`<div class="table-wrap"><table>
        <thead><tr><th>File</th><th>Property</th><th class="hide-sm">Buyer / Seller</th><th class="num">Price</th><th>Closing</th><th>Stage</th><th class="hide-sm">Tasks</th></tr></thead>
        <tbody>
          ${files.map((f) => html`
            <tr class="clickable" data-href="#/files/${f.id}">
              <td><strong>${f.file_number}</strong></td>
              <td>${f.property_address}<div class="small muted">${[f.city, f.state].filter(Boolean).join(', ')}</div></td>
              <td class="hide-sm small">${f.buyers || '—'}<div class="muted">${f.sellers || '—'}</div></td>
              <td class="num">${usd0(f.purchase_price)}</td>
              <td>${niceDate(f.closing_date)}</td>
              <td>${stageBadge(f.stage, f.stage_label)}</td>
              <td class="hide-sm small muted">${f.tasks_done}/${f.tasks_total}</td>
            </tr>`)}
        </tbody></table></div>`
        : html`<div class="empty">No files found. <a href="#/new">Open a new file</a>.</div>`}
    </div>
  `);
}

// ------------------------------------------------------------------ new file

function renderNew() {
  render(html`
    <h1>Open a new file</h1>
    <p class="muted">Creates the file, generates the full closing checklist, and seeds a draft commitment.</p>
    <form data-form="create" class="grid grid-2">
      <div>
        <div class="card">
          <h2>Property</h2>
          <label>Street address *<input name="property_address" required autocomplete="off"></label>
          <div class="form-grid">
            <label>City<input name="city"></label>
            <label>State<input name="state" maxlength="2" placeholder="FL"></label>
            <label>ZIP<input name="zip" maxlength="10"></label>
            <label>County<input name="county"></label>
          </div>
          <label>Parcel / APN<input name="parcel_number"></label>
          <label>Legal description<textarea name="legal_description"></textarea></label>
        </div>
        <div class="card">
          <h2>Parties</h2>
          <p class="small muted">You can add lenders, agents, and others after the file is open.</p>
          ${[['buyer', 'Buyer'], ['seller', 'Seller']].map(([role, label]) => html`
            <div class="form-grid">
              <input type="hidden" name="${role}_role" value="${role}">
              <label>${label} name<input name="${role}_name"></label>
              <label>${label} email<input name="${role}_email" type="email"></label>
            </div>`)}
        </div>
      </div>
      <div>
        <div class="card">
          <h2>Deal terms</h2>
          <div class="form-grid">
            <label>Purchase price *<input name="purchase_price" type="number" min="1" step="0.01" required></label>
            <label>Loan amount <span class="small">(0 = cash)</span><input name="loan_amount" type="number" min="0" step="0.01" value="0"></label>
          </div>
          <label>Target closing date<input name="closing_date" type="date"></label>
        </div>
        <div class="card">
          <h2>Title & escrow estimate</h2>
          <div id="estimate" class="small muted">Enter a purchase price to see an estimate.</div>
        </div>
        <div class="row"><button class="btn btn-primary" type="submit">Open file</button><a class="btn" href="#/">Cancel</a></div>
      </div>
    </form>
  `);
}

let estimateTimer;
async function updateEstimate(form) {
  const price = Number(form.purchase_price.value);
  const loan = Number(form.loan_amount.value) || 0;
  const el = document.getElementById('estimate');
  if (!el) return;
  if (!(price > 0)) { el.innerHTML = 'Enter a purchase price to see an estimate.'; return; }
  const est = await api('GET', `/estimate?price=${price}&loan=${loan}`);
  el.innerHTML = costsTable(est).s;
}

function costsTable(est) {
  return html`
    <table>
      <thead><tr><th>Charge</th><th class="num">Buyer</th><th class="num">Seller</th></tr></thead>
      <tbody>
        ${est.lines.map((l) => html`<tr><td>${l.label}</td><td class="num">${l.payer === 'buyer' ? usd(l.amount) : ''}</td><td class="num">${l.payer === 'seller' ? usd(l.amount) : ''}</td></tr>`)}
        <tr><th>Total</th><th class="num">${usd(est.buyerTotal)}</th><th class="num">${usd(est.sellerTotal)}</th></tr>
      </tbody>
    </table>
    <p class="notice" style="margin-top:12px">${est.disclaimer}</p>`;
}

// ------------------------------------------------------------------ file detail

const TABS = [
  ['tasks', 'Checklist'],
  ['commitment', 'Commitment'],
  ['parties', 'Parties'],
  ['documents', 'Documents'],
  ['costs', 'Closing costs'],
  ['details', 'Details'],
  ['activity', 'Activity'],
];

async function renderFile(id, tab) {
  const f = await api('GET', `/transactions/${id}`);
  state.file = f;
  const curIdx = f.progress.stageIndex;
  const isClosed = f.stage === 'closed';

  render(html`
    <div class="card">
      <div class="spread">
        <div>
          <div class="small muted">${f.file_number} · ${f.financed ? `Financed (${usd0(f.loan_amount)} loan)` : 'Cash purchase'}</div>
          <h1>${f.property_address}</h1>
          <div class="muted">${[f.city, f.state, f.zip].filter(Boolean).join(', ')}${f.county ? ` · ${f.county} County` : ''}</div>
        </div>
        <div style="text-align:right">
          <div class="small muted">Purchase price</div>
          <div style="font-size:1.3rem;font-weight:700">${usd0(f.purchase_price)}</div>
          <div class="small muted">Closing ${niceDate(f.closing_date)}${f.closing_date && !isClosed ? html` · <span class="${daysUntil(f.closing_date) < 0 ? 'overdue' : ''}">${daysUntil(f.closing_date)} days</span>` : ''}</div>
        </div>
      </div>

      <div class="stepper" aria-label="Progress">
        ${META.stages.map((s, i) => html`
          <div class="step ${i < curIdx || isClosed ? 'done' : i === curIdx ? 'current' : ''}" title="${s.label}: ${s.description}">
            <div class="bar"></div><div class="name">${s.label}</div>
          </div>`)}
      </div>

      <div class="spread" style="margin-top:12px">
        <div>
          <strong>Current stage: ${f.stage_label}</strong>
          <div class="small muted">${META.stages[curIdx].description}</div>
        </div>
        <div class="row">
          ${curIdx > 0 ? html`<button class="btn btn-sm" data-action="revert">← Back</button>` : ''}
          ${!isClosed ? html`<button class="btn btn-primary" data-action="advance" ${f.blockers.length ? 'disabled' : ''}>Advance to ${META.stages[curIdx + 1].label} →</button>` : ''}
        </div>
      </div>
      ${isClosed ? html`<div class="ready">File complete. All ${f.progress.tasksTotal} tasks done.</div>`
        : f.blockers.length ? html`<div class="blockers"><strong>${f.blockers.length} item${f.blockers.length > 1 ? 's' : ''} to finish before advancing:</strong>
            <ul>${f.blockers.slice(0, 6).map((b) => html`<li>${b.message}</li>`)}${f.blockers.length > 6 ? html`<li>…and ${f.blockers.length - 6} more</li>` : ''}</ul></div>`
        : html`<div class="ready">Ready to advance.</div>`}
    </div>

    <nav class="tabs">
      ${TABS.map(([k, label]) => html`<a href="#/files/${f.id}/${k}" class="${tab === k ? 'active' : ''}">${label}${k === 'tasks' ? ` (${f.progress.tasksDone}/${f.progress.tasksTotal})` : ''}</a>`)}
    </nav>

    ${({ tasks: tasksTab, commitment: commitmentTab, parties: partiesTab, documents: documentsTab, costs: costsTab, details: detailsTab, activity: activityTab }[tab] || tasksTab)(f)}
  `);
}

function tasksTab(f) {
  const curIdx = f.progress.stageIndex;
  return html`
    ${META.stages.filter((s) => f.tasks.some((t) => t.stage === s.key)).map((s) => {
      const tasks = f.tasks.filter((t) => t.stage === s.key);
      const done = tasks.filter((t) => t.completed_at).length;
      const idx = META.stages.findIndex((x) => x.key === s.key);
      return html`
        <div class="card stage-group ${idx === curIdx ? 'current' : ''}">
          <div class="spread"><h2>${s.label}</h2><span class="badge ${done === tasks.length ? 'ok' : ''}">${done}/${tasks.length}</span></div>
          ${tasks.map((t) => {
            const overdue = !t.completed_at && t.due_date && t.due_date < today();
            return html`
              <div class="task ${t.completed_at ? 'done' : ''}">
                <input type="checkbox" data-action="toggle-task" data-id="${t.id}" ${t.completed_at ? 'checked' : ''} aria-label="${t.title}">
                <div class="body">
                  <div class="title">${t.title}</div>
                  <div class="meta">
                    ${t.completed_at ? `Done ${niceDateTime(t.completed_at)}` : t.due_date ? html`<span class="${overdue ? 'overdue' : ''}">Due ${niceDate(t.due_date)}</span>` : 'No due date'}
                    ${t.assignee ? ` · ${t.assignee}` : ''}
                  </div>
                </div>
                <button class="link-btn" data-action="delete-task" data-id="${t.id}" title="Remove task" aria-label="Remove task">✕</button>
              </div>`;
          })}
        </div>`;
    })}
    <div class="card">
      <h2>Add a task</h2>
      <form data-form="add-task" class="inline-form">
        <input name="title" placeholder="Task description" required>
        <select name="stage">${META.stages.map((s) => html`<option value="${s.key}" ${s.key === f.stage ? 'selected' : ''}>${s.label}</option>`)}</select>
        <input name="due_date" type="date">
        <input name="assignee" placeholder="Assignee">
        <button class="btn btn-primary">Add</button>
      </form>
    </div>`;
}

function commitmentTab(f) {
  const section = (schedule, title, help, statuses) => {
    const items = f.commitment.filter((c) => c.schedule === schedule);
    return html`
      <div class="card">
        <h2>${title}</h2>
        <p class="small muted">${help}</p>
        ${items.length ? items.map((c) => html`
          <div class="item">
            <div class="body">${c.description}${c.notes ? html`<div class="small muted">${c.notes}</div>` : ''}</div>
            <select data-action="item-status" data-id="${c.id}" aria-label="Status">
              ${statuses.map((s) => html`<option value="${s}" ${c.status === s ? 'selected' : ''}>${titleCase(s)}</option>`)}
            </select>
            <button class="link-btn" data-action="delete-item" data-id="${c.id}" aria-label="Remove">✕</button>
          </div>`) : html`<div class="empty">None.</div>`}
        <form data-form="add-item" class="inline-form">
          <input type="hidden" name="schedule" value="${schedule}">
          <input name="description" placeholder="Add ${schedule === 'B-I' ? 'requirement' : 'exception'}…" required>
          <button class="btn">Add</button>
        </form>
      </div>`;
  };
  const open = f.commitment.filter((c) => c.schedule === 'B-I' && c.status === 'open').length;
  return html`
    <div class="card">
      <h2>Schedule A</h2>
      <div class="form-grid small">
        <div><div class="muted">Proposed insured (owner)</div>${f.parties.filter((p) => p.role === 'buyer').map((p) => p.name).join(', ') || '—'}</div>
        <div><div class="muted">Proposed insured (lender)</div>${f.financed ? f.parties.filter((p) => p.role === 'lender').map((p) => p.name).join(', ') || 'Lender TBD' : 'N/A (cash)'}</div>
        <div><div class="muted">Vested owner</div>${f.parties.filter((p) => p.role === 'seller').map((p) => p.name).join(', ') || '—'}</div>
        <div><div class="muted">Policy amounts</div>Owner ${usd0(f.purchase_price)}${f.financed ? ` · Loan ${usd0(f.loan_amount)}` : ''}</div>
      </div>
      <div class="small" style="margin-top:12px"><div class="muted">Legal description</div>${f.legal_description || html`<em class="muted">Not entered — add it on the Details tab.</em>`}</div>
    </div>
    ${section('B-I', `Schedule B-I · Requirements ${open ? `(${open} open)` : '(all cleared)'}`, 'Conditions that must be satisfied before policies can issue. Open requirements block advancing past “Clearing Title”.', ['open', 'satisfied', 'waived'])}
    ${section('B-II', 'Schedule B-II · Exceptions', 'Matters excluded from coverage. Mark “Removed” when an exception will be deleted at closing (e.g., survey obtained).', ['remains', 'removed'])}`;
}

function partiesTab(f) {
  return html`
    <div class="card">
      <h2>Parties & contacts</h2>
      ${f.parties.length ? html`<div class="table-wrap"><table>
        <thead><tr><th>Role</th><th>Name</th><th>Company</th><th>Email</th><th>Phone</th><th></th></tr></thead>
        <tbody>${f.parties.map((p) => html`
          <tr>
            <td><span class="badge">${titleCase(p.role)}</span></td>
            <td>${p.name}</td>
            <td>${p.company || ''}</td>
            <td>${p.email ? html`<a href="mailto:${p.email}">${p.email}</a>` : ''}</td>
            <td>${p.phone || ''}</td>
            <td><button class="link-btn" data-action="delete-party" data-id="${p.id}" aria-label="Remove">✕</button></td>
          </tr>`)}</tbody></table></div>` : html`<div class="empty">No parties yet.</div>`}
      <form data-form="add-party" class="inline-form">
        <select name="role">${META.partyRoles.map((r) => html`<option value="${r}">${titleCase(r)}</option>`)}</select>
        <input name="name" placeholder="Name" required>
        <input name="company" placeholder="Company">
        <input name="email" type="email" placeholder="Email">
        <input name="phone" placeholder="Phone">
        <button class="btn btn-primary">Add</button>
      </form>
    </div>`;
}

function documentsTab(f) {
  return html`
    <div class="card">
      <h2>Documents</h2>
      ${f.documents.length ? html`<div class="table-wrap"><table>
        <thead><tr><th>Document</th><th>Category</th><th>Status</th><th>File</th><th></th></tr></thead>
        <tbody>${f.documents.map((d) => html`
          <tr>
            <td>${d.name}</td>
            <td class="small">${titleCase(d.category)}</td>
            <td>
              <select data-action="doc-status" data-id="${d.id}" aria-label="Status" style="width:auto">
                ${META.documentStatuses.map((s) => html`<option value="${s}" ${d.status === s ? 'selected' : ''}>${titleCase(s)}</option>`)}
              </select>
            </td>
            <td class="small">
              ${d.filename ? html`<a href="/api/transactions/${f.id}/documents/${d.id}/file">${d.filename}</a> <span class="muted">(${Math.ceil(d.size / 1024)} KB)</span><br>` : ''}
              <label class="btn btn-sm" style="margin:4px 0 0;display:inline-flex">${d.filename ? 'Replace' : 'Upload'}
                <input type="file" data-action="upload" data-id="${d.id}" hidden>
              </label>
            </td>
            <td><button class="link-btn" data-action="delete-doc" data-id="${d.id}" aria-label="Remove">✕</button></td>
          </tr>`)}</tbody></table></div>` : html`<div class="empty">No documents tracked yet.</div>`}
      <form data-form="add-doc" class="inline-form">
        <input name="name" placeholder="Document name (e.g. Payoff letter)" required>
        <select name="category">${META.documentCategories.map((c) => html`<option value="${c}">${titleCase(c)}</option>`)}</select>
        <button class="btn btn-primary">Track document</button>
      </form>
    </div>`;
}

function costsTab(f) {
  return html`<div class="card"><h2>Estimated title & escrow charges</h2>${costsTable(f.costs)}</div>`;
}

function detailsTab(f) {
  return html`
    <form data-form="update" class="card">
      <h2>File details</h2>
      <label>Street address<input name="property_address" value="${f.property_address}" required></label>
      <div class="form-grid">
        <label>City<input name="city" value="${f.city || ''}"></label>
        <label>State<input name="state" maxlength="2" value="${f.state || ''}"></label>
        <label>ZIP<input name="zip" value="${f.zip || ''}"></label>
        <label>County<input name="county" value="${f.county || ''}"></label>
        <label>Parcel / APN<input name="parcel_number" value="${f.parcel_number || ''}"></label>
        <label>Closing date<input name="closing_date" type="date" value="${f.closing_date || ''}"></label>
        <label>Purchase price<input name="purchase_price" type="number" min="1" step="0.01" value="${f.purchase_price}"></label>
        <label>Loan amount<input name="loan_amount" type="number" min="0" step="0.01" value="${f.loan_amount}"></label>
      </div>
      <label>Legal description<textarea name="legal_description">${f.legal_description || ''}</textarea></label>
      <p class="small muted">Changing the closing date reschedules every open checklist task that hasn't been manually re-dated.</p>
      <div class="spread">
        <button class="btn btn-primary">Save changes</button>
        <button type="button" class="btn btn-danger" data-action="delete-file">Delete file</button>
      </div>
    </form>`;
}

function activityTab(f) {
  return html`
    <div class="card">
      <h2>Activity & notes</h2>
      <form data-form="add-note" class="inline-form" style="margin:0 0 12px">
        <input name="message" placeholder="Add a note to the file…" required>
        <button class="btn btn-primary">Add note</button>
      </form>
      <ul class="activity">
        ${f.activity.map((a) => html`<li><div>${a.message}</div><div class="small muted">${niceDateTime(a.created_at)}</div></li>`)}
      </ul>
    </div>`;
}

// ------------------------------------------------------------------ events

const fileId = () => state.file?.id;
const refresh = () => route();

async function run(fn, success) {
  try {
    await fn();
    if (success) toast(success);
  } catch (e) {
    toast(e.message, true);
  }
  await refresh();
}

document.addEventListener('click', async (e) => {
  const row = e.target.closest('tr[data-href]');
  if (row && !e.target.closest('a,button,input,select')) { location.hash = row.dataset.href; return; }

  const el = e.target.closest('[data-action]');
  if (!el || el.tagName === 'SELECT' || el.type === 'file') return;
  const { action, id } = el.dataset;
  const tid = fileId();

  switch (action) {
    case 'filter-stage':
      state.stageFilter = state.stageFilter === el.dataset.stage ? '' : el.dataset.stage;
      return refresh();
    case 'toggle-task':
      return run(() => api('PATCH', `/transactions/${tid}/tasks/${id}`, { completed: el.checked }));
    case 'delete-task':
      if (!confirm('Remove this task?')) return;
      return run(() => api('DELETE', `/transactions/${tid}/tasks/${id}`), 'Task removed');
    case 'advance':
      return run(() => api('POST', `/transactions/${tid}/advance`), 'Stage advanced');
    case 'revert':
      if (!confirm('Move this file back one stage?')) return;
      return run(() => api('POST', `/transactions/${tid}/revert`));
    case 'delete-item':
      if (!confirm('Remove this commitment item?')) return;
      return run(() => api('DELETE', `/transactions/${tid}/commitment/${id}`));
    case 'delete-party':
      if (!confirm('Remove this party?')) return;
      return run(() => api('DELETE', `/transactions/${tid}/parties/${id}`));
    case 'delete-doc':
      if (!confirm('Remove this document and any uploaded file?')) return;
      return run(() => api('DELETE', `/transactions/${tid}/documents/${id}`));
    case 'delete-file':
      if (!confirm(`Permanently delete file ${state.file.file_number}? This cannot be undone.`)) return;
      try {
        await api('DELETE', `/transactions/${tid}`);
        toast('File deleted');
        location.hash = '#/';
      } catch (err) { toast(err.message, true); }
      return;
    default:
  }
});

document.addEventListener('change', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const { action, id } = el.dataset;
  const tid = fileId();
  if (action === 'item-status') run(() => api('PATCH', `/transactions/${tid}/commitment/${id}`, { status: el.value }));
  if (action === 'doc-status') run(() => api('PATCH', `/transactions/${tid}/documents/${id}`, { status: el.value }));
  if (action === 'upload' && el.files[0]) {
    const file = el.files[0];
    run(
      () => api('PUT', `/transactions/${tid}/documents/${id}/file`, file, {
        'Content-Type': file.type || 'application/octet-stream',
        'X-Filename': encodeURIComponent(file.name),
      }),
      'File uploaded',
    );
  }
});

document.addEventListener('input', (e) => {
  const form = e.target.closest('form[data-form="create"]');
  if (form && ['purchase_price', 'loan_amount'].includes(e.target.name)) {
    clearTimeout(estimateTimer);
    estimateTimer = setTimeout(() => updateEstimate(form).catch(() => {}), 250);
  }
});

document.addEventListener('submit', async (e) => {
  const form = e.target.closest('form[data-form]');
  if (!form) return;
  e.preventDefault();
  const data = formData(form);
  const tid = fileId();

  switch (form.dataset.form) {
    case 'search':
      state.q = data.q.trim();
      return refresh();
    case 'create': {
      const parties = ['buyer', 'seller']
        .filter((r) => data[`${r}_name`]?.trim())
        .map((r) => ({ role: r, name: data[`${r}_name`], email: data[`${r}_email`] || null }));
      const body = { ...data, parties };
      for (const k of Object.keys(body)) if (/^(buyer|seller)_/.test(k)) delete body[k];
      try {
        const created = await api('POST', '/transactions', body);
        toast(`File ${created.file_number} opened`);
        location.hash = `#/files/${created.id}`;
      } catch (err) { toast(err.message, true); }
      return;
    }
    case 'add-task':
      return run(() => api('POST', `/transactions/${tid}/tasks`, data), 'Task added');
    case 'add-item':
      return run(() => api('POST', `/transactions/${tid}/commitment`, data), 'Item added');
    case 'add-party':
      return run(() => api('POST', `/transactions/${tid}/parties`, data), 'Party added');
    case 'add-doc':
      return run(() => api('POST', `/transactions/${tid}/documents`, data), 'Document tracked');
    case 'add-note':
      return run(() => api('POST', `/transactions/${tid}/notes`, data), 'Note added');
    case 'update':
      return run(() => api('PATCH', `/transactions/${tid}`, data), 'Saved');
    default:
  }
});

route();
