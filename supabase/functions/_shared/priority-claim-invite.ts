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
import { personContactEmail, type PersonIdRow } from "./person-identity.ts";

/** Resolve the app base URL, never falling back to a stale external domain. */
export function resolveAppBase(publicAppUrl: string | undefined | null): string {
  const trimmed = (publicAppUrl ?? "").trim().replace(/\/+$/, "");
  return trimmed || "https://padeltrainer.ai";
}

/** Shape of a guest_players embed: the guest's OWN address. Nothing else is contact. */
export interface GuestEmailSource {
  email?: string | null;
}

/**
 * A guest person's contact email: their OWN address, or null.
 *
 * Pass B §2 removed the linked-profile fallback. The argument for it was that a guest without
 * their own address would otherwise stop receiving invites — true, but the address it fell back
 * to was chosen by a legacy email/name matcher, so "the child's mail goes to the parent" and
 * "this stranger's mail goes to whoever once shared their address" were the SAME code path, and
 * nothing in the row distinguished them. A claim token is a bearer credential for a seat; it
 * cannot be sent to a maybe.
 *
 * A guest with no address is now unresolved, and the callers' existing explicit skip/no-contact
 * outcome reports it.
 */
export function effectiveGuestEmail(guest: GuestEmailSource | null | undefined): string | null {
  return guest?.email?.trim() || null;
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
 * - real send: the claim's contact email under FAM-02 Level 1 — GUEST-FIRST, keyed on the row's
 *   ids (person-identity twin), NOT profile-first. A dual-key person (player_id = the linked
 *   parent profile, guest_player_id = the child) is the GUEST, so their OWN email (guestEmail,
 *   already resolved via effectiveGuestEmail = the guest's own address) wins; the
 *   linked profile's address (playerEmail) is the fallback ONLY when the guest has none. The old
 *   `playerEmail || guestEmail` was profile-first and mailed a child at the parent's inbox.
 */
export function resolveRecipient(args: {
  isTest: boolean;
  callerEmail: string | null | undefined;
  row: PersonIdRow;
  playerEmail: string | null | undefined;
  guestEmail: string | null | undefined;
}): string | null {
  if (args.isTest) {
    return args.callerEmail?.trim() || null;
  }
  return personContactEmail(args.row, { profileEmail: args.playerEmail, guestEmail: args.guestEmail });
}
