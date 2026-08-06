-- N7 — WHATSAPP READINESS. A gate that says NO by default, and explains exactly what it is
-- waiting for.
--
-- WhatsApp is a SEPARATE owner decision from email. It cannot ride on the email activation, it
-- cannot be inferred from "the pipeline works", and it has two preconditions that no amount of
-- code in this repository can satisfy: a provisioned provider with approved templates, and
-- recipients who actually consented. This file reports what the DATABASE can prove and refuses
-- while anything it can see is unmet — and it refuses even when everything it can see is met,
-- unless the operator has separately confirmed the parts it cannot see.
--
-- Read-only. It changes nothing, ever. Its output is the input to an owner decision.
\set ON_ERROR_STOP on
SET search_path = pg_catalog;

\i ../../notif-10ca3/sql/_assert.sql

-- ── what the database can prove ─────────────────────────────────────────────────────────────

-- 1. the path is still INERT. WhatsApp readiness is asked BEFORE the path is opened; if it is
--    already open, this file is not the thing that opened it and someone should say why.
SELECT pg_temp.assert(
  (SELECT state OPERATOR(pg_catalog.=) 'inert'
     FROM public.notification_activation_boundaries WHERE path = 'whatsapp:instant'),
  'the whatsapp:instant delivery path is still INERT — if it is open, WhatsApp was activated outside this gate');

-- 2. the channel is not killed (a kill would make every readiness answer moot)
SELECT pg_temp.assert_eq(
  (SELECT count(*)::pg_catalog.int4 FROM public.notification_channel_kill_switches WHERE channel = 'whatsapp'), 0,
  'the whatsapp channel is not killed');

-- 3. CONSENT EXISTS AND IS SCOPED. Every whatsapp contact that could receive anything must be
--    explicitly opted in, un-revoked, and carry a consent scope with its provenance — the same
--    shape the resolver enforces at send time. A tenant-scoped consent without provenance is the
--    failure mode this asserts against: it would be usable in the WRONG tenant's context.
SELECT 'whatsapp' AS scope, 'opted_in_contacts' AS name,
       count(*) FILTER (WHERE consent_status = 'opted_in' AND revoked_at IS NULL)::text AS value,
       ('total=' || count(*)::text
        || ' opted_out=' || count(*) FILTER (WHERE consent_status = 'opted_out')::text
        || ' unknown=' || count(*) FILTER (WHERE consent_status = 'unknown')::text
        || ' revoked=' || count(*) FILTER (WHERE revoked_at IS NOT NULL)::text) AS detail
  FROM public.notification_contacts WHERE channel = 'whatsapp';

SELECT pg_temp.assert_eq(
  (SELECT count(*)::pg_catalog.int4 FROM public.notification_contacts
    WHERE channel = 'whatsapp' AND revoked_at IS NULL
      AND consent_scope = 'tenant'
      AND consent_academy_profile_id IS NULL AND consent_trainer_id IS NULL), 0,
  'every tenant-scoped whatsapp consent names its tenant (an unscoped one would be usable in the wrong tenant''s context)');

SELECT pg_temp.assert(
  (SELECT count(*) OPERATOR(pg_catalog.>) 0 FROM public.notification_contacts
    WHERE channel = 'whatsapp' AND consent_status = 'opted_in' AND revoked_at IS NULL),
  'at least one recipient has actually opted in — activating a channel nobody consented to is the one thing consent law and this gate agree about');

-- 4. the catalogue actually supports whatsapp somewhere, and the events that do are the ones the
--    owner expects to see (printed, because "which events" is a product decision, not an assertion)
SELECT 'whatsapp' AS scope, 'events_supporting' AS name, count(*)::text AS value,
       coalesce(string_agg(key, ', ' ORDER BY key), '(none)') AS detail
  FROM public.notification_event_types WHERE supports_whatsapp;

SELECT pg_temp.assert(
  (SELECT count(*) OPERATOR(pg_catalog.>) 0 FROM public.notification_event_types WHERE supports_whatsapp),
  'at least one event supports whatsapp (otherwise opening the path would send nothing and prove nothing)');

-- 5. what would be released the moment the path opens: rows already queued on this channel. They
--    are ALL pre-boundary by definition, so the boundary will exclude them — this number is what
--    the operator must decide to dispose of rather than carry forever.
SELECT 'whatsapp' AS scope, 'queued_pre_boundary' AS name,
       count(*)::text AS value,
       'these are older than any boundary this path can be given, so they can never send — dispose via admin_dispose_pre_boundary_backlog' AS detail
  FROM public.notification_outbox WHERE channel = 'whatsapp' AND status = 'pending';

-- ── what the database CANNOT prove, and therefore refuses to assume ─────────────────────────
--
-- WHATSAPP_SEND_ENABLED, the provider account, the sender number, the Meta-approved templates and
-- the webhook are all outside this database. No SELECT can see them, and a gate that quietly
-- treated "I cannot see it" as "it is fine" would be the single most dangerous line in this
-- bundle. So the operator must state each one, and this file refuses until they have.
SELECT pg_temp.assert(
  -- compared as TEXT: an unset psql variable is the empty string, and casting that to boolean
  -- would fail with "invalid input syntax" instead of saying which gate is closed
  :'provider_confirmed' OPERATOR(pg_catalog.=) 'true',
  'BLOCKED_OWNER_WHATSAPP: --provider-confirmed is required — the provider account, sender number and webhook are outside this database and no SQL can verify them');
SELECT pg_temp.assert(
  -- compared as TEXT: an unset psql variable is the empty string, and casting that to boolean
  -- would fail with "invalid input syntax" instead of saying which gate is closed
  :'templates_confirmed' OPERATOR(pg_catalog.=) 'true',
  'BLOCKED_OWNER_WHATSAPP: --templates-confirmed is required — Meta-approved templates are outside this database, and sending without one is a provider-side rejection at best');
SELECT pg_temp.assert(
  -- compared as TEXT: an unset psql variable is the empty string, and casting that to boolean
  -- would fail with "invalid input syntax" instead of saying which gate is closed
  :'consent_confirmed' OPERATOR(pg_catalog.=) 'true',
  'BLOCKED_OWNER_WHATSAPP: --consent-confirmed is required — the counts above show what the database recorded; only the owner can confirm those opt-ins were collected the way the policy says');

SELECT 'WHATSAPP_READINESS=ok' AS whatsapp_marker;
