

# Fix: Trainer Profile Page Error (profiles_public View RLS Issue)

## Problem Summary
When visiting a trainer profile page (e.g., `/en/trainer/347c5763-e2eb-4b55-b901-8369502fc605`), an error occurs because the `profiles_public` view cannot return data for anonymous users.

## Root Cause
The `profiles_public` view uses `security_invoker = on`, which means the caller's RLS policies apply. After the security hardening that removed overly permissive `SELECT` policies from the `profiles` table, anonymous users can no longer read any data from the base table - including through the "safe" public view.

The view was designed to expose only non-sensitive fields (name, avatar, bio, location), but RLS is blocking access entirely.

## Solution
Change the `profiles_public` view from `security_invoker = on` to `security_invoker = off` (security definer mode). This makes the view execute with the permissions of the table owner, bypassing RLS while still only exposing the safe, non-sensitive fields defined in the view.

This is the recommended pattern for "safe" views that intentionally hide sensitive columns - the view itself acts as the security boundary.

---

## Implementation

### Database Migration

```sql
-- Recreate profiles_public view with security_definer (invoker = off)
-- This allows anonymous access to non-sensitive fields only
-- The view itself is the security boundary - it only exposes safe columns

DROP VIEW IF EXISTS public.profiles_public;

CREATE VIEW public.profiles_public
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
  rating_member_id AS knltb_number,
  created_at,
  updated_at
FROM public.profiles;

-- Ensure both anon and authenticated roles can query the view
GRANT SELECT ON public.profiles_public TO anon;
GRANT SELECT ON public.profiles_public TO authenticated;
```

---

## Technical Details

### Why This Is Safe
1. **Column-Level Security**: The view only selects non-sensitive fields - no email, phone, or other PII
2. **Read-Only**: Views only support SELECT, so no mutation risk
3. **Explicit Design**: This view was explicitly created for public access to profile display data
4. **Standard Pattern**: Using security definer views for safe projections is a well-established PostgreSQL pattern

### Fields Exposed (Non-Sensitive)
- `id`, `user_id` - Identifiers (already in URLs)
- `full_name`, `avatar_url`, `bio`, `location` - Public display data
- `skill_rating`, `rating_system`, `knltb_number` - Player skill info (for matching)
- `created_at`, `updated_at` - Timestamps

### Fields Protected (Sensitive PII - NOT exposed)
- `email` - Contact information
- `phone` - Contact information
- Any other columns in the profiles table

---

## Files Changed
1. **Database Migration** - Recreate `profiles_public` view with `security_invoker = off`

No frontend code changes needed - the existing queries to `profiles_public` will start working again.

---

## Verification
After the migration:
1. Anonymous users can view trainer profile pages
2. The trainers list page works for anonymous users
3. The booking page displays trainer information
4. Direct queries to `profiles` table still require authentication (PII protected)

