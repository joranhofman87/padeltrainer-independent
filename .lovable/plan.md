

# Plan: Fix Academy Visibility & Enhance Admin Club Editing

## Overview

Two issues need to be addressed:

1. **Academies not showing on public page**: The `getPublicAcademies()` function queries `academy_profiles` directly, but the RLS policy requires **BOTH** `is_verified = true AND is_public = true`. Since all scraped academies have `is_verified: false`, they're filtered out by RLS.

2. **Admin club editing limitations**: Admins can only edit subscription/verification settings, not full profile details like description, contact info, social links, etc.

## Root Cause Analysis

### Academy Visibility Issue

**Database state** (from query):
- All academies have `is_public: true` but `is_verified: false`
- RLS policy on `academy_profiles`:
  ```sql
  Policy: "Anyone can view verified public academies"
  Using: ((is_verified = true) AND (is_public = true))
  ```

**Current code** in `src/lib/academy.ts`:
```typescript
export async function getPublicAcademies(): Promise<AcademyProfile[]> {
  const { data, error } = await supabase
    .from('academy_profiles')
    .select('*')
    .eq('is_public', true)  // Only filters by is_public
    .order('name');
  // ...
}
```

The RLS policy is stricter than the query filter, so no results are returned.

**Solution options**:
1. Use `academy_profiles_public` view (already exists) which respects RLS
2. Modify RLS to show public academies regardless of verification
3. Auto-verify scraped academies

Recommended: Use the existing `academy_profiles_public` view for consistency with other public queries.

### Admin Club Editing

**Current state**: `ClubSubscriptionEditDialog` only edits:
- `subscription_status`
- `subscription_tier`
- `trial_ends_at`
- `is_verified`

**Missing fields**:
- `description`
- `contact_email`
- `phone`
- `logo_url`
- `banner_url`
- Social links (instagram, facebook, etc.)

## Implementation Plan

### Phase 1: Fix Academy Visibility

**File:** `src/lib/academy.ts`

Update `getPublicAcademies()` to:
1. Query `academy_profiles_public` view instead of `academy_profiles` table
2. This view already excludes PII and respects visibility rules

```typescript
// Before
.from('academy_profiles')
.select('*')
.eq('is_public', true)

// After  
.from('academy_profiles_public')
.select('*')
.order('name')
```

The view filters: `WHERE is_verified = true AND is_public = true`

**Alternative approach**: Since the admins want to see public academies even if not verified yet, we could:
- Modify RLS to allow `is_public = true` to be viewable (less strict)
- Keep current strict policy and have admins verify academies

Given the admin request to make changes easily, I recommend **keeping the strict RLS** but making it easy for admins to bulk-verify academies.

### Phase 2: Create Comprehensive Club Edit Dialog

**File:** `src/components/admin/ClubEditDialog.tsx` (NEW)

A full-featured dialog that allows admins to edit:
- All subscription fields (existing)
- Verification status (existing)
- Description
- Contact email & phone
- Logo URL
- Banner URL
- Social links

This is separate from the subscription-focused dialog to keep concerns separate.

### Phase 3: Update Admin Clubs Page

**File:** `src/pages/admin/AdminClubs.tsx`

Change dropdown menu to offer:
- "Edit Club" - Opens new comprehensive `ClubEditDialog`
- Keep other actions (View Profile, Login as Manager)

### Phase 4: Add "Bulk Verify" for Academies

**File:** `src/pages/admin/AdminAcademies.tsx`

Add a "Verify All Public" action button that:
- Sets `is_verified = true` for all academies where `is_public = true`
- Useful after scraping new academies

## File Changes Summary

| File | Action | Description |
|------|--------|-------------|
| `src/lib/academy.ts` | Modify | Use `academy_profiles_public` view for public queries |
| `src/components/admin/ClubEditDialog.tsx` | Create | Full club editing dialog with all profile fields |
| `src/pages/admin/AdminClubs.tsx` | Modify | Use new ClubEditDialog |
| `src/pages/admin/AdminAcademies.tsx` | Modify | Add "Verify All Public" bulk action |
| `src/hooks/useAdminData.ts` | Modify | Include more club fields for admin editing |

## Detailed Implementation

### ClubEditDialog Fields

```typescript
interface ClubEditData {
  // Subscription (existing)
  subscription_status: string | null;
  subscription_tier: string | null;
  trial_ends_at: string | null;
  is_verified: boolean;
  
  // Profile (new)
  description: string | null;
  contact_email: string | null;
  phone: string | null;
  logo_url: string | null;
  banner_url: string | null;
  
  // Social (new)
  social_instagram: string | null;
  social_facebook: string | null;
  social_tiktok: string | null;
  social_youtube: string | null;
  social_linkedin: string | null;
}
```

### UI Structure

The dialog will use tabs or accordion sections:
1. **Status** - Verified toggle, subscription status/tier
2. **Profile** - Description, contact info
3. **Media** - Logo/banner URLs (with preview)
4. **Social** - All social links

## Technical Notes

### RLS Considerations
- Admin update policy: `is_admin(auth.uid())` already allows admins to update any club
- No RLS changes needed

### Data Flow
1. Admin clicks "Edit Club" in dropdown
2. Full club data is fetched (or passed from list if already available)
3. Dialog shows all editable fields in organized sections
4. On save, updates `club_profiles` table directly

## Expected Outcome

1. **Academies page**: Will show all academies that are both `is_public = true` AND `is_verified = true`
2. **Admin workflow**: Admins can bulk-verify academies after scraping, then they appear publicly
3. **Club editing**: Admins can edit any club field directly without needing to impersonate

