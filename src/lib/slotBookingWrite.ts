import { supabase } from "@/lib/supabaseClient";
import type { SupabaseClient } from "@supabase/supabase-js";
import { CAPACITY_OCCUPYING_STATUSES } from "@/lib/lessons";
import { insertBookings } from "@/lib/bookings";
import {
  buildGuestBookingInsertRow,
  buildRebalanceAmountGroups,
  calculateSlotBookingPricing,
} from "@/lib/bookingPricing";
import { logger } from "@/lib/logger";

/**
 * Shared "book guest(s) into a set of slots" primitive.
 *
 * This is the booking + split-rebalance core that powers BOTH the per-slot
 * "book for the whole cyclus" path in {@link InlineBookPlayer} and the
 * cycle-roster add/swap in {@link addPlayersToCycle}. Keeping it here means the
 * money math (per-slot split pricing + co-occupant rebalance) lives in one place
 * instead of being copy-pasted per caller.
 *
 * It deliberately does NOT touch invoices — the caller runs
 * {@link syncInvoicesAfterAddPlayer} with the returned rows so each UI can own
 * its own "sent/paid invoice" confirmation dialog.
 */

export const INSERTED_BOOKING_SELECT =
  "id, slot_id, guest_player_id, player_id, payment_amount, payment_status, paid_externally";

export interface InsertedBookingRow {
  id: string;
  slot_id: string;
  guest_player_id: string | null;
  player_id: string | null;
  payment_amount: number | null;
  payment_status: string;
  paid_externally: boolean | null;
}

export interface SlotForGuestBooking {
  id: string;
  start_time: string;
  end_time: string;
  price_per_session?: number | null;
}

type ExistingBookingRow = {
  id: string;
  slot_id: string;
  payment_status: string | null;
  paid_externally: boolean | null;
};

export interface InsertGuestsIntoSlotsResult {
  insertedRows: InsertedBookingRow[];
  affectedSlotIds: string[];
  /** A co-occupant rebalance write failed (the bookings still inserted). */
  rebalanceFailed: boolean;
}

/**
 * Re-distribute an existing split among the co-occupants of one slot after a
 * new player joins. Each row keeps its negotiated `discount_amount` and a paid /
 * externally-paid booking is never re-priced. Throws on a write error so the
 * caller can flag a partial rebalance.
 */
export async function rebalanceExistingOnSlot(
  slotId: string,
  rebalanceIds: string[],
  amount: number,
  sessionPriceForOriginal: number,
  client: SupabaseClient = supabase,
): Promise<void> {
  if (rebalanceIds.length === 0) return;

  const { data: existingRows, error: fetchError } = await client
    .from("bookings")
    .select("id, discount_amount")
    .in("id", rebalanceIds);

  if (fetchError) {
    logger.error("Failed to load bookings for rebalance", fetchError, {
      component: "slotBookingWrite",
      slotId,
      rebalanceIds,
    });
    throw fetchError;
  }

  for (const group of buildRebalanceAmountGroups(existingRows ?? [], amount)) {
    const { error } = await client
      .from("bookings")
      .update({
        payment_amount: group.paymentAmount,
        original_amount: sessionPriceForOriginal,
      })
      .in("id", group.bookingIds)
      // Never rewrite an already-settled booking's amount when rebalancing a
      // split — a paid player must keep what they paid.
      .neq("payment_status", "paid")
      .neq("paid_externally", true);

    if (error) {
      logger.error("Failed to rebalance booking amounts", error, {
        component: "slotBookingWrite",
        slotId,
        rebalanceIds: group.bookingIds,
        amount: group.paymentAmount,
      });
      throw error;
    }
  }
}

async function fetchExistingBookingsBySlot(
  slotIds: string[],
  client: SupabaseClient,
): Promise<Map<string, ExistingBookingRow[]>> {
  const { data, error } = await client
    .from("bookings")
    .select("id, slot_id, payment_status, paid_externally")
    .in("slot_id", slotIds)
    .in("status", [...CAPACITY_OCCUPYING_STATUSES]);

  if (error) throw error;

  const bySlot = new Map<string, ExistingBookingRow[]>();
  for (const row of data || []) {
    const list = bySlot.get(row.slot_id) || [];
    list.push(row as ExistingBookingRow);
    bySlot.set(row.slot_id, list);
  }
  return bySlot;
}

/**
 * Insert `guestPlayerIds` into every slot in `slots` (cartesian), pricing each
 * slot on its own session price + current occupancy, then rebalance each slot's
 * existing co-occupants unless `skipRebalance` is set (the "Don't update
 * invoices" toggle). Returns the inserted rows for the caller's invoice sync.
 */
export async function insertGuestsIntoSlots(params: {
  slots: SlotForGuestBooking[];
  guestPlayerIds: string[];
  splitPayment: boolean;
  /** Mirrors "Don't update invoices": skip the co-occupant split rebalance. */
  skipRebalance: boolean;
  notes?: string | null;
  resolveSessionPrice: (slot: SlotForGuestBooking) => number;
  client?: SupabaseClient;
}): Promise<InsertGuestsIntoSlotsResult> {
  const {
    slots,
    guestPlayerIds,
    splitPayment,
    skipRebalance,
    notes = null,
    resolveSessionPrice,
  } = params;
  const client = params.client ?? supabase;

  if (slots.length === 0 || guestPlayerIds.length === 0) {
    return { insertedRows: [], affectedSlotIds: [], rebalanceFailed: false };
  }

  const slotIds = slots.map((s) => s.id);
  const bySlot = await fetchExistingBookingsBySlot(slotIds, client);

  const pricingForSlot = (slot: SlotForGuestBooking) =>
    calculateSlotBookingPricing({
      sessionPrice: resolveSessionPrice(slot),
      splitPayment,
      existingActiveBookingCount: (bySlot.get(slot.id) || []).length,
      newPlayerCount: guestPlayerIds.length,
    });

  const bookingsToInsert = slots.flatMap((slot) => {
    const pricing = pricingForSlot(slot);
    return guestPlayerIds.map((guestPlayerId, playerIndex) =>
      buildGuestBookingInsertRow({
        slotId: slot.id,
        guestPlayerId,
        paymentAmount: pricing.newPlayerAmounts[playerIndex] ?? 0,
        sessionPrice: pricing.sessionPrice,
        notes,
      }),
    );
  });

  const { data: insertedRows, error } = await insertBookings(
    bookingsToInsert,
    client,
    INSERTED_BOOKING_SELECT,
  );
  if (error) throw error;

  let rebalanceFailed = false;
  if (!skipRebalance) {
    for (const slot of slots) {
      const pricing = pricingForSlot(slot);
      if (!pricing.shouldRebalanceExisting || pricing.existingBookingsNewAmount == null) {
        continue;
      }
      const rebalanceIds = (bySlot.get(slot.id) || [])
        .filter((b) => b.payment_status !== "paid" && !b.paid_externally)
        .map((b) => b.id);
      try {
        await rebalanceExistingOnSlot(
          slot.id,
          rebalanceIds,
          pricing.existingBookingsNewAmount,
          pricing.sessionPrice,
          client,
        );
      } catch (rebalanceError) {
        rebalanceFailed = true;
        logger.error(
          "Slot rebalance failed after insert",
          rebalanceError instanceof Error ? rebalanceError : new Error(String(rebalanceError)),
          { component: "slotBookingWrite", slotId: slot.id },
        );
      }
    }
  }

  return {
    insertedRows: (insertedRows as InsertedBookingRow[]) ?? [],
    affectedSlotIds: slotIds,
    rebalanceFailed,
  };
}
