
# Plan: Comprehensive E2E Test Suite Enhancement

## Overview

Enhance the E2E test suite to cover all main user flows for Admin, Player, Club, and Academy roles. This includes adding new test files and updating existing fixtures to support authenticated testing scenarios.

## Current State Analysis

### Test Coverage Summary

| Category | Current Coverage | Gap |
|----------|------------------|-----|
| **Admin** | Only auth guard check | No dashboard, CRUD, or management tests |
| **Player** | Auth guard + basic dashboard route check | No authenticated functionality tests |
| **Trainer** | Auth guard + basic dashboard route check | No authenticated functionality tests |
| **Club** | Auth guard + basic dashboard route check | No dashboard, profile, or management tests |
| **Academy** | Auth guard + public profile tests | No dashboard management tests |

### Existing Test Files (9 files, ~750 lines)
- `auth.spec.ts` - Authentication flows
- `navigation.spec.ts` - Marketing pages
- `booking.spec.ts` - Booking flows
- `dashboard.spec.ts` - Protected route checks
- `roles.spec.ts` - Role-specific signup and auth guards
- `i18n.spec.ts` - Internationalization
- `accessibility.spec.ts` - A11y tests
- `error-handling.spec.ts` - Error states
- `performance.spec.ts` - Performance metrics

## Implementation Plan

### Phase 1: Update Test Fixtures

**File:** `e2e/fixtures/test-data.ts`

Add admin routes and expand route definitions:

```typescript
export const ROUTES = {
  // ... existing routes ...
  admin: '/admin',
  adminUsers: '/admin/users',
  adminTrainers: '/admin/trainers',
  adminClubs: '/admin/clubs',
  adminAcademies: '/admin/academies',
  adminLocations: '/admin/locations',
  adminCertifications: '/admin/certifications',
  adminClubClaims: '/admin/club-claims',
  adminPricing: '/admin/pricing',
  adminRatingSystems: '/admin/rating-systems',
};
```

### Phase 2: Create Admin E2E Tests

**File:** `e2e/admin.spec.ts`

New test file covering:

1. **Admin Dashboard Access**
   - Redirect to auth when not logged in
   - Access denied for non-admin users (if testable)

2. **Admin Sidebar Navigation**
   - All menu items visible
   - Navigation between sections works
   - Pending claims badge visible (if claims exist)

3. **Admin Sub-Pages**
   - Users page loads with table
   - Trainers page loads with table and actions
   - Clubs page loads with table and actions
   - Academies page loads with scrape action
   - Locations page loads with import action
   - Certifications page loads
   - Club Claims page loads
   - Pricing page loads
   - Rating Systems page loads

4. **Admin Actions**
   - Edit dialogs open correctly
   - View profile links work
   - Impersonation dialog opens (if testable without actual login)

### Phase 3: Enhance Player Flow Tests

**File:** `e2e/roles.spec.ts` (update existing)

Add tests under "Player Flows":

1. **Player Dashboard Elements**
   - Dashboard route returns < 500 status
   - Navigation sidebar items exist
   
2. **Player Actions (UI existence)**
   - Bookings page structure
   - Following list page structure
   - Profile edit page structure

### Phase 4: Enhance Club Flow Tests

**File:** `e2e/roles.spec.ts` (update existing)

Add tests under "Club Flows":

1. **Club Dashboard Elements**
   - Dashboard page structure
   - Sidebar navigation items

2. **Club Management Pages**
   - Players page loads
   - Trainers page loads
   - Calendar page loads
   - Cycles page loads
   - Tournaments page loads
   - Settings page loads
   - Subscription page loads

### Phase 5: Enhance Academy Flow Tests

**File:** `e2e/roles.spec.ts` (update existing)

Add tests under "Academy Flows":

1. **Academy Dashboard Elements**
   - Dashboard page structure
   - Sidebar navigation items

2. **Academy Management Pages**
   - Trainers page loads
   - Locations page loads
   - Cycles page loads
   - Settings page loads

### Phase 6: Add Trainer Flow Tests

**File:** `e2e/roles.spec.ts` (update existing)

Expand "Trainer Flows" with:

1. **Trainer Dashboard Elements**
   - Dashboard route check
   - Sidebar navigation items

2. **Trainer Management Pages**
   - Settings page loads
   - Calendar page loads
   - Players page loads
   - Cycles page loads
   - Intake requests page loads
   - Subscription page loads

## File Changes Summary

| File | Action | Description |
|------|--------|-------------|
| `e2e/fixtures/test-data.ts` | Modify | Add admin routes and expand route constants |
| `e2e/admin.spec.ts` | Create | Comprehensive admin panel tests |
| `e2e/roles.spec.ts` | Modify | Add more tests for each role |

## New Test File: admin.spec.ts

```typescript
// Structure overview
test.describe('Admin Panel', () => {
  test.describe('Admin Access Control', () => {
    // Auth guard tests
  });

  test.describe('Admin Dashboard', () => {
    // Dashboard content tests
  });

  test.describe('Admin Sidebar Navigation', () => {
    // Sidebar presence and navigation tests
  });

  test.describe('Admin Users Management', () => {
    // Users table and actions
  });

  test.describe('Admin Trainers Management', () => {
    // Trainers table and actions
  });

  test.describe('Admin Clubs Management', () => {
    // Clubs table and actions
  });

  test.describe('Admin Academies Management', () => {
    // Academies table and actions
  });

  test.describe('Admin Locations Management', () => {
    // Locations table and actions
  });

  test.describe('Admin Certifications', () => {
    // Certifications management
  });

  test.describe('Admin Club Claims', () => {
    // Club claims handling
  });
});
```

## Test Expectations

Since we cannot authenticate in E2E tests without mock users or seeded data, tests will focus on:

1. **Route accessibility** - Verify routes exist and return valid HTTP status
2. **Auth guard verification** - Confirm protected routes redirect to `/auth`
3. **UI structure presence** - When accessible, verify expected elements exist
4. **No 500 errors** - All pages should handle gracefully without server errors

## Limitations

### Cannot Test (without seeded auth):
- Actual CRUD operations with data persistence
- Full booking flow completion
- Impersonation functionality
- Subscription/payment flows
- File uploads and data import

### Recommendation for Future:
Consider adding:
1. Test database seeding with known users
2. Playwright `storageState` for auth persistence
3. Mock authentication tokens
4. Visual regression testing

## Expected Results

After implementation:
- **Admin tests**: ~25 new test cases
- **Enhanced role tests**: ~15 additional test cases
- **Total test count**: ~100+ test cases across all files

Coverage improvements:
- All admin sub-routes tested for accessibility
- All role dashboards tested for structure
- Better documentation of expected UI elements
