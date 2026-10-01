-- U2 × U1c INTEGRATION — the two guards that only fire when these slices are composed.
--
-- Neither PR shows this alone. U1c prerequisite 3 (academy deletion) pins a fingerprint of the REAL
-- schema's deletion catalogue, and U1c prerequisite 4 (backup/export) fails when an identity/Player
-- table is not backed up. U2 adds identity tables, so on the integrated branch both guards refuse —
-- which is exactly what they exist to do. This migration answers them deliberately.
--
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- 1) Re-pin the academy-deletion catalogue fingerprint
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- WHAT CHANGED, and why it is correct rather than something to suppress:
--
--   `identity_verification_challenges` now appears in `academy_deletion_person_closure()`. It gets
--   there through `selected_person_id uuid REFERENCES persons(id) ON DELETE CASCADE` — the column a
--   consumed challenge uses to remember which canonical person the visitor picked.
--
--   That cascade is deliberate and already proven: when a person is merged or deleted away, a
--   consumed challenge pointing at them would otherwise be a dead end that can never resolve. The
--   U2 real-Postgres suite asserts exactly this pair —
--     "deleting the selected person CASCADEs the stale consumed challenge away (no dead end)"
--     "...and the resumed attempt re-resolves (proceed_new: the merged-away guest is gone)"
--   so the row dies with its person and the visitor's next attempt starts clean.
--
--   Per the manifest's own rule ("the new fingerprint is read from
--   academy_deletion_catalog_fingerprint() and pinned here in the same migration that changed it"),
--   re-pinning in THIS migration is the reviewable act.
--
--   BUT the FK is not the whole truth, and re-pinning on its own would have been WRONG. A challenge
--   belongs to an academy through `owner_type`/`owner_id` — a POLYMORPHIC pair with no foreign key
--   (20261129100000, lines 72-73), so the FK-derived catalogue cannot see it. Scoped only through
--   `selected_person_id`, the flow would have missed every challenge whose selection is NULL: each
--   unconsumed challenge, and each consumed "someone new". Those rows carry `contact_normalized` —
--   an email address — and would have OUTLIVED the academy that collected it.
--
--   (The earlier reasoning that "it refused on the fingerprint compare, not on the unscopable
--   refusal, therefore the blast radius is fine" was unsound: `academy_delete_confirmed` compares
--   the fingerprint as step 1, BEFORE the lock plan and the recomputation, so reaching that refusal
--   proves nothing about scoping. Codex round 1 caught it.)
--
--   THE RETENTION GAP THIS LEAVES, recorded rather than silently accepted.
--
--   A challenge belongs to its owner through `owner_type`/`owner_id` — a polymorphic pair with NO
--   foreign key (20261129100000, lines 72-73). Nothing cascades from it. So a challenge whose
--   `selected_person_id` is NULL (every unconsumed one, and every consumed "someone new") survives
--   the deletion of the academy or trainer that collected it, still carrying `contact_normalized` —
--   an email address.
--
--   An earlier revision of THIS migration tried to close the academy half by giving the relation an
--   `owner_scoped` predicate in `academy_deletion_deleted_scope()`. That was withdrawn, because it
--   made things worse rather than better: that predicate feeds the PREVIEW and the digest, but
--   `academy_delete_confirmed` executes a fixed list of statements — the two overlays, this
--   academy's memberships, then the academy root — and nothing there deletes an owner-scoped row.
--   The audit is stamped from `v_preview->'deleted'`, so the scope alone would have made the flow
--   report rows as deleted that were still present. A truthful refusal beats a false receipt, and a
--   count that lies is worse than a count that is merely incomplete.
--
--   Closing it properly means deleting those rows in the execution path (beside the explicit
--   membership delete) and counting them in the same breath, which is surgery on
--   `academy_delete_confirmed` and belongs in its own reviewed slice — together with the TRAINER
--   half, which has the same shape: `delete-user-data.ts` removes a trainer's guests and anonymises
--   the trainer shell without touching trainer-owned challenges. Both halves are one problem and
--   should be fixed once, not twice.
--
--   Until then the preview, the execution and the audit all agree that these rows are not deleted,
--   which is the honest state. Tracked in section 10 of docs/U2_PRODUCTION_CUTOVER_RUNBOOK.md.
--
--   Old: 2238f9c213c1c87b3c6233d42148ee1be33c4173a50dc8ef9758f75d4997ba57  (pre-U2 catalogue)
--   New: 6b87c22354ef4261befdc7ed81d82ca25503e5693ec9653e6834164c7310cc36  (with U2 identity tables)
CREATE OR REPLACE FUNCTION public.academy_deletion_expected_fingerprint()
RETURNS text
LANGUAGE sql
IMMUTABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$ SELECT '6b87c22354ef4261befdc7ed81d82ca25503e5693ec9653e6834164c7310cc36'::text $$;

COMMENT ON FUNCTION public.academy_deletion_expected_fingerprint() IS
  'The REVIEWED academy-deletion catalogue fingerprint. Re-pinned by U2 integration: identity_verification_challenges joined the person closure via selected_person_id ON DELETE CASCADE. Changing this value means editing a migration, which is a review.';

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- 2) Back up the durable create receipt
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- `player_create_commands` is the idempotency ledger that maps a caller's `creation_request_id` to
-- the canonical person that was created for it. Its ONLY job is to make a replayed create return the
-- original Player instead of minting a second one.
--
-- So a restore without it does not lose an audit trail — it loses the thing that PREVENTS duplicate
-- Players, and every retry after the restore creates a new person for a request that already had
-- one. That is the duplication failure this whole programme exists to remove, so the receipt is
-- backed up rather than excluded.
--
-- `identity_verification_challenges` is deliberately NOT backed up; the reason is written next to
-- its exclusion in scripts/db/backup-coverage.mjs (short-lived, single-use, re-mintable).
--
-- The allow-list is IMMUTABLE and lives in the database so it cannot drift from the edge function's
-- TABLES_TO_BACKUP; backup-coverage.mjs asserts the two agree in both directions. Redefining the
-- whole function (rather than appending) keeps it a single reviewable literal.
CREATE OR REPLACE FUNCTION public.backup_export_tables()
RETURNS TABLE (relname text)
LANGUAGE sql
IMMUTABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT * FROM (VALUES
    ('academy_managers'), ('academy_player_locations'), ('academy_player_memberships'),
    ('academy_player_metadata'), ('academy_player_tags'), ('academy_profiles'),
    ('academy_trainers'), ('availability_slots'), ('bookings'), ('club_managers'),
    ('club_profiles'), ('guest_players'), ('intake_requests'), ('invoices'),
    ('locations'), ('membership_backfill_items'), ('membership_backfill_runs'),
    ('notification_contacts'), ('person_links'), ('person_merge_review'), ('persons'),
    ('player_create_commands'),
    ('profiles'), ('proposed_assignments'), ('session_player_notes'),
    ('slot_priority_claims'), ('trainer_profiles'), ('user_roles')
  ) AS t(relname);
$$;

COMMENT ON FUNCTION public.backup_export_tables() IS
  'The tables the backup may export, as an immutable allow-list. Mirrors TABLES_TO_BACKUP in supabase/functions/backup-database/index.ts; scripts/db/backup-coverage.mjs proves the two cannot drift. U2 added player_create_commands: the create receipt that stops a replay from minting a duplicate Player.';
