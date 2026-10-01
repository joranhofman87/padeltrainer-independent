/**
 * ABC-16 H0 — the client-side half of the overlay write containment.
 *
 * `academy_player_metadata` and `academy_player_locations` are presentation overlays that
 * were directly writable by any authenticated academy manager or trainer, for a
 * caller-chosen subject. Because three authorization predicates treated a row in those
 * tables as PROOF of the academy↔player relationship, minting one exposed a guest's
 * personal data and made a nascent account's login email rewritable. The H0 migration
 * (20261118110000) removes that authority and withdraws every client write privilege.
 *
 * With the privilege gone, the old writers would fail at the network boundary with a raw
 * `permission denied` / `violates row-level security policy`. Two things must not happen:
 * the user must not be shown that, and no surface may report a write as successful when
 * the database refused it. So every writer short-circuits HERE, before the request is
 * made, with one typed error the UI translates.
 *
 * This is deliberately a hard block rather than a feature flag. There is no configuration
 * under which the old direct write is safe again: the writer returns only when a later H1
 * command derives the subject from canonical membership server-side. Rollback of this
 * containment is forward-only.
 *
 * READS ARE UNAFFECTED. Notes, tags, soft-removal state, billing overrides and curated
 * clubs all still load and still render — they are shown read-only, never hidden.
 */

/** Surfaces whose writer H0 withdrew. Used only to explain the block to the user. */
export type ContainedOverlaySurface =
  | 'notes'
  | 'tags'
  | 'removal'
  | 'billingEmail'
  | 'locations'
  | 'preferredLocation';

/**
 * Thrown instead of attempting a write the database will refuse.
 *
 * Carries a stable `surface` so a component can explain which control is temporarily
 * read-only without parsing a message, and a non-technical `message` so an untranslated
 * fallback path still shows something a person can act on.
 */
export class OverlayWriteDisabledError extends Error {
  readonly code = 'overlay_write_disabled' as const;
  readonly surface: ContainedOverlaySurface;

  constructor(surface: ContainedOverlaySurface) {
    super(
      'This detail is temporarily read-only while we improve how player records are linked to your academy. Nothing was changed.',
    );
    this.name = 'OverlayWriteDisabledError';
    this.surface = surface;
  }
}

/** Narrow an unknown caught value to the containment error. */
export function isOverlayWriteDisabledError(error: unknown): error is OverlayWriteDisabledError {
  return (
    error instanceof OverlayWriteDisabledError ||
    (typeof error === 'object' &&
      error !== null &&
      (error as { code?: unknown }).code === 'overlay_write_disabled')
  );
}

/**
 * Refuse an overlay write. Always throws — the `never` return lets a writer call it as its
 * whole body without TypeScript demanding an unreachable return afterwards.
 */
export function refuseOverlayWrite(surface: ContainedOverlaySurface): never {
  throw new OverlayWriteDisabledError(surface);
}
