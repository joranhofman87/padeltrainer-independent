
# Subdomain Split: Marketing Website vs App

## Overview

This plan implements hostname-based routing to serve different experiences:
- **padeltrainer.ai** - Marketing website (home, pricing, trainers, locations, blog, etc.)
- **app.padeltrainer.ai** - Application (auth, dashboards, admin, player, trainer, club, academy)

Both will run from the same codebase with hostname detection at the router level.

---

## Architecture

```text
+---------------------------+     +---------------------------+
|    padeltrainer.ai        |     |   app.padeltrainer.ai     |
+---------------------------+     +---------------------------+
|                           |     |                           |
| /:lang/                   |     | /auth                     |
| /:lang/pricing            |     | /signup/*                 |
| /:lang/about              |     | /onboarding/*             |
| /:lang/trainers           |     | /player/*                 |
| /:lang/trainers/:city     |     | /trainer/*                |
| /:lang/trainer/:id        |     | /club/*                   |
| /:lang/locations          |     | /academy/*                |
| /:lang/locations/:slug    |     | /admin/*                  |
| /:lang/academies          |     | /settings/*               |
| /:lang/academies/:slug    |     | ...                       |
| /:lang/book/:trainerId    |     |                           |
| /:lang/blog               |     |                           |
| /:lang/privacy            |     |                           |
| /:lang/terms              |     |                           |
| /:lang/partner            |     |                           |
|                           |     |                           |
+---------------------------+     +---------------------------+
              |                               |
              +---------------+---------------+
                              |
                    Single Codebase
                    (Hostname Detection)
```

---

## Implementation Steps

### 1. Create Hostname Detection Hook

Create a new hook that detects whether we're on the marketing site or app subdomain:

**File: `src/hooks/useHostname.ts`**

This hook will:
- Detect `app.padeltrainer.ai` vs `padeltrainer.ai`
- Allow localhost development with query parameter override (`?app=true`)
- Expose `isAppDomain` and `isMarketingDomain` flags

### 2. Create Domain-Aware Router Component

Create a wrapper component that conditionally renders routes based on hostname:

**File: `src/components/DomainRouter.tsx`**

This component will:
- Use the hostname hook to determine which routes to render
- For marketing domain: render only public/marketing routes
- For app domain: render only authenticated/app routes
- Handle cross-domain redirects (e.g., login button on marketing site links to `app.padeltrainer.ai/auth`)

### 3. Update App.tsx

Modify the main App component to use the new DomainRouter:

- Wrap routes in a domain-aware conditional
- Marketing routes: `/`, `/:lang/*` (home, pricing, trainers, locations, etc.)
- App routes: `/auth`, `/signup/*`, `/player/*`, `/trainer/*`, `/club/*`, `/admin/*`, etc.

### 4. Update Cross-Domain Links

Update link components and navigation to use absolute URLs when crossing domains:

**Files to modify:**
- `src/components/marketing/MarketingLayout.tsx` - "Sign In" and "Get Started" buttons
- `src/pages/marketing/Home.tsx` - CTAs linking to signup
- Other marketing pages with auth links

**Pattern:**
```typescript
// Instead of: <Link to="/auth">
// Use: <a href="https://app.padeltrainer.ai/auth">
```

### 5. Update Auth Redirect URLs

Update OAuth and email verification callbacks to use the app subdomain:

**Files to modify:**
- `src/lib/auth.ts` - Update `window.location.origin` references to use app domain
- Edge functions that send emails with links

### 6. Update SEO Configuration

Update the SEO component to handle both domains correctly:

**File: `src/components/SEO.tsx`**

- Marketing pages use `https://padeltrainer.ai` as base URL
- App pages use `https://app.padeltrainer.ai` (with noindex for private pages)

### 7. Update Sitemap & robots.txt

**File: `supabase/functions/sitemap/index.ts`**

Keep sitemap pointing to marketing domain (padeltrainer.ai) - app pages should not be in sitemap.

**File: `public/robots.txt`**

Add rules for app subdomain to disallow indexing of authenticated routes.

### 8. Handle 404s per Domain

Update the NotFound page to redirect appropriately:
- Marketing 404 stays on marketing domain
- App 404 stays on app domain

---

## Technical Details

### Hostname Detection Logic

```typescript
// src/hooks/useHostname.ts
export function useHostname() {
  const hostname = window.location.hostname;
  
  // Production detection
  const isAppDomain = hostname === 'app.padeltrainer.ai';
  const isMarketingDomain = hostname === 'padeltrainer.ai' || 
                            hostname === 'www.padeltrainer.ai';
  
  // Development: allow override via query param or default to marketing
  const isLocalhost = hostname === 'localhost' || hostname === '127.0.0.1';
  const searchParams = new URLSearchParams(window.location.search);
  const forceApp = searchParams.get('app') === 'true';
  
  return {
    isAppDomain: isAppDomain || (isLocalhost && forceApp),
    isMarketingDomain: isMarketingDomain || (isLocalhost && !forceApp),
    hostname,
  };
}
```

### Cross-Domain Link Helper

```typescript
// src/lib/domains.ts
const APP_DOMAIN = 'https://app.padeltrainer.ai';
const MARKETING_DOMAIN = 'https://padeltrainer.ai';

export function getAppUrl(path: string): string {
  return `${APP_DOMAIN}${path}`;
}

export function getMarketingUrl(path: string, lang: string = 'nl'): string {
  return `${MARKETING_DOMAIN}/${lang}${path}`;
}
```

---

## Cookie & Auth Considerations

### Session Sharing

Supabase auth cookies are scoped to the domain. For seamless auth across subdomains:
- Supabase is already configured to use the root domain for cookies
- No additional configuration needed - sessions work across subdomains

### Redirect Flow

When a user clicks "Sign In" on marketing site:
1. User is redirected to `app.padeltrainer.ai/auth`
2. User logs in
3. User is redirected to their dashboard on app subdomain
4. If user goes back to marketing site, they're still logged in (shared session)

---

## Domain Setup in Lovable

After implementation, you'll need to configure both domains in Lovable:

1. **Primary domain**: `padeltrainer.ai` (marketing)
2. **Add subdomain**: `app.padeltrainer.ai` (app)

Both domains will serve the same project, but the routing logic will differentiate the experience.

---

## Files Summary

| Action | File |
|--------|------|
| Create | `src/hooks/useHostname.ts` |
| Create | `src/lib/domains.ts` |
| Create | `src/components/DomainRouter.tsx` |
| Modify | `src/App.tsx` |
| Modify | `src/components/marketing/MarketingLayout.tsx` |
| Modify | `src/pages/marketing/Home.tsx` |
| Modify | `src/pages/marketing/Pricing.tsx` |
| Modify | `src/pages/marketing/About.tsx` |
| Modify | `src/pages/marketing/Partner.tsx` |
| Modify | `src/lib/auth.ts` |
| Modify | `src/components/SEO.tsx` |
| Modify | `src/pages/NotFound.tsx` |
| Modify | `public/robots.txt` |
| Modify | Various edge functions with redirect URLs |

---

## Migration Steps

1. Implement hostname detection and routing changes
2. Test locally with `?app=true` query parameter
3. Connect `app.padeltrainer.ai` subdomain in Lovable settings
4. Verify both domains work correctly
5. Update DNS if needed (A record for app subdomain pointing to Lovable)
