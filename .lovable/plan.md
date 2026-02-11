

## Fix Slack Signup Notifications

### Problem
1. The `signup-user` edge function hardcodes `role: 'trainer'` in the Slack notification -- so even if a player somehow triggers it, it says "trainer"
2. Player, Club, and Academy signups use `signUpWithEmail` directly from their pages and never call `slack-notify` at all -- so you're missing those signups entirely

### Solution

**1. Update `slack-notify` event formatting**

Change the "New Signup" message format to match what you want:

```
New Sign up: {Role}
Name: {Name}
Role: {Role}
Email: {Email}
```

Update the `new_signup` event title to dynamically include the role (e.g. "New Sign up: Player" instead of generic "New Signup").

**2. Add Slack notifications to Player, Club, and Academy signup pages**

After a successful signup in each page, add a non-blocking call to `slack-notify`:

- `src/pages/PlayerSignup.tsx` -- send `{ event: 'new_signup', data: { name, email, role: 'Player' } }`
- `src/pages/ClubSignup.tsx` -- send `{ event: 'new_signup', data: { name, email, role: 'Club' } }`
- `src/pages/AcademySignup.tsx` -- send `{ event: 'new_signup', data: { name, email, role: 'Academy' } }`

**3. Fix the existing trainer signup notification**

In `supabase/functions/signup-user/index.ts`, change `role: 'trainer'` to `role: 'Trainer'` for consistency.

**4. Update `slack-notify` formatting logic**

In `supabase/functions/slack-notify/index.ts`, update `formatMessage` so the `new_signup` event title includes the role from the data (e.g. "New Sign up: Player" instead of just "New Signup").

### Files to modify
- `supabase/functions/slack-notify/index.ts` -- dynamic title for signups
- `supabase/functions/signup-user/index.ts` -- capitalize role to "Trainer"
- `src/pages/PlayerSignup.tsx` -- add slack-notify call
- `src/pages/ClubSignup.tsx` -- add slack-notify call
- `src/pages/AcademySignup.tsx` -- add slack-notify call
