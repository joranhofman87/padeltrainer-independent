
# Plan: Fix Academy Visibility and Verified Badge Logic

## Problem

"Hello Padel" is set to `is_public = true` but does not appear on the academies page because the database view `academy_profiles_public` requires BOTH `is_verified = true AND is_public = true`.

**Current Database View Filter:**
```sql
WHERE is_verified = true AND is_public = true
```

**Hello Padel's Current State:**
| Field | Value |
|-------|-------|
| is_public | true |
| is_verified | false |
| subscription_status | trial |

## User Requirements

1. **Visibility**: All academies should show when `is_public = true`, regardless of verified status
2. **Verified Badge**: Show checkmark when academy is claimed/verified OR has paid subscription (`is_verified = true OR subscription_status = 'active'`)

## Solution

### 1. Database Migration: Update the View

Change the `academy_profiles_public` view to only require `is_public = true`:

```sql
CREATE OR REPLACE VIEW public.academy_profiles_public AS
SELECT 
  id, name, slug, description, logo_url, banner_url, website_url,
  social_instagram, social_facebook, social_linkedin, social_youtube, social_tiktok,
  is_verified, is_public, subscription_status, subscription_tier,
  created_at, updated_at
FROM academy_profiles
WHERE is_public = true;  -- Only check is_public, not is_verified
```

### 2. Code Change: Update Badge Logic

Update both the featured cards and regular cards in `Academies.tsx` to show the verified checkmark when:
- `is_verified = true` OR 
- `subscription_status = 'active'`

**Before (lines 136-138 and 211-213):**
```tsx
{academy.is_verified && (
  <CheckCircle className="h-4 w-4 text-primary flex-shrink-0" />
)}
```

**After:**
```tsx
{(academy.is_verified || academy.subscription_status === 'active') && (
  <CheckCircle className="h-4 w-4 text-primary flex-shrink-0" />
)}
```

## File Changes

| File | Change |
|------|--------|
| Database | Update `academy_profiles_public` view to only filter by `is_public = true` |
| `src/pages/Academies.tsx` | Update verified badge condition in both card sections |

## Result

After these changes:
- Hello Padel (and any `is_public = true` academy) will appear in the directory
- The verified checkmark will show for academies that are either verified by admin OR have an active paid subscription
