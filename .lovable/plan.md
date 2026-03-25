

# Fix: Player Signup Sends "Trainer" Slack Notification

## Root Cause

Two issues combine:

1. **`signup-user/index.ts`** (server-side, uses service role key) hardcodes `role: 'Trainer'` in its Slack notification — this is the only one that succeeds
2. **`PlayerSignup.tsx`** (client-side, uses anon key) tries to call `slack-notify` directly, but `slack-notify` requires service role auth → **401 Unauthorized** → silently fails

Same issue exists for Club/Academy signup pages — their client-side Slack calls also fail silently.

## Fix

### 1. `supabase/functions/signup-user/index.ts`
- Accept an optional `role` parameter in the request body (already destructured alongside `language`)
- Use it in the Slack notification instead of hardcoded `'Trainer'`
- Default to `'Unknown'` if not provided

### 2. `src/pages/PlayerSignup.tsx`
- Pass `role: 'player'` in the body sent to `signup-user`
- **Remove** the direct client-side `slack-notify` calls (both success paths) — they always fail due to auth

### 3. `src/pages/AcademySignup.tsx`
- Pass `role: 'academy'` in the body sent to `signup-user`  
- **Remove** the direct client-side `slack-notify` calls

### 4. `src/pages/ClubSignup.tsx`
- Pass `role: 'club'` in the body sent to `signup-user`
- **Remove** the direct client-side `slack-notify` calls

| File | Change |
|------|--------|
| `supabase/functions/signup-user/index.ts` | Use `role` from request body instead of hardcoded `'Trainer'` |
| `src/pages/PlayerSignup.tsx` | Pass `role: 'player'` to signup-user, remove failing client-side slack-notify |
| `src/pages/AcademySignup.tsx` | Pass `role: 'academy'`, remove client-side slack-notify |
| `src/pages/ClubSignup.tsx` | Pass `role: 'club'`, remove client-side slack-notify |

