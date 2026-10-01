-- D7 RUNTIME — TIER 4 STOPS COLLIDING WITH A FUTURE BASE.
--
-- OWNER DECISION (`APPROVE_D7_RUNTIME_PROTECTED_ENQUEUE_AND_FINAL_CLOSURE_V1`):
--   `TIER4_FUTURE_COLLISION_ONLY_AFTER_RECOVERING_THE_EXACT_ORIGINAL_FINDING_DO_NOT_GUESS_OR_
--    SUBSTITUTE_A_DIFFERENT_NAMING_RULE`
--
-- ── THE FINDING, RECOVERED VERBATIM ─────────────────────────────────────────────────────────
--
-- Two independent review sessions state it identically:
--
--   "Tier 4 can still collide with a future, otherwise-unique base. `v_dup` is fixed before
--    iteration and `v_emit` contains only earlier decisions. For ordered tier-3 names `A,A,B`,
--    where `B = left(A,297) || ' #2'`, the output is `A,B,B`: the second A cannot see future B, and
--    B has count one so is never rewritten. The frozen distinct-name verdict then refuses the
--    cohort as `invalid_request` although `#3` is available. The existing `A,A,B,B` test cannot
--    catch this, because there B is also colliding."
--
-- The concrete legal fixture it names: a 200-character label, Wednesday 09:00, trainer first name
-- `T`, two 82-character location names of `A`×82, and a third of `A`×79 + ` #2` — which makes each
-- tier-3 name exactly 300 characters.
--
-- This file fixes exactly that and changes no other naming rule. Nothing here was inferred: the
-- earlier stop refused to guess at this item, and the fix waited until the original text was found.
--
-- ── WHY IT HAPPENS, AND THE ONE-LINE SHAPE OF THE FIX ──────────────────────────────────────
--
-- Tier 4 avoids two sets: `v_taken` (names other rounds already hold) and `v_emit` (names THIS call
-- has already decided). Both look backwards. The tier-3 names it has not reached yet are in neither,
-- so a generated suffix is free to land on one — and that later name, being unique, is never
-- rewritten to get out of the way.
--
-- The full tier-3 array is known before the loop starts, so the missing set is simply that array.
-- The candidate must now also avoid it, EXCEPT for the base it is disambiguating from: at `k = 1`
-- the candidate IS the base, and that is the first occurrence legitimately keeping its name.
--
-- Conservative on purpose. A candidate that equals a name which will itself be rewritten is
-- rejected too, even though the rewritten form would have differed. That costs one more `k` and
-- nothing else, and the alternative — reasoning about which future names will move — is the kind of
-- second-guessing this defect came from.

DO $d7_tier4$
DECLARE
  v_src   text;
  v_new   text;
  v_i     int;
  v_hits  int;
  v_ident CONSTANT text :=
    -- `time[]`, NOT `time`. A first version wrote the scalar type, `to_regprocedure` resolved
    -- nothing, and the guard below quietly took its "prerequisites absent" branch — the migration
    -- reported success and changed nothing. That is why the guard is now split in two.
    'public.d7_child_target_names(text,text[],int[],time[],text[],text[],text[])';
  c_subs CONSTANT text[][] := ARRAY[
    -- The full tier-3 array, captured under a name of its own so the WHILE below can read it.
    [E'    v_sfx    text;', E'    v_sfx    text;\n    v_all    text[];', '1'],
    -- Taken at exactly the point the counts are, which is the last instant before tier 4 begins and
    -- the array still holds every tier-3 name.
    --
    -- ANCHORED ON THE TIER-4 LOOP, not on `v_dup := …` alone: every tier recomputes the counts, so
    -- the bare assignment occurs THREE times and a substitution on it would have rewritten tiers 2
    -- and 3 as well. The exact-count assertion is what caught that.
    [E'    v_dup := public.d7_name_counts(v_names);\n'
     '    FOR v_i IN 1 .. v_n LOOP\n'
     '      IF public.d7_name_colliding(v_dup, v_names[v_i], v_taken) THEN\n'
     '        v_base := v_names[v_i];',
     E'    v_all := v_names;\n'
     '    v_dup := public.d7_name_counts(v_names);\n'
     '    FOR v_i IN 1 .. v_n LOOP\n'
     '      IF public.d7_name_colliding(v_dup, v_names[v_i], v_taken) THEN\n'
     '        v_base := v_names[v_i];', '1'],
    [E'        WHILE (v_cand = ANY (v_taken) OR v_cand = ANY (v_emit)) AND v_k <= c_max_k LOOP',
     E'        WHILE (v_cand = ANY (v_taken) OR v_cand = ANY (v_emit)\n'
     '               OR (v_cand IS DISTINCT FROM v_base AND v_cand = ANY (v_all)))\n'
     '              AND v_k <= c_max_k LOOP', '1']
  ];
  v_p     name;
  v_a     name;
BEGIN
  -- TWO CHECKS, NOT ONE, AND THEY MEAN DIFFERENT THINGS.
  --
  -- "ABC-27 is not here" is a legitimate skip: this file sorts after it and must leave nothing
  -- behind on a database that never got it. "ABC-27 is here but my target is not" is a BUG in this
  -- file, and folding the two together is how the first version of it silently did nothing.
  IF to_regclass('public.rebook_rounds') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
                     WHERE a.attrelid = to_regclass('public.notification_outbox')
                       AND a.attname = 'transport_state'
                       AND a.attnum > 0 AND NOT a.attisdropped) THEN
    RAISE NOTICE 'D7 tier 4: prerequisites absent — skipping';
    RETURN;
  END IF;
  IF to_regprocedure(v_ident) IS NULL THEN
    RAISE EXCEPTION 'D7 tier 4: % is not installed — the naming chain this file re-issues is missing', v_ident;
  END IF;

  SELECT p.proowner::regrole::name INTO v_p FROM pg_proc p WHERE p.oid = to_regprocedure(v_ident);

  FOR v_i IN 1 .. array_length(c_subs, 1) LOOP
    SELECT pg_catalog.pg_get_functiondef(to_regprocedure(v_ident)) INTO v_src;
    v_hits := (length(v_src) - length(replace(v_src, c_subs[v_i][1], ''))) / length(c_subs[v_i][1]);
    IF v_hits <> c_subs[v_i][3]::int THEN
      RAISE EXCEPTION 'D7 tier 4: % occurrence(s) of a substitution expected exactly % time(s): %',
        v_hits, c_subs[v_i][3], left(c_subs[v_i][1], 60);
    END IF;
    EXECUTE replace(v_src, c_subs[v_i][1], c_subs[v_i][2]);
    SELECT pg_catalog.pg_get_functiondef(to_regprocedure(v_ident)) INTO v_src;
    IF position(c_subs[v_i][2] IN v_src) = 0 THEN
      RAISE EXCEPTION 'D7 tier 4: the naming chain did not take substitution %', left(c_subs[v_i][2], 60);
    END IF;
  END LOOP;

  -- OWNERSHIP AND PRIVILEGES RE-ASSERTED. `CREATE OR REPLACE` preserves both, but `20261203220000`
  -- re-asserts them here for the same reason and this file must leave the identical negative space.
  SELECT c.relowner::regrole::name INTO v_a
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'rebook_round_transport_transitions';
  EXECUTE format('ALTER FUNCTION %s OWNER TO %I', v_ident, v_p);
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', v_ident);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', v_ident, v_a);

  -- PROVED FROM THE CATALOG: the backward-looking sets SURVIVE. A substitution that replaced them
  -- instead of extending them would fix the future case by breaking the two this file is not about.
  SELECT pg_catalog.pg_get_functiondef(to_regprocedure(v_ident)) INTO v_src;
  IF position('v_cand = ANY (v_taken)' IN v_src) = 0
     OR position('v_cand = ANY (v_emit)' IN v_src) = 0
     OR position('v_cand = ANY (v_all)' IN v_src) = 0 THEN
    RAISE EXCEPTION 'D7 tier 4: the candidate no longer avoids all three sets';
  END IF;

  RAISE NOTICE 'D7: tier 4 now avoids future tier-3 names as well as past ones';
END $d7_tier4$;
