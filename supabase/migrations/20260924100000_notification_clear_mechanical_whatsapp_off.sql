-- Notification Foundation v2 — PR 9: clear the MECHANICAL whatsapp 'off' values PR 8 left behind.
--
-- PR 8's settings page wrote only email_frequency. An upsert that names one column inserts a
-- row whose other column takes its COLUMN DEFAULT — and notification_preferences_v2
-- .whatsapp_frequency defaults to 'off'. So every user who touched ANY email preference under
-- PR 8 now has stored whatsapp_frequency='off' rows they never chose. There was no WhatsApp
-- control on that page at all, so those values cannot be an expression of intent.
--
-- That matters because 20260922100000 made a stored value AUTHORITATIVE: the resolver treats
-- any non-null whatsapp_frequency as an explicit preference and skips the booking-opt-in
-- derivation. Left alone, a logged-in player who once changed their reminder email cadence
-- could tick the WhatsApp box at booking, get a consent row, and still never receive a message
-- — the same "consent that cannot send" failure the cadence fix was meant to end, arriving by a
-- different route.
--
-- WHY THIS DOES NOT CONTRADICT "explicit off wins": that rule protects a CHOICE. Before PR 9
-- there was no control to make one with. Values written from here on are real choices and
-- keep winning — this is a one-shot repair of rows that predate the feature.
--
-- WHY IT GRANTS NOTHING: 'instant' only clears the FIRST gate. The second still requires an
-- opted-in, in-tenant-scope contact, and nobody has one until they opt in explicitly. A user
-- who never opts in is exactly where they were. Pinned below.
--
-- SCOPED TO THE PILOT: session_reminder_player is the only event with a committed template
-- (supports_whatsapp now means exactly that), so it is the only event where a stale 'off' can
-- block anything. When another template is committed, that event needs the same one-shot
-- consideration — there is no way to distinguish mechanical from chosen after the fact, which
-- is the real lesson.
--
-- updated_at is deliberately NOT touched: this is a data repair, not something the user did,
-- and the timestamp should not claim otherwise.
UPDATE public.notification_preferences_v2
SET whatsapp_frequency = 'instant'
WHERE event_type = 'session_reminder_player'
  AND whatsapp_frequency = 'off';
