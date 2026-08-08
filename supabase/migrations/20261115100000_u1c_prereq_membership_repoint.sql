-- U1c PREREQUISITE 1 — make person merge/collapse membership-aware.
--
-- WHY THIS MUST EXIST BEFORE ANY MEMBERSHIP ROW IS WRITTEN.
-- Three shipped paths end by deleting a person:
--   * `collapse_guest_person_into` (20260826280000) — an explicit DELETE after repointing the stamp
--     tables;
--   * the last-source cleanup trigger on profiles/guest_players (same migration) — deletes the person
--     when its final link disappears;
--   * `merge_guest_players` (20260826240000) — deletes the source guest row, which fires the trigger.
-- `academy_player_memberships.person_id` is ON DELETE RESTRICT (OD-10), so once that table holds rows
-- every one of those paths aborts. The two MERGE paths have a survivor to repoint to, and that is what
-- this migration fixes. Last-source DELETION has no survivor and is a different problem — retain and
-- pseudonymize per OD-08 — handled in its own slice.
--
-- WHAT A COLLISION MEANS TODAY (owner ruling, 2026-08-08).
-- A membership row is five columns: two keys and two timestamps. It carries no academy-private data.
-- So "both persons were members of academy A" is not a conflict between two versions of something —
-- it is one relationship recorded twice. The rows are COALESCED into one, keeping the EARLIEST
-- created_at, because the relationship began when the first of them began and moving it later would
-- falsify the record.
--
-- AND WHY THAT PERMISSION EXPIRES BY ITSELF.
-- The moment a membership carries academy-private children — notes, tags, assignments, settings,
-- billing — discarding one of two rows would silently destroy or merge those children, and OD-10 then
-- requires refusal or an explicit conflict preview. A comment saying so would be missed by whoever
-- adds the first child table, so the guard below reads the CATALOG instead: if anything references
-- `academy_player_memberships` by foreign key, coalescence REFUSES. Nobody has to remember.
-- A plain MOVE stays allowed even then — moving a membership row carries its children with it and
-- destroys nothing. Only coalescence discards a row.

CREATE OR REPLACE FUNCTION public.repoint_person_memberships(
  _from uuid, _to uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_moved integer := 0;
  v_coalesced integer := 0;
  v_conflicts integer := 0;
  v_child_tables text[];
BEGIN
  -- Callable blindly from the merge paths: a self-repoint is a no-op, not an error.
  IF _from IS NULL OR _to IS NULL OR _from = _to THEN
    RETURN jsonb_build_object('moved', 0, 'coalesced', 0, 'self_or_null', true);
  END IF;

  -- Lock the two PERSONS first, in UUID order.
  --
  -- Locking the membership rows alone is not enough, and was this function's first bug: FOR UPDATE
  -- locks rows that EXIST, so a concurrent INSERT of a brand-new (academy, _to) pair sails past it and
  -- can manufacture a collision after the conflict check has already run — turning a planned MOVE into
  -- a unique violation, or letting the coalesce branch discard a row without the child-data guard
  -- having been re-evaluated for it. Inserting a membership takes a KEY SHARE lock on its `persons`
  -- parent, and FOR UPDATE conflicts with KEY SHARE, so taking the parents here serialises every such
  -- insert against this repoint for its whole duration. The UUID ordering gives two concurrent
  -- repoints a deterministic acquisition order instead of a deadlock.
  PERFORM 1 FROM public.persons
   WHERE id IN (_from, _to)
   ORDER BY id
   FOR UPDATE;

  -- Then the membership rows themselves, so the rows about to move cannot be updated under us.
  PERFORM 1 FROM public.academy_player_memberships
   WHERE person_id IN (_from, _to)
   ORDER BY id
   FOR UPDATE;

  SELECT count(*) INTO v_conflicts
    FROM public.academy_player_memberships s
   WHERE s.person_id = _from
     AND EXISTS (SELECT 1 FROM public.academy_player_memberships t
                  WHERE t.person_id = _to
                    AND t.academy_profile_id = s.academy_profile_id);

  IF v_conflicts > 0 THEN
    -- The self-activating OD-10 guard. `confrelid` is the referenced table, so this finds every FK
    -- pointing AT memberships — i.e. every academy-private child table that exists.
    SELECT coalesce(array_agg(DISTINCT c.conrelid::regclass::text), '{}'::text[])
      INTO v_child_tables
      FROM pg_constraint c
     WHERE c.contype = 'f'
       AND c.confrelid = 'public.academy_player_memberships'::regclass;

    IF array_length(v_child_tables, 1) > 0 THEN
      RAISE EXCEPTION
        'REFUSING to coalesce % duplicate membership(s) for person %: academy-private child data now hangs off memberships (%). Automatic coalescence was only ever safe while a membership was keys and timestamps. Produce the OD-10 conflict preview and resolve explicitly.',
        v_conflicts, _from, array_to_string(v_child_tables, ', ')
        USING ERRCODE = 'raise_exception',
              HINT = 'See 20261115100000_u1c_prereq_membership_repoint.sql — this guard reads pg_constraint, so it armed itself when the child table was added.';
    END IF;
  END IF;

  -- COALESCE the conflicts: the survivor keeps the earliest start, then the loser is removed. Done
  -- before the move so the move's remaining rows are conflict-free by construction.
  WITH pairs AS (
    SELECT s.id AS source_id, t.id AS target_id, s.created_at AS source_created_at
      FROM public.academy_player_memberships s
      JOIN public.academy_player_memberships t
        ON t.person_id = _to AND t.academy_profile_id = s.academy_profile_id
     WHERE s.person_id = _from
  ), survivors AS (
    UPDATE public.academy_player_memberships t
       SET created_at = LEAST(t.created_at, p.source_created_at)
      FROM pairs p
     WHERE t.id = p.target_id
    RETURNING t.id
  ), losers AS (
    DELETE FROM public.academy_player_memberships s
     USING pairs p
     WHERE s.id = p.source_id
    RETURNING s.id
  )
  SELECT count(*) INTO v_coalesced FROM losers;

  -- MOVE whatever is left: no target row exists for those academies, so the unique constraint is safe.
  WITH moved AS (
    UPDATE public.academy_player_memberships
       SET person_id = _to
     WHERE person_id = _from
    RETURNING id
  )
  SELECT count(*) INTO v_moved FROM moved;

  -- The post-condition the callers depend on: nothing references `_from` any more, so the person can
  -- now be deleted without hitting the RESTRICT FK.
  IF EXISTS (SELECT 1 FROM public.academy_player_memberships WHERE person_id = _from) THEN
    RAISE EXCEPTION 'repoint_person_memberships: person % still holds membership rows after repoint', _from
      USING ERRCODE = 'internal_error';
  END IF;

  RETURN jsonb_build_object('moved', v_moved, 'coalesced', v_coalesced);
END;
$$;

COMMENT ON FUNCTION public.repoint_person_memberships(uuid, uuid) IS
  'U1c prerequisite: transactionally repoint academy_player_memberships from one person to a survivor, coalescing duplicates at the same academy (earliest created_at wins). REFUSES to coalesce once any table references academy_player_memberships by FK — academy-private child data requires the OD-10 conflict preview instead. Returns {moved, coalesced}.';

-- Internal plumbing for the merge/collapse paths, which are themselves SECURITY DEFINER. No app role
-- may call it directly: repointing identity is not a client operation.
REVOKE ALL ON FUNCTION public.repoint_person_memberships(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Wiring 1/2 — collapse_guest_person_into
-- ---------------------------------------------------------------------------
-- Reproduces 20260826280000_persons_backfill.sql:471 verbatim, with ONE addition: the memberships are
-- repointed to the target immediately before the person is deleted. Everything else — the sole-source
-- and login-less preconditions, the link repoint first so the Phase-1 stamp triggers re-derive
-- consistently, the eleven stamp-table updates, the return contract — is unchanged.
--
-- It still RETURNS boolean: the twin-claim and signup triggers call it with PERFORM/IF and changing
-- the signature would break them. A coalescence is therefore surfaced with RAISE NOTICE rather than
-- through a new return channel or a new audit table.

CREATE OR REPLACE FUNCTION public.collapse_guest_person_into_reporting(
  _guest_id uuid, _guest_person uuid, _target_person uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_memberships jsonb;
BEGIN
  IF _guest_person = _target_person THEN
    RETURN jsonb_build_object('ok', true, 'moved', 0, 'coalesced', 0);
  END IF;
  IF EXISTS (SELECT 1 FROM public.person_links
             WHERE person_id = _guest_person AND guest_player_id IS DISTINCT FROM _guest_id)
     OR EXISTS (SELECT 1 FROM public.persons WHERE id = _guest_person AND user_id IS NOT NULL) THEN
    RETURN jsonb_build_object('ok', false, 'moved', 0, 'coalesced', 0);
  END IF;
  UPDATE public.person_links SET person_id = _target_person WHERE guest_player_id = _guest_id;
  PERFORM public.rederive_person(_target_person);  -- the merged guest now fills the target's gaps
  UPDATE public.bookings SET person_id = _target_person
    WHERE guest_player_id = _guest_id AND person_id = _guest_person;
  UPDATE public.bookings SET paid_by_person_id = _target_person
    WHERE paid_by_guest_player_id = _guest_id AND paid_by_person_id = _guest_person;
  UPDATE public.invoices SET person_id = _target_person
    WHERE guest_player_id = _guest_id AND person_id = _guest_person;
  UPDATE public.intake_requests SET person_id = _target_person
    WHERE guest_player_id = _guest_id AND person_id = _guest_person;
  UPDATE public.slot_priority_claims SET person_id = _target_person
    WHERE guest_player_id = _guest_id AND person_id = _guest_person;
  UPDATE public.slot_priority_claims SET booked_by_person_id = _target_person
    WHERE booked_by_guest_player_id = _guest_id AND booked_by_person_id = _guest_person;
  UPDATE public.session_player_notes SET subject_person_id = _target_person
    WHERE subject_guest_player_id = _guest_id AND subject_person_id = _guest_person;
  UPDATE public.academy_player_locations SET person_id = _target_person
    WHERE guest_player_id = _guest_id AND person_id = _guest_person;
  UPDATE public.academy_player_metadata SET person_id = _target_person
    WHERE guest_player_id = _guest_id AND person_id = _guest_person;

  -- THE ADDITION. Memberships are keyed by PERSON, not by the guest row, so they are not covered by
  -- any of the updates above — and their FK is RESTRICT, so without this the DELETE below fails and
  -- the whole collapse aborts once the table is populated.
  v_memberships := public.repoint_person_memberships(_guest_person, _target_person);

  DELETE FROM public.persons WHERE id = _guest_person;
  RETURN jsonb_build_object(
    'ok', true,
    'moved',     coalesce((v_memberships->>'moved')::int, 0),
    'coalesced', coalesce((v_memberships->>'coalesced')::int, 0));
END;
$$;

-- The original boolean entry point, preserved EXACTLY, as a thin wrapper. Anything that still calls
-- the three-argument boolean form — including code outside this programme — keeps working unchanged.
CREATE OR REPLACE FUNCTION public.collapse_guest_person_into(
  _guest_id uuid, _guest_person uuid, _target_person uuid
)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT (public.collapse_guest_person_into_reporting(_guest_id, _guest_person, _target_person)->>'ok')::boolean;
$$;

REVOKE ALL ON FUNCTION public.collapse_guest_person_into_reporting(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Wiring 2/2 — merge_guest_players
-- ---------------------------------------------------------------------------
-- Reproduced from 20260826240000_twin_reader_precedence_and_lock.sql:293 with exactly THREE additions,
-- applied programmatically so the 290 lines in between are byte-identical to what shipped:
--   1. three new locals;
--   2. the membership repoint immediately before the source guest row is deleted (that DELETE fires
--      the last-source trigger, which deletes the person — RESTRICT would abort the whole merge);
--   3. `memberships_moved` / `memberships_coalesced` folded into the jsonb this function ALREADY
--      returns. That return IS the operation's existing evidence; no new audit surface is introduced.

CREATE OR REPLACE FUNCTION public.merge_guest_players(
  p_scope text,            -- 'academy' | 'trainer'
  p_scope_id uuid,
  p_source_guest_id uuid,
  p_target_guest_id uuid,
  p_fields jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_source public.guest_players%ROWTYPE;
  v_target public.guest_players%ROWTYPE;
  v_trainer_ids uuid[];
  v_person_refs uuid[];
  v_bookings integer := 0;
  v_invoices integer := 0;
  v_intakes integer := 0;
  v_claims integer := 0;
  v_claims_dropped integer := 0;
  v_booking_dups integer := 0;
  v_meta_moved integer := 0;
  v_meta_merged integer := 0;
  v_notes integer := 0;
  v_locations integer := 0;
  v_locations_dropped integer := 0;
  v_captain_claims integer := 0;
  v_captain_bookings integer := 0;
  v_keep_email text;
  m record;
  -- U1c prerequisite: memberships are keyed by PERSON, not by the guest row.
  v_src_person uuid;
  v_tgt_person uuid;
  v_src_person_dies boolean := false;
  v_membership_repoint jsonb := '{}'::jsonb;
BEGIN
  IF p_source_guest_id = p_target_guest_id THEN
    RAISE EXCEPTION 'source and target are the same player';
  END IF;

  -- ---- authorization (explicit; the function bypasses RLS below) ----
  IF p_scope = 'academy' THEN
    IF NOT public.is_academy_manager(auth.uid(), p_scope_id) THEN
      RAISE EXCEPTION 'not authorized for academy %', p_scope_id USING ERRCODE = '42501';
    END IF;
    SELECT coalesce(array_agg(at.trainer_profile_id), '{}'::uuid[])
      INTO v_trainer_ids
      FROM public.academy_trainers at
     WHERE at.academy_profile_id = p_scope_id AND at.status = 'active';
  ELSIF p_scope = 'trainer' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.trainer_profiles tp
       WHERE tp.id = p_scope_id AND tp.user_id = auth.uid()
    ) THEN
      RAISE EXCEPTION 'not authorized for trainer %', p_scope_id USING ERRCODE = '42501';
    END IF;
    v_trainer_ids := ARRAY[p_scope_id];
  ELSE
    RAISE EXCEPTION 'invalid scope: %', p_scope;
  END IF;

  SELECT * INTO v_source FROM public.guest_players WHERE id = p_source_guest_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'source player not found'; END IF;
  SELECT * INTO v_target FROM public.guest_players WHERE id = p_target_guest_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'target player not found'; END IF;

  -- both players must be members of the scope (same rules as the overview).
  -- coalesce() keeps the checks NULL-safe: a guest with a NULL owner column
  -- must be rejected, not slip through three-valued logic.
  IF p_scope = 'academy' THEN
    IF NOT (coalesce(v_source.academy_profile_id = p_scope_id, false)
              OR coalesce(v_source.trainer_id = ANY (v_trainer_ids), false))
       OR NOT (coalesce(v_target.academy_profile_id = p_scope_id, false)
              OR coalesce(v_target.trainer_id = ANY (v_trainer_ids), false)) THEN
      RAISE EXCEPTION 'both players must belong to the academy';
    END IF;
  ELSE
    IF v_source.trainer_id IS DISTINCT FROM p_scope_id
       OR v_target.trainer_id IS DISTINCT FROM p_scope_id THEN
      RAISE EXCEPTION 'both players must belong to the trainer';
    END IF;
  END IF;

  -- The two rows may reference at most ONE distinct person. Per ROW, the explicit manager
  -- assertion (twin_of_profile_id) OUTRANKS the email-inferred trigger link (linked_profile_id):
  -- the linked column has no name guard, so a stale family mislink (child's row linked to the
  -- parent) must not make an explicitly-twinned row unmergeable forever. ACROSS the two rows, two
  -- different effective references still refuse — never conflate two humans.
  SELECT coalesce(array_agg(DISTINCT p), '{}'::uuid[]) INTO v_person_refs
  FROM unnest(ARRAY[
    coalesce(v_source.twin_of_profile_id, v_source.linked_profile_id),
    coalesce(v_target.twin_of_profile_id, v_target.linked_profile_id)
  ]) AS p
  WHERE p IS NOT NULL;
  IF array_length(v_person_refs, 1) > 1 THEN
    RAISE EXCEPTION 'players reference two different accounts and cannot be merged';
  END IF;

  -- Email being kept on the target (source email is cleared before delete so
  -- applying it can never self-conflict).
  v_keep_email := CASE
    WHEN p_fields ? 'email' THEN nullif(btrim(p_fields->>'email'), '')
    ELSE v_target.email
  END;

  ------------------------------------------------------------------
  -- Metadata (tags, academy notes, removal): per owner, merge source's
  -- row into the target's (tags union, notes appended) or repoint it.
  ------------------------------------------------------------------
  FOR m IN
    SELECT * FROM public.academy_player_metadata
    WHERE guest_player_id = p_source_guest_id
  LOOP
    IF EXISTS (
      SELECT 1 FROM public.academy_player_metadata t
      WHERE t.guest_player_id = p_target_guest_id
        AND t.academy_profile_id IS NOT DISTINCT FROM m.academy_profile_id
        AND t.trainer_profile_id IS NOT DISTINCT FROM m.trainer_profile_id
    ) THEN
      UPDATE public.academy_player_metadata t
      SET tag_ids = (SELECT coalesce(array_agg(DISTINCT x), '{}'::uuid[])
                     FROM unnest(t.tag_ids || m.tag_ids) AS x),
          notes = CASE
            WHEN nullif(btrim(coalesce(m.notes,'')),'') IS NULL THEN t.notes
            WHEN nullif(btrim(coalesce(t.notes,'')),'') IS NULL THEN m.notes
            ELSE t.notes || E'\n' || m.notes
          END
      WHERE t.guest_player_id = p_target_guest_id
        AND t.academy_profile_id IS NOT DISTINCT FROM m.academy_profile_id
        AND t.trainer_profile_id IS NOT DISTINCT FROM m.trainer_profile_id;
      DELETE FROM public.academy_player_metadata WHERE id = m.id;
      v_meta_merged := v_meta_merged + 1;
    ELSE
      UPDATE public.academy_player_metadata
      SET guest_player_id = p_target_guest_id
      WHERE id = m.id;
      v_meta_moved := v_meta_moved + 1;
    END IF;
  END LOOP;

  ------------------------------------------------------------------
  -- Repoint relations
  ------------------------------------------------------------------
  -- bookings: unique per (slot, guest) for active rows (M-17 index) — when both
  -- players actively book the same slot, cancel the redundant one BEFORE the
  -- repoint or the UPDATE would violate uniq_active_booking_per_slot_guest.
  -- Keep the paid booking; on a tie keep the target's.
  FOR m IN
    SELECT sb.id AS source_booking_id, tb.id AS target_booking_id,
           (sb.payment_status = 'paid' OR coalesce(sb.paid_externally, false)) AS source_paid,
           (tb.payment_status = 'paid' OR coalesce(tb.paid_externally, false)) AS target_paid
    FROM public.bookings sb
    JOIN public.bookings tb
      ON tb.slot_id = sb.slot_id
     AND tb.guest_player_id = p_target_guest_id
     AND tb.status IN ('pending','confirmed','completed')
    WHERE sb.guest_player_id = p_source_guest_id
      AND sb.status IN ('pending','confirmed','completed')
  LOOP
    IF m.source_paid AND NOT m.target_paid THEN
      UPDATE public.bookings SET status = 'cancelled' WHERE id = m.target_booking_id;
    ELSE
      UPDATE public.bookings SET status = 'cancelled' WHERE id = m.source_booking_id;
    END IF;
    v_booking_dups := v_booking_dups + 1;
  END LOOP;

  UPDATE public.bookings SET guest_player_id = p_target_guest_id
  WHERE guest_player_id = p_source_guest_id;
  GET DIAGNOSTICS v_bookings = ROW_COUNT;

  UPDATE public.invoices SET guest_player_id = p_target_guest_id
  WHERE guest_player_id = p_source_guest_id;
  GET DIAGNOSTICS v_invoices = ROW_COUNT;

  UPDATE public.intake_requests SET guest_player_id = p_target_guest_id
  WHERE guest_player_id = p_source_guest_id;
  GET DIAGNOSTICS v_intakes = ROW_COUNT;

  -- priority claims: unique per (slot, guest) — drop source claims where the
  -- target already has one on the same slot, repoint the rest
  DELETE FROM public.slot_priority_claims s
  WHERE s.guest_player_id = p_source_guest_id
    AND EXISTS (SELECT 1 FROM public.slot_priority_claims t
                WHERE t.slot_id = s.slot_id
                  AND t.guest_player_id = p_target_guest_id);
  GET DIAGNOSTICS v_claims_dropped = ROW_COUNT;

  UPDATE public.slot_priority_claims SET guest_player_id = p_target_guest_id
  WHERE guest_player_id = p_source_guest_id;
  GET DIAGNOSTICS v_claims = ROW_COUNT;

  ------------------------------------------------------------------
  -- Repoint the CASCADE + SET-NULL children the previous body ignored
  -- (P1-3). Without these the DELETE below cascades away coaching notes and
  -- manually-curated club rows and nulls the captain attribution markers.
  ------------------------------------------------------------------
  -- session_player_notes: ON DELETE CASCADE, no unique constraint on the
  -- subject column -> a plain repoint cannot collide.
  UPDATE public.session_player_notes
     SET subject_guest_player_id = p_target_guest_id
   WHERE subject_guest_player_id = p_source_guest_id;
  GET DIAGNOSTICS v_notes = ROW_COUNT;

  -- academy_player_locations: ON DELETE CASCADE, partial unique apl_uniq_guest
  -- (academy_profile_id, guest_player_id, location_id) WHERE guest_player_id IS NOT NULL.
  -- Same dedup-then-repoint as slot_priority_claims: drop the source row where the
  -- target already has one for the same (academy, location) (keep the target's flag),
  -- then repoint the rest.
  DELETE FROM public.academy_player_locations s
  WHERE s.guest_player_id = p_source_guest_id
    AND EXISTS (SELECT 1 FROM public.academy_player_locations t
                WHERE t.guest_player_id = p_target_guest_id
                  AND t.academy_profile_id = s.academy_profile_id
                  AND t.location_id = s.location_id);
  GET DIAGNOSTICS v_locations_dropped = ROW_COUNT;

  UPDATE public.academy_player_locations
     SET guest_player_id = p_target_guest_id
   WHERE guest_player_id = p_source_guest_id;
  GET DIAGNOSTICS v_locations = ROW_COUNT;

  -- Group-captain attribution markers (ON DELETE SET NULL): the source guest may be
  -- the captain who booked/paid for other members. Repoint so the surviving guest
  -- keeps the "who booked/paid for whom" link instead of it being nulled. No unique
  -- constraint on these columns -> plain UPDATE.
  UPDATE public.slot_priority_claims
     SET booked_by_guest_player_id = p_target_guest_id
   WHERE booked_by_guest_player_id = p_source_guest_id;
  GET DIAGNOSTICS v_captain_claims = ROW_COUNT;

  UPDATE public.bookings
     SET paid_by_guest_player_id = p_target_guest_id
   WHERE paid_by_guest_player_id = p_source_guest_id;
  GET DIAGNOSTICS v_captain_bookings = ROW_COUNT;

  ------------------------------------------------------------------
  -- Clear the source's email before deleting it so applying the kept email
  -- to the target can never trip the partial unique indexes.
  ------------------------------------------------------------------
  UPDATE public.guest_players SET email = NULL WHERE id = p_source_guest_id;

  -- U1c PREREQUISITE. Deleting the source guest fires the last-source cleanup trigger, which
  -- DELETEs its person when that guest was the person's final link. `academy_player_memberships`
  -- references persons with ON DELETE RESTRICT, so without this the delete below aborts and the whole
  -- merge fails once memberships exist. Memberships hang off the PERSON, so none of the guest-keyed
  -- repoints above touch them.
  SELECT person_id INTO v_src_person FROM public.person_links WHERE guest_player_id = p_source_guest_id;
  SELECT person_id INTO v_tgt_person FROM public.person_links WHERE guest_player_id = p_target_guest_id;

  -- ONLY when this delete will actually destroy the source person. `cleanup_orphan_person_on_source_delete`
  -- keeps a person that still has another link — the supported shape is one profile plus several
  -- guests — and in that case the person lives on and its memberships belong to it, not to the target.
  -- Repointing unconditionally would silently move a surviving human's academy relationships onto
  -- someone else. This is the trigger's own predicate, verbatim: no link other than the dying guest's.
  v_src_person_dies := v_src_person IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.person_links pl
    WHERE pl.person_id = v_src_person
      AND NOT (pl.guest_player_id IS NOT DISTINCT FROM p_source_guest_id)
  );

  IF v_src_person_dies THEN
    IF v_tgt_person IS NULL
       AND EXISTS (SELECT 1 FROM public.academy_player_memberships WHERE person_id = v_src_person) THEN
      -- Refuse legibly instead of letting the FK produce an opaque error two statements later. Only
      -- reachable when a repoint is genuinely required.
      RAISE EXCEPTION 'cannot merge: the target player has no person link to receive % membership(s)',
        (SELECT count(*) FROM public.academy_player_memberships WHERE person_id = v_src_person)
        USING ERRCODE = 'foreign_key_violation';
    END IF;

    v_membership_repoint := public.repoint_person_memberships(v_src_person, v_tgt_person);
  END IF;

  DELETE FROM public.guest_players WHERE id = p_source_guest_id;

  ------------------------------------------------------------------
  -- Apply kept personal fields + combined flags to the target
  ------------------------------------------------------------------
  UPDATE public.guest_players t
  SET
    full_name        = CASE WHEN p_fields ? 'full_name' THEN coalesce(nullif(btrim(p_fields->>'full_name'),''), t.full_name) ELSE t.full_name END,
    first_name       = CASE WHEN p_fields ? 'first_name' THEN nullif(btrim(p_fields->>'first_name'),'') ELSE t.first_name END,
    last_name        = CASE WHEN p_fields ? 'last_name' THEN nullif(btrim(p_fields->>'last_name'),'') ELSE t.last_name END,
    email            = v_keep_email,
    phone            = CASE WHEN p_fields ? 'phone' THEN nullif(btrim(p_fields->>'phone'),'') ELSE t.phone END,
    skill_rating     = CASE WHEN p_fields ? 'skill_rating' THEN (p_fields->>'skill_rating')::numeric ELSE t.skill_rating END,
    rating_system    = CASE WHEN p_fields ? 'rating_system' THEN coalesce(nullif(btrim(p_fields->>'rating_system'),''), t.rating_system) ELSE t.rating_system END,
    birth_date       = CASE WHEN p_fields ? 'birth_date' THEN nullif(btrim(p_fields->>'birth_date'),'')::date ELSE t.birth_date END,
    notes            = CASE WHEN p_fields ? 'notes' THEN nullif(btrim(p_fields->>'notes'),'') ELSE t.notes END,
    billing_business_name = CASE WHEN p_fields ? 'billing_business_name' THEN nullif(btrim(p_fields->>'billing_business_name'),'') ELSE t.billing_business_name END,
    billing_address  = CASE WHEN p_fields ? 'billing_address' THEN nullif(btrim(p_fields->>'billing_address'),'') ELSE t.billing_address END,
    billing_btw_number = CASE WHEN p_fields ? 'billing_btw_number' THEN nullif(btrim(p_fields->>'billing_btw_number'),'') ELSE t.billing_btw_number END,
    preferred_location_id = CASE WHEN p_fields ? 'preferred_location_id' THEN nullif(btrim(p_fields->>'preferred_location_id'),'')::uuid ELSE t.preferred_location_id END,
    source           = CASE WHEN p_fields ? 'source' THEN nullif(btrim(p_fields->>'source'),'') ELSE t.source END,
    has_trained      = t.has_trained OR coalesce(v_source.has_trained, false),
    -- Survivor hygiene (round-2 audit): when the effective twin exists and the inherited inferred
    -- link names a DIFFERENT profile, DROP the link — never manufacture a conflicted row that
    -- shows one person's data to another. (The link trigger may re-infer a link on later email
    -- changes; the readers' twin-first precedence keeps even that state harmless.)
    linked_profile_id = CASE
      WHEN coalesce(t.twin_of_profile_id, v_source.twin_of_profile_id) IS NOT NULL
       AND coalesce(t.linked_profile_id, v_source.linked_profile_id)
           IS DISTINCT FROM coalesce(t.twin_of_profile_id, v_source.twin_of_profile_id)
      THEN NULL
      ELSE coalesce(t.linked_profile_id, v_source.linked_profile_id)
    END,
    twin_of_profile_id = coalesce(t.twin_of_profile_id, v_source.twin_of_profile_id)
  WHERE t.id = p_target_guest_id;

  RETURN jsonb_build_object(
    'target_guest_id', p_target_guest_id,
    'bookings_moved', v_bookings,
    'invoices_moved', v_invoices,
    'intake_requests_moved', v_intakes,
    'priority_claims_moved', v_claims,
    'priority_claims_deduped', v_claims_dropped,
    'bookings_deduped', v_booking_dups,
    'metadata_rows_moved', v_meta_moved,
    'metadata_rows_merged', v_meta_merged,
    'notes_moved', v_notes,
    'locations_moved', v_locations,
    'locations_deduped', v_locations_dropped,
    'captain_claim_markers_moved', v_captain_claims,
    'captain_booking_markers_moved', v_captain_bookings,
    'memberships_moved', coalesce((v_membership_repoint->>'moved')::int, 0),
    'memberships_coalesced', coalesce((v_membership_repoint->>'coalesced')::int, 0)
  );
END;
$$;

-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Durable evidence, written where the evidence row actually is
-- ---------------------------------------------------------------------------
-- An earlier attempt had collapse publish its counts through a transaction-local GUC for a trigger to
-- pick up. That is INVALID: `collapse_guest_person_into` carries `SET search_path`, and PostgreSQL
-- restores GUC state — including changes made by set_config(..., true) — when such a function exits.
-- The value was therefore gone before the caller's INSERT ran. (PGlite does not implement that
-- save/restore, so the test passed and proved nothing; the mechanism has been removed entirely.)
--
-- So the counts are recorded where the row is written. Both callers below are reproduced from
-- 20260826280000_persons_backfill.sql (:514 and :695) programmatically, changing ONLY the collapse
-- call site and the details payload; everything else is byte-identical to what shipped.

CREATE OR REPLACE FUNCTION public.mint_person_for_profile()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_collapse jsonb;
  v_person uuid;
  v_email text := nullif(btrim(NEW.email), '');
  v_guest uuid;
  v_guest_person uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM public.person_links WHERE profile_id = NEW.id) THEN
    RETURN NEW;
  END IF;
  IF v_email IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('guest_email:' || lower(v_email)));
  END IF;
  INSERT INTO public.persons (
    id, user_id, full_name, first_name, last_name, email, phone, birth_date,
    skill_rating, rating_system, rating_member_id, avatar_url, bio, location,
    preferred_language, billing_business_name, billing_address, billing_btw_number,
    stripe_customer_id
  ) VALUES (
    NEW.id, NEW.user_id, NEW.full_name, NEW.first_name, NEW.last_name, NEW.email, NEW.phone, NEW.birth_date,
    NEW.skill_rating, NEW.rating_system, NEW.rating_member_id, NEW.avatar_url, NEW.bio, NEW.location,
    NEW.preferred_language, NEW.billing_business_name, NEW.billing_address, NEW.billing_btw_number,
    NEW.stripe_customer_id
  ) ON CONFLICT (id) DO NOTHING;
  v_person := NEW.id;
  INSERT INTO public.person_links (person_id, profile_id) VALUES (v_person, NEW.id);

  -- Reverse unique email pair — the account-claim flow (guest existed first, the human signs up
  -- with that email later; this shape produced 47 of the 81 pre-backfill matches). Locked rule
  -- (b) evidence at signup time: collapse the guest's person into the new profile's when provably
  -- safe; otherwise leave a pending review row. NEVER keyed on linked_profile_id.
  IF v_email IS NOT NULL
     AND (SELECT count(*) FROM public.profiles p
          WHERE lower(btrim(p.email)) = lower(v_email)
            AND nullif(btrim(p.email), '') IS NOT NULL) = 1
     AND (SELECT count(*) FROM public.guest_players g
          WHERE lower(btrim(g.email)) = lower(v_email)
            AND nullif(btrim(g.email), '') IS NOT NULL) = 1 THEN
    SELECT g.id INTO v_guest FROM public.guest_players g
    WHERE lower(btrim(g.email)) = lower(v_email) AND nullif(btrim(g.email), '') IS NOT NULL;
    SELECT person_id INTO v_guest_person FROM public.person_links WHERE guest_player_id = v_guest;
    IF v_guest_person IS NOT NULL AND v_guest_person <> v_person THEN
      v_collapse := public.collapse_guest_person_into_reporting(v_guest, v_guest_person, v_person);
      IF (v_collapse->>'ok')::boolean THEN
        INSERT INTO public.person_merge_review (kind, status, email, guest_player_id, profile_id, person_id, details)
        VALUES ('auto_merged_email_pair', 'applied', v_email, v_guest, NEW.id, v_person,
                jsonb_build_object('via', 'signup_pair',
                  'memberships_moved',     coalesce((v_collapse->>'moved')::int, 0),
                  'memberships_coalesced', coalesce((v_collapse->>'coalesced')::int, 0)));
      ELSE
        INSERT INTO public.person_merge_review (kind, email, guest_player_id, profile_id, suggested_profile_id, details)
        VALUES ('signup_pair_needs_review', v_email, v_guest, NEW.id, NEW.id,
                jsonb_build_object('reason', 'unique email pair at signup but the guest person is not safely collapsible'));
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.relink_person_on_twin_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_collapse jsonb;
  v_guest_person uuid;
  v_profile_person uuid;
  v_email text := nullif(btrim(NEW.email), '');
  v_profile_email text;
  v_trusted boolean := false;
BEGIN
  IF NEW.twin_of_profile_id IS NOT DISTINCT FROM OLD.twin_of_profile_id THEN
    -- No stamp change — but an email move AWAY from the merged profile's email on a guest that
    -- was LINK-merged withOUT a stamp (B2 / signup-pair) is the same repurpose signal the 0c
    -- guard watches for twins: the row may now be a different human, yet its person_links row
    -- keeps stamping the profile's person onto every new booking. Cannot auto-split (existing
    -- rows legitimately belong to the old person) → pending review row.
    IF NEW.twin_of_profile_id IS NULL
       AND lower(btrim(coalesce(NEW.email, ''))) IS DISTINCT FROM lower(btrim(coalesce(OLD.email, '')))
       AND btrim(coalesce(NEW.email, '')) <> '' THEN
      SELECT pl.person_id INTO v_guest_person
      FROM public.person_links pl WHERE pl.guest_player_id = NEW.id;
      IF v_guest_person IS NOT NULL AND EXISTS (
        SELECT 1
        FROM public.person_links pl
        JOIN public.profiles p ON p.id = pl.profile_id
        WHERE pl.person_id = v_guest_person
          AND nullif(btrim(p.email), '') IS NOT NULL
          AND lower(btrim(p.email)) IS DISTINCT FROM lower(btrim(NEW.email))
      ) AND NOT EXISTS (
        SELECT 1 FROM public.person_merge_review r
        WHERE r.guest_player_id = NEW.id
          AND r.kind = 'merged_guest_email_moved' AND r.status = 'pending'
      ) THEN
        INSERT INTO public.person_merge_review (kind, email, guest_player_id, person_id, details)
        VALUES ('merged_guest_email_moved', NEW.email, NEW.id, v_guest_person,
                jsonb_build_object('guest_name', NEW.full_name, 'old_email', OLD.email,
                                   'reason', 'email moved away from the merged profile''s — split may be needed'));
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  SELECT person_id INTO v_guest_person FROM public.person_links WHERE guest_player_id = NEW.id;
  IF v_guest_person IS NULL THEN
    RETURN NEW;  -- pre-backfill row without a link; the backfill owns it
  END IF;

  IF NEW.twin_of_profile_id IS NOT NULL AND OLD.twin_of_profile_id IS DISTINCT FROM NEW.twin_of_profile_id THEN
    SELECT person_id INTO v_profile_person FROM public.person_links WHERE profile_id = NEW.twin_of_profile_id;
    IF v_profile_person IS NULL OR v_profile_person = v_guest_person THEN
      RETURN NEW;
    END IF;
    SELECT nullif(btrim(p.email), '') INTO v_profile_email
    FROM public.profiles p WHERE p.id = NEW.twin_of_profile_id;
    v_trusted := (v_email IS NOT NULL AND v_profile_email IS NOT NULL
                  AND lower(v_email) = lower(v_profile_email))
                 OR (v_email IS NULL AND NEW.source = 'roster_registered_twin');
    IF v_trusted THEN
      v_collapse := public.collapse_guest_person_into_reporting(NEW.id, v_guest_person, v_profile_person);
    ELSE
      v_collapse := jsonb_build_object('ok', false);
    END IF;
    IF (v_collapse->>'ok')::boolean THEN
      INSERT INTO public.person_merge_review (kind, status, email, guest_player_id, profile_id, person_id, details)
      VALUES ('auto_merged_twin_trust', 'applied', NEW.email, NEW.id, NEW.twin_of_profile_id, v_profile_person,
              jsonb_build_object('guest_name', NEW.full_name, 'via', 'live_claim',
                'memberships_moved',     coalesce((v_collapse->>'moved')::int, 0),
                'memberships_coalesced', coalesce((v_collapse->>'coalesced')::int, 0)));
    ELSE
      INSERT INTO public.person_merge_review (kind, email, guest_player_id, profile_id, details)
      VALUES (CASE WHEN v_trusted THEN 'twin_detached_needs_split' ELSE 'twin_trust_failure' END,
              NEW.email, NEW.id, NEW.twin_of_profile_id,
              jsonb_build_object('guest_name', NEW.full_name,
                                 'reason', CASE WHEN v_trusted THEN 'guest person not safely collapsible' ELSE 'trust rule failed' END));
    END IF;
  ELSIF NEW.twin_of_profile_id IS NULL AND OLD.twin_of_profile_id IS NOT NULL THEN
    -- stamp cleared (repurpose): if the guest shares a person with a profile, the split needs
    -- human judgment — the rows already stamped carry the merged person.
    IF EXISTS (SELECT 1 FROM public.person_links
               WHERE person_id = v_guest_person AND profile_id IS NOT NULL) THEN
      INSERT INTO public.person_merge_review (kind, email, guest_player_id, profile_id, person_id, details)
      VALUES ('twin_detached_needs_split', NEW.email, NEW.id, OLD.twin_of_profile_id, v_guest_person,
              jsonb_build_object('guest_name', NEW.full_name,
                                 'reason', 'twin stamp cleared on a guest merged into a profile person'));
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
