

# Plan: Enhanced Admin Editing & User Impersonation

## Overview

Add comprehensive admin editing capabilities across all entity types (Clubs, Academies, Locations, Trainers) with quick-action buttons for viewing profiles and logging in as users.

## Current State Analysis

### What Already Exists
- **User impersonation**: `impersonate-user` edge function generates magic links for admin login-as-user
- **Subscription editing**: Dialogs exist for Clubs, Academies, and Trainers but with limited fields
- **Location editing**: Full edit form exists inline in `AdminLocations.tsx`
- **User editing**: Full CRUD in `AdminUsers.tsx` (edit, delete, change role, reset password, impersonate)

### What's Missing
1. **Quick profile access**: No links to view entity public profiles directly
2. **Impersonation from entity pages**: Can only impersonate from Users page, not from Trainers/Clubs/Academies
3. **Expanded edit dialogs**: Club dialogs don't include verification status; Trainer dialogs don't include all profile fields
4. **Unified action patterns**: Inconsistent action menus across entity types

## Implementation Plan

### Phase 1: Add "View Profile" and "Login as User" to Trainers Page

**File:** `src/pages/admin/AdminTrainers.tsx`

Add to the dropdown menu:
- **View Profile** - Opens `/en/trainers/{slug}` in new tab
- **Login as User** - Calls impersonate-user edge function with trainer's `user_id`

This requires:
1. Fetching the trainer's `slug` (add to `useAdminTrainers` query)
2. Adding impersonation dialog (copy pattern from AdminUsers)

### Phase 2: Add "View Profile" and "Login as Manager" to Clubs Page

**File:** `src/pages/admin/AdminClubs.tsx`

Add to the dropdown menu:
- **View Profile** - Opens `/en/locations/{slug}` in new tab (club profiles are at location URLs)
- **Login as Manager** - Calls impersonate-user with the club's primary owner from `club_managers`
- **Edit Club** - Expand dialog to include verification toggle

This requires:
1. Fetching the location's `slug` and club's `owner_user_id` (add to `useAdminClubs` query)
2. Adding impersonation confirmation dialog
3. Expanding `ClubSubscriptionEditDialog` to include `is_verified` toggle

### Phase 3: Add "View Profile" and "Login as Manager" to Academies Page

**File:** `src/pages/admin/AdminAcademies.tsx`

Current state:
- Already has "View Public Page" action
- Already has edit dialog with verification/public toggles

Add:
- **Login as Manager** - Calls impersonate-user with academy's primary manager from `academy_managers`

This requires:
1. Fetching the academy's manager `user_id` (add to `useAdminAcademies` query)
2. Adding impersonation confirmation dialog

### Phase 4: Update Admin Data Hooks

**File:** `src/hooks/useAdminData.ts`

Extend queries to fetch additional data needed for impersonation:

| Hook | Additional Fields |
|------|-------------------|
| `useAdminTrainers` | `slug` from `profiles` |
| `useAdminClubs` | `slug` from `locations`, owner `user_id` from `club_managers` |
| `useAdminAcademies` | manager `user_id` from `academy_managers` |

### Phase 5: Create Shared Impersonation Dialog Component

**File:** `src/components/admin/ImpersonateUserDialog.tsx`

A reusable confirmation dialog that:
- Shows the target user name/email
- Warns about logging in as another user
- Calls the `impersonate-user` edge function
- Opens magic link in new tab
- Shows success/error toast

### Phase 6: Expand Club Edit Dialog

**File:** `src/components/admin/ClubSubscriptionEditDialog.tsx`

Add fields:
- `is_verified` toggle (matching Academy dialog pattern)
- Club name (read-only, for display)

### Phase 7: Expand Trainer Edit Dialog

**File:** `src/components/admin/TrainerSubscriptionEditDialog.tsx`

Add fields:
- `is_verified` toggle

## Detailed Changes by File

| File | Changes |
|------|---------|
| `src/hooks/useAdminData.ts` | Extend `TrainerProfileAdmin`, `ClubProfileAdmin`, `AcademyProfileAdmin` types; update queries to fetch slug, manager user_ids |
| `src/components/admin/ImpersonateUserDialog.tsx` | Create new reusable dialog component |
| `src/components/admin/ClubSubscriptionEditDialog.tsx` | Add `is_verified` toggle |
| `src/components/admin/TrainerSubscriptionEditDialog.tsx` | Add `is_verified` toggle |
| `src/pages/admin/AdminTrainers.tsx` | Add View Profile + Login as User actions |
| `src/pages/admin/AdminClubs.tsx` | Add View Profile + Login as Manager actions |
| `src/pages/admin/AdminAcademies.tsx` | Add Login as Manager action (View Profile already exists) |

## User Experience

After implementation, from any admin entity table:

**Trainers:**
- Edit Subscription (expanded)
- View Profile (opens public trainer page)
- Login as Trainer (opens magic link)

**Clubs:**
- Edit Club (expanded with verification)
- View Profile (opens public club page)
- Login as Manager (if manager exists)

**Academies:**
- Edit Academy (already expanded)
- View Public Page (already exists)
- Login as Manager (if manager exists)

## Technical Considerations

### Manager Lookup for Impersonation
- Clubs: Query `club_managers` for `role = 'owner'`, fallback to any manager
- Academies: Query `academy_managers` for `role = 'owner'`, fallback to any manager
- If no manager exists, show "No manager assigned" tooltip and disable button

### Impersonation Safety
- The edge function already prevents impersonating admins
- Logs all impersonation attempts to `admin_impersonation_logs`
- Magic links expire after 1 hour

### Query Optimization
- Use single queries with JOINs to fetch related manager data
- Keep existing cache times (2 min stale, 10 min gc)

## Files to Create/Modify

| Action | File |
|--------|------|
| Create | `src/components/admin/ImpersonateUserDialog.tsx` |
| Modify | `src/hooks/useAdminData.ts` |
| Modify | `src/components/admin/ClubSubscriptionEditDialog.tsx` |
| Modify | `src/components/admin/TrainerSubscriptionEditDialog.tsx` |
| Modify | `src/pages/admin/AdminTrainers.tsx` |
| Modify | `src/pages/admin/AdminClubs.tsx` |
| Modify | `src/pages/admin/AdminAcademies.tsx` |

