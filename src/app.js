import express from 'express';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import * as svc from './service.js';
import { STAGES, PARTY_ROLES, DOCUMENT_CATEGORIES, DOCUMENT_STATUSES } from './workflow.js';
import { estimateClosingCosts } from './costs.js';
import { BSA_MUNICIPALITIES, MUNICIPAL_STATUSES } from './bsa.js';

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export function createApp({ db, uploadDir }) {
  mkdirSync(uploadDir, { recursive: true });
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use(express.static(new URL('../public', import.meta.url).pathname));

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
  api.put(
    '/transactions/:id/documents/:childId/file',
    express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES }),
    (req, res) => {
      const doc = svc.getDocument(db, tid(req), req.params.childId);
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw new svc.HttpError(400, 'Empty upload');
      const filename = basename(decodeURIComponent(req.get('X-Filename') || 'upload')).slice(0, 200);
      const storedName = randomUUID();
      writeFileSync(join(uploadDir, storedName), req.body);
      if (doc.stored_name) rmSync(join(uploadDir, doc.stored_name), { force: true });
      res.json(svc.attachDocumentFile(db, doc, { filename, storedName, size: req.body.length }));
    },
  );

  api.get('/transactions/:id/documents/:childId/file', (req, res) => {
    const doc = svc.getDocument(db, tid(req), req.params.childId);
    const path = doc.stored_name && join(uploadDir, doc.stored_name);
    if (!path || !existsSync(path)) throw new svc.HttpError(404, 'No file uploaded for this document');
    res.download(path, doc.filename);
  });

  api.use((_req, res) => res.status(404).json({ error: 'Not found' }));

  app.use('/api', api);

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
