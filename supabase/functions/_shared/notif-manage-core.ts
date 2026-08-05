/**
 * N2 S5 — the handler core for both manage endpoints: the RFC 8058 one-click POST target and the
 * manage page's context/apply API.
 *
 * THE FAIL-DIRECTION TABLE IS THE POINT. S1's review history killed two designs that answered a
 * one-click unsubscribe with a success the sender never retries while the opt-out was silently
 * lost. The rule that survived:
 *
 *   - OPERATIONAL failures (key state unreadable, key material missing, database error) are 503:
 *     the mailbox provider retries a 5xx, so the opt-out is deferred, never dropped.
 *   - INVALID tokens (grammar, signature, unknown version-above-current) are 400: a probe or a
 *     mangled link can never succeed, and asking the provider to retry it manufactures load.
 *   - DEAD links (burned generation, revoked, expired, swept row) are 410: permanent for THIS
 *     link, truthfully.
 *   - Only 'applied' / 'already_applied' are 200.
 *
 * GET on the one-click URL NEVER unsubscribes. Mailbox scanners (link protection, previews)
 * prefetch List-Unsubscribe URLs with GET; acting on it would mass-unsubscribe people who never
 * clicked anything. GET redirects to the human manage page instead; only the RFC 8058 POST acts.
 *
 * Dependency-injected and pure so every row of this table runs under Deno tests; the serve()
 * wrappers own the I/O and stay unimportable.
 */

import {
  bindManageTokenToRow,
  verifyManageToken,
  type KeyLookup,
  type ManageKeyState,
  type ManageRowLookup,
} from "./manage-token.ts";
import { manageEmailPageUrl } from "./marketing-email.ts";

export interface ManageContextRow {
  status: string; // live | revoked | expired | retired_key | missing
  kind: string | null;
  scope_kind: string | null;
  /** The RPC's column is scope_display_name — declared VERBATIM so the unchecked cast at the
   *  adapter cannot silently turn a real name into undefined. */
  scope_display_name: string | null;
  destination_redacted: string | null;
  key_version: number | null;
}

export interface ManageEndpointDeps {
  /** notification_manage_key_state, or null when unreadable/absent (OPERATIONAL, retryable). */
  loadKeyState(): Promise<ManageKeyState | null>;
  /** get_notification_manage_context. Throws on RPC error (operational). */
  getContext(capabilityId: string): Promise<ManageContextRow | null>;
  /** apply_notification_manage_action. `signedKeyVersion` is the generation the token's HMAC
   *  verified under — the RPC refuses a row minted under any other generation, IN the database,
   *  under its own FOR UPDATE. Returns the RPC verdict; throws on RPC error. */
  applyAction(
    capabilityId: string,
    source: "one_click" | "manage_page",
    signedKeyVersion: number,
  ): Promise<string>;
  keyLookup?: KeyLookup;
}

export type EndpointResult = { status: number; body: Record<string, unknown> };

const OPERATIONAL: EndpointResult = {
  status: 503,
  body: { error: "temporarily_unavailable", retryable: true },
};

/** Map an apply-RPC verdict to transport. Exported for the wrappers' tests. */
function applyVerdictToResult(verdict: string): EndpointResult {
  switch (verdict) {
    case "applied":
    case "already_applied":
      return { status: 200, body: { result: verdict } };
    case "rejected_missing":
    case "rejected_revoked":
    case "rejected_expired":
    case "rejected_retired_key":
      // Permanent for THIS link. 410 tells the provider to stop retrying, truthfully.
      return { status: 410, body: { result: verdict } };
    case "rejected_generation_mismatch":
      // A verifying-but-mismatched pairing only exists if a key leaked — treat it exactly like
      // any other forgery: 400, no retry, nothing revealed.
      return { status: 400, body: { error: "invalid_token" } };
    default:
      // rejected_unknown_action / rejected_unknown_source can only be OUR bug — the core passes
      // literals. 500, and loudly.
      return { status: 500, body: { error: "internal", verdict } };
  }
}

/**
 * The RFC 8058 one-click POST. Verify → apply('one_click') → map. No context read: the apply RPC
 * re-validates liveness row-side under FOR UPDATE, which is the authoritative check.
 */
export async function handleOneClickPost(
  deps: ManageEndpointDeps,
  token: string | null,
): Promise<EndpointResult> {
  const state = await deps.loadKeyState();
  const verified = await verifyManageToken(token, state, deps.keyLookup);
  if (!verified.ok) {
    if (verified.reason === "key_unavailable") return OPERATIONAL;
    if (verified.reason === "inactive") return { status: 410, body: { result: "rejected_retired_key" } };
    return { status: 400, body: { error: "invalid_token" } };
  }
  try {
    return applyVerdictToResult(
      await deps.applyAction(verified.capabilityId, "one_click", verified.keyVersion),
    );
  } catch {
    // An RPC/database failure must NEVER read as handled — a 2xx here loses the opt-out, since
    // RFC 8058 senders do not retry success.
    return OPERATIONAL;
  }
}

/** GET on the one-click URL: redirect the human (or the scanner) to the manage page. */
export function oneClickGetRedirect(token: string | null): EndpointResult & { location: string } {
  const location = manageEmailPageUrl(token ?? "");
  return { status: 303, body: {}, location };
}

/**
 * The manage page's CONTEXT call. Statuses are page content (200), not transport errors — the
 * page renders 'revoked'/'expired'/'missing' as friendly copy. Only operational faults are 5xx.
 */
export async function handleManageContext(
  deps: ManageEndpointDeps,
  token: string | null,
): Promise<EndpointResult> {
  const state = await deps.loadKeyState();
  const verified = await verifyManageToken(token, state, deps.keyLookup);
  if (!verified.ok) {
    if (verified.reason === "key_unavailable") return OPERATIONAL;
    if (verified.reason === "inactive") return { status: 200, body: { status: "retired_key" } };
    return { status: 200, body: { status: "invalid" } };
  }
  let ctx: ManageContextRow | null;
  try {
    ctx = await deps.getContext(verified.capabilityId);
  } catch {
    return OPERATIONAL;
  }
  if (!ctx) return { status: 200, body: { status: "missing" } };
  if (ctx.status !== "live") return { status: 200, body: { status: ctx.status } };

  // Bind the SIGNED generation to the STORED one, through the tagged-lookup helper — never a
  // hand-rolled comparison. A mismatch is 'invalid', exactly like a bad signature.
  const row: ManageRowLookup =
    ctx.key_version == null ? { found: false } : { found: true, keyVersion: ctx.key_version };
  const bound = bindManageTokenToRow(verified, row);
  if (!bound.ok) {
    if (bound.reason === "key_unavailable") return OPERATIONAL;
    return { status: 200, body: { status: "invalid" } };
  }
  return {
    status: 200,
    body: {
      status: "live",
      kind: ctx.kind,
      scopeKind: ctx.scope_kind,
      scopeName: ctx.scope_display_name,
      destinationRedacted: ctx.destination_redacted,
    },
  };
}

/** The manage page's APPLY call — the human pressed the button. */
export async function handleManageApply(
  deps: ManageEndpointDeps,
  token: string | null,
): Promise<EndpointResult> {
  const state = await deps.loadKeyState();
  const verified = await verifyManageToken(token, state, deps.keyLookup);
  if (!verified.ok) {
    if (verified.reason === "key_unavailable") return OPERATIONAL;
    if (verified.reason === "inactive") return { status: 410, body: { result: "rejected_retired_key" } };
    return { status: 400, body: { error: "invalid_token" } };
  }
  try {
    return applyVerdictToResult(
      await deps.applyAction(verified.capabilityId, "manage_page", verified.keyVersion),
    );
  } catch {
    return OPERATIONAL;
  }
}
