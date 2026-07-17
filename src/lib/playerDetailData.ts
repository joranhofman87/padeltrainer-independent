// Shared data helpers for the trainer + academy player-detail pages. The two pages' data layers
// genuinely diverge (trainer scopes guests/slots by trainer_id, has a visibility gate + training
// locations; academy does not), so this does NOT try to be one shared loader. It extracts the two
// pieces that ARE common and money/tenant-isolation-sensitive — the player-invoice fetch and the
// pure cyclus grouping — into testable units. See src/test/playerDetailData.pglite.test.ts for the
// cross-tenant isolation characterization (a trainer/academy only ever sees invoices it owns).
import { supabase } from '@/lib/supabaseClient';
import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '@/lib/logger';

/** The owning tenant: a trainer (`trainer_id`) or an academy (`academy_profile_id`). */
export interface PlayerDetailScope {
  kind: 'trainer' | 'academy';
  /** trainer_profiles.id when kind==='trainer', academy_profiles.id when kind==='academy'. */
  id: string;
}

/** The player being viewed: a guest (`guest_player_id`) or a registered profile (`player_id`). */
export interface ParsedPlayerRef {
  kind: 'guest' | 'profile';
  id: string;
}

/**
 * Phase 3.3b: the IN-SCOPE ref set of the person behind a clicked g_/p_ ref. A merged human's
 * detail page unions bookings/invoices across ALL these refs so their self-booked sessions and
 * profile-addressed invoices show alongside their guest-seated ones. Resolved by the SECURITY
 * DEFINER RPC get_person_refs_for_scope (person_links is RLS-locked). REFS ONLY — the RPC carries
 * no identity/PII (it must never become a cross-tenant identity oracle); the detail header keeps
 * sourcing identity from the clicked row as before.
 */
export interface PersonRefSet {
  /** In-scope, non-split-frozen guest ids of the person (includes the clicked guest). */
  guestIds: string[];
  /** The person's profile, only when the caller can already see it (in-scope booking/invoice). */
  profileId: string | null;
  /** Phase 3.3d: does the PERSON have a login (persons.user_id)? Drives the detail-page type badge
   *  so a merged account holder clicked via their guest side reads 'Registered', not 'Guest'.
   *  `undefined` until the extended RPC is deployed — the page falls back to the seat-based type. */
  hasLogin?: boolean;
}

/**
 * Resolve a clicked g_/p_ ref to the person's in-scope ref set. Falls back to a SINGLE-REF set (the
 * clicked ref only) if the RPC is not yet deployed (PGRST202) or errors — that reproduces the exact
 * pre-3.3b behavior, so the detail page never blanks while the migration rolls out (Vercel ships the
 * client before `db push`).
 */
export async function fetchPersonRefSet(
  scope: PlayerDetailScope,
  clicked: ParsedPlayerRef,
  client: Pick<SupabaseClient, 'rpc'> = supabase,
): Promise<PersonRefSet> {
  const fallback: PersonRefSet = {
    guestIds: clicked.kind === 'guest' ? [clicked.id] : [],
    profileId: clicked.kind === 'profile' ? clicked.id : null,
  };
  try {
    const { data, error } = await client.rpc('get_person_refs_for_scope', {
      p_scope: scope.kind,
      p_scope_id: scope.id,
      p_guest_id: clicked.kind === 'guest' ? clicked.id : undefined,
      p_profile_id: clicked.kind === 'profile' ? clicked.id : undefined,
    });
    if (error) {
      if (error.code !== 'PGRST202') {
        logger.warn('get_person_refs_for_scope failed; showing single-ref detail', {
          component: 'playerDetailData',
          code: error.code,
        });
      }
      return fallback;
    }
    const row = (data as unknown as Array<Record<string, unknown>>)?.[0];
    if (!row) return fallback;
    return {
      guestIds: ((row.guest_ids as string[] | null) ?? []).filter(Boolean),
      profileId: (row.profile_id as string | null) ?? null,
      hasLogin: typeof row.has_login === 'boolean' ? row.has_login : undefined,
    };
  } catch (e) {
    logger.warn('get_person_refs_for_scope threw; showing single-ref detail', {
      component: 'playerDetailData',
      error: e instanceof Error ? e.message : String(e),
    });
    return fallback;
  }
}

/**
 * The distinct slot ids of every booking belonging to the PERSON across the ref set, under the
 * caller's own slots (RLS-scoped). FAM-02: a dual-keyed row is the guest person's, so the profile
 * side matches only PURE-profile rows (guest_player_id IS NULL) — the same guard the overview uses.
 */
export async function fetchPersonBookingSlotIds(
  refs: PersonRefSet,
  client: Pick<SupabaseClient, 'from'> = supabase,
): Promise<string[]> {
  const slotIds = new Set<string>();
  const queries: Promise<{ data: Array<{ slot_id: string | null }> | null }>[] = [];
  if (refs.guestIds.length > 0) {
    queries.push(
      client.from('bookings').select('slot_id').in('guest_player_id', refs.guestIds) as unknown as
        Promise<{ data: Array<{ slot_id: string | null }> | null }>,
    );
  }
  if (refs.profileId) {
    queries.push(
      client.from('bookings').select('slot_id').eq('player_id', refs.profileId).is('guest_player_id', null) as unknown as
        Promise<{ data: Array<{ slot_id: string | null }> | null }>,
    );
  }
  for (const res of await Promise.all(queries)) {
    for (const b of res.data ?? []) if (b.slot_id) slotIds.add(b.slot_id);
  }
  return [...slotIds];
}

/** The PERSON's invoices across the ref set (guest-addressed + profile-addressed), newest first,
 *  deduped by id. Profile-addressed invoices are the person's to pay (addressee exemption — no
 *  pure-profile guard, matching the overview's overdue rule). */
export async function fetchPersonInvoices(
  scope: PlayerDetailScope,
  refs: PersonRefSet,
  client: Pick<SupabaseClient, 'from'> = supabase,
): Promise<PlayerInvoiceRow[]> {
  const parts: PlayerInvoiceRow[] = [];
  if (refs.guestIds.length > 0) {
    for (const gid of refs.guestIds) {
      parts.push(...(await fetchPlayerInvoices(scope, { kind: 'guest', id: gid }, client)));
    }
  }
  if (refs.profileId) {
    parts.push(...(await fetchPlayerInvoices(scope, { kind: 'profile', id: refs.profileId }, client)));
  }
  const byId = new Map<string, PlayerInvoiceRow>();
  for (const inv of parts) if (!byId.has(inv.id)) byId.set(inv.id, inv);
  return [...byId.values()].sort((a, b) => (b.invoice_date ?? '').localeCompare(a.invoice_date ?? ''));
}

export interface PlayerInvoiceRow {
  id: string;
  invoice_number: string | null;
  invoice_date: string | null;
  due_date: string | null;
  total: number | null;
  status: string | null;
  pdf_url: string | null;
  sent_at: string | null;
  trainer_id?: string | null;
  academy_profile_id?: string | null;
}

/**
 * A player's invoices, scoped to the current tenant AND the player, newest first. The tenant `.eq`
 * is the cross-tenant isolation guarantee: a trainer/academy only ever sees invoices it owns. This
 * mirrors the (previously duplicated) inline queries in the two PlayerDetail pages exactly.
 * `client` is injectable for tests (defaults to the real supabase client).
 */
export async function fetchPlayerInvoices(
  scope: PlayerDetailScope,
  player: ParsedPlayerRef,
  client: Pick<SupabaseClient, 'from'> = supabase,
): Promise<PlayerInvoiceRow[]> {
  const scopeCol = scope.kind === 'trainer' ? 'trainer_id' : 'academy_profile_id';
  const playerCol = player.kind === 'guest' ? 'guest_player_id' : 'player_id';
  const cols = `id, invoice_number, invoice_date, due_date, total, status, pdf_url, sent_at, ${scopeCol}`;
  const { data } = await client
    .from('invoices')
    .select(cols)
    .eq(scopeCol, scope.id)
    .eq(playerCol, player.id)
    .order('invoice_date', { ascending: false });
  return (data || []) as unknown as PlayerInvoiceRow[];
}

export interface PlayerSlotRow {
  id: string;
  cyclus_id: string | null;
  cyclus_name: string | null;
  start_time: string | null;
}

export interface RawCyclus {
  cyclus_id: string;
  cyclus_name: string;
  session_count: number;
  first_session: string;
  last_session: string;
}

/**
 * Pure: group a player's booked slots into cyclus rows (newest last_session first). Slots with no
 * cyclus_id collapse under their own id and the `singleSessionsLabel`. Identical logic previously
 * duplicated in both PlayerDetail pages; the caller adds each row's `href` via its role-specific
 * pricing-route resolver (the only role-specific part of this section).
 */
export function groupSlotsIntoCycluses(slots: PlayerSlotRow[], singleSessionsLabel: string): RawCyclus[] {
  const byCyc = new Map<string, { id: string; name: string; dates: Date[] }>();
  for (const s of slots) {
    const cid = s.cyclus_id || s.id;
    const cname = s.cyclus_name || singleSessionsLabel;
    const cur = byCyc.get(cid) || { id: cid, name: cname, dates: [] };
    if (s.start_time) cur.dates.push(new Date(s.start_time));
    byCyc.set(cid, cur);
  }
  return Array.from(byCyc.values())
    .map((c) => {
      const sorted = c.dates.sort((a, b) => a.getTime() - b.getTime());
      return {
        cyclus_id: c.id,
        cyclus_name: c.name,
        session_count: sorted.length,
        first_session: sorted[0]?.toISOString() || '',
        last_session: sorted[sorted.length - 1]?.toISOString() || '',
      };
    })
    .sort((a, b) => (b.last_session || '').localeCompare(a.last_session || ''));
}
