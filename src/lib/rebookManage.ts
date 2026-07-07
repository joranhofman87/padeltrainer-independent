// Per-cycle rebook management: derive the status of each weekly session/group of a
// rebooked cycle (rebooked / awaiting / won't-rebook / open-to-members / open-to-public),
// with per-player response + paid status, plus the bulk levers (open to public / make
// private / send reminder). Read-only derivation — all signals already exist on
// availability_slots + slot_priority_claims + invoices.
import { supabase } from '@/lib/supabaseClient';
import { releaseSlotToPublic, holdSlotForReview, type PublicReleaseStatus } from '@/lib/priorityClaims';
import { fetchTrainerDisplayNamesByProfileIds } from '@/lib/trainerDisplayNames';
import type { BulkResult, BulkFailure } from '@/lib/academyPlayerBulk';

export type GroupStatus = 'rebooked' | 'awaiting' | 'declined' | 'members' | 'public';
type SlotPhase = 'priority' | 'members' | 'public' | 'held';
type ClaimsState = 'rebooked' | 'awaiting' | 'declined' | 'none';

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
  /** When this invitee was last sent a rebook reminder (max across their claims). */
  lastRemindedAt: string | null;
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
}

export interface RebookManageData {
  cycleName: string;
  /** The academy's saved invite message for this round (cycles.settings.rebook_invitation_message);
   *  used to pre-fill the reminder composer. '' when none was set. */
  invitationMessage: string;
  groups: RebookManageGroup[];
  counts: Record<GroupStatus, number>;
  /** Per-invitee headline (invited/rebooked/declined/no-response) — the owner's "who said no". */
  summary: RebookOutcomeSummary;
  paidCount: number;
  unpaidCount: number;
  /** Representative invites still un-sent (awaiting + never emailed) — for "resume sending". */
  uninvitedCount: number;
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

export type SingleInvoiceRow = { player_id: string | null; guest_player_id: string | null; status: string };
export type GroupInvoiceRow = { rebook_group_id: string | null; status: string };

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
  return {
    isPaid: (pk: string, groupId: string | null) =>
      paidKeys.has(pk) || (groupId != null && paidGroups.has(groupId)),
    hasInvoice: (pk: string, groupId: string | null) =>
      invoicedKeys.has(pk) || (groupId != null && invoicedGroups.has(groupId)),
  };
}

export async function getCycleRebookStatus(cycleId: string): Promise<RebookManageData> {
  const [{ data: cycle }, { data: slots }] = await Promise.all([
    supabase.from('cycles').select('name, settings').eq('id', cycleId).maybeSingle(),
    supabase
      .from('availability_slots')
      .select('id, start_time, trainer_id, location_id, max_participants, is_public, public_release_status, priority_window_ends_at, member_window_ends_at')
      .eq('cyclus_id', cycleId),
  ]);
  const invitationMessage = (() => {
    const s = (cycle?.settings ?? null) as { rebook_invitation_message?: unknown } | null;
    return typeof s?.rebook_invitation_message === 'string' ? s.rebook_invitation_message : '';
  })();
  const slotRows = (slots ?? []) as SlotRow[];
  const empty: RebookManageData = {
    cycleName: cycle?.name ?? '',
    invitationMessage,
    groups: [],
    counts: { rebooked: 0, awaiting: 0, declined: 0, members: 0, public: 0 },
    summary: { invited: 0, rebooked: 0, declined: 0, noResponse: 0, clickedYesUnpaid: 0 },
    paidCount: 0,
    unpaidCount: 0,
    uninvitedCount: 0,
  };
  if (slotRows.length === 0) return empty;
  const slotById = new Map(slotRows.map((s) => [s.id, s]));
  const slotIds = slotRows.map((s) => s.id);

  // P1-2: reminded_at was added by an owner-deployed migration; if it isn't live yet the select
  // 400s and the whole management view would blank. Retry without it (fallback null), mirroring
  // getMyPendingPriorityClaims's deploy-window tolerance.
  type ClaimRow = {
    slot_id: string;
    player_id: string | null;
    guest_player_id: string | null;
    status: string;
    rebook_group_id: string | null;
    invited_at?: string | null;
    reminded_at?: string | null;
    response_intent?: string | null;
    response_intent_at?: string | null;
  };
  const claimCols = 'id, slot_id, player_id, guest_player_id, status, rebook_group_id, invited_at';
  // reminded_at + response_intent were both added by owner-deployed migrations; if either isn't
  // live yet the select 400s and the whole management view would blank. Fall back to the base
  // columns (optional fields → undefined), mirroring getMyPendingPriorityClaims's tolerance.
  const primaryClaims = await supabase
    .from('slot_priority_claims')
    // response_intent/response_intent_at are real columns missing from the generated types
    // (types.ts drift, like rebook_cyclus_id) — the select typechecks via `as unknown` and the
    // runtime values are unchanged.
    .select(`${claimCols}, reminded_at, response_intent, response_intent_at`)
    .in('slot_id', slotIds);
  let claimData = primaryClaims.data as unknown as ClaimRow[] | null;
  if (
    primaryClaims.error &&
    (primaryClaims.error.code === '42703' ||
      /reminded_at|response_intent/.test(primaryClaims.error.message ?? ''))
  ) {
    const fb = await supabase.from('slot_priority_claims').select(claimCols).in('slot_id', slotIds);
    claimData = fb.data as ClaimRow[] | null;
  }
  const claimRows = (claimData ?? []) as ClaimRow[];

  // P1-1: rebook invoices are NEVER tagged cycle_id — single-claim invoices carry rebook_cyclus_id,
  // group invoices carry rebook_group_id. Read paid/invoiced via those keys (reading cycle_id showed
  // every rebooked player as unpaid). A group invoice is ONE payment covering all its members, so its
  // paid/invoiced state propagates to every member of that group.
  const groupIds = [...new Set(claimRows.map((c) => c.rebook_group_id).filter(Boolean))] as string[];
  const singleRes = await supabase
    .from('invoices').select('player_id, guest_player_id, status')
    // rebook_cyclus_id is a real column missing from the generated types (types.ts drift);
    // cast the key to a known column so `.eq` type-resolves — the runtime value is unchanged.
    .eq('rebook_cyclus_id' as 'id', cycleId);
  const singleInvoices = (singleRes.data ?? []) as SingleInvoiceRow[];
  let groupInvoices: GroupInvoiceRow[] = [];
  if (groupIds.length) {
    const groupRes = await supabase.from('invoices').select('rebook_group_id, status').in('rebook_group_id', groupIds);
    groupInvoices = (groupRes.data ?? []) as GroupInvoiceRow[];
  }

  // Names.
  const playerIds = [...new Set(claimRows.map((c) => c.player_id).filter(Boolean))] as string[];
  const guestIds = [...new Set(claimRows.map((c) => c.guest_player_id).filter(Boolean))] as string[];
  const [{ data: profiles }, { data: guests }] = await Promise.all([
    playerIds.length ? supabase.from('profiles_public').select('id, full_name').in('id', playerIds) : Promise.resolve({ data: [] }),
    guestIds.length ? supabase.from('guest_players').select('id, full_name').in('id', guestIds) : Promise.resolve({ data: [] }),
  ]);
  const nameByKey = new Map<string, string>();
  for (const p of (profiles ?? []) as Array<{ id: string; full_name: string | null }>) nameByKey.set(p.id, (p.full_name ?? '').trim() || '—');
  for (const g of (guests ?? []) as Array<{ id: string; full_name: string | null }>) nameByKey.set(`g:${g.id}`, (g.full_name ?? '').trim() || '—');

  // Single-claim invoices → per identity; group invoices → per group (propagated to members).
  const { isPaid, hasInvoice: hasInvoiceFor } = buildRebookPaidResolver(singleInvoices, groupInvoices);

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
        lastRemindedAt: existing?.lastRemindedAt ?? null,
      });
    }
    // Accumulate the most-recent reminder + the recorded intent across this player's claims,
    // independent of which claim won the response rank above. Intent lives on the emailed
    // representative claim only; a recorded "decline" wins over "accept" (they said no somewhere).
    const cur = g.players.get(pk)!;
    if (c.reminded_at && (!cur.lastRemindedAt || new Date(c.reminded_at) > new Date(cur.lastRemindedAt))) {
      cur.lastRemindedAt = c.reminded_at;
    }
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
  let uninvitedCount = 0;
  for (const g of groups) {
    for (const p of g.players) {
      if (p.response === 'pending' && !invitedKeys.has(`${g.groupId}|${p.key}`)) uninvitedCount += 1;
    }
  }

  return { cycleName: cycle?.name ?? '', invitationMessage, groups, counts, summary, paidCount, unpaidCount, uninvitedCount };
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
  id: string;
  name: string;
  startDate: string | null; // yyyy-mm-dd
  status: string; // draft | open | closed | ...
}

/** The academy's rebooked "new round" cycles (type='cyclus' with a rebook payment
 *  mode in settings) — the cycles the rebook management view manages. Lets the UI
 *  offer a way back into each round's overview after the post-launch redirect. */
export async function listRebookRounds(academyProfileId: string): Promise<RebookRound[]> {
  const { data, error } = await supabase
    .from('cycles')
    .select('id, name, start_date, status, settings, created_at')
    .eq('owner_type', 'academy')
    .eq('owner_id', academyProfileId)
    .eq('type', 'cyclus')
    .not('settings->>rebook_payment_mode', 'is', null)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []).map((c) => ({
    id: c.id as string,
    name: ((c.name as string | null) ?? '').trim(),
    startDate: (c.start_date as string | null) ?? null,
    status: (c.status as string | null) ?? 'draft',
  }));
}
