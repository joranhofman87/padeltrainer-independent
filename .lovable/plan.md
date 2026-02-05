

# Fix Mollie Connection: Full Reconnection Flow

## Overview

Reset the stuck trainer record and fix the redirect URI mismatch so the OAuth flow works correctly on retry.

## Changes

### 1. Database Migration - Reset Trainer's Mollie Account

Clear the pending state so the trainer can reconnect:

```sql
UPDATE trainer_mollie_accounts 
SET 
  mollie_organization_id = NULL,
  access_token = NULL,
  refresh_token = NULL,
  token_expires_at = NULL,
  onboarding_complete = false,
  charges_enabled = false,
  payouts_enabled = false,
  updated_at = NOW()
WHERE trainer_id = 'dc4abd48-3b65-477e-a2fe-aa512217115e';
```

### 2. Fix Redirect URI in Edge Function

**File:** `supabase/functions/mollie-callback/index.ts`

The current code dynamically builds the redirect URI from the request origin header, which may not match what was registered with Mollie. Hardcode the production URI:

```typescript
// Before (line 74):
const origin = req.headers.get("origin") || "https://app.padeltrainer.ai";
const redirectUri = `${origin}/api/mollie-callback`;

// After:
const redirectUri = 'https://app.padeltrainer.ai/api/mollie-callback';
```

### 3. Add Debug Logging to Callback Page

**File:** `src/pages/MollieCallback.tsx`

Add logging before the edge function call to help debug future issues:

```typescript
// Add after line 23 (before the try block):
console.log('[MollieCallback] Processing callback:', { 
  hasCode: !!code, 
  statePrefix: state?.substring(0, 30),
  origin: window.location.origin 
});
```

## Expected Result

1. Trainer's record is reset to allow fresh OAuth connection
2. Redirect URI will always match Mollie's registered callback URL
3. Future debugging will be easier with console logs
4. Trainer can retry connecting Mollie from `/trainer/earnings`

