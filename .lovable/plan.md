
# Fix Cross-Domain Booking: Move BookLesson to App Domain

## Problem

The booking flow is broken for logged-in players because of a **cross-domain session issue**:

1. Player logs in on `app.padeltrainer.ai` -- session stored in that domain's localStorage
2. Player browses trainers on `padeltrainer.ai` (marketing site) -- no session here (different domain = different localStorage)
3. Player clicks "Book Lesson" which loads `BookLesson` on the marketing domain
4. `BookLesson` calls `useAuth()`, finds no user, redirects to `/auth`
5. `/auth` on marketing domain redirects to `app.padeltrainer.ai/auth` via `RedirectToAppDomain`
6. User is already logged in there -- circular frustration

The booking page requires authentication but lives on the marketing domain where auth sessions don't exist. This is a fundamental architecture mismatch.

## Solution

Move the booking flow to the **app domain** (`app.padeltrainer.ai`). The "Book Lesson" button on the marketing site trainer profile should link to `app.padeltrainer.ai/book/:trainerId` instead of staying on the marketing domain.

### File 1: `src/components/DomainRouter.tsx`

**Add** `/book/:trainerId` route to `AppRoutes`:
```text
<Route path="/book/:trainerId" element={<BookLesson />} />
```

**Add** a redirect in `MarketingRoutes` so `/book/*` on the marketing domain redirects to the app domain (like `/auth` does):
```text
<Route path="/book/*" element={<RedirectToAppDomain path="/book" />} />
```

Also add it to `CombinedRoutes` (dev mode) as a standalone route before the `/:lang` block.

### File 2: `src/pages/TrainerProfile.tsx`

Update the "Book Lesson" button to navigate to the app domain instead of using `localizePath`:
```text
Before:  navigate(localizePath(`/book/${trainerId}`))
After:   window.location.href = getAppUrl(`/book/${trainerId}`)
```

This uses the existing `getAppUrl` helper which returns relative paths in development and full `https://app.padeltrainer.ai/...` URLs in production.

### File 3: `src/pages/PlayerDashboard.tsx`

Update the trainer card click to use `/book/:trainerId` directly (already on the app domain, so just `navigate`):
```text
Before:  navigate(localizePath(`/book/${trainer.id}`))
After:   navigate(`/book/${trainer.id}`)
```

### File 4: `src/pages/BookLesson.tsx`

Update the auth redirect to use `/auth` with a return URL so users are sent back after login:
```text
Before:  navigate('/auth')
After:   navigate(`/auth?redirect=/book/${trainerId}`)
```

Remove the `localizePath` usage since the page now lives on the app domain (no language prefix needed).

### File 5: `src/components/DomainRouter.tsx` (RedirectToAppDomain)

Update `RedirectToAppDomain` to pass through the full path including params:
```text
// For /book/abc123 on marketing domain -> redirect to app.padeltrainer.ai/book/abc123
```

## Summary

| File | Change |
|------|--------|
| `src/components/DomainRouter.tsx` | Add `/book/:trainerId` to AppRoutes; add marketing redirect for `/book/*` |
| `src/pages/TrainerProfile.tsx` | Use `getAppUrl` for book button to navigate cross-domain |
| `src/pages/PlayerDashboard.tsx` | Use simple `/book/` path (already on app domain) |
| `src/pages/BookLesson.tsx` | Remove `localizePath`; fix auth redirect to include return URL |

This ensures the booking page always runs on the app domain where the user's session exists.
