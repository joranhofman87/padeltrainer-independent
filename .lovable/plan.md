
# Fix Redirect Loop on Production Domain

## Problem Analysis

When navigating to `/auth` on `padeltrainer.ai`, users get stuck in a redirect loop. This happens because:

1. **Route Order Issue**: In `MarketingRoutes`, the `/:lang` route (line 107) comes **before** the explicit `/auth` route (line 128)
2. **React Router Matching**: Routes match in order, so `/:lang` catches `/auth` first, treating "auth" as a language parameter
3. **Invalid Language Redirect**: `LanguageRouter` detects "auth" is not a valid language and redirects to `/nl/auth`
4. **Loop Created**: `/nl/auth` has no matching nested route, causing unexpected behavior or loops

This works in preview because `CombinedRoutes` is used (where app routes come first), but fails in production where `MarketingRoutes` is used.

---

## Solution

Move the app route redirects **before** the `/:lang` catch-all route in `MarketingRoutes`.

---

## Code Changes

**File: `src/components/DomainRouter.tsx`**

Reorder routes in `MarketingRoutes` function:

```text
function MarketingRoutes() {
  return (
    <Routes>
      {/* Root redirect - detects browser language */}
      <Route path="/" element={<RootRedirect />} />
      
      {/* App route redirects - MUST come before /:lang to avoid being caught */}
      <Route path="/auth" element={<RedirectToAppDomain path="/auth" />} />
      <Route path="/forgot-password" element={<RedirectToAppDomain path="/forgot-password" />} />
      <Route path="/reset-password" element={<RedirectToAppDomain path="/reset-password" />} />
      <Route path="/signup/*" element={<RedirectToAppDomain path="/signup" />} />
      <Route path="/onboarding/*" element={<RedirectToAppDomain path="/onboarding" />} />
      <Route path="/select-role" element={<RedirectToAppDomain path="/select-role" />} />
      <Route path="/player/*" element={<RedirectToAppDomain path="/player" />} />
      <Route path="/trainer/*" element={<RedirectToAppDomain path="/trainer" />} />
      <Route path="/club/*" element={<RedirectToAppDomain path="/club" />} />
      <Route path="/academy/*" element={<RedirectToAppDomain path="/academy" />} />
      <Route path="/admin/*" element={<RedirectToAppDomain path="/admin" />} />
      <Route path="/profile/*" element={<RedirectToAppDomain path="/profile" />} />
      <Route path="/lessons" element={<RedirectToAppDomain path="/lessons" />} />
      <Route path="/bookings" element={<RedirectToAppDomain path="/bookings" />} />
      <Route path="/booking-success" element={<RedirectToAppDomain path="/booking-success" />} />
      <Route path="/earnings" element={<RedirectToAppDomain path="/earnings" />} />
      <Route path="/subscription" element={<RedirectToAppDomain path="/subscription" />} />
      <Route path="/analytics" element={<RedirectToAppDomain path="/analytics" />} />
      <Route path="/settings/*" element={<RedirectToAppDomain path="/settings" />} />
      <Route path="/availability" element={<RedirectToAppDomain path="/availability" />} />
      <Route path="/schedule" element={<RedirectToAppDomain path="/schedule" />} />
      <Route path="/trainer-bookings" element={<RedirectToAppDomain path="/trainer-bookings" />} />
      
      {/* Language-prefixed marketing routes - MUST come after app routes */}
      <Route path="/:lang" element={<LanguageRouter />}>
        {/* ... existing marketing routes ... */}
      </Route>
      
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
```

---

## Routes to Add

The current `MarketingRoutes` is missing redirects for several app routes that exist in `CombinedRoutes`:

| Route | Description |
|-------|-------------|
| `/forgot-password` | Password recovery |
| `/reset-password` | Password reset |
| `/onboarding/*` | Role-specific onboarding |
| `/select-role` | Role selection |
| `/profile/*` | Profile editing |
| `/lessons` | Lesson management |
| `/bookings` | Player bookings |
| `/booking-success` | Booking confirmation |
| `/earnings` | Trainer earnings |
| `/subscription` | Subscription management |
| `/analytics` | Trainer analytics |
| `/settings/*` | Notification/calendar settings |
| `/availability` | Legacy availability route |
| `/schedule` | Legacy schedule route |
| `/trainer-bookings` | Trainer bookings |

---

## Why This Fixes the Issue

1. **Route Priority**: App routes like `/auth` are now matched **before** the `/:lang` catch-all
2. **Proper Redirect**: When a user visits `padeltrainer.ai/auth`, they're immediately redirected to `app.padeltrainer.ai/auth`
3. **No Language Confusion**: The path `/auth` is never interpreted as a language parameter

---

## Testing

After implementation, verify:
1. `padeltrainer.ai/auth` → redirects to `app.padeltrainer.ai/auth`
2. `padeltrainer.ai/signup/player` → redirects to `app.padeltrainer.ai/signup/player`
3. `padeltrainer.ai/trainer` → redirects to `app.padeltrainer.ai/trainer`
4. `padeltrainer.ai/nl/pricing` → works normally (marketing page)
5. `padeltrainer.ai/en` → works normally (marketing home)
