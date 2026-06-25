import { supabase } from '@/lib/supabaseClient';
import type { Cycle } from '@/lib/cycles';

/**
 * What a slot's `cyclus_id` actually points at.
 *
 * The app has historically treated `cyclus_id` as "a real training cycle", but the DB doesn't
 * enforce that (no FK on availability_slots.cyclus_id), so a cyclus_id can reference a
 * registration/event cycle — or, pre-FK, a `cycles` row that doesn't exist (an orphan slot group
 * the academy overview renders as a "cycle"). This classifier makes the distinction explicit so
 * every caller (overview row-click, slot detail, pricing route, end-date editor, rebooking picker)
 * acts on the truth rather than assuming "cyclus_id ⇒ training cycle".
 */
export type CycleIntegrity =
  | { kind: 'training_cycle'; cycle: Cycle }
  | { kind: 'registration'; cycle: Cycle }
  | { kind: 'event'; cycle: Cycle }
  | { kind: 'orphan_slot_group'; cyclusId: string; slotCount: number }
  | { kind: 'missing'; cyclusId: string | null };

export async function classifyCyclusId(cyclusId: string | null | undefined): Promise<CycleIntegrity> {
  if (!cyclusId) return { kind: 'missing', cyclusId: cyclusId ?? null };

  const { data } = await supabase.from('cycles').select('*').eq('id', cyclusId).maybeSingle();
  if (data) {
    const cycle = data as unknown as Cycle;
    if (cycle.type === 'cyclus') return { kind: 'training_cycle', cycle };
    if (cycle.type === 'registration') return { kind: 'registration', cycle };
    return { kind: 'event', cycle };
  }

  // No `cycles` row → either an orphan slot-group (slots reference this id but its parent is gone)
  // or nothing at all.
  const { count } = await supabase
    .from('availability_slots')
    .select('id', { count: 'exact', head: true })
    .eq('cyclus_id', cyclusId);
  if ((count ?? 0) > 0) return { kind: 'orphan_slot_group', cyclusId, slotCount: count ?? 0 };
  return { kind: 'missing', cyclusId };
}

/** Only a real training cycle (type='cyclus') owns slots/bookings and is editable/rebookable as a cycle. */
export function isTrainingCycle(
  i: CycleIntegrity,
): i is Extract<CycleIntegrity, { kind: 'training_cycle' }> {
  return i.kind === 'training_cycle';
}

/** True when the cyclus link is broken (points at no `cycles` row) — render/act defensively. */
export function isBrokenCyclusLink(i: CycleIntegrity): boolean {
  return i.kind === 'orphan_slot_group' || i.kind === 'missing';
}
