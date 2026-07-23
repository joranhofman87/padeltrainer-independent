// Verified guest contact resolution for the rebook senders (FAM-02 + person-unification).
//
// A guest's identity + account resolve from the GUEST's OWN verified relationships — curated
// person_links → twin_of_profile_id → linked_profile_id, split-freeze — via the SQL RPC
// resolve_guest_member_contacts, which mirrors can_book_member_window. The raw dual-key
// claim.player_id is NEVER an input: it is not proof of the guest's account, so it must never route
// a claim token / reminder to the linked parent or a stale account. Delivery is the guest's OWN email
// then the VERIFIED account profile's email; if neither exists the recipient is SKIPPED (never the
// raw player_id). Batched — one RPC per sender run, no per-recipient queries.

export interface GuestContactRow {
  guest_id: string;
  own_name: string | null;
  own_email: string | null;
  account_name: string | null;
  account_email: string | null;
  has_account: boolean;
}

export type GuestContactMap = Map<string, GuestContactRow>;

// deno-lint-ignore no-explicit-any
type RpcOnly = { rpc: (name: string, args: Record<string, unknown>) => any };

export async function fetchGuestContacts(supabase: RpcOnly, guestIds: Array<string | null | undefined>): Promise<GuestContactMap> {
  const ids = [...new Set(guestIds.filter((x): x is string => !!x))];
  if (ids.length === 0) return new Map();
  const { data, error } = await supabase.rpc("resolve_guest_member_contacts", { _guest_ids: ids });
  if (error) throw new Error(`guest contact resolution failed: ${(error as { message?: string })?.message ?? error}`);
  return new Map(((data ?? []) as GuestContactRow[]).map((g) => [g.guest_id, g]));
}

/** Guest-first VERIFIED delivery email: own → verified account, else null (skip). Never player_id. */
export function guestContactEmail(guestId: string | null | undefined, map: GuestContactMap): string | null {
  if (!guestId) return null;
  const g = map.get(guestId);
  return (g?.own_email?.trim() || g?.account_email?.trim()) || null;
}

/** Guest-first VERIFIED display name: own → verified account name, else "". */
export function guestContactName(guestId: string | null | undefined, map: GuestContactMap): string {
  if (!guestId) return "";
  const g = map.get(guestId);
  return (g?.own_name?.trim() || g?.account_name?.trim()) || "";
}
