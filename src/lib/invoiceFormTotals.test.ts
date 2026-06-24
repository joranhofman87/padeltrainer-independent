import { describe, it, expect } from 'vitest';
import {
  computeCreateInvoiceTotals,
  computeEditInvoiceTotals,
  type InvoiceFormLineItem,
} from './invoiceFormTotals';

/**
 * Characterization test: pins that the extracted shared functions reproduce, byte-for-byte, the
 * math the trainer/academy create + edit invoice forms previously computed inline. The reference
 * implementations below are the historical inline `useMemo` bodies; a future edit to
 * invoiceFormTotals.ts that drifts from them (e.g. "simplifying" onto calculateVatTotals) will fail
 * here. Explicit value pins at the end guard the real-world cent-level outputs.
 */
const r2 = (n: number) => Math.round(n * 100) / 100;

function createRef(lineItems: InvoiceFormLineItem[], pricesIncludeVat: boolean) {
  const hasMultipleRates = new Set(lineItems.map((li) => li.vat_rate)).size > 1;
  let totalSub = 0;
  let totalVatAmt = 0;
  const breakdown: Record<number, { subtotal: number; vat: number }> = {};
  for (const li of lineItems) {
    const lineTotal = li.quantity * li.unit_price;
    const lineVatRate = li.vat_rate as number;
    let lineSub: number;
    let lineVat: number;
    if (pricesIncludeVat) {
      lineSub = lineTotal / (1 + lineVatRate / 100);
      lineVat = lineTotal - lineSub;
    } else {
      lineSub = lineTotal;
      lineVat = lineSub * (lineVatRate / 100);
    }
    totalSub += lineSub;
    totalVatAmt += lineVat;
    if (!breakdown[lineVatRate]) breakdown[lineVatRate] = { subtotal: 0, vat: 0 };
    breakdown[lineVatRate].subtotal += lineSub;
    breakdown[lineVatRate].vat += lineVat;
  }
  for (const rate in breakdown) {
    breakdown[rate].subtotal = r2(breakdown[rate].subtotal);
    breakdown[rate].vat = r2(breakdown[rate].vat);
  }
  const sub = r2(totalSub);
  const vat = r2(totalVatAmt);
  const tot = pricesIncludeVat
    ? r2(lineItems.reduce((s, li) => s + li.quantity * li.unit_price, 0))
    : r2(sub + vat);
  return { subtotal: sub, vatAmount: vat, total: tot, vatBreakdown: hasMultipleRates ? breakdown : null };
}

function editRef(lineItems: InvoiceFormLineItem[], vatRate: number, pricesIncludeVat: boolean) {
  const hasPerItemVat = lineItems.some((li) => li.vat_rate !== undefined && li.vat_rate !== vatRate);
  if (hasPerItemVat) {
    let totalSub = 0;
    let totalVatAmt = 0;
    const breakdown: Record<number, { subtotal: number; vat: number }> = {};
    for (const li of lineItems) {
      const lineTotal = li.quantity * li.unit_price;
      const lineVatRate = li.vat_rate ?? vatRate;
      let lineSub: number;
      let lineVat: number;
      if (pricesIncludeVat) {
        lineSub = lineTotal / (1 + lineVatRate / 100);
        lineVat = lineTotal - lineSub;
      } else {
        lineSub = lineTotal;
        lineVat = lineSub * (lineVatRate / 100);
      }
      totalSub += lineSub;
      totalVatAmt += lineVat;
      if (!breakdown[lineVatRate]) breakdown[lineVatRate] = { subtotal: 0, vat: 0 };
      breakdown[lineVatRate].subtotal += lineSub;
      breakdown[lineVatRate].vat += lineVat;
    }
    for (const rate in breakdown) {
      breakdown[rate].subtotal = r2(breakdown[rate].subtotal);
      breakdown[rate].vat = r2(breakdown[rate].vat);
    }
    const sub = r2(totalSub);
    const vat = r2(totalVatAmt);
    const t = pricesIncludeVat
      ? r2(lineItems.reduce((s, li) => s + li.quantity * li.unit_price, 0))
      : r2(sub + vat);
    return { subtotal: sub, vatAmount: vat, total: t, vatBreakdown: breakdown };
  }
  const lineTotal = lineItems.reduce((sum, li) => sum + li.quantity * li.unit_price, 0);
  if (pricesIncludeVat) {
    const t = r2(lineTotal);
    const sub = r2(t / (1 + vatRate / 100));
    return { subtotal: sub, vatAmount: r2(t - sub), total: t, vatBreakdown: null };
  }
  const sub = r2(lineTotal);
  const vat = r2(sub * (vatRate / 100));
  return { subtotal: sub, vatAmount: vat, total: r2(sub + vat), vatBreakdown: null };
}

const cases: { name: string; items: InvoiceFormLineItem[] }[] = [
  { name: 'single line 21%', items: [{ description: 'a', quantity: 1, unit_price: 121, vat_rate: 21, amount: 121 }] },
  { name: 'multi line same 21%', items: [
    { description: 'a', quantity: 2, unit_price: 50, vat_rate: 21, amount: 100 },
    { description: 'b', quantity: 1, unit_price: 30.5, vat_rate: 21, amount: 30.5 },
  ] },
  { name: 'mixed rates 21 + 9', items: [
    { description: 'a', quantity: 1, unit_price: 121, vat_rate: 21, amount: 121 },
    { description: 'b', quantity: 3, unit_price: 36.33, vat_rate: 9, amount: 108.99 },
  ] },
  { name: 'awkward 33.33 @ 21%', items: [{ description: 'a', quantity: 3, unit_price: 11.11, vat_rate: 21, amount: 33.33 }] },
  { name: 'zero price', items: [{ description: 'a', quantity: 1, unit_price: 0, vat_rate: 21, amount: 0 }] },
];

describe('computeCreateInvoiceTotals reproduces the create-form inline math', () => {
  for (const { name, items } of cases) {
    for (const incl of [true, false]) {
      it(`${name} (${incl ? 'incl' : 'excl'} VAT)`, () => {
        expect(computeCreateInvoiceTotals(items, incl)).toEqual(createRef(items, incl));
      });
    }
  }
});

describe('computeEditInvoiceTotals reproduces the edit-form inline math', () => {
  for (const { name, items } of cases) {
    for (const incl of [true, false]) {
      it(`${name} (${incl ? 'incl' : 'excl'} VAT)`, () => {
        const vatRate = items[0]?.vat_rate ?? 21;
        expect(computeEditInvoiceTotals(items, vatRate, incl)).toEqual(editRef(items, vatRate, incl));
      });
    }
  }
});

describe('explicit value pins', () => {
  it('create: €130.50 @ 21% excl sums per line (vat 27.41)', () => {
    const items: InvoiceFormLineItem[] = [
      { description: 'a', quantity: 2, unit_price: 50, vat_rate: 21, amount: 100 },
      { description: 'b', quantity: 1, unit_price: 30.5, vat_rate: 21, amount: 30.5 },
    ];
    expect(computeCreateInvoiceTotals(items, false)).toEqual({
      subtotal: 130.5,
      vatAmount: 27.41,
      total: 157.91,
      vatBreakdown: null,
    });
  });

  it('create: single line €121 @ 21% incl → 100 + 21', () => {
    const items: InvoiceFormLineItem[] = [{ description: 'a', quantity: 1, unit_price: 121, vat_rate: 21, amount: 121 }];
    expect(computeCreateInvoiceTotals(items, true)).toEqual({
      subtotal: 100,
      vatAmount: 21,
      total: 121,
      vatBreakdown: null,
    });
  });

  it('create: mixed 21% + 9% returns a per-rate breakdown', () => {
    const items: InvoiceFormLineItem[] = [
      { description: 'a', quantity: 1, unit_price: 121, vat_rate: 21, amount: 121 },
      { description: 'b', quantity: 1, unit_price: 109, vat_rate: 9, amount: 109 },
    ];
    const r = computeCreateInvoiceTotals(items, true);
    expect(r.vatBreakdown).not.toBeNull();
    expect(Object.keys(r.vatBreakdown!).sort()).toEqual(['21', '9']);
    expect(r.subtotal + r.vatAmount).toBeCloseTo(r.total, 2);
  });
});
