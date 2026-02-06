

# Fix: Admin Dashboard "No data available"

## Problem

The `get-admin-stats` backend function has never been deployed. The admin dashboard calls it to fetch platform statistics, but since it doesn't exist on the server, the call fails silently and the dashboard shows "No data available."

## Solution

1. **Deploy the `get-admin-stats` edge function** so the admin dashboard can fetch statistics.

2. **Add error visibility to `AdminDashboard.tsx`** -- currently when the query fails, it shows "No data available" with no error details. We should show the actual error message so issues are easier to diagnose in the future.

## Changes

| Item | Change |
|------|--------|
| Deploy `get-admin-stats` | Deploy the existing backend function so the dashboard can call it |
| `src/pages/AdminDashboard.tsx` | Show error state with message when the stats query fails, instead of silent "No data available" |

The dashboard code change is small: use the `error` property from `useAdminStats()` and display it when present.

