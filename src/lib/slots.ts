import { addMinutes, addWeeks } from 'date-fns';
import { supabase } from '@/lib/supabaseClient';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/integrations/supabase/types';

/**
 * Domain service for availability_slot creation.
 *
 * The bulk slot-generation surfaces (AddSlotDialog / ClubAddSlotDialog /
 * OnboardingStep3Schedule) each re-implemented the same two mechanical steps:
 * expanding a weekly cyclus into its individual session datetimes, and the raw
 * `availability_slots` insert. The recurrence math in particular is easy to get
 * subtly wrong (off-by-one on the week count, wrong end time). Routing both
 * through here gives one tested source of truth and one write point.
 */

export interface SlotSession {
  start: Date;
  end: Date;
}

/**
 * Expand a weekly-recurring cyclus into its individual session datetimes: one
 * `{ start, end }` per week for `recurrenceWeeks` weeks, week 0 being the base
 * start itself, each session `durationMinutes` long.
 *
 * The base start is computed by the CALLER and passed in — the date-picker
 * semantics differ per surface (e.g. onboarding floors to `startOfDay` first,
 * the calendar dialogs don't), so keeping that at the call site makes adopting
 * this helper behaviour-frozen: only the `addWeeks`/`addMinutes` loop moves.
 * `recurrenceWeeks <= 0` yields an empty list.
 */
export function expandWeeklySessions(
  baseStart: Date,
  durationMinutes: number,
  recurrenceWeeks: number,
): SlotSession[] {
  const sessions: SlotSession[] = [];
  for (let week = 0; week < recurrenceWeeks; week++) {
    const start = addWeeks(baseStart, week);
    sessions.push({ start, end: addMinutes(start, durationMinutes) });
  }
  return sessions;
}

/**
 * Insert availability_slot row(s) — the single write point for slot creation.
 *
 * Accepts one row or an array (the bulk dialogs pass arrays). Pass `returning`
 * to get the inserted rows back (e.g. `'id, cyclus_id'`); otherwise only the
 * error is reported. Row shape is intentionally permissive: each surface builds
 * a different column set (court_type / rating / pricing / max_participants …)
 * and the existing call sites already constructed fully-typed literals.
 */
export async function insertAvailabilitySlots(
  rows: Record<string, unknown> | Record<string, unknown>[],
  client: SupabaseClient<Database> = supabase,
  returning?: string,
): Promise<{ data: unknown; error: unknown }> {
  // Canonical (trainer_id, start_time) insert order: the overlap-guard trigger
  // (20260708100000) takes a per-trainer advisory lock per row, so two concurrent
  // multi-trainer batches inserting in OPPOSITE trainer orders could AB/BA-deadlock.
  // A deterministic order makes concurrent batches acquire locks in the same
  // sequence. No caller depends on the returned row order (verified: they match by
  // cyclus_id or consume the set wholesale).
  const sorted = Array.isArray(rows)
    ? [...rows].sort(
        (a, b) =>
          String(a.trainer_id).localeCompare(String(b.trainer_id)) ||
          String(a.start_time).localeCompare(String(b.start_time)),
      )
    : rows;
  const query = client.from('availability_slots').insert(sorted as never);
  if (returning) {
    const { data, error } = await query.select(returning);
    return { data, error: error ?? null };
  }
  const { error } = await query;
  return { data: null, error: error ?? null };
}

/**
 * Set the public/private visibility of slot(s) — the shared write point for the
 * `{ is_public }`-only toggle that was duplicated across the open-slots page,
 * the trainer schedule, and several slot-detail surfaces.
 *
 * Accepts one id or an array (a 1-element `.in('id', [x])` is identical to
 * `.eq('id', x)`). `is_public` is the TARGET value — callers pass the
 * already-flipped value, exactly as the inline updates did. An empty list is a
 * no-op. Only `is_public` is written: surfaces that co-write priority-window /
 * release columns (priorityClaims) deliberately do NOT use this — that write is
 * domain-atomic and stays in its own owner.
 */
export async function setSlotVisibility(
  slotIds: string | string[],
  isPublic: boolean,
  client: SupabaseClient<Database> = supabase,
): Promise<{ error: unknown }> {
  const ids = Array.isArray(slotIds) ? slotIds : [slotIds];
  if (ids.length === 0) return { error: null };
  const { error } = await client.from('availability_slots').update({ is_public: isPublic }).in('id', ids);
  return { error: error ?? null };
}
