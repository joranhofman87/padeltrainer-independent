-- Create trainer_followers table
CREATE TABLE public.trainer_followers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id UUID NOT NULL,
  trainer_id UUID NOT NULL,
  notify_new_availability BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (player_id, trainer_id)
);

-- Create notification_preferences table
CREATE TABLE public.notification_preferences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE,
  email_booking_confirmation BOOLEAN NOT NULL DEFAULT true,
  email_booking_reminder BOOLEAN NOT NULL DEFAULT true,
  email_new_availability BOOLEAN NOT NULL DEFAULT true,
  email_review_received BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Enable RLS on both tables
ALTER TABLE public.trainer_followers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_preferences ENABLE ROW LEVEL SECURITY;

-- RLS policies for trainer_followers
CREATE POLICY "Players can view their own follows"
ON public.trainer_followers FOR SELECT
USING (player_id IN (SELECT id FROM profiles WHERE user_id = auth.uid()));

CREATE POLICY "Players can create follows"
ON public.trainer_followers FOR INSERT
WITH CHECK (player_id IN (SELECT id FROM profiles WHERE user_id = auth.uid()));

CREATE POLICY "Players can delete their own follows"
ON public.trainer_followers FOR DELETE
USING (player_id IN (SELECT id FROM profiles WHERE user_id = auth.uid()));

CREATE POLICY "Players can update their own follows"
ON public.trainer_followers FOR UPDATE
USING (player_id IN (SELECT id FROM profiles WHERE user_id = auth.uid()));

CREATE POLICY "Trainers can view their followers"
ON public.trainer_followers FOR SELECT
USING (trainer_id IN (SELECT id FROM trainer_profiles WHERE user_id = auth.uid()));

-- RLS policies for notification_preferences
CREATE POLICY "Users can view their own preferences"
ON public.notification_preferences FOR SELECT
USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own preferences"
ON public.notification_preferences FOR INSERT
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own preferences"
ON public.notification_preferences FOR UPDATE
USING (auth.uid() = user_id);

-- Trigger for updated_at on notification_preferences
CREATE TRIGGER update_notification_preferences_updated_at
BEFORE UPDATE ON public.notification_preferences
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();