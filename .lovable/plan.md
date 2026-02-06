

# Fix: "state is not defined" Error in Mollie Connect Functions

## Problem

Both `mollie-connect-trainer` and `mollie-connect-academy` edge functions define a `generateState()` function but never call it. On the line that builds the OAuth state parameter, they reference an undefined variable `state`:

```typescript
// Line 76 (trainer) / Line 81 (academy)
authUrl.searchParams.set('state', `trainer_${trainerProfile.id}_${state}`);
//                                                                 ^^^^^ undefined!
```

This causes: `"state is not defined"` and returns a 500 error.

## Fix

Add a `const state = generateState();` call before it's used, in both files.

### `supabase/functions/mollie-connect-trainer/index.ts`

Add before line 73:
```typescript
const state = generateState();
```

### `supabase/functions/mollie-connect-academy/index.ts`

Add before line 78:
```typescript
const state = generateState();
```

## Summary

| File | Change |
|------|--------|
| `mollie-connect-trainer/index.ts` | Add `const state = generateState();` before building the auth URL |
| `mollie-connect-academy/index.ts` | Same fix |

One-line fix in each file. After deploying, retry the Mollie connection.
