import { supabase } from '@/lib/supabaseClient';
import { resolveSplitDivisor } from '@/lib/splitDivisor';
import { hasValidPaymentSetup } from '@/lib/academyTrainerPayments';
import { isMissingRelation, reportDeployDriftFallback } from '@/lib/deployDrift';
import { logger } from '@/lib/logger';

export type ClaimStatus = 'pending' | 'claimed' | 'declined' | 'expired' | 'released';

/**
 * How a player pays when keeping their spot for the next cycle:
 * - 'deferred_split' (default, absent = this): Yes = commitment; invoiced at
 *   cycle start, split by final headcount.
 * - 'upfront': the player checks out online (Mollie) immediately on Yes.
 * Stored on cycles.settings.rebook_payment_mode.
 */
export type RebookPaymentMode = 'deferred_split' | 'upfront';

/**
 * Read a cycle's settings JSON. Returns null when unavailable (e.g. RLS).
 *
 * P2-1: this runs on the public token-gated rebook claim/pay page (anon). Read
 * through the sanitized cycles_public view so an unauthenticated caller never
 * receives settings.notify_admin_emails; the denylist preserves rebook_payment_mode
 * (the only key this reader needs). On a missing view (frontend deployed before the
 * migration) fall back to the base cycles table — NOT null — so an 'upfront' cycle is
 * not silently misread as 'deferred_split' during that window.
 */
async function fetchCycleSettings(cyclusId: string): Promise<Record<string, unknown> | null> {
  const { data, error } = await supabase
    .from('cycles_public' as never)
    .select('settings')
    .eq('id', cyclusId)
    .maybeSingle();
  if (error && isMissingRelation(error)) {
    reportDeployDriftFallback('cycles_public', { path: 'priorityClaims.fetchCycleSettings' });
    const { data: baseData, error: baseErr } = await supabase
      .from('cycles')
      .select('settings')
      .eq('id', cyclusId)
      .maybeSingle();
    if (baseErr || !baseData) return null;
    return ((baseData as { settings: unknown }).settings ?? {}) as Record<string, unknown>;
  }
  if (error || !data) return null;
  return ((data as { settings: unknown }).settings ?? {}) as Record<string, unknown>;
}

/**
 * Resolve the rebook payment mode for a cycle. Absent settings, an unreadable
 * cycle (cycles SELECT is public only for status='open'), or any error all
 * fall back to the default 'deferred_split'.
 */
export async function getCycleRebookPaymentMode(
  cyclusId: string | null | undefined,
): Promise<RebookPaymentMode> {
  if (!cyclusId) return 'deferred_split';
  try {
    const settings = await fetchCycleSettings(cyclusId);
    return settings?.rebook_payment_mode === 'upfront' ? 'upfront' : 'deferred_split';
  } catch {
    return 'deferred_split';
  }
}

/**
 * Best-effort record that the player consented to the rebooking rules (stamps
 * slot_priority_claims.rules_accepted_at via the token-gated accept_rebook_rules RPC). Called just
 * before the player proceeds to keep/pay, because the accept then redirects to Mollie. NEVER throws
 * and never hangs (races a short timeout): a consent-logging failure or stall (e.g. the RPC not yet
 * deployed) must not block the rebooking/payment flow — the client-side checkbox has already
 * enforced the agreement. Idempotent server-side.
 */
export async function recordRebookRulesConsent(token: string): Promise<void> {
  try {
    // The caller awaits this right before a checkout redirect, so a stalled connection must not pin
    // the player on "Working…". Race the RPC against a short timer; on timeout, log and proceed.
    const timeout = new Promise<{ error: unknown }>((resolve) =>
      setTimeout(() => resolve({ error: new Error('timeout') }), 2500),
    );
    const { error } = await Promise.race([
      supabase.rpc('accept_rebook_rules', { _token: token }),
      timeout,
    ]);
    if (error) throw error;
  } catch (e) {
    logger.warn('rebook rules consent record failed (best-effort, proceeding)', {
      component: 'priorityClaims',
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * The start date (yyyy-mm-dd) of a cycle, so the player can be told when the new
 * round begins. Null when unavailable (unreadable cycle / RLS / no date) — the
 * caller then simply omits the "starts on …" line. Public for status='open'.
 */
export async function getCycleStartDate(
  cyclusId: string | null | undefined,
): Promise<string | null> {
  if (!cyclusId) return null;
  try {
    // P2-1: anon public claim page — read through cycles_public (sanitized), with a
    // graceful fallback to the base cycles table before the view migration is applied.
    const { data, error } = await supabase
      .from('cycles_public' as never)
      .select('start_date')
      .eq('id', cyclusId)
      .maybeSingle();
    if (error && isMissingRelation(error)) {
      reportDeployDriftFallback('cycles_public', { path: 'priorityClaims.getCycleStartDate' });
      const { data: baseData, error: baseErr } = await supabase
        .from('cycles')
        .select('start_date')
        .eq('id', cyclusId)
        .maybeSingle();
      if (baseErr || !baseData) return null;
      return ((baseData as { start_date: string | null }).start_date) ?? null;
    }
    if (error || !data) return null;
    return ((data as { start_date: string | null }).start_date) ?? null;
  } catch {
    return null;
  }
}

/** Compute when the priority window ends, given a start time and number of days. */
export function computePriorityWindowEnd(now: Date, days: number): Date {
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
}

/** Apply a week offset to an ISO datetime string. */
export function applyWeeksOffset(iso: string, weeks: number): string {
  return new Date(new Date(iso).getTime() + weeks * 7 * 24 * 60 * 60 * 1000).toISOString();
}

export interface PrioritySlotVisibilityArgs {
  slotId: string;
  windowEndsAt: string | null | undefined;
  hasPendingPriority: boolean;
  hasReleasedSeat: boolean;
  claimToken?: string | null;
  claimSlotId?: string | null;
  now?: Date;
}

/**
 * Returns true when a slot must be hidden from public listings because it
 * still belongs to a priority window with unresolved (pending/claimed) claims
 * and no released seats. A matching claim token+slot bypasses the hide.
 */
export function shouldHidePrioritySlot(args: PrioritySlotVisibilityArgs): boolean {
  const { slotId, windowEndsAt, hasPendingPriority, hasReleasedSeat, claimToken, claimSlotId, now } = args;
  if (claimToken && claimSlotId === slotId) return false;
  if (!windowEndsAt) return false;
  const ends = new Date(windowEndsAt).getTime();
  const nowMs = (now ?? new Date()).getTime();
  if (ends <= nowMs) return false;
  return hasPendingPriority && !hasReleasedSeat;
}

export type PublicReleaseStatus = 'pending_admin_review' | 'auto_release_scheduled' | 'released' | 'held';
export type SlotTier = 'priority' | 'members' | 'public' | 'hidden';

export interface SlotVisibilityArgs {
  slotId: string;
  priorityWindowEndsAt: string | null | undefined;
  hasPendingPriority: boolean;
  hasReleasedSeat: boolean;
  memberWindowEndsAt: string | null | undefined;
  publicReleaseStatus: PublicReleaseStatus | null | undefined;
  isCycleMember: boolean;
  claimToken?: string | null;
  claimSlotId?: string | null;
  now?: Date;
}

/**
 * Resolve the current visibility tier for a slot.
 * - 'priority': only the matching claim token sees it
 * - 'members': only viewers who were members of the source cycle
 * - 'public': anyone
 * - 'hidden': owner-only (admin review pending or held)
 */
export function getSlotVisibility(args: SlotVisibilityArgs): SlotTier {
  const { slotId, priorityWindowEndsAt, hasPendingPriority, hasReleasedSeat,
    memberWindowEndsAt, publicReleaseStatus, isCycleMember,
    claimToken, claimSlotId, now } = args;
  const nowMs = (now ?? new Date()).getTime();

  // Priority window?
  const priorityActive = !!priorityWindowEndsAt
    && new Date(priorityWindowEndsAt).getTime() > nowMs
    && hasPendingPriority
    && !hasReleasedSeat;
  if (priorityActive) {
    if (claimToken && claimSlotId === slotId) return 'public';
    return 'priority';
  }

  // Member window?
  const memberActive = !!memberWindowEndsAt
    && new Date(memberWindowEndsAt).getTime() > nowMs;
  if (memberActive) {
    return isCycleMember ? 'public' : 'members';
  }

  // Public release status decides
  if (publicReleaseStatus === 'held' || publicReleaseStatus === 'pending_admin_review') {
    return 'hidden';
  }
  return 'public';
}

/** Convenience: should the public listing hide this slot from a viewer? */
export function shouldHideSlotForViewer(args: SlotVisibilityArgs): boolean {
  const tier = getSlotVisibility(args);
  return tier !== 'public';
}

/** Read claim token + slot from a URLSearchParams-like (browser only). */
export function readClaimParamsFromLocation(): { claimToken: string | null; claimSlotId: string | null } {
  if (typeof window === 'undefined') return { claimToken: null, claimSlotId: null };
  const p = new URLSearchParams(window.location.search);
  return { claimToken: p.get('claim'), claimSlotId: p.get('slot') };
}

export interface PriorityClaim {
  id: string;
  slot_id: string;
  player_id: string | null;
  guest_player_id: string | null;
  status: ClaimStatus;
  claim_token: string;
  invited_at: string | null;
  responded_at: string | null;
  decline_reason: string | null;
  source_slot_id: string | null;
  booking_id: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Fetch the bookings on the source cycle's slots so we know which players
 * are currently sitting in each slot. Returns map keyed by source slot id.
 */
export async function getBookingsBySlotIds(slotIds: string[]) {
  if (slotIds.length === 0) return new Map<string, Array<{ player_id: string | null; guest_player_id: string | null }>>();
  const { data, error } = await supabase
    .from('bookings')
    .select('slot_id, player_id, guest_player_id, status')
    .in('slot_id', slotIds)
    .neq('status', 'cancelled');
  if (error) throw error;
  const map = new Map<string, Array<{ player_id: string | null; guest_player_id: string | null }>>();
  for (const b of data || []) {
    if (!map.has(b.slot_id)) map.set(b.slot_id, []);
    map.get(b.slot_id)!.push({ player_id: b.player_id, guest_player_id: b.guest_player_id });
  }
  return map;
}

export interface BulkCopyInput {
  sourceCycleId: string;
  targetCycleId: string;
  weeksOffset: number; // how many weeks to shift each slot's start/end by
  priorityWindowDays: number;
  // If false, copies slots only without creating priority claims.
  createPriorityClaims: boolean;
  // Allow trainer to opt slots out
  excludeSourceSlotIds?: string[];
  // Tier 2 (members) window length in days, after the priority window ends. 0 to disable.
  memberWindowDays?: number;
  // 'auto_release_scheduled' (default) opens to public after member window;
  // 'pending_admin_review' keeps slots hidden until trainer approves.
  publicReleaseStatus?: PublicReleaseStatus;
}

export interface BulkCopyResult {
  copiedSlots: number;
  createdClaims: number;
  /** New slot ids that received priority claims — use to notify those players. */
  notifiableSlotIds: string[];
}

/**
 * Bulk copy slots from a source cycle to a target cycle, optionally
 * pre-populating slot_priority_claims based on the source slot bookings.
 * Idempotent on (target_cycle_id, source_slot_id).
 */
export async function bulkCopySlotsToCycle(input: BulkCopyInput): Promise<BulkCopyResult> {
  const {
    sourceCycleId, targetCycleId, weeksOffset, priorityWindowDays,
    createPriorityClaims, excludeSourceSlotIds = [],
    memberWindowDays = 0, publicReleaseStatus = 'auto_release_scheduled',
  } = input;

  const { data: sourceSlots, error: srcErr } = await supabase
    .from('availability_slots')
    .select('*')
    .eq('cyclus_id', sourceCycleId);
  if (srcErr) throw srcErr;

  const { data: targetCycle, error: tcErr } = await supabase
    .from('cycles')
    .select('id, name')
    .eq('id', targetCycleId)
    .single();
  if (tcErr) throw tcErr;

  const { data: existingTargetSlots } = await supabase
    .from('availability_slots')
    .select('id, priority_source_slot_id')
    .eq('cyclus_id', targetCycleId)
    .not('priority_source_slot_id', 'is', null);
  const alreadyCopiedSourceIds = new Set((existingTargetSlots || []).map(s => s.priority_source_slot_id));

  const excludeSet = new Set(excludeSourceSlotIds);
  const slotsToCopy = (sourceSlots || []).filter(s => !alreadyCopiedSourceIds.has(s.id) && !excludeSet.has(s.id));

  const now = new Date();
  const windowEnd = computePriorityWindowEnd(now, priorityWindowDays);
  const memberWindowEnd = memberWindowDays > 0
    ? computePriorityWindowEnd(windowEnd, memberWindowDays)
    : null;

  let copiedSlots = 0;
  let createdClaims = 0;
  const notifiableSlotIds: string[] = [];

  for (const src of slotsToCopy) {
    const newStart = applyWeeksOffset(src.start_time, weeksOffset);
    const newEnd = applyWeeksOffset(src.end_time, weeksOffset);

    const insert: Record<string, unknown> = {
      trainer_id: src.trainer_id,
      start_time: newStart,
      end_time: newEnd,
      is_recurring: false,
      cyclus_id: targetCycleId,
      cyclus_name: targetCycle.name,
      court_type: src.court_type,
      location_id: src.location_id,
      academy_profile_id: src.academy_profile_id,
      // Visibility is gated by tier (priority/member/public) in the listing layer.
      // Slots are always queryable; the client filters via getSlotVisibility.
      is_public: true,
      training_level: src.training_level,
      price_per_session: src.price_per_session,
      total_price: src.total_price,
      allow_single_booking: src.allow_single_booking,
      whole_slot_booking: (src as { whole_slot_booking?: boolean | null }).whole_slot_booking ?? false,
      min_participants: src.min_participants,
      max_participants: src.max_participants,
      extra_costs: src.extra_costs,
      rating_system: src.rating_system,
      min_rating: src.min_rating,
      max_rating: src.max_rating,
      prices_include_vat: src.prices_include_vat,
      split_payment: src.split_payment,
      priority_source_slot_id: src.id,
      priority_window_starts_at: createPriorityClaims ? now.toISOString() : null,
      priority_window_ends_at: createPriorityClaims ? windowEnd.toISOString() : null,
      source_cycle_id: sourceCycleId,
      member_window_starts_at: memberWindowEnd ? windowEnd.toISOString() : null,
      member_window_ends_at: memberWindowEnd ? memberWindowEnd.toISOString() : null,
      public_release_status: publicReleaseStatus,
    };

    const { data: newSlot, error: insErr } = await supabase
      .from('availability_slots')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .insert(insert as any)
      .select('id')
      .single();
    if (insErr) throw insErr;
    copiedSlots++;

    if (createPriorityClaims) {
      const bookingsMap = await getBookingsBySlotIds([src.id]);
      const bookings = bookingsMap.get(src.id) || [];
      let slotGotClaim = false;
      for (const b of bookings) {
        if (!b.player_id && !b.guest_player_id) continue;
        const { error: cErr } = await supabase.from('slot_priority_claims').insert({
          slot_id: newSlot.id,
          player_id: b.player_id,
          guest_player_id: b.guest_player_id,
          source_slot_id: src.id,
          status: 'pending',
        });
        if (!cErr) {
          createdClaims++;
          slotGotClaim = true;
        }
      }
      if (slotGotClaim) notifiableSlotIds.push(newSlot.id);
    }
  }

  return { copiedSlots, createdClaims, notifiableSlotIds };
}

/**
 * Send priority-claim invitation emails for the given slots (one call per slot;
 * the edge function emails every pending, not-yet-invited claim on that slot).
 * Returns how many slots were notified. Failures per slot are swallowed so one
 * bad slot doesn't abort the rest.
 */
export async function notifyPriorityClaimsForSlots(slotIds: string[]): Promise<number> {
  let notified = 0;
  for (const slotId of slotIds) {
    const { error } = await supabase.functions.invoke('send-priority-claim-invitation', {
      body: { slotId },
    });
    if (!error) notified++;
  }
  return notified;
}

export interface MyPendingClaim {
  id: string;
  claim_token: string;
  slot_id: string;
  start_time: string;
  end_time: string;
  cyclus_id: string | null;
  cyclus_name: string | null;
  price_per_session: number | null;
  priority_window_ends_at: string | null;
  /** Payment mode of the slot's cycle ('deferred_split' when unknown). */
  rebook_payment_mode: RebookPaymentMode;
  /** Group key tying a weekly SERIES together (null for legacy single claims). */
  rebook_group_id: string | null;
  /** Number of weekly sessions in this group (1 for a single claim). */
  sessions: number;
  /** Start of the LAST session in the group (== start_time when sessions === 1). */
  last_start_time: string;
  /** Start date (yyyy-mm-dd) of the new cycle, for "new cycle starts: …". */
  start_date: string | null;
}

/**
 * The logged-in player's own still-actionable priority claims (pending and
 * within the priority window), COLLAPSED to one entry per rebook group (weekly
 * series) — the same dedup the email invite and the trainer tentative roster
 * use, so a 12-week group shows ONE card, not 12. The earliest session is the
 * representative; its claim_token drives accept/decline, and the group-aware
 * respond_to_priority_claim RPC fans out to the whole series server-side.
 * RLS ("Players read own priority claims") scopes the rows to this player.
 */
export async function getMyPendingPriorityClaims(profileId: string): Promise<MyPendingClaim[]> {
  // Linked-guest aware (rebook go-live B1): the SECURITY DEFINER RPC returns this player's
  // pending claims keyed on player_id = me OR guest_player_id ∈ my linked guests, so an
  // academy/captain rebooking on behalf of a linked account-holder surfaces on their OWN
  // dashboard (a guest-keyed claim is invisible to a plain player_id read). Normalised into
  // the nested shape the group-collapse loop below already expects. Falls back to the legacy
  // player_id-only direct read when the RPC isn't deployed yet (PGRST202) so the card keeps
  // working in the FE-deployed-migration-pending window.
  type NestedClaim = {
    id: string;
    claim_token: string;
    slot_id: string;
    rebook_group_id: string | null;
    availability_slots: {
      start_time: string;
      end_time: string;
      cyclus_id: string | null;
      cyclus_name: string | null;
      price_per_session: number | null;
      priority_window_ends_at: string | null;
    } | null;
  };
  let data: NestedClaim[];
  const rpc = await supabase.rpc('get_my_pending_priority_claims');
  if (rpc.error) {
    if (rpc.error.code !== 'PGRST202') throw rpc.error;
    const fb = await supabase
      .from('slot_priority_claims')
      .select('id, claim_token, slot_id, rebook_group_id, availability_slots:slot_id(start_time, end_time, cyclus_id, cyclus_name, price_per_session, priority_window_ends_at)')
      .eq('player_id', profileId)
      .eq('status', 'pending');
    if (fb.error) throw fb.error;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data = (fb.data || []) as any[];
  } else {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data = ((rpc.data || []) as any[]).map((r) => ({
      id: r.id,
      claim_token: r.claim_token,
      slot_id: r.slot_id,
      rebook_group_id: r.rebook_group_id ?? null,
      availability_slots: {
        start_time: r.start_time,
        end_time: r.end_time,
        cyclus_id: r.cyclus_id ?? null,
        cyclus_name: r.cyclus_name ?? null,
        price_per_session: r.price_per_session ?? null,
        priority_window_ends_at: r.priority_window_ends_at ?? null,
      },
    }));
  }
  const now = Date.now();
  // Collapse weekly claims into one MyPendingClaim per group (fallback: slot).
  const byGroup = new Map<string, MyPendingClaim>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const c of (data || []) as any[]) {
    const s = c.availability_slots;
    if (!s) continue;
    if (s.priority_window_ends_at && new Date(s.priority_window_ends_at).getTime() <= now) continue;
    const key = c.rebook_group_id ?? `slot:${c.slot_id}`;
    const existing = byGroup.get(key);
    if (!existing) {
      byGroup.set(key, {
        id: c.id,
        claim_token: c.claim_token,
        slot_id: c.slot_id,
        start_time: s.start_time,
        end_time: s.end_time,
        cyclus_id: s.cyclus_id ?? null,
        cyclus_name: s.cyclus_name,
        price_per_session: s.price_per_session,
        priority_window_ends_at: s.priority_window_ends_at,
        rebook_payment_mode: 'deferred_split' as RebookPaymentMode,
        rebook_group_id: c.rebook_group_id ?? null,
        sessions: 1,
        last_start_time: s.start_time,
        start_date: null,
      });
    } else {
      existing.sessions += 1;
      // The representative = earliest session (its token drives the group RPC).
      if (s.start_time < existing.start_time) {
        existing.start_time = s.start_time;
        existing.end_time = s.end_time;
        existing.claim_token = c.claim_token;
        existing.id = c.id;
        existing.slot_id = c.slot_id;
      }
      if (s.start_time > existing.last_start_time) existing.last_start_time = s.start_time;
    }
  }
  const claims = [...byGroup.values()];

  // Resolve each cycle's payment mode so the card copy can be mode-aware.
  const cyclusIds = [...new Set(claims.map((c) => c.cyclus_id).filter((id): id is string => !!id))];
  if (cyclusIds.length > 0) {
    const { data: cycleRows } = await supabase
      .from('cycles')
      .select('id, settings, start_date')
      .in('id', cyclusIds);
    const modeByCycle = new Map<string, RebookPaymentMode>(
      (cycleRows || []).map((row) => {
        const settings = (row.settings ?? {}) as Record<string, unknown>;
        return [row.id, settings.rebook_payment_mode === 'upfront' ? 'upfront' : 'deferred_split'];
      }),
    );
    const startDateByCycle = new Map<string, string | null>(
      (cycleRows || []).map((row) => [row.id, (row.start_date as string | null) ?? null]),
    );
    for (const claim of claims) {
      if (claim.cyclus_id) {
        claim.rebook_payment_mode = modeByCycle.get(claim.cyclus_id) ?? 'deferred_split';
        claim.start_date = startDateByCycle.get(claim.cyclus_id) ?? null;
      }
    }
  }

  return claims;
}

export async function getPriorityClaimsForSlot(slotId: string) {
  const { data, error } = await supabase
    .from('slot_priority_claims')
    .select('*, profiles:player_id(id, full_name, email), guest_players:guest_player_id(id, full_name, email)')
    .eq('slot_id', slotId)
    .order('created_at');
  if (error) throw error;
  return data || [];
}

export async function declineClaimAsManager(claimId: string, reason?: string) {
  const { error } = await supabase
    .from('slot_priority_claims')
    .update({ status: 'declined', responded_at: new Date().toISOString(), decline_reason: reason ?? 'Manager released' })
    .eq('id', claimId);
  if (error) throw error;
}

export type ExtendPriorityWindowResult = 'extended' | 'already_extended';

/**
 * Extend the priority window by `extraDays`. The update is conditional on the
 * value read first, so a double-click or concurrent request applies at most
 * once; the loser sees 'already_extended' instead of stacking another week.
 */
export async function extendPriorityWindow(slotId: string, extraDays: number): Promise<ExtendPriorityWindowResult> {
  const { data: slot, error: readError } = await supabase
    .from('availability_slots')
    .select('priority_window_ends_at')
    .eq('id', slotId)
    .single();
  if (readError) throw readError;
  const previousEnd: string | null = slot?.priority_window_ends_at ?? null;
  const base = previousEnd ? new Date(previousEnd) : new Date();
  const newEnd = new Date(base.getTime() + extraDays * 24 * 60 * 60 * 1000);
  let update = supabase
    .from('availability_slots')
    .update({ priority_window_ends_at: newEnd.toISOString() })
    .eq('id', slotId);
  update = previousEnd === null
    ? update.is('priority_window_ends_at', null)
    : update.eq('priority_window_ends_at', previousEnd);
  const { data: updated, error } = await update.select('id');
  if (error) throw error;
  return updated && updated.length > 0 ? 'extended' : 'already_extended';
}

export async function endPriorityWindowNow(slotId: string) {
  const { error } = await supabase
    .from('availability_slots')
    .update({ priority_window_ends_at: new Date().toISOString(), is_public: true })
    .eq('id', slotId);
  if (error) throw error;
}

export async function fetchClaimByToken(token: string) {
  const { data, error } = await supabase.rpc('get_priority_claim_by_token', { _token: token });
  if (error) throw error;
  return data as Record<string, unknown> | null;
}

/**
 * Resume-payment: the claim's ONE active UNPAID rebook invoice pay token, so an accepted upfront
 * claim whose Mollie checkout was dropped/refreshed can offer "Continue to payment" instead of the
 * dead-end deferred copy. Token-gated SECURITY DEFINER read (works logged-out); fail-OPEN — returns
 * null on any error / when the RPC isn't deployed yet, so the button simply doesn't render.
 */
export async function getUnpaidRebookInvoiceByToken(
  token: string,
): Promise<{ public_token: string; status: string } | null> {
  try {
    const { data, error } = await supabase.rpc(
      'get_unpaid_rebook_invoice_by_claim_token' as never,
      { _token: token } as never,
    );
    if (error || !data) return null;
    const row = data as { public_token?: string | null; status?: string | null };
    return row?.public_token ? { public_token: row.public_token, status: row.status ?? 'sent' } : null;
  } catch {
    return null;
  }
}

export async function declineClaimWithToken(token: string, reason?: string) {
  const { data, error } = await supabase.rpc('respond_to_priority_claim', {
    _token: token,
    _action: 'decline',
    _reason: reason,
  });
  if (error) throw error;
  return data;
}

/**
 * Record WHICH button the player clicked on the invite (accept|decline) — best-effort, fires on
 * landing from the email button and on the on-page Yes press. Stamps response_intent on a still-
 * pending claim without touching status, so a "clicked Yes, abandoned checkout" is visible. Never
 * throws (a failed intent log must never block the actual accept/decline flow).
 */
export async function recordPriorityClaimIntent(token: string, intent: 'accept' | 'decline'): Promise<void> {
  try {
    await supabase.rpc('record_priority_claim_intent' as never, { _token: token, _intent: intent } as never);
  } catch {
    // best-effort analytics — swallow.
  }
}

/**
 * Accept a priority claim = commit to the next cycle (no upfront payment).
 * Creates a confirmed, unpaid commitment booking server-side and marks the
 * claim 'claimed'. Returns the RPC result, e.g. { ok, status, booking_id } or
 * { ok: false, reason: 'slot_full' | 'window_expired' | 'already_responded' }.
 */
export async function acceptClaimWithToken(token: string) {
  const { data, error } = await supabase.rpc('respond_to_priority_claim', {
    _token: token,
    _action: 'accept',
  });
  if (error) throw error;
  return data as { ok: boolean; status?: string; reason?: string; booking_id?: string } | null;
}

// ===== Group-captain rebooking: one member re-books the whole group =====

export interface RebookGroupMember {
  key: string; // 'p:<uuid>' | 'g:<uuid>' — opaque to the UI, parsed back by rebook_group_apply
  first_name: string;
  status: 'claimed' | 'pending' | 'declined';
  is_self: boolean;
  has_email: boolean;
}

export interface RebookGroup {
  rebook_group_id: string;
  can_rebook_group: boolean;
  /** True once the captain has PAID their group seat — they may then assign/change the roster. */
  can_manage_group?: boolean;
  /** The single active group invoice (upfront) — manage links covered teammates onto it. */
  group_invoice_id?: string | null;
  self_key: string;
  slot: Record<string, unknown>;
  sessions: number;
  members: RebookGroupMember[];
}

export interface RebookGroupApplyResult {
  ok: boolean;
  group?: boolean;
  reason?: string;
  rebook_group_id?: string;
  booked?: number;
  declined?: number;
  added?: number;
  skipped_full?: number;
  skipped_existing?: number;
  booking_ids?: string[];
}

/** Roster of the token's rebook group (first name + status only — PII-trimmed). Null when
 *  the claim isn't part of a group (legacy single claim) or the token is unknown. */
export async function fetchRebookGroupByToken(token: string): Promise<RebookGroup | null> {
  const { data, error } = await supabase.rpc('get_rebook_group_by_token', { _token: token });
  if (error) throw error;
  return (data as RebookGroup | null) ?? null;
}

/** Token-gated mint of a new guest player for the group (the anon captain can't write
 *  guest_players directly). Returns the guest_players.id to pass to applyRebookGroup. */
export async function createRebookGroupGuest(token: string, input: {
  firstName: string; lastName: string; email: string; phone: string;
}): Promise<string> {
  const { data, error } = await supabase.rpc('create_rebook_group_guest', {
    _token: token,
    _first_name: input.firstName,
    _last_name: input.lastName,
    _email: input.email,
    _phone: input.phone,
  });
  if (error) throw error;
  return data as string;
}

/** Re-book the whole group: keep the listed members, decline the rest (pending only), and add
 *  the given new guest ids — all capacity-guarded + atomic. */
export async function applyRebookGroup(token: string, args: {
  keepKeys: string[]; newGuestIds?: string[];
}): Promise<RebookGroupApplyResult> {
  const { data, error } = await supabase.rpc('rebook_group_apply', {
    _token: token,
    _keep_keys: args.keepKeys,
    _new_guest_ids: args.newGuestIds ?? [],
  });
  if (error) throw error;
  return (data as RebookGroupApplyResult) ?? { ok: false };
}

export interface GroupRebookInvoiceResult {
  ok: boolean;
  reason?: string;
  /** True when the group already had an active invoice — the caller is sent to THAT one, not a 2nd. */
  alreadyStarted?: boolean;
  invoiceId?: string;
  publicToken?: string;
  status?: string;
  checkoutUrl?: string;
}

/** UPFRONT pay-first: books the captain's own seat + mints ONE group invoice (the fixed full
 *  court price) + starts a Mollie checkout. The captain assigns the roster AFTER paying
 *  (manageRebookGroup). Teammates stay pending (slot held) until then. */
export async function createGroupRebookInvoice(token: string): Promise<GroupRebookInvoiceResult> {
  const { data, error } = await supabase.functions.invoke('create-group-rebook-invoice', { body: { token } });
  if (error) return { ok: false, reason: error.message };
  return (data as GroupRebookInvoiceResult) ?? { ok: false };
}

/** UPFRONT post-payment roster management: assign/change players who are COVERED by the
 *  captain's group payment (booked already-paid, paid_by the captain). */
export async function manageRebookGroup(token: string, args: {
  keepKeys: string[]; newGuestIds?: string[]; invoiceId?: string;
}): Promise<RebookGroupApplyResult> {
  const { data, error } = await supabase.rpc('rebook_group_manage', {
    _token: token,
    _keep_keys: args.keepKeys,
    _new_guest_ids: args.newGuestIds ?? [],
    _invoice_id: args.invoiceId ?? null,
  });
  if (error) throw error;
  return (data as RebookGroupApplyResult) ?? { ok: false };
}

/** Phase 4: fire-and-forget — email the people the captain just booked ("X re-booked you" /
 *  "you've been added by X"). Idempotent server-side via confirmation_sent_at, so a dropped call
 *  is recovered on the next group action; never block the UI on it. */
export function sendRebookGroupConfirmations(token: string): void {
  void supabase.functions
    .invoke('send-rebook-group-confirmation', { body: { token } })
    .catch(() => { /* best-effort; the edge fn is idempotent */ });
}

export interface AcceptAndPayResult {
  ok: boolean;
  status?: string;
  reason?: string;
  booking_id?: string;
  /**
   * - 'deferred': commitment captured; invoiced at cycle start (default flow).
   * - 'upfront': commitment captured AND a Mollie checkout was created —
   *   redirect the player to `checkoutUrl`.
   * - 'upfront_invoiced': commitment captured, online checkout unavailable, but an
   *   invoice was minted — send the player to `/pay/{publicToken}` (Mollie button or
   *   bank-transfer instructions). The invoice is also emailed.
   * - 'upfront_unavailable': commitment captured, but neither checkout nor an
   *   invoice could be produced (e.g. guest claim, or the academy has no complete
   *   payment setup). The spot is reserved; the academy follows up manually.
   * - 'strict_mollie_unavailable': STRICT pay-first cycle where the Mollie checkout
   *   could not be started — strict has NO bank fallback, so the just-created HOLD
   *   was RELEASED (no seat is kept). The player should retry; nothing is reserved.
   */
  mode?: 'deferred' | 'upfront' | 'upfront_invoiced' | 'upfront_unavailable' | 'strict_mollie_unavailable';
  checkoutUrl?: string;
  publicToken?: string;
  /** RB-P2-05: sessions in the cyclus that were full at accept time and NOT booked (upfront path). */
  skippedFull?: number;
}

/**
 * Release strict-rebook HOLDS the player can no longer pay for (Mollie checkout
 * couldn't start). Best-effort, idempotent server-side; the expiry cron is the
 * backstop. Used only in strict mode — strict keeps NO seat without payment.
 */
async function releaseRebookHolds(bookingIds: string[]): Promise<void> {
  await Promise.all(
    bookingIds.map(async (id) => {
      try {
        await supabase.rpc('release_rebook_hold', { _booking_id: id });
      } catch {
        // Best-effort — the release-expired-rebook-holds cron reclaims it within minutes.
      }
    }),
  );
}

interface ClaimSlotInfo {
  id: string;
  cyclus_id: string | null;
  cyclus_name: string | null;
  trainer_id: string;
}

/**
 * Upfront rebook accept with no online (Mollie) checkout: mint an invoice so the
 * player has something to pay (bank-transfer instructions on the invoice / pay page)
 * instead of a dead-end. Falls back to 'upfront_unavailable' only if an invoice
 * can't be produced — e.g. the academy's invoice business profile is incomplete, or
 * the edge function isn't deployed yet (graceful, identical to the old behaviour).
 */
async function mintRebookInvoiceFallback(
  accept: { ok: boolean; status?: string; reason?: string; booking_id?: string },
  bookingIds: string[],
): Promise<AcceptAndPayResult> {
  if (bookingIds.length > 0) {
    try {
      const { data, error } = await supabase.functions.invoke('create-rebook-invoice', {
        body: { bookingIds },
      });
      const result = data as { ok?: boolean; publicToken?: string } | null;
      if (!error && result?.ok && result.publicToken) {
        return { ...accept, mode: 'upfront_invoiced', publicToken: result.publicToken };
      }
      if (error) {
        // The edge fn was unreachable/errored — most often because it isn't deployed yet. Signal it:
        // otherwise the player silently lands on 'upfront_unavailable' (a reserved-but-unpayable spot).
        reportDeployDriftFallback('create_rebook_invoice', { reason: 'edge_fn_error', bookingCount: bookingIds.length });
      }
    } catch {
      reportDeployDriftFallback('create_rebook_invoice', { reason: 'edge_fn_throw', bookingCount: bookingIds.length });
    }
  }
  return { ...accept, mode: 'upfront_unavailable' };
}

export interface PublicRebookInvoiceResult {
  ok: boolean;
  reason?: string;
  alreadyStarted?: boolean;
  invoiceId?: string;
  publicToken?: string;
  status?: string;
  checkoutUrl?: string;
  /** RB-P2-05: sessions in the cyclus that were full at accept time and NOT booked/invoiced. */
  skippedFull?: number;
}

/**
 * Slice A — the NO-LOGIN single-claim rebook payment. Token-gated: the edge fn accepts the
 * claimant's whole-cyclus claims, mints ONE full-price invoice over only their bookings, and starts
 * a Mollie checkout — all server-side, works logged-in OR logged-out. Returns `reason: 'is_group'`
 * for a group claim (the caller should use the group path instead).
 */
export async function createRebookInvoicePublic(token: string): Promise<PublicRebookInvoiceResult> {
  const { data, error } = await supabase.functions.invoke('create-rebook-invoice-public', { body: { token } });
  if (error) return { ok: false, reason: 'invoke_failed' };
  return (data as PublicRebookInvoiceResult) ?? { ok: false };
}

/**
 * Accept a priority claim and, when the cycle's rebook_payment_mode is
 * 'upfront', immediately create a Mollie checkout for the player's accepted
 * bookings in that cycle. This only CREATES a checkout link (the
 * create-mollie-payment edge function recomputes the authoritative amount
 * server-side); it never executes a payment.
 *
 * The accept itself is never rolled back: any failure after a successful
 * accept degrades to 'deferred' (mode unknown) or 'upfront_unavailable'
 * (checkout could not be started) instead of surfacing an error.
 */
export async function acceptClaimAndStartPayment(token: string): Promise<AcceptAndPayResult | null> {
  // Determine the payment mode + target cyclus BEFORE accepting: an UPFRONT claim delegates the whole
  // accept + ONE full-price invoice + checkout to the no-login token path (Slice A), so it works
  // logged-in OR logged-out and always charges full price (owner #1). Only the deferred / group-member
  // fallback below accepts client-side.
  let slot: ClaimSlotInfo | null = null;
  let mode: RebookPaymentMode = 'deferred_split';
  let playerId: string | null = null;
  try {
    const claimData = await fetchClaimByToken(token);
    slot = (claimData?.slot ?? null) as ClaimSlotInfo | null;
    playerId = ((claimData?.claim as { player_id?: string | null } | undefined)?.player_id) ?? null;
    // Prefer the status-independent mode from the token RPC (SECURITY DEFINER, so it resolves
    // even after the cycle leaves 'open' — otherwise an upfront cycle would silently fall back
    // to deferred and skip the pay-first gate). Fall back to the cycles_public read only when
    // the RPC didn't supply it (frontend deployed before the migration).
    const rpcMode = (claimData as { rebook_payment_mode?: string | null } | null)?.rebook_payment_mode;
    mode = rpcMode === 'upfront'
      ? 'upfront'
      : rpcMode === 'deferred_split'
        ? 'deferred_split'
        : await getCycleRebookPaymentMode(slot?.cyclus_id);
  } catch {
    // Mode lookup failed. Do NOT silently accept as a deferred commitment: for a STRICT upfront cycle
    // that would degrade the claim to "reserved, pay later" and bypass the pay-first gate (the exact
    // leak a page refresh could trigger). Refuse without accepting so the caller can retry once the
    // mode resolves — a missed acceptance is recoverable; a strict cycle silently reserved is not.
    return { ok: false, reason: 'mode_lookup_failed' };
  }

  // UPFRONT → the no-login public path (accept + one full-price invoice + checkout). A group claim
  // comes back 'is_group' (a member's just-my-spot) → fall through to the legacy authed path.
  if (mode === 'upfront' && slot?.cyclus_id) {
    const res = await createRebookInvoicePublic(token);
    // 'is_group' = a group member's just-my-spot → fall through to the legacy authed path. Any other
    // result is handled here (the public fn already accepted the claim server-side, so we must NOT
    // fall through and re-accept — that would show a misleading "already responded").
    if (res && res.reason !== 'is_group' && res.reason !== 'invoke_failed' && res.reason !== 'claim_not_found') {
      if (res.ok && res.checkoutUrl) return { ok: true, status: 'claimed', mode: 'upfront', checkoutUrl: res.checkoutUrl, skippedFull: res.skippedFull };
      if (res.ok && res.publicToken) return { ok: true, status: 'claimed', mode: 'upfront_invoiced', publicToken: res.publicToken, skippedFull: res.skippedFull };
      if (res.reason === 'strict_mollie_unavailable') return { ok: true, status: 'pending', mode: 'strict_mollie_unavailable' };
      // Booked server-side but no checkout/invoice (e.g. the academy's payment setup is incomplete):
      // the seat is reserved — surface that (manual follow-up), don't lose it or double-accept.
      return { ok: true, status: 'claimed', mode: 'upfront_unavailable' };
    }
  }

  // LEGACY: plain accept — a deferred commitment, or the authed just-my-spot path for a GROUP member.
  const accept = await acceptClaimWithToken(token);
  if (!accept?.ok) return accept;
  if (mode !== 'upfront' || !slot?.cyclus_id) return { ...accept, mode: 'deferred' };

  // STRICT pay-first (opt-in per cycle: settings.rebook_strict_mollie): the accept already created
  // a HOLD instead of a confirmed booking (server-side, A2). Strict keeps NO seat without payment,
  // so on ANY non-checkout outcome we RELEASE the holds (no bank fallback). Track every hold the
  // accept created (this claim + any siblings picked up below) so the catch can release them too.
  const settings = await fetchCycleSettings(slot.cyclus_id);
  const strict = settings?.rebook_strict_mollie === true;
  const strictHoldIds: string[] = strict && accept.booking_id ? [accept.booking_id] : [];
  const failStrict = async (ids: string[]): Promise<AcceptAndPayResult> => {
    await releaseRebookHolds(ids);
    return { ...accept, mode: 'strict_mollie_unavailable' };
  };

  try {
    // Online checkout needs an authenticated player: create-mollie-payment
    // verifies every booking belongs to the caller's profile. Guest/email-only
    // accepts keep the spot and fall back to manual invoicing (strict releases).
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return strict ? await failStrict(strictHoldIds) : { ...accept, mode: 'upfront_unavailable' };

    const cyclusId = slot.cyclus_id;
    const splitPayment = settings?.split_payment === true;

    // All slots of the target cycle (price + trainer for the checkout call).
    const { data: cycleSlots } = await supabase
      .from('availability_slots')
      .select('id, price_per_session, trainer_id')
      .eq('cyclus_id', cyclusId);
    const priceBySlot = new Map<string, number>(
      (cycleSlots || []).map((s) => [s.id, Number(s.price_per_session) || 0]),
    );
    const cycleSlotIds = (cycleSlots || []).map((s) => s.id);

    // Multi-slot cycles: the player may hold one claim per slot. Accept the
    // remaining pending ones first so a single checkout covers the whole
    // cycle. RLS scopes this select to the player's own claims; we also pin
    // player_id explicitly (defense-in-depth) so a future RLS change can't
    // widen it. Previously accepted ('claimed') siblings are picked up via
    // their booking_id.
    //
    // NOTE: this is cycle-scoped (all slots sharing the target cyclus_id), not
    // rebook-group-scoped. For a cohort rebooked across several weekday/time
    // groups into one cycle, accepting+paying one group's claim also accepts
    // this player's pending claims in their OTHER groups of the same cycle and
    // settles them in a single checkout. That is intentional (one payment for
    // the player's whole commitment); the group-aware decline path still lets a
    // manager release individual groups.
    const bookingIds = accept.booking_id ? [accept.booking_id] : [];
    if (cycleSlotIds.length > 0) {
      let myClaimsQuery = supabase
        .from('slot_priority_claims')
        .select('claim_token, slot_id, status, booking_id')
        .in('slot_id', cycleSlotIds);
      if (playerId) myClaimsQuery = myClaimsQuery.eq('player_id', playerId);
      const { data: myClaims } = await myClaimsQuery;
      for (const mc of myClaims || []) {
        if (mc.claim_token === token) continue;
        if (mc.status === 'pending') {
          try {
            const sibling = await acceptClaimWithToken(mc.claim_token);
            if (sibling?.ok && sibling.booking_id) bookingIds.push(sibling.booking_id);
          } catch {
            // One failed sibling (e.g. slot_full) must not block the checkout.
          }
        } else if (mc.status === 'claimed' && mc.booking_id) {
          bookingIds.push(mc.booking_id);
        }
      }
    }

    // Keep only this player's still-payable bookings — a paid or cancelled
    // sibling booking would make create-mollie-payment reject the batch.
    // 'payment_pending' = a STRICT hold (A1/A2): it is payable (the player is paying for it now),
    // so it MUST be included — else the strict accept would drop its own hold and release the seat.
    const { data: payable } = await supabase
      .from('bookings')
      .select('id, slot_id')
      .in('id', [...new Set(bookingIds)])
      .eq('payment_status', 'pending')
      .in('status', ['pending', 'confirmed', 'payment_pending']);
    const payableBookingIds = (payable || []).map((b) => b.id);
    const payableSlotIds = [...new Set((payable || []).map((b) => b.slot_id))];
    if (payableBookingIds.length === 0) return strict ? await failStrict(strictHoldIds) : { ...accept, mode: 'upfront_unavailable' };
    // Strict: the payable bookings ARE the holds to release if checkout can't start.
    if (strict) for (const id of payableBookingIds) if (!strictHoldIds.includes(id)) strictHoldIds.push(id);

    // Amount, mirroring BookLesson's cycle branch: sum of price_per_session over the
    // player's booked slots; with split_payment, divided by the cycle's frozen court
    // CAPACITY (G5), matching the edge function's divisor. Indicative only — the edge
    // function recomputes it with service role.
    const total = payableSlotIds.reduce((sum, id) => sum + (priceBySlot.get(id) ?? 0), 0);
    let amount = total;
    if (splitPayment) {
      const { data: capRows } = await supabase
        .from('availability_slots')
        .select('max_participants')
        .in('id', payableSlotIds);
      const divisor = resolveSplitDivisor((capRows || []) as { max_participants?: number | null }[]);
      amount = Math.round((total / divisor) * 100) / 100;
    }

    const paymentSetup = await hasValidPaymentSetup(slot.trainer_id, slot.trainer_id, false);
    // No online checkout available. Non-strict: mint an invoice (bank transfer / manual) so the
    // player isn't left with a reserved-but-unpayable spot. STRICT: no bank fallback — release the
    // holds (no seat without payment).
    if (!paymentSetup.valid) {
      return strict ? await failStrict(strictHoldIds) : await mintRebookInvoiceFallback(accept, payableBookingIds);
    }

    const { data: paymentData, error: paymentError } = await supabase.functions.invoke('create-mollie-payment', {
      body: {
        slotId: payableSlotIds[0],
        amount,
        description: slot.cyclus_name ?? 'Cyclus',
        trainerId: slot.trainer_id,
        bookingIds: payableBookingIds,
      },
    });
    if (paymentError || !paymentData?.checkoutUrl) {
      return strict ? await failStrict(strictHoldIds) : await mintRebookInvoiceFallback(accept, payableBookingIds);
    }
    return { ...accept, mode: 'upfront', checkoutUrl: paymentData.checkoutUrl as string };
  } catch {
    // Strict: release the holds (no seat without payment). Non-strict: the spot stays reserved.
    if (strict) return await failStrict(strictHoldIds);
    return { ...accept, mode: 'upfront_unavailable' };
  }
}

// === Tier overrides ===

export async function openSlotToMembersNow(slotId: string, memberWindowDays = 7) {
  const memberEnd = new Date(Date.now() + memberWindowDays * 24 * 60 * 60 * 1000);
  const { error } = await supabase
    .from('availability_slots')
    .update({
      priority_window_ends_at: new Date().toISOString(),
      member_window_starts_at: new Date().toISOString(),
      member_window_ends_at: memberEnd.toISOString(),
    } as never)
    .eq('id', slotId);
  if (error) throw error;
}

export async function releaseSlotToPublic(slotId: string) {
  const { error } = await supabase
    .from('availability_slots')
    .update({
      priority_window_ends_at: new Date().toISOString(),
      member_window_ends_at: new Date().toISOString(),
      public_release_status: 'released',
      is_public: true,
    } as never)
    .eq('id', slotId);
  if (error) throw error;
}

export async function holdSlotForReview(slotId: string) {
  const { error } = await supabase
    .from('availability_slots')
    .update({ public_release_status: 'held' } as never)
    .eq('id', slotId);
  if (error) throw error;
}

export async function setSlotToPendingReview(slotId: string) {
  const { error } = await supabase
    .from('availability_slots')
    .update({ public_release_status: 'pending_admin_review' } as never)
    .eq('id', slotId);
  if (error) throw error;
}

// === Member swap ===

export async function swapMemberBooking(oldBookingId: string, newSlotId: string) {
  const { data, error } = await supabase.rpc('swap_member_booking' as never, {
    _old_booking_id: oldBookingId,
    _new_slot_id: newSlotId,
  } as never);
  if (error) throw error;
  return data as { ok: boolean; new_booking_id: string };
}

export async function isCycleMember(cycleId: string): Promise<boolean> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return false;
  const { data, error } = await supabase.rpc('is_cycle_member' as never, {
    _user_id: user.id, _cycle_id: cycleId,
  } as never);
  if (error) return false;
  return Boolean(data);
}

