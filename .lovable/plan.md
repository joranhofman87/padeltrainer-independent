

# Reduce Subscription Polling Intervals

Change the subscription polling in `AcademyLayout.tsx` and `ClubLayout.tsx` from 60 seconds to 5 minutes to match `useAuth.tsx`.

| File | Change |
|---|---|
| `src/components/academy/AcademyLayout.tsx` (~line 113) | `setInterval(fetchSubscription, 60000)` → `setInterval(fetchSubscription, 5 * 60 * 1000)` |
| `src/components/club/ClubLayout.tsx` | Same change: 60s → 5min interval |

