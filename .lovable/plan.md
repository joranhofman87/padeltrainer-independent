

# Fix Notification Settings Route for Trainer Profile

## Problem
The notification settings card in `TrainerSettings.tsx` links to `/settings/notifications` instead of `/trainer/settings/notifications`. This means clicking it navigates to a non-existent route, showing a blank/broken page.

Other settings cards correctly use the `/trainer/...` prefix (e.g., `/trainer/profile`, `/trainer/settings/bookings`).

## Fix

| File | Change |
|------|--------|
| `src/pages/TrainerSettings.tsx` | Line 222: Change `route: '/settings/notifications'` → `route: '/trainer/settings/notifications'` |

One-line fix — aligns with the existing routing pattern used by the other settings cards.

