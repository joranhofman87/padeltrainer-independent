/**
 * Shared invoice recalculation utility.
 * Used by DeleteSlotDialog and TrainerScheduleOverview when bookings are removed.
 */
import { supabase } from "@/lib/supabaseClient";
import { logger } from "@/lib/logger";
import {
  detectSplitCount,
  buildCycleLineItems,
  calculateVatTotals,
  applySplit,
  round2,
  type InvoiceLineItem,
  type ExtraCostInput,
} from "@/lib/invoiceCalc";

interface InvoiceRecord {
  id: string;
  booking_ids: string[];
  vat_rate: number;
  line_items: any[];
  status: string;
}

/**
 * Recalculate an unpaid invoice after bookings have been removed.
 * Handles split payments, multi-rate VAT, and pdf_url reset.
 */
export async function recalculateInvoiceAfterRemoval(
  invoice: InvoiceRecord,
  removedBookingIds: string[],
): Promise<void> {
  const remainingBookingIds = invoice.booking_ids.filter(
    (id) => !removedBookingIds.includes(id),
  );

  if (remainingBookingIds.length === 0) {
    // All bookings removed — mark invoice as cancelled
    await supabase
      .from("invoices")
      .update({
        status: "cancelled",
        booking_ids: [],
        line_items: [],
        subtotal: 0,
        vat_amount: 0,
        total: 0,
        pdf_url: null,
        vat_breakdown: null,
        notes: "Factuur geannuleerd — alle sessies zijn verwijderd",
      })
      .eq("id", invoice.id);
    return;
  }

  // Fetch remaining bookings with slot details
  const { data: remainingBookings } = await supabase
    .from("bookings")
    .select(
      `
      id, payment_amount,
      availability_slots!inner(price_per_session, cyclus_id, cyclus_name, start_time, locations(name), prices_include_vat, extra_costs)
    `,
    )
    .in("id", remainingBookingIds);

  if (!remainingBookings || remainingBookings.length === 0) return;

  const splitCount = detectSplitCount(invoice.line_items);
  const firstSlot = remainingBookings[0].availability_slots as any;
  const sharedCyclusId = firstSlot.cyclus_id;
  const allSameCyclus =
    sharedCyclusId &&
    remainingBookings.every(
      (b) => (b.availability_slots as any).cyclus_id === sharedCyclusId,
    );
  const defaultVatRate = invoice.vat_rate || 21;

  // Resolve price per booking: prefer payment_amount, then slot price
  const resolveBookingPrice = (b: any): number => {
    const bSlot = b.availability_slots as any;
    return b.payment_amount || bSlot.price_per_session || 0;
  };

  // Build session line items
  let lineItems: {
    description: string;
    quantity: number;
    unit_price: number;
    vat_rate?: number;
    date?: string;
  }[];

  if (allSameCyclus) {
    const cyclusName = firstSlot.cyclus_name || "Training cyclus";

    // Resolve price from ALL remaining bookings, not just the first one
    const prices = remainingBookings.map(resolveBookingPrice);
    const nonZeroPrices = prices.filter((p) => p > 0);
    const allSamePrice = nonZeroPrices.length > 0 && nonZeroPrices.every((p) => p === nonZeroPrices[0]);

    if (allSamePrice) {
      let pricePerSession = nonZeroPrices[0];
      if (splitCount > 1) {
        pricePerSession = Math.round((pricePerSession / splitCount) * 100) / 100;
      }
      const desc = splitCount > 1
        ? `${cyclusName} (${remainingBookings.length} weken) (1/${splitCount})`
        : `${cyclusName} (${remainingBookings.length} weken)`;
      lineItems = [
        {
          description: desc,
          quantity: remainingBookings.length,
          unit_price: pricePerSession,
        },
      ];
    } else {
      // Mixed prices or some missing — fall back to per-session line items
      lineItems = remainingBookings.map((b) => {
        const bSlot = b.availability_slots as any;
        const startTime = new Date(bSlot.start_time);
        const locationName = bSlot.locations?.name || "";
        let price = resolveBookingPrice(b);
        if (splitCount > 1) {
          price = Math.round((price / splitCount) * 100) / 100;
        }
        const desc = splitCount > 1
          ? `${cyclusName} - ${startTime.toLocaleDateString("nl-NL")} ${startTime.toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" })}${locationName ? ` (${locationName})` : ""} (1/${splitCount})`
          : `${cyclusName} - ${startTime.toLocaleDateString("nl-NL")} ${startTime.toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" })}${locationName ? ` (${locationName})` : ""}`;
        return {
          description: desc,
          quantity: 1,
          unit_price: price,
          date: startTime.toISOString().split("T")[0],
        };
      });
    }
  } else {
    lineItems = remainingBookings.map((b) => {
      const bSlot = b.availability_slots as any;
      const startTime = new Date(bSlot.start_time);
      const locationName = bSlot.locations?.name || "";
      let desc = bSlot.cyclus_name
        ? `${bSlot.cyclus_name} - ${startTime.toLocaleDateString("nl-NL")} ${startTime.toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" })}${locationName ? ` (${locationName})` : ""}`
        : `Training sessie - ${startTime.toLocaleDateString("nl-NL")}`;
      let price = resolveBookingPrice(b);
      if (splitCount > 1) {
        price = Math.round((price / splitCount) * 100) / 100;
        desc = `${desc} (1/${splitCount})`;
      }
      return {
        description: desc,
        quantity: 1,
        unit_price: price,
        date: startTime.toISOString().split("T")[0],
      };
    });
  }

  // Add extra costs from cycle settings, fall back to slot extra_costs
  let extraCosts: any[] | null = null;

  if (sharedCyclusId) {
    const { data: cycleData } = await supabase
      .from("cycles")
      .select("settings")
      .eq("id", sharedCyclusId)
      .maybeSingle();
    extraCosts = (cycleData?.settings as any)?.extra_costs || null;
  }

  if (!extraCosts || !Array.isArray(extraCosts) || extraCosts.length === 0) {
    const slotExtraCosts = firstSlot.extra_costs;
    if (slotExtraCosts && Array.isArray(slotExtraCosts)) {
      extraCosts = slotExtraCosts;
    }
  }

  if (extraCosts && Array.isArray(extraCosts)) {
    for (const ec of extraCosts) {
      if (ec.description && ec.price > 0) {
        const isOneTime = ec.type === "one_time";
        let ecPrice = ec.price;
        if (splitCount > 1) {
          ecPrice = Math.round((ecPrice / splitCount) * 100) / 100;
        }
        const ecDesc = isOneTime
          ? ec.description
          : `${ec.description} (per sessie)`;
        lineItems.push({
          description: splitCount > 1 ? `${ecDesc} (1/${splitCount})` : ecDesc,
          quantity: isOneTime ? 1 : remainingBookings.length,
          unit_price: ecPrice,
          vat_rate: ec.vat_rate ?? defaultVatRate,
        });
      }
    }
  }

  // Calculate VAT (multi-rate aware)
  const slotPricesIncludeVat = firstSlot.prices_include_vat ?? true;
  const hasMultipleVatRates = lineItems.some(
    (item) => (item.vat_rate ?? defaultVatRate) !== defaultVatRate,
  );

  let subtotal: number;
  let vatAmount: number;
  let totalInclusive: number;
  let vatBreakdown: Record<number, { subtotal: number; vat: number }> = {};

  if (hasMultipleVatRates) {
    let totalSub = 0;
    let totalVat = 0;

    for (const item of lineItems) {
      const lineTotal = item.quantity * item.unit_price;
      const lineVatRate = item.vat_rate ?? defaultVatRate;
      let lineSub: number;
      let lineVat: number;

      if (slotPricesIncludeVat) {
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

    subtotal = Math.round(totalSub * 100) / 100;
    vatAmount = Math.round(totalVat * 100) / 100;
    totalInclusive = slotPricesIncludeVat
      ? lineItems.reduce((sum, item) => sum + item.quantity * item.unit_price, 0)
      : Math.round((subtotal + vatAmount) * 100) / 100;

    for (const rate in vatBreakdown) {
      vatBreakdown[rate].subtotal =
        Math.round(vatBreakdown[rate].subtotal * 100) / 100;
      vatBreakdown[rate].vat =
        Math.round(vatBreakdown[rate].vat * 100) / 100;
    }
  } else {
    const lineItemTotal = lineItems.reduce(
      (sum, item) => sum + item.quantity * item.unit_price,
      0,
    );
    if (slotPricesIncludeVat) {
      totalInclusive = lineItemTotal;
      subtotal = totalInclusive / (1 + defaultVatRate / 100);
      vatAmount = totalInclusive - subtotal;
    } else {
      subtotal = lineItemTotal;
      vatAmount = subtotal * (defaultVatRate / 100);
      totalInclusive = subtotal + vatAmount;
    }
  }

  // Update invoice
  await supabase
    .from("invoices")
    .update({
      booking_ids: remainingBookingIds,
      line_items: lineItems,
      subtotal: Math.round(subtotal * 100) / 100,
      vat_amount: Math.round(vatAmount * 100) / 100,
      total: Math.round(totalInclusive * 100) / 100,
      pdf_url: null,
      ...(Object.keys(vatBreakdown).length > 0
        ? { vat_breakdown: vatBreakdown }
        : { vat_breakdown: null }),
    })
    .eq("id", invoice.id);

  // Regenerate PDF
  try {
    await supabase.functions.invoke("generate-invoice", {
      body: { invoiceId: invoice.id },
    });
  } catch (err) {
    logger.error(
      "Failed to regenerate invoice PDF",
      err instanceof Error ? err : new Error(String(err)),
      { component: "invoiceSync" },
    );
  }
}

/**
 * Recalculate unpaid invoices after slot price changes.
 * Finds invoices with bookings on the given slots and rebuilds totals.
 */
export async function syncInvoicesAfterPriceChange(
  slotIds: string[],
): Promise<void> {
  if (slotIds.length === 0) return;

  // Find bookings on these slots
  const { data: bookings } = await supabase
    .from("bookings")
    .select("id, slot_id, payment_amount")
    .in("slot_id", slotIds)
    .in("status", ["confirmed", "pending"]);

  if (!bookings || bookings.length === 0) return;

  const bookingIds = bookings.map((b) => b.id);

  // Find unpaid invoices overlapping with these bookings
  const { data: invoices } = await supabase
    .from("invoices")
    .select("id, invoice_number, status, booking_ids, total, vat_rate, line_items")
    .in("status", ["sent", "pending", "draft"])
    .overlaps("booking_ids", bookingIds);

  if (!invoices || invoices.length === 0) return;

  // For each affected invoice, do a full recalculate by "removing" zero bookings
  // This forces a rebuild of line items from current slot/booking data
  for (const inv of invoices) {
    await recalculateInvoiceAfterRemoval(
      {
        id: inv.id,
        booking_ids: (inv.booking_ids as string[]) || [],
        vat_rate: (inv.vat_rate as number) || 21,
        line_items: (inv.line_items as any[]) || [],
        status: inv.status as string,
      },
      [], // no bookings removed — just recalculate with current prices
    );
  }
}

/**
 * Recalculate the split count (1/N) for all unpaid invoices in a cycle.
 * Called when a player is added to or removed from a split-payment cycle.
 * Updates all sibling invoices so each player pays 1/N of the session price.
 */
export async function syncSplitCountForCycle(
  cyclusId: string,
): Promise<void> {
  if (!cyclusId) return;

  // 1. Find all slots in this cycle
  const { data: cycleSlots } = await supabase
    .from("availability_slots")
    .select("id, price_per_session, split_payment, cyclus_name, prices_include_vat, extra_costs")
    .eq("cyclus_id", cyclusId);

  if (!cycleSlots || cycleSlots.length === 0) return;

  const firstSlot = cycleSlots[0] as any;
  if (!firstSlot.split_payment) return; // Not a split-payment cycle

  const slotIds = cycleSlots.map((s) => s.id);

  // 2. Count unique active players across the cycle
  const { data: activeBookings } = await supabase
    .from("bookings")
    .select("id, player_id, guest_player_id")
    .in("slot_id", slotIds)
    .in("status", ["confirmed", "pending"]);

  if (!activeBookings || activeBookings.length === 0) return;

  const uniquePlayers = new Set<string>();
  for (const b of activeBookings) {
    const key = b.player_id || b.guest_player_id;
    if (key) uniquePlayers.add(key);
  }

  const playerCount = uniquePlayers.size;
  if (playerCount <= 1) return; // No split needed

  const activeBookingIds = activeBookings.map((b) => b.id);

  // 3. Find all unpaid invoices overlapping with these bookings
  const { data: invoices } = await supabase
    .from("invoices")
    .select("id, booking_ids, line_items, vat_rate, status")
    .in("status", ["sent", "pending", "draft"])
    .overlaps("booking_ids", activeBookingIds);

  if (!invoices || invoices.length === 0) return;

  // 4. For each invoice, rebuild with new split count
  for (const inv of invoices) {
    const invBookingIds = (inv.booking_ids as string[]) || [];
    // Only process if this invoice actually overlaps with active bookings
    const relevantIds = invBookingIds.filter((id) => activeBookingIds.includes(id));
    if (relevantIds.length === 0) continue;

    // Recalculate using the shared function — it will detect the split from line items
    // But we need to force the NEW split count. We do this by updating descriptions first.
    // Instead, we call recalculateInvoiceAfterRemoval with no removals,
    // but we need to override the split detection.
    // The cleanest approach: directly rebuild line items here.

    const { data: invBookings } = await supabase
      .from("bookings")
      .select(`
        id, payment_amount,
        availability_slots!inner(price_per_session, cyclus_id, cyclus_name, start_time, locations(name), prices_include_vat, extra_costs)
      `)
      .in("id", invBookingIds)
      .in("status", ["confirmed", "pending"]);

    if (!invBookings || invBookings.length === 0) continue;

    const defaultVatRate = (inv.vat_rate as number) || 21;
    const slotPricesIncludeVat = (invBookings[0].availability_slots as any).prices_include_vat ?? true;
    const cyclusName = (invBookings[0].availability_slots as any).cyclus_name || "Training cyclus";

    // Get the base (unsplit) price per session
    const basePrice = (invBookings[0].availability_slots as any).price_per_session || 0;
    const splitPrice = Math.round((basePrice / playerCount) * 100) / 100;

    const lineItems: { description: string; quantity: number; unit_price: number; vat_rate?: number }[] = [
      {
        description: `${cyclusName} (${invBookings.length} weken) (1/${playerCount})`,
        quantity: invBookings.length,
        unit_price: splitPrice,
      },
    ];

    // Add extra costs from cycle settings
    const cyclusId2 = (invBookings[0].availability_slots as any).cyclus_id;
    let extraCosts: any[] | null = null;

    if (cyclusId2) {
      const { data: cycleData } = await supabase
        .from("cycles")
        .select("settings")
        .eq("id", cyclusId2)
        .maybeSingle();
      extraCosts = (cycleData?.settings as any)?.extra_costs || null;
    }

    if (!extraCosts || !Array.isArray(extraCosts) || extraCosts.length === 0) {
      const slotExtraCosts = (invBookings[0].availability_slots as any).extra_costs;
      if (slotExtraCosts && Array.isArray(slotExtraCosts)) {
        extraCosts = slotExtraCosts;
      }
    }

    if (extraCosts && Array.isArray(extraCosts)) {
      for (const ec of extraCosts) {
        if (ec.description && ec.price > 0) {
          const isOneTime = ec.type === "one_time";
          const ecPrice = Math.round((ec.price / playerCount) * 100) / 100;
          const ecDesc = isOneTime ? ec.description : `${ec.description} (per sessie)`;
          lineItems.push({
            description: `${ecDesc} (1/${playerCount})`,
            quantity: isOneTime ? 1 : invBookings.length,
            unit_price: ecPrice,
            vat_rate: ec.vat_rate ?? defaultVatRate,
          });
        }
      }
    }

    // Calculate totals
    const hasMultipleVatRates = lineItems.some(
      (item) => (item.vat_rate ?? defaultVatRate) !== defaultVatRate,
    );

    let subtotal: number;
    let vatAmount: number;
    let totalInclusive: number;
    let vatBreakdown: Record<number, { subtotal: number; vat: number }> = {};

    if (hasMultipleVatRates) {
      let totalSub = 0;
      let totalVat = 0;
      for (const item of lineItems) {
        const lineTotal = item.quantity * item.unit_price;
        const lineVatRate = item.vat_rate ?? defaultVatRate;
        let lineSub: number;
        let lineVat: number;
        if (slotPricesIncludeVat) {
          lineSub = lineTotal / (1 + lineVatRate / 100);
          lineVat = lineTotal - lineSub;
        } else {
          lineSub = lineTotal;
          lineVat = lineSub * (lineVatRate / 100);
        }
        totalSub += lineSub;
        totalVat += lineVat;
        if (!vatBreakdown[lineVatRate]) vatBreakdown[lineVatRate] = { subtotal: 0, vat: 0 };
        vatBreakdown[lineVatRate].subtotal += lineSub;
        vatBreakdown[lineVatRate].vat += lineVat;
      }
      subtotal = Math.round(totalSub * 100) / 100;
      vatAmount = Math.round(totalVat * 100) / 100;
      totalInclusive = slotPricesIncludeVat
        ? lineItems.reduce((sum, item) => sum + item.quantity * item.unit_price, 0)
        : Math.round((subtotal + vatAmount) * 100) / 100;
      for (const rate in vatBreakdown) {
        vatBreakdown[rate].subtotal = Math.round(vatBreakdown[rate].subtotal * 100) / 100;
        vatBreakdown[rate].vat = Math.round(vatBreakdown[rate].vat * 100) / 100;
      }
    } else {
      const lineItemTotal = lineItems.reduce((sum, item) => sum + item.quantity * item.unit_price, 0);
      if (slotPricesIncludeVat) {
        totalInclusive = lineItemTotal;
        subtotal = totalInclusive / (1 + defaultVatRate / 100);
        vatAmount = totalInclusive - subtotal;
      } else {
        subtotal = lineItemTotal;
        vatAmount = subtotal * (defaultVatRate / 100);
        totalInclusive = subtotal + vatAmount;
      }
    }

    await supabase
      .from("invoices")
      .update({
        line_items: lineItems,
        subtotal: Math.round(subtotal * 100) / 100,
        vat_amount: Math.round(vatAmount * 100) / 100,
        total: Math.round(totalInclusive * 100) / 100,
        pdf_url: null,
        ...(Object.keys(vatBreakdown).length > 0
          ? { vat_breakdown: vatBreakdown }
          : { vat_breakdown: null }),
      })
      .eq("id", inv.id);

    // Regenerate PDF
    try {
      await supabase.functions.invoke("generate-invoice", {
        body: { invoiceId: inv.id },
      });
    } catch (err) {
      logger.error(
        "Failed to regenerate invoice PDF after split sync",
        err instanceof Error ? err : new Error(String(err)),
        { component: "invoiceSync" },
      );
    }
  }
}

/**
 * Find and recalculate all unpaid invoices affected by removed booking IDs.
 * For paid invoices, optionally adds a credit note.
 */
export async function syncInvoicesAfterBookingRemoval(
  removedBookingIds: string[],
  options?: { addCreditNoteToPaid?: boolean },
): Promise<void> {
  if (removedBookingIds.length === 0) return;

  const { data: invoices } = await supabase
    .from("invoices")
    .select("id, invoice_number, status, booking_ids, total, vat_rate, line_items")
    .in("status", ["sent", "pending", "draft"])
    .overlaps("booking_ids", removedBookingIds);

  if (!invoices || invoices.length === 0) return;

  for (const inv of invoices) {
    const overlapping = (inv.booking_ids as string[] || []).filter((id: string) =>
      removedBookingIds.includes(id),
    );
    if (overlapping.length === 0) continue;

    await recalculateInvoiceAfterRemoval(
      {
        id: inv.id,
        booking_ids: inv.booking_ids as string[] || [],
        vat_rate: inv.vat_rate as number || 21,
        line_items: (inv.line_items as any[]) || [],
        status: inv.status as string,
      },
      overlapping,
    );
  }
}
