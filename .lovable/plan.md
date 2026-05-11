## Harden Reditus webhook signature verification

Yes, both points are valid security improvements. Apply them to `supabase/functions/reditus-referral-webhook/index.ts`.

### Changes

**1. Make signature verification mandatory (fail-closed)**

Replace the `if (webhookSecret) { ... }` block so that:
- Missing `REDITUS_WEBHOOK_SECRET` → 500 (misconfiguration, never accept traffic)
- Missing `x-signature` header → 401
- Invalid signature → 401

**2. Constant-time signature comparison**

Add a `constantTimeEqual(a, b)` helper and use it inside `verifySignature` instead of `computed === signature`, to prevent timing attacks on HMAC comparison.

### Files

- `supabase/functions/reditus-referral-webhook/index.ts` — only file touched.

### After

- Mark the relevant security finding as fixed (if one exists for this), otherwise just note in security memory that Reditus webhook now requires signed requests.
