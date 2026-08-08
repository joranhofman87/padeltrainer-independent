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

CREATE OR REPLACE FUNCTION public.collapse_guest_person_into(
  _guest_id uuid, _guest_person uuid, _target_person uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_memberships jsonb;
BEGIN
  IF _guest_person = _target_person THEN
    RETURN true;
  END IF;
  IF EXISTS (SELECT 1 FROM public.person_links
             WHERE person_id = _guest_person AND guest_player_id IS DISTINCT FROM _guest_id)
     OR EXISTS (SELECT 1 FROM public.persons WHERE id = _guest_person AND user_id IS NOT NULL) THEN
    RETURN false;
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
  IF coalesce((v_memberships->>'coalesced')::int, 0) > 0 THEN
    RAISE NOTICE 'collapse_guest_person_into: coalesced % duplicate membership(s) from person % into %',
      v_memberships->>'coalesced', _guest_person, _target_person;
  END IF;

  DELETE FROM public.persons WHERE id = _guest_person;
  RETURN true;
END;
$$;
