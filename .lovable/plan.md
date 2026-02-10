
## Update Email Sender Domain to Verified `app.padeltrainer.ai`

### Problem
All 7 edge functions currently send emails from `noreply@padeltrainer.ai`, but only `app.padeltrainer.ai` is verified in Resend. This causes 403 errors on every email attempt.

### Fix
Update the "from" address in all 7 edge functions from:
- `PadelTrainer.ai <noreply@padeltrainer.ai>`

To:
- `PadelTrainer.ai <noreply@app.padeltrainer.ai>`

### Files to update

| File | Occurrences |
|------|-------------|
| `supabase/functions/send-email/index.ts` | 1 |
| `supabase/functions/send-auth-email/index.ts` | 1 |
| `supabase/functions/send-digest-emails/index.ts` | 1 |
| `supabase/functions/forward-invoice/index.ts` | 1 |
| `supabase/functions/process-onboarding-emails/index.ts` | 2 |
| `supabase/functions/trigger-welcome-emails/index.ts` | 1 |
| `supabase/functions/signup-user/index.ts` | 1 |

### After deployment
Once updated and deployed, we'll test by sending a verification email to joranhofman87@gmail.com to confirm delivery works.
