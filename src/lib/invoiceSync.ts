/**
 * Shared invoice recalculation utility.
 * Used by DeleteSlotDialog, TrainerScheduleOverview, TrainerBookings and the
 * slot-detail pages when bookings are removed/cancelled or prices change.
 *
 * Concurrency model: every write re-reads the invoice row first and guards the
 * UPDATE with `.eq("updated_at", <read value>)`. The `update_invoices_updated_at`
 * trigger bumps `updated_at` on every write, so a concurrent edit makes the
 * guard match zero rows; we then re-read and retry once before giving up.
 */
import { supabase } from "@/lib/supabaseClient";
import { logger } from "@/lib/logger";
import {
  detectSplitCount,
  calculateVatTotals,
  applySplit,
} from "@/lib/invoiceCalc";

// "overdue" is a valid STORED status (invoices_status_check) and overdue
// invoices are still unpaid — they must recalc like sent/pending ones
// (applyAffectedInvoiceUpdates explicitly passes it).
const UNPAID_SYNC_STATUSES = ["sent", "pending", "draft", "overdue"];
const MAX_INVOICE_UPDATE_ATTEMPTS = 2;

// Type alias (not interface) so it keeps an implicit index signature and stays
// assignable to the Json column type of the typed Supabase client.
type SyncLineItem = {
  description: string;
  quantity: number;
  unit_price: number;
  vat_rate?: number;
  date?: string;
};

type InvoiceUpdatePayload = {
  status?: string;
  booking_ids?: string[];
  line_items?: SyncLineItem[];
  subtotal?: number;
  vat_amount?: number;
  total?: number;
  pdf_url?: string | null;
  vat_breakdown?: Record<number, { subtotal: number; vat: number }> | null;
  notes?: string;
};

interface InvoiceState {
  id: string;
  booking_ids: string[];
  vat_rate: number;
  line_items: { description?: string }[];
  status: string;
  updated_at: string;
  /** M-33 structural divisor; NULL on legacy invoices (regex fallback). */
  split_count: number | null;
}

interface SlotJoin {
  price_per_session: number | null;
  cyclus_id: string | null;
  cyclus_name: string | null;
  start_time: string;
  locations: { name: string | null } | null;
  prices_include_vat: boolean | null;
  extra_costs: ExtraCostEntry[] | null;
}

interface BookingWithSlot {
  id: string;
  payment_amount: number | null;
  availability_slots: SlotJoin;
}

type ExtraCostEntry = {
  description?: string;
  price?: number;
  type?: string;
  vat_rate?: number;
};

const BOOKING_WITH_SLOT_SELECT = `
  id, payment_amount,
  availability_slots!inner(price_per_session, cyclus_id, cyclus_name, start_time, locations(name), prices_include_vat, extra_costs)
`;

/** What happened to a single invoice during a sync pass. */
export type InvoiceRecalcOutcome =
  | "updated" // totals rebuilt and written
  | "cancelled" // all bookings removed — invoice cancelled
  | "noop" // invoice missing, or no billable bookings found
  | "skipped"; // invoice is no longer unpaid (e.g. paid mid-flight) — left untouched

export interface BookingRemovalSyncResult {
  /**
   * Invoice numbers that reference removed bookings but were left untouched
   * because the invoice is (or became) paid. Callers should surface these so
   * the trainer knows the paid invoice no longer matches its bookings.
   */
  skippedPaidInvoiceNumbers: string[];
}

export interface SyncBookingPrice {
  paymentAmount: number | null | undefined;
  slotPrice: number | null | undefined;
}

export function hasExplicitPaymentAmount(b: SyncBookingPrice): boolean {
  return b.paymentAmount != null && Number(b.paymentAmount) > 0;
}

/**
 * Resolve the final per-booking unit price for an invoice rebuild.
 *
 * A booking's payment_amount is the AUTHORITATIVE per-player charge for that
 * session (already a split share when split, or the full price when not) and
 * must NEVER be re-divided. Only the slot-price fallback (used when
 * payment_amount is absent) is the *full* session price that still needs
 * dividing by splitCount. The split decision is made per booking — never
 * collectively — so a mix of explicit and fallback amounts can no longer drag
 * the explicit amounts through the division (M-21).
 */
export function resolveFinalBookingPrices(
  bookings: SyncBookingPrice[],
  splitCount: number,
): number[] {
  return bookings.map((b) => {
    if (hasExplicitPaymentAmount(b)) return Number(b.paymentAmount);
    return applySplit(b.slotPrice || 0, splitCount);
  });
}

async function fetchInvoiceState(invoiceId: string): Promise<InvoiceState | null> {
  const { data, error } = await supabase
    .from("invoices")
    .select("id, booking_ids, vat_rate, line_items, status, updated_at, split_count")
    .eq("id", invoiceId)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  return {
    id: data.id as string,
    booking_ids: (data.booking_ids as string[]) || [],
    vat_rate: (data.vat_rate as number) || 21,
    line_items:
      (data.line_items as unknown as { description?: string }[]) || [],
    status: data.status as string,
    updated_at: data.updated_at as string,
    split_count: (data.split_count as number | null) ?? null,
  };
}

/**
 * Apply an invoice update guarded on the row's last-read updated_at.
 * Returns false when the guard matched zero rows (concurrent modification).
 * Throws on database errors instead of swallowing them (M-36).
 */
async function applyGuardedInvoiceUpdate(
  invoiceId: string,
  expectedUpdatedAt: string,
  payload: InvoiceUpdatePayload,
): Promise<boolean> {
  const { data, error } = await supabase
    .from("invoices")
    .update(payload)
    .eq("id", invoiceId)
    .eq("updated_at", expectedUpdatedAt)
    .select("id");

  if (error) throw error;
  return (data ?? []).length > 0;
}

/**
 * Read-recalculate-write with one retry on optimistic-concurrency conflict.
 * Fresh state is read on every attempt so the recalculation is always based
 * on the same row version the updated_at guard checks against.
 */
async function withOptimisticRetry(
  invoiceId: string,
  apply: (state: InvoiceState) => Promise<"updated" | "cancelled" | "noop" | "conflict">,
): Promise<InvoiceRecalcOutcome> {
  for (let attempt = 1; attempt <= MAX_INVOICE_UPDATE_ATTEMPTS; attempt++) {
    const state = await fetchInvoiceState(invoiceId);
    if (!state) return "noop";
    if (!UNPAID_SYNC_STATUSES.includes(state.status)) return "skipped";

    const outcome = await apply(state);
    if (outcome !== "conflict") return outcome;
  }

  throw new Error(
    `Invoice ${invoiceId} was modified concurrently; recalculation was not applied`,
  );
}

async function regenerateInvoicePdf(invoiceId: string): Promise<void> {
  try {
    await supabase.functions.invoke("generate-invoice", {
      body: { invoiceId },
    });
  } catch (err) {
    logger.error(
      "Failed to regenerate invoice PDF",
      err instanceof Error ? err : new Error(String(err)),
      { component: "invoiceSync" },
    );
  }
}

async function resolveExtraCosts(
  cyclusId: string | null,
  slotExtraCosts: ExtraCostEntry[] | null,
): Promise<ExtraCostEntry[]> {
  if (cyclusId) {
    const { data: cycleData, error } = await supabase
      .from("cycles")
      .select("settings")
      .eq("id", cyclusId)
      .maybeSingle();

    // A swallowed failure here would silently drop billable extra-cost lines.
    if (error) throw error;

    const fromSettings = (
      cycleData?.settings as { extra_costs?: ExtraCostEntry[] } | null
    )?.extra_costs;
    if (Array.isArray(fromSettings) && fromSettings.length > 0) {
      return fromSettings;
    }
  }

  return Array.isArray(slotExtraCosts) ? slotExtraCosts : [];
}

function appendExtraCostLineItems(
  lineItems: SyncLineItem[],
  extraCosts: ExtraCostEntry[],
  splitCount: number,
  sessionCount: number,
  defaultVatRate: number,
): void {
  for (const ec of extraCosts) {
    const price = ec.price ?? 0;
    if (!ec.description || price <= 0) continue;

    const isOneTime = ec.type === "one_time";
    // Extra costs are stored as full (unsplit) prices, so dividing by the
    // split count is always correct here — unlike booking payment_amount.
    const ecPrice = applySplit(price, splitCount);
    const ecDesc = isOneTime ? ec.description : `${ec.description} (per sessie)`;
    lineItems.push({
      description: splitCount > 1 ? `${ecDesc} (1/${splitCount})` : ecDesc,
      quantity: isOneTime ? 1 : sessionCount,
      unit_price: ecPrice,
      vat_rate: ec.vat_rate ?? defaultVatRate,
    });
  }
}

/**
 * One guarded recalculation pass for an invoice after bookings were removed.
 */
async function applyRemovalRecalculation(
  state: InvoiceState,
  removedBookingIds: string[],
): Promise<"updated" | "cancelled" | "noop" | "conflict"> {
  const remainingBookingIds = state.booking_ids.filter(
    (id) => !removedBookingIds.includes(id),
  );

  if (remainingBookingIds.length === 0) {
    // All bookings removed — mark invoice as cancelled
    const applied = await applyGuardedInvoiceUpdate(state.id, state.updated_at, {
      status: "cancelled",
      booking_ids: [],
      line_items: [],
      subtotal: 0,
      vat_amount: 0,
      total: 0,
      pdf_url: null,
      vat_breakdown: null,
      notes: "Factuur geannuleerd — alle sessies zijn verwijderd",
    });
    return applied ? "cancelled" : "conflict";
  }

  // Fetch remaining bookings with slot details
  const { data: bookingRows, error: bookingsError } = await supabase
    .from("bookings")
    .select(BOOKING_WITH_SLOT_SELECT)
    .in("id", remainingBookingIds);

  if (bookingsError) throw bookingsError;

  const remainingBookings = (bookingRows ?? []) as unknown as BookingWithSlot[];
  if (remainingBookings.length === 0) return "noop";

  // M-33: structural divisor on new invoices; legacy invoices (NULL) fall
  // back to the "(1/N)" marker in line-item descriptions.
  const splitCount = state.split_count ?? detectSplitCount(state.line_items);
  const firstSlot = remainingBookings[0].availability_slots;
  const sharedCyclusId = firstSlot.cyclus_id;
  const allSameCyclus =
    !!sharedCyclusId &&
    remainingBookings.every(
      (b) => b.availability_slots.cyclus_id === sharedCyclusId,
    );
  const defaultVatRate = state.vat_rate || 21;

  // Final per-booking prices: explicit payment_amount kept as-is, slot-price
  // fallback divided by the split count (per booking — see M-21 note above).
  const finalPrices = resolveFinalBookingPrices(
    remainingBookings.map((b) => ({
      paymentAmount: b.payment_amount,
      slotPrice: b.availability_slots.price_per_session,
    })),
    splitCount,
  );

  // Build session line items
  let lineItems: SyncLineItem[];

  if (allSameCyclus) {
    const cyclusName = firstSlot.cyclus_name || "Training cyclus";

    // Consolidate only when the FINAL per-booking prices agree, so a mixed
    // explicit/fallback set with equal raw prices can no longer collapse the
    // explicit amounts through the division.
    const nonZeroPrices = finalPrices.filter((p) => p > 0);
    const allSamePrice =
      nonZeroPrices.length > 0 &&
      nonZeroPrices.every((p) => p === nonZeroPrices[0]);

    if (allSamePrice) {
      const pricePerSession = nonZeroPrices[0];
      const desc =
        splitCount > 1
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
      lineItems = remainingBookings.map((b, i) => {
        const bSlot = b.availability_slots;
        const startTime = new Date(bSlot.start_time);
        const locationName = bSlot.locations?.name || "";
        const base = `${cyclusName} - ${startTime.toLocaleDateString("nl-NL")} ${startTime.toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" })}${locationName ? ` (${locationName})` : ""}`;
        return {
          description: splitCount > 1 ? `${base} (1/${splitCount})` : base,
          quantity: 1,
          unit_price: finalPrices[i],
          date: startTime.toISOString().split("T")[0],
        };
      });
    }
  } else {
    lineItems = remainingBookings.map((b, i) => {
      const bSlot = b.availability_slots;
      const startTime = new Date(bSlot.start_time);
      const locationName = bSlot.locations?.name || "";
      let desc = bSlot.cyclus_name
        ? `${bSlot.cyclus_name} - ${startTime.toLocaleDateString("nl-NL")} ${startTime.toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" })}${locationName ? ` (${locationName})` : ""}`
        : `Training sessie - ${startTime.toLocaleDateString("nl-NL")}`;
      if (splitCount > 1 && !hasExplicitPaymentAmount({
        paymentAmount: b.payment_amount,
        slotPrice: bSlot.price_per_session,
      })) {
        desc = `${desc} (1/${splitCount})`;
      }
      return {
        description: desc,
        quantity: 1,
        unit_price: finalPrices[i],
        date: startTime.toISOString().split("T")[0],
      };
    });
  }

  // Add extra costs from cycle settings, fall back to slot extra_costs
  const extraCosts = await resolveExtraCosts(sharedCyclusId, firstSlot.extra_costs);
  appendExtraCostLineItems(
    lineItems,
    extraCosts,
    splitCount,
    remainingBookings.length,
    defaultVatRate,
  );

  // Calculate VAT (multi-rate aware)
  const slotPricesIncludeVat = firstSlot.prices_include_vat ?? true;
  const totals = calculateVatTotals(lineItems, defaultVatRate, slotPricesIncludeVat);

  const applied = await applyGuardedInvoiceUpdate(state.id, state.updated_at, {
    booking_ids: remainingBookingIds,
    line_items: lineItems,
    subtotal: totals.subtotal,
    vat_amount: totals.vatAmount,
    total: totals.total,
    pdf_url: null,
    vat_breakdown:
      Object.keys(totals.vatBreakdown).length > 0 ? totals.vatBreakdown : null,
  });
  if (!applied) return "conflict";

  await regenerateInvoicePdf(state.id);
  return "updated";
}

/**
 * Recalculate an unpaid invoice after bookings have been removed.
 * Handles split payments, multi-rate VAT, and pdf_url reset.
 *
 * The invoice state (booking_ids, line_items, …) is re-read from the database
 * for the optimistic-concurrency guard, so only `invoice.id` is used here;
 * the wider object is accepted for caller compatibility.
 */
export async function recalculateInvoiceAfterRemoval(
  invoice: { id: string },
  removedBookingIds: string[],
): Promise<InvoiceRecalcOutcome> {
  return withOptimisticRetry(invoice.id, (state) =>
    applyRemovalRecalculation(state, removedBookingIds),
  );
}

/**
 * Recalculate unpaid invoices after slot price changes.
 * Finds invoices with bookings on the given slots and rebuilds totals.
 */
const DEFAULT_PRICE_SYNC_STATUSES = ["sent", "pending", "draft"];

export async function syncInvoicesAfterPriceChange(
  slotIds: string[],
  options?: { statuses?: string[] },
): Promise<void> {
  if (slotIds.length === 0) return;

  const statuses = options?.statuses ?? DEFAULT_PRICE_SYNC_STATUSES;

  // Find bookings on these slots
  const { data: bookings, error: bookingsError } = await supabase
    .from("bookings")
    .select("id, slot_id, payment_amount")
    .in("slot_id", slotIds)
    .in("status", ["confirmed", "pending"]);

  if (bookingsError) throw bookingsError;
  if (!bookings || bookings.length === 0) return;

  const bookingIds = bookings.map((b) => b.id);

  // Find invoices overlapping with these bookings (status filter configurable)
  const { data: invoices, error: invoicesError } = await supabase
    .from("invoices")
    .select("id, status, booking_ids")
    .in("status", statuses)
    .overlaps("booking_ids", bookingIds);

  if (invoicesError) throw invoicesError;
  if (!invoices || invoices.length === 0) return;

  // Full recalculate with zero removed bookings: forces a rebuild of line
  // items from current slot/booking data.
  for (const inv of invoices) {
    await recalculateInvoiceAfterRemoval({ id: inv.id }, []);
  }
}

/**
 * One guarded rebuild pass for a split-cycle invoice with a new player count.
 */
async function applySplitRebuild(
  state: InvoiceState,
  playerCount: number,
): Promise<"updated" | "noop" | "conflict"> {
  const { data: bookingRows, error: bookingsError } = await supabase
    .from("bookings")
    .select(BOOKING_WITH_SLOT_SELECT)
    .in("id", state.booking_ids)
    .in("status", ["confirmed", "pending"]);

  if (bookingsError) throw bookingsError;

  const invBookings = (bookingRows ?? []) as unknown as BookingWithSlot[];
  if (invBookings.length === 0) return "noop";

  const defaultVatRate = state.vat_rate || 21;
  const firstSlot = invBookings[0].availability_slots;
  const slotPricesIncludeVat = firstSlot.prices_include_vat ?? true;
  const cyclusName = firstSlot.cyclus_name || "Training cyclus";

  // Divisor: prefer the authoritative split_count written by
  // recalc_cycle_split_count (under a per-cycle lock); fall back to the passed
  // count. This is what makes concurrent split-cycle joins race-safe — the count
  // is no longer a stale client value.
  const splitCount = state.split_count ?? playerCount;

  // The split count itself changed, so per-player shares are re-derived from
  // the base (unsplit) slot price by design — payment_amount still reflects
  // the OLD share here and cannot be reused.
  const basePrice = firstSlot.price_per_session || 0;
  const splitPrice = applySplit(basePrice, splitCount);

  const lineItems: SyncLineItem[] = [
    {
      description: `${cyclusName} (${invBookings.length} weken) (1/${splitCount})`,
      quantity: invBookings.length,
      unit_price: splitPrice,
    },
  ];

  const extraCosts = await resolveExtraCosts(
    firstSlot.cyclus_id,
    firstSlot.extra_costs,
  );
  appendExtraCostLineItems(
    lineItems,
    extraCosts,
    splitCount,
    invBookings.length,
    defaultVatRate,
  );

  const totals = calculateVatTotals(lineItems, defaultVatRate, slotPricesIncludeVat);

  const applied = await applyGuardedInvoiceUpdate(state.id, state.updated_at, {
    line_items: lineItems,
    subtotal: totals.subtotal,
    vat_amount: totals.vatAmount,
    total: totals.total,
    split_count: splitCount,
    pdf_url: null,
    vat_breakdown:
      Object.keys(totals.vatBreakdown).length > 0 ? totals.vatBreakdown : null,
  });
  if (!applied) return "conflict";

  await regenerateInvoicePdf(state.id);
  return "updated";
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

  // 1. Authoritative, race-safe divisor: the RPC takes a per-cycle advisory
  // lock, recounts unique active players, and writes split_count onto every
  // unpaid sibling invoice. The rebuild below reads that split_count, so
  // concurrent joins can no longer stamp a stale 1/N. Returns 0 for a
  // non-split cycle / when no split is needed.
  const { data: playerCount, error: rpcError } = await supabase.rpc(
    "recalc_cycle_split_count",
    { _cyclus_id: cyclusId },
  );
  if (rpcError) throw rpcError;
  if (!playerCount || playerCount <= 1) return;

  // 2. Locate the active bookings → the unpaid sibling invoices to rebuild.
  const { data: cycleSlots, error: slotsError } = await supabase
    .from("availability_slots")
    .select("id")
    .eq("cyclus_id", cyclusId);

  if (slotsError) throw slotsError;
  if (!cycleSlots || cycleSlots.length === 0) return;

  const slotIds = cycleSlots.map((s) => s.id);

  const { data: activeBookings, error: activeBookingsError } = await supabase
    .from("bookings")
    .select("id")
    .in("slot_id", slotIds)
    .in("status", ["confirmed", "pending"]);

  if (activeBookingsError) throw activeBookingsError;
  if (!activeBookings || activeBookings.length === 0) return;

  const activeBookingIds = activeBookings.map((b) => b.id);

  // 3. Find all unpaid invoices overlapping with these bookings
  const { data: invoices, error: invoicesError } = await supabase
    .from("invoices")
    .select("id, booking_ids, status")
    .in("status", UNPAID_SYNC_STATUSES)
    .overlaps("booking_ids", activeBookingIds);

  if (invoicesError) throw invoicesError;
  if (!invoices || invoices.length === 0) return;

  // 4. For each invoice, rebuild with the new split count
  for (const inv of invoices) {
    const invBookingIds = (inv.booking_ids as string[]) || [];
    // Only process if this invoice actually overlaps with active bookings
    const relevantIds = invBookingIds.filter((id) =>
      activeBookingIds.includes(id),
    );
    if (relevantIds.length === 0) continue;

    await withOptimisticRetry(inv.id, (state) =>
      applySplitRebuild(state, playerCount),
    );
  }
}

/**
 * Find and recalculate all unpaid invoices affected by removed booking IDs.
 *
 * Paid invoices are NEVER rewritten here — there is no credit-note mechanism
 * (see audit M-38), so the previous `addCreditNoteToPaid` option was dead code
 * and has been removed. Instead, paid invoices that reference the removed
 * bookings are returned in `skippedPaidInvoiceNumbers` so callers can warn the
 * trainer that those invoices no longer match their bookings.
 */
export async function syncInvoicesAfterBookingRemoval(
  removedBookingIds: string[],
): Promise<BookingRemovalSyncResult> {
  const result: BookingRemovalSyncResult = { skippedPaidInvoiceNumbers: [] };
  if (removedBookingIds.length === 0) return result;

  const { data: invoices, error } = await supabase
    .from("invoices")
    .select("id, invoice_number, status, booking_ids")
    .in("status", [...UNPAID_SYNC_STATUSES, "paid"])
    .overlaps("booking_ids", removedBookingIds);

  if (error) throw error;
  if (!invoices || invoices.length === 0) return result;

  for (const inv of invoices) {
    const overlapping = ((inv.booking_ids as string[]) || []).filter(
      (id: string) => removedBookingIds.includes(id),
    );
    if (overlapping.length === 0) continue;

    if (inv.status === "paid") {
      result.skippedPaidInvoiceNumbers.push(inv.invoice_number as string);
      continue;
    }

    const outcome = await recalculateInvoiceAfterRemoval(
      { id: inv.id },
      overlapping,
    );
    // The invoice was unpaid when queried but paid by the time we rewrote it.
    if (outcome === "skipped") {
      result.skippedPaidInvoiceNumbers.push(inv.invoice_number as string);
    }
  }

  return result;
}
