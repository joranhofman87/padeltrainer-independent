import { supabase } from "@/lib/supabaseClient";
import { logger } from "@/lib/logger";
import { applyAffectedInvoiceUpdates } from "@/lib/applyAffectedInvoiceUpdates";
import type { AffectedInvoicesClassification } from "@/lib/affectedInvoices";
import { buildAffectedInvoicesSummary } from "@/lib/affectedInvoices";
import type { InvoiceUpdateChoice } from "@/lib/invoiceUpdateChoice";
import {
  splitAmongPlayersForInvoiceCreate,
  type BookingWithSlotPrice,
} from '@/lib/invoiceSplitPricing';
import { resolveSplitDivisor } from '@/lib/splitDivisor';

export type AddPlayerBookingRow = {
  id: string;
  guest_player_id?: string | null;
  player_id?: string | null;
  payment_amount: number | null;
  payment_status: string;
  paid_externally?: boolean | null;
  slot_id?: string;
};

export type InvoiceAfterAddPlayerInput = {
  newBookings: AddPlayerBookingRow[];
  splitPayment: boolean;
  slotIds: string[];
  cyclusId?: string | null;
  /** How to recalc existing invoices on affected slots (default: drafts only). */
  invoiceUpdateChoice?: InvoiceUpdateChoice;
  /**
   * When true, perform NO invoice work at all — no new draft creation AND no
   * recalc of existing invoices. The booking insert already happened at the call
   * site, so the player is added but every invoice is left untouched. For the
   * deliberate "Don't update invoices" roster edit. (Note: `invoiceUpdateChoice:
   * "skip"` only skips the EXISTING-invoice recalc, NOT new-draft creation — this
   * flag skips both.)
   */
  skipInvoices?: boolean;
};

export type InvoiceAfterAddPlayerResult = {
  created: number;
  /** Total skipped count (non-chargeable bookings + benign auto-create skips). */
  skipped: number;
  failed: number;
  /** Chargeable recipient groups that invoked auto-create-invoice. */
  invoiceCreateAttempts: number;
  /** auto-create returned skipped/deduped (not an error). */
  invoiceCreateSkipped: number;
  /** Bookings excluded from invoice creation (€0, paid, etc.). */
  nonChargeableBookings: number;
  /** Whether UI should prompt before updating sent/pending invoices. */
  needsConfirmation: boolean;
  classification: AffectedInvoicesClassification;
  paidUnchangedCount: number;
  draftsRecalculated: boolean;
  sentRecalculated: boolean;
};

export type RecipientBookingGroup = {
  recipientKey: string;
  guestPlayerId: string | null;
  playerId: string | null;
  bookingIds: string[];
};

type AutoCreateInvoiceResponse = {
  success?: boolean;
  skipped?: boolean;
  deduped?: boolean;
  incompleteBusinessProfile?: boolean;
  reason?: string;
  error?: string;
};

/** Bookings eligible for draft invoice creation after add-player. */
export function isChargeableAddPlayerBooking(booking: AddPlayerBookingRow): boolean {
  const amount = booking.payment_amount ?? 0;
  if (amount <= 0) return false;
  if (booking.payment_status === "paid") return false;
  if (booking.paid_externally === true) return false;
  return true;
}

/** Group chargeable bookings by guest_player_id or player_id. */
export function groupChargeableBookingsByRecipient(
  bookings: AddPlayerBookingRow[],
): RecipientBookingGroup[] {
  const map = new Map<string, RecipientBookingGroup>();

  for (const booking of bookings) {
    if (!isChargeableAddPlayerBooking(booking)) continue;

    const guestPlayerId = booking.guest_player_id ?? null;
    const playerId = booking.player_id ?? null;
    const recipientKey = guestPlayerId
      ? `guest:${guestPlayerId}`
      : playerId
        ? `player:${playerId}`
        : null;

    if (!recipientKey) continue;

    const existing = map.get(recipientKey);
    if (existing) {
      existing.bookingIds.push(booking.id);
    } else {
      map.set(recipientKey, {
        recipientKey,
        guestPlayerId,
        playerId,
        bookingIds: [booking.id],
      });
    }
  }

  return Array.from(map.values());
}

export function buildAutoCreateInvoicePayload(
  bookingIds: string[],
  splitAmongPlayers: number | null,
  bookingsForSplit?: BookingWithSlotPrice[],
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    bookingIds,
    asDraft: true,
  };
  const effectiveSplit = bookingsForSplit
    ? splitAmongPlayersForInvoiceCreate(bookingsForSplit, splitAmongPlayers)
    : splitAmongPlayers;
  if (effectiveSplit != null && effectiveSplit > 1) {
    body.splitAmongPlayers = effectiveSplit;
  }
  return body;
}

/**
 * G5: the split divisor for these slots = the cycle's COURT CAPACITY (frozen), i.e.
 * MAX(max_participants). NOT the live participant count — so a draft created here
 * matches the charge path + recalc_cycle_split_count and never drifts. Returns 1 (no
 * split) on error or capacity ≤ 1.
 */
export async function resolveSplitDivisorForSlots(slotIds: string[]): Promise<number> {
  if (slotIds.length === 0) return 1;

  const { data, error } = await supabase
    .from("availability_slots")
    .select("max_participants")
    .in("id", slotIds);

  if (error) {
    logger.warn("Failed to read slot capacity for invoice split", {
      component: "invoiceAfterAddPlayer",
      error: error.message,
    });
    return 1;
  }

  return resolveSplitDivisor((data || []) as { max_participants?: number | null }[]);
}

async function invokeAutoCreateDraftInvoice(
  bookingIds: string[],
  splitAmongPlayers: number | null,
  bookingsForSplit?: BookingWithSlotPrice[],
): Promise<"created" | "skipped" | "failed"> {
  try {
    const { data, error } = await supabase.functions.invoke("auto-create-invoice", {
      body: buildAutoCreateInvoicePayload(bookingIds, splitAmongPlayers, bookingsForSplit),
    });

    if (error) {
      logger.warn("auto-create-invoice invoke error", {
        component: "invoiceAfterAddPlayer",
        message: error.message,
        bookingIds,
      });
      return "failed";
    }

    const result = (data ?? {}) as AutoCreateInvoiceResponse;

    if (result.error) {
      logger.warn("auto-create-invoice returned error", {
        component: "invoiceAfterAddPlayer",
        error: result.error,
        bookingIds,
      });
      return "failed";
    }

    if (result.skipped || result.deduped) {
      return "skipped";
    }

    if (result.success) {
      return "created";
    }

    return "failed";
  } catch (err) {
    logger.warn("auto-create-invoice exception", {
      component: "invoiceAfterAddPlayer",
      error: err instanceof Error ? err.message : String(err),
      bookingIds,
    });
    return "failed";
  }
}

/**
 * Create draft invoices for new chargeable bookings and recalc affected existing invoices.
 * Drafts recalc automatically; sent/pending require confirmation unless choice includes them.
 */
export async function syncInvoicesAfterAddPlayer(
  input: InvoiceAfterAddPlayerInput,
): Promise<InvoiceAfterAddPlayerResult> {
  const choice = input.invoiceUpdateChoice ?? "update_drafts_only";
  const result: InvoiceAfterAddPlayerResult = {
    created: 0,
    skipped: 0,
    failed: 0,
    invoiceCreateAttempts: 0,
    invoiceCreateSkipped: 0,
    nonChargeableBookings: 0,
    needsConfirmation: false,
    classification: {
      draftInvoiceIds: [],
      sentOrPendingInvoiceIds: [],
      paidInvoiceIds: [],
      cancelledInvoiceIds: [],
    },
    paidUnchangedCount: 0,
    draftsRecalculated: false,
    sentRecalculated: false,
  };

  // Deliberate "Don't update invoices" roster edit: the booking(s) were already
  // inserted by the caller; create no draft and recalc nothing — invoices untouched.
  if (input.skipInvoices) return result;

  const chargeable = input.newBookings.filter(isChargeableAddPlayerBooking);
  const nonChargeableCount = input.newBookings.length - chargeable.length;
  result.nonChargeableBookings = nonChargeableCount;
  result.skipped += nonChargeableCount;

  const groups = groupChargeableBookingsByRecipient(input.newBookings);
  result.invoiceCreateAttempts = groups.length;

  let splitAmongPlayers: number | null = null;
  if (input.splitPayment && input.slotIds.length > 0) {
    const divisor = await resolveSplitDivisorForSlots(input.slotIds);
    if (divisor > 1) {
      splitAmongPlayers = divisor;
    }
  }

  for (const group of groups) {
    const groupBookings = chargeable.filter((b) => group.bookingIds.includes(b.id));
    const bookingsForSplit: BookingWithSlotPrice[] = groupBookings.map((b) => ({
      payment_amount: b.payment_amount,
    }));
    const outcome = await invokeAutoCreateDraftInvoice(
      group.bookingIds,
      splitAmongPlayers,
      bookingsForSplit,
    );
    if (outcome === "created") result.created += 1;
    else if (outcome === "skipped") {
      result.invoiceCreateSkipped += 1;
      result.skipped += 1;
    } else result.failed += 1;
  }

  if (input.slotIds.length > 0) {
    const updateResult = await applyAffectedInvoiceUpdates(input.slotIds, choice);
    result.classification = updateResult.classification;
    result.draftsRecalculated = updateResult.draftsRecalculated;
    result.sentRecalculated = updateResult.sentRecalculated;
    result.needsConfirmation = updateResult.needsConfirmation;
    result.paidUnchangedCount = updateResult.paidUnchangedCount;
  }

  const summary = buildAffectedInvoicesSummary(result.classification);
  if (summary.requiresConfirmation && choice === "update_drafts_only") {
    result.needsConfirmation = true;
  }

  return result;
}

export type InvoiceFollowUpMessages = {
  paidUnchanged?: string;
  sentNotUpdated?: string;
  sentUpdated?: string;
};

/** User-facing follow-up copy after invoice sync (caller shows toasts). */
export function getInvoiceFollowUpMessages(
  result: InvoiceAfterAddPlayerResult,
  options?: { sentWasUpdated?: boolean },
): InvoiceFollowUpMessages {
  const messages: InvoiceFollowUpMessages = {};
  if (result.paidUnchangedCount > 0) {
    messages.paidUnchanged = "Paid invoices were not changed.";
  }
  const sentCount = result.classification.sentOrPendingInvoiceIds.length;
  if (options?.sentWasUpdated && sentCount > 0) {
    messages.sentUpdated = "Sent invoices were updated.";
  } else if (result.needsConfirmation && sentCount > 0) {
    messages.sentNotUpdated = "Sent invoices were not updated.";
  }
  return messages;
}

/** Apply admin choice after confirmation dialog (sent/pending recalc only). */
export async function applyAddPlayerInvoiceChoice(
  slotIds: string[],
  choice: InvoiceUpdateChoice,
): Promise<Pick<InvoiceAfterAddPlayerResult, "sentRecalculated" | "paidUnchangedCount" | "classification">> {
  const updateResult = await applyAffectedInvoiceUpdates(slotIds, choice);
  return {
    sentRecalculated: updateResult.sentRecalculated,
    paidUnchangedCount: updateResult.paidUnchangedCount,
    classification: updateResult.classification,
  };
}
