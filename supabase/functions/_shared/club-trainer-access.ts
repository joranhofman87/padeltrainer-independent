/**
 * Pure authorization decision for create-club-trainer.
 *
 * A caller may only create/attach a trainer when they manage the *specific*
 * club AND the requested location actually belongs to that club. This guards
 * against a manager of one club minting trainer accounts on another club.
 */

export type ClubTrainerAccessInput = {
  /** Whether the caller manages the specific target club. */
  managesClub: boolean;
  /** The location_id that the target club is bound to (null if club missing). */
  clubLocationId: string | null | undefined;
  /** The location_id supplied in the request. */
  requestedLocationId: string | null | undefined;
};

export type ClubTrainerAccessResult =
  | { ok: true }
  | { ok: false; reason: "not_club_manager" | "location_mismatch" };

export function evaluateClubTrainerAccess(
  input: ClubTrainerAccessInput,
): ClubTrainerAccessResult {
  if (!input.managesClub) {
    return { ok: false, reason: "not_club_manager" };
  }
  if (
    !input.clubLocationId ||
    !input.requestedLocationId ||
    input.clubLocationId !== input.requestedLocationId
  ) {
    return { ok: false, reason: "location_mismatch" };
  }
  return { ok: true };
}
