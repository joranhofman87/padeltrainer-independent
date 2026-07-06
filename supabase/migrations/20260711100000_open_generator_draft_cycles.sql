-- Retire the quick-generator draft stage: one-time promotion of historical drafts.
--
-- PR #379 removed draft creation (the generator now creates status='open' cycles
-- directly, slot visibility per the wizard's choice). This flips the drafts that
-- already exist so the frontend's draft heal machinery (concept banner, "already
-- live" banner, bulk-visibility promotion) can be deleted in the same release.
--
-- SCOPE — generator drafts ONLY (settings->>'generated_by' = 'slot_generator'):
-- bulk-rebook-cycle uses status='draft' as its "half-built rebuild target" marker
-- (a draft rebook cycle is cleaned up and rebuilt on re-run; a non-draft one means
-- already_exists) — those MUST keep their draft status, so no blanket flip.
--
-- Slot visibility is deliberately untouched: an unpublished generator draft becomes
-- an open cycle with private slots — exactly the shape the generator now produces
-- for the 'private' visibility choice. Nothing becomes publicly bookable by this
-- migration.

UPDATE public.cycles
SET status = 'open', updated_at = now()
WHERE status = 'draft'
  AND settings->>'generated_by' = 'slot_generator';
