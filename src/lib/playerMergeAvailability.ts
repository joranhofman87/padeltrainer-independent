/**
 * Pass B §4 — player merge is UNAVAILABLE.
 *
 * `merge_guest_players` is a retired RPC. Merging decided that two guest rows were one human,
 * and the evidence it used to justify that — shared email, shared name, the legacy account
 * bridge — is exactly what this containment withdrew. A merge is also irreversible: it moves
 * bookings and invoices and deletes a row, so a wrong one cannot be undone from the UI.
 *
 * Every entry point imports the availability from HERE so there is one truth. The UI must be
 * unavailable BEFORE any network activity: no request is made, nothing optimistic is written,
 * and no success is ever reported. A disabled-looking control that still fires on Enter is not
 * unavailable — the action itself is gone, not merely styled as absent.
 */

/** The retired RPC. Exported so tests can assert, by name, that nothing calls it. */
export const RETIRED_MERGE_RPC = 'merge_guest_players' as const;

/**
 * Is player merge available? Always false.
 *
 * A function rather than a bare `false` so that consumers read as a capability check, and so a
 * later decision to restore merging behind real evidence has exactly one place to change.
 */
export function isPlayerMergeAvailable(): boolean {
  return false;
}

/** i18n key + neutral English default for the explicit unavailable state. */
export const PLAYER_MERGE_UNAVAILABLE_I18N = {
  titleKey: 'players.merge.unavailableTitle',
  titleDefault: 'Merging players is unavailable',
  bodyKey: 'players.merge.unavailableBody',
  bodyDefault:
    'Combining two players into one is switched off. It relied on matching names, email addresses and old account links to decide that two entries were the same person, which is not reliable enough to move trainings and invoices — and a merge cannot be undone. Edit each player separately instead.',
} as const;
