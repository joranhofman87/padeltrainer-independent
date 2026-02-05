

# Mollie OAuth Callback URL Configuration

## Current Behavior

The edge functions already correctly build the redirect URI:

```typescript
const origin = req.headers.get("origin") || "https://app.padeltrainer.ai";
const redirectUri = `${origin}/api/mollie-callback`;
```

- **From preview**: Uses `https://id-preview--*.lovable.app/api/mollie-callback`
- **From production**: Uses `https://app.padeltrainer.ai/api/mollie-callback`

## Implementation Required

### 1. Create Frontend Callback Page

**File:** `src/pages/MollieCallback.tsx`

Handles the OAuth return, calls the edge function, and redirects to settings.

### 2. Register Route

**File:** `src/components/DomainRouter.tsx`

Add `/api/mollie-callback` route for both app and development modes.

---

## Mollie Dashboard Configuration Required

You must register **all** redirect URIs in your Mollie Dashboard (App Settings → Redirect URIs):

| Environment | Redirect URI |
|------------|--------------|
| **Production** | `https://app.padeltrainer.ai/api/mollie-callback` |
| **Preview** | `https://id-preview--f04c6cfe-e2a8-41a5-974c-e82c2372539e.lovable.app/api/mollie-callback` |

Mollie requires exact URL matching - each preview URL needs to be registered if you want to test there.

---

## Files to Create/Modify

| File | Change |
|------|--------|
| `src/pages/MollieCallback.tsx` | **Create** - Handle OAuth callback |
| `src/components/DomainRouter.tsx` | Add `/api/mollie-callback` route |

---

## Alternative: Fixed Production-Only Callback

If you prefer to **always** use the production URL (even when testing from preview), we can modify the edge functions to hardcode the redirect URI:

```typescript
// Always use production URL regardless of origin
const redirectUri = "https://app.padeltrainer.ai/api/mollie-callback";
```

This simplifies Mollie configuration (only one URL to register) but means you'd need to test OAuth flows against production.

**Recommendation**: Keep dynamic origin for flexibility in development, and register both URLs in Mollie.

