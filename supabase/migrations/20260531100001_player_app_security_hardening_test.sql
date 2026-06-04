-- Player app security hardening: install assertions (no data mutation).

DO $$
DECLARE
  v_policy text;
  v_expected text[] := ARRAY[
    'Players can view session reports for their bookings',
    'Players can insert their own session reports',
    'Players can update their own session reports',
    'Trainers can view session reports on their slots',
    'Trainers can insert session reports on their slots',
    'Trainers can update session reports on their slots',
    'Academy managers can view session reports on academy slots',
    'Admins can manage all session reports',
    'Players can view their own follows',
    'Players can create follows',
    'Players can delete their own follows',
    'Players can update their own follows',
    'Trainers can view their followers',
    'Users can view their own preferences',
    'Users can insert their own preferences',
    'Users can update their own preferences'
  ];
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'session_reports'
      AND c.relrowsecurity
  ) THEN
    RAISE EXCEPTION 'session_reports RLS not enabled';
  END IF;

  FOREACH v_policy IN ARRAY v_expected
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_policies
      WHERE schemaname = 'public'
        AND policyname = v_policy
    ) THEN
      RAISE EXCEPTION 'policy missing: %', v_policy;
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'session_reports'
      AND policyname = 'Players can view session reports for their bookings'
      AND cmd = 'SELECT'
      AND qual::text ILIKE '%get_profile_id_for_user%'
      AND qual::text ILIKE '%reporter_role%'
  ) THEN
    RAISE EXCEPTION 'session_reports player SELECT policy must scope by booking and trainer reports';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'trainer_followers'
      AND policyname = 'Players can update their own follows'
      AND cmd = 'UPDATE'
      AND with_check::text ILIKE '%get_profile_id_for_user%'
  ) THEN
    RAISE EXCEPTION 'trainer_followers player UPDATE must use get_profile_id_for_user WITH CHECK';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'notification_preferences'
      AND policyname = 'Users can update their own preferences'
      AND with_check IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'notification_preferences UPDATE must have WITH CHECK';
  END IF;
END $$;
