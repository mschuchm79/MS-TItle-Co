// Borrower portal: view closing progress and upload required documents.

class Raw { constructor(s) { this.s = s; } }
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (v) => (v instanceof Raw ? v.s : Array.isArray(v) ? v.map(fmt).join('') : v == null || v === false ? '' : esc(v));
const html = (strings, ...vals) => new Raw(strings.reduce((out, s, i) => out + s + (i < vals.length ? fmt(vals[i]) : ''), ''));

const $app = document.getElementById('app');
const token = location.pathname.split('/')[2] || '';
const api = `/api/portal/${encodeURIComponent(token)}`;
const niceDate = (d) => (d ? new Date(`${d.slice(0, 10)}T00:00:00`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) : 'To be scheduled');
const MAX_BYTES = 25 * 1024 * 1024;

let toastTimer;
function toast(msg, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `show${isError ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, 4000);
}

const STATUS = {
  requested: { label: 'Needed', cls: 'warn' },
  received: { label: 'Received – under review', cls: '' },
  reviewed: { label: 'Accepted', cls: 'ok' },
  recorded: { label: 'Accepted', cls: 'ok' },
};

function render(v) {
  const needed = v.documents.filter((d) => d.status === 'requested').length;
  const accepted = v.documents.filter((d) => d.locked).length;
  const pct = Math.round(((v.stage_index + 1) / v.stages.length) * 100);
  $app.innerHTML = html`
    <div class="card">
      <p class="hello">Hi ${v.borrower_name.split(' ')[0]},</p>
      <div class="muted">Here's where things stand on your purchase of</div>
      <h1 style="margin-top:6px">${v.property_address}</h1>
      <div class="muted">${[v.city, v.state].filter(Boolean).join(', ')} · File ${v.file_number}</div>
      <div class="progress-line" aria-hidden="true"><div style="width:${pct}%"></div></div>
      <div class="summary">
        <strong>Step ${v.stage_index + 1} of ${v.stages.length}: ${v.stage_label}</strong>
        <span class="small muted">Closing: ${niceDate(v.closing_date)}</span>
      </div>
    </div>

    <div class="wire" role="note">
      <strong>Protect yourself from wire fraud.</strong> We will never email or text you new wiring instructions.
      Before sending any money, call us at a phone number you already know, not one taken from an email.
    </div>

    <div class="card">
      <div class="summary">
        <h2>Documents we need from you</h2>
        <span class="small muted">${accepted} of ${v.documents.length} accepted</span>
      </div>
      ${needed === 0 && v.documents.length ? html`<div class="all-done">✓ Thank you! You've sent everything we asked for. We'll let you know if we need anything else.</div>` : ''}
      <p class="small muted" style="margin-top:0">Upload a PDF or clear photo. On a phone you can take the picture right from the upload button. Files up to 25 MB.</p>
      ${v.documents.length ? v.documents.map((d) => html`
        <div class="doc ${d.locked ? 'done' : ''}" data-doc="${d.id}">
          <div class="top">
            <div class="name">${d.name}</div>
            <span class="badge ${STATUS[d.status]?.cls}">${STATUS[d.status]?.label ?? d.status}</span>
          </div>
          ${d.status === 'requested' && d.filename && d.borrower_note ? html`<div class="note">${d.borrower_note}</div>` : d.borrower_note ? html`<div class="hint">${d.borrower_note}</div>` : ''}
          ${d.filename ? html`<div class="file">📎 ${d.filename}</div>` : ''}
          ${d.locked ? '' : html`
            <div class="actions">
              <label class="btn ${d.filename ? '' : 'btn-primary'} upload-btn">
                ${d.filename ? 'Replace file' : 'Upload'}
                <input type="file" data-upload="${d.id}" accept=".pdf,.jpg,.jpeg,.png,.heic,.heif,.tif,.tiff,.doc,.docx,image/*,application/pdf">
              </label>
            </div>
            <div class="bar"><div></div></div>`}
        </div>`) : html`<div class="empty">No documents are needed from you right now.</div>`}
    </div>

    ${v.contact ? html`
      <div class="card">
        <h2>Questions?</h2>
        <div><strong>${v.contact.name}</strong>${v.contact.company ? ` · ${v.contact.company}` : ''}</div>
        <div class="small">Your escrow officer</div>
        <div class="row" style="margin-top:10px">
          ${v.contact.phone ? html`<a class="btn btn-sm" href="tel:${v.contact.phone}">📞 ${v.contact.phone}</a>` : ''}
          ${v.contact.email ? html`<a class="btn btn-sm" href="mailto:${v.contact.email}">✉️ ${v.contact.email}</a>` : ''}
        </div>
      </div>` : ''}

    <p class="small muted" style="text-align:center">This private link expires ${niceDate(v.expires_at)}. Please don't forward it.</p>
  `.s;
}

async function load() {
  const res = await fetch(api, { cache: 'no-store' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    $app.innerHTML = html`<div class="card"><h2>Link not available</h2><p class="muted">${data.error || 'Something went wrong. Please try again later.'}</p></div>`.s;
    return;
  }
  render(data);
}

function uploadFile(docId, file) {
  const card = document.querySelector(`[data-doc="${CSS.escape(docId)}"]`);
  const bar = card?.querySelector('.bar > div');
  card?.classList.add('uploading');
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `${api}/documents/${encodeURIComponent(docId)}/file`);
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.setRequestHeader('X-Filename', encodeURIComponent(file.name));
    xhr.upload.onprogress = (e) => { if (bar && e.lengthComputable) bar.style.width = `${(e.loaded / e.total) * 100}%`; };
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* non-JSON error */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(data.error || (xhr.status === 413 ? 'That file is too large (25 MB max).' : 'Upload failed. Please try again.')));
    };
    xhr.onerror = () => reject(new Error('Network error. Check your connection and try again.'));
    xhr.send(file);
  }).finally(() => card?.classList.remove('uploading'));
}

document.addEventListener('change', async (e) => {
  const input = e.target.closest('input[data-upload]');
  if (!input || !input.files[0]) return;
  const file = input.files[0];
  if (file.size > MAX_BYTES) { toast('That file is too large (25 MB max).', true); input.value = ''; return; }
  try {
    render(await uploadFile(input.dataset.upload, file));
    toast('Uploaded. Thank you!');
  } catch (err) {
    toast(err.message, true);
    input.value = '';
  }
});

load();
