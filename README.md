# MS Title Co

A web app for running the title & escrow side of a residential real estate purchase, from the moment a contract arrives to issuing the final title policy.

## What it does

- **File pipeline.** Each purchase is a *file* (`MST-2026-0001`) that moves through 10 stages:
  Order Opened → Title Search → Title Commitment → Clearing Title → Closing Scheduled → Closing / Signing → Funding & Disbursement → Recording → Policy Issuance → Complete.
- **Generated closing checklist.** Opening a file creates about 30 tasks, each due a set number of days before or after the closing date. Lender-only tasks are left out for cash deals. Moving the closing date reschedules every open task.
- **Stage gates.** A file can't advance while tasks in its current stage are unfinished, and it can't leave *Clearing Title* while any Schedule B-I requirement is still open.
- **Title commitment.** Schedule A (proposed insureds, vesting, policy amounts, legal description), Schedule B-I requirements (open / satisfied / waived), and Schedule B-II exceptions (remains / removed). New files start with the standard items.
- **BS&A Online (bsaonline.com) integration.** Set a file's BS&A municipality `uid` to get one-click, pre-filled searches by address, parcel number, and owner for property tax, utility billing, special assessment, assessing, and building records. Each file gets a *Municipal records* checklist (taxes, water/sewer, special assessments, assessing record, open permits). Every item must be checked before the file leaves *Clearing Title*, and any **balance due** is added to the seller's side of the closing costs.
- **Borrower portal.** Each file requests the standard documents the buyer / borrower must provide to close: photo ID, vesting instructions, proof of funds, earnest money receipt, plus homeowner's insurance and the signed Closing Disclosure for financed deals. Staff create a private, expiring link for the buyer. On that page (built for phones) the buyer sees their closing progress, a wire-fraud warning and their escrow officer's contact details, and can upload each document. Staff accept uploads or send them back with instructions. Every borrower document must be accepted before the file can leave *Closing Scheduled*, and new uploads show on the dashboard.
- **Parties.** Buyers, sellers, lenders, agents, attorneys, HOA, and others, with contact details.
- **Documents.** Tracks each document from requested to received, reviewed, and recorded, with file upload and download.
- **Closing cost estimate.** Owner's and lender's title premiums (tiered rates, simultaneous-issue pricing), recording fees, transfer tax, and the settlement fee, split between buyer and seller.
- **Dashboard.** Pipeline counts by stage, closings in the next 14 days, overdue tasks, and search by address, file number, or party name.
- **Activity log** of every change, plus free-form notes.
- **Wire fraud controls** built into the checklist: wire instructions are verified by phone using a known number, and buyer funds are confirmed as a verified wire.

## Quick start

Requires **Node.js 22.5+**. It uses Node's built-in `node:sqlite`, so there's no native database build step.

```bash
npm install
npm run seed     # optional: 3 demo files at different stages
npm start        # http://localhost:3000
npm test
```

Environment variables: `PORT` (default 3000), `DATA_DIR` (default `./data`; holds `title.db` and `uploads/`), `DB_PATH`, `STAFF_PASSWORD`.

## Borrower portal & going online

Borrowers can only reach the portal if the server is on the internet. Before you do that:

1. **Set `STAFF_PASSWORD`.** It puts all staff screens and the staff API behind a browser sign-in (any username, this password), while `/portal/…` stays open to link holders. Without it, anyone who can reach the server can see every file.
2. **Serve it over HTTPS** (e.g. behind a reverse proxy such as Caddy or nginx). Portal links and Basic-auth passwords must not travel over plain HTTP.

How the portal is secured:
- Each link token is 256 bits of randomness. Only its SHA-256 hash is stored, the raw link is shown to staff once, and links expire after 60 days and can be revoked.
- A link shows only that borrower's file summary and borrower-requested documents. It never shows prices, other parties, staff notes or other files.
- Borrowers can upload only PDFs, photos and Word files (25 MB max) to their own requested documents, and can't replace a document once staff accept it. They can't download files.
- Responses use `no-store`, `no-referrer`, `nosniff` and `X-Frame-Options: DENY`.

Still to add before heavy use: per-user staff accounts, rate limiting, malware scanning of uploads, and email/SMS delivery of the link.

## Configure your rates

`config/rates.json` holds **illustrative** premium tiers, fees, transfer tax, and the customary payer for each charge. Title rates are filed by state and often vary by county, so replace these with your rate manual before quoting real customers.

## BS&A Online

BS&A has no public API, and its searches sit behind a security check, so the app links out instead of pulling data automatically. Searches open in a new tab, and staff record what they find on the file's **Municipal (BS&A)** tab. To find a municipality's `uid`, open it on bsaonline.com and read `uid=` in the address bar. Add your common jurisdictions to `config/bsa-municipalities.json` so they show up as suggestions.

## Project layout

```
src/
  workflow.js   stages, task templates, standard B-I/B-II items
  costs.js      premium and closing-cost calculator
  bsa.js        BS&A Online links and municipal-records checklist
  portal.js     borrower portal: links, borrower view, upload rules
  service.js    business logic and validation (stage gates, rescheduling, …)
  app.js        Express REST API (/api/…)
  db.js         SQLite schema
  server.js     entry point
  seed.js       demo data
public/         staff single-page UI and the borrower portal page (plain JS, no build step)
test/           node:test suites for the API and cost math
```

## API overview

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/dashboard` | Pipeline counts, upcoming closings, overdue tasks |
| GET / POST | `/api/transactions` | List (`?stage=`, `?q=`) and create files |
| GET / PATCH / DELETE | `/api/transactions/:id` | Full file detail, update, delete |
| POST | `/api/transactions/:id/advance` · `/revert` | Move between stages (409 with blockers if gated) |
| POST / PATCH / DELETE | `/api/transactions/:id/{tasks,parties,commitment,documents}[/:childId]` | Manage child records |
| PUT / GET | `/api/transactions/:id/documents/:docId/file` | Upload (raw body plus `X-Filename`) and download |
| PATCH | `/api/transactions/:id/municipal/:checkId` | Record a municipal (BS&A) check: `status`, `amount`, `notes` |
| POST / DELETE | `/api/transactions/:id/portal-links[/:linkId]` | Create a borrower portal link (`party_id`, optional `days`) or revoke one |
| GET | `/api/portal/:token` | Borrower view (public, token-scoped) |
| PUT | `/api/portal/:token/documents/:docId/file` | Borrower upload (raw body plus `X-Filename`) |
| POST | `/api/transactions/:id/notes` | Add a note |
| GET | `/api/estimate?price=&loan=` | Closing cost estimate |

## Roadmap / not yet built

- User accounts, roles (escrow officer, examiner, processor), and permissions. **Add these before exposing the app beyond a trusted network**, because the API currently has no authentication.
- Extend the portal to sellers and agents, and send links by email or SMS
- Email and SMS notifications for milestones and overdue tasks
- Integrations: title plant and search vendors, underwriter policy jackets, e-recording (e.g. Simplifile), RON/eClosing, lender portals
- Generated documents: commitment PDF, ALTA settlement statement, deed
- Trust accounting: escrow ledger, disbursements, three-way reconciliation
- Per-state rate manuals and endorsement catalogs
