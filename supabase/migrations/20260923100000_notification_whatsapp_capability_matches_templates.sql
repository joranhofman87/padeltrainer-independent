-- Notification Foundation v2 — PR 9: make supports_whatsapp describe what we can ACTUALLY send.
--
-- The catalog claimed WhatsApp capability for five events while _shared/whatsapp-templates.ts
-- commits exactly one template (session_reminder_player). Business-initiated WhatsApp requires
-- a Meta-approved Content template, so the worker terminal-fails a row it cannot render
-- ('no_whatsapp_template'). Every consumer of that flag was therefore over-promising:
--
--   * the RESOLVER would enqueue whatsapp rows that die on the first drain;
--   * the SETTINGS page renders a WhatsApp toggle for every supports_whatsapp event, so a
--     registered user could switch it on for invoice_reminder_player or rebook_invite_player
--     and simply never receive anything;
--   * and 20260922100000 flagged three events as whatsapp_optin_via_booking, two of which had
--     no template — so a booking checkbox would have produced immediately-failing rows.
--
-- That last one contradicted this codebase's own committed plan: the template file says the
-- session reminder is the PILOT and "four more events support whatsapp; they follow once this
-- one is proven", which is the same shape as PR 5 piloting email on one low-risk notification
-- before the money path.
--
-- So capability now tracks the committed templates, and this is the ONE lever: flipping
-- supports_whatsapp back on is part of committing each template (definition + samples +
-- approval + its TWILIO_TEMPLATE_* env var), not a separate thing to remember. Pinned by a
-- cross-layer test asserting catalog capability never exceeds the committed template set.
UPDATE public.notification_event_types
SET supports_whatsapp = false
WHERE key IN (
  'booking_confirmed_player',   -- email still carries this one, and it is required_delivery
  'booking_cancelled_player',
  'invoice_reminder_player',
  'rebook_invite_player'
);

-- The pilot keeps its flag: session_reminder_player is the one event with a committed template,
-- and it is the genuinely useful WhatsApp message — a reminder about a session you booked.
UPDATE public.notification_event_types
SET whatsapp_optin_via_booking = false
WHERE key <> 'session_reminder_player';

COMMENT ON COLUMN public.notification_event_types.supports_whatsapp IS
  'Notification v2: TRUE only when a Meta-approved Content template is COMMITTED for this event in _shared/whatsapp-templates.ts. Business-initiated WhatsApp cannot render without one, so the worker terminal-fails such rows — this flag must never promise more than the template set can deliver. Flip it on as part of committing a template, and a cross-layer test enforces that.';
