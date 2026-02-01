
# Fix Security Definer View: academy_profiles_public

## Problem

The `academy_profiles_public` view currently has `security_invoker = off` (security definer mode), which means it bypasses RLS policies on the underlying `academy_profiles` table. This was accidentally introduced in migration `20260130115052`.

## Solution

Create a database migration to recreate the view with `security_invoker = on`.

---

## Implementation

### Database Migration

```sql
-- Drop and recreate academy_profiles_public with security_invoker enabled
DROP VIEW IF EXISTS public.academy_profiles_public;

CREATE VIEW public.academy_profiles_public
WITH (security_invoker = on)
AS
SELECT 
  id,
  name,
  slug,
  description,
  logo_url,
  website_url,
  city,
  is_public,
  created_at
FROM public.academy_profiles
WHERE is_public = true;

-- Grant access to both roles
GRANT SELECT ON public.academy_profiles_public TO anon;
GRANT SELECT ON public.academy_profiles_public TO authenticated;
```

---

## Verification

After migration, verify with:

```sql
SELECT 
  schemaname,
  viewname,
  definition
FROM pg_views 
WHERE viewname = 'academy_profiles_public';

-- Check security_invoker setting
SELECT 
  c.relname as view_name,
  CASE 
    WHEN c.reloptions @> ARRAY['security_invoker=on'] THEN 'on'
    WHEN c.reloptions @> ARRAY['security_invoker=true'] THEN 'on'
    ELSE 'off'
  END as security_invoker
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind = 'v' 
  AND n.nspname = 'public'
  AND c.relname = 'academy_profiles_public';
```

---

## Risk Assessment

| Risk | Mitigation |
|------|------------|
| View structure change | Migration preserves exact column selection |
| Permission loss | Explicit GRANT statements included |
| Downtime | View recreation is near-instant |

---

## Files Changed

| Action | File |
|--------|------|
| Create | Database migration via migration tool |

---

## Post-Migration

All 7 views will have correct security settings:

| View | Security Invoker |
|------|------------------|
| `academy_profiles_public` | ✅ on (after fix) |
| `profiles_public` | off (intentional - security boundary) |
| `profiles_safe` | ✅ on |
| `trainer_profiles_safe` | ✅ on |
| `club_profiles_public` | ✅ on |
| `club_profiles_safe` | ✅ on |
| `trainer_profiles_public` | ✅ on |
