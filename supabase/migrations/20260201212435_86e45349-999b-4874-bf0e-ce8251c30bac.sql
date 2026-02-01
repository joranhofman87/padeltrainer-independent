-- Create is_any_academy_manager function to check if user manages any academy
CREATE OR REPLACE FUNCTION public.is_any_academy_manager(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.academy_managers
    WHERE user_id = _user_id
  );
$$;

-- Create location_requests table for location submissions awaiting admin approval
CREATE TABLE public.location_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  city TEXT NOT NULL,
  country TEXT NOT NULL DEFAULT 'NL',
  street_address TEXT,
  postal_code TEXT,
  website_url TEXT,
  phone TEXT,
  email TEXT,
  requested_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  request_context TEXT NOT NULL DEFAULT 'academy', -- 'academy', 'trainer', 'club'
  context_id UUID, -- e.g., academy_profile_id if from academy
  status TEXT NOT NULL DEFAULT 'pending', -- pending, approved, rejected
  reviewed_by UUID REFERENCES auth.users(id),
  reviewed_at TIMESTAMPTZ,
  rejection_reason TEXT,
  created_location_id UUID REFERENCES public.locations(id),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.location_requests ENABLE ROW LEVEL SECURITY;

-- Users can create location requests
CREATE POLICY "Users can create location requests"
ON public.location_requests
FOR INSERT
TO authenticated
WITH CHECK (auth.uid() = requested_by);

-- Users can view their own requests
CREATE POLICY "Users can view own location requests"
ON public.location_requests
FOR SELECT
TO authenticated
USING (auth.uid() = requested_by);

-- Admins can view all location requests
CREATE POLICY "Admins can view all location requests"
ON public.location_requests
FOR SELECT
TO authenticated
USING (public.is_admin(auth.uid()));

-- Admins can update location requests (approve/reject)
CREATE POLICY "Admins can update location requests"
ON public.location_requests
FOR UPDATE
TO authenticated
USING (public.is_admin(auth.uid()));

-- Admins can delete location requests
CREATE POLICY "Admins can delete location requests"
ON public.location_requests
FOR DELETE
TO authenticated
USING (public.is_admin(auth.uid()));

-- Create updated_at trigger
CREATE TRIGGER update_location_requests_updated_at
BEFORE UPDATE ON public.location_requests
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();