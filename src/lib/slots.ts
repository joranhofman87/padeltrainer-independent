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
  const query = client.from('availability_slots').insert(rows as never);
  if (returning) {
    const { data, error } = await query.select(returning);
    return { data, error: error ?? null };
  }
  const { error } = await query;
  return { data: null, error: error ?? null };
}
