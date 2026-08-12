// ABC-18 Pass B §1b — who may access an invoice AS THE PLAYER.
//
// THE RULE (FAM-02, the same one personRefOf encodes): an invoice carrying a guest_player_id
// belongs to that GUEST. Any player_id beside it is legacy link decoration, not identity.
//
// Four arms used to grant access. Three are withdrawn and the fourth is narrowed:
//
//   1. player arm — RETAINED but PURE-PROFILE ONLY. It previously matched on invoice.player_id
//      alone, so a DUAL-KEY invoice (a guest's invoice carrying some account's stale player_id)
//      handed that account the guest's invoice: amounts, billing identity, payment page.
//   2. person arm — WITHDRAWN. person_links equality descends from the legacy bridge.
//   3. twin/linked bridge — WITHDRAWN. Both columns are caller-authored legacy values.
//   4. legacy email fallback — WITHDRAWN. A mutable string is not identity; two people sharing a
//      household address is ordinary, and matching on it hands one the other's invoice.
//
// The freeze check that guarded the person arm goes with it: it existed only to make bridge
// traversal safe, and nothing traverses the bridge now. A guest invoice simply grants no account
// access at all — GUEST-TOKEN authorization remains a SEPARATE, explicit boundary (the public
// token path), and this helper never converts a token into account identity.
//
// Fails CLOSED on any lookup error.

export interface AuthzClient {
  from(table: string): {
    select(cols: string): {
      eq(col: string, val: string): AuthzFilter;
    };
  };
}
interface AuthzFilter {
  eq(col: string, val: string): AuthzFilter;
  in(col: string, vals: string[]): AuthzFilter;
  limit(n: number): AuthzFilter;
  single(): PromiseLike<{ data: Record<string, unknown> | null; error: unknown }>;
  maybeSingle(): PromiseLike<{ data: Record<string, unknown> | null; error: unknown }>;
}

export interface InvoiceRefs {
  player_id: string | null;
  guest_player_id: string | null;
}

export interface CallerIdentity {
  id: string | null;
  email: string | null;
}

/** True when the caller may access this invoice AS THE PLAYER (pure-profile self only). */
export async function resolveInvoicePlayerAccess(
  invoice: InvoiceRefs,
  user: CallerIdentity,
  supabase: AuthzClient,
): Promise<boolean> {
  // A guest invoice grants NO account access. This is checked first and unconditionally, so no
  // later arm can be reached for a dual-key row.
  if (invoice.guest_player_id) return false;

  if (!invoice.player_id || !user.id) return false;

  // pure-profile self: the invoice's profile is the caller's own.
  if (invoice.player_id === user.id) return true;

  const { data: playerProfile, error } = await supabase
    .from('profiles')
    .select('user_id')
    .eq('id', invoice.player_id)
    .single();
  if (error) return false;          // fail closed on lookup error
  return playerProfile?.user_id === user.id;
}
