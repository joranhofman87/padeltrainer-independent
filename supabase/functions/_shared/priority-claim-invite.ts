/**
 * Pure helpers for send-priority-claim-invitation.
 *
 * Security context: the invitation email embeds a slot_priority_claims
 * claim_token, which grants anyone holding it the ability to view the claim
 * (player name/email) and decline it. Therefore:
 *  - a "test" send (preview to an arbitrary address) must NOT carry a real
 *    token, and
 *  - the recipient of a test send is the caller's own email only.
 */

/** Resolve the app base URL, never falling back to a stale external domain. */
export function resolveAppBase(publicAppUrl: string | undefined | null): string {
  const trimmed = (publicAppUrl ?? "").trim().replace(/\/+$/, "");
  return trimmed || "https://padeltrainer.ai";
}

/**
 * Build the claim URL for an email. For test/preview sends we deliberately emit
 * a non-functional placeholder token so a live token is never delivered to an
 * inbox during previews.
 */
export function buildClaimUrl(
  appBase: string,
  claimToken: string,
  isTest: boolean,
): string {
  const base = appBase.replace(/\/+$/, "");
  const token = isTest ? "preview" : claimToken;
  return `${base}/claim/${token}`;
}

/**
 * Decide the recipient for a single claim email.
 * - test send: always the caller's own email (never an attacker-chosen one)
 * - real send: the claim's player/guest email
 */
export function resolveRecipient(args: {
  isTest: boolean;
  callerEmail: string | null | undefined;
  playerEmail: string | null | undefined;
  guestEmail: string | null | undefined;
}): string | null {
  if (args.isTest) {
    return args.callerEmail?.trim() || null;
  }
  return args.playerEmail || args.guestEmail || null;
}
