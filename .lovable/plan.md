

# Filter PostHog to Production Only

## What changes
PostHog will only initialize and track events on your real production domain, skipping all Lovable preview/staging URLs. This means your PostHog dashboard will only show real user traffic.

## How it works
In `src/lib/posthog.ts`, add a hostname check before initializing. If the current hostname includes `lovable.app` or `localhost`, PostHog won't load at all.

## Technical Details

### Modified file: `src/lib/posthog.ts`

Add a check at the top of `initializePostHog()`:

```typescript
const isProduction = !window.location.hostname.includes('lovable.app') 
  && !window.location.hostname.includes('localhost');

if (!isProduction) return;
```

This prevents `posthog.init()` from ever being called on preview/dev URLs. The `trackPostHogPageView` function already guards on `isInitialized`, so it will silently no-op as well.

### No other files need changes
The `PageTracker` component and `usePageTracking` hook remain unchanged -- they simply won't fire events since PostHog won't be initialized.

