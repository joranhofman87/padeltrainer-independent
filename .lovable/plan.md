

# Skip Email Verification Gate on Trainer Signup

## Problem
After signing up, trainers are shown a "Verification Pending" screen that blocks them from continuing to onboarding. Since verification emails can be slow, this causes drop-off.

## Solution
Auto-confirm the user's email in the `signup-user` edge function so a session is immediately available, then sign the user in right away. The verification email is still sent as a courtesy/security measure, but it no longer blocks the flow.

## Changes

### 1. Edge Function: `supabase/functions/signup-user/index.ts`
- Change `email_confirm: false` to `email_confirm: true` on line 123 so the user is created as already confirmed
- After creating the user, call `supabaseAdmin.auth.admin.generateLink()` with type `"magiclink"` (instead of `"signup"`) to still produce a verification/welcome link for the branded email -- or simply keep sending the welcome email without a confirm action (just a "Welcome" email instead of "Confirm your email")
- Update the email template: change subject to "Welcome to PadelTrainer" and copy to a welcome message (no action required), since the account is already confirmed
- The email still gets sent via Resend, just with different copy

### 2. Auth helper: `src/lib/auth.ts` -- `signUpWithEmail()`
- After the edge function returns successfully with the user data, immediately sign the user in using `supabase.auth.signInWithPassword({ email, password })` to establish a session
- Return the session from this sign-in so the signup page gets `data.session` and proceeds directly to onboarding

### 3. Signup page: `src/pages/TrainerSignup.tsx`
- The `else` branch (lines 88-97) that shows `VerificationPending` becomes a fallback/dead code path since `data.session` will now always be truthy after a successful signup
- No structural changes needed -- the existing `if (data?.session)` branch already navigates to `/app/onboarding/trainer`

## What stays the same
- The branded email is still sent (just as a welcome, not a gate)
- The `VerificationPending` component remains available for other signup flows (player, club)
- All onboarding logic is unchanged

## Technical Details

**Edge function change** (key line):
```
email_confirm: true  // was: false
```

**Auth helper addition** (after edge function success):
```typescript
// Sign in immediately after creation
const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({ email, password });
if (signInError) {
  // User was created but sign-in failed -- fall back to manual login
  return { data: { user: response.user, session: null }, error: null };
}
return { data: { user: signInData.user, session: signInData.session }, error: null };
```

**Email template update**: Change from "Confirm your email" to a welcome email that links to the app (no confirmation action needed).
