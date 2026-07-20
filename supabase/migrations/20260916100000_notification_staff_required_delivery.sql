-- Notification Foundation v2 — PR 6b: the paid-booking STAFF fan-out → outbox.
--
-- The staff fan-out (sendStaffBookingNotifications) is cut over to enqueue
-- booking_confirmed_staff instead of a direct send-email. To surface a staff account that
-- has NO reachable email (a manager/trainer whose persons.email is missing) as a VISIBLE
-- skipped/no_email_contact row — rather than a silent drop — booking_confirmed_staff
-- becomes REQUIRED-delivery. The resolver only writes a skipped row for a required event
-- with no deliverable channel, and the email worker's dedup'd ops alert then flags it.
--
-- CONSEQUENCE (intended): required-delivery also forces the email channel to 'instant' and
-- makes it non-mutable (a staff member cannot turn booking_confirmed_staff email OFF via
-- prefs_v2). This matches the player confirmation (also required) and the current behaviour
-- (staff already receive an immediate email per paid booking; no one has a prefs_v2 override
-- yet). A future digest/opt-out, if wanted, is a prefs_v2 (PR 8) decision. No schema change,
-- no new function — a single seed flag flip, so no generated-types drift.
UPDATE public.notification_event_types
SET required_delivery = true, updated_at = now()
WHERE key = 'booking_confirmed_staff';
