/**
 * Pass B §4 — who may be added to, or swapped into, a cycle roster.
 *
 * Only a DIRECTLY OWNED GUEST. A registered player is refused, and refused BEFORE any network
 * activity: no twin is minted, no roster write is attempted, and no optimistic state is set.
 *
 * Why registered admission is gone. Adding a registered player used to mint (or find) a "guest
 * twin" for them so the guest-keyed booking and invoice chain could seat them. That twin was
 * created from a name/email match against the account, which is the legacy identity evidence this
 * containment withdrew — a twin minted for the wrong human seats and BILLS the wrong human, and
 * the resulting bookings and invoices are not easy to unwind. `resolveOrCreateGuestTwinForRegisteredPlayer`
 * is retired for this path.
 *
 * The rule is a pure predicate so the UI, the handlers and the tests all read the same one.
 */

/** The retired resolver. Exported by name so a test can assert nothing on this path calls it. */
export const RETIRED_TWIN_RESOLVER = 'resolveOrCreateGuestTwinForRegisteredPlayer' as const;

export type RosterAdmissionRefusal = 'registered_membership_required' | 'no_identity';

export interface RosterAdmissionCandidate {
  guestPlayerId?: string | null;
  profileId?: string | null;
}

export type RosterAdmission =
  | { admitted: true; guestPlayerId: string }
  | { admitted: false; reason: RosterAdmissionRefusal };

/**
 * Decide admission WITHOUT touching the network.
 *
 * A candidate carrying a guest id is that guest (FAM-02: an accompanying profile id on the same
 * row is decoration and is not used to route anything). Anything else is refused.
 */
export function admitRosterCandidate(person: RosterAdmissionCandidate | null | undefined): RosterAdmission {
  // Blank and whitespace-only ids FAIL CLOSED. An earlier draft wrote
  //   person?.guestPlayerId?.trim?.() || person?.guestPlayerId
  // which falls back to the UNTRIMMED value, so "   " was admitted as a guest id and would have
  // been sent to the roster writer as an identity.
  const raw = person?.guestPlayerId;
  const guestPlayerId = typeof raw === 'string' ? raw.trim() : '';
  if (guestPlayerId.length > 0) return { admitted: true, guestPlayerId };

  const profileRaw = person?.profileId;
  const profileId = typeof profileRaw === 'string' ? profileRaw.trim() : '';
  if (profileId.length > 0) return { admitted: false, reason: 'registered_membership_required' };
  return { admitted: false, reason: 'no_identity' };
}

/** Is this candidate selectable at all? Used to make the control unavailable, not just refusing. */
export function isRosterCandidateSelectable(person: RosterAdmissionCandidate | null | undefined): boolean {
  return admitRosterCandidate(person).admitted;
}

/** i18n key + neutral English default for the refusal. Contains no personal data. */
export const ROSTER_REGISTERED_UNAVAILABLE_I18N = {
  key: 'detail.roster.registeredUnavailable',
  default:
    'Players with their own account can’t be added to a cycle here. Ask them to book, or add a player you manage yourself.',
} as const;
