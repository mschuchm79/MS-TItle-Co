import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { MUNICIPAL_CHECKS } from './bsa.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_number TEXT NOT NULL UNIQUE,
  stage TEXT NOT NULL DEFAULT 'open',
  property_address TEXT NOT NULL,
  city TEXT,
  state TEXT,
  zip TEXT,
  county TEXT,
  parcel_number TEXT,
  legal_description TEXT,
  purchase_price REAL NOT NULL DEFAULT 0,
  loan_amount REAL NOT NULL DEFAULT 0,
  closing_date TEXT,
  bsa_uid INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS parties (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  name TEXT NOT NULL,
  company TEXT,
  email TEXT,
  phone TEXT
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  title TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  offset_days INTEGER,
  due_date TEXT,
  assignee TEXT,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS commitment_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  schedule TEXT NOT NULL CHECK (schedule IN ('B-I', 'B-II')),
  description TEXT NOT NULL,
  status TEXT NOT NULL,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'other',
  status TEXT NOT NULL DEFAULT 'requested',
  filename TEXT,
  stored_name TEXT,
  size INTEGER,
  uploaded_at TEXT
);

CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS municipal_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  label TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'not_checked',
  amount REAL NOT NULL DEFAULT 0,
  notes TEXT,
  checked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_municipal_tx ON municipal_checks(transaction_id);
CREATE INDEX IF NOT EXISTS idx_tasks_tx ON tasks(transaction_id);
CREATE INDEX IF NOT EXISTS idx_parties_tx ON parties(transaction_id);
CREATE INDEX IF NOT EXISTS idx_items_tx ON commitment_items(transaction_id);
CREATE INDEX IF NOT EXISTS idx_docs_tx ON documents(transaction_id);
CREATE INDEX IF NOT EXISTS idx_activity_tx ON activity(transaction_id);
`;

export function openDatabase(path = ':memory:') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

// Columns added after the first release; CREATE TABLE IF NOT EXISTS won't add them.
function migrate(db) {
  const cols = db.prepare('PRAGMA table_info(transactions)').all().map((c) => c.name);
  if (!cols.includes('bsa_uid')) db.exec('ALTER TABLE transactions ADD COLUMN bsa_uid INTEGER');

  // Give files opened before municipal checks existed their checklist.
  const missing = db
    .prepare('SELECT id FROM transactions t WHERE NOT EXISTS (SELECT 1 FROM municipal_checks m WHERE m.transaction_id = t.id)')
    .all();
  for (const { id } of missing) insertMunicipalChecks(db, id);
}

export function insertMunicipalChecks(db, transactionId) {
  const ins = db.prepare('INSERT INTO municipal_checks (transaction_id, category, label) VALUES (?, ?, ?)');
  for (const c of MUNICIPAL_CHECKS) ins.run(transactionId, c.category, c.label);
}

// Run fn inside a transaction; roll back on any thrown error.
export function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
