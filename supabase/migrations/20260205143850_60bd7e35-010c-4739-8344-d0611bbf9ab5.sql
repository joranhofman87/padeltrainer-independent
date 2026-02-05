-- Create waiting list entries table
CREATE TABLE public.waiting_list_entries (
    id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    owner_type TEXT NOT NULL CHECK (owner_type IN ('academy', 'trainer', 'location')),
    owner_id UUID NOT NULL,
    player_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    lesson_type TEXT NOT NULL CHECK (lesson_type IN ('private', 'duo', 'group', 'kids')),
    has_group BOOLEAN NOT NULL DEFAULT false,
    group_size INTEGER,
    rating DECIMAL,
    rating_system TEXT DEFAULT 'knltb',
    preferred_days TEXT[],
    preferred_time_windows JSONB,
    notes TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'contacted', 'archived')),
    contacted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Create index for faster lookups
CREATE INDEX idx_waiting_list_owner ON public.waiting_list_entries(owner_type, owner_id);
CREATE INDEX idx_waiting_list_player ON public.waiting_list_entries(player_id);
CREATE INDEX idx_waiting_list_status ON public.waiting_list_entries(status);

-- Enable RLS
ALTER TABLE public.waiting_list_entries ENABLE ROW LEVEL SECURITY;

-- Players can insert their own entries
CREATE POLICY "Players can insert their own entries"
ON public.waiting_list_entries
FOR INSERT
TO authenticated
WITH CHECK (auth.uid() = (SELECT user_id FROM public.profiles WHERE id = player_id));

-- Players can view their own entries
CREATE POLICY "Players can view their own entries"
ON public.waiting_list_entries
FOR SELECT
TO authenticated
USING (auth.uid() = (SELECT user_id FROM public.profiles WHERE id = player_id));

-- Players can delete their own entries
CREATE POLICY "Players can delete their own entries"
ON public.waiting_list_entries
FOR DELETE
TO authenticated
USING (auth.uid() = (SELECT user_id FROM public.profiles WHERE id = player_id));

-- Trainers can view entries for their profile
CREATE POLICY "Trainers can view entries for their profile"
ON public.waiting_list_entries
FOR SELECT
TO authenticated
USING (
    owner_type = 'trainer' AND 
    owner_id IN (SELECT id FROM public.trainer_profiles WHERE user_id = auth.uid())
);

-- Trainers can update status of entries for their profile
CREATE POLICY "Trainers can update entries for their profile"
ON public.waiting_list_entries
FOR UPDATE
TO authenticated
USING (
    owner_type = 'trainer' AND 
    owner_id IN (SELECT id FROM public.trainer_profiles WHERE user_id = auth.uid())
);

-- Academy managers can view entries for their academies
CREATE POLICY "Academy managers can view entries"
ON public.waiting_list_entries
FOR SELECT
TO authenticated
USING (
    owner_type = 'academy' AND 
    owner_id IN (SELECT public.get_user_academy_ids(auth.uid()))
);

-- Academy managers can update entries for their academies
CREATE POLICY "Academy managers can update entries"
ON public.waiting_list_entries
FOR UPDATE
TO authenticated
USING (
    owner_type = 'academy' AND 
    owner_id IN (SELECT public.get_user_academy_ids(auth.uid()))
);

-- Club managers can view entries for their locations
CREATE POLICY "Club managers can view location entries"
ON public.waiting_list_entries
FOR SELECT
TO authenticated
USING (
    owner_type = 'location' AND 
    owner_id IN (SELECT location_id FROM public.club_profiles WHERE id IN (SELECT public.get_user_club_ids(auth.uid())))
);

-- Club managers can update entries for their locations
CREATE POLICY "Club managers can update location entries"
ON public.waiting_list_entries
FOR UPDATE
TO authenticated
USING (
    owner_type = 'location' AND 
    owner_id IN (SELECT location_id FROM public.club_profiles WHERE id IN (SELECT public.get_user_club_ids(auth.uid())))
);

-- Admins can view all entries
CREATE POLICY "Admins can view all entries"
ON public.waiting_list_entries
FOR SELECT
TO authenticated
USING (public.is_admin(auth.uid()));

-- Admins can update all entries
CREATE POLICY "Admins can update all entries"
ON public.waiting_list_entries
FOR UPDATE
TO authenticated
USING (public.is_admin(auth.uid()));

-- Add trigger for updated_at
CREATE TRIGGER update_waiting_list_entries_updated_at
BEFORE UPDATE ON public.waiting_list_entries
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();