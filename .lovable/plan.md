
# Fix Academy Profiles Public View

## Problem Identified
The `academy_profiles_public` view is missing two critical columns that are needed for the academy pages to work correctly:

1. **`subscription_status`** - Needed to identify "featured" academies (those with active subscriptions)
2. **`is_public`** - Needed for the in-memory check in `getAcademyBySlug()` function

This is why "Bramos Padel Academy" and "RL Padel Performance" are:
- Not appearing in the featured section (filter fails because `subscription_status` is undefined)
- Cannot have their profiles opened (check fails because `is_public` is undefined)

## Solution
Update the `academy_profiles_public` view to include both missing columns.

---

## Database Migration

```sql
-- Fix academy_profiles_public view to include missing columns
DROP VIEW IF EXISTS academy_profiles_public;
CREATE VIEW academy_profiles_public WITH (security_invoker = on) AS
SELECT 
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
  country
FROM academy_profiles
WHERE is_public = true;
```

---

## Technical Details

| Column | Purpose |
|--------|---------|
| `is_public` | Used by `getAcademyBySlug()` in-memory check at line 224 |
| `subscription_status` | Used by `Academies.tsx` featured filter at line 53 |

### Files Affected (no code changes needed)
- `src/lib/academy.ts` - `getAcademyBySlug()` will work correctly once view is fixed
- `src/pages/Academies.tsx` - Featured filter will work correctly once view is fixed

---

## Expected Result After Fix
- "Bramos Padel Academy" and "RL Padel Performance" will appear in the featured section
- Both academy profiles will be accessible via their public URLs
- All other academies with `subscription_status = 'active'` will also appear as featured
