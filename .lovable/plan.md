

# Plan: Reset Admin Password via Backend

## Problem

The admin user (`info@padeltrainer.ai`) password is unknown, and the email reset flow isn't working. The existing `admin-reset-password` edge function requires admin authentication and blocks resetting other admin passwords.

## Solution

I'll create a temporary edge function that can reset the admin password using the service role key, bypassing the authentication requirement. After the password is reset, you should delete or disable this function for security.

## Implementation

### New Edge Function: `bootstrap-admin-password`

**File:** `supabase/functions/bootstrap-admin-password/index.ts`

This function will:
1. Accept a secret key (must match a secret we set) to prevent unauthorized use
2. Look up the admin user by email
3. Reset their password to a new value you provide
4. Return success

```typescript
// Simplified logic:
// 1. Verify bootstrap secret matches environment variable
// 2. Find user by email
// 3. Use auth.admin.updateUserById to set new password
// 4. Return success
```

### Configuration

**File:** `supabase/config.toml` (add entry)
```toml
[functions.bootstrap-admin-password]
verify_jwt = false
```

### Security Measures

- Requires a `BOOTSTRAP_SECRET` that only you know
- Function should be deleted after use
- Logs the action for audit purposes

## Usage After Implementation

You'll call the function directly with:
```bash
curl -X POST "https://ppkbhdiiqdusdeatgdft.supabase.co/functions/v1/bootstrap-admin-password" \
  -H "Content-Type: application/json" \
  -d '{"secret": "YOUR_BOOTSTRAP_SECRET", "email": "info@padeltrainer.ai", "new_password": "YourNewSecurePassword123!"}'
```

Or I can test it for you using the edge function testing tool after deployment.

## Files to Create/Modify

| File | Change |
|------|--------|
| `supabase/functions/bootstrap-admin-password/index.ts` | New temporary edge function |
| `supabase/config.toml` | Add function config with `verify_jwt = false` |

## Post-Reset Cleanup

After successfully resetting the password:
1. Delete `supabase/functions/bootstrap-admin-password/index.ts`
2. Remove entry from `supabase/config.toml`

This ensures no security vulnerability remains.

