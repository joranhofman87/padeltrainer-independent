

## Bot Protection for Signup

### Approach
Two layers of protection, no external services or API keys needed:

1. **Server-side rate limiting** on the `signup-user` edge function -- reuses the existing `rate_limits` table pattern
2. **Honeypot field** on all signup forms -- a hidden input that bots auto-fill but real users never see
3. **Timing check** -- reject submissions that happen faster than humanly possible (under 2 seconds)

### How it works

**Honeypot**: A hidden text field (e.g., named "website") is added to the form but invisible via CSS. Bots scanning the DOM will fill it in, humans won't. If it has a value on submit, the signup is silently rejected.

**Timing**: A timestamp is recorded when the form mounts. If the form is submitted in under 2 seconds, it's almost certainly a bot.

**Rate limiting**: The `signup-user` edge function checks the `rate_limits` table before creating a user. Limit: 5 signups per IP per hour. This stops brute-force account creation.

### Technical Details

**1. Create a reusable honeypot hook** -- `src/hooks/useHoneypot.ts`

Returns a ref for the hidden input, a timestamp for timing validation, and a `isSuspicious()` check.

**2. Add honeypot + timing to all 4 signup forms:**
- `src/pages/PlayerSignup.tsx`
- `src/pages/TrainerSignup.tsx`
- `src/pages/ClubSignup.tsx`
- `src/pages/AcademySignup.tsx`

Each form gets:
- A hidden input field (visually hidden with `aria-hidden`, `tabIndex={-1}`, `position: absolute; left: -9999px`)
- Early return in `handleSignUp` if honeypot is filled or timing is too fast

**3. Add rate limiting to `supabase/functions/signup-user/index.ts`**

Before creating the user, check the `rate_limits` table using the request IP. Allow max 5 signups per IP per 60-minute window. Return a 429 error if exceeded.

### Files to create
- `src/hooks/useHoneypot.ts` -- reusable hook with honeypot ref, timing, and `isSuspicious()` function

### Files to modify
- `src/pages/PlayerSignup.tsx` -- add honeypot hook + hidden field
- `src/pages/TrainerSignup.tsx` -- add honeypot hook + hidden field
- `src/pages/ClubSignup.tsx` -- add honeypot hook + hidden field
- `src/pages/AcademySignup.tsx` -- add honeypot hook + hidden field
- `supabase/functions/signup-user/index.ts` -- add IP-based rate limiting using existing `rate_limits` table
