// Per-cycle rebook management: derive the status of each weekly session/group of a
// rebooked cycle (rebooked / awaiting / won't-rebook / open-to-members / open-to-public),
// with per-player response + paid status, plus the bulk levers (open to public / make
// private / send reminder). Read-only derivation — all signals already exist on
// availability_slots + slot_priority_claims + invoices.
import { supabase } from '@/lib/supabaseClient';
import { releaseSlotToPublic, holdSlotForReview, type PublicReleaseStatus } from '@/lib/priorityClaims';
import type { BulkResult, BulkFailure } from '@/lib/academyPlayerBulk';

export type GroupStatus = 'rebooked' | 'awaiting' | 'declined' | 'members' | 'public';
type SlotPhase = 'priority' | 'members' | 'public' | 'held';
type ClaimsState = 'rebooked' | 'awaiting' | 'declined' | 'none';

export interface RebookManagePlayer {
  key: string; // player_id or `g:${guest_player_id}`
  playerId: string | null;
  guestPlayerId: string | null;
  name: string;
  response: 'claimed' | 'pending' | 'declined';
  paid: boolean;
  hasInvoice: boolean;
}

export interface RebookManageGroup {
  groupId: string; // rebook_group_id (or slot id fallback)
  weekday: string;
  time: string;
  trainerId: string | null;
  locationId: string | null;
  slotIds: string[];
  capacity: number;
  status: GroupStatus;
  players: RebookManagePlayer[];
}

export interface RebookManageData {
  cycleName: string;
  groups: RebookManageGroup[];
  counts: Record<GroupStatus, number>;
  paidCount: number;
  unpaidCount: number;
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

function claimsStateOf(responses: Array<'claimed' | 'pending' | 'declined'>): ClaimsState {
  if (responses.length === 0) return 'none';
  if (responses.some((r) => r === 'claimed')) return 'rebooked';
  if (responses.some((r) => r === 'pending')) return 'awaiting';
  return 'declined'; // all declined/expired
}

export async function getCycleRebookStatus(cycleId: string): Promise<RebookManageData> {
  const [{ data: cycle }, { data: slots }] = await Promise.all([
    supabase.from('cycles').select('name').eq('id', cycleId).maybeSingle(),
    supabase
      .from('availability_slots')
      .select('id, start_time, trainer_id, location_id, max_participants, is_public, public_release_status, priority_window_ends_at, member_window_ends_at')
      .eq('cyclus_id', cycleId),
  ]);
  const slotRows = (slots ?? []) as SlotRow[];
  const empty: RebookManageData = {
    cycleName: cycle?.name ?? '',
    groups: [],
    counts: { rebooked: 0, awaiting: 0, declined: 0, members: 0, public: 0 },
    paidCount: 0,
    unpaidCount: 0,
  };
  if (slotRows.length === 0) return empty;
  const slotById = new Map(slotRows.map((s) => [s.id, s]));
  const slotIds = slotRows.map((s) => s.id);

  const [{ data: claims }, { data: invoices }] = await Promise.all([
    supabase
      .from('slot_priority_claims')
      .select('id, slot_id, player_id, guest_player_id, status, rebook_group_id')
      .in('slot_id', slotIds),
    supabase
      .from('invoices')
      .select('player_id, guest_player_id, status')
      .eq('cycle_id', cycleId),
  ]);
  const claimRows = (claims ?? []) as Array<{
    slot_id: string;
    player_id: string | null;
    guest_player_id: string | null;
    status: string;
    rebook_group_id: string | null;
  }>;

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

  // Paid status per player key (any 'paid' invoice for this cycle).
  const paidKeys = new Set<string>();
  const invoicedKeys = new Set<string>();
  for (const inv of (invoices ?? []) as Array<{ player_id: string | null; guest_player_id: string | null; status: string }>) {
    const key = inv.player_id ?? (inv.guest_player_id ? `g:${inv.guest_player_id}` : null);
    if (!key || inv.status === 'cancelled') continue;
    invoicedKeys.add(key);
    if (inv.status === 'paid') paidKeys.add(key);
  }

  const keyOf = (c: { player_id: string | null; guest_player_id: string | null }) =>
    c.player_id ?? `g:${c.guest_player_id}`;
  // Strongest response per (group, player) — a player on a multi-week series has one
  // claim per slot; collapse to claimed > pending > declined.
  const rank = { claimed: 3, pending: 2, declined: 1, expired: 0 } as const;

  const groupsMap = new Map<string, { slotIds: Set<string>; players: Map<string, RebookManagePlayer> }>();
  for (const c of claimRows) {
    const groupKey = c.rebook_group_id ?? c.slot_id;
    let g = groupsMap.get(groupKey);
    if (!g) { g = { slotIds: new Set(), players: new Map() }; groupsMap.set(groupKey, g); }
    g.slotIds.add(c.slot_id);
    const pk = keyOf(c);
    const resp = (c.status === 'claimed' || c.status === 'pending' || c.status === 'declined') ? c.status : 'declined';
    const existing = g.players.get(pk);
    if (!existing || rank[resp] > rank[existing.response]) {
      g.players.set(pk, {
        key: pk,
        playerId: c.player_id,
        guestPlayerId: c.guest_player_id,
        name: nameByKey.get(pk) ?? '—',
        response: resp,
        paid: paidKeys.has(pk),
        hasInvoice: invoicedKeys.has(pk),
      });
    }
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
      slotIds: ids,
      capacity: rep.max_participants ?? 0,
      status,
      players,
    });
  }
  groups.sort((a, b) => a.weekday.localeCompare(b.weekday) || a.time.localeCompare(b.time));

  const counts: Record<GroupStatus, number> = { rebooked: 0, awaiting: 0, declined: 0, members: 0, public: 0 };
  for (const grp of groups) counts[grp.status] += 1;
  const allPlayers = groups.flatMap((g) => g.players);
  const paidCount = allPlayers.filter((p) => p.paid).length;
  const unpaidCount = allPlayers.filter((p) => p.response === 'claimed' && !p.paid).length;

  return { cycleName: cycle?.name ?? '', groups, counts, paidCount, unpaidCount };
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
