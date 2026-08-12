-- PRODUCTION PREFLIGHT BASELINE — READ ONLY, NON-PII, SINGLE STATEMENT.
-- Project: ficwbdrzefmblkbkomzw (Padeltrainer-production).
-- Only SELECT. Wrapped READ ONLY so any write attempt aborts. Counts/aggregates only — no names,
-- emails, phones, addresses or notes are selected. One statement, because the CLI returns only the
-- final result set.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '180s';

SELECT jsonb_pretty(jsonb_build_object(
  'db', jsonb_build_object(
    'database', current_database(),
    'pg_version', current_setting('server_version'),
    'observed_at', now()
  ),
  'persons', (SELECT jsonb_build_object(
      'total', count(*),
      'with_login', count(*) FILTER (WHERE user_id IS NOT NULL),
      'without_login', count(*) FILTER (WHERE user_id IS NULL),
      'with_email', count(*) FILTER (WHERE email IS NOT NULL AND btrim(email) <> ''),
      'with_phone', count(*) FILTER (WHERE phone IS NOT NULL AND btrim(phone) <> '')
    ) FROM public.persons),
  'sources', jsonb_build_object(
    'profiles', (SELECT count(*) FROM public.profiles),
    'guest_players', (SELECT count(*) FROM public.guest_players)
  ),
  'person_links', (SELECT jsonb_build_object(
      'total', count(*),
      'from_profile', count(*) FILTER (WHERE profile_id IS NOT NULL),
      'from_guest', count(*) FILTER (WHERE guest_player_id IS NOT NULL),
      'distinct_persons', count(DISTINCT person_id)
    ) FROM public.person_links),
  'unlinked_sources', jsonb_build_object(
    'profiles_without_link', (SELECT count(*) FROM public.profiles p
       WHERE NOT EXISTS (SELECT 1 FROM public.person_links l WHERE l.profile_id = p.id)),
    'guests_without_link', (SELECT count(*) FROM public.guest_players g
       WHERE NOT EXISTS (SELECT 1 FROM public.person_links l WHERE l.guest_player_id = g.id))
  ),
  'integrity', jsonb_build_object(
    'persons_with_multi_profile', (SELECT count(*) FROM (
       SELECT person_id FROM public.person_links WHERE profile_id IS NOT NULL
       GROUP BY person_id HAVING count(*) > 1) x),
    'links_orphaned', (SELECT count(*) FROM public.person_links l
       WHERE NOT EXISTS (SELECT 1 FROM public.persons p WHERE p.id = l.person_id)),
    'persons_without_any_link', (SELECT count(*) FROM public.persons p
       WHERE NOT EXISTS (SELECT 1 FROM public.person_links l WHERE l.person_id = p.id)),
    'guests_with_linked_profile', (SELECT count(*) FROM public.guest_players
       WHERE linked_profile_id IS NOT NULL)
  ),
  'bookings', (SELECT jsonb_build_object(
      'total', count(*),
      'with_person_id', count(*) FILTER (WHERE person_id IS NOT NULL),
      'with_guest_id', count(*) FILTER (WHERE guest_player_id IS NOT NULL),
      'with_player_id', count(*) FILTER (WHERE player_id IS NOT NULL)
    ) FROM public.bookings),
  'invoices', (SELECT jsonb_build_object(
      'total', count(*),
      'with_person_id', count(*) FILTER (WHERE person_id IS NOT NULL),
      'with_guest_id', count(*) FILTER (WHERE guest_player_id IS NOT NULL),
      'with_player_id', count(*) FILTER (WHERE player_id IS NOT NULL),
      'paid_count', count(*) FILTER (WHERE status = 'paid'),
      'null_status_count', count(*) FILTER (WHERE status IS NULL),
      'total_sum', round(coalesce(sum(total),0)::numeric, 2),
      'paid_sum', round(coalesce(sum(total) FILTER (WHERE status = 'paid'),0)::numeric, 2)
    ) FROM public.invoices),
  'large_academy', jsonb_build_object(
    'academy_profile_id', 'f5124b05-6c8b-40e4-9d67-36e2a41acd36',
    'guest_players', (SELECT count(*) FROM public.guest_players
       WHERE academy_profile_id = 'f5124b05-6c8b-40e4-9d67-36e2a41acd36'),
    'guests_linked_to_person', (SELECT count(*) FROM public.guest_players g
       WHERE g.academy_profile_id = 'f5124b05-6c8b-40e4-9d67-36e2a41acd36'
         AND EXISTS (SELECT 1 FROM public.person_links l WHERE l.guest_player_id = g.id)),
    'bookings_via_guest', (SELECT count(*) FROM public.bookings b
       WHERE b.guest_player_id IN (SELECT id FROM public.guest_players
         WHERE academy_profile_id = 'f5124b05-6c8b-40e4-9d67-36e2a41acd36')),
    'invoices', (SELECT count(*) FROM public.invoices i
       WHERE i.academy_profile_id = 'f5124b05-6c8b-40e4-9d67-36e2a41acd36'),
    'invoice_total_sum', (SELECT round(coalesce(sum(i.total),0)::numeric,2) FROM public.invoices i
       WHERE i.academy_profile_id = 'f5124b05-6c8b-40e4-9d67-36e2a41acd36')
  ),
  'tables_present', jsonb_build_object(
    'academy_player_memberships', to_regclass('public.academy_player_memberships') IS NOT NULL,
    'membership_backfill_runs', to_regclass('public.membership_backfill_runs') IS NOT NULL,
    'membership_backfill_items', to_regclass('public.membership_backfill_items') IS NOT NULL,
    'account_deletion_audit', to_regclass('public.account_deletion_audit') IS NOT NULL,
    'identity_verification_challenges', to_regclass('public.identity_verification_challenges') IS NOT NULL,
    'identity_verify_key_state', to_regclass('public.identity_verify_key_state') IS NOT NULL,
    'player_create_commands', to_regclass('public.player_create_commands') IS NOT NULL,
    'persons', to_regclass('public.persons') IS NOT NULL,
    'person_links', to_regclass('public.person_links') IS NOT NULL
  )
)) AS baseline;

COMMIT;
