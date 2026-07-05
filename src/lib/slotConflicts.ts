/**
 * Trainer slot-overlap helpers — the client half of the double-booking guard.
 *
 * A trainer can be on court ONCE per moment. The authoritative guard is the DB
 * trigger (migration 20260708100000: any INSERT/time-UPDATE whose [start,end)
 * range overlaps another slot of the same trainer raises 'trainer_slot_overlap').
 * These helpers exist for the UX layer on top of it:
 *
 *   - `epochRange`/`rangesOverlap`/`splitByOverlap` compare as EPOCHS, never as
 *     strings: PostgREST returns timestamptz as '2026-09-07T09:00:00+00:00' while
 *     Date#toISOString yields '...T09:00:00.000Z' — string comparison silently
 *     never matches (that exact mismatch broke the bulk-create page's dedup).
 *   - `fetchTrainerSlotRanges` reads existing slots PAGINATED (PostgREST caps a
 *     bare select at ~1000 rows — a truncated read would silently let duplicates
 *     through) and bounded to the window that matters.
 *   - `isTrainerSlotOverlapError` recognizes the trigger's refusal so surfaces
 *     can toast a human message instead of a raw Postgres error.
 *
 * Client checks are best-effort (RLS may hide another org's private slots from
 * the reader); the trigger is the backstop that sees ALL rows.
 */
import { supabase } from '@/lib/supabaseClient';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/integrations/supabase/types';

export interface EpochRange {
  startMs: number;
  endMs: number;
}

/** Parse a start/end pair (ISO strings or Dates) into epoch milliseconds. */
export function epochRange(start: string | Date, end: string | Date): EpochRange {
  return {
    startMs: typeof start === 'string' ? new Date(start).getTime() : start.getTime(),
    endMs: typeof end === 'string' ? new Date(end).getTime() : end.getTime(),
  };
}

/** Half-open [start, end) overlap — back-to-back sessions do NOT overlap. */
export function rangesOverlap(a: EpochRange, b: EpochRange): boolean {
  return a.startMs < b.endMs && b.startMs < a.endMs;
}

/**
 * Partition candidates into those free of conflicts vs those overlapping an
 * existing range. O(n·m) — fine at slot-generation scale (dozens × hundreds).
 */
export function splitByOverlap<T>(
  candidates: T[],
  rangeOf: (c: T) => EpochRange,
  existing: EpochRange[],
): { fresh: T[]; skipped: T[] } {
  const fresh: T[] = [];
  const skipped: T[] = [];
  for (const c of candidates) {
    const r = rangeOf(c);
    (existing.some((e) => rangesOverlap(e, r)) ? skipped : fresh).push(c);
  }
  return { fresh, skipped };
}

/**
 * Read the existing [start,end) ranges of the given trainers' slots that could
 * overlap the window [fromIso, toIso), paginated past PostgREST's row cap.
 * The filter is the overlap condition itself (end_time > fromIso AND
 * start_time < toIso), so a long slot straddling the window start is included —
 * a plain `start_time >= fromIso` read would miss it.
 */
export async function fetchTrainerSlotRanges(
  trainerIds: string[],
  fromIso: string,
  toIso: string,
  client: SupabaseClient<Database> = supabase,
): Promise<{ byTrainer: Map<string, EpochRange[]>; error: unknown }> {
  const byTrainer = new Map<string, EpochRange[]>();
  if (trainerIds.length === 0) return { byTrainer, error: null };
  const PAGE = 1000;
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await client
      .from('availability_slots')
      .select('trainer_id, start_time, end_time')
      .in('trainer_id', trainerIds)
      .gt('end_time', fromIso)
      .lt('start_time', toIso)
      .order('start_time', { ascending: true })
      .order('id', { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) return { byTrainer, error };
    const rows = (data ?? []) as { trainer_id: string; start_time: string; end_time: string }[];
    for (const r of rows) {
      const list = byTrainer.get(r.trainer_id) ?? [];
      list.push(epochRange(r.start_time, r.end_time));
      byTrainer.set(r.trainer_id, list);
    }
    if (rows.length < PAGE) break;
  }
  return { byTrainer, error: null };
}

/** True when an error is the DB trigger's 'trainer_slot_overlap' refusal. */
export function isTrainerSlotOverlapError(err: unknown): boolean {
  if (!err) return false;
  const msg = (err as { message?: string }).message ?? String(err);
  return msg.includes('trainer_slot_overlap');
}
