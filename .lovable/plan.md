
## Preserve Player Intent Across Signup and Onboarding

### Problem
When a player clicks a CTA (e.g., "Sign up & apply" for a cycle, "Join waiting list", "Book a lesson") and goes through signup + onboarding, they end up on the generic dashboard instead of being returned to their intended action. Two gaps cause this:

1. **CycleApplicationModal** and **CycleRegistration** don't pass the `?redirect=` param to the signup page -- they use `sessionStorage` or route to `/auth` instead of `/app/signup/player?redirect=...`
2. **TrainerOnboarding** (`handleComplete`) never checks `localStorage.getItem('redirectAfterOnboarding')` -- so even when the redirect IS stored, trainer onboarding ignores it

### What's changing

**Fix redirect preservation at CTA points:**
- `CycleApplicationModal.tsx`: Change `handleLoginRedirect` to navigate to `/app/signup/player?redirect=...` (consistent with all other CTAs)
- `CycleRegistration.tsx`: Change `handleLoginRedirect` to navigate to `/app/signup/player?redirect=...` instead of `/auth?redirect=...`

**Fix redirect consumption after onboarding:**
- `TrainerOnboarding.tsx`: In `handleComplete`, after marking onboarding as done, check for `redirectAfterOnboarding` in localStorage and navigate there instead of always going to `/app/trainer/get-started`

### Technical Details

**File: `src/components/cycles/CycleApplicationModal.tsx`** (line ~76-79)

Replace sessionStorage approach with redirect param:
```typescript
const handleLoginRedirect = () => {
  const currentPath = window.location.pathname;
  navigate(`/app/signup/player?redirect=${encodeURIComponent(currentPath)}`);
};
```

**File: `src/pages/CycleRegistration.tsx`** (line ~154-157)

Route to player signup instead of auth:
```typescript
const handleLoginRedirect = () => {
  const currentPath = window.location.pathname;
  navigate(`/app/signup/player?redirect=${encodeURIComponent(currentPath)}`);
};
```

**File: `src/pages/TrainerOnboarding.tsx`** (in `handleComplete`, after line ~130)

Add redirect check before navigating to get-started:
```typescript
const redirectUrl = localStorage.getItem('redirectAfterOnboarding');
if (redirectUrl) {
  localStorage.removeItem('redirectAfterOnboarding');
  navigate(redirectUrl);
} else {
  navigate('/app/trainer/get-started');
}
```

### Files to modify
- `src/components/cycles/CycleApplicationModal.tsx`
- `src/pages/CycleRegistration.tsx`
- `src/pages/TrainerOnboarding.tsx`
