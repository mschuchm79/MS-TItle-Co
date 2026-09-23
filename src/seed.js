// Populate the database with a few demo files at different stages.
import { openDatabase } from './db.js';
import * as svc from './service.js';
import { addDays } from './workflow.js';

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
  property_address: '2200 Oak Hollow Ln', city: 'Orlando', state: 'FL', zip: '32803', county: 'Orange',
  purchase_price: 329900, loan_amount: 313405, closing_date: addDays(today, 27),
  parties: [
    { role: 'buyer', name: 'Taylor Brooks' },
    { role: 'seller', name: 'Oak Hollow Builders LLC' },
  ],
});
svc.updateTask(db, c.id, svc.getTransaction(db, c.id).tasks[0].id, { completed: true });

console.log('Seeded 3 demo files.');
