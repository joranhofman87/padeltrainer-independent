import { supabase } from '@/lib/supabaseClient';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/integrations/supabase/types';

/**
 * Domain owner for the two bespoke invoice writes that live inside the trainer
 * cyclus-edit save (`TrainerScheduleOverview.handleSaveCycleEdit`). The logic is
 * lifted here VERBATIM (behaviour-frozen) so the money rules sit in one tested
 * place and the documented bugs are PINNED by characterization tests BEFORE the
 * separate fix PRs touch them.
 *
 * ⚠️ Both writes carry real money bugs (see docs/audits/TSO_INVOICE_WRITES_AUDIT.md).
 * This extraction deliberately does NOT fix them — it freezes today's behaviour so
 * the subsequent matcher-fix / recalc-replacement PRs have a reviewable money diff.
 * Each known bug is flagged inline with a `BUG …:` marker mirrored by an assertion
 * in `src/test/cycleEditInvoiceSync.pglite.test.ts`.
 */

/** A cycle's pre-existing player/guest booking row, as the merge reads it (no `id`). */
export interface ExistingCycleBookingRow {
  player_id: string | null;
  guest_player_id: string | null;
}

/** A freshly-inserted booking on the newly-added sessions, as the merge reads it. */
export interface CreatedCycleBookingRow {
  id: string;
  player_id: string | null;
  guest_player_id: string | null;
}

export interface MergeNewBookingIdsParams {
  /** The bookings just inserted on the newly-added sessions (DB-generated ids). */
  createdBookings: CreatedCycleBookingRow[];
  /** The cycle's pre-existing player/guest bookings (template rows; carry no id). */
  existingBookings: ExistingCycleBookingRow[];
  /** The ids of the cycle's pre-existing slots (used to find the cycle's invoices). */
  existingSlotIds: string[];
}

/**
 * Write A — append each newly-created session booking's id to the matching unpaid
 * invoice's `booking_ids`, so the line-item quantity bills the added weeks. Runs
 * only when a trainer EXTENDS a running cyclus (`newCount > cycleSlots.length`).
 *
 * ⚠️ BUG A1 (P0 — pinned by the characterization test, NOT fixed here): the
 * player→invoice matcher below is a no-op. The `.find` predicate never references
 * its `_ab` argument and the inner `.some` is a tautology (`eb` always matches
 * itself within `existingBookings`), so `.find` returns `allCycleBookings[0]`
 * every iteration → `ebId` collapses to a single constant id. As a result the new
 * `booking_ids` are MISROUTED: the invoice whose `booking_ids` contains that
 * constant id absorbs EVERY player's new bookings (overcharge), and every other
 * invoice gets none (undercharge). For a single group invoice the constant branch
 * happens to land correct, masking the bug — so it bites the per-player shape.
 * PR-2 replaces this with a real per-player join. See A2/A3 in the audit too
 * (status filter omits `overdue`/uses dead `pending`; not idempotent).
 */
export async function mergeNewBookingIdsIntoCycleInvoices(
  params: MergeNewBookingIdsParams,
  client: SupabaseClient<Database> = supabase,
): Promise<void> {
  const { createdBookings, existingBookings, existingSlotIds } = params;
  if (!createdBookings || createdBookings.length === 0) return;

  // Get all existing booking IDs for this cycle to find invoices
  const { data: allCycleBookings } = await client
    .from('bookings')
    .select('id')
    .in('slot_id', existingSlotIds)
    .in('status', ['confirmed', 'attended', 'pending']);

  const allExistingBookingIds = (allCycleBookings || []).map((b) => b.id);

  const { data: affectedInvoices } = await client
    .from('invoices')
    .select('id, booking_ids')
    .in('status', ['draft', 'sent', 'pending'])
    .overlaps('booking_ids', allExistingBookingIds);

  if (affectedInvoices) {
    for (const inv of affectedInvoices) {
      const currentIds = (inv.booking_ids as string[]) || [];
      // Find which players this invoice covers
      const invExistingBookings = existingBookings.filter((eb) => {
        const ebId = allCycleBookings?.find((_ab) =>
          existingBookings.some((x) => (x.player_id === eb.player_id && x.guest_player_id === eb.guest_player_id)),
        )?.id;
        return ebId && currentIds.includes(ebId);
      });
      // Get new bookings for those same players
      const playerKeys = new Set(invExistingBookings.map((b) => b.player_id || b.guest_player_id));
      const relevantNewIds = createdBookings
        .filter((nb) => playerKeys.has(nb.player_id || nb.guest_player_id))
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
}
