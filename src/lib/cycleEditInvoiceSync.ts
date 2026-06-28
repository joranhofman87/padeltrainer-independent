import { supabase } from '@/lib/supabaseClient';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/integrations/supabase/types';
import { syncInvoicesAfterPriceChange } from '@/lib/invoiceSync';

/**
 * Domain owner for the two bespoke invoice writes that live inside the trainer
 * cyclus-edit save (`TrainerScheduleOverview.handleSaveCycleEdit`). Both writes
 * were extracted here verbatim first (behaviour-frozen) so the money rules sit in
 * one tested place; their fixes then land as separate, characterization-backed
 * PRs. See docs/audits/TSO_INVOICE_WRITES_AUDIT.md.
 *  - Write A (`mergeNewBookingIdsIntoCycleInvoices`): bug A1 FIXED (PR-2) — the
 *    player→invoice matcher now routes each player's new bookings to the right
 *    invoice. A2 (status set) / A3 (cross-rerun idempotency) remain open.
 *  - Write B (`syncInvoicesAfterCycleEdit`): bugs B1–B5 + the TOCTOU FIXED (PR-3)
 *    — the bespoke recalc is gone; it now delegates to the canonical
 *    `syncInvoicesAfterPriceChange` resync (the same path every other cycle
 *    price/extra-cost edit uses).
 */

/** A freshly-inserted booking on the newly-added sessions, as the merge reads it. */
export interface CreatedCycleBookingRow {
  id: string;
  player_id: string | null;
  guest_player_id: string | null;
}

export interface MergeNewBookingIdsParams {
  /** The bookings just inserted on the newly-added sessions (DB-generated ids). */
  createdBookings: CreatedCycleBookingRow[];
  /** The ids of the cycle's pre-existing slots (used to find the cycle's invoices). */
  existingSlotIds: string[];
}

/**
 * Write A — append each newly-created session booking's id to the matching unpaid
 * invoice's `booking_ids`, so the line-item quantity bills the added weeks. Runs
 * only when a trainer EXTENDS a running cyclus (`newCount > cycleSlots.length`).
 *
 * Routing (bug A1 fix, PR-2): each existing booking is read WITH its player, so an
 * invoice's `booking_ids` resolve to the exact players it already bills; a player's
 * new bookings are appended ONLY to the invoice(s) covering that player. A
 * per-player invoice gets just that player's added week; a group invoice covering
 * several players gets all of theirs. (The previous matcher was a no-op that routed
 * every player's new ids to whichever invoice held `allCycleBookings[0]`.)
 *
 * Still open (NOT in this PR's scope): A2 — the unpaid-status set here
 * (`draft/sent/pending`) omits `overdue` and carries the dead `pending`; aligning
 * it to the canonical set is a flagged owner decision. A3 — a full re-run of the
 * cyclus edit mints fresh booking UUIDs the `Set` dedup can't collapse (needs the
 * whole save to be transactional/idempotent).
 */
export async function mergeNewBookingIdsIntoCycleInvoices(
  params: MergeNewBookingIdsParams,
  client: SupabaseClient<Database> = supabase,
): Promise<void> {
  const { createdBookings, existingSlotIds } = params;
  if (!createdBookings || createdBookings.length === 0) return;

  // Read the cycle's existing bookings WITH their player, so each booking id maps
  // to the player it bills — the join the old matcher lacked.
  const { data: allCycleBookings } = await client
    .from('bookings')
    .select('id, player_id, guest_player_id')
    .in('slot_id', existingSlotIds)
    .in('status', ['confirmed', 'attended', 'pending']);

  const bookingIdToPlayerKey = new Map<string, string>();
  for (const b of allCycleBookings ?? []) {
    const key = b.player_id || b.guest_player_id;
    if (key) bookingIdToPlayerKey.set(b.id, key);
  }
  const allExistingBookingIds = [...bookingIdToPlayerKey.keys()];
  if (allExistingBookingIds.length === 0) return;

  const { data: affectedInvoices } = await client
    .from('invoices')
    .select('id, booking_ids')
    .in('status', ['draft', 'sent', 'pending'])
    .overlaps('booking_ids', allExistingBookingIds);

  for (const inv of affectedInvoices ?? []) {
    const currentIds = (inv.booking_ids as string[]) || [];
    // The players this invoice already bills (among this cycle's bookings).
    const invPlayerKeys = new Set(
      currentIds.map((id) => bookingIdToPlayerKey.get(id)).filter((k): k is string => Boolean(k)),
    );
    if (invPlayerKeys.size === 0) continue;

    // Append exactly those players' new bookings — and no other player's.
    const relevantNewIds = createdBookings
      .filter((nb) => {
        const key = nb.player_id || nb.guest_player_id;
        return !!key && invPlayerKeys.has(key);
      })
      .map((nb) => nb.id);

    if (relevantNewIds.length > 0) {
      // Dedup the merge so a duplicate booking UUID can't inflate the quantity.
      const { error: invIdsErr } = await client
        .from('invoices')
        .update({ booking_ids: [...new Set([...currentIds, ...relevantNewIds])], pdf_url: null })
        .eq('id', inv.id);
      if (invIdsErr) throw invIdsErr;
    }
  }
}

/** The canonical unpaid set both cyclus-edit writes target (owner-confirmed): drops the
 *  dead `pending`, includes `overdue`. `syncInvoicesAfterPriceChange`'s own default omits
 *  `overdue`, so it must be passed explicitly. */
const CYCLE_EDIT_UNPAID_STATUSES = ['sent', 'draft', 'overdue'];

/**
 * Write B — re-derive line items + totals for a cyclus's unpaid invoices after a
 * price / extra-cost / length edit. Delegates to the canonical cycle resync
 * {@link syncInvoicesAfterPriceChange} — the SAME path CycleDetailView and the
 * slot-detail price edits use — which rebuilds ALL line items from the real
 * bookings (`buildCycleLineItems`/`calculateVatTotals`), reads the authoritative
 * `invoices.split_count`, and writes through the guarded optimistic lock. This
 * replaces the former bespoke recalc that carried bugs B1–B5 + a TOCTOU.
 *
 * Contract — the CALLER (TSO) must, BEFORE calling:
 *  1. gate this to an actual price/extra-cost/length change (a benign rename must
 *     NOT re-derive every overlapping invoice); and
 *  2. ensure the cycle's slots AND `cycles.settings.extra_costs` carry the fresh
 *     values — the canonical extra-cost resolver reads `settings.extra_costs` in
 *     preference to the slot value, so a stale settings entry would otherwise win.
 */
export async function syncInvoicesAfterCycleEdit(cyclusId: string): Promise<void> {
  if (!cyclusId) return;

  const { data: slots } = await supabase
    .from('availability_slots')
    .select('id')
    .eq('cyclus_id', cyclusId);

  const slotIds = (slots ?? []).map((s) => s.id);
  if (slotIds.length === 0) return;

  await syncInvoicesAfterPriceChange(slotIds, { statuses: CYCLE_EDIT_UNPAID_STATUSES });
}
