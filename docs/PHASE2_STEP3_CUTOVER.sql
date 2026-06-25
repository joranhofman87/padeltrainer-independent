-- =============================================================================
-- PHASE 2 STEP 3 — THE CUTOVER BACKFILL  (registration <-> cycle split)
-- =============================================================================
-- OWNER-RUN, ONE-TIME, DELIBERATE. This is NOT a tracked migration on purpose:
-- it must run only AFTER its prerequisites (below) and only when you choose to,
-- so it is intentionally kept out of supabase/migrations/ where the next
-- `supabase db push` would otherwise fire it automatically. Run it by hand in
-- the Supabase SQL editor (or psql) after the pre-flight in
-- docs/PHASE2_STEP3_RUNBOOK.md passes.
--
-- PRE-REQ (expand-before-contract, HARD): the dual-read frontend (PR #110) and
-- the two payment edge fns (submit-guest-intake, create-registration-invoice)
-- MUST already be DEPLOYED. They resolve a registration by source_cycle_id and
-- pass registration.id when minting, so the type='cyclus' flip below is safe
-- while legacy /register/:cycleId links still exist. Running this before that
-- deploy makes the 2 flipped cycles fall to the legacy getCycle path → the form
-- mis-renders AND paid registrations silently stop charging.
--
-- NON-DESTRUCTIVE (owner-locked): only (a) INSERT registrations rows, (b)
-- additive NULL-only UPDATE of registration_id on intake_requests + invoices,
-- (c) a REVERSIBLE cycles.type flip on exactly the training-owning
-- registration/event cycles. NO DELETE / DROP / move. bookings +
-- availability_slots are never written (proven by checksum in the verify block).
--
-- SELF-ROLLING-BACK: wrapped in one explicit transaction. The verification DO
-- block RAISEs EXCEPTION on ANY anomaly → the txn aborts → the trailing COMMIT
-- is reported as ROLLBACK → zero rows changed. Fix the cause and re-run; every
-- write step is idempotent and the verification is re-run-safe.
--
-- DRY-RUN: to inspect on prod without committing, change the final COMMIT to
-- ROLLBACK and run it — you get the NOTICE / EXCEPTION arithmetic with no write.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 0) BASELINE — capture pre-write state inside THIS transaction. Content
--    checksums on the never-written tables PROVE the exact row-set is untouched
--    (not just cardinality). Re-checked at the end → RAISE → ROLLBACK on drift.
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE _backfill_baseline ON COMMIT DROP AS
SELECT
  (SELECT count(*) FROM public.bookings)            AS bookings,
  (SELECT count(*) FROM public.availability_slots)  AS availability_slots,
  (SELECT count(*) FROM public.intake_requests)     AS intake_requests,
  (SELECT count(*) FROM public.invoices)            AS invoices,
  (SELECT count(*) FROM public.cycles)              AS cycles,
  (SELECT count(*) FROM public.registrations)       AS registrations,
  -- content checksums for the tables this script must NEVER write
  (SELECT md5(coalesce(string_agg(id::text, ',' ORDER BY id), '')) FROM public.bookings)           AS bookings_ck,
  (SELECT md5(coalesce(string_agg(id::text, ',' ORDER BY id), '')) FROM public.availability_slots) AS slots_ck,
  -- how many registration/event cycles still NEED a registrations row (insertable = named, no row yet)
  (SELECT count(*) FROM public.cycles c
     WHERE c.type IN ('registration','event')
       AND c.name IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.registrations r WHERE r.source_cycle_id = c.id)
  ) AS to_insert,
  -- how many cycles WILL flip type→'cyclus' (NAMED registration/event that own >=1 slot)
  (SELECT count(*) FROM public.cycles c
     WHERE c.type IN ('registration','event')
       AND c.name IS NOT NULL
       AND EXISTS (SELECT 1 FROM public.availability_slots s WHERE s.cyclus_id = c.id)
  ) AS to_flip,
  -- INVARIANT TARGET (re-run-safe): reg-backed, slot-owning 'cyclus' cycles already present at
  -- baseline. After this txn the total must equal already_flipped + to_flip (check 8).
  (SELECT count(*) FROM public.cycles c
     WHERE c.type = 'cyclus'
       AND EXISTS (SELECT 1 FROM public.registrations r WHERE r.source_cycle_id = c.id)
       AND EXISTS (SELECT 1 FROM public.availability_slots s WHERE s.cyclus_id = c.id)
  ) AS already_flipped;

-- ---------------------------------------------------------------------------
-- (a) One registrations row per NAMED registration/event cycle. Copies all
--     form-facing fields + start_date/end_date/created_at + the FORM-ONLY
--     settings keys (training keys STAY on the cycle — additive). Idempotent via
--     NOT EXISTS + the uq_registrations_source_cycle unique index. Skips
--     NULL-named cycles (registrations.name is NOT NULL) — surfaced by the
--     pre-flight; COALESCE currency so a NULL never aborts the whole txn.
-- ---------------------------------------------------------------------------
INSERT INTO public.registrations (
  id, source_cycle_id, owner_type, owner_id, format, name, description,
  start_date, end_date, enrollment_deadline, status, total_price, currency,
  price_table, location_id, settings, created_at
)
SELECT
  gen_random_uuid(), c.id, c.owner_type, c.owner_id, c.type, c.name, c.description,
  c.start_date, c.end_date, c.enrollment_deadline, c.status, c.total_price,
  COALESCE(c.currency, 'EUR'),
  c.price_table, c.location_id,
  -- FORM-ONLY settings split. Verified against the actual readers: public form
  -- (CycleApplicationForm), shared pricing (registration-pricing.ts), payment minter
  -- (event-registration-invoice.ts), confirmation email (registration-confirmation-email.ts),
  -- registration display (CycleDetailDisplay / BrandedCycleRegistration).
  -- EXCLUDED (TRAINING-side, read only by generate-proposals / GenerateProposalsWizard;
  -- confirmed NOT read by any form/payment/email/display surface): min_skill_rating,
  -- max_skill_rating, applicable_trainer_ids, and the rest of the training/scoring keys
  -- (the cycle KEEPS all of them — non-destructive). Extra keys here that don't exist on a
  -- given cycle are simply skipped by `c.settings ? k`, so the list is a safe superset.
  COALESCE(
    (SELECT jsonb_object_agg(k, c.settings->k)
       FROM unnest(ARRAY[
         'lesson_types','custom_lesson_types','show_preferred_trainer','show_price_indication',
         'cyclus_options','duration_options','available_duration_minutes','price_columns',
         'prices_include_vat','success_message','confirmation_email_text','payment_methods',
         'rating_system','default_duration_minutes','available_days','max_participants',
         'notify_admin_on_submission','notify_admin_emails','pricing_note'
       ]) AS k
      WHERE c.settings ? k),
    '{}'::jsonb
  ),
  c.created_at
FROM public.cycles c
WHERE c.type IN ('registration','event')
  AND c.name IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM public.registrations r WHERE r.source_cycle_id = c.id);

-- ---------------------------------------------------------------------------
-- (b) Link intake_requests + invoices to their registration (additive; cycle_id
--     kept). NULL-only → idempotent. Never touches cycle_id/status/recipient, so
--     the invoices dedup index uniq_live_event_invoice_per_registrant is never engaged.
-- ---------------------------------------------------------------------------
UPDATE public.intake_requests ir
   SET registration_id = r.id
  FROM public.registrations r
 WHERE r.source_cycle_id = ir.cycle_id
   AND ir.registration_id IS NULL;

UPDATE public.invoices i
   SET registration_id = r.id
  FROM public.registrations r
 WHERE r.source_cycle_id = i.cycle_id
   AND i.registration_id IS NULL;

-- ---------------------------------------------------------------------------
-- (c) Re-designate ONLY the NAMED registration/event cycles that own training
--     (>=1 slot via availability_slots.cyclus_id) as type='cyclus'. The name
--     guard mirrors (a) EXACTLY, so the flip never touches a cycle that did not
--     also get a registrations row (no orphaned form). Pure-form cycles (0 slots)
--     keep their type as a deprecated shadow. Reversible. Idempotent (rows already
--     'cyclus' fall out of the WHERE on re-run).
-- ---------------------------------------------------------------------------
UPDATE public.cycles c
   SET type = 'cyclus'
 WHERE c.type IN ('registration','event')
   AND c.name IS NOT NULL
   AND EXISTS (SELECT 1 FROM public.availability_slots s WHERE s.cyclus_id = c.id);

-- ---------------------------------------------------------------------------
-- (d) VERIFY in-transaction. Any RAISE EXCEPTION aborts → ROLLBACK (data intact).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  base       _backfill_baseline%ROWTYPE;
  bad        bigint;
  n_reg_now  bigint;
BEGIN
  SELECT * INTO base FROM _backfill_baseline;

  -- (1) CONTENT-IMMUTABLE: the never-written tables must be byte-for-byte the same
  --     row-set (checksum, not just count) — proves the 1009 bookings / 322 slots untouched.
  IF (SELECT md5(coalesce(string_agg(id::text, ',' ORDER BY id), '')) FROM public.bookings) <> base.bookings_ck THEN
    RAISE EXCEPTION 'bookings row-set changed (checksum mismatch)';
  END IF;
  IF (SELECT md5(coalesce(string_agg(id::text, ',' ORDER BY id), '')) FROM public.availability_slots) <> base.slots_ck THEN
    RAISE EXCEPTION 'availability_slots row-set changed (checksum mismatch)';
  END IF;
  IF (SELECT count(*) FROM public.bookings) <> base.bookings THEN
    RAISE EXCEPTION 'bookings count changed: % -> %', base.bookings, (SELECT count(*) FROM public.bookings);
  END IF;
  IF (SELECT count(*) FROM public.availability_slots) <> base.availability_slots THEN
    RAISE EXCEPTION 'availability_slots count changed: % -> %', base.availability_slots, (SELECT count(*) FROM public.availability_slots);
  END IF;
  IF (SELECT count(*) FROM public.cycles) <> base.cycles THEN
    RAISE EXCEPTION 'cycles count changed: % -> %', base.cycles, (SELECT count(*) FROM public.cycles);
  END IF;

  -- (1b) intake_requests / invoices: NO-DROP (not strict-equality). A concurrent legitimate
  --      INSERT (a guest registers mid-apply via the already-deployed edge fns) is harmless and
  --      must not trigger a spurious rollback; a DROP signals real data loss. Link checks (5/6/7)
  --      catch any genuinely unlinked or mis-linked row regardless.
  IF (SELECT count(*) FROM public.intake_requests) < base.intake_requests THEN
    RAISE EXCEPTION 'intake_requests count DROPPED: % -> %', base.intake_requests, (SELECT count(*) FROM public.intake_requests);
  END IF;
  IF (SELECT count(*) FROM public.invoices) < base.invoices THEN
    RAISE EXCEPTION 'invoices count DROPPED: % -> %', base.invoices, (SELECT count(*) FROM public.invoices);
  END IF;

  -- (2) INSERT COUNT MATCHES the planned (name-guarded) work.
  n_reg_now := (SELECT count(*) FROM public.registrations);
  IF n_reg_now <> base.registrations + base.to_insert THEN
    RAISE EXCEPTION 'registrations insert count mismatch: had %, expected +% = %, got %',
      base.registrations, base.to_insert, base.registrations + base.to_insert, n_reg_now;
  END IF;

  -- (3) COVERAGE — un-flipped form shadows: every NAMED reg/event cycle still typed
  --     registration/event has a registrations row.
  SELECT count(*) INTO bad
    FROM public.cycles c
   WHERE c.type IN ('registration','event')
     AND c.name IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.registrations r WHERE r.source_cycle_id = c.id);
  IF bad > 0 THEN RAISE EXCEPTION 'named registration/event cycles without a registrations row: %', bad; END IF;

  -- (3b) COVERAGE — flipped set (closes the blind spot of a flipped-but-rowless cycle): every
  --      'cyclus' cycle that owns a slot AND is referenced by an intake_request MUST have a
  --      registrations row.
  SELECT count(*) INTO bad
    FROM public.cycles c
   WHERE c.type = 'cyclus'
     AND c.name IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.intake_requests ir WHERE ir.cycle_id = c.id)
     AND EXISTS (SELECT 1 FROM public.availability_slots s WHERE s.cyclus_id = c.id)
     AND NOT EXISTS (SELECT 1 FROM public.registrations r WHERE r.source_cycle_id = c.id);
  IF bad > 0 THEN RAISE EXCEPTION 'flipped cyclus cycles (with intakes+slots) missing a registrations row: %', bad; END IF;

  -- (4) Every registrations row carries the REQUIRED data + a live back-ref.
  SELECT count(*) INTO bad
    FROM public.registrations r
   WHERE r.source_cycle_id IS NULL
      OR r.owner_type IS NULL
      OR r.owner_id   IS NULL
      OR r.name       IS NULL
      OR r.format NOT IN ('registration','event')
      OR NOT EXISTS (SELECT 1 FROM public.cycles c WHERE c.id = r.source_cycle_id);
  IF bad > 0 THEN RAISE EXCEPTION 'registrations rows missing required data / dangling source_cycle_id: %', bad; END IF;

  -- (5) NO UNLINKED intake_requests that SHOULD be linked.
  SELECT count(*) INTO bad
    FROM public.intake_requests ir
   WHERE ir.registration_id IS NULL
     AND EXISTS (SELECT 1 FROM public.registrations r WHERE r.source_cycle_id = ir.cycle_id);
  IF bad > 0 THEN RAISE EXCEPTION 'unlinked intake_requests: %', bad; END IF;

  -- (6) NO UNLINKED invoices that SHOULD be linked (booking invoices have cycle_id IS NULL → excluded).
  SELECT count(*) INTO bad
    FROM public.invoices i
   WHERE i.registration_id IS NULL
     AND i.cycle_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.registrations r WHERE r.source_cycle_id = i.cycle_id);
  IF bad > 0 THEN RAISE EXCEPTION 'unlinked invoices: %', bad; END IF;

  -- (7) LINK CORRECTNESS — no cross-wiring.
  SELECT count(*) INTO bad
    FROM public.intake_requests ir
    JOIN public.registrations r ON r.id = ir.registration_id
   WHERE r.source_cycle_id <> ir.cycle_id;
  IF bad > 0 THEN RAISE EXCEPTION 'mis-linked intake_requests (registration.source_cycle_id <> cycle_id): %', bad; END IF;

  SELECT count(*) INTO bad
    FROM public.invoices i
    JOIN public.registrations r ON r.id = i.registration_id
   WHERE i.cycle_id IS NOT NULL AND r.source_cycle_id <> i.cycle_id;
  IF bad > 0 THEN RAISE EXCEPTION 'mis-linked invoices (registration.source_cycle_id <> cycle_id): %', bad; END IF;

  -- (8) TYPE-FLIP STATE INVARIANT (re-run-safe). Total reg-backed, slot-owning 'cyclus' cycles
  --     must equal what SHOULD exist after this txn: already there at baseline + planned to flip.
  --     Fresh run: already_flipped + to_flip. Re-run: already_flipped already includes them, to_flip=0
  --     → still equal. No false abort.
  SELECT count(*) INTO bad
    FROM public.cycles c
   WHERE c.type = 'cyclus'
     AND EXISTS (SELECT 1 FROM public.registrations r WHERE r.source_cycle_id = c.id)
     AND EXISTS (SELECT 1 FROM public.availability_slots s WHERE s.cyclus_id = c.id);
  IF bad <> base.already_flipped + base.to_flip THEN
    RAISE EXCEPTION 'type-flip invariant violated: expected % reg-backed slot-owning cyclus cycles (=% already + % flipped), got %',
      base.already_flipped + base.to_flip, base.already_flipped, base.to_flip, bad;
  END IF;

  -- (9) NO NAMED registration/event cycle that owns a slot was LEFT un-flipped.
  SELECT count(*) INTO bad
    FROM public.cycles c
   WHERE c.type IN ('registration','event')
     AND c.name IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.availability_slots s WHERE s.cyclus_id = c.id);
  IF bad > 0 THEN RAISE EXCEPTION 'named training-owning registration/event cycles NOT flipped to cyclus: %', bad; END IF;

  -- (10) SAFETY GATE — a NULL-named cycle that OWNS a slot is undecidable here (cannot get a
  --      registrations row, must not be silently left a half-broken form-owner). Force the owner to
  --      name it first. Expected ZERO (pre-flight canary C surfaces these before apply).
  SELECT count(*) INTO bad
    FROM public.cycles c
   WHERE c.type IN ('registration','event')
     AND c.name IS NULL
     AND EXISTS (SELECT 1 FROM public.availability_slots s WHERE s.cyclus_id = c.id);
  IF bad > 0 THEN
    RAISE EXCEPTION 'NULL-named registration/event cycle(s) own training slots (%) — name them before backfilling', bad;
  END IF;

  RAISE NOTICE 'registrations backfill OK: +% registrations (total %), % cycles flipped to cyclus, checksums + links + invariants verified.',
    base.to_insert, n_reg_now, base.to_flip;
END $$;

COMMIT;
