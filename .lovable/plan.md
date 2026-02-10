

## Fix Post-Signup Redirect to Original Page

### Problem

When a player signs up via a CTA on a trainer/club/academy profile, they should be redirected back to that page after completing signup + onboarding. Currently they end up on the dashboard instead.

**Root cause**: The redirect URL is stored in `localStorage` as `redirectAfterOnboarding`, and it's only consumed in `Onboarding.tsx` when the onboarding form is submitted. However, when the user verifies their email and lands on `/app/auth`, the Auth page may detect that the user already has a role and redirect them straight to the dashboard -- never reaching the onboarding page where the redirect would be consumed.

### Solution

Add a check for `redirectAfterOnboarding` in `Auth.tsx` so that even if a user already has a role, the stored redirect URL is honored.

### Changes

**`src/pages/Auth.tsx`**

In the redirect logic (around line 84-104), when a user with an existing role is being redirected to their dashboard:

1. Before falling through to the default dashboard redirect, check `localStorage.getItem('redirectAfterOnboarding')`
2. If it exists, navigate there instead and clear it from localStorage
3. This covers the case where the user completed onboarding but Auth still handles the final navigation

**`src/pages/Onboarding.tsx`** (no change needed -- already handles it correctly)

### How it works after the fix

```text
User clicks CTA on trainer profile
  -> /app/signup/player?redirect=/en/trainer/john
  -> localStorage: redirectAfterOnboarding = "/en/trainer/john"
  -> User signs up, verifies email
  -> Lands on /app/auth
  -> Auth sees user has role -> checks redirectAfterOnboarding
  -> Navigates to /en/trainer/john instead of /app/player
```

### Files to modify

- `src/pages/Auth.tsx` (add redirectAfterOnboarding check in the existing-role redirect block)
