# Restrict `testEmail` in `send-invoice-email` to the caller's own email

## Problem

`supabase/functions/send-invoice-email/index.ts` accepts an arbitrary `testEmail` from the request body and sends a real (PDF-attached) invoice email from `noreply@app.padeltrainer.ai` to that address. Any authenticated user could send "[TEST] Invoice" emails from our domain to any recipient — phishing-from-our-domain risk.

## Fix

Validate that `testEmail`, when provided, matches the authenticated caller's own email address. Reject mismatches with 403.

### Change (single file)

`supabase/functions/send-invoice-email/index.ts`

1. When loading the user (around line 41), also capture `user.email` into `authenticatedUserEmail`.
2. Right after parsing `testEmail` (line 60), add:
   - If `testEmail` is set and `isServiceRole` is false:
     - Normalize both sides (`trim().toLowerCase()`).
     - If `authenticatedUserEmail` is missing or doesn't match, return `403 { error: "test_email_must_match_caller" }`.
   - Service-role calls remain unrestricted (internal/admin tooling).

No other behavior changes. `previewOnly` (which doesn't actually send) is unaffected.

## Out of scope

- No UI changes. The existing "send test" UI already uses the logged-in user's email by default; this just enforces it server-side.
- No changes to non-test sends (those go to the invoice's resolved recipient).
