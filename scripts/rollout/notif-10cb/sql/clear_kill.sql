-- N6 — CLEAR A CHANNEL KILL. The one reviewed way back.
--
-- A kill stops a channel now; clearing it decides that mail RESUMES, which is why it lives here
-- and not on the admin page. Before this artifact existed the documented procedure was
-- "guard-disable + DELETE as superuser" — which is not a procedure. This is: it names the exact
-- kill being cleared, prints who set it and why, reports the queue the clear releases, and leaves
-- an audit row beside the original kill.
--
-- Takes :channel and :kill_request_id — the request id OF THE KILL, read from the admin page or
-- from `status`. Clearing "whatever kill is there" would re-open a channel someone else may have
-- killed thirty seconds ago for a different incident, so a mismatch is refused.
\set ON_ERROR_STOP on
-- NAME RESOLUTION IS PINNED FOR THE WHOLE SESSION (the doctrine every artifact here follows: an
-- exact-arity rival beats pg_catalog wherever its schema sits, so only EXCLUDING one works).
SET search_path = pg_catalog;

\i ../../notif-10ca3/sql/_assert.sql

-- WHAT YOU ARE ABOUT TO CLEAR, printed BEFORE the transaction: the operator reads this, and the
-- assertion below refuses if it is not the kill they named.
SELECT k.channel, k.request_id AS kill_request_id, k.activated_by, k.reason,
       k.activated_at, (pg_catalog.now() - k.activated_at) AS killed_for
  FROM public.notification_channel_kill_switches k
 WHERE k.channel = :'channel';

-- …and the queue this clear would release, so the size of the decision is visible before it is
-- taken. Disposing of it is a SEPARATE act (admin_dispose_pre_boundary_backlog, or simply letting
-- it send) — this artifact never decides that for you.
SELECT pg_catalog.count(*) AS pending_rows_that_would_resume
  FROM public.notification_outbox o
 WHERE o.channel = :'channel' AND o.status OPERATOR(pg_catalog.=) 'pending';

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TEMP TABLE _clear AS
  SELECT * FROM public.clear_notification_channel_kill(
    :'channel',
    :'kill_request_id'::pg_catalog.uuid,
    :'reason',
    :'request_id'::pg_catalog.uuid);

-- Every refusal is a typed verdict, already recorded as a rejected attempt on the way out — so
-- this assertion turns it into a non-zero exit without losing the evidence.
SELECT pg_temp.assert(
  (SELECT verdict FROM pg_temp._clear) OPERATOR(pg_catalog.=) 'cleared',
  'the kill was cleared (rejected_stale_kill = the live kill is not the one you named; rejected_not_killed = the channel was already live)');

-- the postcondition, in the same transaction
SELECT pg_temp.assert_eq(
  (SELECT pg_catalog.count(*)::pg_catalog.int FROM public.notification_channel_kill_switches
    WHERE channel = :'channel'), 0,
  'the channel is no longer killed');
SELECT pg_temp.assert_eq(
  (SELECT pg_catalog.count(*)::pg_catalog.int FROM public.notification_admin_audit
    WHERE request_id = :'request_id'::pg_catalog.uuid AND action = 'channel_kill_cleared'), 1,
  'the clearing is audited beside the kill it cleared');

SELECT pg_catalog.format('KILL_CLEARED=%s RELEASED=%s%s',
         :'channel', (SELECT pending_released FROM pg_temp._clear),
         CASE WHEN (SELECT pending_released_capped FROM pg_temp._clear) THEN '+' ELSE '' END) AS clear_marker;

DROP TABLE pg_temp._clear;
COMMIT;
