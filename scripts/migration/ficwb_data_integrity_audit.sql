-- ficwb data integrity audit (read-only) — no psql meta-commands

-- AUTH & ROLES
SELECT 'users_no_role' AS check_id, COUNT(*)::bigint AS cnt FROM auth.users u
WHERE NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = u.id);

SELECT 'users_multi_roles' AS check_id, COUNT(*)::bigint AS cnt FROM (
  SELECT user_id FROM public.user_roles GROUP BY user_id HAVING COUNT(DISTINCT role) > 1
) t;

SELECT 'academy_role_no_manager_row' AS check_id, COUNT(*)::bigint AS cnt FROM public.user_roles ur
WHERE ur.role = 'academy' AND NOT EXISTS (SELECT 1 FROM public.academy_managers am WHERE am.user_id = ur.user_id);

SELECT 'academy_manager_missing_academy' AS check_id, COUNT(*)::bigint AS cnt FROM public.academy_managers am
LEFT JOIN public.academy_profiles ap ON ap.id = am.academy_profile_id WHERE ap.id IS NULL;

SELECT 'club_role_no_manager_row' AS check_id, COUNT(*)::bigint AS cnt FROM public.user_roles ur
WHERE ur.role IN ('club','club_manager') AND NOT EXISTS (SELECT 1 FROM public.club_managers cm WHERE cm.user_id = ur.user_id);

SELECT 'trainer_role_no_profile' AS check_id, COUNT(*)::bigint AS cnt FROM public.user_roles ur
WHERE ur.role = 'trainer' AND NOT EXISTS (SELECT 1 FROM public.trainer_profiles tp WHERE tp.user_id = ur.user_id);

SELECT 'trainer_profile_no_role' AS check_id, COUNT(*)::bigint AS cnt FROM public.trainer_profiles tp
WHERE NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = tp.user_id AND ur.role = 'trainer');

-- ONBOARDING
SELECT 'trainers_no_onboarding' AS check_id, COUNT(*)::bigint AS cnt FROM public.trainer_profiles tp
WHERE NOT EXISTS (SELECT 1 FROM public.trainer_onboarding tob WHERE tob.user_id = tp.user_id);

SELECT 'onboarding_orphan_user' AS check_id, COUNT(*)::bigint AS cnt FROM public.trainer_onboarding tob
WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = tob.user_id);

SELECT 'onboarding_done_no_slug' AS check_id, COUNT(*)::bigint AS cnt FROM public.trainer_onboarding tob
JOIN public.trainer_profiles tp ON tp.user_id = tob.user_id
WHERE tob.completed_at IS NOT NULL AND (tp.slug IS NULL OR btrim(tp.slug) = '');

-- PAYMENTS
SELECT 'trainer_active_no_stripe' AS check_id, COUNT(*)::bigint AS cnt FROM public.trainer_profiles tp
WHERE tp.subscription_status = 'active' AND COALESCE(tp.stripe_customer_id, '') = '';

SELECT 'trainer_trial_past_end' AS check_id, COUNT(*)::bigint AS cnt FROM public.trainer_profiles tp
WHERE tp.subscription_status = 'trial' AND tp.trial_ends_at IS NOT NULL AND tp.trial_ends_at < NOW();

SELECT 'dup_stripe_customer_trainers' AS check_id, COUNT(*)::bigint AS cnt FROM (
  SELECT stripe_customer_id FROM public.trainer_profiles WHERE COALESCE(stripe_customer_id,'') <> ''
  GROUP BY stripe_customer_id HAVING COUNT(*) > 1
) d;

SELECT 'dup_stripe_customer_academies' AS check_id, COUNT(*)::bigint AS cnt FROM (
  SELECT stripe_customer_id FROM public.academy_profiles WHERE COALESCE(stripe_customer_id,'') <> ''
  GROUP BY stripe_customer_id HAVING COUNT(*) > 1
) d;

-- BOOKINGS
SELECT 'bookings_no_player_guest' AS check_id, COUNT(*)::bigint AS cnt FROM public.bookings b
WHERE b.player_id IS NULL AND b.guest_player_id IS NULL;

SELECT 'bookings_missing_player_profile' AS check_id, COUNT(*)::bigint AS cnt FROM public.bookings b
WHERE b.player_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = b.player_id);

SELECT 'bookings_missing_slot' AS check_id, COUNT(*)::bigint AS cnt FROM public.bookings b
WHERE NOT EXISTS (SELECT 1 FROM public.availability_slots s WHERE s.id = b.slot_id);

SELECT 'bookings_bad_payment_status' AS check_id, COUNT(*)::bigint AS cnt FROM public.bookings b
WHERE b.payment_status NOT IN ('pending','paid','failed','canceled','cancelled','expired','refunded');

SELECT 'paid_booking_no_invoice' AS check_id, COUNT(*)::bigint AS cnt FROM public.bookings b
WHERE b.payment_status = 'paid' AND NOT EXISTS (
  SELECT 1 FROM public.invoices i WHERE i.booking_ids @> ARRAY[b.id]::uuid[] AND i.status <> 'cancelled'
);

SELECT 'invoice_orphan_booking_id' AS check_id, COUNT(*)::bigint AS cnt FROM (
  SELECT bid.booking_id FROM public.invoices i
  CROSS JOIN LATERAL unnest(COALESCE(i.booking_ids, ARRAY[]::uuid[])) AS bid(booking_id)
  LEFT JOIN public.bookings b ON b.id = bid.booking_id WHERE b.id IS NULL
) x;

-- INVOICES
SELECT 'invoice_missing_player' AS check_id, COUNT(*)::bigint AS cnt FROM public.invoices i
WHERE i.player_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = i.player_id);

SELECT 'invoice_missing_trainer' AS check_id, COUNT(*)::bigint AS cnt FROM public.invoices i
WHERE i.trainer_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.trainer_profiles tp WHERE tp.id = i.trainer_id);

SELECT 'invoice_negative_amounts' AS check_id, COUNT(*)::bigint AS cnt FROM public.invoices i
WHERE i.total < 0 OR i.subtotal < 0;

SELECT 'invoice_paid_no_paid_at' AS check_id, COUNT(*)::bigint AS cnt FROM public.invoices i
WHERE i.status = 'paid' AND i.paid_at IS NULL;

SELECT 'invoice_unpaid_has_paid_at' AS check_id, COUNT(*)::bigint AS cnt FROM public.invoices i
WHERE i.status NOT IN ('paid','cancelled') AND i.paid_at IS NOT NULL;

SELECT 'invoice_dup_booking_set' AS check_id, COUNT(*)::bigint AS cnt FROM (
  SELECT 1 FROM public.invoices WHERE status <> 'cancelled' AND booking_ids IS NOT NULL AND cardinality(booking_ids) > 0
  GROUP BY trainer_id, player_id, guest_player_id, booking_ids HAVING COUNT(*) > 1
) d;

-- AVAILABILITY
SELECT 'slot_end_before_start' AS check_id, COUNT(*)::bigint AS cnt FROM public.availability_slots s
WHERE s.end_time <= s.start_time;

SELECT 'slot_missing_trainer' AS check_id, COUNT(*)::bigint AS cnt FROM public.availability_slots s
WHERE NOT EXISTS (SELECT 1 FROM public.trainer_profiles tp WHERE tp.id = s.trainer_id);

SELECT 'slot_past_still_public' AS check_id, COUNT(*)::bigint AS cnt FROM public.availability_slots s
WHERE s.end_time < NOW() AND s.is_public = true;

SELECT 'slot_overbooked' AS check_id, COUNT(*)::bigint AS cnt FROM (
  SELECT s.id FROM public.availability_slots s
  JOIN public.bookings b ON b.slot_id = s.id AND b.status NOT IN ('cancelled','canceled')
  GROUP BY s.id, s.max_participants
  HAVING COUNT(*) > COALESCE(NULLIF(s.max_participants, 0), 4)
) o;

SELECT 'duplicate_player_slot_booking' AS check_id, COUNT(*)::bigint AS cnt FROM (
  SELECT b.slot_id, COALESCE(b.player_id, b.guest_player_id) AS pid FROM public.bookings b
  WHERE b.status NOT IN ('cancelled','canceled') AND COALESCE(b.player_id, b.guest_player_id) IS NOT NULL
  GROUP BY b.slot_id, COALESCE(b.player_id, b.guest_player_id) HAVING COUNT(*) > 1
) d;

-- ACADEMIES & CLUBS
SELECT 'academy_no_managers' AS check_id, COUNT(*)::bigint AS cnt FROM public.academy_profiles ap
WHERE NOT EXISTS (SELECT 1 FROM public.academy_managers am WHERE am.academy_profile_id = ap.id);

SELECT 'academy_trainers_orphan_trainer' AS check_id, COUNT(*)::bigint AS cnt FROM public.academy_trainers at
WHERE NOT EXISTS (SELECT 1 FROM public.trainer_profiles tp WHERE tp.id = at.trainer_profile_id);

SELECT 'academy_trainers_orphan_academy' AS check_id, COUNT(*)::bigint AS cnt FROM public.academy_trainers at
WHERE NOT EXISTS (SELECT 1 FROM public.academy_profiles ap WHERE ap.id = at.academy_profile_id);

SELECT 'trainer_locations_orphan_trainer' AS check_id, COUNT(*)::bigint AS cnt FROM public.trainer_locations tl
WHERE NOT EXISTS (SELECT 1 FROM public.trainer_profiles tp WHERE tp.id = tl.trainer_id);

SELECT 'trainer_locations_orphan_location' AS check_id, COUNT(*)::bigint AS cnt FROM public.trainer_locations tl
WHERE NOT EXISTS (SELECT 1 FROM public.locations l WHERE l.id = tl.location_id);

SELECT 'club_no_managers' AS check_id, COUNT(*)::bigint AS cnt FROM public.club_profiles cp
WHERE NOT EXISTS (SELECT 1 FROM public.club_managers cm WHERE cm.club_profile_id = cp.id);

-- EMAIL
SELECT 'onboarding_queue_orphan_user' AS check_id, COUNT(*)::bigint AS cnt FROM public.onboarding_email_queue q
WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = q.user_id);

SELECT 'onboarding_queue_failed' AS check_id, COUNT(*)::bigint AS cnt FROM public.onboarding_email_queue q WHERE q.status = 'failed';

SELECT 'onboarding_queue_pending_old' AS check_id, COUNT(*)::bigint AS cnt FROM public.onboarding_email_queue q
WHERE q.status = 'pending' AND q.scheduled_for < NOW() - INTERVAL '7 days';

SELECT 'notification_queue_orphan_user' AS check_id, COUNT(*)::bigint AS cnt FROM public.notification_queue nq
WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = nq.user_id);

SELECT 'notifications_orphan_user' AS check_id, COUNT(*)::bigint AS cnt FROM public.notifications n
WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = n.user_id);

-- EXTRA
SELECT 'slot_overlap_same_trainer' AS check_id, COUNT(*)::bigint AS cnt FROM (
  SELECT a.id FROM public.availability_slots a
  JOIN public.availability_slots b ON a.trainer_id = b.trainer_id AND a.id < b.id
    AND a.start_time < b.end_time AND b.start_time < a.end_time
) x;

SELECT 'invoice_line_total_mismatch' AS check_id, COUNT(*)::bigint AS cnt FROM public.invoices i
WHERE i.line_items IS NOT NULL AND jsonb_typeof(i.line_items) = 'array'
  AND ABS(
    i.total - COALESCE((
      SELECT SUM((elem->>'amount')::numeric)
      FROM jsonb_array_elements(i.line_items) elem
      WHERE elem ? 'amount'
    ), i.total)
  ) > 0.02;

SELECT 'profiles_orphan_user' AS check_id, COUNT(*)::bigint AS cnt FROM public.profiles p
WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = p.user_id);

SELECT 'auth_user_no_profile' AS check_id, COUNT(*)::bigint AS cnt FROM auth.users u
WHERE NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.user_id = u.id);
