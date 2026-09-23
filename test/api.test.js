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

  // Tasks done but B-I requirements still open -> blocked.
  const tx = await completeCurrentStage(id);
  const blocked = await call('POST', `/transactions/${id}/advance`);
  assert.equal(blocked.status, 409);
  assert.ok(blocked.data.details.every((d) => d.type === 'requirement'));

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
