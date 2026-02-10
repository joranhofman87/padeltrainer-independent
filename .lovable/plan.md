

## Fix Post-Signup Redirect to Preserve User Intent

### Problem
When an unauthenticated user clicks "Sign up & apply" on a trainer/academy/club page, they are correctly sent to the player signup page with a `?redirect=` parameter. The signup and onboarding pages already store this in `localStorage` as `redirectAfterOnboarding` and use it after onboarding completes. However, the redirect URLs are broken in several components because they are missing the required `/app/` prefix, causing the user to land on the dashboard instead of being returned to the page they came from.

### Root Cause
Three components construct the signup URL without using the `getAppUrl()` helper, so the navigation itself fails to reach `/app/signup/player`. Additionally, `BookLesson.tsx` omits the `/app/` prefix on the redirect target value.

### Changes

**File: `src/components/trainer/TrainerOpenCycles.tsx`**
- Import `getAppUrl` from `@/lib/domains`
- Change `navigate(\`/signup/player?redirect=...\`)` to `navigate(getAppUrl(\`/signup/player?redirect=...\`))`

**File: `src/components/academy/AcademyOpenCycles.tsx`**
- Import `getAppUrl` from `@/lib/domains`
- Change `navigate(\`/signup/player?redirect=...\`)` to `navigate(getAppUrl(\`/signup/player?redirect=...\`))`

**File: `src/components/club/LocationOpenCycles.tsx`**
- Import `getAppUrl` from `@/lib/domains`
- Change `navigate(\`/signup/player?redirect=...\`)` to `navigate(getAppUrl(\`/signup/player?redirect=...\`))`

**File: `src/pages/BookLesson.tsx`**
- Fix the redirect value to include `/app/` prefix: change `redirect=/book/${trainerId}` to `redirect=/app/book/${trainerId}`

### What already works (no changes needed)
- `PlayerSignup.tsx` reads `?redirect=` and stores it as `redirectAfterOnboarding` in localStorage
- `Onboarding.tsx` reads `redirectAfterOnboarding` after completing setup and navigates there
- `TrainerProfile.tsx` and `WaitingListCard.tsx` already use `getAppUrl()` correctly

### Result
After signing up and completing onboarding, the player is returned to the exact trainer/academy/club page where they were trying to take action (book a cycle, join a waiting list, etc.) instead of landing on the generic dashboard.

