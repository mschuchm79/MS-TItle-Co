// Borrower portal: a private, expiring link that lets the buyer / borrower see
// their file's progress and upload the documents required to close.
// The link token is 256 bits of randomness; only its SHA-256 hash is stored,
// so a database leak does not expose working links.
import { randomBytes, createHash } from 'node:crypto';
import { extname } from 'node:path';
import { tx } from './db.js';
import { HttpError, logActivity, touch, requireChild, attachDocumentFile, ACCEPTED_DOC_STATUSES } from './service.js';
import { getStage, stageIndex, STAGES, addDays } from './workflow.js';

export const PORTAL_ROLES = ['buyer'];
export const DEFAULT_LINK_DAYS = 60;
export const ALLOWED_UPLOAD_EXTENSIONS = ['.pdf', '.jpg', '.jpeg', '.png', '.heic', '.heif', '.tif', '.tiff', '.doc', '.docx'];

const hashToken = (token) => createHash('sha256').update(token).digest('hex');
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
// A single "not found" for every failure so the portal never reveals whether a token ever existed.
const invalidLink = () => new HttpError(404, 'This link is invalid or has expired. Please contact your title company for a new one.');

export function createPortalLink(db, transactionId, { party_id: partyId, days } = {}) {
  const party = requireChild(db, 'parties', transactionId, partyId, 'Party');
  if (!PORTAL_ROLES.includes(party.role)) throw new HttpError(400, 'Portal links can only be created for a buyer / borrower');
  const lifetime = days === undefined || days === '' ? DEFAULT_LINK_DAYS : Number(days);
  if (!Number.isInteger(lifetime) || lifetime < 1 || lifetime > 180) throw new HttpError(400, 'days must be between 1 and 180');

  const token = randomBytes(32).toString('base64url');
  const expiresAt = `${addDays(new Date().toISOString().slice(0, 10), lifetime)} 23:59:59`;
  return tx(db, () => {
    const { lastInsertRowid } = db
      .prepare('INSERT INTO portal_links (transaction_id, party_id, token_hash, expires_at) VALUES (?, ?, ?, ?)')
      .run(party.transaction_id, party.id, hashToken(token), expiresAt);
    logActivity(db, party.transaction_id, `Borrower portal link created for ${party.name} (expires ${expiresAt.slice(0, 10)})`);
    touch(db, party.transaction_id);
    // The raw token is returned exactly once; it cannot be recovered later.
    return { id: Number(lastInsertRowid), token, path: `/portal/${token}`, expires_at: expiresAt, party_name: party.name };
  });
}

export function revokePortalLink(db, transactionId, linkId) {
  const link = requireChild(db, 'portal_links', transactionId, linkId, 'Portal link');
  if (!link.revoked_at) {
    db.prepare("UPDATE portal_links SET revoked_at = datetime('now') WHERE id = ?").run(link.id);
    logActivity(db, link.transaction_id, 'Borrower portal link revoked');
  }
}

// Resolve a token to its active link, or throw a generic 404.
export function resolvePortalToken(db, token) {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) throw invalidLink();
  const link = db
    .prepare(
      `SELECT l.*, p.name AS party_name FROM portal_links l JOIN parties p ON p.id = l.party_id
       WHERE l.token_hash = ? AND l.revoked_at IS NULL AND l.expires_at > datetime('now')`,
    )
    .get(hashToken(token));
  if (!link) throw invalidLink();
  db.prepare("UPDATE portal_links SET last_used_at = datetime('now') WHERE id = ?").run(link.id);
  return link;
}

// What the borrower sees. Deliberately minimal: no prices, other parties'
// contact details, staff notes, internal tasks, or other files.
export function portalView(db, link) {
  const t = db.prepare('SELECT * FROM transactions WHERE id = ?').get(link.transaction_id);
  const contact = db
    .prepare("SELECT name, company, email, phone FROM parties WHERE transaction_id = ? AND role = 'escrow_officer' ORDER BY id LIMIT 1")
    .get(t.id);
  const documents = db
    .prepare(
      `SELECT id, name, status, borrower_note, filename, uploaded_at FROM documents
       WHERE transaction_id = ? AND requested_from = 'borrower' ORDER BY id`,
    )
    .all(t.id)
    .map((d) => ({ ...d, locked: ACCEPTED_DOC_STATUSES.includes(d.status) }));
  return {
    borrower_name: link.party_name,
    file_number: t.file_number,
    property_address: t.property_address,
    city: t.city,
    state: t.state,
    closing_date: t.closing_date,
    stage_label: getStage(t.stage)?.label,
    stage_index: stageIndex(t.stage),
    stages: STAGES.map((s) => s.label),
    expires_at: link.expires_at,
    contact: contact ?? null,
    documents,
  };
}

export function checkUploadFilename(filename) {
  if (!ALLOWED_UPLOAD_EXTENSIONS.includes(extname(filename).toLowerCase())) {
    throw new HttpError(415, `Please upload a PDF, photo, or Word document (${ALLOWED_UPLOAD_EXTENSIONS.join(', ')})`);
  }
}

// Document the borrower may upload to: borrower-requested, on their file, not yet accepted.
export function portalUploadTarget(db, link, docId) {
  const doc = db
    .prepare("SELECT * FROM documents WHERE id = ? AND transaction_id = ? AND requested_from = 'borrower'")
    .get(Number(docId), link.transaction_id);
  if (!doc) throw new HttpError(404, 'Document not found');
  if (ACCEPTED_DOC_STATUSES.includes(doc.status)) {
    throw new HttpError(409, 'This document has already been accepted. Contact your title company to change it.');
  }
  return doc;
}

export function recordPortalUpload(db, link, doc, file) {
  return attachDocumentFile(db, doc, file, { by: link.party_name });
}
