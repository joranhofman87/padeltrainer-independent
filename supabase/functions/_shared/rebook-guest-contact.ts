// Guest contact resolution for the rebook senders (FAM-02, Pass B §2).
//
// A guest is addressed at the guest's OWN email. There is no account fallback: the "account" a
// guest used to resolve to came from the legacy bridge, which was written by an email/name
// matcher and joins two different people who once shared an address. A claim token or reminder
// sent to that address reaches the wrong person, so the arm is gone.
//
// The dual-key claim.player_id is likewise never an input — on a row carrying a guest, the
// profile id is decoration, not proof.
//
// If the guest has no address of their own the recipient is SKIPPED. That is the intended
// outcome and it is explicit; it is never an inherited account address.
//
// The account_* columns still arrive from the RPC (its result shape is unchanged) and are
// deliberately NOT consulted here. Batched — one RPC per sender run.

export interface GuestContactRow {
  guest_id: string;
  own_name: string | null;
  own_email: string | null;
  account_name: string | null;
  account_email: string | null;
  has_account: boolean;
}

export type GuestContactMap = Map<string, GuestContactRow>;

// `unknown` return so the real SupabaseClient and a test fake both satisfy it; narrowed at the await.
type RpcOnly = { rpc: (name: string, args: Record<string, unknown>) => unknown };

export async function fetchGuestContacts(supabase: RpcOnly, guestIds: Array<string | null | undefined>): Promise<GuestContactMap> {
  const ids = [...new Set(guestIds.filter((x): x is string => !!x))];
  if (ids.length === 0) return new Map();
  const { data, error } = await (supabase.rpc("resolve_guest_member_contacts", { _guest_ids: ids }) as Promise<{ data: GuestContactRow[] | null; error: unknown }>);
  if (error) throw new Error(`guest contact resolution failed: ${(error as { message?: string })?.message ?? error}`);
  return new Map(((data ?? []) as GuestContactRow[]).map((g) => [g.guest_id, g]));
}

/** The guest's OWN delivery email, or null so the caller skips them. No account fallback. */
export function guestContactEmail(guestId: string | null | undefined, map: GuestContactMap): string | null {
  if (!guestId) return null;
  return map.get(guestId)?.own_email?.trim() || null;
}

/** The guest's OWN display name, or "". A blank name is not filled in from an account. */
export function guestContactName(guestId: string | null | undefined, map: GuestContactMap): string {
  if (!guestId) return "";
  return map.get(guestId)?.own_name?.trim() || "";
}
