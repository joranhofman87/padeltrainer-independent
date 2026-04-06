

# Improve Guest-to-Player Flow: Hide Drafts + Better Signup Link

## What changes

### 1. Hide draft invoices from players (RLS + frontend)

**Problem**: The "Players can view their own invoices" RLS policy has no status filter — players can see draft invoices before the academy has finalized them.

**Fix**:
- **Migration**: Drop and recreate the player SELECT policy with `AND status != 'draft'` added to the `USING` clause
- **Frontend**: Add `.neq('status', 'draft')` to the query in `PlayerInvoicesTab.tsx` as defense-in-depth (line 78)

### 2. Pre-fill email + name in schedule notification signup link

**Problem**: The schedule email CTA links to `/app/signup/player` with no pre-fill. The player has to type their email manually, risking a mismatch that breaks the guest-linking trigger.

**Fix**: In `send-schedule-notifications/index.ts`, update the email data to include `playerEmail` (already partially there at line 943 of the template). In `send-email/index.ts`, update the signup URL (line 940) from:

```
https://padeltrainer.ai/app/signup/player
```
to:
```
https://padeltrainer.ai/app/signup/player?email=${encodeURIComponent(email)}&name=${encodeURIComponent(name)}
```

`PlayerSignup.tsx` already reads these params (lines 43-49) — no frontend change needed there.

## File summary

| File | Change |
|------|--------|
| Migration SQL | Add `status != 'draft'` to player invoice SELECT policy |
| `src/components/player/PlayerInvoicesTab.tsx` | Add `.neq('status', 'draft')` to query |
| `supabase/functions/send-schedule-notifications/index.ts` | Pass `playerEmail` in email data |
| `supabase/functions/send-email/index.ts` | Update signup CTA URL to include `?email=&name=` params |

