
# Fix Marketing Sign-In Button Navigation

## Problem
The "Sign In" button on the marketing site (`padeltrainer.ai`) navigates to `/auth` on the same domain instead of redirecting to the app subdomain (`app.padeltrainer.ai/auth`), causing a redirect loop.

## Root Cause
The `isInDevelopment()` function may be returning unexpected values, or the conditional rendering is not working as expected in production. The current approach relies on correctly detecting the environment, which can be fragile.

## Solution
Use a more robust approach: **always render external links for auth routes on the marketing site**, regardless of environment detection. This simplifies the logic and ensures proper cross-domain navigation.

---

## Changes Required

### 1. Update MarketingLayout.tsx
Replace the conditional `isInDevelopment()` check with domain-aware linking that always uses external URLs for auth routes:

**Current code:**
```tsx
<Button variant="ghost" asChild>
  {isInDevelopment() ? (
    <Link to="/auth">Sign In</Link>
  ) : (
    <a href={getAppUrl('/auth')}>Sign In</a>
  )}
</Button>
```

**New code:**
```tsx
<Button variant="ghost" asChild>
  <a href={getAppUrl('/auth')}>{t('nav.signIn')}</a>
</Button>
```

This applies to:
- Desktop "Sign In" button (line 79-85)
- Desktop "Get Started" button (line 86-92)
- Mobile "Sign In" button (line 133-139)
- Mobile "Get Started" button (line 140-146)
- Footer "Register your club" link (line 182-186)

### 2. Update getAppUrl function (optional improvement)
Make `getAppUrl` environment-aware to return relative paths in development:

```typescript
export function getAppUrl(path: string): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  
  // In development, use relative paths for same-origin navigation
  if (isInDevelopment()) {
    return normalizedPath;
  }
  
  // In production, always use full app subdomain URL
  return `${APP_DOMAIN}${normalizedPath}`;
}
```

---

## Result
| Environment | Sign In Link |
|-------------|--------------|
| `padeltrainer.ai` | `https://app.padeltrainer.ai/auth` |
| `localhost` | `/auth` |
| `*.lovable.app` | `/auth` |

The marketing site will correctly redirect to the app subdomain for authentication in production, while development/preview environments will continue using relative paths for easier testing.
