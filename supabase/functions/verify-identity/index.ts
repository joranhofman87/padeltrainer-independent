// U2 — the identity-verification link target. The person who received the emailed link lands here
// to prove control of their address, see the minimal candidate list, and make the explicit choice.
//
// It holds ONLY the opaque token. It never learns who a candidate is until the token verifies, and
// it never narrates WHY a token failed (that is the enumeration oracle). Design + threat model:
// docs/U2_IDENTITY_CONTINUITY_DESIGN.md.
//
// The token is validated with no database access (identity-verify-token.ts), then bound to the
// challenge row's stored key generation, and only then may list/select run. A key-unavailable
// outcome is the ONE retryable failure (503 + Retry-After); everything else is the uniform generic
// "this link is invalid or has expired".
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.108.2";
import { restrictedCors } from "../_shared/cors.ts";
import {
  bindIdentityTokenToRow,
  type IdentityKeyState,
  type IdentityRowLookup,
  verifyIdentityToken,
} from "../_shared/identity-verify-token.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The uniform public answer to any bad/expired/forged token — never a reason, never a detail. */
const GENERIC_INVALID = { status: "invalid" as const };

async function readKeyState(admin: SupabaseClient): Promise<IdentityKeyState | null> {
  const { data, error } = await admin
    .from("identity_verify_key_state")
    .select("current_version, min_mintable_version")
    .eq("id", true)
    .maybeSingle();
  if (error || !data) return null;
  return {
    currentVersion: (data as { current_version: number }).current_version,
    minMintableVersion: (data as { min_mintable_version: number }).min_mintable_version,
  };
}

async function rowLookup(admin: SupabaseClient, challengeId: string): Promise<IdentityRowLookup> {
  // Via a definer RPC, NOT a direct table read: the challenge table is granted to nobody (it holds
  // the contact address) and BYPASSRLS does not bypass a table ACL, so a service-role SELECT would
  // fail (Codex r1 f1). The RPC returns the key_version alone.
  const { data, error } = await admin.rpc("identity_challenge_key_version", { _challenge_id: challengeId });
  if (error) return { unavailable: true };
  if (data === null || data === undefined) return { found: false };
  return { found: true, keyVersion: data as number };
}

export async function handleRequest(
  req: Request,
  deps?: { adminClient?: SupabaseClient },
): Promise<Response> {
  const cors = restrictedCors(req);
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

  try {
    const admin = deps?.adminClient ?? createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const body = await req.json().catch(() => ({}));
    const token = typeof body?.token === "string" ? body.token : null;
    const action = body?.action === "select" ? "select" : "list";

    // 1. Validate the token with no DB access. A missing key state is operational (retryable);
    //    a bad/forged/retired token is the uniform generic answer.
    const state = await readKeyState(admin);
    const result = await verifyIdentityToken(token, state);
    if (!result.ok && result.reason === "key_unavailable") {
      return json({ status: "unavailable" }, 503);
    }
    if (!result.ok) return json(GENERIC_INVALID);

    // 2. Bind the signed generation to the stored one. A DB fault here is retryable; a missing row
    //    or a generation mismatch collapses to the uniform generic answer.
    const bound = bindIdentityTokenToRow(result, await rowLookup(admin, result.challengeId));
    if (!bound.ok && bound.reason === "key_unavailable") return json({ status: "unavailable" }, 503);
    if (!bound.ok) return json(GENERIC_INVALID);

    const challengeId = bound.challengeId;

    if (action === "select") {
      const chooseNew = body?.choose_someone_new === true;
      const personId = typeof body?.person_id === "string" && UUID_RE.test(body.person_id)
        ? body.person_id
        : null;
      if (!chooseNew && !personId) return json({ status: "not_a_candidate" });
      const { data, error } = await admin.rpc("identity_verification_select", {
        _challenge_id: challengeId,
        _person_id: personId,
        _choose_someone_new: chooseNew,
      });
      // A DB fault is retryable; never echo the error text (PII/oracle channel).
      if (error) return json({ status: "unavailable" }, 503);
      return json(data ?? GENERIC_INVALID);
    }

    // action === "list": the token verified, so disclose the minimal candidate set.
    const { data, error } = await admin.rpc("identity_verification_list", { _challenge_id: challengeId });
    if (error) return json({ status: "unavailable" }, 503);
    return json(data ?? GENERIC_INVALID);
  } catch (_err) {
    // Never surface raw error text: it can carry PII, and a detailed failure is an oracle.
    return json({ status: "unavailable" }, 503);
  }
}

// Only bind a port when run as the entrypoint — importing for tests must not serve.
if (import.meta.main) Deno.serve((req) => handleRequest(req));
