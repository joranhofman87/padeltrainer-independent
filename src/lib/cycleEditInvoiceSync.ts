import { supabase } from '@/lib/supabaseClient';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/integrations/supabase/types';

/**
 * Domain owner for the two bespoke invoice writes that live inside the trainer
 * cyclus-edit save (`TrainerScheduleOverview.handleSaveCycleEdit`). Both writes
 * were extracted here verbatim first (behaviour-frozen) so the money rules sit in
 * one tested place; their fixes then land as separate, characterization-backed
 * PRs. See docs/audits/TSO_INVOICE_WRITES_AUDIT.md.
 *  - Write A (`mergeNewBookingIdsIntoCycleInvoices`): bug A1 FIXED (PR-2) — the
 *    player→invoice matcher now routes each player's new bookings to the right
 *    invoice. A2 (status set) / A3 (cross-rerun idempotency) remain open.
 *  - Write B (`recalcCycleInvoiceTotals`): still behaviour-frozen, carries bugs
 *    B1–B5; PR-3 routes it through the canonical pipeline.
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

/** An extra-cost row as the cyclus-edit form holds it (mirrors TSO's local `ExtraCost`). */
export interface CycleEditExtraCost {
  description: string;
  price: number;
  type?: 'per_session' | 'one_time';
  vat_rate?: number;
}

export interface RecalcCycleInvoiceTotalsParams {
  /** The cyclus being saved (its slots → bookings → overlapping unpaid invoices). */
  cyclusId: string;
  /** The cyclus name, used to label the fallback session line (`cycleEditData.name`). */
  cycleName: string;
  /** Per-session price to re-derive line totals from (`null` = leave unit prices as-is). */
  sessionPrice: number | null;
  /** The current cyclus extra costs to rebuild the extra-cost line items from. */
  extraCosts: CycleEditExtraCost[];
  /** Whether the cyclus prices are VAT-inclusive (`cycleEditData.pricesIncludeVat`). */
  pricesIncludeVat: boolean;
}

/**
 * Write B — rebuild `line_items` and overwrite `subtotal / vat_amount / total /
 * vat_breakdown` (+ null `pdf_url`) on every overlapping unpaid invoice. Runs on
 * EVERY cyclus-edit save (including no-op renames). This is the write that sets
 * the total the customer pays.
 *
 * ⚠️ KNOWN BUGS (pinned by the characterization test, NOT fixed here):
 *  - B1 (P0): "first-item-only" session rebuild keeps `line_items[0]` and DROPS
 *    `[1..n]` (the `filter((_item, idx) => idx === 0)`), so per-session invoices
 *    collapse to one week and manual lines/discounts in `[1..n]` are deleted.
 *  - B2 (P0): split count is read from the `(1/N)` description marker ONLY,
 *    ignoring `invoices.split_count` (not even selected) → a structural-split
 *    invoice with no marker text is re-priced at FULL (N× overcharge).
 *  - B3 (P1): the exclusive multi-rate `total` accumulates UNROUNDED per-line VAT
 *    and rounds once, so it diverges from `subtotal + vat_amount` by ~1¢.
 *  - B4 (P1): `vat_breakdown` is only spread when the NEW result is multi-rate, so
 *    a multi→single-rate edit leaves a STALE breakdown on the row.
 *  - B5 (P2): extra-cost builder keys on `type==='per_session'` and omits the
 *    canonical `price<=0`/blank skip.
 * Plus: no `updated_at`/status optimistic lock at the write (TOCTOU). PR-3 deletes
 * this body and routes through the canonical `invoiceCalc`/`invoiceSync` pipeline.
 */
export async function recalcCycleInvoiceTotals(
  params: RecalcCycleInvoiceTotalsParams,
  client: SupabaseClient<Database> = supabase,
): Promise<void> {
  const { cyclusId, cycleName, sessionPrice, extraCosts, pricesIncludeVat } = params;

  const { data: syncSlotIds } = await client
    .from('availability_slots')
    .select('id')
    .eq('cyclus_id', cyclusId);

  if (syncSlotIds && syncSlotIds.length > 0) {
    const syncSlotIdList = syncSlotIds.map((s) => s.id);
    const { data: syncBookings } = await client
      .from('bookings')
      .select('id')
      .in('slot_id', syncSlotIdList)
      .neq('status', 'cancelled');

    if (syncBookings && syncBookings.length > 0) {
      const syncBookingIdList = syncBookings.map((b) => b.id);

      const { data: matchingUnpaidInvoices } = await client
        .from('invoices')
        .select('id, booking_ids, line_items, vat_rate, status')
        .in('status', ['draft', 'sent', 'pending', 'overdue'])
        .overlaps('booking_ids', syncBookingIdList);

      if (matchingUnpaidInvoices && matchingUnpaidInvoices.length > 0) {
        for (const inv of matchingUnpaidInvoices) {
          const existingItems = (inv.line_items as any[]) || [];
          const bookingCount = (inv.booking_ids as string[])?.length || 1;

          // Detect split count from existing line items (e.g. "(1/2)" → 2)
          let splitCount = 1;
          for (const item of existingItems) {
            const splitMatch = item.description?.match(/\(1\/(\d+)\)/);
            if (splitMatch) { splitCount = parseInt(splitMatch[1], 10); break; }
          }

          const baseSessionItems = existingItems.filter(
            (_item: any, idx: number) => idx === 0,
          );

          const sessionItems = (baseSessionItems.length > 0
            ? baseSessionItems
            : [{
              description: `${cycleName.trim()} (${bookingCount} weken)`,
              quantity: bookingCount,
              unit_price: sessionPrice ?? 0,
            }]
          ).map((item: any) => {
            if (sessionPrice !== null) {
              const splitPrice = splitCount > 1
                ? Math.round((sessionPrice / splitCount) * 100) / 100
                : sessionPrice;
              return {
                ...item,
                unit_price: splitPrice,
                amount: (item.quantity ?? 1) * splitPrice,
              };
            }
            return item;
          });

          // Build extra cost line items from current cycle settings
          const extraCostItems = extraCosts.map((ec: any) => {
            const isPerSession = ec.type === "per_session";
            const bookingCount = (inv.booking_ids as string[])?.length || 1;
            let ecPrice = ec.price;
            if (splitCount > 1) {
              ecPrice = Math.round((ecPrice / splitCount) * 100) / 100;
            }
            const ecDesc = `${ec.description}${isPerSession ? " (per sessie)" : ""}`;
            return {
              description: splitCount > 1 ? `${ecDesc} (1/${splitCount})` : ecDesc,
              quantity: isPerSession ? bookingCount : 1,
              unit_price: ecPrice,
              amount: ecPrice * (isPerSession ? bookingCount : 1),
              vat_rate: ec.vat_rate ?? inv.vat_rate ?? 21,
            };
          });

          const updatedItems = [...sessionItems, ...extraCostItems];

          // Recalculate totals
          const vatRate = inv.vat_rate || 21;
          const pricesIncVat = pricesIncludeVat;

          // Check for multi-rate VAT
          const rates = updatedItems.map((it: any) => it.vat_rate ?? vatRate);
          const hasMultiRate = new Set(rates).size > 1;

          let subtotal = 0;
          let vatAmount = 0;
          let total = 0;
          const vatBreakdown: Record<number, { subtotal: number; vat: number }> = {};

          for (const item of updatedItems) {
            const lineTotal = item.quantity * item.unit_price;
            const lineVatRate = item.vat_rate ?? vatRate;

            let lineSub: number;
            let lineVat: number;
            if (pricesIncVat) {
              lineSub = lineTotal / (1 + lineVatRate / 100);
              lineVat = lineTotal - lineSub;
            } else {
              lineSub = lineTotal;
              lineVat = lineTotal * (lineVatRate / 100);
            }

            subtotal += lineSub;
            vatAmount += lineVat;
            total += pricesIncVat ? lineTotal : lineTotal + lineVat;

            if (hasMultiRate) {
              if (!vatBreakdown[lineVatRate]) {
                vatBreakdown[lineVatRate] = { subtotal: 0, vat: 0 };
              }
              vatBreakdown[lineVatRate].subtotal += lineSub;
              vatBreakdown[lineVatRate].vat += lineVat;
            }
          }

          // Round breakdown values
          for (const rate in vatBreakdown) {
            vatBreakdown[rate].subtotal = Math.round(vatBreakdown[rate].subtotal * 100) / 100;
            vatBreakdown[rate].vat = Math.round(vatBreakdown[rate].vat * 100) / 100;
          }

          const { error: invRecalcErr } = await client
            .from('invoices')
            .update({
              line_items: updatedItems,
              subtotal: Math.round(subtotal * 100) / 100,
              vat_amount: Math.round(vatAmount * 100) / 100,
              total: Math.round(total * 100) / 100,
              ...(Object.keys(vatBreakdown).length > 0 ? { vat_breakdown: vatBreakdown } : {}),
              pdf_url: null,
            })
            .eq('id', inv.id);
          if (invRecalcErr) throw invRecalcErr;
        }
      }
    }
  }
}
