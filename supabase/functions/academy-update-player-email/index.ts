// ABC-16 H0 — RETIRED. This endpoint no longer rewrites anyone's login identity.
//
// It used to overwrite a registered player's REAL login email through the privileged Auth
// admin API, auto-confirming the new address, whenever `get_player_email_edit_capability`
// returned 'direct'. That gate's "this academy owns the player" predicate was satisfied by a
// row in `academy_player_metadata` — a table any authenticated academy manager could write
// for an arbitrary, caller-chosen `profile_id`. Minting one row therefore made an account
// takeover reachable for a nascent target (never signed in, never confirmed, single-tenant,
// non-admin, non-trainer).
//
// SQL alone cannot close that. This function held the SERVICE ROLE, which is bound by neither
// RLS nor the profile guard, so the boundary has to exist HERE as well. It does so
// structurally: no privileged client is constructed, no key is read, and no privileged Auth
// call exists anywhere in this module. There is no branch to reach.
//
// The identifiers of the removed call are deliberately NOT written out anywhere in this file:
// abc16IdentityRetired.test.ts proves the containment by asserting they are absent from the
// module, and a comment quoting them would defeat that guard.
//
// The safe paths that replace it:
//   * a registered player owns their login email and changes it themselves (self-service);
//   * invoices can carry an academy-scoped billing-email override — temporarily read-only
//     under H0 while `academy_player_metadata` has no trustworthy writer;
//   * a guest has no login, so guest contact email is still edited directly on
//     `guest_players`, whose write policies are ownership-based and overlay-independent.
//
// Rollback is forward-only: if this refusal is inconvenient, the answer is an H1
// membership-backed command, never the restoration of academy Auth-email rewriting.
//
// `verify_jwt = false` in supabase/config.toml is retained deliberately. The refusal is
// identical for every caller, so routing an unauthenticated request to the gateway's 401
// instead would only make the response depend on the caller again.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/** The single, stable response. Same status and body for every caller and every input. */
const REFUSAL = {
  error: "identity_is_self_service",
  detail:
    "An academy can no longer change a registered player's login email. The player changes it themselves from their own account; for invoicing, use a billing email override.",
} as const;

Deno.serve((req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  // No request body is read, no caller is identified, no database or Auth call is made:
  // nothing about the response can vary, so nothing about it can leak.
  return new Response(JSON.stringify(REFUSAL), {
    status: 403,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
