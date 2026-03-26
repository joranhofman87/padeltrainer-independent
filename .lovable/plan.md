

# Replace Rate Limiter with Better Spam Prevention

## Problem
The current rate limit (max 3 submissions per hour per email) blocks legitimate use — families registering multiple members back-to-back. The frontend already has a honeypot field + 2-second timing check (`useHoneypot`), but the edge function has its own server-side rate limit that's too aggressive.

## Approach

**Remove** the per-email rate limit from `submit-guest-intake/index.ts` (lines 50-63).

**Add server-side spam checks** that don't block legitimate family registrations:

1. **IP-based rate limit** — limit to 15 submissions per hour per IP (catches automated spam without blocking family registrations from the same email)
2. **Duplicate submission check** — reject exact same email + cycle_id combination submitted within 60 seconds (prevents accidental double-clicks, not intentional re-registrations)

The existing frontend honeypot + timing check remains as first line of defense.

## Changes

| File | Change |
|------|--------|
| `supabase/functions/submit-guest-intake/index.ts` | Remove email-based rate limit (lines 50-63). Add: (1) duplicate check — reject same email+cycle within 60s; (2) IP-based rate limit — max 15/hour per IP using `x-forwarded-for` header |

