-- D7 RUNTIME — NAMES ARE DISAMBIGUATED ON THE FORM THAT IS ACTUALLY STORED.
--
-- OWNER DECISION (`APPROVE_D7_RUNTIME_TERMINAL_SEMANTICS_AND_RECOVERY_CLOSURE_V1`):
-- `NAMING=TRUNCATE_THEN_DISAMBIGUATE_ON_THE_FINAL_PERSISTED_FORM_WITH_SUFFIX_AWARE_BOUNDED_TIER_4`.
--
-- ── THE DEFECT, AS REVIEW ROUND 5 STATED IT ─────────────────────────────────────────────────
--
-- `d7_child_target_names` decides every collision on the UNTRUNCATED candidate, and both callers
-- truncate afterwards — the projection at `20261203190000` and the patched cores at
-- `20261203200000`, each with `rebook_round_sanitize_copy(…, 300)`. So the chain answers a
-- question about strings that are never stored, and two candidates it judged distinct can be
-- identical by the time they reach `public.cycles.name`.
--
-- It fails in both directions, and neither is theoretical:
--
--   * A VALID COHORT IS REFUSED. A 200-character label with two same-time series whose trainers'
--     first names share their first ~86 characters: tier 2 sees two distinct names and stops;
--     truncation to 300 makes them identical; the core's distinct-name verdict then refuses a
--     cohort that had a perfectly good pair of names available.
--
--   * AN ARMED REVIEW CANNOT APPLY. A single overlong candidate truncates onto a name the round
--     already holds at 300 characters. The review arms — it compared untruncated strings and saw
--     no collision — and the apply dies on `uniq_rebook_cycle_key`, returning `invalid_request`
--     for a round the operator was told was ready.
--
-- ── WHY THE FIX GOES HERE AND NOWHERE ELSE ──────────────────────────────────────────────────
--
-- Both surfaces call THIS function. That was the point of centralising it, and it is what makes a
-- one-place fix move the projection and both cores together — the property the round-2 digest and
-- round-3 child-id drift were fixed by establishing. Truncating in the two CALLERS instead would
-- leave the chain still reasoning about strings nobody stores, and would put the two call sites
-- one edit apart from disagreeing again.
--
-- The callers keep their outer `rebook_round_sanitize_copy(…, 300)`. It is idempotent over what
-- this function now returns, and leaving it in place means the callers' contract is unchanged if
-- this inner rule is ever revisited. It is a belt beside braces, deliberately.
--
-- ── TIER 4 HAD TO LEARN ABOUT ITS OWN SUFFIX ────────────────────────────────────────────────
--
-- Appending ` #12` to a base already at 300 characters and then truncating gives back the base —
-- so the numeric tier, the one whose entire job is to break ties, could hand back the very name it
-- was disambiguating from. The base is therefore cut to `300 - length(' #' || k)` BEFORE the
-- suffix is appended, so `… #12` is 300 characters and still ends in its own suffix.
--
-- The search is bounded. Each `k` yields a DISTINCT candidate, so the loop cannot cycle and
-- terminates within `array_length(p_taken, 1) + 1` steps — the taken set is bounded by the round's
-- 200 children plus the same-date rebook cycles. The explicit ceiling below is therefore
-- unreachable in practice and exists so that "cannot happen" is enforced rather than believed.
-- ON EXHAUSTION IT FALLS THROUGH WITH A COLLIDING NAME, ON PURPOSE: the core's distinct-name
-- verdict and `uniq_rebook_cycle_key` both refuse that, TYPED, and a bare `RAISE` here would
-- escape the closed envelope as a raw SQLSTATE — precisely the defect `20261203230000` fixes for
-- the zero-occurrence case. A fail-closed path that already exists beats a new raiser.

DO $d7_naming_persisted_form$
DECLARE
  v_a name;
  v_p name;
BEGIN
  IF to_regclass('public.rebook_rounds') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
                     WHERE a.attrelid = to_regclass('public.notification_outbox')
                       AND a.attname = 'transport_state'
                       AND a.attnum > 0 AND NOT a.attisdropped)
     OR to_regprocedure('public.d7_child_target_names(text,text[],int[],time[],text[],text[],text[])') IS NULL
     OR to_regprocedure('public.rebook_round_sanitize_copy(text,int)') IS NULL THEN
    RAISE NOTICE 'D7 prerequisites absent — skipping (this file sorts after the selection authority)';
    RETURN;
  END IF;

  SELECT c.relowner::regrole::name INTO v_p
    FROM pg_catalog.pg_class c WHERE c.oid = to_regclass('public.cycles');
  SELECT p.proowner::regrole::name INTO v_a
    FROM pg_catalog.pg_proc p
   WHERE p.oid = to_regprocedure('public.rebook_round_preview_normalized_core(uuid,uuid,text,text,uuid,int,text,date,date,int,int,int,text,boolean,text,boolean,boolean,numeric,boolean,int,text,text,text,text,text,text,date[],date[],text[],uuid[],uuid[],uuid[])');
  IF v_a IS NULL OR v_p IS NULL OR v_a = v_p THEN
    RAISE EXCEPTION 'D7 naming: the two domain owners did not resolve distinctly (A=%, P=%)', v_a, v_p;
  END IF;
  IF NOT pg_catalog.pg_has_role(current_user, v_a, 'MEMBER')
     OR NOT pg_catalog.pg_has_role(current_user, v_p, 'MEMBER') THEN
    RAISE EXCEPTION 'D7 naming: % is not a member of both domain owners', current_user;
  END IF;

  -- ── THE CHAIN, RE-ISSUED ──────────────────────────────────────────────────────────────────
  --
  -- Every tier now ends in the persisted form, so every `d7_name_counts` / `d7_name_colliding`
  -- question is asked about a string that can actually be written to `public.cycles.name`.
  CREATE OR REPLACE FUNCTION public.d7_child_target_names(
    p_label     text,
    p_keys      text[],
    p_weekday   int[],
    p_time      time[],
    p_trainer   text[],
    p_location  text[],
    p_taken     text[]
  ) RETURNS text[] LANGUAGE plpgsql IMMUTABLE SET search_path = public
  AS $nm$
  DECLARE
    -- `public.cycles.name` is the destination, and 300 is what both callers cap at.
    c_max    CONSTANT int := 300;
    -- Unreachable given the taken set's own bound; see the header. A ceiling, not a policy.
    c_max_k  CONSTANT int := 9999;
    v_n      int := coalesce(array_length(p_keys, 1), 0);
    v_names  text[] := ARRAY[]::text[];
    v_taken  text[] := coalesce(p_taken, ARRAY[]::text[]);
    v_dup    jsonb;
    v_i      int;
    v_base   text;
    v_cand   text;
    v_sfx    text;
    v_seen   jsonb := '{}'::jsonb;
    -- EVERY NAME THIS CALL HAS ALREADY DECIDED. Not the same thing as `v_taken`, which is what the
    -- ROUND already holds; see the cross-base note in tier 4.
    v_emit   text[] := ARRAY[]::text[];
    v_k      int;
  BEGIN
    IF v_n = 0 THEN RETURN ARRAY[]::text[]; END IF;

    -- Tier 0 — one series, nothing taken, the label VERBATIM (legacy behaviour), in its persisted
    -- form. With a boundary-normalized label (`20261203230000`) this is the identity; it is
    -- applied anyway so that no arm of this function can return something unstorable.
    IF v_n = 1 AND coalesce(array_length(v_taken, 1), 0) = 0 THEN
      RETURN ARRAY[coalesce(public.rebook_round_sanitize_copy(p_label, c_max), '')];
    END IF;

    -- Tier 1 — day and time.
    FOR v_i IN 1 .. v_n LOOP
      v_names := v_names || coalesce(public.rebook_round_sanitize_copy(
        p_label || ' — ' || public.d7_series_label(p_weekday[v_i], p_time[v_i]), c_max), '');
    END LOOP;

    -- Tier 2 — the trainer's first name.
    v_dup := public.d7_name_counts(v_names);
    FOR v_i IN 1 .. v_n LOOP
      IF public.d7_name_colliding(v_dup, v_names[v_i], v_taken) AND p_trainer[v_i] IS NOT NULL THEN
        v_names[v_i] := coalesce(public.rebook_round_sanitize_copy(
          v_names[v_i] || ' · ' || p_trainer[v_i], c_max), '');
      END IF;
    END LOOP;

    -- Tier 3 — the location.
    v_dup := public.d7_name_counts(v_names);
    FOR v_i IN 1 .. v_n LOOP
      IF public.d7_name_colliding(v_dup, v_names[v_i], v_taken) AND p_location[v_i] IS NOT NULL THEN
        v_names[v_i] := coalesce(public.rebook_round_sanitize_copy(
          v_names[v_i] || ' · ' || p_location[v_i], c_max), '');
      END IF;
    END LOOP;

    -- Tier 4 — numeric, skipping what the round already holds AND what this call has already
    -- decided. The FIRST colliding instance of a base keeps the base itself (k = 1 renders no
    -- suffix), which is the legacy behaviour and the reason `v_seen` counts per BASE rather than
    -- per row.
    --
    -- REVIEW ROUND 1 (P2) · TWO DIFFERENT BASES CAN CONVERGE ONCE THE SUFFIX MAKES ROOM.
    --
    -- `v_seen` guarantees uniqueness only WITHIN one base, and the skip loop consulted only
    -- `v_taken`. Take four series ending tier 3 as bases `A, A, B, B`, where `A` and `B` are both
    -- 300 characters and differ only in their last three: `A` keeps itself, then `left(A,297) #2`;
    -- `B` keeps itself, then `left(B,297) #2` — and those two truncations are the SAME STRING.
    -- The review projects a duplicate pair, and the apply then fails on `uniq_rebook_cycle_key`
    -- for a cohort that had four perfectly good names available.
    --
    -- Cutting the base to make room for the suffix is what creates the convergence, so the fix
    -- belongs beside it: every name this call has already decided is off-limits too.
    v_dup := public.d7_name_counts(v_names);
    FOR v_i IN 1 .. v_n LOOP
      IF public.d7_name_colliding(v_dup, v_names[v_i], v_taken) THEN
        v_base := v_names[v_i];
        v_k := coalesce((v_seen ->> v_base)::int, 0) + 1;
        IF v_k = 1 THEN
          v_cand := v_base;
        ELSE
          v_sfx  := ' #' || v_k::text;
          -- THE BASE IS CUT TO MAKE ROOM FOR THE SUFFIX, not truncated after it. Otherwise a base
          -- already at the cap swallows its own disambiguator and tier 4 returns the collision.
          v_cand := coalesce(public.rebook_round_sanitize_copy(v_base, c_max - length(v_sfx)), '')
                    || v_sfx;
        END IF;
        WHILE (v_cand = ANY (v_taken) OR v_cand = ANY (v_emit)) AND v_k <= c_max_k LOOP
          v_k := v_k + 1;
          v_sfx  := ' #' || v_k::text;
          v_cand := coalesce(public.rebook_round_sanitize_copy(v_base, c_max - length(v_sfx)), '')
                    || v_sfx;
        END LOOP;
        v_seen := jsonb_set(v_seen, ARRAY[v_base], to_jsonb(v_k));
        v_names[v_i] := v_cand;
      END IF;
      -- EVERY final name, not only the rewritten ones: a suffixed candidate must also avoid a name
      -- that tier 3 left alone.
      v_emit := v_emit || v_names[v_i];
    END LOOP;

    RETURN v_names;
  END;
  $nm$;

  -- OWNERSHIP FIRST, PRIVILEGES SECOND: `ALTER FUNCTION … OWNER TO` REWRITES the ACL's owner
  -- entries, so a REVOKE/GRANT issued before the transfer is partly undone by it. Re-asserted here
  -- rather than assumed, because `CREATE OR REPLACE` preserves the existing owner and ACL and this
  -- file must leave the same negative space `20261203180000` established.
  EXECUTE format('ALTER FUNCTION public.d7_child_target_names(text,text[],int[],time[],text[],text[],text[]) OWNER TO %I', v_p);
  REVOKE ALL ON FUNCTION public.d7_child_target_names(text,text[],int[],time[],text[],text[],text[])
    FROM PUBLIC, anon, authenticated, service_role;
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.d7_child_target_names(text,text[],int[],time[],text[],text[],text[]) TO %I', v_a);

  RAISE NOTICE 'D7: the naming chain now disambiguates on the persisted form (owner %, caller %)', v_p, v_a;
END $d7_naming_persisted_form$;
