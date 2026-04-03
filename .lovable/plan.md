

# Auto-Detect Timezone on Signup

## Problem
Trainers and academy owners currently default to `Europe/Amsterdam`. If they sign up from a different timezone, they'd need to manually go to settings to change it. We want to capture their browser timezone at signup and save it automatically.

## Approach
Detect the browser timezone via `Intl.DateTimeFormat().resolvedOptions().timeZone` at signup time and pass it through to the profile creation code. The timezone is set once on signup and never auto-changed again — users can update it manually in settings.

## Changes

### 1. `src/lib/auth.ts` — Accept `timezone` param in `signUpWithEmail` and `setUserRole`
- Add `timezone` parameter to `signUpWithEmail()`, pass it to the `signup-user` edge function body
- Add `timezone` parameter to `setUserRole()`. When creating `trainer_profiles`, include the timezone value (falling back to `'Europe/Amsterdam'`)

### 2. `supabase/functions/signup-user/index.ts` — Save timezone on profile creation
- Accept `timezone` from the request body
- After user creation, include `timezone` in the `profiles` table update (alongside `phone`, `preferred_language`, `stripe_customer_id`)

### 3. Signup pages — Detect and pass browser timezone
- **`src/pages/TrainerSignup.tsx`** (or equivalent), **`src/pages/AcademySignup.tsx`**, **`src/pages/PlayerSignup.tsx`**, **`src/pages/ClubSignup.tsx`**: Detect `Intl.DateTimeFormat().resolvedOptions().timeZone` and pass it to `signUpWithEmail()`

### 4. `src/lib/academy.ts` — `createAcademy()`: Include timezone
- When inserting into `academy_profiles`, detect and include the browser timezone

### 5. `src/pages/TrainerOnboarding.tsx` — Set timezone on trainer profile
- When `setUserRole` is called during onboarding, pass the detected browser timezone

## Database
No migration needed — the `timezone` column already exists on both `trainer_profiles` and `academy_profiles` with a default of `'Europe/Amsterdam'`. We also don't need a `timezone` column on `profiles` since it's role-specific.

## Result
- New trainers get their timezone auto-detected from the browser at signup
- New academies get their timezone auto-detected when the academy is created
- The value is set once and never changed automatically
- Users can always override it in Settings

## Files

| File | Change |
|------|--------|
| `src/lib/auth.ts` | Add `timezone` param to `signUpWithEmail` and `setUserRole` |
| `src/pages/TrainerOnboarding.tsx` | Pass detected timezone to `setUserRole` |
| `src/lib/academy.ts` | Include detected timezone in `createAcademy` insert |
| `src/pages/AcademySignup.tsx` | Detect and pass timezone |
| `src/pages/PlayerSignup.tsx` | Detect and pass timezone (for future use) |
| `src/pages/ClubSignup.tsx` | Detect and pass timezone (for future use) |

