// Round-wide editors for a rebook round's post-deadline behaviour, driven from the manage page
// (AcademyRebookManage). Mirrors updateRoundPriorityDeadline (rebookRoundDeadline.ts): the caller
// passes the round's resolved cycleIds, we write cycle settings / slots resiliently (chunked,
// `.select('id')` to count RLS-blocked no-ops, failures accumulated — never thrown mid-loop).
//
// Three knobs:
//  - updateRoundPaymentMode      → how RETURNING players pay (cycles.settings.rebook_payment_mode)
//  - updateRoundPublicOpenMode   → how the PUBLIC pays once sessions open (booking-mode flags + split)
//  - updateRoundReleasePolicy    → whether sessions auto-open at the deadline or stay private
import { supabase } from '@/lib/supabaseClient';
import { updateCycleSettings } from '@/lib/cycleWrites';
import type { CycleSettings } from '@/lib/cycleTypes';
import { applyBookingModeToFutureSlots, cycleBookingModeToFlags, type CycleBookingMode } from '@/lib/cycleBookingMode';
import type { RebookPaymentMode, PublicReleaseStatus } from '@/lib/priorityClaims';

export type ReleasePolicy = 'auto' | 'private';
/** The round's current release stance for the toggle prefill / row display. */
export type ReleasePolicyState = 'auto' | 'private' | 'mixed';

export interface RoundSettingsResult {
  updatedCycles: number;
  updatedSlots: number;
  skippedReleasedSlots: number;
  skippedBookedSlots: number;
  failed: Array<{ ids: string[]; reason: string }>;
}

const CHUNK = 150; // PostgREST .in() URL-length budget — same as rebookRoundDeadline.
const PAGE = 1000; // PostgREST caps a select at ~1000 rows; page anyway.

const emptyResult = (): RoundSettingsResult => ({ updatedCycles: 0, updatedSlots: 0, skippedReleasedSlots: 0, skippedBookedSlots: 0, failed: [] });
const reasonOf = (e: unknown): string =>
  e instanceof Error ? e.message : typeof e === 'object' && e && 'message' in e ? String((e as { message: unknown }).message) : String(e);

/** Read a cycle's current settings so a write can MERGE (updateCycleSettings replaces the column). */
async function readSettings(cycleId: string): Promise<CycleSettings> {
  const { data, error } = await supabase.from('cycles').select('settings').eq('id', cycleId).maybeSingle();
  if (error) throw error;
  return ((data?.settings as CycleSettings | null) ?? {}) as CycleSettings;
}

/**
 * Derive the round's current release stance from its slots' public_release_status (ignoring
 * already-`released` slots, which the policy never touches). 'mixed' when non-released slots
 * disagree — the toggle then defaults to whatever the admin picks.
 */
export function deriveReleasePolicy(statuses: Array<PublicReleaseStatus | null>): ReleasePolicyState {
  let auto = 0, priv = 0;
  for (const s of statuses) {
    if (s === 'released') continue;
    if (s === 'auto_release_scheduled') auto++;
    else if (s === 'held' || s === 'pending_admin_review') priv++;
  }
  if (auto > 0 && priv === 0) return 'auto';
  if (priv > 0 && auto === 0) return 'private';
  if (auto === 0 && priv === 0) return 'auto'; // no policy-bearing slots → default
  return 'mixed';
}

/** How RETURNING players pay when they keep their spot — round-wide on cycles.settings. */
export async function updateRoundPaymentMode(
  cycleIds: string[],
  mode: RebookPaymentMode,
  strictMollie: boolean,
): Promise<RoundSettingsResult> {
  const result = emptyResult();
  for (const cycleId of cycleIds) {
    try {
      const current = await readSettings(cycleId);
      await updateCycleSettings(cycleId, {
        ...current,
        rebook_payment_mode: mode,
        // strict pay-first is only meaningful with upfront (mirrors the edge fn's coupling).
        rebook_strict_mollie: mode === 'upfront' && strictMollie,
      } as CycleSettings);
      result.updatedCycles += 1;
    } catch (e) {
      result.failed.push({ ids: [cycleId], reason: reasonOf(e) });
    }
  }
  return result;
}

/**
 * How the PUBLIC pays once non-rebooked sessions open. Writes the booking-mode flags to each cycle's
 * settings (allow_single/allow_cyclus/whole_slot) + split_payment (the sync_cycle_split_payment_to_slots
 * DB trigger mirrors split to every slot), then stamps allow_single/whole_slot on FUTURE slots via the
 * shared, direction-aware applyBookingModeToFutureSlots (skips booked slots when enabling per-seat —
 * no phantom seats on a held/paid court).
 */
export async function updateRoundPublicOpenMode(
  cycleIds: string[],
  mode: CycleBookingMode,
  split: boolean,
): Promise<RoundSettingsResult> {
  const result = emptyResult();
  const { allowSingle, allowCyclus, wholeSlot } = cycleBookingModeToFlags(mode);
  // whole-court is one payment by definition → split can't apply (mirrors CycleForm's rule).
  const effectiveSplit = wholeSlot ? false : split;
  for (const cycleId of cycleIds) {
    try {
      const current = await readSettings(cycleId);
      await updateCycleSettings(cycleId, {
        ...current,
        allow_single_booking: allowSingle,
        allow_cyclus_booking: allowCyclus,
        whole_slot_booking: wholeSlot,
        split_payment: effectiveSplit,
      } as CycleSettings);
      const { flipped, skippedBooked } = await applyBookingModeToFutureSlots(cycleId, { allowSingle, wholeSlot });
      result.updatedCycles += 1;
      result.updatedSlots += flipped;
      result.skippedBookedSlots += skippedBooked;
    } catch (e) {
      result.failed.push({ ids: [cycleId], reason: reasonOf(e) });
    }
  }
  return result;
}

/** Page every slot of the round (id + release status) so the policy write can exclude released ones. */
async function fetchRoundSlotStatuses(cycleIds: string[]): Promise<{ rows: Array<{ id: string; public_release_status: PublicReleaseStatus | null }>; error: { message?: string } | null }> {
  const rows: Array<{ id: string; public_release_status: PublicReleaseStatus | null }> = [];
  if (cycleIds.length === 0) return { rows, error: null };
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('availability_slots')
      .select('id, public_release_status')
      .in('cyclus_id', cycleIds)
      .order('id')
      .range(from, from + PAGE - 1);
    if (error) return { rows, error };
    const page = (data ?? []) as Array<{ id: string; public_release_status: PublicReleaseStatus | null }>;
    rows.push(...page);
    if (page.length < PAGE) return { rows, error: null };
  }
}

/**
 * Whether the round's sessions auto-open to the public at the deadline ('auto' →
 * `auto_release_scheduled`) or stay private until the admin releases them ('private' → `held`).
 * Applied round-wide, EXCLUDING slots already `released` (don't reverse a deliberate open).
 */
export async function updateRoundReleasePolicy(
  cycleIds: string[],
  policy: ReleasePolicy,
): Promise<RoundSettingsResult> {
  const result = emptyResult();
  const target: PublicReleaseStatus = policy === 'auto' ? 'auto_release_scheduled' : 'held';

  const { rows, error } = await fetchRoundSlotStatuses(cycleIds);
  if (error) {
    result.failed.push({ ids: [], reason: error.message ?? 'read_failed' });
    return result;
  }
  result.skippedReleasedSlots = rows.filter((s) => s.public_release_status === 'released').length;
  // Only touch slots that aren't released and aren't already at the target (idempotent, minimal writes).
  const targetIds = rows.filter((s) => s.public_release_status !== 'released' && s.public_release_status !== target).map((s) => s.id);

  for (let i = 0; i < targetIds.length; i += CHUNK) {
    const chunk = targetIds.slice(i, i + CHUNK);
    const { data, error: upErr } = await supabase
      .from('availability_slots')
      .update({ public_release_status: target })
      .in('id', chunk)
      .select('id');
    if (upErr) {
      result.failed.push({ ids: chunk, reason: upErr.message });
      continue;
    }
    result.updatedSlots += (data ?? []).length; // RLS-blocked no-ops return 0 rows.
  }
  return result;
}
