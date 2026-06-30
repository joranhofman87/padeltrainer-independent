import { supabase } from "@/lib/supabaseClient";
import type { SupabaseClient } from "@supabase/supabase-js";
import { CAPACITY_OCCUPYING_STATUSES } from "@/lib/lessons";
import { cancelBookingsAndSync, reconcileBookingInvoices } from "@/lib/bookings";
import {
  syncInvoicesAfterAddPlayer,
  type InvoiceAfterAddPlayerResult,
} from "@/lib/invoiceAfterAddPlayer";
import {
  insertGuestsIntoSlots,
  type InsertedBookingRow,
  type SlotForGuestBooking,
} from "@/lib/slotBookingWrite";
import { logger } from "@/lib/logger";

/**
 * Cycle-wide roster operations for the cycle-detail page ("Spelers in deze
 * cyclus"). These mirror the per-slot add/change/remove flow but apply across
 * EVERY session of the cycle (past + future), so an academy can fix a wrong
 * planning in one action.
 *
 * The "Don't update invoices" toggle threads through as `skipInvoices`:
 *  - true  → bookings change, invoices are left untouched (manual reconcile);
 *  - false → invoices follow.
 */

// A guest may hold at most one booking per slot in these statuses (the M-17
// unique index `uniq_active_booking_per_slot_guest`, 20260612140000). We dedup
// against THIS set — not the narrower capacity allowlist — so a guest with a
// `completed` booking on a past session is treated as already enrolled there
// (and that session is skipped) instead of tripping a unique-violation.
const DEDUP_BOOKING_STATUSES = ["pending", "confirmed", "completed"] as const;
// Fallback when a slot row has no explicit capacity (column default is 4).
const DEFAULT_SLOT_CAPACITY = 4;

interface CycleSlotRow extends SlotForGuestBooking {
  max_participants: number | null;
}

/** Every session of a cycle (no date filter — past + future). */
export async function fetchCycleSlots(
  cycleId: string,
  client: SupabaseClient = supabase,
): Promise<CycleSlotRow[]> {
  const { data, error } = await client
    .from("availability_slots")
    .select("id, start_time, end_time, price_per_session, max_participants")
    .eq("cyclus_id", cycleId)
    .order("start_time");
  if (error) throw error;
  return (data ?? []) as CycleSlotRow[];
}

async function fetchCyclePricing(
  cycleId: string,
  client: SupabaseClient,
): Promise<{ splitPayment: boolean; pricePerSession: number | null }> {
  const { data, error } = await client
    .from("cycles")
    .select("split_payment, price_per_session")
    .eq("id", cycleId)
    .single();
  if (error) throw error;
  return {
    splitPayment: Boolean(data?.split_payment),
    pricePerSession: data?.price_per_session ?? null,
  };
}

export interface AddPlayersToCycleResult {
  insertedCount: number;
  affectedSlotIds: string[];
  rebalanceFailed: boolean;
  invoiceResult: InvoiceAfterAddPlayerResult | null;
  /** Sessions skipped because they were full or the insert was refused (capacity race). */
  blockedSlotIds: string[];
  /** Sessions where the player was already booked (skipped, not an error). */
  alreadyBookedSlotIds: string[];
}

const EMPTY_ADD_RESULT: AddPlayersToCycleResult = {
  insertedCount: 0,
  affectedSlotIds: [],
  rebalanceFailed: false,
  invoiceResult: null,
  blockedSlotIds: [],
  alreadyBookedSlotIds: [],
};

/**
 * Book one or more guest players into EVERY session of a cycle. Inserts are done
 * one session at a time so a single full / already-taken session is skipped and
 * reported (blockedSlotIds / alreadyBookedSlotIds) instead of aborting the whole
 * add — the DB capacity trigger stays the source of truth, the JS pre-checks are
 * just an optimisation. Honours the "Don't update invoices" toggle.
 */
export async function addPlayersToCycle(params: {
  cycleId: string;
  guestPlayerIds: string[];
  skipInvoices?: boolean;
  notes?: string | null;
  client?: SupabaseClient;
}): Promise<AddPlayersToCycleResult> {
  const client = params.client ?? supabase;
  const { cycleId, guestPlayerIds, skipInvoices = false, notes = null } = params;
  if (guestPlayerIds.length === 0) return { ...EMPTY_ADD_RESULT };

  const [slots, pricing] = await Promise.all([
    fetchCycleSlots(cycleId, client),
    fetchCyclePricing(cycleId, client),
  ]);
  if (slots.length === 0) return { ...EMPTY_ADD_RESULT };

  const slotIds = slots.map((s) => s.id);
  // Pull both the dedup-active rows (any of pending/confirmed/completed) and the
  // capacity-occupying rows in one query, then bucket them.
  const { data: existing, error: exErr } = await client
    .from("bookings")
    .select("id, slot_id, guest_player_id, status")
    .in("slot_id", slotIds)
    .in("status", Array.from(new Set([...DEDUP_BOOKING_STATUSES, ...CAPACITY_OCCUPYING_STATUSES])));
  if (exErr) throw exErr;

  const capacityCountBySlot = new Map<string, number>();
  const guestSlotSet = new Set<string>(); // `${slotId}:${guestId}` for dedup-active rows
  const capacityStatuses = new Set<string>(CAPACITY_OCCUPYING_STATUSES);
  const dedupStatuses = new Set<string>(DEDUP_BOOKING_STATUSES);
  for (const b of existing ?? []) {
    if (capacityStatuses.has(b.status)) {
      capacityCountBySlot.set(b.slot_id, (capacityCountBySlot.get(b.slot_id) ?? 0) + 1);
    }
    if (b.guest_player_id && dedupStatuses.has(b.status)) {
      guestSlotSet.add(`${b.slot_id}:${b.guest_player_id}`);
    }
  }

  const resolveSessionPrice = (slot: SlotForGuestBooking) =>
    Number(slot.price_per_session ?? pricing.pricePerSession ?? 0);

  const allInserted: InsertedBookingRow[] = [];
  const affectedSlotIds = new Set<string>();
  const blockedSlotIds = new Set<string>();
  const alreadyBookedSlotIds = new Set<string>();
  let rebalanceFailed = false;

  for (const guestId of guestPlayerIds) {
    for (const slot of slots) {
      if (guestSlotSet.has(`${slot.id}:${guestId}`)) {
        alreadyBookedSlotIds.add(slot.id);
        continue;
      }
      const current = capacityCountBySlot.get(slot.id) ?? 0;
      const max = slot.max_participants ?? DEFAULT_SLOT_CAPACITY;
      if (current >= max) {
        blockedSlotIds.add(slot.id);
        continue;
      }
      try {
        const res = await insertGuestsIntoSlots({
          slots: [slot],
          guestPlayerIds: [guestId],
          splitPayment: pricing.splitPayment,
          skipRebalance: skipInvoices,
          notes,
          resolveSessionPrice,
          client,
        });
        allInserted.push(...res.insertedRows);
        affectedSlotIds.add(slot.id);
        if (res.rebalanceFailed) rebalanceFailed = true;
        // Reflect the new seat + dedup so later guests/slots see it.
        capacityCountBySlot.set(slot.id, current + 1);
        guestSlotSet.add(`${slot.id}:${guestId}`);
      } catch (err) {
        // A single session refusing the insert (full via a concurrent booking, a
        // unique-violation we didn't pre-filter, …) must not abort the rest.
        blockedSlotIds.add(slot.id);
        logger.error("Cycle add: session insert refused, skipping it", err as Error, {
          component: "cycleRoster",
          slotId: slot.id,
        });
      }
    }
  }

  if (allInserted.length > 0) {
    await client.from("guest_players").update({ has_trained: true }).in("id", guestPlayerIds);
  }

  let invoiceResult: InvoiceAfterAddPlayerResult | null = null;
  if (allInserted.length > 0) {
    invoiceResult = await syncInvoicesAfterAddPlayer({
      newBookings: allInserted,
      splitPayment: pricing.splitPayment,
      slotIds: [...affectedSlotIds],
      cyclusId: cycleId,
      skipInvoices,
    });
  }

  return {
    insertedCount: allInserted.length,
    affectedSlotIds: [...affectedSlotIds],
    rebalanceFailed,
    invoiceResult,
    blockedSlotIds: [...blockedSlotIds],
    alreadyBookedSlotIds: [...alreadyBookedSlotIds],
  };
}

export interface SwapPlayerInCycleResult {
  error: unknown | null;
  /** Sessions whose booking was re-pointed from the outgoing to the incoming player. */
  reassignedCount: number;
  /** Sessions where the incoming player was already booked, so the outgoing one was just cancelled. */
  cancelledCollisionCount: number;
  /** Invoice reconcile threw after a successful reassign (bookings ARE swapped). */
  syncFailed: boolean;
}

/**
 * Replace one enrolled player with another across EVERY session of a cycle by
 * re-pointing the outgoing player's bookings to the incoming guest IN PLACE
 * (mirrors the per-slot swap in InlineEditBooking). In-place keeps each
 * booking's amount/paid state, so a non-split payer stays the payer and a paid
 * seat carries to the replacement — no €0 sessions, no orphaned unpaid draft.
 *
 * Sessions where the incoming guest is ALREADY booked can't take a second
 * booking (M-17), so the outgoing player's redundant booking there is cancelled
 * instead. Invoices are reconciled only when `skipInvoices` is false (same as
 * the per-slot swap).
 */
export async function swapPlayerInCycle(params: {
  cycleId: string;
  fromPlayer: { playerId?: string | null; guestPlayerId?: string | null };
  toGuestPlayerId: string;
  skipInvoices?: boolean;
  client?: SupabaseClient;
}): Promise<SwapPlayerInCycleResult> {
  const client = params.client ?? supabase;
  const { cycleId, fromPlayer, toGuestPlayerId, skipInvoices = false } = params;

  if (!fromPlayer.playerId && !fromPlayer.guestPlayerId) {
    return { error: null, reassignedCount: 0, cancelledCollisionCount: 0, syncFailed: false };
  }

  const slots = await fetchCycleSlots(cycleId, client);
  const slotIds = slots.map((s) => s.id);
  if (slotIds.length === 0) {
    return { error: null, reassignedCount: 0, cancelledCollisionCount: 0, syncFailed: false };
  }

  // The outgoing player's swappable bookings (dedup-active) across the cycle.
  let outQuery = client
    .from("bookings")
    .select("id, slot_id")
    .in("slot_id", slotIds)
    .in("status", [...DEDUP_BOOKING_STATUSES]);
  // Match by guest id first: the Change action is guest-initiated, and a linked (account-claimed)
  // guest has BOTH ids on its bookings, so matching by guest_player_id reliably finds all the seats.
  outQuery = fromPlayer.guestPlayerId
    ? outQuery.eq("guest_player_id", fromPlayer.guestPlayerId)
    : outQuery.eq("player_id", fromPlayer.playerId as string);
  const { data: outgoing, error: outErr } = await outQuery;
  if (outErr) return { error: outErr, reassignedCount: 0, cancelledCollisionCount: 0, syncFailed: false };
  if (!outgoing || outgoing.length === 0) {
    return { error: null, reassignedCount: 0, cancelledCollisionCount: 0, syncFailed: false };
  }

  // Sessions where the incoming guest is already booked — a reassign there would
  // collide with M-17, so cancel the outgoing booking on those instead.
  const { data: incoming, error: inErr } = await client
    .from("bookings")
    .select("slot_id")
    .in("slot_id", slotIds)
    .in("status", [...DEDUP_BOOKING_STATUSES])
    .eq("guest_player_id", toGuestPlayerId);
  if (inErr) return { error: inErr, reassignedCount: 0, cancelledCollisionCount: 0, syncFailed: false };
  const incomingSlots = new Set((incoming ?? []).map((b) => b.slot_id));

  const reassignIds = outgoing.filter((b) => !incomingSlots.has(b.slot_id)).map((b) => b.id);
  const collisionIds = outgoing.filter((b) => incomingSlots.has(b.slot_id)).map((b) => b.id);

  let reassignedCount = 0;
  if (reassignIds.length > 0) {
    const { data: updatedRows, error: upErr } = await client
      .from("bookings")
      // Clear any stale profile link so the seat belongs to the incoming guest ONLY. A linked
      // (account-claimed) outgoing guest has player_id backfilled; leaving it set would keep the
      // old person attributed to the booking and make the swap look like a no-op in the UI.
      .update({ guest_player_id: toGuestPlayerId, player_id: null })
      .in("id", reassignIds)
      .select("id");
    if (upErr) return { error: upErr, reassignedCount: 0, cancelledCollisionCount: 0, syncFailed: false };
    reassignedCount = updatedRows?.length ?? 0;
    // An RLS-blocked UPDATE returns no error but changes 0 rows. Don't report a phantom swap — the
    // academy-manager bookings UPDATE policy (20260704120000) must be live for the reassign to persist.
    if (reassignedCount === 0) {
      return {
        error: new Error('No bookings were updated — you may not have permission to change these bookings.'),
        reassignedCount: 0,
        cancelledCollisionCount: 0,
        syncFailed: false,
      };
    }
  }

  let syncFailed = false;

  if (collisionIds.length > 0) {
    const { cancelError, syncError } = await cancelBookingsAndSync(collisionIds, client, {
      skipInvoiceSync: skipInvoices,
    });
    if (cancelError || syncError) {
      // The reassign (the main action) already succeeded; a failed redundant-cancel is surfaced as a
      // "review this" warning rather than failing the whole swap.
      syncFailed = true;
      logger.error("Cycle swap: collision-cancel did not fully complete", (cancelError ?? syncError) as Error, {
        component: "cycleRoster",
        cycleId,
      });
    }
  }

  // Mark the incoming guest trained (the reassigned seats are now theirs).
  if (reassignIds.length > 0) {
    await client.from("guest_players").update({ has_trained: true }).eq("id", toGuestPlayerId);
  }

  if (!skipInvoices && reassignIds.length > 0) {
    try {
      await reconcileBookingInvoices(reassignIds, client);
    } catch (err) {
      syncFailed = true;
      logger.error("Cycle swap: invoice reconcile failed after reassign", err as Error, {
        component: "cycleRoster",
        cycleId,
      });
    }
  }

  return {
    error: null,
    reassignedCount,
    cancelledCollisionCount: collisionIds.length,
    syncFailed,
  };
}
