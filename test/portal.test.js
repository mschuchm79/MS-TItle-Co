import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/db.js';
import { createApp } from '../src/app.js';

let server, base, root, dir, db;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mstitle-portal-'));
  db = openDatabase(':memory:');
  const app = createApp({ db, uploadDir: join(dir, 'uploads') });
  await new Promise((r) => { server = app.listen(0, r); });
  root = `http://127.0.0.1:${server.address().port}`;
  base = `${root}/api`;
});
after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

async function call(method, path, body, headers = {}) {
  const isBytes = body instanceof Uint8Array;
  const res = await fetch(base + path, {
    method,
    headers: body && !isBytes ? { 'Content-Type': 'application/json', ...headers } : headers,
    body: isBytes ? body : body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = text;
  try { data = JSON.parse(text); } catch {}
  return { status: res.status, data, headers: res.headers };
}

async function fileWithLink(overrides = {}) {
  const { data: t } = await call('POST', '/transactions', {
    property_address: '9 Portal Pl', city: 'Lansing', state: 'MI', purchase_price: 250000, loan_amount: 200000,
    closing_date: '2030-01-15',
    parties: [{ role: 'buyer', name: 'Bea Borrower' }, { role: 'seller', name: 'Sy Seller' }],
    ...overrides,
  });
  const buyer = t.parties.find((p) => p.role === 'buyer');
  const { status, data: link } = await call('POST', `/transactions/${t.id}/portal-links`, { party_id: buyer.id });
  assert.equal(status, 201);
  return { t, link };
}

const upload = (token, docId, name = 'id.pdf', bytes = new TextEncoder().encode('%PDF-1.4 test')) =>
  call('PUT', `/portal/${token}/documents/${docId}/file`, bytes, { 'X-Filename': encodeURIComponent(name) });

test('new files request the standard borrower documents', async () => {
  const { data: financed } = await call('POST', '/transactions', { property_address: 'a', purchase_price: 1, loan_amount: 1 });
  const { data: cash } = await call('POST', '/transactions', { property_address: 'b', purchase_price: 1 });
  const count = (t) => t.documents.filter((d) => d.requested_from === 'borrower').length;
  assert.equal(count(financed), 6);
  assert.equal(count(cash), 4);
  assert.ok(financed.documents.every((d) => d.requested_from !== 'borrower' || d.borrower_note));
});

test('link token is returned once and only its hash is stored', async () => {
  const { link } = await fileWithLink();
  assert.match(link.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(link.path, `/portal/${link.token}`);
  const rows = db.prepare('SELECT token_hash FROM portal_links').all();
  assert.ok(rows.every((r) => r.token_hash !== link.token && /^[0-9a-f]{64}$/.test(r.token_hash)));
});

test('portal links are only for buyers', async () => {
  const { t } = await fileWithLink();
  const seller = t.parties.find((p) => p.role === 'seller');
  assert.equal((await call('POST', `/transactions/${t.id}/portal-links`, { party_id: seller.id })).status, 400);
  assert.equal((await call('POST', `/transactions/${t.id}/portal-links`, { party_id: 99999 })).status, 404);
});

test('portal view shows only borrower-facing data', async () => {
  const { t, link } = await fileWithLink();
  const { status, data, headers } = await call('GET', `/portal/${link.token}`);
  assert.equal(status, 200);
  assert.equal(headers.get('cache-control'), 'no-store');
  assert.equal(headers.get('referrer-policy'), 'no-referrer');
  assert.equal(data.borrower_name, 'Bea Borrower');
  assert.equal(data.property_address, '9 Portal Pl');
  assert.equal(data.documents.length, 6);
  for (const key of ['purchase_price', 'loan_amount', 'parties', 'tasks', 'activity', 'costs', 'id']) assert.ok(!(key in data), key);
  assert.ok(data.documents.every((d) => !('stored_name' in d)));
  assert.ok(!JSON.stringify(data).includes('Sy Seller'));
  void t;
});

test('invalid, revoked, and expired links all return the same 404', async () => {
  const { t, link } = await fileWithLink();
  const bad = await call('GET', '/portal/not-a-real-token');
  const wrong = await call('GET', `/portal/${'A'.repeat(43)}`);
  assert.equal(bad.status, 404);
  assert.equal(wrong.status, 404);
  assert.equal(bad.data.error, wrong.data.error);

  const linkRow = t && (await call('GET', `/transactions/${t.id}`)).data.portal_links[0];
  assert.equal(linkRow.active, 1);
  assert.equal((await call('DELETE', `/transactions/${t.id}/portal-links/${linkRow.id}`)).status, 204);
  assert.equal((await call('GET', `/portal/${link.token}`)).status, 404);

  const { link: l2 } = await fileWithLink();
  db.prepare("UPDATE portal_links SET expires_at = datetime('now', '-1 minute')").run();
  assert.equal((await call('GET', `/portal/${l2.token}`)).status, 404);
});

test('borrower uploads a document; staff review locks it', async () => {
  const { t, link } = await fileWithLink();
  const doc = (await call('GET', `/portal/${link.token}`)).data.documents[0];
  const res = await upload(link.token, doc.id, '../../license.pdf');
  assert.equal(res.status, 200);
  const after = res.data.documents.find((d) => d.id === doc.id);
  assert.equal(after.status, 'received');
  assert.equal(after.filename, 'license.pdf');

  const file = (await call('GET', `/transactions/${t.id}`)).data;
  assert.ok(file.activity.some((a) => a.message.includes('Bea Borrower uploaded via borrower portal')));
  const staffDoc = file.documents.find((d) => d.id === doc.id);
  assert.equal(readdirSync(join(dir, 'uploads')).includes(staffDoc.stored_name), true);

  // Re-upload allowed while under review; blocked once accepted.
  assert.equal((await upload(link.token, doc.id, 'license-v2.pdf')).status, 200);
  await call('PATCH', `/transactions/${t.id}/documents/${doc.id}`, { status: 'reviewed' });
  const locked = await upload(link.token, doc.id, 'license-v3.pdf');
  assert.equal(locked.status, 409);
  assert.equal((await call('GET', `/portal/${link.token}`)).data.documents.find((d) => d.id === doc.id).locked, true);

  // Staff can send it back with a note.
  await call('PATCH', `/transactions/${t.id}/documents/${doc.id}`, { status: 'requested', borrower_note: 'Back side is missing' });
  const reopened = (await call('GET', `/portal/${link.token}`)).data.documents.find((d) => d.id === doc.id);
  assert.equal(reopened.status, 'requested');
  assert.equal(reopened.borrower_note, 'Back side is missing');
});

test('portal uploads are restricted to the borrower documents on that file', async () => {
  const { t, link } = await fileWithLink();
  const { t: other } = await fileWithLink();
  const staffDoc = (await call('POST', `/transactions/${t.id}/documents`, { name: 'Payoff letter', category: 'payoff' })).data;
  const otherDoc = other.documents.find((d) => d.requested_from === 'borrower');
  const mine = (await call('GET', `/portal/${link.token}`)).data.documents[0];

  assert.equal((await upload(link.token, staffDoc.id)).status, 404);
  assert.equal((await upload(link.token, otherDoc.id)).status, 404);
  assert.equal((await upload(link.token, mine.id, 'evil.html')).status, 415);
  assert.equal((await upload(link.token, mine.id, 'script.exe')).status, 415);
  assert.equal((await upload(link.token, mine.id, 'photo.JPG', new Uint8Array())).status, 400);
});

test('staff can request extra documents from the borrower', async () => {
  const { t, link } = await fileWithLink();
  await call('POST', `/transactions/${t.id}/documents`, {
    name: 'Trust certificate', category: 'borrower', requested_from: 'borrower', borrower_note: 'Buying in a trust',
  });
  const docs = (await call('GET', `/portal/${link.token}`)).data.documents;
  assert.ok(docs.some((d) => d.name === 'Trust certificate' && d.borrower_note === 'Buying in a trust'));
  assert.equal((await call('POST', `/transactions/${t.id}/documents`, { name: 'x', requested_from: 'nobody' })).status, 400);
});

test('portal page is served for any token path', async () => {
  const res = await fetch(`${root}/portal/whatever`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /portal\.js/);
});

test('STAFF_PASSWORD protects staff routes but not the portal', async () => {
  const d2 = mkdtempSync(join(tmpdir(), 'mstitle-auth-'));
  const db2 = openDatabase(':memory:');
  const app = createApp({ db: db2, uploadDir: join(d2, 'u'), staffPassword: 's3cret' });
  const srv = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const url = `http://127.0.0.1:${srv.address().port}`;
  const auth = (pw) => ({ Authorization: `Basic ${Buffer.from(`staff:${pw}`).toString('base64')}` });
  try {
    assert.equal((await fetch(`${url}/api/transactions`)).status, 401);
    assert.equal((await fetch(`${url}/`)).status, 401);
    assert.equal((await fetch(`${url}/api/transactions`, { headers: auth('wrong') })).status, 401);
    assert.equal((await fetch(`${url}/api/transactions`, { headers: auth('s3cret') })).status, 200);
    assert.equal((await fetch(`${url}/portal/abc`)).status, 200);
    assert.equal((await fetch(`${url}/portal.js`)).status, 200);
    assert.equal((await fetch(`${url}/api/portal/abc`)).status, 404); // reaches the portal API, not auth
  } finally {
    srv.close();
    rmSync(d2, { recursive: true, force: true });
  }
});
