
# Send Onboarding Emails After Email Confirmation

## Problem

Currently, onboarding emails with `delay_days = 0` are queued immediately when a user signs up. However, for users who need to verify their email first, it makes more sense to send the welcome email **after** they confirm their email address - when they first successfully log in.

## Current Flow

```text
User Signs Up
    |
    v
Profile Created -> Trigger queues emails
    |
    v
User receives verification email
    |
    v
User clicks verification link
    |
    v
User logs in (welcome email was already sent at signup)
```

## Proposed Flow

```text
User Signs Up
    |
    v
Profile Created -> Trigger queues emails with delay_days = 0 set to "awaiting_confirmation"
    |
    v
User receives verification email
    |
    v
User clicks verification link -> Auth callback triggers immediate email sending
    |
    v
User logged in + welcome email sent
```

## Solution

We'll modify the system to detect email confirmation and send day-0 emails at that point.

### Changes Required

**1. Database: Add status for waiting confirmation**
- Add a new status `awaiting_confirmation` to the email queue
- Modify the queue function to use this status for delay_days = 0 emails

**2. Modify Queue Function**
- For `delay_days = 0` templates: queue with status `awaiting_confirmation`
- For `delay_days > 0` templates: continue using `pending` status with future scheduled_for date

**3. Create new Edge Function: `trigger-welcome-emails`**
- Called when user confirms their email
- Finds all `awaiting_confirmation` emails for that user
- Sends them immediately via Resend
- Updates status to `sent`

**4. Frontend: Detect email confirmation**
- In `useAuth.tsx`, detect when a user's email gets confirmed
- Call the `trigger-welcome-emails` edge function

### Database Migration

```sql
-- Update the queue_onboarding_emails function to use awaiting_confirmation for 0-day emails
CREATE OR REPLACE FUNCTION public.queue_onboarding_emails(
  p_user_id uuid, 
  p_email text, 
  p_user_name text, 
  p_user_type text, 
  p_trigger_type text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  INSERT INTO onboarding_email_queue (template_id, user_id, email, user_name, user_type, scheduled_for, status)
  SELECT 
    t.id,
    p_user_id,
    p_email,
    p_user_name,
    p_user_type,
    now() + (t.delay_days || ' days')::interval,
    CASE WHEN t.delay_days = 0 THEN 'awaiting_confirmation' ELSE 'pending' END
  FROM onboarding_email_templates t
  WHERE t.user_type = p_user_type
    AND t.trigger_type = p_trigger_type
    AND t.is_active = true;
END;
$function$;
```

### New Edge Function: `trigger-welcome-emails`

```typescript
// supabase/functions/trigger-welcome-emails/index.ts
// - Accepts user_id from authenticated request
// - Finds all awaiting_confirmation emails for that user
// - Sends them via Resend
// - Updates status to sent
```

### Frontend Changes

**Modify `useAuth.tsx`:**
- Detect the `USER_UPDATED` or `SIGNED_IN` auth event where `email_confirmed_at` becomes set
- Call the `trigger-welcome-emails` edge function when this happens

### Files Summary

| Action | File |
|--------|------|
| Migrate | Database function `queue_onboarding_emails` |
| Create | `supabase/functions/trigger-welcome-emails/index.ts` |
| Modify | `supabase/config.toml` (register new function) |
| Modify | `src/hooks/useAuth.tsx` (detect email confirmation) |
| Update | `supabase/functions/process-onboarding-emails/index.ts` (update sender domain) |

### Additional Fix

The `process-onboarding-emails` function still uses `noreply@padeltrainer.nl` - this will be updated to `noreply@padeltrainer.ai`.
