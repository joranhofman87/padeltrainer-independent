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
 *
 * The claim route is nested under /:lang/* (LanguageRouter sets the page language
 * from the path segment). Without a prefix, /claim/:token redirects to the browser
 * default (usually /en/...), so a Dutch email landed on an English page. Prefix with
 * the email's language — default nl to match the Dutch invite — exactly like the
 * invoice email's buildPayUrl. The app only serves nl/en, so clamp anything else.
 */
export function buildClaimUrl(
  appBase: string,
  claimToken: string,
  isTest: boolean,
  lang = "nl",
): string {
  const base = appBase.replace(/\/+$/, "");
  const token = isTest ? "preview" : claimToken;
  const safeLang = lang === "en" ? "en" : "nl";
  return `${base}/${safeLang}/claim/${token}`;
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
