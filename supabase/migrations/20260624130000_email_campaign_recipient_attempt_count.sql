-- Bounded cross-invocation retry for email-campaign recipients.
--
-- A recipient that still fails after the in-invocation 429/network retries is marked
-- 'failed'. Without a retry budget there was no safe way to re-attempt it, and the
-- "campaign sent" summary silently hid those un-emailed people. attempt_count records how
-- many send attempts a row has had so the owner-triggered "retry failed" action (and any
-- future automated retry) can re-queue ONLY rows below the cap — never looping forever on a
-- hard bounce (e.g. an invalid address).
ALTER TABLE public.email_campaign_recipients
  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0;
