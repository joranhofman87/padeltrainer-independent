
# Add Token Refresh to Payment Function

## Problem

The trainer's Mollie OAuth access token is likely expired or invalidated. While the `check-mollie-connect-status` function has token refresh logic, the `create-mollie-payment` function does not -- it just uses whatever token is stored in the database. An invalid token causes Mollie to return a 404.

## Fix

### `supabase/functions/create-mollie-payment/index.ts`

Copy the same `refreshTokenIfNeeded` function from `check-mollie-connect-status` into `create-mollie-payment`, and call it before making the Mollie API request.

**1. Add the `refreshTokenIfNeeded` function** (same logic as in `check-mollie-connect-status`):
- Checks if the token expires within 5 minutes
- If so, uses the refresh token to get a new access token from Mollie
- Updates the database with the new tokens
- Returns the valid access token

**2. Fetch full account data** (including `token_expires_at` and `refresh_token`) from `trainer_mollie_accounts` and `academy_mollie_accounts` instead of just `access_token` and `mollie_organization_id`.

**3. Call `refreshTokenIfNeeded`** after finding the Mollie account but before building the payment request. Use the refreshed token for the Mollie API call.

This ensures every payment attempt uses a valid, non-expired token.

## Files changed

- `supabase/functions/create-mollie-payment/index.ts` -- add token refresh logic, fetch full token data
