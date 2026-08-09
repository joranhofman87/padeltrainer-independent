/**
 * One id per create ATTEMPT.
 *
 * Since U2 a Player is created idempotently on a UUID the caller chooses, because no attribute of a
 * person may be used to recognise a repeat: names get corrected, addresses are shared by families,
 * and plenty of players have no address at all. The id has to survive a retry of the SAME attempt
 * and it has to change when the attempt itself changes — those are opposite requirements, and
 * getting either one wrong is a bug you only see in production:
 *
 *   - a fresh id per call        → a double-click or a network replay makes a second Player;
 *   - one id held forever        → correcting a typo and saving again is refused as a conflict,
 *                                  because the server sees one attempt claiming two payloads.
 *
 * So the id is keyed on the material facts of the attempt. Same facts, same id; edit the recipient,
 * and it is honestly a different attempt.
 */
export type CreationAttempt = { key: string; id: string } | null;

/** Stable id for the attempt described by `key`, minting a new one when the facts change. */
export function creationRequestIdFor(
  ref: { current: CreationAttempt },
  key: string,
): string {
  if (!ref.current || ref.current.key !== key) {
    ref.current = { key, id: crypto.randomUUID() };
  }
  return ref.current.id;
}

/** Call after the attempt has succeeded: whatever comes next is a new Player, not a retry. */
export function clearCreationAttempt(ref: { current: CreationAttempt }): void {
  ref.current = null;
}
