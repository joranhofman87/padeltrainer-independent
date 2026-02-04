

# Fix Subscription Overlay Race Condition & Path

Two issues need fixing in `TrainerLayout.tsx`:

---

## Issue 1: Overlay Shows for Non-Trainers

The overlay renders immediately (sync) before the `useEffect` redirect (async) can navigate non-trainer users away.

**Fix**: Add `role === 'trainer'` guard to overlay condition

```tsx
// Line 92: Add role check
{!loading && role === 'trainer' && isSubscriptionExpired && !isOnSubscriptionPage && (
```

---

## Issue 2: Wrong Subscription Path

The subscription path points to `/subscription` which causes a 404.

**Fix**: Change to `/trainer/subscription`

```tsx
// Line 95: Fix path
subscriptionPath="/trainer/subscription"
```

---

## Changes Summary

| Line | Current | Fixed |
|------|---------|-------|
| 92 | `{!loading && isSubscriptionExpired && ...}` | `{!loading && role === 'trainer' && isSubscriptionExpired && ...}` |
| 95 | `subscriptionPath="/subscription"` | `subscriptionPath="/trainer/subscription"` |

---

## Files Modified

- `src/components/trainer/TrainerLayout.tsx` (2 line changes)

