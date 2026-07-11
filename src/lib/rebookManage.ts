// Per-cycle rebook management: derive the status of each weekly session/group of a
// rebooked cycle (rebooked / awaiting / won't-rebook / open-to-members / open-to-public),
// with per-player response + paid status, plus the bulk levers (open to public / make
// private / send reminder). Read-only derivation — all signals already exist on
// availability_slots + slot_priority_claims + invoices.
import { supabase } from '@/lib/supabaseClient';
import { releaseSlotToPublic, holdSlotForReview, declineClaimAsManager, type PublicReleaseStatus } from '@/lib/priorityClaims';
import { cancelPlayerBookingsInCycle } from '@/lib/bookings';
import { updateCycleSettings } from '@/lib/cycleWrites';
import type { CycleSettings } from '@/lib/cycleTypes';
import { fetchTrainerDisplayNamesByProfileIds } from '@/lib/trainerDisplayNames';
import type { BulkResult, BulkFailure } from '@/lib/academyPlayerBulk';

export type GroupStatus = 'rebooked' | 'awaiting' | 'declined' | 'members' | 'public';
type SlotPhase = 'priority' | 'members' | 'public' | 'held';
type ClaimsState = 'rebooked' | 'awaiting' | 'declined' | 'none';

/**
 * PostgREST silently caps a single select at ~1000 rows (project default) — NO error, just a
 * truncated result. A real round blows past that: 100+ invitees × ~14 weekly claims ≈ 1500+ claim
 * rows, so the one-shot read dropped ~500 rows INCLUDING the representative claims carrying
 * `invited_at`. The manage view then showed dozens of already-emailed players as "niet verstuurd"
 * (and the resume button — correctly — found nothing to send: the sender reads in chunks and saw
 * the true state). Page every bulk read with .range() until a short page; `order` keeps the
 * pagination deterministic.
 */
const FETCH_PAGE = 1000;
export async function fetchAllPages<T>(
  buildPage: (from: number, to: number) => PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>,
): Promise<{ rows: T[]; error: { code?: string; message?: string } | null }> {
  const rows: T[] = [];
  for (let from = 0; ; from += FETCH_PAGE) {
    const { data, error } = await buildPage(from, from + FETCH_PAGE - 1);
    if (error) return { rows, error };
    const page = (data ?? []) as T[];
    rows.push(...page);
    if (page.length < FETCH_PAGE) return { rows, error: null };
  }
}

export type ClaimResponse = 'claimed' | 'pending' | 'declined' | 'expired';
export type ResponseIntent = 'accept' | 'decline' | null;
/** What the owner really wants to see: did this invitee rebook, say no, or not respond. */
export type RebookOutcome = 'rebooked' | 'declined' | 'noResponse';

export interface RebookManagePlayer {
  key: string; // player_id or `g:${guest_player_id}`
  playerId: string | null;
  guestPlayerId: string | null;
  name: string;
  response: ClaimResponse;
  /** The button the player clicked on the invite (recorded even if they never finished). */
  responseIntent: ResponseIntent;
  paid: boolean;
  hasInvoice: boolean;
  /** True once the initial rebook invite email was sent to this invitee (any of their
   *  claims carries invited_at). False = still un-emailed (or emailless guest). */
  invited: boolean;
  /** Every claim id for this invitee in the group — the levers for "free this seat". */
  claimIds: string[];
  /** When this invitee was last sent a rebook reminder (max across their claims). */
  lastRemindedAt: string | null;
  /** False only for a GUEST with no email on file — a registered player always has an
   *  auth email. These invitees were never actually emailed (RB05); the owner can copy
   *  their claim link and share it manually. */
  hasEmail: boolean;
  /** A representative claim_token so the owner can copy this invitee's claim link
   *  (`/nl/claim/:token`) and share it manually (WhatsApp etc.). */
  claimToken: string | null;
  /** Public token of this invitee's UNPAID rebook invoice (own single invoice, else their group's)
   *  — `/pay/:token` goes straight to the Mollie checkout, for manual sharing. Null when paid or
   *  no invoice was minted yet. */
  payToken: string | null;
}

/**
 * Collapse the raw claim state + intent into the single answer the owner cares about.
 * An explicit "No" (status declined OR a recorded decline intent) is a decline even if the
 * claim technically still reads 'pending'; an expired/pending claim with no decline intent is
 * a non-response; a 'clicked Yes but never paid' claim (accept intent, still pending) is NOT
 * counted as rebooked (there is no booking) — it surfaces separately via clickedYesUnpaid.
 */
export function rebookPlayerOutcome(p: Pick<RebookManagePlayer, 'response' | 'responseIntent'>): RebookOutcome {
  if (p.response === 'claimed') return 'rebooked';
  if (p.response === 'declined' || p.responseIntent === 'decline') return 'declined';
  return 'noResponse';
}

/**
 * Clicked "Yes" on the invite but never completed (no booking yet) AND can still act — i.e. the
 * claim is still pending. Gated on 'pending' (not merely !== 'claimed') so an EXPIRED accept-intent
 * claim, which can no longer be completed, is not counted as an actionable "started but didn't pay"
 * (and doesn't collide with the "verlopen" chip).
 */
export function clickedYesUnpaid(p: Pick<RebookManagePlayer, 'response' | 'responseIntent'>): boolean {
  return p.responseIntent === 'accept' && p.response === 'pending';
}

export interface RebookOutcomeSummary {
  invited: number;
  rebooked: number;
  declined: number;
  noResponse: number;
  clickedYesUnpaid: number;
}

/**
 * Assemble the headline "X invited · Y rebooked · Z declined · W no response" totals.
 *
 * Counts DISTINCT invitees, not group-memberships: one round has many weekly series (one group
 * per series), and a player enrolled in two series (e.g. Mon 18:00 AND Wed 20:00) appears once per
 * group. Without dedup, `invited` and every bucket inflate. We collapse each identity (`p.key`) to
 * its strongest outcome across all their series — rebooked > declined > noResponse — so someone who
 * rebooked one slot but let another lapse reads as "rebooked", matching what the owner intuitively
 * expects from "who rebooked / who said no".
 */
const OUTCOME_RANK: Record<RebookOutcome, number> = { rebooked: 3, declined: 2, noResponse: 1 };
export function summariseRebookOutcomes(players: RebookManagePlayer[]): RebookOutcomeSummary {
  const byKey = new Map<string, { outcome: RebookOutcome; clickedYes: boolean }>();
  for (const p of players) {
    const outcome = rebookPlayerOutcome(p);
    const clickedYes = clickedYesUnpaid(p);
    const prev = byKey.get(p.key);
    if (!prev) {
      byKey.set(p.key, { outcome, clickedYes });
    } else {
      byKey.set(p.key, {
        outcome: OUTCOME_RANK[outcome] > OUTCOME_RANK[prev.outcome] ? outcome : prev.outcome,
        clickedYes: prev.clickedYes || clickedYes,
      });
    }
  }
  const s: RebookOutcomeSummary = { invited: byKey.size, rebooked: 0, declined: 0, noResponse: 0, clickedYesUnpaid: 0 };
  for (const { outcome, clickedYes } of byKey.values()) {
    s[outcome] += 1;
    // "clicked Yes, unpaid" is a sub-note of not-yet-rebooked; if they completed any series, drop it.
    if (clickedYes && outcome !== 'rebooked') s.clickedYesUnpaid += 1;
  }
  return s;
}

export interface RebookManageGroup {
  groupId: string; // rebook_group_id (or slot id fallback)
  weekday: string;
  time: string;
  trainerId: string | null;
  locationId: string | null;
  trainerName: string | null;
  locationName: string | null;
  slotIds: string[];
  capacity: number;
  status: GroupStatus;
  players: RebookManagePlayer[];
  /** The cycle this group belongs to (per-series split): set on multi-cycle rounds so the manage
   *  page can label which new cycle each group became; null/absent for a single-cycle round. */
  cycleId?: string | null;
  cycleName?: string | null;
}

export interface RebookManageData {
  cycleName: string;
  /** The academy's saved invite message for this round (cycles.settings.rebook_invitation_message);
   *  used to pre-fill the reminder composer. '' when none was set. */
  invitationMessage: string;
  /** The academy's saved reminder text for this round (used by auto-rebook-reminder + to pre-fill
   *  the manual reminder composer). '' when none was set. */
  reminderMessage: string;
  reminderSubject: string;
  groups: RebookManageGroup[];
  counts: Record<GroupStatus, number>;
  /** Per-invitee headline (invited/rebooked/declined/no-response) — the owner's "who said no". */
  summary: RebookOutcomeSummary;
  paidCount: number;
  unpaidCount: number;
  /** € invoiced-and-paid vs € invoiced-and-still-outstanding across the round (single +
   *  group rebook invoices). Not "expected" — deferred rounds may not be invoiced yet. */
  paidAmount: number;
  outstandingAmount: number;
  /** Invite reps emailed vs total (per group+player) — "X of Y invites sent". */
  invitesSent: number;
  invitesTotal: number;
  /** Representative invites still un-sent (awaiting + never emailed) — for "resume sending". */
  uninvitedCount: number;
  /** All cycle ids of this round (a per-series run has >1). Resume-send MUST drain across ALL of them
   *  (round-scoped), else invites stranded on sibling cycles can never be sent. Length 1 for legacy
   *  single-cycle rounds. */
  cycleIds: string[];
  /** settings.rebook_round_id — the id the "add groups to this round" wizard extends. Null for
   *  legacy single-cycle rounds (created before per-series rounds existed), which can't be extended. */
  roundId: string | null;
}

interface SlotRow {
  id: string;
  start_time: string;
  trainer_id: string | null;
  location_id: string | null;
  max_participants: number | null;
  is_public: boolean | null;
  public_release_status: PublicReleaseStatus | null;
  priority_window_ends_at: string | null;
  member_window_ends_at: string | null;
  cyclus_id?: string | null;
}

/** Manager-facing slot phase from the window timestamps (no viewer context). Mirrors
 *  getSlotVisibility's precedence but answers "where in its lifecycle is this slot". */
export function slotPhase(
  slot: Pick<SlotRow, 'priority_window_ends_at' | 'member_window_ends_at' | 'public_release_status'>,
  now: Date = new Date(),
): SlotPhase {
  const nowMs = now.getTime();
  if (slot.priority_window_ends_at && new Date(slot.priority_window_ends_at).getTime() > nowMs) return 'priority';
  if (slot.member_window_ends_at && new Date(slot.member_window_ends_at).getTime() > nowMs) return 'members';
  if (slot.public_release_status === 'held' || slot.public_release_status === 'pending_admin_review') return 'held';
  return 'public'; // 'released' or auto-released after the member window lapsed
}

/** The single headline status for a group. anyClaimed wins (a kept spot is the
 *  headline); otherwise the lifecycle phase or the fully-declined state. */
export function deriveGroupStatus(claims: ClaimsState, phase: SlotPhase): GroupStatus {
  if (claims === 'rebooked') return 'rebooked';
  if (phase === 'public') return 'public';
  if (phase === 'members') return 'members';
  if (claims === 'declined') return 'declined';
  return 'awaiting';
}

function claimsStateOf(responses: ClaimResponse[]): ClaimsState {
  if (responses.length === 0) return 'none';
  if (responses.some((r) => r === 'claimed')) return 'rebooked';
  if (responses.some((r) => r === 'pending')) return 'awaiting';
  return 'declined'; // all declined/expired
}

export type SingleInvoiceRow = { player_id: string | null; guest_player_id: string | null; status: string; total?: number | null; public_token?: string | null };
export type GroupInvoiceRow = { rebook_group_id: string | null; status: string; total?: number | null; public_token?: string | null };

/**
 * Sum the round's invoiced money: € already paid vs € still outstanding. Single-claim and
 * group invoices are distinct invoice rows (one per player vs one per group), so both are
 * summed. Cancelled invoices are excluded; 'paid' → paidAmount, anything else → outstanding.
 * Pure + exported so the owner's money headline is unit-tested.
 */
export function sumRebookInvoiceAmounts(
  singleInvoices: SingleInvoiceRow[],
  groupInvoices: GroupInvoiceRow[],
): { paidAmount: number; outstandingAmount: number } {
  let paidAmount = 0;
  let outstandingAmount = 0;
  for (const inv of [...singleInvoices, ...groupInvoices]) {
    if (inv.status === 'cancelled') continue;
    const amount = Number(inv.total) || 0;
    if (inv.status === 'paid') paidAmount += amount;
    else outstandingAmount += amount;
  }
  return { paidAmount, outstandingAmount };
}

/**
 * Resolve rebook paid/invoiced state per player. Rebook invoices are NEVER tagged `cycle_id`:
 * single-claim invoices carry `rebook_cyclus_id` (keyed to a player identity), group invoices
 * carry `rebook_group_id` (one payment covering EVERY member of that group). So a member is
 * paid/invoiced iff their own single invoice OR their group's invoice is active/paid. Pure +
 * exported so the invariant (that the academy's "who paid?" view is correct) is unit-tested.
 */
export function buildRebookPaidResolver(
  singleInvoices: SingleInvoiceRow[],
  groupInvoices: GroupInvoiceRow[],
) {
  const paidKeys = new Set<string>();
  const invoicedKeys = new Set<string>();
  for (const inv of singleInvoices) {
    const key = inv.player_id ?? (inv.guest_player_id ? `g:${inv.guest_player_id}` : null);
    if (!key || inv.status === 'cancelled') continue;
    invoicedKeys.add(key);
    if (inv.status === 'paid') paidKeys.add(key);
  }
  const paidGroups = new Set<string>();
  const invoicedGroups = new Set<string>();
  for (const inv of groupInvoices) {
    if (!inv.rebook_group_id || inv.status === 'cancelled') continue;
    invoicedGroups.add(inv.rebook_group_id);
    if (inv.status === 'paid') paidGroups.add(inv.rebook_group_id);
  }
  // Pay-link tokens for UNPAID (not paid, not cancelled) invoices: /pay/<token> goes straight to
  // the Mollie checkout, so the academy can share it manually (WhatsApp etc.) with someone who
  // accepted but never finished paying. Keyed like paid/invoiced: own single invoice first, else
  // the group's one shared invoice (any member may complete a group payment — deliberate).
  const payTokenByKey = new Map<string, string>();
  for (const inv of singleInvoices) {
    const key = inv.player_id ?? (inv.guest_player_id ? `g:${inv.guest_player_id}` : null);
    if (!key || inv.status === 'cancelled' || inv.status === 'paid' || !inv.public_token) continue;
    payTokenByKey.set(key, inv.public_token);
  }
  const payTokenByGroup = new Map<string, string>();
  for (const inv of groupInvoices) {
    if (!inv.rebook_group_id || inv.status === 'cancelled' || inv.status === 'paid' || !inv.public_token) continue;
    payTokenByGroup.set(inv.rebook_group_id, inv.public_token);
  }
  return {
    isPaid: (pk: string, groupId: string | null) =>
      paidKeys.has(pk) || (groupId != null && paidGroups.has(groupId)),
    hasInvoice: (pk: string, groupId: string | null) =>
      invoicedKeys.has(pk) || (groupId != null && invoicedGroups.has(groupId)),
    /** Public /pay token of the player's UNPAID invoice (own single first, else their group's). */
    getPayToken: (pk: string, groupId: string | null): string | null =>
      payTokenByKey.get(pk) ?? (groupId != null ? payTokenByGroup.get(groupId) ?? null : null),
  };
}

export async function getCycleRebookStatus(cycleId: string): Promise<RebookManageData> {
  // ROUND AGGREGATION: a per-series rebook run creates one cycle per series, all sharing
  // settings.rebook_round_id. The manage/progress view shows the WHOLE round combined (the owner's
  // "one combined view on how the rebooking is going"), while the cycles stay separate elsewhere.
  // Legacy single-cycle rounds (no rebook_round_id) resolve to just [cycleId] → identical to before.
  const { data: cycle } = await supabase
    .from('cycles').select('name, owner_type, owner_id, settings').eq('id', cycleId).maybeSingle();
  const roundSettings = (cycle?.settings ?? {}) as Record<string, unknown>;
  const roundId = typeof roundSettings.rebook_round_id === 'string' ? roundSettings.rebook_round_id : null;
  let cycleIds = [cycleId];
  const cycleNameById = new Map<string, string>([[cycleId, cycle?.name ?? '']]);
  if (roundId && cycle?.owner_id) {
    const { data: siblings } = await supabase
      .from('cycles')
      .select('id, name')
      .eq('owner_type', cycle.owner_type)
      .eq('owner_id', cycle.owner_id)
      // Match this engine's own cycles only (rebook marker) sharing the round id.
      .eq('settings->>rebook_round_id', roundId)
      .not('settings->>rebook_payment_mode', 'is', null);
    if (siblings && siblings.length > 0) {
      cycleIds = siblings.map((c) => c.id);
      cycleNameById.clear();
      for (const c of siblings) cycleNameById.set(c.id, c.name);
    }
  }
  const { rows: slots } = await fetchAllPages<SlotRow>((from, to) =>
    supabase
      .from('availability_slots')
      .select('id, start_time, trainer_id, location_id, max_participants, is_public, public_release_status, priority_window_ends_at, member_window_ends_at, cyclus_id')
      .in('cyclus_id', cycleIds)
      .order('id')
      .range(from, to),
  );
  const settingsObj = (cycle?.settings ?? null) as {
    rebook_invitation_message?: unknown; rebook_reminder_message?: unknown; rebook_reminder_subject?: unknown;
  } | null;
  const invitationMessage = typeof settingsObj?.rebook_invitation_message === 'string' ? settingsObj.rebook_invitation_message : '';
  const reminderMessage = typeof settingsObj?.rebook_reminder_message === 'string' ? settingsObj.rebook_reminder_message : '';
  const reminderSubject = typeof settingsObj?.rebook_reminder_subject === 'string' ? settingsObj.rebook_reminder_subject : '';
  const slotRows = slots;
  // For a multi-cycle round, the header shows the round label; a single cycle shows its own name.
  const displayName = (roundId && cycleIds.length > 1 && typeof roundSettings.rebook_round_label === 'string'
    ? roundSettings.rebook_round_label
    : cycle?.name) ?? '';
  const empty: RebookManageData = {
    cycleName: displayName,
    invitationMessage,
    reminderMessage,
    reminderSubject,
    groups: [],
    counts: { rebooked: 0, awaiting: 0, declined: 0, members: 0, public: 0 },
    summary: { invited: 0, rebooked: 0, declined: 0, noResponse: 0, clickedYesUnpaid: 0 },
    paidCount: 0,
    unpaidCount: 0,
    paidAmount: 0,
    outstandingAmount: 0,
    invitesSent: 0,
    invitesTotal: 0,
    uninvitedCount: 0,
    cycleIds,
    roundId,
  };
  if (slotRows.length === 0) return empty;
  const slotById = new Map(slotRows.map((s) => [s.id, s]));
  const slotIds = slotRows.map((s) => s.id);

  // P1-2: reminded_at was added by an owner-deployed migration; if it isn't live yet the select
  // 400s and the whole management view would blank. Retry without it (fallback null), mirroring
  // getMyPendingPriorityClaims's deploy-window tolerance.
  type ClaimRow = {
    id: string;
    slot_id: string;
    player_id: string | null;
    guest_player_id: string | null;
    status: string;
    rebook_group_id: string | null;
    invited_at?: string | null;
    claim_token?: string | null;
    reminded_at?: string | null;
    response_intent?: string | null;
    response_intent_at?: string | null;
  };
  const claimCols = 'id, slot_id, player_id, guest_player_id, status, rebook_group_id, invited_at, claim_token';
  // reminded_at + response_intent were both added by owner-deployed migrations; if either isn't
  // live yet the select 400s and the whole management view would blank. Fall back to the base
  // columns (optional fields → undefined), mirroring getMyPendingPriorityClaims's tolerance.
  // Paginated (see fetchAllPages): a 100+ invitee round has 1500+ claims — a one-shot read
  // silently truncated at 1000 and dropped the invited_at representative rows.
  const primaryClaims = await fetchAllPages<ClaimRow>((from, to) =>
    supabase
      .from('slot_priority_claims')
      // response_intent/response_intent_at are real columns missing from the generated types
      // (types.ts drift, like rebook_cyclus_id) — the select typechecks via `as unknown` and the
      // runtime values are unchanged.
      .select(`${claimCols}, reminded_at, response_intent, response_intent_at`)
      .in('slot_id', slotIds)
      .order('id')
      .range(from, to),
  );
  let claimRows = primaryClaims.rows;
  if (
    primaryClaims.error &&
    (primaryClaims.error.code === '42703' ||
      /reminded_at|response_intent/.test(primaryClaims.error.message ?? ''))
  ) {
    const fb = await fetchAllPages<ClaimRow>((from, to) =>
      supabase.from('slot_priority_claims').select(claimCols).in('slot_id', slotIds).order('id').range(from, to),
    );
    claimRows = fb.rows;
  }

  // P1-1: rebook invoices are NEVER tagged cycle_id — single-claim invoices carry rebook_cyclus_id,
  // group invoices carry rebook_group_id. Read paid/invoiced via those keys (reading cycle_id showed
  // every rebooked player as unpaid). A group invoice is ONE payment covering all its members, so its
  // paid/invoiced state propagates to every member of that group.
  const groupIds = [...new Set(claimRows.map((c) => c.rebook_group_id).filter(Boolean))] as string[];
  const singleRes = await supabase
    .from('invoices').select('player_id, guest_player_id, status, total, public_token')
    // rebook_cyclus_id is a real column missing from the generated types (types.ts drift);
    // cast the key to a known column so `.in` type-resolves — the runtime value is unchanged.
    // Round-aware: single-claim invoices span every sibling cycle of the round.
    .in('rebook_cyclus_id' as 'id', cycleIds);
  const singleInvoices = (singleRes.data ?? []) as SingleInvoiceRow[];
  let groupInvoices: GroupInvoiceRow[] = [];
  if (groupIds.length) {
    const groupRes = await supabase.from('invoices').select('rebook_group_id, status, total, public_token').in('rebook_group_id', groupIds);
    groupInvoices = (groupRes.data ?? []) as GroupInvoiceRow[];
  }

  // Names.
  const playerIds = [...new Set(claimRows.map((c) => c.player_id).filter(Boolean))] as string[];
  const guestIds = [...new Set(claimRows.map((c) => c.guest_player_id).filter(Boolean))] as string[];
  const [{ data: profiles }, { data: guests }] = await Promise.all([
    playerIds.length ? supabase.from('profiles_public').select('id, full_name').in('id', playerIds) : Promise.resolve({ data: [] }),
    guestIds.length ? supabase.from('guest_players').select('id, full_name, email').in('id', guestIds) : Promise.resolve({ data: [] }),
  ]);
  const nameByKey = new Map<string, string>();
  // RB05: which invitees have NO email. Only guests can be emailless — a registered player
  // always has an auth email — so a guest key not in this set is the emailless case.
  const guestHasEmail = new Set<string>();
  for (const p of (profiles ?? []) as Array<{ id: string; full_name: string | null }>) nameByKey.set(p.id, (p.full_name ?? '').trim() || '—');
  for (const g of (guests ?? []) as Array<{ id: string; full_name: string | null; email: string | null }>) {
    nameByKey.set(`g:${g.id}`, (g.full_name ?? '').trim() || '—');
    if (g.email?.trim()) guestHasEmail.add(`g:${g.id}`);
  }

  // Single-claim invoices → per identity; group invoices → per group (propagated to members).
  const { isPaid, hasInvoice: hasInvoiceFor, getPayToken } = buildRebookPaidResolver(singleInvoices, groupInvoices);

  const keyOf = (c: { player_id: string | null; guest_player_id: string | null }) =>
    c.player_id ?? `g:${c.guest_player_id}`;
  // Strongest response per (group, player) — a player on a multi-week series has one
  // claim per slot; collapse to claimed > pending > declined.
  const rank = { claimed: 3, pending: 2, declined: 1, expired: 0 } as const;

  // Per (group, player): did ANY of their claims get an invite email? The sender
  // stamps exactly one representative per (group, player), so a single invited_at
  // means that invitee was emailed. Used to count how many invites are still un-sent.
  const invitedKeys = new Set<string>();
  const groupsMap = new Map<string, { slotIds: Set<string>; players: Map<string, RebookManagePlayer> }>();
  for (const c of claimRows) {
    const groupKey = c.rebook_group_id ?? c.slot_id;
    let g = groupsMap.get(groupKey);
    if (!g) { g = { slotIds: new Set(), players: new Map() }; groupsMap.set(groupKey, g); }
    g.slotIds.add(c.slot_id);
    const pk = keyOf(c);
    if (c.invited_at) invitedKeys.add(`${groupKey}|${pk}`);
    const resp: ClaimResponse =
      c.status === 'claimed' || c.status === 'pending' || c.status === 'declined' || c.status === 'expired'
        ? c.status
        : 'expired';
    const existing = g.players.get(pk);
    if (!existing || rank[resp] > rank[existing.response]) {
      g.players.set(pk, {
        key: pk,
        playerId: c.player_id,
        guestPlayerId: c.guest_player_id,
        name: nameByKey.get(pk) ?? '—',
        response: resp,
        responseIntent: existing?.responseIntent ?? null,
        paid: isPaid(pk, c.rebook_group_id),
        hasInvoice: hasInvoiceFor(pk, c.rebook_group_id),
        payToken: getPayToken(pk, c.rebook_group_id),
        invited: existing?.invited ?? false,
        claimIds: existing?.claimIds ?? [],
        lastRemindedAt: existing?.lastRemindedAt ?? null,
        hasEmail: c.player_id ? true : guestHasEmail.has(pk),
        claimToken: c.claim_token ?? existing?.claimToken ?? null,
      });
    }
    // Accumulate this claim's id + whether it was emailed, across ALL of the invitee's claims
    // (independent of which one won the response rank above).
    const acc = g.players.get(pk)!;
    if (c.id && !acc.claimIds.includes(c.id)) acc.claimIds.push(c.id);
    if (c.invited_at) acc.invited = true;
    // Accumulate the most-recent reminder + the recorded intent across this player's claims,
    // independent of which claim won the response rank above. Intent lives on the emailed
    // representative claim only; a recorded "decline" wins over "accept" (they said no somewhere).
    const cur = g.players.get(pk)!;
    if (c.reminded_at && (!cur.lastRemindedAt || new Date(c.reminded_at) > new Date(cur.lastRemindedAt))) {
      cur.lastRemindedAt = c.reminded_at;
    }
    if (!cur.claimToken && c.claim_token) cur.claimToken = c.claim_token; // capture a token from any claim (RB05)
    if (c.response_intent === 'decline') cur.responseIntent = 'decline';
    else if (c.response_intent === 'accept' && cur.responseIntent !== 'decline') cur.responseIntent = 'accept';
  }

  const now = new Date();
  const groups: RebookManageGroup[] = [];
  for (const [groupId, g] of groupsMap) {
    const ids = [...g.slotIds];
    const reps = ids.map((id) => slotById.get(id)).filter(Boolean) as SlotRow[];
    const rep = reps.sort((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime())[0];
    if (!rep) continue;
    const players = [...g.players.values()].sort((a, b) => a.name.localeCompare(b.name, 'nl'));
    const status = deriveGroupStatus(claimsStateOf(players.map((p) => p.response)), slotPhase(rep, now));
    const d = new Date(rep.start_time);
    groups.push({
      groupId,
      weekday: new Intl.DateTimeFormat('nl-NL', { weekday: 'long' }).format(d),
      time: new Intl.DateTimeFormat('nl-NL', { hour: '2-digit', minute: '2-digit' }).format(d),
      trainerId: rep.trainer_id,
      locationId: rep.location_id,
      trainerName: null,
      locationName: null,
      slotIds: ids,
      capacity: rep.max_participants ?? 0,
      status,
      players,
      // Only meaningful when the round spans >1 cycle; the UI shows it as a per-group badge.
      cycleId: cycleIds.length > 1 ? (rep.cyclus_id ?? null) : null,
      cycleName: cycleIds.length > 1 ? (rep.cyclus_id ? cycleNameById.get(rep.cyclus_id) ?? null : null) : null,
    });
  }
  groups.sort((a, b) => a.weekday.localeCompare(b.weekday) || a.time.localeCompare(b.time));

  // Resolve trainer + location display names for the table columns/filters.
  const trainerIds = [...new Set(groups.map((g) => g.trainerId).filter((x): x is string => !!x))];
  const locationIds = [...new Set(groups.map((g) => g.locationId).filter((x): x is string => !!x))];
  const [trainerNames, { data: locs }] = await Promise.all([
    trainerIds.length
      ? fetchTrainerDisplayNamesByProfileIds(trainerIds, supabase, 'rebookManage')
      : Promise.resolve(new Map<string, string>()),
    locationIds.length
      ? supabase.from('locations').select('id, name').in('id', locationIds)
      : Promise.resolve({ data: [] as Array<{ id: string; name: string | null }> }),
  ]);
  const locNameById = new Map<string, string>();
  for (const l of (locs ?? []) as Array<{ id: string; name: string | null }>) {
    locNameById.set(l.id, (l.name ?? '').trim());
  }
  for (const g of groups) {
    g.trainerName = g.trainerId ? (trainerNames.get(g.trainerId) ?? null) : null;
    g.locationName = g.locationId ? (locNameById.get(g.locationId) || null) : null;
  }

  const counts: Record<GroupStatus, number> = { rebooked: 0, awaiting: 0, declined: 0, members: 0, public: 0 };
  for (const grp of groups) counts[grp.status] += 1;
  const allPlayers = groups.flatMap((g) => g.players);
  // Only count players who actually rebooked (response==='claimed'). A group-paid invoice's
  // paid flag propagates to a removed/declined member's still-group-tagged claim, so gating on
  // 'claimed' (symmetric with unpaidCount) keeps the headline paid figure from over-counting them.
  const paidCount = allPlayers.filter((p) => p.response === 'claimed' && p.paid).length;
  const unpaidCount = allPlayers.filter((p) => p.response === 'claimed' && !p.paid).length;
  const summary = summariseRebookOutcomes(allPlayers);
  // Invites still to send: (group, player) representatives who are still awaiting a
  // response AND never received an invite email. Drives the "resume sending" control
  // — an estimate; the resumable drain (send-priority-claim-invitation cycleId mode)
  // is the source of truth for exactly which invites go out.
  // Un-sent invites: pending reps never emailed. Emailless reps (guest OR registered)
  // are stamped invited_at by the sender's drain (they can't be emailed), so they fall
  // out of this count once a drain has touched the round — the banner converges.
  let uninvitedCount = 0;
  let invitesSent = 0;
  let invitesTotal = 0;
  for (const g of groups) {
    for (const p of g.players) {
      invitesTotal += 1;
      if (p.invited) invitesSent += 1;
      if (p.response === 'pending' && !invitedKeys.has(`${g.groupId}|${p.key}`)) uninvitedCount += 1;
    }
  }
  const { paidAmount, outstandingAmount } = sumRebookInvoiceAmounts(singleInvoices, groupInvoices);

  return {
    cycleName: displayName,
    invitationMessage,
    reminderMessage,
    reminderSubject,
    groups,
    counts,
    summary,
    paidCount,
    unpaidCount,
    paidAmount,
    outstandingAmount,
    invitesSent,
    invitesTotal,
    uninvitedCount,
    cycleIds,
    roundId,
  };
}

// ===== Bulk levers (resilient, per-slot) =====

const reasonOf = (e: unknown): string => {
  const err = e as { message?: string };
  return err?.message || String(e);
};

async function bulkSlots(slotIds: string[], fn: (id: string) => Promise<void>): Promise<BulkResult<string>> {
  let succeeded = 0;
  const failed: BulkFailure<string>[] = [];
  for (const id of slotIds) {
    try { await fn(id); succeeded++; } catch (e) { failed.push({ item: id, reason: reasonOf(e) }); }
  }
  return { succeeded, failed };
}

/** Open the selected sessions to everyone (public_release_status='released', is_public=true). */
export const bulkReleaseToPublic = (slotIds: string[]) => bulkSlots(slotIds, releaseSlotToPublic);

/** Hide the selected sessions from the public again (public_release_status='held'). */
export const bulkHoldSlots = (slotIds: string[]) => bulkSlots(slotIds, holdSlotForReview);

// ===== Bulk reminder email =====

export interface RebookReminderTarget {
  player_id: string | null;
  guest_player_id: string | null;
}

export interface RebookReminderResult {
  ok: boolean;
  sent: number;
  skipped: number;
  failed: number;
  reason?: string;
}

/** Email a custom reminder to the selected players of this cycle (server resolves + scopes). */
export async function sendRebookReminder(args: {
  cycleId: string;
  targets: RebookReminderTarget[];
  subject: string;
  message: string;
}): Promise<RebookReminderResult> {
  const { data, error } = await supabase.functions.invoke('send-rebook-reminder', { body: args });
  if (error) return { ok: false, sent: 0, skipped: 0, failed: args.targets.length, reason: error.message };
  const r = (data ?? {}) as Partial<RebookReminderResult>;
  return { ok: Boolean(r.ok), sent: Number(r.sent ?? 0), skipped: Number(r.skipped ?? 0), failed: Number(r.failed ?? 0), reason: r.reason };
}

// ===== Discovery: list an academy's rebook rounds =====

export interface RebookRound {
  id: string; // the PRIMARY cycle id (where 'Beheer' lands; its manage page aggregates the round)
  name: string;
  startDate: string | null; // yyyy-mm-dd
  status: string; // draft | open | closed | ...
  archived: boolean;
  /** All cycle ids of this round (a per-series run has >1). Length 1 for legacy single-cycle rounds. */
  cycleIds: string[];
}

/** The academy's rebooked "new round" cycles (type='cyclus' with a rebook payment
 *  mode in settings) — the cycles the rebook management view manages. Lets the UI
 *  offer a way back into each round's overview after the post-launch redirect.
 *  Archived rounds are hidden unless `includeArchived` is set (so the owner can find +
 *  restore them). */
export async function listRebookRounds(
  academyProfileId: string,
  opts?: { includeArchived?: boolean },
): Promise<RebookRound[]> {
  const { data, error } = await supabase
    .from('cycles')
    .select('id, name, start_date, status, settings, created_at')
    .eq('owner_type', 'academy')
    .eq('owner_id', academyProfileId)
    .eq('type', 'cyclus')
    .not('settings->>rebook_payment_mode', 'is', null)
    .order('created_at', { ascending: false });
  if (error) throw error;
  // GROUP BY ROUND: a per-series run creates one cycle per series sharing settings.rebook_round_id.
  // Collapse them into ONE round entry (label from rebook_round_label) so the list shows one row per
  // round, not per cycle. Legacy cycles without a round id key on their own id → one row each, as before.
  // 'created_at DESC' order is preserved (first-seen key wins → newest round first).
  type Row = { id: string; name: string; start_date: string | null; status: string; settings: Record<string, unknown> | null };
  const rows = (data ?? []) as unknown as Row[];
  const byRound = new Map<string, RebookRound>();
  for (const c of rows) {
    const s = c.settings ?? {};
    const roundId = typeof s.rebook_round_id === 'string' ? s.rebook_round_id : c.id;
    const existing = byRound.get(roundId);
    if (existing) {
      existing.cycleIds.push(c.id);
      // Any non-archived sibling makes the round visible.
      if (s.rebook_archived !== true) existing.archived = false;
      continue;
    }
    byRound.set(roundId, {
      id: c.id,
      name: (typeof s.rebook_round_label === 'string' && s.rebook_round_label ? s.rebook_round_label : (c.name ?? '')).trim(),
      startDate: c.start_date ?? null,
      status: c.status ?? 'draft',
      archived: s.rebook_archived === true,
      cycleIds: [c.id],
    });
  }
  return [...byRound.values()].filter((r) => opts?.includeArchived || !r.archived);
}

/**
 * Archive (or restore) a rebook round: flips cycles.settings.rebook_archived, which only
 * hides it from the rounds list. Touches NO bookings, sessions or invoices — reads the
 * current settings and rewrites the merged object (updateCycleSettings overwrites wholesale).
 */
export async function setRebookRoundArchived(cycleId: string, archived: boolean): Promise<void> {
  const { data, error } = await supabase.from('cycles').select('settings, owner_type, owner_id').eq('id', cycleId).maybeSingle();
  if (error) throw error;
  const current = (data?.settings ?? {}) as Record<string, unknown>;
  // Archive/restore the WHOLE round (every sibling cycle sharing rebook_round_id), so a per-series
  // round hides/restores as one unit. Legacy single-cycle rounds have no round id → just this cycle.
  const roundId = typeof current.rebook_round_id === 'string' ? current.rebook_round_id : null;
  if (roundId && data?.owner_id) {
    const { data: siblings } = await supabase
      .from('cycles')
      .select('id, settings')
      .eq('owner_type', data.owner_type)
      .eq('owner_id', data.owner_id)
      .eq('settings->>rebook_round_id', roundId);
    if (siblings && siblings.length > 0) {
      await Promise.all(siblings.map((c) =>
        updateCycleSettings(c.id, { ...((c.settings ?? {}) as Record<string, unknown>), rebook_archived: archived } as unknown as CycleSettings),
      ));
      return;
    }
  }
  await updateCycleSettings(cycleId, { ...current, rebook_archived: archived } as unknown as CycleSettings);
}

/**
 * "Free the seat": the invitee isn't coming back, so cancel their reserved booking(s) on the
 * round's sessions (which resyncs the split invoices) AND decline their claim(s) so the round
 * overview reads "not rebooked" and the seat re-opens to members/public. Does NOT credit/refund
 * a paid invoice — the owner handles that separately (the UI warns when an invoice was paid).
 */
export interface FreeSeatResult {
  cancelledCount: number;
  declinedCount: number;
  cancelError: string | null;
  syncError: string | null;
}
export async function freePlayerRebookSeat(args: {
  slotIds: string[];
  player: { playerId: string | null; guestPlayerId: string | null };
  claimIds: string[];
}): Promise<FreeSeatResult> {
  const cancel = await cancelPlayerBookingsInCycle(args.slotIds, args.player);
  let declinedCount = 0;
  const declineErrors: string[] = [];
  for (const id of args.claimIds) {
    try { await declineClaimAsManager(id, 'Manager: niet herboekt'); declinedCount += 1; }
    catch (e) { declineErrors.push(reasonOf(e)); }
  }
  return {
    cancelledCount: cancel.cancelledCount,
    declinedCount,
    cancelError: cancel.cancelError ? reasonOf(cancel.cancelError) : (declineErrors[0] ?? null),
    syncError: cancel.syncError ? reasonOf(cancel.syncError) : null,
  };
}
