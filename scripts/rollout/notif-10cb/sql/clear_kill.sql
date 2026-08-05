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

-- WHAT YOU ARE ABOUT TO CLEAR, printed before the transaction. This is the SAME read the
-- `clear-kill --preview` step showed you; it is reprinted because an operator should see what
-- they are acting on in the transcript of the act itself.
--
-- The confirmation is NOT this printout: :expected_pending is the number the preview gave you, and
-- the function below refuses if the queue has GROWN past it. A flag asserting "I read a number"
-- that is printed one statement before the clear would have confirmed nothing.
SELECT * FROM public.preview_notification_channel_kill_clear(:'channel');

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TEMP TABLE _clear AS
  SELECT * FROM public.clear_notification_channel_kill(
    :'channel',
    :'kill_request_id'::pg_catalog.uuid,
    :'expected_pending'::pg_catalog.int,
    :'reason',
    :'request_id'::pg_catalog.uuid);

-- Every refusal is a typed verdict, already recorded as a rejected attempt on the way out — so
-- this assertion turns it into a non-zero exit without losing the evidence.
SELECT pg_temp.assert(
  (SELECT verdict FROM pg_temp._clear) OPERATOR(pg_catalog.=) 'cleared',
  'the kill was cleared (rejected_stale_kill = the live kill is not the one you named; rejected_backlog_grew = more mail queued than the preview showed you, so look again; rejected_not_killed = the channel was already live)');

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
