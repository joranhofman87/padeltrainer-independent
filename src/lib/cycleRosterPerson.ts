// Phase 3.1 (person-unification): whole-PERSON roster actions.
//
// A merged human's roster entry spans EVERY old-world ref they hold seats under (bookings are
// still written old-world until cluster 3.3), so Remove/Change must cover ALL refs — anything
// less leaves half the person silently seated. These wrappers iterate the entry's refs over the
// existing old-world write libs and aggregate the results; the write semantics themselves are
// unchanged.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/integrations/supabase/types';
import type { PersonRef } from '@/lib/personIdentity';
import { cancelPlayerBookingsInCycle } from '@/lib/bookings';
import { swapPlayerInCycle, type SwapPlayerInCycleResult } from '@/lib/cycleRoster';
import type { CycleRosterEntry } from '@/lib/cycleDetail';

/** The entry's refs, falling back to its primary XOR pair (unstamped legacy entries). */
export function refsOfEntry(entry: Pick<CycleRosterEntry, 'refs' | 'playerId' | 'guestPlayerId'>): PersonRef[] {
  if (entry.refs.length > 0) return entry.refs;
  const ref = { playerId: entry.playerId, guestPlayerId: entry.guestPlayerId } as PersonRef;
  return ref.playerId || ref.guestPlayerId ? [ref] : [];
}

/**
 * Picker exclusion keys for a roster entry — BOTH sides of a merged person (it has a `g_` and a
 * `p_` picker row until the 3.2 person-dedup), so neither can be picked as their own replacement.
 */
export function pickerExcludeKeysFor(
  entry: Pick<CycleRosterEntry, 'refs' | 'playerId' | 'guestPlayerId'>,
): string[] {
  return refsOfEntry(entry)
    .map((r) => (r.guestPlayerId ? `g_${r.guestPlayerId}` : r.playerId ? `p_${r.playerId}` : ''))
    .filter(Boolean);
}

export interface RemovePersonResult {
  cancelledCount: number;
  /** First sync error encountered (cancellations themselves all succeeded). */
  syncError: unknown | null;
}

/** Cancel a person's bookings across the cycle — once per old-world ref. Throws on cancel errors. */
export async function removePersonFromCycle(
  slotIds: string[],
  entry: Pick<CycleRosterEntry, 'refs' | 'playerId' | 'guestPlayerId'>,
  client: SupabaseClient<Database>,
  opts: { skipInvoiceSync?: boolean; declineClaims?: boolean } = {},
): Promise<RemovePersonResult> {
  let cancelledCount = 0;
  let syncError: unknown | null = null;
  for (const ref of refsOfEntry(entry)) {
    const res = await cancelPlayerBookingsInCycle(
      slotIds,
      { playerId: ref.playerId, guestPlayerId: ref.guestPlayerId },
      client,
      opts,
    );
    if (res.cancelError) throw res.cancelError;
    if (res.syncError && !syncError) syncError = res.syncError;
    cancelledCount += res.cancelledCount;
  }
  return { cancelledCount, syncError };
}

export interface SwapPersonResult {
  reassignedCount: number;
  cancelledCollisionCount: number;
  syncFailed: boolean;
}

/**
 * Swap a person out of the cycle — one swap per old-world ref, same incoming person each time.
 * A later call whose slot the incoming person already occupies (a merged person's duplicate seat)
 * resolves through swap's existing collision handling.
 */
export async function swapPersonInCycle(args: {
  cycleId: string;
  fromEntry: Pick<CycleRosterEntry, 'refs' | 'playerId' | 'guestPlayerId'>;
  toGuestPlayerId: string;
  toProfileId?: string | null;
  skipInvoices?: boolean;
}): Promise<SwapPersonResult> {
  let reassignedCount = 0;
  let cancelledCollisionCount = 0;
  let syncFailed = false;
  for (const ref of refsOfEntry(args.fromEntry)) {
    const res: SwapPlayerInCycleResult = await swapPlayerInCycle({
      cycleId: args.cycleId,
      fromPlayer: { playerId: ref.playerId, guestPlayerId: ref.guestPlayerId },
      toGuestPlayerId: args.toGuestPlayerId,
      toProfileId: args.toProfileId,
      skipInvoices: args.skipInvoices,
    });
    if (res.error) throw res.error;
    reassignedCount += res.reassignedCount;
    cancelledCollisionCount += res.cancelledCollisionCount;
    syncFailed = syncFailed || res.syncFailed;
  }
  return { reassignedCount, cancelledCollisionCount, syncFailed };
}
