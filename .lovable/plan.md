

## Filter PostHog to Production Domain Only

### Problem
The production check in `src/lib/posthog.ts` excludes `lovable.app` and `localhost`, but the Lovable preview runs on `lovableproject.com` -- which is not blocked. This means PostHog captures events from preview sessions, polluting your analytics.

### Solution
Instead of a blocklist (which breaks every time a new non-production domain appears), switch to an **allowlist** that only initializes PostHog on your actual production domain: `padeltrainer.ai`.

### Technical Details

**File:** `src/lib/posthog.ts`, line 11-12

Change:
```typescript
const isProduction = !window.location.hostname.includes('lovable.app')
  && !window.location.hostname.includes('localhost');
```

To:
```typescript
const isProduction = window.location.hostname === 'padeltrainer.ai'
  || window.location.hostname.endsWith('.padeltrainer.ai');
```

This ensures PostHog only fires on `padeltrainer.ai` (and any future subdomains). All other environments -- Lovable preview, lovableproject.com, localhost, staging -- are automatically excluded. One line change, no other files affected.
