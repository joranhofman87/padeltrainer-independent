

# Security Findings Cleanup

After reviewing all 10 ignored findings, here's my assessment of which ones can be **actually fixed** vs which are genuine exceptions:

## Findings we CAN fix (3)

### 1. `admin_impersonation_logs` INSERT policy — `WITH CHECK (true)`
The INSERT policy uses `WITH CHECK (true)`, meaning any authenticated user could insert fake audit logs. Since inserts only happen from edge functions using the service role client (which bypasses RLS anyway), we can **tighten this policy** to only allow admins:

```sql
DROP POLICY "Service role can insert impersonation logs" ON admin_impersonation_logs;
CREATE POLICY "Admins can insert impersonation logs"
  ON admin_impersonation_logs FOR INSERT
  WITH CHECK (is_admin(auth.uid()));
```

Service role calls bypass RLS, so edge functions will still work. This removes the permissive `true` check.

### 2. Stripe verification fields updatable by managers
The UPDATE policies on `club_stripe_accounts`, `trainer_stripe_accounts`, and `academy_stripe_accounts` allow managers to update sensitive fields like `charges_enabled` and `payouts_enabled`. We can add column-level restrictions using `WITH CHECK` to prevent updating verification fields, or better yet, restrict UPDATE to only the columns managers should change (like `stripe_account_id`). The verification fields should only be set by webhooks (service role).

**Fix:** Add `WITH CHECK` constraints that prevent changing verification status fields, or create a trigger that rejects changes to those columns from non-service-role callers.

### 3. Leaked Password Protection
We can enable this via the `cloud--configure_auth` tool if available, or document it as a platform limitation.

## Findings that are genuine exceptions (keep ignored) (7)

| Finding | Why it stays ignored |
|---------|---------------------|
| Security Definer View (`profiles_public`) | Intentional design — view IS the security boundary for anon access |
| Extension in Public (`pg_net`) | Cannot be moved — Supabase limitation |
| RLS Enabled No Policy (`subscription_payments`, `notification_queue`) | Service-role-only tables by design |
| Chart `dangerouslySetInnerHTML` | Safe — no user input, only controlled theme values |
| Partner Form Validation | Properly implemented — info-level, no action needed |
| Edge Function Authorization | Properly implemented — info-level, no action needed |
| Database Security Functions | Properly implemented — info-level, no action needed |

## Plan

1. **Fix `admin_impersonation_logs` INSERT policy** — replace `WITH CHECK (true)` with `WITH CHECK (is_admin(auth.uid()))`. Service role bypasses RLS so edge functions are unaffected.

2. **Restrict Stripe verification field updates** — add a trigger on all three `*_stripe_accounts` tables that prevents non-service-role users from modifying `charges_enabled`, `payouts_enabled`, and `onboarding_complete`. These should only be set by webhook edge functions.

3. **Update ignore reasons** on the remaining findings to be more concise and confirm they've been reviewed.

This reduces actionable findings from 3 to 0 and keeps only genuinely unfixable items as ignored.

