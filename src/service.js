import { tx, insertMunicipalChecks } from './db.js';
import { bsaLinks, MUNICIPAL_STATUSES } from './bsa.js';
import {
  STAGES,
  STAGE_KEYS,
  PARTY_ROLES,
  DOCUMENT_CATEGORIES,
  DOCUMENT_STATUSES,
  STANDARD_EXCEPTIONS,
  standardRequirements,
  buildTasks,
  addDays,
  getStage,
  stageIndex,
} from './workflow.js';
import { estimateClosingCosts } from './costs.js';

export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const bad = (msg, details) => new HttpError(400, msg, details);
const notFound = (what) => new HttpError(404, `${what} not found`);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const REQUIREMENT_STATUSES = ['open', 'satisfied', 'waived'];
const EXCEPTION_STATUSES = ['remains', 'removed'];

function str(v, max = 500) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}

function money(v, field) {
  if (v === undefined || v === null || v === '') return 0;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw bad(`${field} must be a non-negative number`);
  return Math.round(n * 100) / 100;
}

function date(v, field) {
  const s = str(v, 10);
  if (s === null) return null;
  if (!DATE_RE.test(s) || Number.isNaN(Date.parse(s))) throw bad(`${field} must be YYYY-MM-DD`);
  return s;
}

function bsaUid(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0 || n > 1e6) throw bad('bsa_uid must be a positive whole number (the uid from a bsaonline.com URL)');
  return n;
}

function oneOf(v, allowed, field) {
  if (!allowed.includes(v)) throw bad(`${field} must be one of: ${allowed.join(', ')}`);
  return v;
}

export function logActivity(db, transactionId, message) {
  db.prepare('INSERT INTO activity (transaction_id, message) VALUES (?, ?)').run(transactionId, message);
}

function touch(db, id) {
  db.prepare("UPDATE transactions SET updated_at = datetime('now') WHERE id = ?").run(id);
}

function nextFileNumber(db) {
  const year = new Date().getFullYear();
  const prefix = `MST-${year}-`;
  const row = db
    .prepare('SELECT file_number FROM transactions WHERE file_number LIKE ? ORDER BY file_number DESC LIMIT 1')
    .get(`${prefix}%`);
  const seq = row ? Number(row.file_number.slice(prefix.length)) + 1 : 1;
  return `${prefix}${String(seq).padStart(4, '0')}`;
}

// ---------------------------------------------------------------- transactions

const TX_FIELDS = ['property_address', 'city', 'state', 'zip', 'county', 'parcel_number', 'legal_description'];

function cleanTransactionInput(input, { partial = false } = {}) {
  const out = {};
  for (const f of TX_FIELDS) {
    if (f in input) out[f] = str(input[f], f === 'legal_description' ? 5000 : 200);
  }
  if ('state' in out && out.state) out.state = out.state.toUpperCase().slice(0, 2);
  if ('purchase_price' in input) out.purchase_price = money(input.purchase_price, 'purchase_price');
  if ('loan_amount' in input) out.loan_amount = money(input.loan_amount, 'loan_amount');
  if ('closing_date' in input) out.closing_date = date(input.closing_date, 'closing_date');
  if ('bsa_uid' in input) out.bsa_uid = bsaUid(input.bsa_uid);

  if (!partial || 'property_address' in out) {
    if (!out.property_address) throw bad('property_address is required');
  }
  if (!partial || 'purchase_price' in out) {
    if (!(out.purchase_price > 0)) throw bad('purchase_price must be greater than 0');
  }
  return out;
}

export function createTransaction(db, input) {
  const data = cleanTransactionInput(input);
  const parties = Array.isArray(input.parties) ? input.parties.map(cleanPartyInput) : [];

  return tx(db, () => {
    const fileNumber = nextFileNumber(db);
    const cols = Object.keys(data);
    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO transactions (file_number, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})`,
      )
      .run(fileNumber, ...cols.map((c) => data[c]));
    const id = Number(lastInsertRowid);
    const financed = (data.loan_amount ?? 0) > 0;

    const insTask = db.prepare(
      'INSERT INTO tasks (transaction_id, stage, title, sort_order, offset_days, due_date) VALUES (?, ?, ?, ?, ?, ?)',
    );
    for (const t of buildTasks({ financed, closingDate: data.closing_date })) {
      insTask.run(id, t.stage, t.title, t.sort_order, t.offset_days, t.due_date);
    }

    const insItem = db.prepare(
      'INSERT INTO commitment_items (transaction_id, schedule, description, status) VALUES (?, ?, ?, ?)',
    );
    for (const r of standardRequirements({ financed })) insItem.run(id, 'B-I', r, 'open');
    for (const e of STANDARD_EXCEPTIONS) insItem.run(id, 'B-II', e, 'remains');
    insertMunicipalChecks(db, id);

    const insParty = db.prepare(
      'INSERT INTO parties (transaction_id, role, name, company, email, phone) VALUES (?, ?, ?, ?, ?, ?)',
    );
    for (const p of parties) insParty.run(id, p.role, p.name, p.company, p.email, p.phone);

    logActivity(db, id, `File ${fileNumber} opened for ${data.property_address}`);
    return getTransaction(db, id);
  });
}

function requireTransaction(db, id) {
  const t = db.prepare('SELECT * FROM transactions WHERE id = ?').get(Number(id));
  if (!t) throw notFound('Transaction');
  return t;
}

// What must be done before this file can move to the next stage.
export function getBlockers(db, t) {
  const blockers = [];
  const openTasks = db
    .prepare('SELECT id, title FROM tasks WHERE transaction_id = ? AND stage = ? AND completed_at IS NULL ORDER BY sort_order')
    .all(t.id, t.stage);
  for (const task of openTasks) blockers.push({ type: 'task', id: task.id, message: `Task incomplete: ${task.title}` });

  if (getStage(t.stage)?.requiresClearedCommitment) {
    const openReqs = db
      .prepare("SELECT id, description FROM commitment_items WHERE transaction_id = ? AND schedule = 'B-I' AND status = 'open'")
      .all(t.id);
    for (const r of openReqs) blockers.push({ type: 'requirement', id: r.id, message: `Open B-I requirement: ${r.description}` });

    const unchecked = db
      .prepare("SELECT id, label FROM municipal_checks WHERE transaction_id = ? AND status = 'not_checked' ORDER BY id")
      .all(t.id);
    for (const m of unchecked) blockers.push({ type: 'municipal', id: m.id, message: `Municipal record not checked: ${m.label}` });
  }
  return blockers;
}

function progress(db, t) {
  const { total, done } = db
    .prepare('SELECT COUNT(*) AS total, COUNT(completed_at) AS done FROM tasks WHERE transaction_id = ?')
    .get(t.id);
  return { tasksTotal: total, tasksDone: done, stageIndex: stageIndex(t.stage), stageCount: STAGES.length };
}

export function getTransaction(db, id) {
  const t = requireTransaction(db, id);
  const q = (sql) => db.prepare(sql).all(t.id);
  const parties = q('SELECT * FROM parties WHERE transaction_id = ? ORDER BY role, name');
  const municipal = q('SELECT * FROM municipal_checks WHERE transaction_id = ? ORDER BY id');
  const costs = estimateClosingCosts({ purchasePrice: t.purchase_price, loanAmount: t.loan_amount });
  // Municipal balances found on BS&A are paid from seller proceeds at closing.
  const dues = municipal.filter((m) => m.status === 'balance_due' && m.amount > 0);
  for (const m of dues) costs.lines.push({ label: `Municipal balance – ${m.label}`, amount: m.amount, payer: 'seller' });
  const dueTotal = dues.reduce((sum, m) => sum + m.amount, 0);
  costs.sellerTotal = Math.round((costs.sellerTotal + dueTotal) * 100) / 100;
  costs.grandTotal = Math.round((costs.grandTotal + dueTotal) * 100) / 100;
  return {
    ...t,
    financed: t.loan_amount > 0,
    stage_label: getStage(t.stage)?.label,
    parties,
    tasks: q('SELECT * FROM tasks WHERE transaction_id = ? ORDER BY sort_order, id').sort(
      (a, b) => stageIndex(a.stage) - stageIndex(b.stage),
    ),
    commitment: q('SELECT * FROM commitment_items WHERE transaction_id = ? ORDER BY schedule, id'),
    documents: q('SELECT * FROM documents WHERE transaction_id = ? ORDER BY id DESC'),
    municipal,
    bsa: bsaLinks(t, parties.find((p) => p.role === 'seller')?.name),
    activity: q('SELECT * FROM activity WHERE transaction_id = ? ORDER BY id DESC LIMIT 200'),
    blockers: getBlockers(db, t),
    progress: progress(db, t),
    costs,
  };
}

export function listTransactions(db, { stage, q } = {}) {
  const where = [];
  const args = [];
  if (stage) {
    where.push('t.stage = ?');
    args.push(stage);
  }
  if (q) {
    where.push(
      '(t.file_number LIKE ? OR t.property_address LIKE ? OR t.city LIKE ? OR EXISTS (SELECT 1 FROM parties p WHERE p.transaction_id = t.id AND p.name LIKE ?))',
    );
    const like = `%${q}%`;
    args.push(like, like, like, like);
  }
  const rows = db
    .prepare(
      `SELECT t.*,
        (SELECT COUNT(*) FROM tasks WHERE transaction_id = t.id) AS tasks_total,
        (SELECT COUNT(*) FROM tasks WHERE transaction_id = t.id AND completed_at IS NOT NULL) AS tasks_done,
        (SELECT group_concat(name, ', ') FROM parties WHERE transaction_id = t.id AND role = 'buyer') AS buyers,
        (SELECT group_concat(name, ', ') FROM parties WHERE transaction_id = t.id AND role = 'seller') AS sellers
       FROM transactions t
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY (t.closing_date IS NULL), t.closing_date, t.id DESC`,
    )
    .all(...args);
  return rows.map((r) => ({ ...r, stage_label: getStage(r.stage)?.label }));
}

export function updateTransaction(db, id, input) {
  const before = requireTransaction(db, id);
  const data = cleanTransactionInput(input, { partial: true });
  const cols = Object.keys(data);
  if (!cols.length) return getTransaction(db, id);

  return tx(db, () => {
    db.prepare(`UPDATE transactions SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`)
      .run(...cols.map((c) => data[c]), before.id);

    if ('closing_date' in data && data.closing_date !== before.closing_date) {
      // Reschedule outstanding tasks that were generated relative to closing.
      const tasks = db
        .prepare('SELECT id, offset_days FROM tasks WHERE transaction_id = ? AND completed_at IS NULL AND offset_days IS NOT NULL')
        .all(before.id);
      const upd = db.prepare('UPDATE tasks SET due_date = ? WHERE id = ?');
      for (const t of tasks) upd.run(data.closing_date ? addDays(data.closing_date, t.offset_days) : null, t.id);
      logActivity(db, before.id, `Closing date changed from ${before.closing_date ?? 'unset'} to ${data.closing_date ?? 'unset'}`);
    }
    const changed = cols.filter((c) => c !== 'closing_date' && data[c] !== before[c]);
    if (changed.length) logActivity(db, before.id, `Updated ${changed.join(', ').replaceAll('_', ' ')}`);
    return getTransaction(db, before.id);
  });
}

export function deleteTransaction(db, id) {
  const t = requireTransaction(db, id);
  const docs = db.prepare('SELECT stored_name FROM documents WHERE transaction_id = ? AND stored_name IS NOT NULL').all(t.id);
  db.prepare('DELETE FROM transactions WHERE id = ?').run(t.id);
  return docs;
}

export function advanceStage(db, id) {
  const t = requireTransaction(db, id);
  const idx = stageIndex(t.stage);
  if (idx === STAGE_KEYS.length - 1) throw bad('File is already complete');
  const blockers = getBlockers(db, t);
  if (blockers.length) throw new HttpError(409, 'Stage has outstanding items', blockers);
  const next = STAGES[idx + 1];
  return tx(db, () => {
    db.prepare("UPDATE transactions SET stage = ?, updated_at = datetime('now') WHERE id = ?").run(next.key, t.id);
    logActivity(db, t.id, `Advanced to stage: ${next.label}`);
    return getTransaction(db, t.id);
  });
}

export function revertStage(db, id) {
  const t = requireTransaction(db, id);
  const idx = stageIndex(t.stage);
  if (idx === 0) throw bad('File is already at the first stage');
  const prev = STAGES[idx - 1];
  return tx(db, () => {
    db.prepare("UPDATE transactions SET stage = ?, updated_at = datetime('now') WHERE id = ?").run(prev.key, t.id);
    logActivity(db, t.id, `Moved back to stage: ${prev.label}`);
    return getTransaction(db, t.id);
  });
}

// ---------------------------------------------------------------- tasks

function requireChild(db, table, transactionId, childId, what) {
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ? AND transaction_id = ?`).get(Number(childId), Number(transactionId));
  if (!row) throw notFound(what);
  return row;
}

export function addTask(db, transactionId, input) {
  const t = requireTransaction(db, transactionId);
  const title = str(input.title, 300);
  if (!title) throw bad('title is required');
  const stage = oneOf(input.stage ?? t.stage, STAGE_KEYS, 'stage');
  const { lastInsertRowid } = db
    .prepare('INSERT INTO tasks (transaction_id, stage, title, sort_order, due_date, assignee) VALUES (?, ?, ?, 100, ?, ?)')
    .run(t.id, stage, title, date(input.due_date, 'due_date'), str(input.assignee, 100));
  logActivity(db, t.id, `Task added: ${title}`);
  touch(db, t.id);
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(lastInsertRowid);
}

export function updateTask(db, transactionId, taskId, input) {
  const task = requireChild(db, 'tasks', transactionId, taskId, 'Task');
  const sets = [];
  const args = [];
  if ('completed' in input) {
    const completed = Boolean(input.completed);
    if (completed !== Boolean(task.completed_at)) {
      sets.push("completed_at = CASE WHEN ? THEN datetime('now') ELSE NULL END");
      args.push(completed ? 1 : 0);
      logActivity(db, task.transaction_id, `${completed ? 'Completed' : 'Reopened'} task: ${task.title}`);
    }
  }
  if ('due_date' in input) {
    sets.push('due_date = ?', 'offset_days = NULL');
    args.push(date(input.due_date, 'due_date'));
  }
  if ('assignee' in input) {
    sets.push('assignee = ?');
    args.push(str(input.assignee, 100));
  }
  if ('title' in input) {
    const title = str(input.title, 300);
    if (!title) throw bad('title cannot be empty');
    sets.push('title = ?');
    args.push(title);
  }
  if (sets.length) {
    db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...args, task.id);
    touch(db, task.transaction_id);
  }
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id);
}

export function deleteTask(db, transactionId, taskId) {
  const task = requireChild(db, 'tasks', transactionId, taskId, 'Task');
  db.prepare('DELETE FROM tasks WHERE id = ?').run(task.id);
  logActivity(db, task.transaction_id, `Task removed: ${task.title}`);
}

// ---------------------------------------------------------------- parties

function cleanPartyInput(input) {
  const name = str(input.name, 200);
  if (!name) throw bad('party name is required');
  const email = str(input.email, 200);
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad(`invalid email: ${email}`);
  return {
    role: oneOf(input.role, PARTY_ROLES, 'role'),
    name,
    company: str(input.company, 200),
    email,
    phone: str(input.phone, 50),
  };
}

export function addParty(db, transactionId, input) {
  const t = requireTransaction(db, transactionId);
  const p = cleanPartyInput(input);
  const { lastInsertRowid } = db
    .prepare('INSERT INTO parties (transaction_id, role, name, company, email, phone) VALUES (?, ?, ?, ?, ?, ?)')
    .run(t.id, p.role, p.name, p.company, p.email, p.phone);
  logActivity(db, t.id, `Added ${p.role.replaceAll('_', ' ')}: ${p.name}`);
  touch(db, t.id);
  return db.prepare('SELECT * FROM parties WHERE id = ?').get(lastInsertRowid);
}

export function updateParty(db, transactionId, partyId, input) {
  const existing = requireChild(db, 'parties', transactionId, partyId, 'Party');
  const p = cleanPartyInput({ ...existing, ...input });
  db.prepare('UPDATE parties SET role = ?, name = ?, company = ?, email = ?, phone = ? WHERE id = ?')
    .run(p.role, p.name, p.company, p.email, p.phone, existing.id);
  touch(db, existing.transaction_id);
  return db.prepare('SELECT * FROM parties WHERE id = ?').get(existing.id);
}

export function deleteParty(db, transactionId, partyId) {
  const p = requireChild(db, 'parties', transactionId, partyId, 'Party');
  db.prepare('DELETE FROM parties WHERE id = ?').run(p.id);
  logActivity(db, p.transaction_id, `Removed ${p.role.replaceAll('_', ' ')}: ${p.name}`);
}

// ---------------------------------------------------------------- commitment

export function addCommitmentItem(db, transactionId, input) {
  const t = requireTransaction(db, transactionId);
  const schedule = oneOf(input.schedule, ['B-I', 'B-II'], 'schedule');
  const description = str(input.description, 2000);
  if (!description) throw bad('description is required');
  const status = schedule === 'B-I' ? 'open' : 'remains';
  const { lastInsertRowid } = db
    .prepare('INSERT INTO commitment_items (transaction_id, schedule, description, status, notes) VALUES (?, ?, ?, ?, ?)')
    .run(t.id, schedule, description, status, str(input.notes, 2000));
  logActivity(db, t.id, `Schedule ${schedule} item added: ${description}`);
  touch(db, t.id);
  return db.prepare('SELECT * FROM commitment_items WHERE id = ?').get(lastInsertRowid);
}

export function updateCommitmentItem(db, transactionId, itemId, input) {
  const item = requireChild(db, 'commitment_items', transactionId, itemId, 'Commitment item');
  const allowed = item.schedule === 'B-I' ? REQUIREMENT_STATUSES : EXCEPTION_STATUSES;
  const status = 'status' in input ? oneOf(input.status, allowed, 'status') : item.status;
  const notes = 'notes' in input ? str(input.notes, 2000) : item.notes;
  const description = 'description' in input ? str(input.description, 2000) : item.description;
  if (!description) throw bad('description cannot be empty');
  db.prepare('UPDATE commitment_items SET status = ?, notes = ?, description = ? WHERE id = ?')
    .run(status, notes, description, item.id);
  if (status !== item.status) {
    logActivity(db, item.transaction_id, `Schedule ${item.schedule} item marked ${status}: ${item.description}`);
  }
  touch(db, item.transaction_id);
  return db.prepare('SELECT * FROM commitment_items WHERE id = ?').get(item.id);
}

export function deleteCommitmentItem(db, transactionId, itemId) {
  const item = requireChild(db, 'commitment_items', transactionId, itemId, 'Commitment item');
  db.prepare('DELETE FROM commitment_items WHERE id = ?').run(item.id);
  logActivity(db, item.transaction_id, `Schedule ${item.schedule} item removed: ${item.description}`);
}

// ---------------------------------------------------------------- documents

export function addDocument(db, transactionId, input) {
  const t = requireTransaction(db, transactionId);
  const name = str(input.name, 200);
  if (!name) throw bad('name is required');
  const category = oneOf(input.category ?? 'other', DOCUMENT_CATEGORIES, 'category');
  const status = oneOf(input.status ?? 'requested', DOCUMENT_STATUSES, 'status');
  const { lastInsertRowid } = db
    .prepare('INSERT INTO documents (transaction_id, name, category, status) VALUES (?, ?, ?, ?)')
    .run(t.id, name, category, status);
  logActivity(db, t.id, `Document tracked: ${name} (${status})`);
  touch(db, t.id);
  return db.prepare('SELECT * FROM documents WHERE id = ?').get(lastInsertRowid);
}

export function getDocument(db, transactionId, docId) {
  return requireChild(db, 'documents', transactionId, docId, 'Document');
}

export function updateDocument(db, transactionId, docId, input) {
  const doc = getDocument(db, transactionId, docId);
  const status = 'status' in input ? oneOf(input.status, DOCUMENT_STATUSES, 'status') : doc.status;
  const category = 'category' in input ? oneOf(input.category, DOCUMENT_CATEGORIES, 'category') : doc.category;
  db.prepare('UPDATE documents SET status = ?, category = ? WHERE id = ?').run(status, category, doc.id);
  if (status !== doc.status) logActivity(db, doc.transaction_id, `Document ${doc.name} marked ${status}`);
  touch(db, doc.transaction_id);
  return db.prepare('SELECT * FROM documents WHERE id = ?').get(doc.id);
}

export function attachDocumentFile(db, doc, { filename, storedName, size }) {
  db.prepare(
    "UPDATE documents SET filename = ?, stored_name = ?, size = ?, uploaded_at = datetime('now'), status = CASE WHEN status = 'requested' THEN 'received' ELSE status END WHERE id = ?",
  ).run(filename, storedName, size, doc.id);
  logActivity(db, doc.transaction_id, `File uploaded for ${doc.name}: ${filename}`);
  touch(db, doc.transaction_id);
  return db.prepare('SELECT * FROM documents WHERE id = ?').get(doc.id);
}

export function deleteDocument(db, transactionId, docId) {
  const doc = getDocument(db, transactionId, docId);
  db.prepare('DELETE FROM documents WHERE id = ?').run(doc.id);
  logActivity(db, doc.transaction_id, `Document removed: ${doc.name}`);
  return doc;
}

// ---------------------------------------------------------------- municipal (BS&A)

export function updateMunicipalCheck(db, transactionId, checkId, input) {
  const check = requireChild(db, 'municipal_checks', transactionId, checkId, 'Municipal check');
  const status = 'status' in input ? oneOf(input.status, MUNICIPAL_STATUSES, 'status') : check.status;
  const amount = 'amount' in input ? money(input.amount, 'amount') : check.amount;
  const notes = 'notes' in input ? str(input.notes, 2000) : check.notes;
  if (status === 'balance_due' && !(amount > 0)) throw bad('Enter the amount due for a balance-due item');
  db.prepare(
    "UPDATE municipal_checks SET status = ?, amount = ?, notes = ?, checked_at = CASE WHEN ? = 'not_checked' THEN NULL ELSE datetime('now') END WHERE id = ?",
  ).run(status, amount, notes, status, check.id);
  if (status !== check.status || amount !== check.amount) {
    const amt = status === 'balance_due' ? ` ($${amount.toFixed(2)})` : '';
    logActivity(db, check.transaction_id, `Municipal record ${check.label}: ${status.replaceAll('_', ' ')}${amt}`);
  }
  touch(db, check.transaction_id);
  return db.prepare('SELECT * FROM municipal_checks WHERE id = ?').get(check.id);
}

// ---------------------------------------------------------------- notes & dashboard

export function addNote(db, transactionId, input) {
  const t = requireTransaction(db, transactionId);
  const text = str(input.message, 2000);
  if (!text) throw bad('message is required');
  logActivity(db, t.id, `Note: ${text}`);
  touch(db, t.id);
}

export function dashboard(db, today = new Date().toISOString().slice(0, 10)) {
  const byStage = Object.fromEntries(STAGE_KEYS.map((k) => [k, 0]));
  for (const r of db.prepare('SELECT stage, COUNT(*) AS n FROM transactions GROUP BY stage').all()) byStage[r.stage] = r.n;

  const upcomingClosings = db
    .prepare(
      "SELECT id, file_number, property_address, closing_date, stage FROM transactions WHERE closing_date BETWEEN ? AND ? AND stage NOT IN ('funding','recording','policy','closed') ORDER BY closing_date",
    )
    .all(today, addDays(today, 14))
    .map((r) => ({ ...r, stage_label: getStage(r.stage)?.label }));

  const overdueTasks = db
    .prepare(
      `SELECT k.id, k.title, k.due_date, k.stage, t.id AS transaction_id, t.file_number, t.property_address
       FROM tasks k JOIN transactions t ON t.id = k.transaction_id
       WHERE k.completed_at IS NULL AND k.due_date < ? AND t.stage != 'closed'
       ORDER BY k.due_date LIMIT 50`,
    )
    .all(today);

  return {
    stages: STAGES.map((s) => ({ key: s.key, label: s.label, count: byStage[s.key] })),
    activeFiles: Object.entries(byStage).filter(([k]) => k !== 'closed').reduce((s, [, n]) => s + n, 0),
    upcomingClosings,
    overdueTasks,
  };
}
