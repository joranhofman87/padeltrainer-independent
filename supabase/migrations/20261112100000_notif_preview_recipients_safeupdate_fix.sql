-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- RECIPIENT PREVIEW — LAUNCH BLOCKER: the staging table was cleared with an unqualified DELETE.
--
-- THE PRODUCTION FAILURE, verbatim:
--
--   code:    21000
--   message: delete requires a where clause
--
-- Opening Recipient Preview on the admin notification-ops screen returns that and no recipients.
-- Not a slow path, not a partial result — the RPC never gets to answer. The whole surface is dead
-- in production while passing every test we had, because the guard that rejects it does not exist
-- in a stock PostgreSQL and therefore does not exist in any of our harnesses.
--
-- THE CAUSE, one statement, in 20261022100000_notif_n4_seam_corrections.sql:416:
--
--   DELETE FROM _preview_raw;
--
-- Supabase's hosted Postgres loads the `safeupdate` guard, which refuses an UPDATE or DELETE with
-- no WHERE clause and raises SQLSTATE 21000. It fires inside SECURITY DEFINER plpgsql exactly as it
-- does at top level: the executor sees a delete with no qualification and stops it. Every other
-- DELETE in that function is qualified (`WHERE (r.uid, r.cid) = …`, `WHERE uid = v_boundary`) and
-- was never the problem — this one line is.
--
-- WHY THIS IS A NEW MIGRATION AND NOT AN EDIT. 20261022100000 is deployed. Editing an applied
-- migration makes the file lie about what the database contains and breaks every clone, rehearsal
-- and drift check that replays the chain. Forward-only, always.
--
-- ── WHAT REPLACES IT, AND WHY NOT THE OBVIOUS THING ────────────────────────────────────────────
--
-- The minimal fix is `TRUNCATE TABLE pg_temp._preview_raw`: TRUNCATE is a utility statement, not an
-- UPDATE or DELETE, so `safeupdate` does not inspect it. That was VERIFIED rather than assumed, and
-- it is not what this migration does — because TRUNCATE fixes the clearing and leaves a second,
-- older defect standing:
--
--   CREATE TEMP TABLE IF NOT EXISTS _preview_raw (…)
--
-- `IF NOT EXISTS` SILENTLY REUSES whatever relation already answers to that name. `pg_temp` is
-- searched before every schema in `search_path` for tables — including inside a SECURITY DEFINER
-- function with `SET search_path = public` — so an unqualified `_preview_raw` resolves to a
-- CALLER-created temp relation if one exists. Measured on a real server: with a caller-created
-- `_preview_raw(junk text)` in the session, the old shape skips creation, clears the caller's
-- table, and dies on `INSERT has more expressions than target columns` (42601). A different shape
-- with compatible column types would not error at all — it would stage the caller's rows and preview
-- them. For an admin surface whose entire job is answering "who would receive this", quietly
-- reading a relation someone else defined is the worse of the two bugs.
--
-- So the staging relation is DROPPED AND RECREATED on every invocation:
--
--   DROP TABLE IF EXISTS pg_temp._preview_raw;
--   CREATE TEMP TABLE _preview_raw (…) ON COMMIT DROP;
--
-- That answers all three requirements at once and removes the clearing step rather than replacing
-- it — there is nothing to clear in a table that was just created:
--   * no unqualified DELETE exists any more, so `safeupdate` has nothing to refuse;
--   * RE-ENTRANCY is by construction. Two invocations in one transaction or one session cannot
--     share staged rows, because the second one is not looking at the first one's table. The old
--     code depended on the DELETE for that, which is precisely the statement production refused —
--     so on a hosted database the previous invocation's rows were never cleared at all, they were
--     simply unreachable behind an error;
--   * a caller-created relation of ANY shape is replaced, not adopted. If it is not a table at all
--     (a temp VIEW of that name), `DROP TABLE` raises "is not a table" — a loud, immediate refusal
--     rather than a preview computed over someone else's definition.
--
-- EVERY REFERENCE IS SCHEMA-QUALIFIED as `pg_temp._preview_raw`. The function pins
-- `search_path = public`, which does NOT remove pg_temp from table resolution, so an unqualified
-- name here is ambiguous by construction. Qualifying says which relation is meant and cannot be
-- redirected.
--
-- NOTHING ELSE CHANGES. The candidate sources, the RAW_BUDGET, the keyset cursor, the partial-page
-- trimming, the clamp, the per-user provenance call, the empty-but-partial sentinel row and the
-- grants are byte-for-byte the deployed logic. This migration fixes how the staging table is
-- managed and touches nothing about what the preview returns.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.admin_preview_notification_recipients(
  p_event_key text,
  p_channel text,
  p_tenant_academy_profile_id uuid DEFAULT NULL,
  p_after_user_id uuid DEFAULT NULL,
  p_limit int DEFAULT 25
) RETURNS TABLE (
  user_id uuid,
  final_frequency text,
  final_decision text,
  destination_masked text,
  candidates_partial boolean,
  next_cursor uuid
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  RAW_BUDGET constant int := 500;
  u record;
  v_partial boolean := false;
  v_boundary uuid;
  v_progress uuid;
  v_lookahead uuid;
  v_single boolean := false;
  v_raw int := 0;
  v_emitted int := 0;
BEGIN
  PERFORM public.notif_admin_gate();
  -- A FRESH staging relation, every invocation. See the header: this replaces both the unqualified
  -- DELETE that production's safeupdate guard refuses AND the `IF NOT EXISTS` that would adopt a
  -- caller-created relation of the same name.
  DROP TABLE IF EXISTS pg_temp._preview_raw;
  CREATE TEMP TABLE _preview_raw (
    uid uuid, cid uuid, consent_status text, consent_scope text,
    consent_academy_profile_id uuid, consent_trainer_id uuid
  ) ON COMMIT DROP;
  INSERT INTO pg_temp._preview_raw
  SELECT nc.effective_user_id, nc.id, nc.consent_status, nc.consent_scope,
         nc.consent_academy_profile_id, nc.consent_trainer_id
    FROM public.notification_contacts nc
   WHERE nc.channel = p_channel AND nc.revoked_at IS NULL
     AND nc.effective_user_id IS NOT NULL
     AND (p_after_user_id IS NULL OR nc.effective_user_id > p_after_user_id)
   ORDER BY nc.effective_user_id, nc.id
   LIMIT RAW_BUDGET + 1;
  GET DIAGNOSTICS v_raw = ROW_COUNT;
  v_partial := (v_raw > RAW_BUDGET);
  IF v_partial THEN
    SELECT r.uid INTO v_lookahead FROM pg_temp._preview_raw r ORDER BY r.uid DESC, r.cid DESC LIMIT 1;
    DELETE FROM pg_temp._preview_raw r
     WHERE (r.uid, r.cid) = (SELECT r2.uid, r2.cid FROM pg_temp._preview_raw r2 ORDER BY r2.uid DESC, r2.cid DESC LIMIT 1);
    SELECT r.uid INTO v_boundary FROM pg_temp._preview_raw r ORDER BY r.uid DESC, r.cid DESC LIMIT 1;
    IF v_lookahead = v_boundary THEN
      SELECT count(DISTINCT r.uid) = 1 INTO v_single FROM pg_temp._preview_raw r;
      IF NOT v_single THEN
        DELETE FROM pg_temp._preview_raw WHERE uid = v_boundary;
        SELECT r.uid INTO v_progress FROM pg_temp._preview_raw r ORDER BY r.uid DESC LIMIT 1;
      ELSE
        -- the cap is now best-effort on the UPDATE path (the deadlock fix above), so an
        -- over-cap user is POSSIBLE rather than impossible: judge them on the staged set and
        -- advance, flagged partial — a raise here would wedge the crawl on one bad row.
        v_progress := v_boundary;
      END IF;
    ELSE
      v_progress := v_boundary;
    END IF;
  END IF;

  FOR u IN
    SELECT cand.uid FROM (
      (SELECT v2.user_id AS uid FROM public.notification_preferences_v2 v2
        WHERE v2.event_type = p_event_key
          AND (p_after_user_id IS NULL OR v2.user_id > p_after_user_id)
          AND (NOT v_partial OR v2.user_id <= v_progress)
        ORDER BY v2.user_id LIMIT 50)
      UNION
      (SELECT DISTINCT r.uid FROM pg_temp._preview_raw r
        WHERE (CASE p_channel WHEN 'email' THEN r.consent_status <> 'opted_out'
                              ELSE r.consent_status = 'opted_in' END)
          AND public.is_notification_consent_in_scope(
                r.consent_scope, r.consent_academy_profile_id, r.consent_trainer_id,
                p_tenant_academy_profile_id, NULL)
        ORDER BY 1 LIMIT 50)
      UNION
      -- ACCOUNT-EMAIL recipients: logged-in persons the resolver mails at persons.email when
      -- no eligible contact exists. Email only (whatsapp has no such fallback), bounded and
      -- cursored like every other source, and clamped to the same horizon on partial pages.
      (SELECT p.user_id FROM public.persons p
        WHERE p_channel = 'email' AND p.user_id IS NOT NULL AND p.email IS NOT NULL
          AND (p_after_user_id IS NULL OR p.user_id > p_after_user_id)
          AND (NOT v_partial OR p.user_id <= v_progress)
        ORDER BY p.user_id LIMIT 50)
    ) cand
    WHERE cand.uid IS NOT NULL
    ORDER BY cand.uid
    LIMIT LEAST(GREATEST(coalesce(p_limit, 25), 1), 50)
  LOOP
    v_emitted := v_emitted + 1;
    RETURN QUERY
    SELECT u.uid, d.final_frequency, d.final_decision, d.destination_masked, v_partial, u.uid
      FROM public.admin_preview_notification_decision(u.uid, p_event_key, p_channel, p_tenant_academy_profile_id) d;
  END LOOP;
  IF v_emitted = 0 AND v_partial THEN
    user_id := NULL; final_frequency := NULL; final_decision := NULL; destination_masked := NULL;
    candidates_partial := true; next_cursor := v_progress;
    RETURN NEXT;
  END IF;
END;
$$;

COMMENT ON FUNCTION public.admin_preview_notification_recipients(text, text, uuid, uuid, int) IS
  'N4 (seam-corrected; safeupdate fix 20261112100000): bounded recipient preview over THREE candidate sources — preference rows, eligible contacts (via the persisted effective-user projection, ≤500 rows examined) and, for email, logged-in persons with an account email (the resolver''s own fallback). Each source is cursored and clamped; candidates_partial + next_cursor keep omissions and progress honest. The pg_temp staging relation is DROPPED and recreated per invocation: the previous unqualified `DELETE FROM _preview_raw` raised 21000 under Supabase''s safeupdate guard (the surface was dead in production), and `CREATE TEMP TABLE IF NOT EXISTS` would otherwise adopt a caller-created relation of the same name.';

-- The grants are re-stated because CREATE OR REPLACE preserves them and silence here would leave a
-- reader unable to tell whether that was intended. Same set as the deployed function.
REVOKE ALL ON FUNCTION public.admin_preview_notification_recipients(text, text, uuid, uuid, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_preview_notification_recipients(text, text, uuid, uuid, int) TO authenticated, service_role;
