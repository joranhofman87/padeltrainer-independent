

# Fix Private Slot Exposure & Email Queue Security

## Issue 3: Private Slots Readable by Anyone

**Problem**: The `availability_slots` table has an `is_public` column, but the SELECT policy is `USING (true)` — meaning private slots (group lessons, academy-internal sessions) are exposed to any API caller.

**Fix**: Replace the blanket SELECT with two policies:
1. Public slots visible to everyone (for marketplace/booking)
2. Private slots visible only to the owner trainer, academy managers, or club managers

### Migration SQL

```sql
DROP POLICY IF EXISTS "Anyone can view availability slots" ON availability_slots;

-- Public slots: anyone can see (marketplace, booking pages)
CREATE POLICY "Public slots are viewable by everyone"
  ON availability_slots FOR SELECT
  USING (is_public = true);

-- Private slots: only owner/managers/admins
CREATE POLICY "Owners and managers can view all their slots"
  ON availability_slots FOR SELECT
  TO authenticated
  USING (
    trainer_id IN (SELECT id FROM trainer_profiles WHERE user_id = auth.uid())
    OR academy_profile_id IN (SELECT get_user_academy_ids(auth.uid()))
    OR trainer_id IN (
      SELECT tl.trainer_id FROM trainer_locations tl
      JOIN club_profiles cp ON cp.location_id = tl.location_id
      WHERE cp.id IN (SELECT get_user_club_ids(auth.uid()))
    )
    OR public.is_admin(auth.uid())
  );
```

No frontend changes needed — public-facing pages already filter `is_public = true`, and dashboard pages run as authenticated owners who match the second policy.

---

## Issue 4: Email Queue Open to Anonymous INSERT

**Problem**: The INSERT policies on `onboarding_email_queue` and `onboarding_email_logs` are granted to the `public` role with `WITH CHECK (true)`. This means unauthenticated users could insert fake queue entries or log records via the API.

These tables are only written to by:
- Database triggers (`queue_onboarding_emails` — runs as `SECURITY DEFINER`)
- Edge functions (using service role key — bypasses RLS entirely)

Neither path needs a client-facing INSERT policy at all.

**Fix**: Drop both INSERT policies. The SECURITY DEFINER functions and service role calls bypass RLS, so they keep working.

### Migration SQL

```sql
DROP POLICY IF EXISTS "Service role can insert to queue" ON onboarding_email_queue;
DROP POLICY IF EXISTS "Service role can insert logs" ON onboarding_email_logs;
```

---

## File summary

| File | Change |
|------|--------|
| Migration SQL | Drop `"Anyone can view availability slots"`, add public + owner/manager SELECT policies |
| Migration SQL | Drop anonymous INSERT policies on `onboarding_email_queue` and `onboarding_email_logs` |

Both fixes are pure database migrations — no frontend or edge function changes required.

