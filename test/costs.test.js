import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tieredPremium, ownersPremium, lendersPremium, estimateClosingCosts } from '../src/costs.js';

const rates = {
  tiers: [
    { upTo: 100000, perThousand: 5 },
    { upTo: null, perThousand: 2 },
  ],
};

test('tiered premium charges each band at its own rate', () => {
  assert.equal(tieredPremium(100000, rates), 500);
  assert.equal(tieredPremium(250000, rates), 500 + 300);
  assert.equal(tieredPremium(0, rates), 0);
});

test('minimum premium applies to small policies', () => {
  assert.equal(tieredPremium(10000, { ...rates, minimumPremium: 250 }), 250);
});

test("owner's premium uses default rate manual", () => {
  // 100k @ 5.75 + 385k @ 5.00
  assert.equal(ownersPremium(485000), 575 + 1925);
});

test("lender's simultaneous premium is flat when loan <= price", () => {
  assert.equal(lendersPremium(388000, 485000), 150);
  assert.equal(lendersPremium(0, 485000), 0);
});

test("lender's premium adds excess liability when loan > price", () => {
  // excess 10k in the 100k-500k band at 5.00/1000 = 50
  assert.equal(lendersPremium(310000, 300000), 200);
});

test('cash purchase has no lender charges', () => {
  const est = estimateClosingCosts({ purchasePrice: 300000, loanAmount: 0 });
  assert.ok(!est.lines.some((l) => /lender|mortgage/i.test(l.label)));
  assert.equal(est.buyerTotal + est.sellerTotal, est.grandTotal);
});

test('financed purchase splits costs between buyer and seller', () => {
  const est = estimateClosingCosts({ purchasePrice: 485000, loanAmount: 388000 });
  assert.ok(est.lines.some((l) => l.payer === 'buyer' && /Lender/.test(l.label)));
  assert.ok(est.lines.some((l) => l.payer === 'seller' && /Owner/.test(l.label)));
  assert.ok(Math.abs(est.buyerTotal + est.sellerTotal - est.grandTotal) < 0.01);
});
