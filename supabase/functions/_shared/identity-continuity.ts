// U2 — the anonymous-identity resolver every guest entrypoint calls BEFORE any side effect.
//
// It is the thin edge wrapper over identity_resolve_or_challenge (which does all the work in one
// definer transaction: trusted-evidence check, PII candidate match, idempotent challenge mint, and
// the inert verification enqueue). The entrypoint gets back exactly one of three outcomes and never
// sees a candidate identity, name or count:
//
//   proceed_new     — create a fresh Player through the UUID command, as today.
//   proceed_person  — a trusted, already-decided canonical person; use it, create nothing.
//   verify_required — candidates exist and control of the address is not yet proven; a challenge
//                     was minted and one message enqueued. The entrypoint MUST return here with NO
//                     hold/invoice/payment/create — the browser shows a generic "check your email".
//
// Design + threat model: docs/U2_IDENTITY_CONTINUITY_DESIGN.md.
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.108.2";

export type AnonymousWorkflow = "slot" | "cart" | "cyclus" | "intake" | "rebook";

export type IdentityOwner =
  | { academyProfileId: string; trainerId?: undefined }
  | { trainerId: string; academyProfileId?: undefined };

export type IdentityResolution =
  | { status: "proceed_new" }
  | { status: "proceed_person"; personId: string }
  | { status: "verify_required" };

export type ResolveAnonymousParams = {
  creationRequestId: string;
  owner: IdentityOwner;
  workflow: AnonymousWorkflow;
  email: string;
  /** The material booking intent this attempt is for — the exact target (slot/cart/cyclus/
   *  registration ids) plus the submitted name/phone, as a canonical string. Bound into the
   *  challenge so a verified selection can be reused ONLY for the same target+payload (a caller who
   *  keeps the creation_request_id cannot resume it for a different booking). Built from the
   *  entrypoint's OWN validated values. */
  payloadKey: string;
  /** An authenticated caller's canonical person. MUST be derived from a SERVER-VALIDATED JWT, never
   *  echoed from the client: the resolver only checks the owner MAY act on the person, not that the
   *  caller IS them, so a client-supplied value would let anyone book as any in-scope person
   *  (Codex r2 f8). The public guest endpoints (verify_jwt=false) never validate a token, so they
   *  leave this null and treat every caller as anonymous — a logged-in player books through the
   *  authenticated surfaces, which resolve their person and never reach these endpoints. Wiring
   *  optional JWT validation into the public endpoints is future work; until then login-bypass here
   *  is deliberately absent rather than unsafely client-trusted. */
  authedPersonId?: string | null;
};

/**
 * Resolve anonymous identity, or demand verification. Throws on a refusal the caller cannot handle
 * (a missing attempt id, an unusable key state) — the entrypoints already require an attempt id, so
 * a throw here is a broken invariant, not a user path.
 *
 * The `verify_required` outcome deliberately carries NOTHING else: the challenge id, key version and
 * expiry stay server-side (the browser needs none of them — the link arrives by email), so the
 * response cannot become an existence oracle.
 */
export async function resolveAnonymousIdentity(
  admin: SupabaseClient,
  params: ResolveAnonymousParams,
): Promise<IdentityResolution> {
  if (!params.creationRequestId) {
    throw new Error("identity_resolve_failed:missing_creation_request_id");
  }
  const academyProfileId = params.owner.academyProfileId ?? null;
  const trainerId = params.owner.trainerId ?? null;
  if (!academyProfileId && !trainerId) {
    throw new Error("identity_resolve_failed:no_owner_scope");
  }

  const { data, error } = await admin.rpc("identity_resolve_or_challenge", {
    _creation_request_id: params.creationRequestId,
    _owner_type: academyProfileId ? "academy" : "trainer",
    _owner_id: academyProfileId ?? trainerId,
    _workflow: params.workflow,
    _email: params.email ?? "",
    _authed_person_id: params.authedPersonId ?? null,
    _payload_key: params.payloadKey ?? "",
  });
  if (error) {
    // Code only — Postgres error detail can embed the address (PII hygiene, same as the checkout).
    throw new Error(`identity_resolve_failed:${error.code ?? "unknown"}`);
  }

  const result = data as {
    status: "proceed_new" | "proceed_person" | "verify_required";
    person_id?: string | null;
  } | null;

  if (result?.status === "proceed_person" && result.person_id) {
    return { status: "proceed_person", personId: result.person_id };
  }
  if (result?.status === "verify_required") {
    return { status: "verify_required" };
  }
  if (result?.status === "proceed_new") {
    return { status: "proceed_new" };
  }
  throw new Error("identity_resolve_failed:unexpected_result");
}
