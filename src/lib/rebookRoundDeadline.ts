// Round-wide priority-deadline read + edit for the rebook manage page.
//
// A rebook round's deadline (`availability_slots.priority_window_ends_at`) is stamped at SEND
// time as `now + priorityWindowDays·24h` — the wizard only takes a days count. This module gives
// the academy full control afterwards: show the round's deadline and move it to an exact
// date + time. Every gate (tier resolver, slotPhase, claim page) reads the timestamps LIVE, so
// an edit takes effect immediately.
//
// Two rules make the edit safe:
//  • Slots the academy already RELEASED to the public are excluded — extending must never
//    resurrect a deliberately opened-up group. Lapsed-but-unreleased slots (natural lapse,
//    "end now", "open to members now") ARE included: extending after a lapse is the use case.
//  • Expired claims on the updated slots are REVIVED (status 'expired' → 'pending',
//    responded_at cleared — the expire cron's exact inverse, mirroring
//    release_expired_rebook_holds). This is load-bearing, not cosmetic:
//    resolve_slot_booking_tier only yields the 'priority' tier while a pending|claimed claim
//    exists, so extending the timestamp WITHOUT reviving would leave a lapsed slot open to
//    members/public despite the new deadline. Genuine "no" answers are untouched (manager-freed
//    seats and player declines are status 'declined'; a revived claim with a recorded decline
//    intent still reads as declined in the outcome summary).
import { supabase } from '@/lib/supabaseClient';

export interface DeadlineSlotRow {
  id: string;
  priority_window_ends_at: string | null;
  member_window_starts_at: string | null;
  member_window_ends_at: string | null;
  public_release_status: string | null;
}

export interface RoundDeadlineSummary {
  /** The round's headline deadline: the LATEST priority end among NON-released slots
   *  ("the round is open until …"). Null when the round has no editable slots. */
  deadline: string | null;
  /** True when non-released slots disagree (minute precision) — "varies per group". */
  varies: boolean;
  /** How many slots an edit would touch (non-released). 0 disables the editor. */
  editableSlotCount: number;
}

/** Minute-truncated epoch, so second/millisecond jitter between slots doesn't read as "varies". */
const minuteKey = (iso: string): number => Math.floor(new Date(iso).getTime() / 60_000);

export function summariseRoundDeadline(slots: DeadlineSlotRow[]): RoundDeadlineSummary {
  const editable = slots.filter((s) => s.public_release_status !== 'released');
  const ends = editable
    .map((s) => s.priority_window_ends_at)
    .filter((v): v is string => !!v);
  if (ends.length === 0) return { deadline: null, varies: false, editableSlotCount: editable.length };
  let latest = ends[0];
  const distinct = new Set<number>();
  for (const iso of ends) {
    distinct.add(minuteKey(iso));
    if (new Date(iso).getTime() > new Date(latest).getTime()) latest = iso;
  }
  return { deadline: latest, varies: distinct.size > 1, editableSlotCount: editable.length };
}

export interface WindowTargetBatch {
  ids: string[];
  patch: {
    priority_window_ends_at: string;
    member_window_starts_at: string | null;
    member_window_ends_at: string | null;
  };
}

/**
 * Per-slot target windows for a new deadline, grouped into identical-patch batches.
 * Released slots are excluded. The member window keeps the invariant the engine writes at
 * creation (`member_window_starts_at === priority_window_ends_at`) and keeps each slot's
 * member DURATION: member end = newEnd + max(0, old member end − old priority end). A round
 * created in one run shares one window tuple, so this normally yields a single batch.
 */
export function computeWindowTargets(slots: DeadlineSlotRow[], newEndIso: string): WindowTargetBatch[] {
  const newEndMs = new Date(newEndIso).getTime();
  const batches = new Map<string, WindowTargetBatch>();
  for (const s of slots) {
    if (s.public_release_status === 'released') continue;
    let memberEnd: string | null = null;
    if (s.member_window_ends_at) {
      const oldPriorityMs = s.priority_window_ends_at ? new Date(s.priority_window_ends_at).getTime() : newEndMs;
      const duration = Math.max(0, new Date(s.member_window_ends_at).getTime() - oldPriorityMs);
      memberEnd = new Date(newEndMs + duration).toISOString();
    }
    const patch = {
      priority_window_ends_at: new Date(newEndMs).toISOString(),
      member_window_starts_at: s.member_window_starts_at ? new Date(newEndMs).toISOString() : null,
      member_window_ends_at: memberEnd,
    };
    const key = `${patch.member_window_starts_at}|${patch.member_window_ends_at}`;
    const batch = batches.get(key);
    if (batch) batch.ids.push(s.id);
    else batches.set(key, { ids: [s.id], patch });
  }
  return [...batches.values()];
}

export interface UpdateRoundDeadlineResult {
  updatedSlots: number;
  skippedReleasedSlots: number;
  revivedClaims: number;
  /** Batches that failed to write (retryable — targets are absolute, a retry converges). */
  failed: Array<{ ids: string[]; reason: string }>;
}

// PostgREST encodes .in() ids in the URL — chunk to stay well under URL-length limits
// (the member-open notifier uses 200; slots + claims here use the same order of magnitude).
const CHUNK = 150;

// PostgREST silently caps a select at ~1000 rows; rounds are ~300 slots but page anyway.
// Local copy (not rebookManage's fetchAllPages) so this module and rebookManage don't form
// an import cycle — rebookManage imports summariseRoundDeadline from here.
const PAGE = 1000;
async function fetchAllSlotPages(cycleIds: string[]): Promise<{ rows: DeadlineSlotRow[]; error: { message?: string } | null }> {
  const rows: DeadlineSlotRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('availability_slots')
      .select('id, priority_window_ends_at, member_window_starts_at, member_window_ends_at, public_release_status')
      .in('cyclus_id', cycleIds)
      .order('id')
      .range(from, from + PAGE - 1);
    if (error) return { rows, error };
    const page = (data ?? []) as unknown as DeadlineSlotRow[];
    rows.push(...page);
    if (page.length < PAGE) return { rows, error: null };
  }
}

/**
 * Move the round's priority deadline to `newEndIso` (a future UTC instant) on every
 * non-released slot of the round, shift member windows along, then revive expired claims on
 * the updated slots. Slots first, claims second: with a future deadline in place the expire
 * cron can never re-expire what we revive. Per-chunk failures are collected, never thrown
 * mid-loop (saveRebookRoundTexts pattern) — the dialog keeps itself open for a retry.
 */
export async function updateRoundPriorityDeadline(
  cycleIds: string[],
  newEndIso: string,
): Promise<UpdateRoundDeadlineResult> {
  const result: UpdateRoundDeadlineResult = { updatedSlots: 0, skippedReleasedSlots: 0, revivedClaims: 0, failed: [] };
  if (cycleIds.length === 0) return result;

  const { rows: slots, error: readError } = await fetchAllSlotPages(cycleIds);
  if (readError) {
    result.failed.push({ ids: [], reason: readError.message ?? 'read_failed' });
    return result;
  }
  result.skippedReleasedSlots = slots.filter((s) => s.public_release_status === 'released').length;

  const updatedSlotIds: string[] = [];
  for (const batch of computeWindowTargets(slots, newEndIso)) {
    for (let i = 0; i < batch.ids.length; i += CHUNK) {
      const chunk = batch.ids.slice(i, i + CHUNK);
      const { data, error } = await supabase
        .from('availability_slots')
        .update(batch.patch)
        .in('id', chunk)
        .select('id');
      if (error) {
        result.failed.push({ ids: chunk, reason: error.message });
        continue;
      }
      const ids = (data ?? []).map((r) => r.id as string);
      // RLS-blocked UPDATEs return no error but change 0 rows — count what actually persisted.
      result.updatedSlots += ids.length;
      updatedSlotIds.push(...ids);
    }
  }

  for (let i = 0; i < updatedSlotIds.length; i += CHUNK) {
    const chunk = updatedSlotIds.slice(i, i + CHUNK);
    const { data, error } = await supabase
      .from('slot_priority_claims')
      .update({ status: 'pending', responded_at: null })
      .in('slot_id', chunk)
      .eq('status', 'expired')
      .select('id');
    if (error) {
      result.failed.push({ ids: chunk, reason: error.message });
      continue;
    }
    result.revivedClaims += (data ?? []).length;
  }

  return result;
}
