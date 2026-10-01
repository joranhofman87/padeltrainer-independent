-- D7 RUNTIME — SCHEMA. The one approved claim index, then the four retired member-open shims.
--
-- ORDER IS DELIBERATE: the index is created BEFORE the drops. If a drop were ever to fail, the
-- index — which the live dispatcher depends on for its bounded claim — is already in place, and
-- the failure is a legible partial rather than a fast path that silently regressed.
--
-- ── THE PREREQUISITE GUARD ───────────────────────────────────────────────────────────────────
--
-- This file sorts AFTER `20261118120000_abc27_rebook_round_notification_authority.sql` (and after
-- its own sibling `20261118115000_d7_runtime_crons.sql`, which sorts BEFORE ABC-27), and the
-- ABC-27 evidence suite builds its predecessor from the migrations directory MINUS the file under
-- test — which sweeps this file in and replays it BEFORE ABC-27, an order that never occurs in
-- production. `notification_outbox.transport_state` is created ONLY by ABC-27, so an unguarded
-- index over it would raise "column does not exist" and take the whole suite down with it.
-- Every block below therefore refuses to act when the D7 objects are absent.
--
-- A SKIPPING MIGRATION IS A FAIL-OPEN. `src/test/d7ForwardChain.realpg.test.ts` replays the
-- directory in TRUE filename order and asserts the index exists with its exact `indexdef` and all
-- four signatures are gone — i.e. that this guard never fires on the real chain. Do not remove it.
--
-- ── DEPLOY ORDER, AND HOW MUCH OF IT IS ENFORCED BY FILENAME RATHER THAN BY DISCIPLINE ──────
--
--   1. the code merges (workers, driver, retirements) — nothing applied, nothing deployed;
--   2. `notify-rebook-member-open` is UNDEPLOYED;
--   3. the three new edge functions are deployed, send flag ABSENT;
--   4. ONE `supabase db push` applies, in filename order and by construction:
--        `20261118115000_d7_runtime_crons.sql`  — retires the legacy cron, installs three INACTIVE
--        `20261118120000_abc27_…`               — the frozen authority migration
--        `20261203110000` (THIS FILE)           — the claim index, then the four drops
--
-- THIS FILE'S POSITION IS "AFTER", NOT "LAST". It is reissued at `20261203110000` so it sorts
-- after the composed A migration block (which currently ends at
-- `20261203100000_u2_account_scrub_operations.sql`) as well as after ABC-27. Nothing here — and
-- nothing in the evidence — depends on it being the FINAL file in the lineage: later migrations may
-- and will join after it. What it depends on is the ORDER RELATIVE TO ABC-27, which is what the
-- prerequisite guard and its not-silently-skipping control actually assert.
--
-- THE ORDER INSIDE STEP 4 IS THE FILENAMES', NOT AN OPERATOR'S. The cron retirement sorts BEFORE
-- ABC-27 precisely so the legacy job cannot still be armed when ABC-27 revokes the RPC it calls;
-- this file sorts AFTER ABC-27 because the four functions it drops are RE-CREATED by ABC-27 §10a
-- (which kept their signatures alive so a not-yet-redeployed Edge build still resolved) — dropping
-- them earlier would simply see them come back. Step 2 removes their last caller, so by the time
-- this file runs there is nothing left that could call them.
--
-- `src/test/d7ForwardChain.realpg.test.ts` proves that ordering from the DIRECTORY rather than
-- from this comment: it asserts every version prefix in the lineage is unique, that these three
-- files appear in exactly this relative order, and then replays the whole directory in filename
-- order and measures the resulting schema.

-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- (a) THE ONE APPROVED INDEX (OD-2).
--
-- It serves EXACTLY the D7 claim scan in `rebook_member_open_claim_batch`:
--
--     WHERE event_type = 'rebook_member_open_player'
--       AND channel    = 'email'
--       AND transport_state IN ('queued','retry_wait','quiet_hours_deferred','channel_kill_deferred')
--       AND NOT public.abc27_a_member_decided(...)
--       AND (scheduled_for IS NULL OR scheduled_for <= clock_timestamp())
--     ORDER BY scheduled_for, id
--     FOR UPDATE SKIP LOCKED
--     LIMIT n
--
-- KEY = THE EXACT `ORDER BY`. `ORDER BY x` is `ASC NULLS LAST`, which is the btree default, so an
-- ordered index scan over `(scheduled_for, id)` needs NO `Sort` node — that absence is the property
-- worth having, and it is asserted rather than assumed (P-2).
--
-- PREDICATE = THE EXACT CONSTANT CONJUNCTS, and only those. `clock_timestamp()` is VOLATILE, so
-- `scheduled_for <= clock_timestamp()` cannot be an index range bound and is applied as a filter;
-- that is fine, because the scan is already in `scheduled_for` order and the `LIMIT` terminates it
-- early. `abc27_a_member_decided(...)` is a function call and stays a filter by construction.
--
-- STATED RESIDUAL (the owner approved ONE index). `rebook_member_open_recover_expired_leases`
-- (`transport_state = 'leased'`, `ORDER BY locked_at, id`) and `rebook_member_open_close_unresolved`
-- (the acceptance-uncertain and window-closed classes) are NOT served by it. Both fall back to
-- `uq_notification_outbox_rebook_member_open_recipient`, whose predicate
-- (`event_type = 'rebook_member_open_player'`) is implied by theirs — so they are bounded by the
-- LIVE D7 ROW COUNT rather than by a batch size. That bound is measured and recorded in the
-- rollout runbook (P-3) and accepted; a second index is deliberately NOT added here.
--
-- LOCK NOTE FOR THE OPERATOR. `CREATE INDEX` takes a `SHARE` lock, which blocks writes to
-- `notification_outbox` for the duration of the build and therefore stalls the every-two-minutes
-- `notification-email-worker`. The partial predicate matches ZERO rows at apply time (D7 has never
-- run), so the build is a single scan of a partial index over an empty match set. The runbook
-- still carries a `pg_relation_size` / `reltuples` preflight and offers `CREATE INDEX CONCURRENTLY`
-- as a SEPARATE operator step outside this migration — `CONCURRENTLY` cannot run inside a
-- transaction block, so it can never be done from here.
DO $do$
DECLARE
  v_def text;
BEGIN
  -- `pg_catalog`, NOT `information_schema`. The information_schema views are PRIVILEGE-FILTERED:
  -- they show a column only to a role that owns the relation or holds a privilege on it. A
  -- deployment role able to assume the Domain-P owner but holding nothing on the Domain-N
  -- `notification_outbox` would see the column as ABSENT, take this skip, and let the migration be
  -- recorded as applied over nothing. `pg_attribute` is not filtered, so the guard now answers the
  -- question it is actually asking: does the object exist, not may I see it.
  IF to_regclass('public.rebook_rounds') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
                     WHERE a.attrelid = to_regclass('public.notification_outbox')
                       AND a.attname = 'transport_state'
                       AND a.attnum > 0 AND NOT a.attisdropped) THEN
    RAISE NOTICE 'D7 prerequisites absent — skipping (this file sorts after ABC-27 and must never run before it)';
    RETURN;
  END IF;

  CREATE INDEX IF NOT EXISTS idx_notification_outbox_d7_member_open_claim
    ON public.notification_outbox (scheduled_for, id)
    WHERE event_type = 'rebook_member_open_player'
      AND channel    = 'email'
      AND transport_state IN ('queued','retry_wait','quiet_hours_deferred','channel_kill_deferred');

  -- The index is the whole point of this block, so its existence is asserted rather than assumed:
  -- `IF NOT EXISTS` is silent about a name that already exists as something else.
  IF to_regclass('public.idx_notification_outbox_d7_member_open_claim') IS NULL THEN
    RAISE EXCEPTION 'D7 assert: idx_notification_outbox_d7_member_open_claim was not created';
  END IF;

  -- …AND EXISTENCE IS NOT ENOUGH. `CREATE INDEX IF NOT EXISTS` skips silently for ANY relation
  -- already holding that name, and the one an operator is most likely to meet is the INVALID
  -- leftover of a failed `CREATE INDEX CONCURRENTLY` — which the runbook offers as a manual
  -- pre-step for a large production table. An invalid index is not used by the planner and is not
  -- maintained, so taking the skip and reporting success would leave the claim scan on the
  -- sequential path this migration exists to remove, with a green migration log saying otherwise.
  --
  -- Every arm below is a fail-CLOSED refusal that names the remedy, never a repair: dropping or
  -- rebuilding somebody else's same-named object is not this migration's decision to take.
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_index i
     WHERE i.indexrelid = to_regclass('public.idx_notification_outbox_d7_member_open_claim')
       AND i.indrelid   = to_regclass('public.notification_outbox')
       AND i.indisvalid AND i.indisready AND i.indislive
  ) THEN
    RAISE EXCEPTION 'D7 assert: idx_notification_outbox_d7_member_open_claim exists but is not a live, valid index on public.notification_outbox'
      USING HINT = 'CREATE INDEX IF NOT EXISTS is silent about a name that is already taken — including by the INVALID leftover of a failed CREATE INDEX CONCURRENTLY. Drop the leftover, then re-run this migration.';
  END IF;

  -- The SHAPE is checked too, because a same-named index over different columns or a different
  -- predicate would be valid, live, and still not serve the claim scan. The deparsed definition is
  -- compared by its load-bearing parts rather than as one exact string: the exact byte form of a
  -- deparse varies with the column types the predicate compares, and pinning bytes here would turn
  -- an unrelated column-type change into a false refusal. The forward-chain suite separately pins
  -- the FULL definition byte-for-byte on the applied chain, where that comparison is meaningful.
  v_def := pg_catalog.pg_get_indexdef(to_regclass('public.idx_notification_outbox_d7_member_open_claim'));
  IF v_def IS NULL
     OR strpos(v_def, 'USING btree (scheduled_for, id)')      = 0
     OR strpos(v_def, '''rebook_member_open_player''')        = 0
     OR strpos(v_def, '''email''')                            = 0
     OR strpos(v_def, '''queued''')                           = 0
     OR strpos(v_def, '''retry_wait''')                       = 0
     OR strpos(v_def, '''quiet_hours_deferred''')             = 0
     OR strpos(v_def, '''channel_kill_deferred''')            = 0
     OR strpos(v_def, 'UNIQUE')                               > 0 THEN
    RAISE EXCEPTION 'D7 assert: idx_notification_outbox_d7_member_open_claim is not the reviewed partial index (actual: %)', coalesce(v_def, '<absent>')
      USING HINT = 'A pre-existing index already holds this name. Rename or drop it, then re-run this migration.';
  END IF;

  -- INSIDE THE GUARD, NOT AT TOP LEVEL. A top-level `COMMENT ON INDEX` would RAISE during the
  -- guard-skipped replay — the index does not exist there — which is precisely the error the
  -- guard exists to avoid. Every statement in this file must be reachable only when the D7
  -- prerequisites are present, or the file is not the clean no-op it claims to be.
  COMMENT ON INDEX public.idx_notification_outbox_d7_member_open_claim IS
    'D7: serves EXACTLY the rebook_member_open_claim_batch scan — key (scheduled_for, id) is the query''s own ORDER BY so no Sort node is planned, and the partial predicate is the three constant conjuncts. The volatile scheduled_for comparison and abc27_a_member_decided() stay filters by construction; LIMIT terminates the ordered scan early. Recovery and close scans are deliberately NOT served by it (one-index decision); they are bounded by live D7 row count.';
END $do$;

-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- (b) THE FOUR RETIRED MEMBER-OPEN SHIMS.
--
-- ABC-27 §10a kept these four signatures alive for one stated reason: "generated types and any
-- not-yet-redeployed Edge build still resolve". That is a DEPLOY-ORDERING argument, and this
-- release discharges it — `notify-rebook-member-open` and `_shared/rebook-member-open.ts` are
-- deleted from the repository, the function is undeployed at step 2, and the generated types are
-- regenerated wholesale at step 7.
--
-- DROP SAFETY, PROVED RATHER THAN ASSERTED. Every reference to these four across the whole
-- migration lineage is DDL (`CREATE OR REPLACE` / `GRANT` / `REVOKE`) in exactly four files. No
-- database function body, view definition, trigger, default, policy, constraint or generated
-- column calls any of them; `supabase/functions/bulk-rebook-cycle/index.ts` mentions one in a
-- COMMENT only. `src/test/d7ForwardChain.realpg.test.ts` re-proves all of that on the applied
-- chain (E-4b): `pg_depend` carries no edge, the four identities resolve to NULL, and a scan of
-- every remaining `public` function body, view definition and constraint expression finds zero
-- occurrences of the four names.
--
-- PLAIN `DROP`, NEVER `CASCADE`. There is nothing to cascade — that is the point of the proof
-- above — and `CASCADE` would silently take whatever a future object had come to depend on,
-- turning a reviewed retirement into an unreviewed one.
DO $do$
BEGIN
  -- `pg_catalog`, NOT `information_schema`. The information_schema views are PRIVILEGE-FILTERED:
  -- they show a column only to a role that owns the relation or holds a privilege on it. A
  -- deployment role able to assume the Domain-P owner but holding nothing on the Domain-N
  -- `notification_outbox` would see the column as ABSENT, take this skip, and let the migration be
  -- recorded as applied over nothing. `pg_attribute` is not filtered, so the guard now answers the
  -- question it is actually asking: does the object exist, not may I see it.
  IF to_regclass('public.rebook_rounds') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
                     WHERE a.attrelid = to_regclass('public.notification_outbox')
                       AND a.attname = 'transport_state'
                       AND a.attnum > 0 AND NOT a.attisdropped) THEN
    RAISE NOTICE 'D7 prerequisites absent — skipping the member-open shim drops';
    RETURN;
  END IF;

  DROP FUNCTION IF EXISTS public.claim_rebook_member_open_notice(uuid);
  DROP FUNCTION IF EXISTS public.unclaim_rebook_member_open_notice(uuid);
  DROP FUNCTION IF EXISTS public.append_rebook_member_open_notified(uuid, text[]);
  DROP FUNCTION IF EXISTS public.rebook_cycles_needing_member_open_notice();

  -- EXACT-IDENTITY ABSENCE, IN THE SAME TRANSACTION AS THE DROPS. `DROP FUNCTION IF EXISTS` is
  -- silent when the signature does not match, so an OVERLOAD that survived the drop would
  -- otherwise be discovered months later by whatever managed to call it. `to_regprocedure` over the
  -- exact reviewed signature is what turns "we dropped it" into a migration-time failure.
  IF to_regprocedure('public.claim_rebook_member_open_notice(uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'D7 assert: claim_rebook_member_open_notice(uuid) still exists after the drop';
  END IF;
  IF to_regprocedure('public.unclaim_rebook_member_open_notice(uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'D7 assert: unclaim_rebook_member_open_notice(uuid) still exists after the drop';
  END IF;
  IF to_regprocedure('public.append_rebook_member_open_notified(uuid, text[])') IS NOT NULL THEN
    RAISE EXCEPTION 'D7 assert: append_rebook_member_open_notified(uuid, text[]) still exists after the drop';
  END IF;
  IF to_regprocedure('public.rebook_cycles_needing_member_open_notice()') IS NOT NULL THEN
    RAISE EXCEPTION 'D7 assert: rebook_cycles_needing_member_open_notice() still exists after the drop';
  END IF;

  -- AND NO ROUTINE OF THOSE NAMES SURVIVES ANYWHERE, AT ANY SIGNATURE. The four checks above ask
  -- about four exact identities, which is the right question for the drops that just ran and the
  -- wrong one for everything else: `DROP FUNCTION IF EXISTS f(uuid)` is silent about an `f(text)`
  -- beside it, and an overload at a different argument list survives the retirement while staying
  -- perfectly callable — with whatever default EXECUTE it was created with. A search_path-shadowing
  -- copy in another schema is the same defect wearing a different hat, so the sweep is by name
  -- across every namespace rather than by identity in `public`.
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_proc p
     WHERE p.proname IN ('claim_rebook_member_open_notice',
                         'unclaim_rebook_member_open_notice',
                         'append_rebook_member_open_notified',
                         'rebook_cycles_needing_member_open_notice')
  ) THEN
    RAISE EXCEPTION 'D7 assert: a routine named after a retired member-open shim survives at some other signature or in some other schema'
      USING HINT = 'The four drops above each name ONE exact signature. Anything left with these names is an overload or a shadowing copy that was never reviewed; remove it deliberately before this migration can claim the surfaces are retired.';
  END IF;

  -- AND NOTHING THAT SURVIVES NAMES THEM. A drop that leaves a caller behind is a scheduled
  -- runtime error, so executable text is scanned here too — comments and string literals stripped
  -- with the same leftmost-first replacement the ABC-27 advisory scans use, which cannot erase
  -- executable text (it may over-match a quoted identifier, never miss a call).
  IF EXISTS (
    SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.prokind IN ('f','p')
       AND regexp_replace(p.prosrc, '(--[^\n]*)|(''([^'']|'''')*'')', ' ', 'g') ~
           '(claim_rebook_member_open_notice|unclaim_rebook_member_open_notice|append_rebook_member_open_notified|rebook_cycles_needing_member_open_notice)'
  ) THEN
    RAISE EXCEPTION 'D7 assert: a surviving public function body still names a retired member-open shim';
  END IF;

  -- …AND THE SAME SCAN AGAIN WITH THE LITERALS LEFT IN. The scan above strips string literals,
  -- which is right for prose and wrong for `EXECUTE 'SELECT public.claim_…(' || v_id || ')'`: a
  -- dynamically composed call is executable text that lives inside a literal, carries no
  -- `pg_depend` edge, and is therefore invisible to BOTH the stripped scan and the dependency
  -- proof — the two things this migration otherwise stands on.
  --
  -- IT LOOKS FOR A CALL, NOT A MENTION. Requiring the name to be followed by an open parenthesis
  -- is what keeps a comment or a message that merely names a retired shim from failing the
  -- migration, while still catching every composed call, which cannot omit it.
  IF EXISTS (
    SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.prokind IN ('f','p')
       AND p.prosrc ~
           '(claim_rebook_member_open_notice|unclaim_rebook_member_open_notice|append_rebook_member_open_notified|rebook_cycles_needing_member_open_notice)[[:space:]]*\('
  ) THEN
    RAISE EXCEPTION 'D7 assert: a surviving public function composes a call to a retired member-open shim in dynamic SQL'
      USING HINT = 'A call built inside a string literal has no catalog dependency, so neither pg_depend nor a literal-stripped source scan can see it. Rewrite or remove that caller before the shims are retired.';
  END IF;

  RAISE NOTICE 'D7: the four member-open shim signatures are retired and unreferenced';
END $do$;

-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- (c) THE STORED VALUES STAY. This is a comment, and only a comment.
--
-- `cycles.settings` still carries `rebook_member_open_notified_at` and
-- `rebook_member_open_notified_recipients` on rows the legacy path touched. They are HISTORICAL
-- RESIDUE: nothing reads them any more, and D7's per-recipient checkpoint is the durable
-- `rebook_round_recipient_decisions` relation instead.
--
-- THEY ARE NOT DELETED, DELIBERATELY. ABC-27 §10b's backfill reasons over exactly these keys when
-- it reconstructs provenance for pre-D7 rounds, so erasing them would destroy the only record of
-- who a legacy round had already contacted — and containment changes no rows by design.
--
-- GUARDED LIKE EVERYTHING ELSE HERE. `public.cycles` does exist in the inverted replay, so this
-- statement would succeed there — and that is exactly why it is guarded anyway: a file that is
-- supposed to be a total no-op before ABC-27 must not leave a single catalog change behind, or the
-- "clean no-op" claim is true only of the parts someone remembered to check.
DO $do$
BEGIN
  -- `pg_catalog`, NOT `information_schema`. The information_schema views are PRIVILEGE-FILTERED:
  -- they show a column only to a role that owns the relation or holds a privilege on it. A
  -- deployment role able to assume the Domain-P owner but holding nothing on the Domain-N
  -- `notification_outbox` would see the column as ABSENT, take this skip, and let the migration be
  -- recorded as applied over nothing. `pg_attribute` is not filtered, so the guard now answers the
  -- question it is actually asking: does the object exist, not may I see it.
  IF to_regclass('public.rebook_rounds') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
                     WHERE a.attrelid = to_regclass('public.notification_outbox')
                       AND a.attname = 'transport_state'
                       AND a.attnum > 0 AND NOT a.attisdropped) THEN
    RAISE NOTICE 'D7 prerequisites absent — skipping the legacy settings-residue comment';
    RETURN;
  END IF;

  COMMENT ON COLUMN public.cycles.settings IS
    'Free-form cycle settings document. D7 NOTE: the keys `rebook_member_open_notified_at` and `rebook_member_open_notified_recipients` are HISTORICAL RESIDUE of the retired member-open cron — nothing reads them at runtime any more (the durable per-recipient checkpoint is public.rebook_round_recipient_decisions). They are retained because the ABC-27 §10b import backfill reasons over them to reconstruct provenance for pre-D7 rounds; do not delete the stored values.';
END $do$;
