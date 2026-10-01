-- D7 RUNTIME — THE APPLY COUNTERPART OF THE SELECTION SURFACE.
--
-- WHY THIS EXISTS. `CLIENT=NO_FINAL_SOURCE_SLOT_ARRAY` is an end-to-end rule, and
-- `rebook_round_apply_command_as_actor` takes `p_source_slot_ids` and `p_child_cycle_ids` as
-- arguments. A browser that may not hold the source array cannot call it, so without this file the
-- client rule is unimplementable and the cutover stops one hop short of the thing it was for.
--
-- IT IS THE PREVIEW SURFACE'S MIRROR, NOT A SECOND AUTHORITY. Same gates in the same order, the
-- same two closed vocabularies, the same candidate bridges, the same clusterer, the same derived
-- child identities. It re-derives rather than accepting a relayed array, and then hands the result
-- to the EXISTING `rebook_round_apply_normalized_core` — which stays the only apply authority.
--
-- ── WHY RE-DERIVING IS SAFE, AND WHAT HAPPENS WHEN THE SOURCE MOVED ─────────────────────────
--
-- The child identities are `md5(round_id || '|' || series_key)`, so the same selection derives the
-- same children at review and at apply. If a source slot moved in between, the derived arrays
-- differ, the core re-computes a different fingerprint from them, and the operator gets the typed
-- `source_drift` refusal with nothing written — which is exactly the answer the typed protocol
-- already gives when a relayed array goes stale. The selection digest is checked FIRST, so the
-- commoner case (the operator's own selection changed under them) is answered in the selection's
-- own vocabulary rather than as a drift deep inside apply.
--
-- ── REPLAY ──────────────────────────────────────────────────────────────────────────────────
--
-- Unchanged and inherited: the command UUID is the idempotency key, and re-calling this function
-- with the same command id and the same fingerprint returns the core's `replayed` receipt without
-- re-issuing a capability. Nothing here caches, retries or re-mints.

DO $d7_selection_apply$
DECLARE
  v_a name;
  v_p name;
  v_apply_sig CONSTANT text :=
    'public.rebook_round_apply_command_as_actor(uuid,uuid,text,text,uuid,int,text,date,date,int,int,int,text,boolean,text,boolean,boolean,numeric,boolean,int,text,text,text,text,text,text,date[],date[],text[],uuid[],uuid[],uuid[],bytea)';
BEGIN
  IF to_regclass('public.rebook_rounds') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
                     WHERE a.attrelid = to_regclass('public.notification_outbox')
                       AND a.attname = 'transport_state'
                       AND a.attnum > 0 AND NOT a.attisdropped)
     OR to_regprocedure(v_apply_sig) IS NULL
     OR to_regprocedure('public.d7_p_series_cluster(uuid,uuid[],text,date,uuid,text,text[])') IS NULL THEN
    RAISE NOTICE 'D7 prerequisites absent — skipping (this file sorts after the selection surface)';
    RETURN;
  END IF;

  SELECT p.proowner::regrole::name INTO v_a
    FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(v_apply_sig);
  SELECT c.relowner::regrole::name INTO v_p
    FROM pg_catalog.pg_class c WHERE c.oid = to_regclass('public.cycles');
  IF v_a IS NULL OR v_p IS NULL OR v_a = v_p THEN
    RAISE EXCEPTION 'D7 selection apply: the two domain owners did not resolve distinctly (A=%, P=%)', v_a, v_p;
  END IF;
  IF NOT pg_catalog.pg_has_role(current_user, v_a, 'MEMBER') THEN
    RAISE EXCEPTION 'D7 selection apply: % is not a member of the Domain-A owner %', current_user, v_a;
  END IF;

  CREATE FUNCTION public.rebook_round_selection_apply_as_actor(
    p_academy_profile_id   uuid,
    p_command_id           uuid,
    p_contract_version     text,
    p_command_kind         text,
    p_selection_mode       text,
    p_source_cycle_id      uuid,
    p_location_ids         uuid[],
    p_term_end             date,
    p_excluded_series_keys text[],
    -- MANDATORY HERE, unlike on the preview surface. An apply that did not name the selection it
    -- was reviewed against could be applied from a selection the operator never saw; the preview
    -- may be asked without one because asking is not acting.
    p_selection_digest     bytea,
    p_round_id             uuid,
    p_expected_version     int,
    p_label                text,
    p_target_start         date,
    p_target_end           date,
    p_term_weeks           int,
    p_priority_days        int,
    p_member_days          int,
    p_payment_mode         text,
    p_strict_mollie        boolean,
    p_public_open_mode     text,
    p_public_open_split    boolean,
    p_require_admin_review boolean,
    p_session_price        numeric,
    p_auto_reminder        boolean,
    p_reminder_lead_hours  int,
    p_invitation_subject   text,
    p_invitation_body      text,
    p_reminder_subject     text,
    p_reminder_body        text,
    p_rebook_rules         text,
    p_claim_info           text,
    p_holiday_from         date[],
    p_holiday_to           date[],
    p_holiday_label        text[],
    p_target_slot_ids      uuid[],
    p_review_fingerprint   bytea
  ) RETURNS TABLE (
    status            text,
    round_id          uuid,
    command_id        uuid,
    child_count       int,
    occurrence_count  int,
    claim_count       int,
    receipt_canonical bytea,
    receipt_digest    bytea,
    detail            jsonb,
    round_version     int,
    -- THE ROUND'S OWN CHILDREN, returned so the caller can drain invites for them.
    --
    -- This is NOT the source array the client rule withholds. These are the cycles this command
    -- just created — rows the operator is about to be shown and navigate into — and the caller
    -- needs them to drain. The alternative was for the browser to re-derive
    -- `md5(round || '|' || series_key)` for itself, which is the browser reproducing a server
    -- derivation: the exact habit this release exists to end.
    child_cycle_ids   uuid[]
  )
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
  AS $fn$
  DECLARE
    -- NOT INITIALIZED IN `DECLARE`, for the reason every wrapper in this family records: a
    -- malformed subject would raise before any gate and turn authorization into a distinguishable
    -- error.
    v_actor  uuid;
    v_refuse boolean := false;
    v_cands  uuid[];
    v_label  text;
    v_digest bytea;
    v_replay boolean := false;
    v_slots  uuid[];
    v_childs uuid[];
    v_row    record;
  BEGIN
    IF current_setting('transaction_isolation') <> 'read committed' THEN
      v_refuse := true;
    ELSE
      BEGIN
        v_actor := auth.uid();
      EXCEPTION WHEN OTHERS THEN
        v_actor := NULL;
      END;
      IF v_actor IS NULL
         OR p_academy_profile_id IS NULL
         OR p_command_id IS NULL
         OR p_contract_version IS DISTINCT FROM 'abc27.wire.v1'
         OR p_command_kind IS NULL OR p_command_kind NOT IN ('create', 'extend')
         OR p_selection_mode IS NULL OR p_selection_mode NOT IN ('source_cycle', 'cohort')
         OR p_selection_digest IS NULL
         OR NOT EXISTS (SELECT 1 FROM public.academy_managers am
                         WHERE am.academy_profile_id = p_academy_profile_id
                           AND am.user_id = v_actor) THEN
        v_refuse := true;
      END IF;
    END IF;
    IF v_refuse THEN
      RETURN QUERY SELECT 'refused'::text, NULL::uuid, p_command_id, 0, 0, 0,
                          NULL::bytea, NULL::bytea, NULL::jsonb, NULL::int, NULL::uuid[];
      RETURN;
    END IF;

    IF p_selection_mode = 'source_cycle' THEN
      v_cands := public.d7_p_cyclus_candidates(p_academy_profile_id, p_source_cycle_id);
    ELSE
      v_cands := public.d7_p_cohort_candidates(p_academy_profile_id, p_location_ids, p_term_end);
    END IF;
    v_label := coalesce(public.d7_p_round_label(p_academy_profile_id,
                          CASE WHEN p_command_kind = 'extend' THEN p_round_id END), p_label);

    -- ── A REPLAY IS ANSWERED BEFORE THE SELECTION IS FENCED ─────────────────────────────────
    --
    -- REVIEW ROUND 1 (P1). THE FENCE MADE A COMMITTED COMMAND UNREPLAYABLE, and it did so for the
    -- ordinary success case, not an exotic one: applying a round CREATES cycles, those cycles are
    -- same-date rebook cycles of this academy, and the digest covers the round's taken names — so
    -- the very act of succeeding changes the digest. An extend is worse still: its new children
    -- are stamped with the source cyclus, so the clusterer then suppresses those series and the
    -- (series, slot) half moves as well. Either way the retry after a lost response was refused
    -- `selection_moved` and never reached the core's stored receipt, which is precisely the
    -- situation the command uuid exists to resolve.
    --
    -- So a command this actor has ALREADY COMMITTED under this exact fingerprint goes straight to
    -- the core, which answers it from its stored bytes without issuing a capability or entering
    -- Domain P. Anything else — an unknown command, another actor's, another academy's, or the
    -- same uuid with a different review — is fenced normally and then answered by the core in its
    -- own vocabulary (`command_tenant_mismatch`, `command_payload_mismatch`). This reads only the
    -- Domain-A command table, scoped to the caller, so it discloses nothing a replay would not.
    SELECT EXISTS (
      SELECT 1 FROM public.rebook_round_commands rc
       WHERE rc.command_id = p_command_id
         AND rc.academy_profile_id = p_academy_profile_id
         AND rc.actor_user_id IS NOT DISTINCT FROM v_actor
         AND rc.request_fingerprint = p_review_fingerprint)
      INTO v_replay;

    -- THE SELECTION IS FENCED BEFORE THE COMMAND IS. A selection that moved is the operator's
    -- question, answered in the selection's own words; a source that moved underneath an unchanged
    -- selection is the core's, answered as `source_drift`. Collapsing the two would report a
    -- re-selected round as a data race.
    v_digest := public.d7_p_selection_digest(
      p_academy_profile_id, v_cands, p_selection_mode, p_term_end,
      CASE WHEN p_command_kind = 'extend' THEN p_round_id END,
      v_label, p_excluded_series_keys, p_target_start);
    IF NOT v_replay AND p_selection_digest IS DISTINCT FROM v_digest THEN
      RETURN QUERY SELECT 'selection_moved'::text, NULL::uuid, p_command_id, 0, 0, 0,
                          NULL::bytea, NULL::bytea, NULL::jsonb, NULL::int, NULL::uuid[];
      RETURN;
    END IF;

    SELECT array_agg(c.slot_id ORDER BY c.series_first, c.series_key, c.slot_start, c.slot_id),
           array_agg(public.d7_child_cycle_id(p_round_id, c.series_key)
                     ORDER BY c.series_first, c.series_key, c.slot_start, c.slot_id)
      INTO v_slots, v_childs
      FROM public.d7_p_series_cluster(p_academy_profile_id, v_cands, p_selection_mode, p_term_end,
             CASE WHEN p_command_kind = 'extend' THEN p_round_id END,
             v_label, p_excluded_series_keys) c
     WHERE c.qualifies AND NOT c.suppressed AND NOT c.excluded;

    -- A PURE PASS-THROUGH of the core's answer, exactly as the wrapper it mirrors is: the core is
    -- the sole actor-bound receipt authority, so nothing here performs a second command lookup
    -- that could disclose a peer actor's stored receipt.
    SELECT * INTO v_row FROM public.rebook_round_apply_normalized_core(
      v_actor, p_academy_profile_id, p_contract_version, p_command_kind, p_command_id, p_round_id,
      p_expected_version, p_label, p_target_start, p_target_end, p_term_weeks,
      p_priority_days, p_member_days, p_payment_mode, p_strict_mollie,
      p_public_open_mode, p_public_open_split, p_require_admin_review, p_session_price,
      p_auto_reminder, p_reminder_lead_hours, p_invitation_subject, p_invitation_body,
      p_reminder_subject, p_reminder_body, p_rebook_rules, p_claim_info,
      p_holiday_from, p_holiday_to, p_holiday_label,
      coalesce(v_slots, ARRAY[]::uuid[]), coalesce(v_childs, ARRAY[]::uuid[]),
      p_target_slot_ids, p_review_fingerprint);

    RETURN QUERY SELECT v_row.status, v_row.round_id, v_row.command_id,
                        v_row.child_count, v_row.occurrence_count, v_row.claim_count,
                        v_row.receipt_canonical, v_row.receipt_digest, v_row.detail,
                        v_row.round_version,
                        -- Only on an outcome that HAS children: a refusal discloses nothing.
                        -- REVIEW ROUND 1 (P3): ORDERED. `array_agg(DISTINCT …)` without an
                        -- ORDER BY leaves the order to the planner, so a replay could pick a
                        -- different first navigation target and a different drain order than the
                        -- original apply — the same command answering differently twice.
                        CASE WHEN v_row.status IN ('applied', 'replayed')
                             THEN (SELECT array_agg(DISTINCT ch ORDER BY ch)
                                     FROM unnest(v_childs) ch) END;
  END;
  $fn$;

  EXECUTE format('ALTER FUNCTION public.rebook_round_selection_apply_as_actor('
    || 'uuid,uuid,text,text,text,uuid,uuid[],date,text[],bytea,uuid,int,text,date,date,int,int,int,'
    || 'text,boolean,text,boolean,boolean,numeric,boolean,int,text,text,text,text,text,text,'
    || 'date[],date[],text[],uuid[],bytea) OWNER TO %I', v_a);

  REVOKE ALL ON FUNCTION public.rebook_round_selection_apply_as_actor(
    uuid,uuid,text,text,text,uuid,uuid[],date,text[],bytea,uuid,int,text,date,date,int,int,int,
    text,boolean,text,boolean,boolean,numeric,boolean,int,text,text,text,text,text,text,
    date[],date[],text[],uuid[],bytea)
    FROM PUBLIC, anon, authenticated, service_role;
  GRANT EXECUTE ON FUNCTION public.rebook_round_selection_apply_as_actor(
    uuid,uuid,text,text,text,uuid,uuid[],date,text[],bytea,uuid,int,text,date,date,int,int,int,
    text,boolean,text,boolean,boolean,numeric,boolean,int,text,text,text,text,text,text,
    date[],date[],text[],uuid[],bytea)
    TO authenticated;

  RAISE NOTICE 'D7: the selection apply surface is installed, granted to authenticated only';
END $d7_selection_apply$;
