
# Remove Google Analytics, TradeTracker, and Cookie Banner

## What changes
Since PostHog (cookieless) now handles all traffic analytics, there's no remaining reason for Google Analytics, TradeTracker, or the cookie consent system. Removing all of them simplifies the codebase and eliminates the consent banner entirely.

## Files to delete
- `src/lib/analytics.ts` -- GA + TradeTracker initialization
- `src/contexts/CookieConsentContext.tsx` -- Cookie consent state management
- `src/components/CookieConsentBanner.tsx` -- The banner UI and customize dialog

## Files to modify

### `src/main.tsx`
- Remove `import { initializeAnalytics }` and the `initializeAnalytics()` call

### `src/App.tsx`
- Remove `CookieConsentProvider` wrapper
- Remove `CookieConsentBanner` component
- Remove their imports

## Translation keys to clean up
Remove the `cookies.*` keys from:
- `src/i18n/locales/en/common.json`
- `src/i18n/locales/nl/common.json`

## What stays
- **PostHog** (`src/lib/posthog.ts`) -- cookieless, always loads, no consent needed
- **PageTracker** (`src/components/PageTracker.tsx`) -- SPA route tracking via PostHog
- **Privacy page** -- still accessible, just no longer linked from the cookie banner

## Summary
| Before | After |
|--------|-------|
| GA + TradeTracker (behind consent) | Removed |
| PostHog (cookieless) | Stays |
| Cookie consent banner | Removed |
| 3 extra files + context provider | Gone |
