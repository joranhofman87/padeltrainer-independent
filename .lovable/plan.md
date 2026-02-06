

# Cleanup: Fix Leftover Non-Prefixed Routes from Old Subdomain Setup

## What's Wrong

When you consolidated from two domains (`app.padeltrainer.ai` + `padeltrainer.ai`) to a single domain with path-based routing (`/app/*`), many `navigate()` calls and `Link` components across the codebase were **never updated** to use the `/app/` prefix. They still point to paths like `/auth`, `/trainer`, `/club/subscription`, etc.

These technically "work" because `DomainRouter.tsx` has legacy redirect routes that catch them and redirect to `/app/*`. But this causes:
- **Unnecessary double-navigation** (navigate to `/auth` -> redirect to `/app/auth`)
- **Lost query parameters** on some redirects (the booking-success bug you already hit)
- **Confusion** about which paths are correct
- **Dead code** in `domains.ts` (deprecated functions nobody calls)

## Scope of the Problem

**~22 files** use `navigate('/auth')` instead of `navigate('/app/auth')`

**~19 files** use non-prefixed app paths like:
- `navigate('/trainer')` instead of `navigate('/app/trainer')`
- `navigate('/club/subscription')` instead of `navigate('/app/club/subscription')`
- `navigate('/admin/users')` instead of `navigate('/app/admin/users')`
- `navigate('/onboarding/club')` instead of `navigate('/app/onboarding/club')`

**~5 files** use non-prefixed `Link to="/auth"` or `Link to="/signup/..."` paths

**1 test file** has an outdated expected redirect URL

**1 file (`domains.ts`)** has 3 deprecated functions and 1 deprecated constant that are never imported anywhere

## Plan

### 1. Fix all `navigate('/auth')` calls (22 files)
Replace with `navigate('/app/auth')`. Files include:
- `TrainerBookings.tsx`, `TrainerDashboard.tsx`, `TrainerAnalytics.tsx`, `TrainerEarnings.tsx`, `TrainerSubscription.tsx`, `TrainerLessons.tsx`
- `ClubCalendar.tsx`, `ClubLessons.tsx`, `ClubPlayers.tsx`, `ClubSubscription.tsx`
- `AdminDashboard.tsx`, `AdminCertifications.tsx`, `AdminRatingSystems.tsx`, `AdminReviewTags.tsx`
- `NotificationSettings.tsx`, `EditProfile.tsx`, `CalendarSettings.tsx`, `ResetPassword.tsx`
- `AcademySidebar.tsx`, `TrainerSidebar.tsx`
- `CycleApplicationModal.tsx`, `CycleRegistration.tsx`

### 2. Fix all non-prefixed app `navigate()` calls (~19 files)
Replace `/trainer`, `/club`, `/admin`, `/player`, `/onboarding` with `/app/trainer`, `/app/club`, etc. Files include:
- `ProfileSwitcher.tsx` -- `/trainer` and `/club` to `/app/trainer` and `/app/club`
- `AdminStatsCards.tsx` -- `/admin/users`, `/admin/clubs` to `/app/admin/...`
- `OpenSlots.tsx` -- `/trainer/calendar` to `/app/trainer/calendar`
- `TrainerDashboard.tsx` -- `/trainer/subscription`, `/trainer/players` etc.
- `TrainerBookingSettings.tsx`, `TrainerCyclus.tsx`, `TrainerSettings.tsx`, `PlayerSettings.tsx`
- `ClubDashboard.tsx`, `ClubProfile.tsx`
- `ClubTrainerInvitation.tsx` -- `/trainer` to `/app/trainer`
- `Onboarding.tsx` -- `/onboarding/club` to `/app/onboarding/club`
- `PlayerSignup.tsx`, `TrainerSignup.tsx`, `ClubSignup.tsx` -- `/onboarding/*` to `/app/onboarding/*`

### 3. Fix non-prefixed `Link` components (~5 files)
- `AcademySignup.tsx` -- `to="/auth"` and `to="/signup/player"` to `/app/auth` and `/app/signup/player`
- `VerificationPending.tsx` -- `to="/auth"` to `/app/auth`
- `TrainersCity.tsx` -- `to="/signup/trainer"` to `/app/signup/trainer`
- `AdminSidebar.tsx` -- all `/admin/*` links to `/app/admin/*`

### 4. Clean up dead code in `domains.ts`
Remove the 3 deprecated functions (`isOnAppDomain`, `isOnMarketingDomain`, `isInDevelopment`) and the deprecated `APP_DOMAIN` constant -- none are imported anywhere.

### 5. Update test file
- `auth.test.ts` -- fix expected redirect URL from `/auth` to `/app/auth`

### 6. Keep legacy redirects (for now)
The legacy redirect routes in `DomainRouter.tsx` should stay as a safety net for any external links or bookmarks pointing to old URLs. They now correctly preserve query params thanks to the earlier `LegacyRedirect` fix.

## Files to Change

1. `src/pages/TrainerBookings.tsx`
2. `src/pages/TrainerDashboard.tsx`
3. `src/pages/TrainerAnalytics.tsx`
4. `src/pages/TrainerEarnings.tsx`
5. `src/pages/TrainerSubscription.tsx`
6. `src/pages/TrainerLessons.tsx`
7. `src/pages/TrainerBookingSettings.tsx`
8. `src/pages/TrainerCyclus.tsx`
9. `src/pages/TrainerSettings.tsx`
10. `src/pages/OpenSlots.tsx`
11. `src/pages/club/ClubCalendar.tsx`
12. `src/pages/club/ClubLessons.tsx`
13. `src/pages/club/ClubPlayers.tsx`
14. `src/pages/club/ClubSubscription.tsx`
15. `src/pages/club/ClubDashboard.tsx`
16. `src/pages/club/ClubProfile.tsx`
17. `src/pages/club/ClubTrainerInvitation.tsx`
18. `src/pages/AdminDashboard.tsx`
19. `src/pages/admin/AdminCertifications.tsx`
20. `src/pages/admin/AdminRatingSystems.tsx`
21. `src/pages/admin/AdminReviewTags.tsx`
22. `src/pages/NotificationSettings.tsx`
23. `src/pages/EditProfile.tsx`
24. `src/pages/CalendarSettings.tsx`
25. `src/pages/ResetPassword.tsx`
26. `src/pages/PlayerSettings.tsx`
27. `src/pages/PlayerSignup.tsx`
28. `src/pages/TrainerSignup.tsx`
29. `src/pages/ClubSignup.tsx`
30. `src/pages/AcademySignup.tsx`
31. `src/pages/Onboarding.tsx`
32. `src/pages/CycleRegistration.tsx`
33. `src/components/ProfileSwitcher.tsx`
34. `src/components/admin/AdminSidebar.tsx`
35. `src/components/admin/AdminStatsCards.tsx`
36. `src/components/academy/AcademySidebar.tsx`
37. `src/components/trainer/TrainerSidebar.tsx`
38. `src/components/auth/VerificationPending.tsx`
39. `src/components/cycles/CycleApplicationModal.tsx`
40. `src/pages/TrainersCity.tsx`
41. `src/lib/domains.ts`
42. `src/lib/auth.test.ts`
