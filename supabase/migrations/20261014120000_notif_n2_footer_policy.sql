-- N2 S1 — EXPLICIT footer/unsubscribe POLICY on the catalog, and a delivery CLASS on the
-- onboarding templates.
--
-- WHY A COLUMN AND NOT AN INFERENCE. The footer-attach layers must decide, per email, whether to
-- append a manage-preferences footer, a marketing unsubscribe (with the one-click headers), or
-- nothing. Inferring that from category/priority was reviewed and rejected: 'engagement' is a
-- PRIORITY, not a category, and a rule spread across two enum readings drifts the first time an
-- event is added. One declared column, seeded deliberately per event, read verbatim by every
-- attach layer, is the single source of truth — and a new event gets the SAFE default
-- ('manage_prefs') rather than silently inheriting marketing semantics.

ALTER TABLE public.notification_event_types
  ADD COLUMN email_footer_policy text NOT NULL DEFAULT 'manage_prefs'
    CHECK (email_footer_policy IN ('none', 'manage_prefs', 'marketing_unsubscribe'));

COMMENT ON COLUMN public.notification_event_types.email_footer_policy IS
  'What the email footer-attach layers append for this event: none (required/transactional mail carries no mutating link), manage_prefs (optional service mail: a link to the settings surface, one-click scoped to THIS event for account holders), marketing_unsubscribe (marketing mail: broad-in-scope unsubscribe + RFC 8058 one-click headers). Declared, never inferred from category/priority.';

-- Seeds BEFORE the constraint: the live catalog already carries required events, which sit on
-- the column default until this UPDATE moves them — adding the constraint first would fail the
-- migration against every real database while passing on an empty one.
UPDATE public.notification_event_types SET email_footer_policy = 'none'
 WHERE required_delivery;
UPDATE public.notification_event_types SET email_footer_policy = 'marketing_unsubscribe'
 WHERE category = 'marketing' AND NOT required_delivery;
-- everything else keeps the column default: manage_prefs.

-- Required-delivery mail must not advertise an unsubscribe it will not honour, and marketing
-- semantics on a required event would be a contradiction in terms. (manage_prefs on required is
-- also excluded in N2: the settings page renders those events control-free, so a footer implying
-- a choice would lie. Revisit deliberately if an informational footer is ever wanted.) A future
-- seed of a required event must therefore declare 'none' explicitly — loud at db:reset rather
-- than silently mutating-by-default.
ALTER TABLE public.notification_event_types
  ADD CONSTRAINT notif_event_footer_policy_coherent
    CHECK (NOT (required_delivery AND email_footer_policy <> 'none'));

-- ---------------------------------------------------------------------------
-- Onboarding templates: marketing suppression may only silence MARKETING mail, and the drip
-- table has no such notion — applying platform suppression to every template could silence a
-- service mail. The class is declared per template; the drip/welcome senders read it at send
-- time. Default 'marketing' is the honest classification of an engagement drip AND the safe
-- direction: a misclassified service template is suppressible (recoverable, visible), while a
-- misclassified marketing template would be unsuppressible (a compliance hole).
ALTER TABLE public.onboarding_email_templates
  ADD COLUMN delivery_class text NOT NULL DEFAULT 'marketing'
    CHECK (delivery_class IN ('service', 'marketing'));

COMMENT ON COLUMN public.onboarding_email_templates.delivery_class IS
  'marketing: subject to email_marketing_suppression (platform scope) + carries the unsubscribe footer/headers. service: exempt from marketing suppression (still subject to hard bounce suppression). Owner reclassifies per template; the default is the suppressible direction.';
