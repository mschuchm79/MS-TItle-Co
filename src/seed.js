// Populate the database with a few demo files at different stages.
import { openDatabase } from './db.js';
import * as svc from './service.js';
import { addDays } from './workflow.js';
import { createPortalLink } from './portal.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const dataDir = process.env.DATA_DIR || new URL('../data', import.meta.url).pathname;
const db = openDatabase(process.env.DB_PATH || `${dataDir}/title.db`);
const today = new Date().toISOString().slice(0, 10);

function completeStagesAndAdvance(t, times) {
  for (let i = 0; i < times; i++) {
    const cur = svc.getTransaction(db, t.id);
    for (const task of cur.tasks.filter((k) => k.stage === cur.stage && !k.completed_at)) {
      svc.updateTask(db, t.id, task.id, { completed: true });
    }
    if (cur.stage === 'curative') {
      for (const item of cur.commitment.filter((c) => c.schedule === 'B-I' && c.status === 'open')) {
        svc.updateCommitmentItem(db, t.id, item.id, { status: 'satisfied' });
      }
      for (const m of cur.municipal.filter((x) => x.status === 'not_checked')) {
        svc.updateMunicipalCheck(db, t.id, m.id, { status: 'clear' });
      }
    }
    svc.advanceStage(db, t.id);
  }
}

const a = svc.createTransaction(db, {
  property_address: '1418 Magnolia Ave', city: 'Tampa', state: 'FL', zip: '33606', county: 'Hillsborough',
  parcel_number: 'A-19-29-18-4KL-000012-00010.0', purchase_price: 485000, loan_amount: 388000,
  closing_date: addDays(today, 9),
  parties: [
    { role: 'buyer', name: 'Jordan Rivera', email: 'jordan.rivera@example.com', phone: '813-555-0142' },
    { role: 'seller', name: 'Pat & Casey Nguyen', email: 'nguyen.family@example.com' },
    { role: 'lender', name: 'Sunrise Home Lending', company: 'Sunrise Home Lending', email: 'closings@example.com' },
    { role: 'buyer_agent', name: 'Morgan Lee', company: 'Bayside Realty' },
    { role: 'escrow_officer', name: 'Dana Whitfield', company: 'MS Title Co', email: 'dana@example.com', phone: '517-555-0100' },
  ],
});
completeStagesAndAdvance(a, 3);
svc.addCommitmentItem(db, a.id, { schedule: 'B-I', description: 'Satisfaction of mortgage recorded in OR Book 23411, Page 882 in favor of First Coast Bank.' });
svc.addCommitmentItem(db, a.id, { schedule: 'B-II', description: 'Declaration of Covenants for Magnolia Park HOA recorded in OR Book 9912, Page 101.' });
svc.addDocument(db, a.id, { name: 'Executed purchase contract', category: 'contract', status: 'received' });
svc.addDocument(db, a.id, { name: 'Payoff letter – First Coast Bank', category: 'payoff' });

const b = svc.createTransaction(db, {
  property_address: '77 Harbor View Dr', city: 'Sarasota', state: 'FL', zip: '34236', county: 'Sarasota',
  purchase_price: 1250000, loan_amount: 0, closing_date: addDays(today, 4),
  parties: [
    { role: 'buyer', name: 'Avery Thompson Trust' },
    { role: 'seller', name: 'Robin Castillo' },
    { role: 'listing_agent', name: 'Sam Patel', company: 'Gulf Coast Luxury' },
  ],
});
completeStagesAndAdvance(b, 4);

const c = svc.createTransaction(db, {
  property_address: '2200 Oak Hollow Ln', city: 'Lansing', state: 'MI', zip: '48912', county: 'Ingham',
  parcel_number: '33-01-01-15-326-011', bsa_uid: 384,
  purchase_price: 329900, loan_amount: 313405, closing_date: addDays(today, 27),
  parties: [
    { role: 'buyer', name: 'Taylor Brooks' },
    { role: 'seller', name: 'Oak Hollow Builders LLC' },
  ],
});
svc.updateTask(db, c.id, svc.getTransaction(db, c.id).tasks[0].id, { completed: true });
const cMuni = svc.getTransaction(db, c.id).municipal;
svc.updateMunicipalCheck(db, c.id, cMuni.find((m) => m.category === 'property_tax').id, { status: 'clear', notes: '2025 summer & winter paid' });
svc.updateMunicipalCheck(db, c.id, cMuni.find((m) => m.category === 'utility').id, { status: 'balance_due', amount: 186.52, notes: 'Acct 004512-01; final read to be ordered' });

// Borrower portal demo: a link for the first file and one upload awaiting review.
const buyer = svc.getTransaction(db, a.id).parties.find((p) => p.role === 'buyer');
const link = createPortalLink(db, a.id, { party_id: buyer.id });
const idDoc = svc.getTransaction(db, a.id).documents.find((d) => d.name.startsWith('Government-issued'));
mkdirSync(`${dataDir}/uploads`, { recursive: true });
const storedName = randomUUID();
writeFileSync(`${dataDir}/uploads/${storedName}`, '%PDF-1.4 demo drivers license');
svc.attachDocumentFile(db, idDoc, { filename: 'drivers-license.pdf', storedName, size: 29 }, { by: buyer.name });

console.log('Seeded 3 demo files.');
console.log(`Demo borrower portal: http://localhost:${process.env.PORT || 3000}${link.path}`);
