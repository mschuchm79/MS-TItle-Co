import { readFileSync } from 'node:fs';

const DEFAULT_RATES = JSON.parse(
  readFileSync(new URL('../config/rates.json', import.meta.url), 'utf8'),
);

const round2 = (n) => Math.round(n * 100) / 100;

// Tiered (marginal) premium: each band of liability is charged at its own rate.
export function tieredPremium(amount, { tiers, minimumPremium = 0 }) {
  if (!(amount > 0)) return 0;
  let premium = 0;
  let floor = 0;
  for (const tier of tiers) {
    const ceiling = tier.upTo ?? Infinity;
    if (amount <= floor) break;
    const band = Math.min(amount, ceiling) - floor;
    premium += (band / 1000) * tier.perThousand;
    floor = ceiling;
  }
  return round2(Math.max(premium, minimumPremium));
}

export function ownersPremium(price, rates = DEFAULT_RATES) {
  return tieredPremium(price, rates.ownersPolicy);
}

// Lender's policy issued simultaneously with the owner's policy: flat fee,
// plus the owner's rate on any loan amount exceeding the purchase price.
export function lendersPremium(loan, price, rates = DEFAULT_RATES) {
  if (!(loan > 0)) return 0;
  const { simultaneousIssueFee, excessRatePercentOfOwners } = rates.lendersPolicy;
  let premium = simultaneousIssueFee;
  if (loan > price) {
    const excess =
      tieredPremium(loan, { tiers: rates.ownersPolicy.tiers }) -
      tieredPremium(price, { tiers: rates.ownersPolicy.tiers });
    premium += excess * (excessRatePercentOfOwners / 100);
  }
  return round2(premium);
}

// Title & escrow charges estimate, split between buyer and seller.
export function estimateClosingCosts({ purchasePrice, loanAmount = 0 }, rates = DEFAULT_RATES) {
  const price = Number(purchasePrice) || 0;
  const loan = Number(loanAmount) || 0;
  const financed = loan > 0;
  const lines = [];
  const add = (label, amount, payer) => {
    if (amount > 0) lines.push({ label, amount: round2(amount), payer });
  };

  add("Owner's title policy", ownersPremium(price, rates), rates.payers.ownersPolicy);
  if (financed) {
    add("Lender's title policy (simultaneous issue)", lendersPremium(loan, price, rates), rates.payers.lendersPolicy);
    add('Title endorsements', rates.endorsementsFlat, rates.payers.endorsements);
    add('Recording fee – mortgage / deed of trust', rates.recording.mortgage, rates.payers.recordingMortgage);
  }
  add('Recording fee – deed', rates.recording.deed, rates.payers.recordingDeed);
  add('Transfer tax', (price / 1000) * rates.transferTaxPerThousand, rates.payers.transferTax);

  const split = rates.settlementFeeSplit;
  add('Settlement / escrow fee (buyer share)', rates.settlementFee * split.buyer, 'buyer');
  add('Settlement / escrow fee (seller share)', rates.settlementFee * split.seller, 'seller');

  const total = (payer) => round2(lines.filter((l) => l.payer === payer).reduce((s, l) => s + l.amount, 0));
  return {
    lines,
    buyerTotal: total('buyer'),
    sellerTotal: total('seller'),
    grandTotal: round2(lines.reduce((s, l) => s + l.amount, 0)),
    disclaimer: rates._note,
  };
}
