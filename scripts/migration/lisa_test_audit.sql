-- Read-only audit: Lisa Test accounts (ficwb)
-- Emails: lisa-test-{player,trainer,admin,club,academy}@test.com

CREATE TEMP TABLE lisa_users (user_id uuid PRIMARY KEY, email text);
INSERT INTO lisa_users (user_id, email)
SELECT id, email FROM auth.users
WHERE email IN (
  'lisa-test-player@test.com',
  'lisa-test-trainer@test.com',
  'lisa-test-admin@test.com',
  'lisa-test-club@test.com',
  'lisa-test-academy@test.com'
);

CREATE TEMP TABLE lisa_trainer_ids (trainer_profile_id uuid PRIMARY KEY);
INSERT INTO lisa_trainer_ids
SELECT tp.id FROM public.trainer_profiles tp
JOIN lisa_users u ON tp.user_id = u.user_id;

CREATE TEMP TABLE lisa_academy_ids (academy_profile_id uuid PRIMARY KEY);
INSERT INTO lisa_academy_ids
SELECT ap.id FROM public.academy_profiles ap
JOIN lisa_users u ON ap.created_by = u.user_id;

CREATE TEMP TABLE lisa_club_ids (club_profile_id uuid PRIMARY KEY);
INSERT INTO lisa_club_ids
SELECT cp.id FROM public.club_profiles cp
JOIN lisa_users u ON cp.created_by = u.user_id;

CREATE TEMP TABLE lisa_profile_ids (profile_id uuid PRIMARY KEY);
INSERT INTO lisa_profile_ids
SELECT p.id FROM public.profiles p
JOIN lisa_users u ON p.user_id = u.user_id;

-- Section A: rows keyed by user_id (and similar uuid user columns)
SELECT 'auth.users' AS table_name, COUNT(*)::bigint AS row_count
FROM auth.users u JOIN lisa_users lu ON u.id = lu.user_id
UNION ALL
SELECT 'profiles', COUNT(*) FROM public.profiles p JOIN lisa_users lu ON p.user_id = lu.user_id
UNION ALL
SELECT 'user_roles', COUNT(*) FROM public.user_roles ur JOIN lisa_users lu ON ur.user_id = lu.user_id
UNION ALL
SELECT 'trainer_profiles', COUNT(*) FROM public.trainer_profiles tp JOIN lisa_users lu ON tp.user_id = lu.user_id
UNION ALL
SELECT 'trainer_onboarding', COUNT(*) FROM public.trainer_onboarding t JOIN lisa_users lu ON t.user_id = lu.user_id
UNION ALL
SELECT 'academy_profiles (created_by)', COUNT(*) FROM public.academy_profiles ap JOIN lisa_users lu ON ap.created_by = lu.user_id
UNION ALL
SELECT 'academy_managers', COUNT(*) FROM public.academy_managers am JOIN lisa_users lu ON am.user_id = lu.user_id
UNION ALL
SELECT 'club_profiles (created_by)', COUNT(*) FROM public.club_profiles cp JOIN lisa_users lu ON cp.created_by = lu.user_id
UNION ALL
SELECT 'club_managers', COUNT(*) FROM public.club_managers cm JOIN lisa_users lu ON cm.user_id = lu.user_id
UNION ALL
SELECT 'onboarding_email_queue', COUNT(*) FROM public.onboarding_email_queue o JOIN lisa_users lu ON o.user_id = lu.user_id
UNION ALL
SELECT 'onboarding_email_logs', COUNT(*) FROM public.onboarding_email_logs o JOIN lisa_users lu ON o.user_id = lu.user_id
UNION ALL
SELECT 'notification_preferences', COUNT(*) FROM public.notification_preferences n JOIN lisa_users lu ON n.user_id = lu.user_id
UNION ALL
SELECT 'notifications', COUNT(*) FROM public.notifications n JOIN lisa_users lu ON n.user_id = lu.user_id
UNION ALL
SELECT 'notification_queue', COUNT(*) FROM public.notification_queue n JOIN lisa_users lu ON n.user_id = lu.user_id
UNION ALL
SELECT 'banner_events', COUNT(*) FROM public.banner_events b JOIN lisa_users lu ON b.user_id = lu.user_id
UNION ALL
SELECT 'calendar_events', COUNT(*) FROM public.calendar_events c JOIN lisa_users lu ON c.user_id = lu.user_id
UNION ALL
SELECT 'mollie_oauth_states', COUNT(*) FROM public.mollie_oauth_states m JOIN lisa_users lu ON m.user_id = lu.user_id
UNION ALL
SELECT 'admin_impersonation_logs (admin)', COUNT(*) FROM public.admin_impersonation_logs a JOIN lisa_users lu ON a.admin_user_id = lu.user_id
UNION ALL
SELECT 'admin_impersonation_logs (target)', COUNT(*) FROM public.admin_impersonation_logs a JOIN lisa_users lu ON a.target_user_id = lu.user_id
UNION ALL
SELECT 'court_reviews', COUNT(*) FROM public.court_reviews c JOIN lisa_users lu ON c.user_id = lu.user_id
UNION ALL
SELECT 'rate_limits (identifier contains user)', COUNT(*) FROM public.rate_limits r
  WHERE r.identifier LIKE '%' || (SELECT user_id::text FROM lisa_users LIMIT 1) || '%'
UNION ALL
SELECT 'bookings (player_id)', COUNT(*) FROM public.bookings b JOIN lisa_users lu ON b.player_id = lu.user_id
UNION ALL
SELECT 'invoices (player_id)', COUNT(*) FROM public.invoices i JOIN lisa_users lu ON i.player_id = lu.user_id
UNION ALL
SELECT 'reviews (player_id)', COUNT(*) FROM public.reviews r JOIN lisa_users lu ON r.player_id = lu.user_id
UNION ALL
SELECT 'intake_requests (player_id)', COUNT(*) FROM public.intake_requests ir JOIN lisa_users lu ON ir.player_id = lu.user_id
UNION ALL
SELECT 'trainer_followers (player_id)', COUNT(*) FROM public.trainer_followers tf JOIN lisa_users lu ON tf.player_id = lu.user_id
UNION ALL
SELECT 'club_followers (player_id)', COUNT(*) FROM public.club_followers cf JOIN lisa_users lu ON cf.player_id = lu.user_id
UNION ALL
SELECT 'academy_followers (player_id)', COUNT(*) FROM public.academy_followers af JOIN lisa_users lu ON af.player_id = lu.user_id
UNION ALL
SELECT 'slot_priority_claims (player_id)', COUNT(*) FROM public.slot_priority_claims s JOIN lisa_users lu ON s.player_id = lu.user_id
UNION ALL
SELECT 'availability_slots (trainer_id)', COUNT(*) FROM public.availability_slots a
  JOIN lisa_trainer_ids lt ON a.trainer_id = lt.trainer_profile_id
UNION ALL
SELECT 'bookings (trainer via slot)', COUNT(*) FROM public.bookings b
  JOIN public.availability_slots a ON b.slot_id = a.id
  JOIN lisa_trainer_ids lt ON a.trainer_id = lt.trainer_profile_id
UNION ALL
SELECT 'reviews (trainer_id)', COUNT(*) FROM public.reviews r
  JOIN lisa_trainer_ids lt ON r.trainer_id = lt.trainer_profile_id
UNION ALL
SELECT 'invoices (trainer owner)', COUNT(*) FROM public.invoices i
  WHERE i.owner_type = 'trainer' AND i.owner_id IN (SELECT trainer_profile_id FROM lisa_trainer_ids)
UNION ALL
SELECT 'payment_audit_log', COUNT(*) FROM public.payment_audit_log p
  WHERE (p.user_id IN (SELECT user_id FROM lisa_users))
     OR (p.trainer_profile_id IN (SELECT trainer_profile_id FROM lisa_trainer_ids))
UNION ALL
SELECT 'payments (if exists)', (
  SELECT COUNT(*) FROM information_schema.tables t
  WHERE t.table_schema = 'public' AND t.table_name = 'payments'
)
ORDER BY table_name;
