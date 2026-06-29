// Shared data helpers for the trainer + academy player-detail pages. The two pages' data layers
// genuinely diverge (trainer scopes guests/slots by trainer_id, has a visibility gate + training
// locations; academy does not), so this does NOT try to be one shared loader. It extracts the two
// pieces that ARE common and money/tenant-isolation-sensitive — the player-invoice fetch and the
// pure cyclus grouping — into testable units. See src/test/playerDetailData.pglite.test.ts for the
// cross-tenant isolation characterization (a trainer/academy only ever sees invoices it owns).
import { supabase } from '@/lib/supabaseClient';
import type { SupabaseClient } from '@supabase/supabase-js';

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
