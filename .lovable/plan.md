

# Translation Audit: Missing i18n Coverage

## Summary

All 5 languages (EN, NL, ES, DE, FR) have **identical JSON file structures** across all 11 namespaces — the translation files themselves are complete and in sync. The problem is **hardcoded English strings in page components** that bypass the translation system entirely.

## Findings

### Translation JSON files: COMPLETE
All namespaces (common, marketing, auth, player, trainer, club, cycles, admin, academy, waitingList, notifications) exist for all 5 languages with matching key structures.

### Pages with hardcoded English (no `useTranslation`):

| Page | Impact | Hardcoded strings |
|------|--------|-------------------|
| **PlayerDashboard.tsx** (612 lines) | HIGH - Player-facing | Status badges ("Confirmed", "Pending Payment", "Awaiting Approval"), "No upcoming bookings", section headers |
| **PlayerBookings.tsx** | HIGH - Player-facing | "My Bookings", "Pending Payment", "Awaiting Approval", "No upcoming bookings", "Find a trainer and book your first lesson!", "Browse Trainers", "No past bookings" |
| **BookingSuccess.tsx** (264 lines) | HIGH - Post-payment | "Payment Successful!", "Your booking has been confirmed", "Payment Issue", "Something went wrong" |
| **BookingCancelled.tsx** (73 lines) | MEDIUM - Post-payment | "Betaling niet voltooid" (Dutch hardcoded!), mixed Dutch/English |
| **BookLesson.tsx** | HIGH - Booking flow | "Trainer not found", "Browse Trainers", booking form labels |
| **FollowingList.tsx** | MEDIUM - Player-facing | "Follow trainers to get notified...", "Browse Trainers" |
| **TrainerEarnings.tsx** | LOW - Has `useTranslation` but still has hardcoded "All caught up!", "No pending payments" |

### Admin pages (lower priority, internal-only):
- `AdminLocations.tsx`, `AdminUsers.tsx`, `AdminReviewTags.tsx`, `AdminClubs.tsx` — all English-only, but these are admin-only pages.

## Plan

### Step 1: Add translation keys to player namespace
Add missing keys to `src/i18n/locales/{en,nl,es,de,fr}/player.json` for:
- PlayerDashboard status badges and empty states
- PlayerBookings page text
- FollowingList text

### Step 2: Add translation keys to common namespace  
Add missing keys to all `common.json` files for:
- BookingSuccess page (payment status, confirmation messages)
- BookingCancelled page
- BookLesson error states

### Step 3: Wire up translations in 6 page files
Add `useTranslation` and replace all hardcoded strings in:
1. `src/pages/PlayerDashboard.tsx`
2. `src/pages/PlayerBookings.tsx`
3. `src/pages/BookingSuccess.tsx`
4. `src/pages/BookingCancelled.tsx`
5. `src/pages/BookLesson.tsx`
6. `src/pages/FollowingList.tsx`

### Step 4: Fix TrainerEarnings remaining hardcoded strings
Replace remaining English fallbacks in `TrainerEarnings.tsx`.

### Out of scope (admin-only pages)
Admin pages (`AdminLocations`, `AdminUsers`, `AdminReviewTags`, `AdminClubs`) are internal tools — translation can be deferred.

### Technical approach
- Each page gets `const { t } = useTranslation('player')` (or appropriate namespace)
- All visible text replaced with `t('key')` calls
- All 5 language files updated simultaneously with proper translations

This is a large change touching ~6 pages and ~10 JSON files. I recommend splitting into 2 batches: high-impact player pages first (Steps 1-3), then earnings cleanup (Step 4).

