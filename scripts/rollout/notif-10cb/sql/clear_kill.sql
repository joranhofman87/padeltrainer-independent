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
-- SHORT and bounded: the function takes a SHARE lock on the outbox so the number the operator
-- confirmed cannot be overtaken by a concurrent enqueue. That lock is why these timeouts matter —
-- a pathological wait must fail rather than hold producers.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TEMP TABLE _clear AS
  SELECT * FROM public.clear_notification_channel_kill(
    :'channel',
    :'kill_request_id'::pg_catalog.uuid,
    :'expected_pending'::pg_catalog.int,
    :'reason',
    :'request_id'::pg_catalog.uuid);

-- COMMIT BEFORE ASSERTING. Every refusal is a typed verdict that the function has already
-- recorded as a rejected attempt and a consumed request id — and raising inside this transaction
-- would roll that evidence back, which is the exact defect this bundle fixed once already on the
-- admin RPCs. Commit the decision (whatever it was), then turn a non-'cleared' verdict into a
-- non-zero exit from outside the transaction.
COMMIT;

SELECT pg_temp.assert(
  (SELECT verdict FROM pg_temp._clear) OPERATOR(pg_catalog.=) 'cleared',
  'the kill was cleared (rejected_stale_kill = the live kill is not the one you named; rejected_backlog_grew = more mail queued than the preview showed you, so look again — the refusal names both numbers; rejected_not_killed = the channel was already live)');

-- the postconditions, read after the commit that made them true
SELECT pg_temp.assert_eq(
  (SELECT pg_catalog.count(*)::pg_catalog.int FROM public.notification_channel_kill_switches
    WHERE channel = :'channel'), 0,
  'the channel is no longer killed');
SELECT pg_temp.assert_eq(
  (SELECT pg_catalog.count(*)::pg_catalog.int FROM public.notification_admin_audit
    WHERE request_id = :'request_id'::pg_catalog.uuid AND action = 'channel_kill_cleared'), 1,
  'the clearing is audited beside the kill it cleared');

SELECT pg_catalog.format('KILL_CLEARED=%s RELEASED=%s',
         :'channel', (SELECT pending_released FROM pg_temp._clear)) AS clear_marker;

DROP TABLE pg_temp._clear;
