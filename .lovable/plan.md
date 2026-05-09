## Problem

Rene owns RL Padel Performance (an academy) but also has a trainer role on his account. After signing in, the post-login redirect in `src/pages/Auth.tsx` only looks at the primary `role` (priority: admin > trainer > club > player). Since he has the `trainer` role, he is sent to `/app/trainer` even though his day-to-day work happens in `/app/academy`.

## Goal

When a user manages an academy, land them on the academy dashboard by default — without breaking trainers who are not academy managers.

## Approach

Two small, focused changes — no business-logic changes, only the routing decision after sign-in.

### 1. Prefer academy as the landing target for academy managers

In `src/pages/Auth.tsx` (the post-login redirect block around lines 104–126), use `isAcademyManager` from `useAuth()` to override the role-based default:

```text
if (redirectUrl) → use it (unchanged)
else if (onboardingRedirect) → use it (unchanged)
else if (isAcademyManager) → /app/academy        ← NEW
else if (role === 'admin')   → /app/admin
else if (role === 'trainer') → /app/trainer
else if (role === 'club' or isClubManager) → /app/club
else → /app/player
```

`useAuth` already exposes `isAcademyManager` (set by `isUserAcademyManager` in `fetchUserData`), so no new data fetching is needed.

### 2. Remember a per-user "preferred home" (lightweight)

To keep flexibility for hybrid users (trainer + academy owner who occasionally wants the trainer view as default), persist a small preference in `localStorage` under a key like `preferredHome:{userId}` with values `'academy' | 'trainer' | 'club' | 'player'`.

- Auth.tsx checks this key first (after the explicit `redirectUrl` / onboarding redirect), before falling back to the academy/role logic above.
- The preference is set automatically the first time we apply the academy override (so Rene gets `academy` saved), and can be overridden later by a small "Make this my default view" action — out of scope for this change unless you want it now.

If you'd rather skip the preference layer entirely, step 1 alone fully solves Rene's case.

## Out of scope

- No changes to sidebars, ProfileSwitcher, or the existing trainer→academy redirect inside `TrainerLayout` (that already sends academy trainers to `/app/trainer/calendar` once they hit `/app/trainer`, but Rene as an owner should not land there at all after this fix).
- No DB schema changes.

## Files to touch

- `src/pages/Auth.tsx` — adjust redirect logic, pull `isAcademyManager` from `useAuth()`.
- (Optional) `src/hooks/useAuth.tsx` — no change required; `isAcademyManager` is already exposed.

## Question for you

Do you want just step 1 (academy owners always land on `/app/academy`), or also step 2 (remember a per-user preferred home so power users can switch the default)?
