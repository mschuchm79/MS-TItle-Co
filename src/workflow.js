// The title & escrow lifecycle for a residential purchase, in order.
// Each stage carries the task templates generated when a file is opened.
// `offsetDays` is relative to the scheduled closing date (negative = before).
// `financedOnly` tasks are skipped for all-cash purchases.

export const STAGES = [
  {
    key: 'open',
    label: 'Order Opened',
    description: 'Contract received, file opened, earnest money deposited.',
    tasks: [
      { title: 'Receive fully executed purchase contract', offsetDays: -30 },
      { title: 'Deposit earnest money into escrow', offsetDays: -28 },
      { title: 'Enter all parties and contact information', offsetDays: -28 },
      { title: 'Order payoff statement(s) for seller liens', offsetDays: -25 },
      { title: 'Send borrower portal link to buyer for closing documents', offsetDays: -27 },
    ],
  },
  {
    key: 'search',
    label: 'Title Search',
    description: 'Search public records for ownership, liens, and encumbrances.',
    tasks: [
      { title: 'Order title search / abstract', offsetDays: -27 },
      { title: 'Review chain of title and vesting', offsetDays: -22 },
      { title: 'Search for liens, judgments, and unpaid taxes', offsetDays: -22 },
      { title: 'Order survey (if required)', offsetDays: -21 },
      { title: 'Request HOA estoppel / resale certificate (if applicable)', offsetDays: -21 },
      { title: 'Pull BS&A Online tax, utility, and special assessment records', offsetDays: -21 },
    ],
  },
  {
    key: 'commitment',
    label: 'Title Commitment',
    description: 'Examine the search and issue the commitment (Schedules A, B-I, B-II).',
    tasks: [
      { title: 'Examine search results and draft commitment', offsetDays: -18 },
      { title: 'Issue commitment to buyer, seller, lender, and agents', offsetDays: -17 },
    ],
  },
  {
    key: 'curative',
    label: 'Clearing Title',
    description: 'Satisfy every Schedule B-I requirement and check municipal records before closing.',
    requiresClearedCommitment: true,
    tasks: [
      { title: 'Receive payoff statement(s)', offsetDays: -10 },
      { title: 'Receive lender closing instructions', offsetDays: -7, financedOnly: true },
      { title: 'Confirm all Schedule B-I requirements are satisfied or waived', offsetDays: -5 },
    ],
  },
  {
    key: 'scheduled',
    label: 'Closing Scheduled',
    description: 'Documents prepared, figures balanced, signing appointment set, borrower documents accepted.',
    requiresBorrowerDocs: true,
    tasks: [
      { title: 'Prepare deed and closing documents', offsetDays: -4 },
      { title: 'Order final water / sewer meter read and utility transfer', offsetDays: -3 },
      { title: 'Balance settlement statement / Closing Disclosure with lender', offsetDays: -3, financedOnly: true },
      { title: 'Prepare settlement statement', offsetDays: -3 },
      { title: 'Schedule signing appointment with all parties', offsetDays: -3 },
      { title: 'Send wire instructions and verify by phone using a known number', offsetDays: -2 },
    ],
  },
  {
    key: 'closing',
    label: 'Closing / Signing',
    description: 'Parties sign; identities verified; buyer funds received.',
    tasks: [
      { title: 'Verify government-issued ID for every signer', offsetDays: 0 },
      { title: 'Execute and notarize closing documents', offsetDays: 0 },
      { title: 'Confirm receipt of buyer funds (verified wire)', offsetDays: 0 },
    ],
  },
  {
    key: 'funding',
    label: 'Funding & Disbursement',
    description: 'Lender funds; payoffs, proceeds, and commissions disbursed.',
    tasks: [
      { title: 'Receive lender funding', offsetDays: 0, financedOnly: true },
      { title: 'Disburse lien payoffs', offsetDays: 1 },
      { title: 'Pay outstanding tax / utility balances to the municipality', offsetDays: 1 },
      { title: 'Disburse seller proceeds and commissions', offsetDays: 1 },
    ],
  },
  {
    key: 'recording',
    label: 'Recording',
    description: 'Record deed and security instrument with the county.',
    tasks: [
      { title: 'Submit deed for recording', offsetDays: 1 },
      { title: 'Submit mortgage / deed of trust for recording', offsetDays: 1, financedOnly: true },
      { title: 'Log recorded instrument numbers', offsetDays: 7 },
      { title: 'Receive lien release(s) for paid-off loans', offsetDays: 30 },
    ],
  },
  {
    key: 'policy',
    label: 'Policy Issuance',
    description: 'Issue final title insurance policies.',
    tasks: [
      { title: "Issue owner's title policy", offsetDays: 30 },
      { title: "Issue lender's title policy", offsetDays: 30, financedOnly: true },
    ],
  },
  {
    key: 'closed',
    label: 'Complete',
    description: 'File complete and archived.',
    tasks: [],
  },
];

export const STAGE_KEYS = STAGES.map((s) => s.key);

export function stageIndex(key) {
  return STAGE_KEYS.indexOf(key);
}

export function getStage(key) {
  return STAGES.find((s) => s.key === key);
}

export const PARTY_ROLES = [
  'buyer',
  'seller',
  'lender',
  'loan_officer',
  'buyer_agent',
  'listing_agent',
  'attorney',
  'escrow_officer',
  'surveyor',
  'hoa',
  'other',
];

export const DOCUMENT_CATEGORIES = [
  'contract',
  'title_search',
  'commitment',
  'survey',
  'payoff',
  'hoa',
  'lender',
  'closing',
  'recorded',
  'policy',
  'borrower',
  'other',
];

export const DOCUMENT_STATUSES = ['requested', 'received', 'reviewed', 'recorded'];

// Documents the buyer / borrower must provide before closing, requested
// through the borrower portal. `hint` is shown to the borrower.
export const BORROWER_DOCUMENTS = [
  { name: 'Government-issued photo ID (each signer)', hint: "Driver's license or passport, front and back. Every person signing needs one." },
  { name: 'Vesting instructions', hint: 'How you will hold title, e.g. "John and Jane Smith, married, as tenants by the entirety".' },
  { name: 'Proof of funds to close', hint: 'Recent bank statement showing funds for your down payment and closing costs.' },
  { name: 'Earnest money deposit receipt', hint: 'Receipt or cancelled check for your earnest money deposit.' },
  { name: "Homeowner's insurance binder / declarations page", hint: 'From your insurance agent, naming your lender as mortgagee.', financedOnly: true },
  { name: 'Signed Closing Disclosure acknowledgment', hint: 'Your lender sends this at least 3 business days before closing.', financedOnly: true },
];

// Standard Schedule B-II exceptions that appear on nearly every commitment.
export const STANDARD_EXCEPTIONS = [
  'Rights or claims of parties in possession not shown by the public records.',
  'Easements, or claims of easements, not shown by the public records.',
  'Encroachments, overlaps, boundary line disputes, or other matters which would be disclosed by an accurate survey.',
  'Any lien, or right to a lien, for services, labor, or material not shown by the public records.',
  'Taxes and assessments for the current year, a lien not yet due and payable.',
];

// Baseline Schedule B-I requirements; the examiner adds file-specific ones.
export function standardRequirements({ financed }) {
  const reqs = [
    'Payment of the full consideration to, or for the account of, the seller.',
    'Record a warranty deed from the seller to the buyer.',
    'Payment of all taxes and assessments now due and payable.',
  ];
  if (financed) {
    reqs.push('Record a mortgage / deed of trust from the buyer to the lender securing the new loan.');
  }
  return reqs;
}

export function addDays(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Task rows to create for a newly opened file.
export function buildTasks({ financed, closingDate }) {
  const rows = [];
  for (const stage of STAGES) {
    stage.tasks.forEach((t, i) => {
      if (t.financedOnly && !financed) return;
      rows.push({
        stage: stage.key,
        title: t.title,
        sort_order: i,
        offset_days: t.offsetDays,
        due_date: closingDate ? addDays(closingDate, t.offsetDays) : null,
      });
    });
  }
  return rows;
}
