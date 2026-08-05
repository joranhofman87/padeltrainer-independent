/**
 * N2 S3 — the marketing-email attach layer: suppression gate, per-send manage capability,
 * unsubscribe footer, RFC 8058 one-click headers.
 *
 * THE CONTRACT (from S1's schema + review):
 *  - Marketing mail may not leave without an unsubscribe. The footer's human link and the
 *    one-click header both carry the send's SIGNED capability token; the capability IS the send's
 *    identity (`UNIQUE (source_kind, source_id)`), so a retry re-derives byte-identical bytes.
 *  - A suppressed address must be refused at SEND time, by the canonical reader
 *    (`is_marketing_suppressed`), which RAISES on malformed input — an ERROR means "defer and
 *    alert", never clearance.
 *  - A capability signed by a RETIRED key generation must block the SEND, not merely the click
 *    (N2 §3): sending a dead link would look delivered while the opt-out silently stopped
 *    working.
 *  - CUTOVER (N2 §4): rows first attempted before this deploy were provider-accepted WITHOUT a
 *    footer under a stable idempotency key. Capability EXISTENCE is the marker for "this send's
 *    canonical body carries the footer" — see `resolveMarketingAttachment`.
 *
 * Pure + dependency-injected so the decision table runs under Deno tests; callers own the I/O.
 */

import { buildManageToken, type ManageKeyState, type KeyLookup } from "./manage-token.ts";

/**
 * The HUMAN manage page (S5 ships the route; the URL shape is frozen here and pinned by tests).
 * Public and outside /app: a marketing recipient may have no account, so the page must not sit
 * behind any auth or role layout.
 */
export const MANAGE_EMAIL_PAGE_URL = "https://padeltrainer.ai/manage-email";

/** The RFC 8058 one-click endpoint (S5 ships the function; the name is frozen here). */
export const ONE_CLICK_FUNCTION_NAME = "notif-unsubscribe-one-click";

export function manageEmailPageUrl(token: string): string {
  return `${MANAGE_EMAIL_PAGE_URL}?token=${encodeURIComponent(token)}`;
}

export function oneClickUnsubscribeUrl(supabaseUrl: string, token: string): string {
  return `${supabaseUrl}/functions/v1/${ONE_CLICK_FUNCTION_NAME}?token=${encodeURIComponent(token)}`;
}

/**
 * RFC 8058 headers, as Resend body `headers`. Both are required for mailbox-provider one-click:
 * `List-Unsubscribe` names the HTTPS POST target; `List-Unsubscribe-Post` is the literal opt-in
 * marker providers look for.
 */
export function rfc8058Headers(supabaseUrl: string, token: string): Record<string, string> {
  return {
    "List-Unsubscribe": `<${oneClickUnsubscribeUrl(supabaseUrl, token)}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}

const FOOTER_COPY: Record<string, { from: string; unsubscribe: string }> = {
  nl: { from: "Je ontvangt deze e-mail van PadelTrainer.ai.", unsubscribe: "Afmelden voor deze e-mails" },
  en: { from: "You're receiving this email from PadelTrainer.ai.", unsubscribe: "Unsubscribe from these emails" },
};

/**
 * The marketing footer. DETERMINISTIC: same token + locale → same bytes, which is what lets a
 * campaign retry rebuild an identical body under its frozen idempotency key. The token is
 * URL-encoded but never HTML-escaped-mangled — it is base64url + dots, HTML-inert by
 * construction, and a test pins that.
 */
export function marketingFooterHtml(token: string, locale?: string | null): string {
  const copy = FOOTER_COPY[(locale ?? "en").slice(0, 2).toLowerCase()] ?? FOOTER_COPY.en;
  return (
    `<div style="margin-top:32px;padding-top:16px;border-top:1px solid #e5e7eb">` +
    `<p style="color:#6b7280;font-size:12px;text-align:center;margin:0">` +
    `${copy.from}<br/>` +
    `<a href="${manageEmailPageUrl(token)}" style="color:#6b7280;text-decoration:underline">${copy.unsubscribe}</a>` +
    `</p></div>`
  );
}

// ── the attach decision ─────────────────────────────────────────────────────────────────────────

export type MintedCapability = { capabilityId: string; keyVersion: number };

export interface MarketingAttachDeps {
  /** The mint RPC: creates the capability for this send, or returns the existing one. Throws on
   *  refusal (incl. SQLSTATE NMRET for a retired-generation retry). */
  mintCapability: (args: {
    scopeKind: "platform" | "academy" | "trainer";
    scopeId: string | null;
    address: string;
    sourceKind: string;
    sourceId: string;
  }) => Promise<MintedCapability>;
  /** The read-only source lookup (get_manage_capability_for_source). Null when absent. */
  readCapabilityForSource: (
    sourceKind: string,
    sourceId: string,
  ) => Promise<(MintedCapability & { revoked: boolean; expired: boolean }) | null>;
  /** Authoritative key state (notification_manage_key_state), null when unreadable/absent. */
  keyState: ManageKeyState | null;
  /** Key material lookup; defaults to env inside buildManageToken. Injectable for tests. */
  keyLookup?: KeyLookup;
}

export type MarketingAttachment =
  /** Fresh or already-footered send: attach this token's footer + headers. */
  | { kind: "attach"; token: string }
  /** Pre-cutover row: its provider-accepted body has no footer; a retry must stay byte-identical. */
  | { kind: "legacy_no_footer" }
  /** The send must NOT go out (retired/revoked capability, unavailable keys). Terminal for this
   *  attempt path — never silently downgraded to "send without unsubscribe". */
  | { kind: "terminal"; reason: string };

/**
 * Decide what this send carries. `attempted` is whether the row has EVER been attempted
 * (campaigns: attempt_count > 0) — the cutover discriminator.
 */
export async function resolveMarketingAttachment(
  deps: MarketingAttachDeps,
  input: {
    scopeKind: "platform" | "academy" | "trainer";
    scopeId: string | null;
    address: string;
    sourceKind: string;
    sourceId: string;
    attempted: boolean;
  },
): Promise<MarketingAttachment> {
  let cap: MintedCapability;
  if (input.attempted) {
    const existing = await deps.readCapabilityForSource(input.sourceKind, input.sourceId);
    if (!existing) {
      // First attempted before the footer deploy: the provider-accepted body is footer-less and
      // the idempotency key is unchanged, so the retry must reproduce those exact bytes.
      return { kind: "legacy_no_footer" };
    }
    if (existing.revoked || existing.expired) {
      // N2 §3: a non-live capability blocks the SEND. Mailing a dead unsubscribe would read as
      // delivered while the opt-out silently stopped working.
      return { kind: "terminal", reason: existing.revoked ? "capability_revoked" : "capability_expired" };
    }
    cap = existing;
  } else {
    cap = await deps.mintCapability({
      scopeKind: input.scopeKind,
      scopeId: input.scopeId,
      address: input.address,
      sourceKind: input.sourceKind,
      sourceId: input.sourceId,
    });
  }

  try {
    const token = await buildManageToken(cap.capabilityId, cap.keyVersion, deps.keyState, deps.keyLookup);
    return { kind: "attach", token };
  } catch (err) {
    // buildManageToken throws only on operational refusals: retired generation, missing key
    // material, invalid state. Every one means the unsubscribe would be dead — block the send.
    return { kind: "terminal", reason: err instanceof Error ? err.message : "token_build_failed" };
  }
}
