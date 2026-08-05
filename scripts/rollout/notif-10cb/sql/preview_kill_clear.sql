-- N6 — PREVIEW a kill clear. Reads only; changes nothing.
--
-- Prints who killed the channel, why, how long ago, and how many pending rows would resume the
-- moment the kill is cleared. That last number is what `clear-kill` demands back as
-- --expected-pending: the confirmation has to be about a value the operator has actually seen,
-- which is why it lives in its own step rather than one statement above the clear.
\set ON_ERROR_STOP on
SET search_path = pg_catalog;

SELECT * FROM public.preview_notification_channel_kill_clear(:'channel');

SELECT pg_catalog.format('KILL_PREVIEW=%s PENDING=%s%s',
         :'channel',
         (SELECT pending_now FROM public.preview_notification_channel_kill_clear(:'channel')),
         CASE WHEN (SELECT pending_now_capped FROM public.preview_notification_channel_kill_clear(:'channel'))
              THEN '+' ELSE '' END) AS preview_marker;
