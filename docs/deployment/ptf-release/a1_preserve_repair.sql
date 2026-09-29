-- A1 PRESERVATION — REPAIR (a data write; run BEFORE apply.sql). Tom's binding decision of 2026-09-29: every
-- guest side that rule A1 would drop from academy f5124b05-6c8b-40e4-9d67-36e2a41acd36 (34 manual entries:
-- 2 academy-invoice-linked, 32 manual prospects) stays in that academy through an EXPLICIT academy
-- relationship.
--
-- The relationship is the existing canonical one that A1 already reads: one academy_player_metadata row per
-- guest (20261208100000 `guest_refs`, "linked by one of its metadata rows"; the owner's rule of
-- 20260706130100).
--   * The row: academy_profile_id = the academy, guest_player_id = the guest, no notes, no tags, no trainer
--     scope, not removed. The table's own trigger stamps person_id from person_links.
--   * Not written: guest ownership (trainer_id, academy_profile_id), invoices, bookings, person links,
--     existing relationship rows and removals. No new schema, no ownership rewrite.
--
-- THIS FILE REFUSES UNTIL IT IS PINNED.
--   * The two constants marked PINNING DELTA stay NULL until Tom's read-only CAPTURE has run.
--   * Then a narrow, separately reviewed delta commit sets them to CAPTURE's pinned_sha256 and
--     effective_persons, and changes nothing else in this file.
--   * Only a pinned file can write, and only for the one id set that hashes to the pinned digest: on the first
--     run and on every replay.
--
-- The ids enter ONLY as a psql variable. Nothing is included or executed from outside this file:
--   psql -X -1 -v ON_ERROR_STOP=1 -v expected_sysid=<system identifier> -v pinned_ids='<CAPTURE pinned_ids>' -f this file
-- `:'pinned_ids'` interpolates the value as one quoted SQL literal, so it cannot run SQL. A missing variable is
-- a psql syntax error on the set_config line, so nothing runs. The value passes one canonical parser: '{'
-- + lower-case canonical uuids, sorted, distinct, comma-separated, no spaces + '}'. Anything else refuses.
--
-- Accepted starting states (anything else refuses and changes nothing; psql exits 3):
--   * FIRST RUN:
--     - the ledger is the reviewed 620 versions (pre-apply);
--     - no pinned guest has any row for the academy;
--     - the pinned set IS the academy's current A1-dropped set, exactly;
--     - it forms the pinned number of canonical persons.
--   * RE-RUN:
--     - the same ledger and the same pinned set;
--     - every pinned guest already has exactly one active row for the academy, and none is dropped;
--     - it inserts nothing, and the relationship rows are unchanged.
-- Every check after the write raises on a mismatch, so psql -1 rolls the whole transaction back.

-- 1. Read committed, bounded waits.
SET TRANSACTION ISOLATION LEVEL READ COMMITTED;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- 2. The inputs, as quoted literals, into transaction-local settings (psql variables do not reach inside a DO
--    body).
SELECT 'inputs loaded' AS a1_preserve
  FROM (VALUES (set_config('ptf_a1p.expected_sysid', :'expected_sysid', true),
                set_config('ptf_a1p.pinned_ids', :'pinned_ids', true))) AS v(s, i);

-- 3. Serialize with every writer of the relationship table (the app's notes, tags and removal paths) for this
--    short transaction. Readers are not blocked.
LOCK TABLE public.academy_player_metadata IN SHARE ROW EXCLUSIVE MODE;

-- 4. Guard, write, verify.
DO $ptf_a1_preserve$
DECLARE
  c_academy           CONSTANT uuid    := 'f5124b05-6c8b-40e4-9d67-36e2a41acd36';
  c_decided           CONSTANT integer := 34;  -- Tom, 2026-09-29: keep all 34
  c_ledger            CONSTANT text    := '98015eddaccd8ef67297c172db67495f5ff11a881ea28e1f024fb82741c3bc72'; -- 620, to 20261207100000
  c_pinned_sha256     CONSTANT text    := NULL;  -- PINNING DELTA: CAP's pinned_sha256
  c_effective_persons CONSTANT integer := NULL;  -- PINNING DELTA: CAP's effective_persons
  c_uuid              CONSTANT text    := '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  v_sysid   text := (SELECT system_identifier::text FROM pg_control_system());
  v_ledger  text := (SELECT encode(sha256(convert_to(string_agg(version, E'\n' ORDER BY version COLLATE "C"), 'UTF8')), 'hex')
                       FROM supabase_migrations.schema_migrations);
  v_text    text;
  v_ids     uuid[];
  v_canon   text;
  v_sha     text;
  v_locked  integer;
  v_persons integer;
  v_owned integer; v_not_live integer; v_removed integer; v_other_meta integer; v_linked integer; v_any_row integer;
  v_dropped_before uuid[];
  v_dropped_after  uuid[];
  v_guests_before   text; v_guests_after   text;
  v_history_before  text; v_history_after  text;
  v_meta_before     text; v_meta_after     text;
  v_pinned_before   text; v_pinned_after   text;
  v_rows_before integer; v_rows_after integer;
  v_inserted integer;
  v_bad      integer;
BEGIN
  -- Target and sequencing: this database, this user, and the pre-apply ledger only.
  IF current_database() <> 'postgres' THEN
    RAISE EXCEPTION 'ptf a1 preserve guard: connected to database %, expected postgres', current_database();
  END IF;
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION 'ptf a1 preserve guard: connected as %, expected postgres', current_user;
  END IF;
  IF v_sysid IS DISTINCT FROM current_setting('ptf_a1p.expected_sysid') THEN
    RAISE EXCEPTION 'ptf a1 preserve guard: system identifier %, expected %', v_sysid, current_setting('ptf_a1p.expected_sysid');
  END IF;
  IF v_ledger IS DISTINCT FROM c_ledger THEN
    RAISE EXCEPTION 'ptf a1 preserve guard: the ledger is not the reviewed 620 versions to 20261207100000 (digest %); this repair runs before apply.sql only',
      v_ledger;
  END IF;

  -- The reviewed pin: without CAPTURE's digest and person count fixed in this file, nothing is written.
  IF c_pinned_sha256 IS NULL OR c_effective_persons IS NULL
     OR c_pinned_sha256 !~ '^[0-9a-f]{64}$' OR c_effective_persons NOT BETWEEN 1 AND c_decided THEN
    RAISE EXCEPTION 'ptf a1 preserve guard: the capture digest is not pinned in this reviewed file; pin CAPTURE''s pinned_sha256 and effective_persons by the reviewed PINNING DELTA first';
  END IF;

  -- The one canonical parser for the ids.
  v_text := current_setting('ptf_a1p.pinned_ids');
  IF v_text IS NULL OR v_text !~ ('^\{' || c_uuid || '(,' || c_uuid || ')*\}$') THEN
    RAISE EXCEPTION 'ptf a1 preserve guard: pinned_ids is not a canonical id list (''{'' + lower-case uuids, comma-separated, no spaces + ''}'')';
  END IF;
  v_ids := v_text::uuid[];
  v_canon := '{' || (SELECT string_agg(x::text, ',' ORDER BY x::text COLLATE "C") FROM (SELECT DISTINCT unnest(v_ids) AS x) AS s) || '}';
  IF v_canon IS DISTINCT FROM v_text THEN
    RAISE EXCEPTION 'ptf a1 preserve guard: pinned_ids is not sorted and distinct';
  END IF;
  IF cardinality(v_ids) <> c_decided THEN
    RAISE EXCEPTION 'ptf a1 preserve guard: the pinned set must be % ids (got %)', c_decided, cardinality(v_ids);
  END IF;
  v_sha := encode(sha256(convert_to(substr(v_text, 2, length(v_text) - 2), 'UTF8')), 'hex');
  IF v_sha IS DISTINCT FROM c_pinned_sha256 THEN
    RAISE EXCEPTION 'ptf a1 preserve guard: the pinned ids hash to %, not to the digest pinned in this file (%)', v_sha, c_pinned_sha256;
  END IF;

  -- Hold the pinned guest rows against an ownership change or deletion for the rest of the transaction.
  SELECT count(*) INTO v_locked
    FROM (SELECT 1 FROM public.guest_players g WHERE g.id = ANY (v_ids) ORDER BY g.id FOR SHARE) AS s;
  IF v_locked <> c_decided THEN
    RAISE EXCEPTION 'ptf a1 preserve guard: % of the % pinned guests exist', v_locked, c_decided;
  END IF;

  -- Eligibility of every pinned guest, with a count per refusal reason. The removal and other-side rules are
  -- person-wide, as in A1 (removed_persons; the guest-side-first with_meta). Sides that are themselves pinned
  -- are not "another side".
  SELECT count(*) FILTER (WHERE g.academy_profile_id IS NOT NULL),
         count(*) FILTER (WHERE NOT EXISTS (
           SELECT 1 FROM public.academy_trainers t
            WHERE t.academy_profile_id = c_academy AND t.status = 'active' AND t.trainer_profile_id = g.trainer_id)),
         count(*) FILTER (WHERE EXISTS (
           SELECT 1 FROM public.academy_player_metadata m
            WHERE m.academy_profile_id = c_academy AND m.removed_at IS NOT NULL
              AND (m.guest_player_id = g.id
                OR EXISTS (SELECT 1 FROM public.person_links pl JOIN public.person_links pl2 ON pl2.person_id = pl.person_id
                            WHERE pl.guest_player_id = g.id
                              AND (m.guest_player_id = pl2.guest_player_id OR m.profile_id = pl2.profile_id))))),
         count(*) FILTER (WHERE EXISTS (
           SELECT 1 FROM public.person_links pl JOIN public.person_links pl2 ON pl2.person_id = pl.person_id
             JOIN public.academy_player_metadata m ON m.academy_profile_id = c_academy AND m.removed_at IS NULL
              AND (m.guest_player_id = pl2.guest_player_id OR m.profile_id = pl2.profile_id)
            WHERE pl.guest_player_id = g.id
              AND (pl2.guest_player_id IS NULL OR NOT (pl2.guest_player_id = ANY (v_ids))))),
         count(*) FILTER (WHERE EXISTS (
           SELECT 1 FROM public.academy_player_metadata m
            WHERE m.academy_profile_id = c_academy AND m.guest_player_id = g.id AND m.removed_at IS NULL)),
         count(*) FILTER (WHERE EXISTS (
           SELECT 1 FROM public.academy_player_metadata m
            WHERE m.academy_profile_id = c_academy AND m.guest_player_id = g.id))
    INTO v_owned, v_not_live, v_removed, v_other_meta, v_linked, v_any_row
    FROM public.guest_players g
   WHERE g.id = ANY (v_ids);
  IF v_owned + v_not_live + v_removed + v_other_meta > 0 THEN
    RAISE EXCEPTION 'ptf a1 preserve guard: refused, % owned by an academy, % not owned by an active trainer of this academy, % with a removed side here, % with another side already related here',
      v_owned, v_not_live, v_removed, v_other_meta;
  END IF;
  IF NOT ((v_linked = 0 AND v_any_row = 0) OR (v_linked = c_decided AND v_any_row = c_decided)) THEN
    RAISE EXCEPTION 'ptf a1 preserve guard: mixed state, % of % pinned guests already related here (% rows); refusing a partial run',
      v_linked, c_decided, v_any_row;
  END IF;

  -- List-row cardinality: A1 renders one row per canonical person, keyed exactly as its `sided` CTE keys a
  -- guest side. The pinned set must still form the pinned number of persons.
  v_persons := (SELECT count(DISTINCT CASE WHEN pl.person_id IS NOT NULL AND NOT public.is_guest_split_frozen(x)
                                         THEN pl.person_id ELSE x END)
                  FROM unnest(v_ids) AS x LEFT JOIN public.person_links pl ON pl.guest_player_id = x);
  IF v_persons IS DISTINCT FROM c_effective_persons THEN
    RAISE EXCEPTION 'ptf a1 preserve guard: the pinned guests form % canonical persons, the pinned count is %', v_persons, c_effective_persons;
  END IF;

  -- Set identity, computed with the classification's rule, bounded to this academy.
  -- First run: the pinned set IS the dropped set. Re-run: no pinned guest is dropped.
  v_dropped_before := (
    WITH trainers AS (SELECT t.trainer_profile_id AS tid FROM public.academy_trainers t
                       WHERE t.academy_profile_id = c_academy AND t.status = 'active'),
         removed_g AS (SELECT m.guest_player_id AS gid FROM public.academy_player_metadata m
                        WHERE m.academy_profile_id = c_academy AND m.removed_at IS NOT NULL AND m.guest_player_id IS NOT NULL),
         live_g AS (SELECT g.id AS gid FROM public.guest_players g WHERE g.academy_profile_id = c_academy
                    UNION SELECT g.id FROM trainers t JOIN public.guest_players g ON g.trainer_id = t.tid),
         a1_g AS (SELECT g.id AS gid FROM public.guest_players g WHERE g.academy_profile_id = c_academy
                  UNION SELECT b.guest_player_id FROM public.bookings b JOIN public.availability_slots s ON s.id = b.slot_id
                         WHERE s.academy_profile_id = c_academy AND b.status IN ('confirmed', 'completed') AND b.guest_player_id IS NOT NULL
                  UNION SELECT m.guest_player_id FROM public.academy_player_metadata m
                         WHERE m.academy_profile_id = c_academy AND m.guest_player_id IS NOT NULL)
    SELECT coalesce(array_agg(d.gid ORDER BY d.gid), '{}'::uuid[])
      FROM (SELECT gid FROM live_g EXCEPT SELECT gid FROM a1_g EXCEPT SELECT gid FROM removed_g) AS d);
  IF v_linked = 0 AND v_dropped_before IS DISTINCT FROM (SELECT array_agg(x ORDER BY x) FROM unnest(v_ids) AS x) THEN
    RAISE EXCEPTION 'ptf a1 preserve guard: the pinned set is not the academy''s current A1-dropped set (% dropped now, % pinned); capture again',
      cardinality(v_dropped_before), c_decided;
  END IF;
  IF v_linked = c_decided AND v_dropped_before && v_ids THEN
    RAISE EXCEPTION 'ptf a1 preserve guard: a re-run found pinned guests still dropped';
  END IF;

  -- Before-images of everything that must not change (and, on a re-run, of the relationship rows themselves).
  v_guests_before := (SELECT md5(string_agg(row_to_json(g)::text, '|' ORDER BY g.id))
                        FROM public.guest_players g WHERE g.id = ANY (v_ids));
  v_history_before := (SELECT md5(coalesce(string_agg(t, '|' ORDER BY t), '')) FROM (
                         SELECT 'invoice ' || row_to_json(i)::text AS t FROM public.invoices i WHERE i.guest_player_id = ANY (v_ids)
                         UNION ALL
                         SELECT 'booking ' || row_to_json(b)::text FROM public.bookings b WHERE b.guest_player_id = ANY (v_ids)
                         UNION ALL
                         SELECT 'person_link ' || row_to_json(pl)::text FROM public.person_links pl WHERE pl.guest_player_id = ANY (v_ids)
                         UNION ALL
                         SELECT 'other academy ' || row_to_json(m)::text FROM public.academy_player_metadata m
                          WHERE m.guest_player_id = ANY (v_ids) AND m.academy_profile_id IS DISTINCT FROM c_academy) AS s);
  v_meta_before := (SELECT md5(coalesce(string_agg(row_to_json(m)::text, '|' ORDER BY m.id), ''))
                      FROM public.academy_player_metadata m
                     WHERE m.academy_profile_id = c_academy AND (m.guest_player_id IS NULL OR NOT (m.guest_player_id = ANY (v_ids))));
  v_pinned_before := (SELECT md5(coalesce(string_agg(row_to_json(m)::text, '|' ORDER BY m.id), ''))
                        FROM public.academy_player_metadata m
                       WHERE m.academy_profile_id = c_academy AND m.guest_player_id = ANY (v_ids));
  v_rows_before := (SELECT count(*) FROM public.academy_player_metadata m WHERE m.academy_profile_id = c_academy);

  -- The write: one relationship row per pinned guest that has none.
  INSERT INTO public.academy_player_metadata (academy_profile_id, guest_player_id, tag_ids)
  SELECT c_academy, x, '{}'::uuid[]
    FROM unnest(v_ids) AS x
   WHERE NOT EXISTS (SELECT 1 FROM public.academy_player_metadata m
                      WHERE m.academy_profile_id = c_academy AND m.guest_player_id = x)
  ON CONFLICT (academy_profile_id, guest_player_id) WHERE guest_player_id IS NOT NULL DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  -- Verification. Any mismatch raises, and psql -1 rolls everything back.
  IF v_inserted <> CASE WHEN v_linked = 0 THEN c_decided ELSE 0 END THEN
    RAISE EXCEPTION 'ptf a1 preserve verify: inserted %, expected %; rolled back', v_inserted, CASE WHEN v_linked = 0 THEN c_decided ELSE 0 END;
  END IF;
  SELECT count(*) INTO v_bad
    FROM unnest(v_ids) AS x
   WHERE (SELECT count(*) FROM public.academy_player_metadata m
           WHERE m.academy_profile_id = c_academy AND m.guest_player_id = x AND m.removed_at IS NULL
             AND m.trainer_profile_id IS NULL AND m.profile_id IS NULL
             AND m.person_id IS NOT DISTINCT FROM (SELECT pl.person_id FROM public.person_links pl WHERE pl.guest_player_id = x)) <> 1;
  IF v_bad <> 0 THEN
    RAISE EXCEPTION 'ptf a1 preserve verify: % pinned guests lack exactly one active academy row with their canonical person; rolled back', v_bad;
  END IF;
  IF v_linked = 0 AND (SELECT count(*) FROM public.academy_player_metadata m
                        WHERE m.academy_profile_id = c_academy AND m.guest_player_id = ANY (v_ids)
                          AND (m.notes IS NOT NULL OR m.tag_ids <> '{}'::uuid[] OR m.preferred_location_id IS NOT NULL)) <> 0 THEN
    RAISE EXCEPTION 'ptf a1 preserve verify: a new row carries notes, tags or a location; rolled back';
  END IF;
  v_dropped_after := (
    WITH trainers AS (SELECT t.trainer_profile_id AS tid FROM public.academy_trainers t
                       WHERE t.academy_profile_id = c_academy AND t.status = 'active'),
         removed_g AS (SELECT m.guest_player_id AS gid FROM public.academy_player_metadata m
                        WHERE m.academy_profile_id = c_academy AND m.removed_at IS NOT NULL AND m.guest_player_id IS NOT NULL),
         live_g AS (SELECT g.id AS gid FROM public.guest_players g WHERE g.academy_profile_id = c_academy
                    UNION SELECT g.id FROM trainers t JOIN public.guest_players g ON g.trainer_id = t.tid),
         a1_g AS (SELECT g.id AS gid FROM public.guest_players g WHERE g.academy_profile_id = c_academy
                  UNION SELECT b.guest_player_id FROM public.bookings b JOIN public.availability_slots s ON s.id = b.slot_id
                         WHERE s.academy_profile_id = c_academy AND b.status IN ('confirmed', 'completed') AND b.guest_player_id IS NOT NULL
                  UNION SELECT m.guest_player_id FROM public.academy_player_metadata m
                         WHERE m.academy_profile_id = c_academy AND m.guest_player_id IS NOT NULL)
    SELECT coalesce(array_agg(d.gid ORDER BY d.gid), '{}'::uuid[])
      FROM (SELECT gid FROM live_g EXCEPT SELECT gid FROM a1_g EXCEPT SELECT gid FROM removed_g) AS d);
  IF v_dropped_after && v_ids OR (v_linked = 0 AND cardinality(v_dropped_after) <> 0) THEN
    RAISE EXCEPTION 'ptf a1 preserve verify: % guest sides still dropped after the write; rolled back', cardinality(v_dropped_after);
  END IF;
  v_guests_after := (SELECT md5(string_agg(row_to_json(g)::text, '|' ORDER BY g.id))
                       FROM public.guest_players g WHERE g.id = ANY (v_ids));
  v_history_after := (SELECT md5(coalesce(string_agg(t, '|' ORDER BY t), '')) FROM (
                        SELECT 'invoice ' || row_to_json(i)::text AS t FROM public.invoices i WHERE i.guest_player_id = ANY (v_ids)
                        UNION ALL
                        SELECT 'booking ' || row_to_json(b)::text FROM public.bookings b WHERE b.guest_player_id = ANY (v_ids)
                        UNION ALL
                        SELECT 'person_link ' || row_to_json(pl)::text FROM public.person_links pl WHERE pl.guest_player_id = ANY (v_ids)
                        UNION ALL
                        SELECT 'other academy ' || row_to_json(m)::text FROM public.academy_player_metadata m
                         WHERE m.guest_player_id = ANY (v_ids) AND m.academy_profile_id IS DISTINCT FROM c_academy) AS s);
  v_meta_after := (SELECT md5(coalesce(string_agg(row_to_json(m)::text, '|' ORDER BY m.id), ''))
                     FROM public.academy_player_metadata m
                    WHERE m.academy_profile_id = c_academy AND (m.guest_player_id IS NULL OR NOT (m.guest_player_id = ANY (v_ids))));
  v_pinned_after := (SELECT md5(coalesce(string_agg(row_to_json(m)::text, '|' ORDER BY m.id), ''))
                       FROM public.academy_player_metadata m
                      WHERE m.academy_profile_id = c_academy AND m.guest_player_id = ANY (v_ids));
  v_rows_after := (SELECT count(*) FROM public.academy_player_metadata m WHERE m.academy_profile_id = c_academy);
  IF v_rows_after <> v_rows_before + v_inserted THEN
    RAISE EXCEPTION 'ptf a1 preserve verify: the academy has % relationship rows, expected %; rolled back', v_rows_after, v_rows_before + v_inserted;
  END IF;
  IF v_linked = c_decided AND v_pinned_after IS DISTINCT FROM v_pinned_before THEN
    RAISE EXCEPTION 'ptf a1 preserve verify: a re-run changed the pinned relationship rows; rolled back';
  END IF;
  IF v_guests_after IS DISTINCT FROM v_guests_before OR v_history_after IS DISTINCT FROM v_history_before
     OR v_meta_after IS DISTINCT FROM v_meta_before THEN
    RAISE EXCEPTION 'ptf a1 preserve verify: guests % / history % / other relationship rows % changed; rolled back',
      v_guests_after IS DISTINCT FROM v_guests_before, v_history_after IS DISTINCT FROM v_history_before, v_meta_after IS DISTINCT FROM v_meta_before;
  END IF;

  RAISE NOTICE 'ptf a1 preserve: inserted %, linked %/% for academy %, pinned %, effective persons %, dropped now %, transaction time %',
    v_inserted, c_decided, c_decided, c_academy, v_sha, v_persons, cardinality(v_dropped_after), now();
END
$ptf_a1_preserve$;
