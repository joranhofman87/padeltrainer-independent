
# Redirect unauthenticated trainer page CTAs to Sign Up

## What changes
All call-to-action buttons visible to unauthenticated users on trainer-related pages currently navigate to `/app/auth` (the sign-in page). We will change these to navigate to `/app/signup/player` instead, preserving any redirect parameters so users return to the correct page after registration.

## Affected locations

1. **TrainerProfile.tsx (line 412)** -- the "Sign In to Book" header button navigates to `/app/auth`. Change to `/app/signup/player` with a redirect back to the trainer profile, and update the label to "Sign Up to Book".

2. **BookLesson.tsx (line 99)** -- unauthenticated users are redirected to `/app/auth?redirect=/book/:trainerId`. Change to `/app/signup/player?redirect=/book/:trainerId`.

3. **WaitingListCard.tsx (line 37)** -- unauthenticated users clicking "Join Waiting List" are sent to `/app/auth?redirect=...`. Change to `/app/signup/player?redirect=...`.

4. **CycleApplicationModal.tsx (line 79)** -- unauthenticated users trying to apply for a cycle are sent to `/app/auth`. Change to `/app/signup/player` (preserving the sessionStorage redirect logic).

## Translation updates
- Add `signUpToBook` key to EN and NL `common.json` (e.g., "Sign Up to Book" / "Registreer om te Boeken")

## Technical details

Each change is a simple URL swap from `/auth` to `/signup/player`, keeping existing redirect query parameters intact. The PlayerSignup page already handles redirects via query params and sessionStorage, so no changes are needed there.

No database or backend changes required.
