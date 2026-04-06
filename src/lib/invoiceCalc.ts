/**
 * Pure computation functions for invoice calculations.
 * No Supabase dependencies — fully unit-testable.
 */

export interface InvoiceLineItem {
  description: string;
  quantity: number;
  unit_price: number;
  vat_rate?: number;
  date?: string;
}

export interface VatTotals {
  subtotal: number;
  vatAmount: number;
  total: number;
  vatBreakdown: Record<number, { subtotal: number; vat: number }>;
}

export interface ExtraCostInput {
  description: string;
  price: number;
  type?: 'per_session' | 'one_time';
  vat_rate?: number;
}

/**
 * Detect split count from existing line item descriptions (e.g. "(1/2)" → 2).
 */
export function detectSplitCount(lineItems: { description?: string }[]): number {
  for (const item of lineItems) {
    const match = item.description?.match(/\(1\/(\d+)\)/);
    if (match) return parseInt(match[1], 10);
  }
  return 1;
}

/**
 * Round to 2 decimal places using banker-safe integer math.
 */
export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Apply split to a price: divide by splitCount and round to 2 decimals.
 */
export function applySplit(price: number, splitCount: number): number {
  if (splitCount <= 1) return price;
  return round2(price / splitCount);
}

/**
 * Build line items for a cycle invoice from booking data.
 */
export function buildCycleLineItems(params: {
  bookings: {
    paymentAmount: number | null;
    slotPricePerSession: number | null;
    startTime: string;
    locationName: string;
  }[];
  cyclusName: string;
  splitCount: number;
  extraCosts: ExtraCostInput[];
  defaultVatRate: number;
}): InvoiceLineItem[] {
  const { bookings, cyclusName, splitCount, extraCosts, defaultVatRate } = params;
  const lineItems: InvoiceLineItem[] = [];

  // Resolve price per booking
  const prices = bookings.map(b => b.paymentAmount || b.slotPricePerSession || 0);
  const nonZeroPrices = prices.filter(p => p > 0);
  const allSamePrice = nonZeroPrices.length > 0 && nonZeroPrices.every(p => p === nonZeroPrices[0]);

  if (allSamePrice) {
    const pricePerSession = applySplit(nonZeroPrices[0], splitCount);
    const desc = splitCount > 1
      ? `${cyclusName} (${bookings.length} weken) (1/${splitCount})`
      : `${cyclusName} (${bookings.length} weken)`;
    lineItems.push({ description: desc, quantity: bookings.length, unit_price: pricePerSession });
  } else {
    // Mixed prices — per-session line items
    for (const b of bookings) {
      const startTime = new Date(b.startTime);
      let price = b.paymentAmount || b.slotPricePerSession || 0;
      price = applySplit(price, splitCount);
      const datePart = startTime.toLocaleDateString("nl-NL");
      const timePart = startTime.toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" });
      const locSuffix = b.locationName ? ` (${b.locationName})` : "";
      let desc = `${cyclusName} - ${datePart} ${timePart}${locSuffix}`;
      if (splitCount > 1) desc += ` (1/${splitCount})`;
      lineItems.push({
        description: desc,
        quantity: 1,
        unit_price: price,
        date: startTime.toISOString().split("T")[0],
      });
    }
  }

  // Add extra costs
  for (const ec of extraCosts) {
    if (!ec.description || ec.price <= 0) continue;
    const isOneTime = ec.type === "one_time";
    const ecPrice = applySplit(ec.price, splitCount);
    const ecDesc = isOneTime ? ec.description : `${ec.description} (per sessie)`;
    lineItems.push({
      description: splitCount > 1 ? `${ecDesc} (1/${splitCount})` : ecDesc,
      quantity: isOneTime ? 1 : bookings.length,
      unit_price: ecPrice,
      vat_rate: ec.vat_rate ?? defaultVatRate,
    });
  }

  return lineItems;
}

/**
 * Calculate VAT totals from line items.
 * Supports single-rate and multi-rate VAT, both inclusive and exclusive pricing.
 */
export function calculateVatTotals(
  lineItems: InvoiceLineItem[],
  defaultVatRate: number,
  pricesIncludeVat: boolean,
): VatTotals {
  const hasMultipleVatRates = lineItems.some(
    item => (item.vat_rate ?? defaultVatRate) !== defaultVatRate,
  );

  let subtotal: number;
  let vatAmount: number;
  let total: number;
  const vatBreakdown: Record<number, { subtotal: number; vat: number }> = {};

  if (hasMultipleVatRates) {
    let totalSub = 0;
    let totalVat = 0;

    for (const item of lineItems) {
      const lineTotal = item.quantity * item.unit_price;
      const lineVatRate = item.vat_rate ?? defaultVatRate;
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
      totalVat += lineVat;

      if (!vatBreakdown[lineVatRate]) {
        vatBreakdown[lineVatRate] = { subtotal: 0, vat: 0 };
      }
      vatBreakdown[lineVatRate].subtotal += lineSub;
      vatBreakdown[lineVatRate].vat += lineVat;
    }

    subtotal = round2(totalSub);
    vatAmount = round2(totalVat);
    total = pricesIncludeVat
      ? lineItems.reduce((sum, item) => sum + item.quantity * item.unit_price, 0)
      : round2(subtotal + vatAmount);

    for (const rate in vatBreakdown) {
      vatBreakdown[rate].subtotal = round2(vatBreakdown[rate].subtotal);
      vatBreakdown[rate].vat = round2(vatBreakdown[rate].vat);
    }
  } else {
    const lineItemTotal = lineItems.reduce(
      (sum, item) => sum + item.quantity * item.unit_price, 0,
    );
    if (pricesIncludeVat) {
      total = lineItemTotal;
      subtotal = total / (1 + defaultVatRate / 100);
      vatAmount = total - subtotal;
    } else {
      subtotal = lineItemTotal;
      vatAmount = subtotal * (defaultVatRate / 100);
      total = subtotal + vatAmount;
    }
  }

  return {
    subtotal: round2(subtotal),
    vatAmount: round2(vatAmount),
    total: round2(total),
    vatBreakdown,
  };
}

/**
 * Calculate the split-invoice share for each player.
 * Returns the share for the "first" player (who absorbs rounding remainder)
 * and the standard share for the rest.
 */
export function calculateSplitShares(
  originalTotal: number,
  totalPlayers: number,
): { firstPlayerTotal: number; otherPlayerShare: number } {
  const splitShare = Math.floor((originalTotal / totalPlayers) * 100) / 100;
  const remainder = round2(originalTotal - splitShare * totalPlayers);
  return {
    firstPlayerTotal: round2(splitShare + remainder),
    otherPlayerShare: splitShare,
  };
}
