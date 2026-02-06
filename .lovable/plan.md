

# Fix Booking Links on Trainer Profile (404 Error)

## Problem

When viewing a trainer profile at `/nl/trainer/trainer-test`, clicking "Book Lesson" navigates to `/app/book/trainer-test` which requires authentication context and feels wrong from a public marketing page. The booking page already exists as a public marketing route at `/:lang/book/:trainerId`, so links from the marketing trainer profile should use that route instead.

## Solution

Replace `getAppUrl('/book/...')` with `localizePath('/book/...')` in two files so booking links stay within the marketing route structure.

## Changes

### 1. `src/pages/TrainerProfile.tsx`
- Update 3 instances of `getAppUrl('/book/...')` to use `localizePath('/book/...')` (the `localizePath` helper is already imported and available)
- Lines affected: ~420, ~740, ~783

### 2. `src/components/trainer/TrainerOpenSlots.tsx`
- Replace `getAppUrl('/book/...')` with a localized path
- Pass the current language into the component (or use the `useLocalizedPathFn` hook directly) to build the correct `/:lang/book/:trainerId` URL
- This also fixes the slot row click handler and the "View All and Book" button

### 3. Auth redirect ("Sign In to Book")
- The sign-in button at line ~392 correctly uses `getAppUrl('/auth')` since auth lives under `/app/` -- no change needed there

## Technical Detail
- `localizePath('/book/trainer-test')` produces `/nl/book/trainer-test` (matching the existing `/:lang/book/:trainerId` marketing route)
- `getAppUrl('/book/trainer-test')` produces `/app/book/trainer-test` (requires auth context, wrong origin for public pages)
