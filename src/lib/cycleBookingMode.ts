/**
 * Bulk booking-mode + targeted price facades for the academy cyclus overview
 * (docs/technical-debt/MUTATION_BOUNDARY_BACKLOG.md P1-b: the page's direct table writes,
 * moved behind a lib facade that bundles the invoice resync so it cannot be forgotten).
 *
 * Booking mode ("buy slot vs cycle") is a CYCLE-level property:
 *  - `availability_slots.allow_single_booking` is what the public page + cart + booking RPCs
 *    read — the authoritative per-slot flag;
 *  - `cycles.settings.allow_single_booking` seeds future slot generation;
 *  - `cycles.settings.allow_cyclus_booking` (PR #360) gates the whole-series checkout
 *    (GuestBookingDialog via cycles_public + the create-guest-cyclus-payment server guard).
 * setCycleBookingMode writes all three coherently, cycle-wide, future slots only.
 *
 * Direction-aware safety: ENABLING per-seat on a slot that already has an active booking
 * would open `max_participants − 1` phantom seats (the existing booking held the WHOLE
 * court at capacity 1) — those slots are skipped and reported. DISABLING per-seat on a
 * seat-booked slot is safe (capacity becomes 1, occupancy ≥ 1 → the slot simply shows
 * full), so `cyclus_only` flips every future slot.
 */
import { supabase } from '@/lib/supabaseClient';
import { updateCycleSettings } from '@/lib/cycleWrites';
import { syncInvoicesAfterPriceChange } from '@/lib/invoiceSync';
import type { CycleSettings } from '@/lib/cycleTypes';

export type CycleBookingMode = 'both' | 'single_only' | 'single_only_whole_slot' | 'cyclus_only';

export interface BookingModeTarget {
  /** The group's cyclus_id (slots' grouping key — always present). */
  cyclusId: string;
  /** False for orphan groups (slots only, no cycles row → no settings to write). */
  hasCycleRow: boolean;
  /** Display name for failure reporting. */
  name: string;
}

export interface BookingModeResult {
  /** Cycles fully processed (settings and/or slot flips applied). */
  succeeded: number;
  failed: { name: string; reason: string }[];
  /** Future slots left untouched because they hold active bookings (per-seat enable only). */
  skippedBookedSlots: number;
  /** Orphan groups skipped for single_only (no cycles row → the whole-series checkout
   * cannot be blocked, so the mode cannot be honored). */
  skippedOrphans: number;
}

const CHUNK = 500;

function chunked<T>(arr: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += CHUNK) out.push(arr.slice(i, i + CHUNK));
  return out;
}

const reasonOf = (e: unknown): string =>
  e instanceof Error ? e.message : typeof e === 'object' && e && 'message' in e ? String((e as { message: unknown }).message) : String(e);

/**
 * Future slots of a cyclus that currently hold an ACTIVE booking. Predicate mirrors the
 * booking RPCs' occupancy rule: CAPACITY_OCCUPYING_STATUSES (confirmed/pending/
 * pending_approval — see src/lib/lessons.ts, SYNC-bound to the DB) plus a LIVE
 * payment_pending hold (hold_expires_at > now). Hand-rolled here because no frontend
 * helper is hold-aware.
 */
async function occupiedSlotIds(slotIds: string[], nowIso: string): Promise<Set<string>> {
  const occupied = new Set<string>();
  for (const chunk of chunked(slotIds)) {
    const { data, error } = await supabase
      .from('bookings')
      .select('slot_id')
      .in('slot_id', chunk)
      .or(`status.in.(confirmed,pending,pending_approval),and(status.eq.payment_pending,hold_expires_at.gt.${nowIso})`);
    if (error) throw error;
    (data ?? []).forEach((b: { slot_id: string }) => occupied.add(b.slot_id));
  }
  return occupied;
}

/**
 * Apply a booking mode to the selected cycles, CYCLE-WIDE (settings are cycle-level; a
 * per-group slot write would leave one cycle in the mixed state the guest dialog treats
 * as misconfiguration). Resilient: each cycle is independent — one failure never aborts
 * the rest (the academyPlayerBulk pattern).
 */
export async function setCycleBookingMode(
  targets: BookingModeTarget[],
  mode: CycleBookingMode,
): Promise<BookingModeResult> {
  const result: BookingModeResult = { succeeded: 0, failed: [], skippedBookedSlots: 0, skippedOrphans: 0 };
  // Dedupe: multi-trainer cycles produce one group per trainer, but the write is cycle-wide.
  const byCycle = new Map<string, BookingModeTarget>();
  for (const t of targets) if (!byCycle.has(t.cyclusId)) byCycle.set(t.cyclusId, t);

  // single_only_whole_slot sells individual sessions as the ENTIRE slot at full price:
  // allow_single stays FALSE (that's what makes pricing full + capacity 1 everywhere) and
  // the whole_slot_booking flag unlocks the permission gates instead.
  const allowSingle = mode === 'both' || mode === 'single_only';
  const allowCyclus = mode === 'both' || mode === 'cyclus_only';
  const wholeSlot = mode === 'single_only_whole_slot';
  const nowIso = new Date().toISOString();

  // Batch-read every real cycle's settings up front (one round trip).
  const realIds = [...byCycle.values()].filter((t) => t.hasCycleRow).map((t) => t.cyclusId);
  const settingsById = new Map<string, CycleSettings>();
  if (realIds.length > 0) {
    const { data, error } = await supabase.from('cycles').select('id, settings').in('id', realIds);
    if (error) {
      // Without settings nothing can be written coherently — fail everything up front.
      return { ...result, failed: [...byCycle.values()].map((t) => ({ name: t.name, reason: reasonOf(error) })) };
    }
    (data ?? []).forEach((row) => settingsById.set(row.id, ((row.settings as CycleSettings | null) ?? {})));
  }

  for (const target of byCycle.values()) {
    try {
      // An orphan group has no cycles row: the whole-series checkout can't be blocked
      // (the dialog + edge guard default to bookable when settings are absent), so the
      // sessions-only modes cannot be honored — skip entirely rather than half-apply.
      if (!target.hasCycleRow && (mode === 'single_only' || mode === 'single_only_whole_slot')) {
        result.skippedOrphans += 1;
        continue;
      }

      if (target.hasCycleRow) {
        const merged: CycleSettings = {
          ...(settingsById.get(target.cyclusId) ?? {}),
          allow_single_booking: allowSingle,
          allow_cyclus_booking: allowCyclus,
          whole_slot_booking: wholeSlot,
        };
        await updateCycleSettings(target.cyclusId, merged);
      }

      const { skippedBooked } = await applyBookingModeToFutureSlots(
        target.cyclusId,
        { allowSingle, wholeSlot },
        nowIso,
      );
      result.skippedBookedSlots += skippedBooked;

      result.succeeded += 1;
    } catch (e) {
      result.failed.push({ name: target.name, reason: reasonOf(e) });
    }
  }
  return result;
}

export interface SlotBookingModeFlags {
  /** Per-seat selling (price ÷ max_participants, capacity max_participants). */
  allowSingle: boolean;
  /** Whole-slot selling (full price, capacity 1) — only meaningful when allowSingle=false. */
  wholeSlot: boolean;
}

/**
 * Stamp the booking-mode flags on a cycle's FUTURE slots — the slot half of a booking-mode
 * change, shared by the bulk action above and CycleForm's booking controls (which write
 * cycle settings themselves but must not leave existing slots behind — the slot columns are
 * what the public page/cart/booking RPCs actually read).
 *
 * Direction-aware: ENABLING per-seat skips slots holding an active booking (a whole-court
 * booking would otherwise open `max_participants − 1` phantom seats); every other change
 * flips booked slots too (capacity collapses to 1 → the slot simply shows full).
 */
export async function applyBookingModeToFutureSlots(
  cyclusId: string,
  flags: SlotBookingModeFlags,
  nowIso = new Date().toISOString(),
): Promise<{ flipped: number; skippedBooked: number }> {
  const { allowSingle, wholeSlot } = flags;
  // Future slots only: past sessions' booking mode is meaningless, and the guest
  // flows only sell future sessions anyway.
  const { data: slotRows, error: slotErr } = await supabase
    .from('availability_slots')
    .select('id')
    .eq('cyclus_id', cyclusId)
    .gte('start_time', nowIso);
  if (slotErr) throw slotErr;
  let flipIds = (slotRows ?? []).map((s: { id: string }) => s.id);
  let skippedBooked = 0;

  if (allowSingle && flipIds.length > 0) {
    const occupied = await occupiedSlotIds(flipIds, nowIso);
    skippedBooked = flipIds.filter((id) => occupied.has(id)).length;
    flipIds = flipIds.filter((id) => !occupied.has(id));
  }

  for (const chunk of chunked(flipIds)) {
    const { error } = await supabase
      .from('availability_slots')
      // whole_slot_booking is newer than the committed generated types (stale-since-#273
      // convention: no full regen for one column) — cast like insertAvailabilitySlots does.
      .update({ allow_single_booking: allowSingle, whole_slot_booking: wholeSlot } as never)
      .in('id', chunk);
    if (error) throw error;
  }
  return { flipped: flipIds.length, skippedBooked };
}

/**
 * Targeted bulk price write — the exact semantics of the overview page's previous inline
 * handler (characterized in cycleBookingMode.test.ts), now bundled with the invoice resync:
 *  1. push the price onto the SELECTED slots (billing source of truth), 500-chunked;
 *  2. keep each real cycle row's stored price in sync (bare price_per_session write —
 *     NOT updateCyclePricing, which would re-push extra_costs/split/VAT cyclus-wide and
 *     ignore the overview's (cyclus_id, trainer_id) selection granularity);
 *  3. rebuild affected unpaid invoices (default statuses: sent/pending/draft).
 * Empty slotIds → no writes at all (matches the page's early return).
 */
export async function setTargetedCyclePrice(
  slotIds: string[],
  realCycleIds: string[],
  price: number,
): Promise<{ updatedSlots: number }> {
  if (slotIds.length === 0) return { updatedSlots: 0 };
  for (const chunk of chunked(slotIds)) {
    const { error } = await supabase
      .from('availability_slots')
      .update({ price_per_session: price })
      .in('id', chunk);
    if (error) throw error;
  }
  for (const cyclusId of realCycleIds) {
    const { error } = await supabase.from('cycles').update({ price_per_session: price }).eq('id', cyclusId);
    if (error) throw error;
  }
  await syncInvoicesAfterPriceChange(slotIds);
  return { updatedSlots: slotIds.length };
}
