

# Cleanup: Remove SelectRole Page

## Problem

The `SelectRole` page (`/select-role`) is legacy functionality that's no longer needed since all signup flows now use dedicated paths (`/signup/player`, `/signup/trainer`, etc.) that automatically set the user's intended role.

Currently, users see this page briefly on refresh due to a race condition where `role` is null before `fetchUserData` completes.

## Solution

1. Remove the SelectRole page and route entirely
2. Update Auth.tsx to default to player onboarding for edge cases (user without `pendingRole`)
3. Fix the race condition in `useAuth` so layouts wait for role data before evaluating guards

## Files to Modify

| File | Change |
|------|--------|
| `src/hooks/useAuth.tsx` | Await `fetchUserData` before setting `loading: false` |
| `src/pages/Auth.tsx` | Replace `/select-role` fallback with `/onboarding/player` |
| `src/components/DomainRouter.tsx` | Remove SelectRole import and all `/select-role` routes |
| `src/components/trainer/TrainerLayout.tsx` | Remove redirect to `/select-role` (will be handled by loading state) |
| `src/components/player/PlayerLayout.tsx` | Remove redirect to `/select-role` |
| `src/pages/SelectRole.tsx` | Delete this file |
| `e2e/dashboard.spec.ts` | Update or remove tests referencing `/select-role` |

## Technical Changes

### 1. useAuth.tsx - Fix Race Condition

```typescript
// Change getSession handler to await fetchUserData
supabase.auth.getSession().then(async ({ data: { session } }) => {
  setSession(session);
  setUser(session?.user ?? null);
  
  if (session?.user) {
    await fetchUserData(session.user.id);
  }
  setLoading(false);
});

// Similarly in onAuthStateChange - await before setLoading(false)
```

### 2. Auth.tsx - Default to Player Onboarding

```typescript
// Line 109-110: Change fallback from /select-role to /onboarding/player
} else {
  // Default to player onboarding for edge cases (e.g., OAuth without pendingRole)
  navigate('/onboarding/player');
}
```

### 3. DomainRouter.tsx - Remove Routes

- Remove `import SelectRole from '@/pages/SelectRole';`
- Remove `<Route path="/select-role" element={<SelectRole />} />` from all route sections
- Remove `<Route path="/select-role" element={<RedirectToAppDomain path="/select-role" />} />` from marketing routes

### 4. Layout Guards - Remove /select-role Redirects

**TrainerLayout.tsx:**
```typescript
// Change from:
} else if (!role) {
  navigate('/select-role');
}

// To:
} else if (!role) {
  navigate('/auth');  // User needs to log in again or complete onboarding
}
```

**PlayerLayout.tsx:** Same change

### 5. Delete SelectRole.tsx

Remove the file entirely.

### 6. E2E Tests

Update `e2e/dashboard.spec.ts` to remove or update the "Role Selection" test block.

## Expected Result

- No more `/select-role` page appearing during navigation
- Users who somehow end up without a role default to player onboarding
- Loading states properly wait for role data before rendering

