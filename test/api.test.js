import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/db.js';
import { createApp } from '../src/app.js';

let server;
let base;
let dir;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mstitle-'));
  const app = createApp({ db: openDatabase(':memory:'), uploadDir: join(dir, 'uploads') });
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}/api`;
});

after(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

async function call(method, path, body, headers = {}) {
  const res = await fetch(base + path, {
    method,
    headers: body && !(body instanceof Uint8Array) ? { 'Content-Type': 'application/json', ...headers } : headers,
    body: body instanceof Uint8Array ? body : body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = text;
  try { data = JSON.parse(text); } catch {}
  return { status: res.status, data };
}

const newFile = (overrides = {}) =>
  call('POST', '/transactions', {
    property_address: '1 Main St',
    city: 'Springfield',
    state: 'il',
    purchase_price: 400000,
    loan_amount: 320000,
    closing_date: '2030-06-30',
    parties: [{ role: 'buyer', name: 'Alex Buyer' }, { role: 'seller', name: 'Sam Seller' }],
    ...overrides,
  });

test('creates a file with number, tasks, commitment defaults, and parties', async () => {
  const { status, data } = await newFile();
  assert.equal(status, 201);
  assert.match(data.file_number, /^MST-\d{4}-\d{4}$/);
  assert.equal(data.stage, 'open');
  assert.equal(data.state, 'IL');
  assert.equal(data.parties.length, 2);
  assert.ok(data.tasks.length > 20);
  assert.ok(data.tasks.some((t) => /lender funding/i.test(t.title)));
  assert.equal(data.commitment.filter((c) => c.schedule === 'B-I').length, 4);
  assert.ok(data.commitment.filter((c) => c.schedule === 'B-II').length >= 4);
  const first = data.tasks.find((t) => t.title.startsWith('Receive fully executed'));
  assert.equal(first.due_date, '2030-05-31'); // 30 days before closing
});

test('cash purchase omits lender-only tasks and requirements', async () => {
  const { data } = await newFile({ loan_amount: 0 });
  assert.ok(!data.tasks.some((t) => /lender funding|lender's title policy|mortgage \/ deed of trust/i.test(t.title)));
  assert.equal(data.commitment.filter((c) => c.schedule === 'B-I').length, 3);
});

test('file numbers increment', async () => {
  const a = (await newFile()).data.file_number;
  const b = (await newFile()).data.file_number;
  assert.equal(Number(b.slice(-4)), Number(a.slice(-4)) + 1);
});

test('rejects invalid input', async () => {
  assert.equal((await newFile({ property_address: '' })).status, 400);
  assert.equal((await newFile({ purchase_price: -5 })).status, 400);
  assert.equal((await newFile({ closing_date: '06/30/2030' })).status, 400);
  assert.equal((await newFile({ parties: [{ role: 'wizard', name: 'x' }] })).status, 400);
  assert.equal((await call('GET', '/transactions/99999')).status, 404);
});

test('cannot advance a stage with incomplete tasks', async () => {
  const { data } = await newFile();
  const res = await call('POST', `/transactions/${data.id}/advance`);
  assert.equal(res.status, 409);
  assert.ok(res.data.details.length > 0);
  assert.ok(res.data.details.every((d) => d.type === 'task'));
});

async function completeCurrentStage(id) {
  const { data } = await call('GET', `/transactions/${id}`);
  for (const t of data.tasks.filter((k) => k.stage === data.stage && !k.completed_at)) {
    await call('PATCH', `/transactions/${id}/tasks/${t.id}`, { completed: true });
  }
  return data;
}

test('walks a file through the full lifecycle, gated by B-I requirements', async () => {
  const { data: created } = await newFile();
  const id = created.id;
  for (let i = 0; i < 3; i++) {
    await completeCurrentStage(id);
    assert.equal((await call('POST', `/transactions/${id}/advance`)).status, 200);
  }
  assert.equal((await call('GET', `/transactions/${id}`)).data.stage, 'curative');

  // Tasks done but B-I requirements and municipal records still open -> blocked.
  const tx = await completeCurrentStage(id);
  const blocked = await call('POST', `/transactions/${id}/advance`);
  assert.equal(blocked.status, 409);
  assert.deepEqual(new Set(blocked.data.details.map((d) => d.type)), new Set(['requirement', 'municipal']));

  for (const m of tx.municipal) {
    assert.equal((await call('PATCH', `/transactions/${id}/municipal/${m.id}`, { status: 'clear' })).status, 200);
  }

  // B-II exceptions don't block; satisfy / waive the B-I items.
  const reqs = tx.commitment.filter((c) => c.schedule === 'B-I');
  for (const [i, r] of reqs.entries()) {
    const res = await call('PATCH', `/transactions/${id}/commitment/${r.id}`, { status: i ? 'satisfied' : 'waived' });
    assert.equal(res.status, 200);
  }
  assert.equal((await call('POST', `/transactions/${id}/advance`)).status, 200);

  let stage;
  do {
    await completeCurrentStage(id);
    const res = await call('POST', `/transactions/${id}/advance`);
    assert.equal(res.status, 200);
    stage = res.data.stage;
  } while (stage !== 'closed');

  const done = (await call('GET', `/transactions/${id}`)).data;
  assert.equal(done.progress.tasksDone, done.progress.tasksTotal);
  assert.equal((await call('POST', `/transactions/${id}/advance`)).status, 400);
  assert.ok(done.activity.some((a) => a.message.includes('Complete')));
});

test('commitment status must match its schedule', async () => {
  const { data } = await newFile();
  const b2 = data.commitment.find((c) => c.schedule === 'B-II');
  assert.equal((await call('PATCH', `/transactions/${data.id}/commitment/${b2.id}`, { status: 'satisfied' })).status, 400);
  assert.equal((await call('PATCH', `/transactions/${data.id}/commitment/${b2.id}`, { status: 'removed' })).status, 200);
});

test('changing closing date reschedules open auto-generated tasks only', async () => {
  const { data } = await newFile();
  const [t1, t2] = data.tasks;
  await call('PATCH', `/transactions/${data.id}/tasks/${t1.id}`, { completed: true });
  const { data: upd } = await call('PATCH', `/transactions/${data.id}`, { closing_date: '2030-07-10' });
  assert.equal(upd.tasks.find((t) => t.id === t1.id).due_date, t1.due_date);
  assert.notEqual(upd.tasks.find((t) => t.id === t2.id).due_date, t2.due_date);
});

test('child records are scoped to their transaction', async () => {
  const a = (await newFile()).data;
  const b = (await newFile()).data;
  const res = await call('PATCH', `/transactions/${b.id}/tasks/${a.tasks[0].id}`, { completed: true });
  assert.equal(res.status, 404);
});

test('document tracking with file upload and download', async () => {
  const { data: t } = await newFile();
  const { data: doc } = await call('POST', `/transactions/${t.id}/documents`, { name: 'Survey', category: 'survey' });
  assert.equal(doc.status, 'requested');

  const bytes = new TextEncoder().encode('%PDF-1.4 fake survey');
  const up = await call('PUT', `/transactions/${t.id}/documents/${doc.id}/file`, bytes, {
    'Content-Type': 'application/pdf',
    'X-Filename': encodeURIComponent('../../survey plat.pdf'),
  });
  assert.equal(up.status, 200);
  assert.equal(up.data.filename, 'survey plat.pdf');
  assert.equal(up.data.status, 'received');

  const dl = await fetch(`${base}/transactions/${t.id}/documents/${doc.id}/file`);
  assert.equal(dl.status, 200);
  assert.equal(await dl.text(), '%PDF-1.4 fake survey');

  assert.equal((await call('DELETE', `/transactions/${t.id}`)).status, 204);
  assert.equal((await call('GET', `/transactions/${t.id}`)).status, 404);
});

test('search, dashboard, estimate, and notes', async () => {
  const { data: t } = await newFile({ property_address: '999 Unique Blvd' });
  const list = (await call('GET', '/transactions?q=Unique')).data;
  assert.equal(list.length, 1);
  assert.equal(list[0].buyers, 'Alex Buyer');

  const dash = (await call('GET', '/dashboard')).data;
  assert.ok(dash.activeFiles >= 1);
  assert.equal(dash.stages.length, 10);

  const est = (await call('GET', '/estimate?price=300000&loan=240000')).data;
  assert.ok(est.grandTotal > 0);

  const notes = (await call('POST', `/transactions/${t.id}/notes`, { message: 'Buyer requested Friday signing' })).data;
  assert.ok(notes[0].message.includes('Friday'));
});

test('BS&A Online links are built from the file municipality, address, parcel, and seller', async () => {
  const { data: noBsa } = await newFile();
  assert.equal(noBsa.bsa, null);

  const { data } = await newFile({ bsa_uid: '384', parcel_number: '33-01-01-08-101-001', property_address: '124 W Michigan Ave' });
  assert.equal(data.bsa_uid, 384);
  assert.equal(data.bsa.municipality, 'City of Lansing');
  const byKey = Object.fromEntries(data.bsa.links.map((l) => [l.key, new URL(l.url)]));
  assert.equal(byKey.home.href, 'https://bsaonline.com/?uid=384');
  assert.equal(byKey.address.pathname, '/SiteSearch/SiteSearchResults');
  assert.equal(byKey.address.searchParams.get('SearchCategory'), 'Address');
  assert.equal(byKey.address.searchParams.get('SearchText'), '124 W Michigan Ave');
  assert.equal(byKey.address.searchParams.get('uid'), '384');
  assert.equal(byKey.parcel.searchParams.get('SearchCategory'), 'Parcel Number');
  assert.equal(byKey.owner.searchParams.get('SearchText'), 'Sam Seller');

  assert.equal((await newFile({ bsa_uid: 'abc' })).status, 400);
  const cleared = await call('PATCH', `/transactions/${data.id}`, { bsa_uid: '' });
  assert.equal(cleared.data.bsa, null);
});

test('municipal checks: validation, balances flow to seller costs', async () => {
  const { data } = await newFile();
  assert.equal(data.municipal.length, 5);
  assert.ok(data.municipal.every((m) => m.status === 'not_checked'));
  const utility = data.municipal.find((m) => m.category === 'utility');
  const path = `/transactions/${data.id}/municipal/${utility.id}`;

  assert.equal((await call('PATCH', path, { status: 'bogus' })).status, 400);
  assert.equal((await call('PATCH', path, { status: 'balance_due' })).status, 400); // amount required
  const upd = await call('PATCH', path, { status: 'balance_due', amount: 212.4, notes: 'Final read ordered' });
  assert.equal(upd.status, 200);
  assert.ok(upd.data.checked_at);

  const after = (await call('GET', `/transactions/${data.id}`)).data;
  const line = after.costs.lines.find((l) => l.label.includes('utility'));
  assert.equal(line.amount, 212.4);
  assert.equal(line.payer, 'seller');
  assert.equal(after.costs.sellerTotal, Math.round((data.costs.sellerTotal + 212.4) * 100) / 100);

  const other = (await newFile()).data;
  assert.equal((await call('PATCH', `/transactions/${other.id}/municipal/${utility.id}`, { status: 'clear' })).status, 404);
});
