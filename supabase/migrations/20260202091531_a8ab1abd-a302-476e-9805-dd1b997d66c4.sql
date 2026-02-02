-- Update profiles_public view to include phone and rating_member_id
-- This allows academy/club managers to read trainer profile data without hitting RLS restrictions

DROP VIEW IF EXISTS profiles_public;

CREATE VIEW profiles_public
WITH (security_invoker = off) AS
SELECT 
  id,
  user_id,
  full_name,
  avatar_url,
  bio,
  location,
  skill_rating,
  rating_system,
  rating_member_id,
  phone,
  created_at,
  updated_at
FROM profiles;