-- N6 — PREVIEW a kill clear. Reads only; changes nothing.
--
-- Prints who killed the channel, why, how long ago, and how many pending rows would resume the
-- moment the kill is cleared. That last number is what `clear-kill` demands back as
-- --expected-pending: the confirmation has to be about a value the operator has actually seen,
-- which is why it lives in its own step rather than one statement above the clear.
\set ON_ERROR_STOP on
SET search_path = pg_catalog;

-- BOUNDED: the pending count is exact (a bound the operator confirms cannot be "at least"), so on
-- a large outbox it is a real scan. A timeout makes that fail visibly instead of hanging a runbook
-- step, and the clear recounts under its own lock anyway.
SET statement_timeout = '30s';

-- materialised ONCE: two calls could report two different numbers in the same transcript, and the
-- number is the thing the operator is about to confirm
CREATE TEMP TABLE _preview AS SELECT * FROM public.preview_notification_channel_kill_clear(:'channel');

SELECT * FROM pg_temp._preview;

SELECT pg_catalog.format('KILL_PREVIEW=%s PENDING=%s', :'channel',
         (SELECT pending_now FROM pg_temp._preview)) AS preview_marker;

DROP TABLE pg_temp._preview;
