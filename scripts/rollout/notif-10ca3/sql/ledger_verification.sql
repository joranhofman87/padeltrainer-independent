-- ===========================================================================
-- ledger_verification.sql — read-only consistency invariants over the
-- append-only reconcile ledger and the live email-delivery tables. Post
-- migration the reconcile ledger is INERT (0 rows); the invariants are written
-- generically so they also hold once the ledger is populated in PR-2. Also
-- re-checks that the new event_type CHECK accepts every pre-existing
-- email_delivery_events row (migration data-safety). Mutates nothing.
-- Used after rehearsals to confirm no partial/half-written ledger rows exist.
-- ===========================================================================
\ir _assert.sql

-- ---- reconcile state/actions ledger invariants ----------------------------
-- Every action references an existing reconcile-state row (no dangling audit).
SELECT pg_temp.assert(
  NOT EXISTS (
    SELECT 1 FROM public.notification_orphan_reconcile_actions a
    LEFT JOIN public.notification_orphan_reconcile_state s
      ON s.resend_event_id = a.resend_event_id
    WHERE s.resend_event_id IS NULL),
  'every reconcile action references an existing state row');

-- action domain
SELECT pg_temp.assert(
  NOT EXISTS (SELECT 1 FROM public.notification_orphan_reconcile_actions
              WHERE action NOT IN ('requeue','resolve')),
  'reconcile actions.action in (requeue,resolve)');

-- quarantine invariants (mirror the table CHECK constraints, as data checks)
SELECT pg_temp.assert(
  NOT EXISTS (SELECT 1 FROM public.notification_orphan_reconcile_state
              WHERE quarantined AND last_error_code IS NULL),
  'quarantined state rows always carry a last_error_code');
SELECT pg_temp.assert(
  NOT EXISTS (SELECT 1 FROM public.notification_orphan_reconcile_state
              WHERE quarantined AND attempts <= 0),
  'quarantined state rows always have attempts > 0');
SELECT pg_temp.assert(
  NOT EXISTS (SELECT 1 FROM public.notification_orphan_reconcile_state
              WHERE attempts < 0),
  'reconcile state attempts >= 0');

-- ---- live email-delivery data safety --------------------------------------
-- The new CHECK constraint on event_type must accept every existing row.
SELECT pg_temp.assert(
  NOT EXISTS (
    SELECT 1 FROM public.email_delivery_events
    WHERE event_type NOT IN
      ('sent','delivered','bounced','complained','delivery_delayed','failed',
       'send_failed','suppressed','suppression_removed','operator_reset')),
  'every email_delivery_events.event_type is within the accepted domain');

-- is_suppressed is a STORED generated column; re-verify it matches its rule for
-- every row (defends against a bad manual backfill upstream of the generation).
SELECT pg_temp.assert(
  NOT EXISTS (
    SELECT 1 FROM public.email_address_state
    WHERE is_suppressed IS DISTINCT FROM
      ((state IN ('hard_bounced','complained')) OR provider_suppressed_active)),
  'email_address_state.is_suppressed matches its generation rule for all rows');

SELECT pg_temp.assert(
  NOT EXISTS (SELECT 1 FROM public.email_address_state
              WHERE state NOT IN ('ok','soft_bounced','hard_bounced','complained')),
  'email_address_state.state is within its domain for all rows');

-- evidence: current row counts (INERT ledger expected 0/0)
SELECT pg_temp.note('reconcile_state rows = '   || (SELECT count(*) FROM public.notification_orphan_reconcile_state));
SELECT pg_temp.note('reconcile_actions rows = ' || (SELECT count(*) FROM public.notification_orphan_reconcile_actions));
SELECT pg_temp.note('email_address_state rows = ' || (SELECT count(*) FROM public.email_address_state));
SELECT pg_temp.note('email_delivery_events rows = ' || (SELECT count(*) FROM public.email_delivery_events));

SELECT pg_temp.note('ledger_verification: all assertions passed');
