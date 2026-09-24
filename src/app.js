import express from 'express';
import { randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import * as svc from './service.js';
import { STAGES, PARTY_ROLES, DOCUMENT_CATEGORIES, DOCUMENT_STATUSES } from './workflow.js';
import { estimateClosingCosts } from './costs.js';
import { BSA_MUNICIPALITIES, MUNICIPAL_STATUSES } from './bsa.js';
import * as portal from './portal.js';

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const PUBLIC_DIR = new URL('../public', import.meta.url).pathname;

// Paths the borrower portal needs; everything else is staff-only.
const isPortalPath = (p) =>
  p.startsWith('/portal/') || p.startsWith('/api/portal/') || ['/portal.js', '/styles.css'].includes(p);

const digest = (s) => createHash('sha256').update(String(s)).digest();

// Optional HTTP Basic auth for staff screens and the staff API (any username).
function staffAuth(password) {
  const expected = digest(password);
  return (req, res, next) => {
    if (isPortalPath(req.path)) return next();
    const [scheme, encoded] = (req.get('Authorization') || '').split(' ');
    if (scheme === 'Basic' && encoded) {
      const decoded = Buffer.from(encoded, 'base64').toString();
      const supplied = decoded.slice(decoded.indexOf(':') + 1);
      if (timingSafeEqual(digest(supplied), expected)) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="MS Title Co staff", charset="UTF-8"');
    res.status(401).send('Staff sign-in required');
  };
}

function safeFilename(header) {
  let name = header || 'upload';
  try { name = decodeURIComponent(name); } catch { /* keep raw */ }
  return basename(name).replace(/[\x00-\x1f]/g, '').slice(0, 200) || 'upload';
}

export function createApp({ db, uploadDir, staffPassword }) {
  mkdirSync(uploadDir, { recursive: true });
  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      // Keeps portal tokens (in the URL path) from leaking to other sites.
      'Referrer-Policy': 'no-referrer',
    });
    next();
  });
  if (staffPassword) app.use(staffAuth(staffPassword));
  app.use(express.json({ limit: '1mb' }));
  app.use(express.static(PUBLIC_DIR));

  // Save a raw-body upload for a document, replacing any earlier file.
  const rawUpload = express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES });
  function storeUpload(req, doc) {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw new svc.HttpError(400, 'Empty upload');
    const filename = safeFilename(req.get('X-Filename'));
    const storedName = randomUUID();
    writeFileSync(join(uploadDir, storedName), req.body);
    if (doc.stored_name) rmSync(join(uploadDir, doc.stored_name), { force: true });
    return { filename, storedName, size: req.body.length };
  }

  const api = express.Router();
  const tid = (req) => req.params.id;

  api.get('/meta', (_req, res) =>
    res.json({
      stages: STAGES.map(({ key, label, description }) => ({ key, label, description })),
      partyRoles: PARTY_ROLES,
      documentCategories: DOCUMENT_CATEGORIES,
      documentStatuses: DOCUMENT_STATUSES,
      bsaMunicipalities: BSA_MUNICIPALITIES,
      municipalStatuses: MUNICIPAL_STATUSES,
    }),
  );

  api.get('/dashboard', (_req, res) => res.json(svc.dashboard(db)));

  api.get('/estimate', (req, res) =>
    res.json(estimateClosingCosts({ purchasePrice: req.query.price, loanAmount: req.query.loan })),
  );

  api.get('/transactions', (req, res) =>
    res.json(svc.listTransactions(db, { stage: req.query.stage, q: req.query.q })),
  );
  api.post('/transactions', (req, res) => res.status(201).json(svc.createTransaction(db, req.body ?? {})));
  api.get('/transactions/:id', (req, res) => res.json(svc.getTransaction(db, tid(req))));
  api.patch('/transactions/:id', (req, res) => res.json(svc.updateTransaction(db, tid(req), req.body ?? {})));
  api.delete('/transactions/:id', (req, res) => {
    for (const d of svc.deleteTransaction(db, tid(req))) rmSync(join(uploadDir, d.stored_name), { force: true });
    res.status(204).end();
  });
  api.post('/transactions/:id/advance', (req, res) => res.json(svc.advanceStage(db, tid(req))));
  api.post('/transactions/:id/revert', (req, res) => res.json(svc.revertStage(db, tid(req))));
  api.post('/transactions/:id/notes', (req, res) => {
    svc.addNote(db, tid(req), req.body ?? {});
    res.status(201).json(svc.getTransaction(db, tid(req)).activity);
  });

  api.post('/transactions/:id/tasks', (req, res) => res.status(201).json(svc.addTask(db, tid(req), req.body ?? {})));
  api.patch('/transactions/:id/tasks/:childId', (req, res) =>
    res.json(svc.updateTask(db, tid(req), req.params.childId, req.body ?? {})),
  );
  api.delete('/transactions/:id/tasks/:childId', (req, res) => {
    svc.deleteTask(db, tid(req), req.params.childId);
    res.status(204).end();
  });

  api.post('/transactions/:id/parties', (req, res) => res.status(201).json(svc.addParty(db, tid(req), req.body ?? {})));
  api.patch('/transactions/:id/parties/:childId', (req, res) =>
    res.json(svc.updateParty(db, tid(req), req.params.childId, req.body ?? {})),
  );
  api.delete('/transactions/:id/parties/:childId', (req, res) => {
    svc.deleteParty(db, tid(req), req.params.childId);
    res.status(204).end();
  });

  api.post('/transactions/:id/commitment', (req, res) =>
    res.status(201).json(svc.addCommitmentItem(db, tid(req), req.body ?? {})),
  );
  api.patch('/transactions/:id/commitment/:childId', (req, res) =>
    res.json(svc.updateCommitmentItem(db, tid(req), req.params.childId, req.body ?? {})),
  );
  api.delete('/transactions/:id/commitment/:childId', (req, res) => {
    svc.deleteCommitmentItem(db, tid(req), req.params.childId);
    res.status(204).end();
  });

  api.patch('/transactions/:id/municipal/:childId', (req, res) =>
    res.json(svc.updateMunicipalCheck(db, tid(req), req.params.childId, req.body ?? {})),
  );

  api.post('/transactions/:id/documents', (req, res) =>
    res.status(201).json(svc.addDocument(db, tid(req), req.body ?? {})),
  );
  api.patch('/transactions/:id/documents/:childId', (req, res) =>
    res.json(svc.updateDocument(db, tid(req), req.params.childId, req.body ?? {})),
  );
  api.delete('/transactions/:id/documents/:childId', (req, res) => {
    const doc = svc.deleteDocument(db, tid(req), req.params.childId);
    if (doc.stored_name) rmSync(join(uploadDir, doc.stored_name), { force: true });
    res.status(204).end();
  });

  // Upload the file for a tracked document: raw request body, name in X-Filename.
  api.put('/transactions/:id/documents/:childId/file', rawUpload, (req, res) => {
    const doc = svc.getDocument(db, tid(req), req.params.childId);
    res.json(svc.attachDocumentFile(db, doc, storeUpload(req, doc)));
  });

  api.get('/transactions/:id/documents/:childId/file', (req, res) => {
    const doc = svc.getDocument(db, tid(req), req.params.childId);
    const path = doc.stored_name && join(uploadDir, doc.stored_name);
    if (!path || !existsSync(path)) throw new svc.HttpError(404, 'No file uploaded for this document');
    res.download(path, doc.filename);
  });

  // ---- borrower portal: staff side
  api.post('/transactions/:id/portal-links', (req, res) =>
    res.status(201).json(portal.createPortalLink(db, tid(req), req.body ?? {})),
  );
  api.delete('/transactions/:id/portal-links/:childId', (req, res) => {
    portal.revokePortalLink(db, tid(req), req.params.childId);
    res.status(204).end();
  });

  // ---- borrower portal: public side (token in path, no staff auth)
  const noStore = (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); };
  api.get('/portal/:token', noStore, (req, res) => {
    res.json(portal.portalView(db, portal.resolvePortalToken(db, req.params.token)));
  });
  api.put('/portal/:token/documents/:docId/file', noStore, (req, res, next) => {
    // Validate the link and target before reading a potentially large body.
    const link = portal.resolvePortalToken(db, req.params.token);
    const doc = portal.portalUploadTarget(db, link, req.params.docId);
    portal.checkUploadFilename(safeFilename(req.get('X-Filename')));
    res.locals.portal = { link, doc };
    next();
  }, rawUpload, (req, res) => {
    const { link, doc } = res.locals.portal;
    portal.recordPortalUpload(db, link, doc, storeUpload(req, doc));
    res.json(portal.portalView(db, link));
  });

  api.use((_req, res) => res.status(404).json({ error: 'Not found' }));

  app.use('/api', api);
  app.get('/portal/:token', noStore, (_req, res) => res.sendFile(join(PUBLIC_DIR, 'portal.html')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof svc.HttpError) {
      return res.status(err.status).json({ error: err.message, details: err.details });
    }
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Upload too large' });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body' });
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
