

# Fix Infinite Loading When Navigating Back (Player Routes)

## Problem

When a player logs in, browses trainers, and navigates back, the app gets stuck loading. The root cause is that nearly all navigation links in the player area use paths **without** the required `/app/` prefix (e.g., `/player` instead of `/app/player`).

Every click triggers a redirect chain: `/player` hits a legacy redirect rule, which then redirects to `/app/player`. This double-navigation causes React components to unmount and remount, re-triggering data fetches and auth checks, which can result in stuck loading states -- especially when combined with browser back/forward navigation.

## Changes

### 1. `src/components/player/PlayerSidebar.tsx`

Update all `NavLink` `to` props and `isActive` checks to include the `/app/` prefix:

- `/player` becomes `/app/player` (Dashboard link, line 147)
- `/player/bookings` becomes `/app/player/bookings` (line 162)
- `/player/following` becomes `/app/player/following` (line 177)
- `/player/settings` becomes `/app/player/settings` (lines 58, 74, 198, 217)
- `/player/settings/notifications` becomes `/app/player/settings/notifications` (line 229)
- `/player/settings/calendar` becomes `/app/player/settings/calendar` (line 240)
- Logout: `/auth` becomes `/app/auth` (line 70)

### 2. `src/pages/BookLesson.tsx`

Fix hardcoded navigation paths in the "Trainer not found" and "Request Sent" fallback screens:

- `/player` becomes `/app/player` (lines 574, 596)
- `/player/bookings` becomes `/app/player/bookings` (line 593)

### 3. `src/components/marketing/MarketingLayout.tsx`

The "Dashboard" button always links to `/app/player` regardless of user role (line 83). Update to route based on the user's actual role so trainers, clubs, and academy managers land on the correct dashboard.

## Why This Fixes It

Removing the redirect chain means React Router performs a single direct navigation instead of two. Components stay mounted, auth state remains stable, and data fetches don't get interrupted or duplicated. Browser back/forward navigation works cleanly because the history entries point to the correct final URLs.

