import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/db.js';

test('upgrading a pre-BS&A database adds bsa_uid and backfills municipal checks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mstitle-mig-'));
  const path = join(dir, 'old.db');
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, file_number TEXT NOT NULL UNIQUE, stage TEXT NOT NULL DEFAULT 'open',
    property_address TEXT NOT NULL, city TEXT, state TEXT, zip TEXT, county TEXT, parcel_number TEXT,
    legal_description TEXT, purchase_price REAL NOT NULL DEFAULT 0, loan_amount REAL NOT NULL DEFAULT 0,
    closing_date TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
    INSERT INTO transactions (file_number, property_address, purchase_price) VALUES ('MST-2026-0001', '1 Old St', 100000);`);
  old.close();

  const db = openDatabase(path);
  const cols = db.prepare('PRAGMA table_info(transactions)').all().map((c) => c.name);
  assert.ok(cols.includes('bsa_uid'));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM municipal_checks').get().n, 5);
  db.close();

  // Re-opening is idempotent.
  const again = openDatabase(path);
  assert.equal(again.prepare('SELECT COUNT(*) AS n FROM municipal_checks').get().n, 5);
  again.close();
  rmSync(dir, { recursive: true, force: true });
});
