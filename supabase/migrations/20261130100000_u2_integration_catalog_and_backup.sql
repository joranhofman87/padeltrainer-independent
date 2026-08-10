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
--   So the relation is given an explicit OWNER scope below, and only then is the fingerprint pinned.
CREATE OR REPLACE FUNCTION public.academy_deletion_extra_relations()
RETURNS TABLE (relname text, role text)
LANGUAGE sql
IMMUTABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT * FROM (VALUES
    ('academy_player_metadata',          'overlay'),
    ('academy_player_locations',         'overlay'),
    ('availability_slots',               'detached'),
    ('invoices',                         'blocker'),
    ('cycles',                           'blocker'),
    ('registrations',                    'blocker'),
    ('person_links',                     'identity'),
    ('persons',                          'identity'),
    ('academy_player_memberships',       'identity'),
    ('person_merge_review',              'mutated'),
    -- U2: owned through a polymorphic (owner_type, owner_id) pair that no FK describes.
    ('identity_verification_challenges', 'owner_scoped')
  ) AS t(relname, role);
$$;

-- The owner scope itself. OR-ed with whatever the FK graph already reached, exactly like the
-- overlay arm above it: a challenge can be reached BOTH as this academy's own row AND as a row
-- whose selected person is dying, and either predicate alone under-counts.
--
-- The person arm stays: `selected_person_id ... ON DELETE CASCADE` means those rows DO disappear
-- when the person does, so a preview that omitted them would be untruthful about what the operation
-- destroys. Including both arms is what makes the count match reality.
CREATE OR REPLACE FUNCTION public.academy_deletion_deleted_scope(_relname text)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_scope text;
  v_person_scope text;
BEGIN
  IF _relname = 'persons' THEN
    RETURN public.academy_deletion_dying_persons_pred();
  END IF;

  v_scope := public.academy_deletion_scope_predicate(_relname);

  v_person_scope := public.academy_deletion_scope_predicate(
    _relname, 'persons', public.academy_deletion_dying_persons_pred());
  IF v_person_scope IS NOT NULL THEN
    v_scope := CASE WHEN v_scope IS NULL THEN v_person_scope
                    ELSE '(' || v_scope || ' OR ' || v_person_scope || ')' END;
  END IF;

  IF EXISTS (SELECT 1 FROM public.academy_deletion_extra_relations() er
              WHERE er.relname = _relname AND er.role = 'overlay') THEN
    v_scope := CASE WHEN v_scope IS NULL THEN '(academy_profile_id = $1)'
                    ELSE '(academy_profile_id = $1 OR ' || v_scope || ')' END;
  END IF;

  -- U2 owner-scoped relations: keyed to the academy by a polymorphic pair, not by a foreign key.
  IF EXISTS (SELECT 1 FROM public.academy_deletion_extra_relations() er
              WHERE er.relname = _relname AND er.role = 'owner_scoped') THEN
    v_scope := CASE WHEN v_scope IS NULL
                    THEN '(owner_type = ''academy'' AND owner_id = $1)'
                    ELSE '((owner_type = ''academy'' AND owner_id = $1) OR ' || v_scope || ')' END;
  END IF;

  IF v_scope IS NULL
     AND (EXISTS (SELECT 1 FROM public.academy_deletion_cascade_closure() cc WHERE cc.relname = _relname)
       OR EXISTS (SELECT 1 FROM public.academy_deletion_person_closure() pc WHERE pc.relname = _relname)) THEN
    RAISE EXCEPTION 'ACADEMY_DELETION_CATALOG_DRIFT: % is reached by the cascade but cannot be scoped to one academy', _relname
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN v_scope;
END;
$$;

--   Old: 2238f9c213c1c87b3c6233d42148ee1be33c4173a50dc8ef9758f75d4997ba57  (pre-U2 catalogue)
--   New: 8145bad9294c6b1673ce940abfd8135aa1e2151c534a3f0928d447c334173c28  (U2 identity tables + the owner scope below)
CREATE OR REPLACE FUNCTION public.academy_deletion_expected_fingerprint()
RETURNS text
LANGUAGE sql
IMMUTABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$ SELECT '8145bad9294c6b1673ce940abfd8135aa1e2151c534a3f0928d447c334173c28'::text $$;

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
