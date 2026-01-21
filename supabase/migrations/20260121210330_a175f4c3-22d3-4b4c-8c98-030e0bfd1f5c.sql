-- Add created_by column to track who submitted the claim
ALTER TABLE public.club_profiles 
ADD COLUMN created_by uuid REFERENCES auth.users(id);

-- Allow users to view their own pending club claims
CREATE POLICY "Users can view their own pending club claims"
ON public.club_profiles
FOR SELECT
TO authenticated
USING (created_by = auth.uid());