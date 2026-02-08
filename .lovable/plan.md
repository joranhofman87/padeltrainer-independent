
# Add PostHog Analytics (Cookieless Mode)

## What changes
Add PostHog analytics that loads for **all visitors** without requiring cookie consent. This runs alongside the existing Google Analytics (which stays behind the consent banner). You'll get full traffic visibility from day one.

PostHog in cookieless mode uses no cookies and stores nothing persistently in the browser, so it's GDPR-compliant without consent.

## Setup steps

### 1. Get your PostHog API key
- Sign up at [posthog.com](https://posthog.com) (free tier: 1M events/month)
- Go to Project Settings and copy your **Project API Key** (it's a public key, safe to use in frontend code)
- Note your **PostHog host** (usually `https://eu.i.posthog.com` for EU data residency -- recommended for a Netherlands-based site)

### 2. You'll be asked to provide the PostHog key
Since this is a **public/publishable** key, it will be stored directly in the code (not as a secret).

## Technical Details

### New file: `src/lib/posthog.ts`
Initialize PostHog with cookieless settings:
- `persistence: 'memory'` -- no cookies, no localStorage
- `disable_cookie: true`
- `disable_persistence: true`
- SPA page-view tracking on route changes

### Modified file: `src/main.tsx`
Import and call `initializePostHog()` at app startup (no consent check needed).

### Modified file: `src/lib/analytics.ts`
Add a `trackPageView()` helper that fires to both PostHog (always) and GA (when consented). Add SPA route tracking via a React hook or history listener.

### New file: `src/hooks/usePageTracking.ts`
A React hook using `useLocation()` from react-router to track page views on every route change -- fires to PostHog unconditionally and to GA only if consented.

### Modified file: `src/App.tsx`
Add the `usePageTracking()` hook inside the router to capture all navigation.

### Dependencies
- Install `posthog-js` package

No database changes needed. No backend changes needed.
