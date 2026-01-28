-- Phase 1: Academy Layer Database Foundation

-- 1. Add 'academy' to the app_role enum
ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'academy';

-- 2. Create academy_profiles table
CREATE TABLE public.academy_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text UNIQUE NOT NULL,
  description text,
  logo_url text,
  banner_url text,
  contact_email text,
  phone text,
  website_url text,
  social_instagram text,
  social_facebook text,
  social_linkedin text,
  social_youtube text,
  social_tiktok text,
  is_verified boolean NOT NULL DEFAULT false,
  is_public boolean NOT NULL DEFAULT false,
  subscription_status text DEFAULT 'trial',
  subscription_tier text DEFAULT 'starter',
  trial_ends_at timestamptz,
  stripe_customer_id text,
  subscription_id text,
  subscription_ends_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Enable RLS on academy_profiles
ALTER TABLE public.academy_profiles ENABLE ROW LEVEL SECURITY;

-- 3. Create academy_managers table
CREATE TABLE public.academy_managers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  academy_profile_id uuid NOT NULL REFERENCES public.academy_profiles(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  role text NOT NULL DEFAULT 'manager',
  invited_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(academy_profile_id, user_id)
);

-- Enable RLS on academy_managers
ALTER TABLE public.academy_managers ENABLE ROW LEVEL SECURITY;

-- 4. Create academy_trainers table
CREATE TABLE public.academy_trainers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  academy_profile_id uuid NOT NULL REFERENCES public.academy_profiles(id) ON DELETE CASCADE,
  trainer_profile_id uuid NOT NULL REFERENCES public.trainer_profiles(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'invited',
  payment_percentage numeric NOT NULL DEFAULT 70,
  show_on_academy_page boolean NOT NULL DEFAULT true,
  invited_by uuid,
  joined_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(academy_profile_id, trainer_profile_id)
);

-- Enable RLS on academy_trainers
ALTER TABLE public.academy_trainers ENABLE ROW LEVEL SECURITY;

-- 5. Create academy_locations table
CREATE TABLE public.academy_locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  academy_profile_id uuid NOT NULL REFERENCES public.academy_profiles(id) ON DELETE CASCADE,
  location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  contract_type text DEFAULT 'non_exclusive',
  contract_start date,
  contract_end date,
  is_active boolean NOT NULL DEFAULT true,
  show_on_academy_page boolean NOT NULL DEFAULT true,
  show_on_club_page boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(academy_profile_id, location_id)
);

-- Enable RLS on academy_locations
ALTER TABLE public.academy_locations ENABLE ROW LEVEL SECURITY;

-- 6. Create academy_stripe_accounts table
CREATE TABLE public.academy_stripe_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  academy_profile_id uuid NOT NULL UNIQUE REFERENCES public.academy_profiles(id) ON DELETE CASCADE,
  stripe_account_id text NOT NULL,
  charges_enabled boolean NOT NULL DEFAULT false,
  payouts_enabled boolean NOT NULL DEFAULT false,
  onboarding_complete boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Enable RLS on academy_stripe_accounts
ALTER TABLE public.academy_stripe_accounts ENABLE ROW LEVEL SECURITY;

-- 7. Create academy_trainer_invitations table
CREATE TABLE public.academy_trainer_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  academy_profile_id uuid NOT NULL REFERENCES public.academy_profiles(id) ON DELETE CASCADE,
  trainer_email text NOT NULL,
  trainer_profile_id uuid REFERENCES public.trainer_profiles(id) ON DELETE SET NULL,
  invited_by uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  message text,
  payment_percentage numeric NOT NULL DEFAULT 70,
  token uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  responded_at timestamptz
);

-- Enable RLS on academy_trainer_invitations
ALTER TABLE public.academy_trainer_invitations ENABLE ROW LEVEL SECURITY;

-- 8. Create academy_followers table
CREATE TABLE public.academy_followers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  academy_profile_id uuid NOT NULL REFERENCES public.academy_profiles(id) ON DELETE CASCADE,
  player_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  notify_new_availability boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(academy_profile_id, player_id)
);

-- Enable RLS on academy_followers
ALTER TABLE public.academy_followers ENABLE ROW LEVEL SECURITY;

-- 9. Create academy_profile_views table
CREATE TABLE public.academy_profile_views (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  academy_profile_id uuid NOT NULL REFERENCES public.academy_profiles(id) ON DELETE CASCADE,
  session_id text,
  viewed_at timestamptz NOT NULL DEFAULT now()
);

-- Enable RLS on academy_profile_views
ALTER TABLE public.academy_profile_views ENABLE ROW LEVEL SECURITY;

-- 10. Add academy_profile_id to availability_slots for per-slot assignment
ALTER TABLE public.availability_slots 
ADD COLUMN academy_profile_id uuid REFERENCES public.academy_profiles(id) ON DELETE SET NULL;

-- 11. Create trigger for updated_at on academy tables
CREATE TRIGGER update_academy_profiles_updated_at
  BEFORE UPDATE ON public.academy_profiles
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_academy_trainers_updated_at
  BEFORE UPDATE ON public.academy_trainers
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_academy_stripe_accounts_updated_at
  BEFORE UPDATE ON public.academy_stripe_accounts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 12. Create trigger for academy trial (similar to club trial)
CREATE OR REPLACE FUNCTION public.set_academy_trial()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  NEW.subscription_status := 'trial';
  NEW.subscription_tier := 'starter';
  NEW.trial_ends_at := NOW() + interval '14 days';
  RETURN NEW;
END;
$$;

CREATE TRIGGER set_academy_trial_trigger
  BEFORE INSERT ON public.academy_profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_academy_trial();

-- 13. Create helper functions (SECURITY DEFINER to avoid RLS recursion)

-- Check if user is an academy manager
CREATE OR REPLACE FUNCTION public.is_academy_manager(_user_id uuid, _academy_profile_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.academy_managers
    WHERE user_id = _user_id
      AND academy_profile_id = _academy_profile_id
  )
$$;

-- Check if user is any academy manager
CREATE OR REPLACE FUNCTION public.is_any_academy_manager(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.academy_managers
    WHERE user_id = _user_id
  )
$$;

-- Get user's academy IDs
CREATE OR REPLACE FUNCTION public.get_user_academy_ids(_user_id uuid)
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT academy_profile_id
  FROM public.academy_managers
  WHERE user_id = _user_id
$$;

-- Check if user is academy owner
CREATE OR REPLACE FUNCTION public.is_academy_owner(_user_id uuid, _academy_profile_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.academy_managers
    WHERE user_id = _user_id
      AND academy_profile_id = _academy_profile_id
      AND role = 'owner'
  )
$$;

-- Check if academy has managers
CREATE OR REPLACE FUNCTION public.academy_has_managers(_academy_profile_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.academy_managers
    WHERE academy_profile_id = _academy_profile_id
  )
$$;

-- 14. RLS Policies for academy_profiles

-- Anyone can view verified, public academies
CREATE POLICY "Anyone can view verified public academies"
  ON public.academy_profiles FOR SELECT
  USING (is_verified = true AND is_public = true);

-- Academy managers can view their own academy
CREATE POLICY "Academy managers can view their academy"
  ON public.academy_profiles FOR SELECT
  USING (id IN (SELECT get_user_academy_ids(auth.uid())));

-- Admins can view all academies
CREATE POLICY "Admins can view all academies"
  ON public.academy_profiles FOR SELECT
  USING (is_admin(auth.uid()));

-- Users can view their own pending academy claims
CREATE POLICY "Users can view their own pending academies"
  ON public.academy_profiles FOR SELECT
  USING (created_by = auth.uid());

-- Authenticated users can create academies
CREATE POLICY "Authenticated users can create academies"
  ON public.academy_profiles FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);

-- Academy managers can update their academy
CREATE POLICY "Academy managers can update their academy"
  ON public.academy_profiles FOR UPDATE
  USING (id IN (SELECT get_user_academy_ids(auth.uid())));

-- Admins can update any academy
CREATE POLICY "Admins can update any academy"
  ON public.academy_profiles FOR UPDATE
  USING (is_admin(auth.uid()));

-- 15. RLS Policies for academy_managers

-- Academy managers can view their academy's managers
CREATE POLICY "Academy managers can view their managers"
  ON public.academy_managers FOR SELECT
  USING (academy_profile_id IN (SELECT get_user_academy_ids(auth.uid())));

-- Admins can view all academy managers
CREATE POLICY "Admins can view all academy managers"
  ON public.academy_managers FOR SELECT
  USING (is_admin(auth.uid()));

-- Academy owners can add managers (or first manager if none exist)
CREATE POLICY "Academy owners can add managers"
  ON public.academy_managers FOR INSERT
  WITH CHECK (is_academy_owner(auth.uid(), academy_profile_id) OR NOT academy_has_managers(academy_profile_id));

-- Academy owners can update managers
CREATE POLICY "Academy owners can update managers"
  ON public.academy_managers FOR UPDATE
  USING (is_academy_owner(auth.uid(), academy_profile_id));

-- Academy owners can delete managers
CREATE POLICY "Academy owners can delete managers"
  ON public.academy_managers FOR DELETE
  USING (is_academy_owner(auth.uid(), academy_profile_id));

-- 16. RLS Policies for academy_trainers

-- Academy managers can view their academy trainers
CREATE POLICY "Academy managers can view their trainers"
  ON public.academy_trainers FOR SELECT
  USING (academy_profile_id IN (SELECT get_user_academy_ids(auth.uid())));

-- Trainers can view their own academy memberships
CREATE POLICY "Trainers can view their academy memberships"
  ON public.academy_trainers FOR SELECT
  USING (trainer_profile_id IN (SELECT id FROM trainer_profiles WHERE user_id = auth.uid()));

-- Public can view active trainers on public academy pages
CREATE POLICY "Public can view active academy trainers"
  ON public.academy_trainers FOR SELECT
  USING (
    status = 'active' 
    AND show_on_academy_page = true 
    AND academy_profile_id IN (
      SELECT id FROM academy_profiles WHERE is_verified = true AND is_public = true
    )
  );

-- Academy managers can create trainer records
CREATE POLICY "Academy managers can create trainer records"
  ON public.academy_trainers FOR INSERT
  WITH CHECK (academy_profile_id IN (SELECT get_user_academy_ids(auth.uid())));

-- Academy managers can update trainer records
CREATE POLICY "Academy managers can update trainer records"
  ON public.academy_trainers FOR UPDATE
  USING (academy_profile_id IN (SELECT get_user_academy_ids(auth.uid())));

-- Trainers can update their own records (to accept/decline)
CREATE POLICY "Trainers can update their own academy records"
  ON public.academy_trainers FOR UPDATE
  USING (trainer_profile_id IN (SELECT id FROM trainer_profiles WHERE user_id = auth.uid()));

-- Academy managers can delete trainer records
CREATE POLICY "Academy managers can delete trainer records"
  ON public.academy_trainers FOR DELETE
  USING (academy_profile_id IN (SELECT get_user_academy_ids(auth.uid())));

-- 17. RLS Policies for academy_locations

-- Academy managers can view their locations
CREATE POLICY "Academy managers can view their locations"
  ON public.academy_locations FOR SELECT
  USING (academy_profile_id IN (SELECT get_user_academy_ids(auth.uid())));

-- Public can view active locations on public academy pages
CREATE POLICY "Public can view active academy locations for academy pages"
  ON public.academy_locations FOR SELECT
  USING (
    is_active = true 
    AND show_on_academy_page = true 
    AND academy_profile_id IN (
      SELECT id FROM academy_profiles WHERE is_verified = true AND is_public = true
    )
  );

-- Public can view active locations for club pages
CREATE POLICY "Public can view academy locations for club pages"
  ON public.academy_locations FOR SELECT
  USING (is_active = true AND show_on_club_page = true);

-- Academy managers can create locations
CREATE POLICY "Academy managers can create locations"
  ON public.academy_locations FOR INSERT
  WITH CHECK (academy_profile_id IN (SELECT get_user_academy_ids(auth.uid())));

-- Academy managers can update locations
CREATE POLICY "Academy managers can update locations"
  ON public.academy_locations FOR UPDATE
  USING (academy_profile_id IN (SELECT get_user_academy_ids(auth.uid())));

-- Academy managers can delete locations
CREATE POLICY "Academy managers can delete locations"
  ON public.academy_locations FOR DELETE
  USING (academy_profile_id IN (SELECT get_user_academy_ids(auth.uid())));

-- 18. RLS Policies for academy_stripe_accounts

-- Academy managers can view their stripe account
CREATE POLICY "Academy managers can view their stripe account"
  ON public.academy_stripe_accounts FOR SELECT
  USING (academy_profile_id IN (SELECT get_user_academy_ids(auth.uid())));

-- Academy managers can insert their stripe account
CREATE POLICY "Academy managers can insert their stripe account"
  ON public.academy_stripe_accounts FOR INSERT
  WITH CHECK (academy_profile_id IN (SELECT get_user_academy_ids(auth.uid())));

-- Academy managers can update their stripe account
CREATE POLICY "Academy managers can update their stripe account"
  ON public.academy_stripe_accounts FOR UPDATE
  USING (academy_profile_id IN (SELECT get_user_academy_ids(auth.uid())));

-- 19. RLS Policies for academy_trainer_invitations

-- Academy managers can view their invitations
CREATE POLICY "Academy managers can view their invitations"
  ON public.academy_trainer_invitations FOR SELECT
  USING (academy_profile_id IN (SELECT get_user_academy_ids(auth.uid())));

-- Trainers can view invitations to their email
CREATE POLICY "Trainers can view their invitations"
  ON public.academy_trainer_invitations FOR SELECT
  USING (
    trainer_email = (SELECT email FROM profiles WHERE user_id = auth.uid())
    OR trainer_profile_id IN (SELECT id FROM trainer_profiles WHERE user_id = auth.uid())
  );

-- Academy managers can create invitations
CREATE POLICY "Academy managers can create invitations"
  ON public.academy_trainer_invitations FOR INSERT
  WITH CHECK (academy_profile_id IN (SELECT get_user_academy_ids(auth.uid())));

-- Academy managers can update invitations
CREATE POLICY "Academy managers can update invitations"
  ON public.academy_trainer_invitations FOR UPDATE
  USING (academy_profile_id IN (SELECT get_user_academy_ids(auth.uid())));

-- Trainers can update their invitations (to respond)
CREATE POLICY "Trainers can respond to their invitations"
  ON public.academy_trainer_invitations FOR UPDATE
  USING (
    trainer_email = (SELECT email FROM profiles WHERE user_id = auth.uid())
    OR trainer_profile_id IN (SELECT id FROM trainer_profiles WHERE user_id = auth.uid())
  );

-- 20. RLS Policies for academy_followers

-- Players can view their academy follows
CREATE POLICY "Players can view their academy follows"
  ON public.academy_followers FOR SELECT
  USING (player_id IN (SELECT id FROM profiles WHERE user_id = auth.uid()));

-- Academy managers can view their followers
CREATE POLICY "Academy managers can view their followers"
  ON public.academy_followers FOR SELECT
  USING (academy_profile_id IN (SELECT get_user_academy_ids(auth.uid())));

-- Players can create academy follows
CREATE POLICY "Players can create academy follows"
  ON public.academy_followers FOR INSERT
  WITH CHECK (player_id IN (SELECT id FROM profiles WHERE user_id = auth.uid()));

-- Players can delete academy follows
CREATE POLICY "Players can delete academy follows"
  ON public.academy_followers FOR DELETE
  USING (player_id IN (SELECT id FROM profiles WHERE user_id = auth.uid()));

-- 21. RLS Policies for academy_profile_views

-- Anyone can record academy profile views
CREATE POLICY "Anyone can record academy profile views"
  ON public.academy_profile_views FOR INSERT
  WITH CHECK (true);

-- Academy managers can view their profile views
CREATE POLICY "Academy managers can view their profile views"
  ON public.academy_profile_views FOR SELECT
  USING (academy_profile_id IN (SELECT get_user_academy_ids(auth.uid())));

-- 22. Create secure views for public access

-- academy_profiles_public - excludes PII
CREATE OR REPLACE VIEW public.academy_profiles_public
WITH (security_invoker = on)
AS SELECT
  id,
  name,
  slug,
  description,
  logo_url,
  banner_url,
  website_url,
  social_instagram,
  social_facebook,
  social_linkedin,
  social_youtube,
  social_tiktok,
  is_verified,
  is_public,
  subscription_status,
  subscription_tier,
  created_at,
  updated_at
FROM public.academy_profiles
WHERE is_verified = true AND is_public = true;

-- Grant access to the view
GRANT SELECT ON public.academy_profiles_public TO anon, authenticated;

-- academy_profiles_safe - for discovery queries (excludes billing info)
CREATE OR REPLACE VIEW public.academy_profiles_safe
WITH (security_invoker = on)
AS SELECT
  id,
  name,
  slug,
  description,
  logo_url,
  banner_url,
  website_url,
  social_instagram,
  social_facebook,
  social_linkedin,
  social_youtube,
  social_tiktok,
  is_verified,
  is_public,
  created_at,
  updated_at
FROM public.academy_profiles;

-- Grant access to the safe view
GRANT SELECT ON public.academy_profiles_safe TO anon, authenticated;

-- 23. Create index for slug lookups
CREATE INDEX idx_academy_profiles_slug ON public.academy_profiles(slug);

-- 24. Create index for academy_profile_id on availability_slots
CREATE INDEX idx_availability_slots_academy ON public.availability_slots(academy_profile_id);

-- 25. Update availability_slots RLS to allow academy-based slot creation
CREATE POLICY "Academy managers can create slots for their trainers"
  ON public.availability_slots FOR INSERT
  WITH CHECK (
    academy_profile_id IN (SELECT get_user_academy_ids(auth.uid()))
    AND trainer_id IN (
      SELECT trainer_profile_id FROM academy_trainers 
      WHERE academy_profile_id = availability_slots.academy_profile_id 
      AND status = 'active'
    )
  );

CREATE POLICY "Academy managers can update slots for their trainers"
  ON public.availability_slots FOR UPDATE
  USING (
    academy_profile_id IN (SELECT get_user_academy_ids(auth.uid()))
  );

CREATE POLICY "Academy managers can delete slots for their trainers"
  ON public.availability_slots FOR DELETE
  USING (
    academy_profile_id IN (SELECT get_user_academy_ids(auth.uid()))
  );