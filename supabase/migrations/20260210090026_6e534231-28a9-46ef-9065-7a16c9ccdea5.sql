
-- Drop old boolean columns from notification_preferences and add frequency-based columns
ALTER TABLE public.notification_preferences
  DROP COLUMN IF EXISTS email_booking_confirmation,
  DROP COLUMN IF EXISTS email_booking_reminder,
  DROP COLUMN IF EXISTS email_new_availability,
  DROP COLUMN IF EXISTS email_review_received;

-- Add player notification columns
ALTER TABLE public.notification_preferences
  ADD COLUMN booking_confirmation text NOT NULL DEFAULT 'instant',
  ADD COLUMN booking_reminder text NOT NULL DEFAULT 'instant',
  ADD COLUMN open_slots_digest text NOT NULL DEFAULT 'weekly',
  ADD COLUMN upcoming_sessions_digest text NOT NULL DEFAULT 'daily',
  ADD COLUMN payment_receipt text NOT NULL DEFAULT 'instant',
  ADD COLUMN waitlist_update text NOT NULL DEFAULT 'instant';

-- Add trainer/academy notification columns
ALTER TABLE public.notification_preferences
  ADD COLUMN new_booking text NOT NULL DEFAULT 'instant',
  ADD COLUMN booking_cancelled text NOT NULL DEFAULT 'instant',
  ADD COLUMN new_follower text NOT NULL DEFAULT 'daily',
  ADD COLUMN new_player text NOT NULL DEFAULT 'daily',
  ADD COLUMN new_registration text NOT NULL DEFAULT 'instant',
  ADD COLUMN new_review text NOT NULL DEFAULT 'instant',
  ADD COLUMN upcoming_schedule_digest text NOT NULL DEFAULT 'daily',
  ADD COLUMN payment_received text NOT NULL DEFAULT 'instant';

-- Validation trigger for frequency values
CREATE OR REPLACE FUNCTION public.validate_notification_frequency()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  col text;
  val text;
  freq_columns text[] := ARRAY[
    'booking_confirmation', 'booking_reminder', 'open_slots_digest',
    'upcoming_sessions_digest', 'payment_receipt', 'waitlist_update',
    'new_booking', 'booking_cancelled', 'new_follower', 'new_player',
    'new_registration', 'new_review', 'upcoming_schedule_digest', 'payment_received'
  ];
BEGIN
  FOREACH col IN ARRAY freq_columns LOOP
    EXECUTE format('SELECT ($1).%I', col) INTO val USING NEW;
    IF val IS NOT NULL AND val NOT IN ('instant', 'daily', 'weekly', 'off') THEN
      RAISE EXCEPTION 'Invalid frequency value "%" for column "%". Must be instant, daily, weekly, or off.', val, col;
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

CREATE TRIGGER validate_notification_prefs_frequency
  BEFORE INSERT OR UPDATE ON public.notification_preferences
  FOR EACH ROW
  EXECUTE FUNCTION public.validate_notification_frequency();

-- Create notification_queue table
CREATE TABLE public.notification_queue (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL,
  notification_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  scheduled_for text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz NULL
);

-- Enable RLS on notification_queue
ALTER TABLE public.notification_queue ENABLE ROW LEVEL SECURITY;

-- No user-facing policies on notification_queue (service role only)
-- Index for efficient digest queries
CREATE INDEX idx_notification_queue_pending ON public.notification_queue (scheduled_for, processed_at) WHERE processed_at IS NULL;
CREATE INDEX idx_notification_queue_user ON public.notification_queue (user_id);
