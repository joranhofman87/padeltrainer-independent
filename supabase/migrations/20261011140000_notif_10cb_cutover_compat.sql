-- 10c-b D — CUTOVER COMPATIBILITY for state that already exists at deploy time.
--
-- The v1 -> v2 preference mirror that used to live here has MOVED into
-- 20261011100000_notif_10cb_resolver_open_slots_digest.sql, immediately before the one-time
-- backfill. Installing it here left a window: a legacy preference write landing between the
-- backfill and the trigger was recorded by neither, so that user's choice was lost. Creating the
-- trigger first, in the same transaction as the backfill, removes the window entirely — see the
-- "5b" section of that migration.

-- ===========================================================================
-- Rows enqueued BEFORE this deploy have no destination_fingerprint.
--
-- The instant worker now refuses to send when the live address no longer matches the frozen
-- fingerprint — but that comparison is written `IF destination_fingerprint IS NOT NULL`, so
-- every row queued before the fingerprint freeze skips it and could still be delivered to a
-- stale address. This affects EVERY event, not just open slots, because the worker applies the
-- policy to all instant email rows.
--
-- Backfilling from the row's own frozen destination is exactly right: it records what the
-- resolver decided at enqueue, which is the value the check needs to compare against. It cannot
-- invent authorisation — a row whose address has since changed now fingerprints differently and
-- is stopped, which is the entire point.
UPDATE public.notification_outbox
   SET destination_fingerprint = public.notif_digest_destination_fingerprint(destination_normalized)
 WHERE channel = 'email'
   AND destination_fingerprint IS NULL
   AND destination_normalized IS NOT NULL
   AND btrim(destination_normalized) <> ''
   AND status IN ('pending','processing');
