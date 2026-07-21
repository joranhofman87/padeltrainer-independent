// Player booking cutoff — the check for PUBLIC/GUEST self-booking edge functions.
//
// Registered players are already covered without any edge-function work: can_book_slot() carries
// the cutoff, and it is called by the bookings trigger, by book_slot_for_payment, and by
// create-mollie-payment's pre-check. GUESTS are the gap — book_guest_*_for_payment take no user
// id, so they never reach can_book_slot — which is why these three flows check explicitly.
//
// The tenant is read SERVER-SIDE from the slot inside the RPC; callers pass slot ids only.
// Time comes from the database clock, never the request.
//
// CYCLES/CARTS: any single slot inside its cutoff blocks the whole purchase. Selling someone
// four sessions and silently dropping the one that starts tomorrow would be worse than refusing.

// Structural, not the SDK's SupabaseClient: a remote `import type` from esm.sh drags this file
// into the browser tsconfig graph as soon as a vitest test imports it, and tsc cannot resolve
// URL specifiers. Callers pass `supabase as unknown as CutoffCheckClient`.
export interface CutoffCheckClient {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>;
}

export type CutoffCheckResult =
  | { ok: true }
  /** At least one slot is inside its cutoff — refuse the purchase. */
  | { ok: false; reason: 'booking_cutoff'; slotId: string }
  /** The RPC is genuinely absent (deploy order). Caller should proceed but alert loudly. */
  | { ok: true; degraded: 'rpc_missing'; detail: string };

/** A missing function, as opposed to a real failure. PGRST202 = no such RPC; 42883 = undefined function. */
function isMissingRpc(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  return (
    error.code === 'PGRST202' ||
    error.code === '42883' ||
    (error.message ?? '').includes('is_slot_within_player_booking_cutoff')
  );
}

/**
 * Refuse if ANY of these slots is inside its player booking cutoff.
 *
 * Throws on a real RPC error. A genuinely-missing RPC returns a DEGRADED ok — matching the
 * tier pre-check's established deploy-order tolerance in create-mollie-payment. That is a
 * deliberate asymmetry: wrongly blocking public checkout costs the academy real bookings,
 * while wrongly allowing one is recoverable by staff cancelling it. Deploy order (migration
 * first) makes the window zero anyway, and the caller is expected to alert.
 */
export async function assertSlotsOutsideBookingCutoff(
  supabase: CutoffCheckClient,
  slotIds: string[],
): Promise<CutoffCheckResult> {
  for (const slotId of slotIds) {
    const { data, error } = await supabase.rpc('is_slot_within_player_booking_cutoff', {
      p_slot_id: slotId,
    });
    if (error) {
      if (isMissingRpc(error)) {
        return { ok: true, degraded: 'rpc_missing', detail: error.message ?? 'rpc missing' };
      }
      throw new Error(`booking cutoff check failed: ${error.message ?? 'unknown'}`);
    }
    // Strict === true. The RPC returns a real boolean (EXISTS never yields NULL), and an
    // unknown slot answers false so the FK reports it rather than this check — so anything
    // other than true means "not blocked HERE", not "verified safe". The blocking decision is
    // the RPC's alone; this function never infers one.
    if (data === true) {
      return { ok: false, reason: 'booking_cutoff', slotId };
    }
  }
  return { ok: true };
}
