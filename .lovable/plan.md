

# Fix: Onboarding emails sent to stale email address

## Problem

When a user changes their email, pending onboarding emails in `onboarding_email_queue` still use the original email stored at queue time. Neither `process-onboarding-emails` nor `trigger-welcome-emails` looks up the user's current email before sending.

## Solution

At send time in both edge functions, fetch the user's current email from the `profiles` table (using `user_id`) and use that instead of the stale `queue.email` column. Also update the queue row's email so logs/audit stay accurate.

## Changes

### 1. `supabase/functions/process-onboarding-emails/index.ts`
Before the send loop (after fetching pending emails), for each queue item:
- Query `profiles` table by `user_id` to get current email
- If found, use that email instead of `queueItem.email`
- Update the queue row's email column if it differs

### 2. `supabase/functions/trigger-welcome-emails/index.ts`
Same pattern — before sending each awaiting_confirmation email:
- Look up current email from `profiles` by `user_id`
- Use the fresh email for sending

### 3. (Optional but recommended) Add a database trigger
On `profiles` table `AFTER UPDATE OF email`, update all `pending`/`awaiting_confirmation` rows in `onboarding_email_queue` for that `user_id` to the new email. This keeps the queue accurate even before send time.

## Technical Detail

Both edge functions already have a service-role Supabase client. The lookup is a single query per queue item:

```sql
SELECT email FROM profiles WHERE user_id = $1 LIMIT 1
```

For the trigger approach:
```sql
CREATE OR REPLACE FUNCTION sync_queue_email_on_profile_update()
RETURNS trigger AS $$
BEGIN
  IF OLD.email IS DISTINCT FROM NEW.email THEN
    UPDATE onboarding_email_queue
    SET email = NEW.email
    WHERE user_id = NEW.user_id
      AND status IN ('pending', 'awaiting_confirmation');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE TRIGGER trg_sync_queue_email
AFTER UPDATE OF email ON profiles
FOR EACH ROW EXECUTE FUNCTION sync_queue_email_on_profile_update();
```

This is a belt-and-suspenders approach: the trigger keeps queue data fresh proactively, and the edge functions verify at send time as a safety net.

