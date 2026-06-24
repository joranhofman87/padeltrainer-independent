/**
 * Shared invoice-FORM money math — single source for the trainer + academy create/edit invoice
 * forms, which previously each duplicated this computation inline.
 *
 * IMPORTANT: these are extracted VERBATIM from the forms' previous inline `useMemo` bodies, so the
 * consolidation is byte-for-byte behaviour-preserving (verified by invoiceFormTotals.test.ts).
 * They are intentionally NOT routed through `calculateVatTotals` in invoiceCalc.ts: that function
 * computes the single-rate path from the aggregate (subtotal × rate) whereas the create form sums
 * per line, which differs by up to a cent at float half-cent boundaries (e.g. €130.50 @ 21% excl).
 * Aligning the forms onto `calculateVatTotals` is a deliberate, separately-verified follow-up — not
 * a free refactor on a money path.
 *
 * The create and edit forms genuinely differ (create uses each line's own rate; edit drives off an
 * editable global rate and only does the per-line breakdown when a line overrides it), hence two
 * functions rather than one.
 */

export interface InvoiceFormLineItem {
  description: string;
  quantity: number;
  unit_price: number;
  amount: number;
  vat_rate?: number;
}

export interface InvoiceFormTotals {
  subtotal: number;
  vatAmount: number;
  total: number;
  /** null when there is a single effective VAT rate; a per-rate record when rates are mixed. */
  vatBreakdown: Record<number, { subtotal: number; vat: number }> | null;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Create-invoice totals (trainer + academy create forms were identical). Per-line VAT. */
export function computeCreateInvoiceTotals(
  lineItems: InvoiceFormLineItem[],
  pricesIncludeVat: boolean,
): InvoiceFormTotals {
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

/** Edit-invoice totals (trainer + academy edit forms were identical). Editable global rate. */
export function computeEditInvoiceTotals(
  lineItems: InvoiceFormLineItem[],
  vatRate: number,
  pricesIncludeVat: boolean,
): InvoiceFormTotals {
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
