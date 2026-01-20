-- Create table for club trainer invitations
CREATE TABLE public.club_trainer_invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  club_profile_id UUID NOT NULL REFERENCES public.club_profiles(id) ON DELETE CASCADE,
  trainer_email TEXT NOT NULL,
  trainer_profile_id UUID REFERENCES public.trainer_profiles(id) ON DELETE CASCADE,
  invited_by UUID NOT NULL REFERENCES auth.users(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'expired', 'cancelled')),
  token UUID DEFAULT gen_random_uuid() UNIQUE NOT NULL,
  message TEXT,
  created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
  responded_at TIMESTAMPTZ,
  UNIQUE(club_profile_id, trainer_email)
);

-- Enable RLS
ALTER TABLE public.club_trainer_invitations ENABLE ROW LEVEL SECURITY;

-- Club managers can view invitations for their clubs
CREATE POLICY "Club managers can view their club invitations"
ON public.club_trainer_invitations
FOR SELECT
USING (club_profile_id IN (SELECT get_user_club_ids(auth.uid())));

-- Club managers can create invitations for their clubs
CREATE POLICY "Club managers can create invitations"
ON public.club_trainer_invitations
FOR INSERT
WITH CHECK (club_profile_id IN (SELECT get_user_club_ids(auth.uid())));

-- Club managers can update/cancel invitations for their clubs
CREATE POLICY "Club managers can update invitations"
ON public.club_trainer_invitations
FOR UPDATE
USING (club_profile_id IN (SELECT get_user_club_ids(auth.uid())));

-- Trainers can view invitations sent to their email
CREATE POLICY "Trainers can view invitations to their email"
ON public.club_trainer_invitations
FOR SELECT
USING (
  trainer_email = (SELECT email FROM public.profiles WHERE user_id = auth.uid())
  OR trainer_profile_id IN (SELECT id FROM public.trainer_profiles WHERE user_id = auth.uid())
);

-- Trainers can update (accept/decline) invitations sent to them
CREATE POLICY "Trainers can respond to their invitations"
ON public.club_trainer_invitations
FOR UPDATE
USING (
  trainer_email = (SELECT email FROM public.profiles WHERE user_id = auth.uid())
  OR trainer_profile_id IN (SELECT id FROM public.trainer_profiles WHERE user_id = auth.uid())
);

-- Create index for faster lookups
CREATE INDEX idx_club_trainer_invitations_token ON public.club_trainer_invitations(token);
CREATE INDEX idx_club_trainer_invitations_email ON public.club_trainer_invitations(trainer_email);
CREATE INDEX idx_club_trainer_invitations_status ON public.club_trainer_invitations(status);