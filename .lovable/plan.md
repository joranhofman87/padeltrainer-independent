

# Fix Two PageSpeed Insights SEO Issues

## Issue 1: `robots.txt` — "Content-Signal: search=yes,ai-train=no" unknown directive

This is **not in our codebase**. Cloudflare automatically injects a "Managed Content" block (including the `Content-Signal` directive) before our `robots.txt` content. Since Lighthouse doesn't recognize `Content-Signal`, it flags it as invalid.

**Fix**: This must be disabled in the **Cloudflare dashboard** under the domain's AI settings (Settings → Scrape Shield or AI → Content Signals). It cannot be fixed from the codebase. No code change needed here.

## Issue 2: Avatar images missing `alt` attributes

The Lighthouse screenshot shows an `<img>` tag from the avatar component without an `alt` attribute. Most `AvatarImage` usages across the codebase pass no `alt` prop — e.g., trainer avatars, player avatars, academy logos, sidebar avatars, review avatars.

**Fix**: Add a default `alt=""` fallback in the `AvatarImage` component so decorative avatars get an empty alt (valid for accessibility), and update key public-facing usages (trainer cards, location pages, review cards) to pass meaningful `alt` text with the person/entity name.

### Files to change

1. **`src/components/ui/avatar.tsx`** — Default `alt` to `""` in `AvatarImage` so no avatar ever renders without an `alt` attribute
2. **Key component files** (bulk find-and-replace pattern) — Add descriptive `alt` props where a name is available:
   - `src/components/reviews/ReviewCard.tsx` — `alt={reviewerName}`
   - `src/components/reviews/AcademyReviews.tsx` — same
   - `src/components/ProfileSwitcher.tsx` — `alt={profile name}`
   - `src/components/academy/AcademySidebar.tsx` — `alt={academy name}`
   - `src/components/booking/BookingTrainerCard.tsx` — `alt={trainer name}`
   - `src/components/cycles/ReassignPlayerDialog.tsx` — `alt={trainer name}`
   - `src/pages/LocationDetail.tsx` — `alt={trainer/academy name}`
   - `src/pages/academy/AcademyTrainers.tsx` — `alt={trainer name}`
   - `src/pages/TrainerBookings.tsx` — `alt={player name}`

This is a straightforward change: the `AvatarImage` default ensures zero regressions for any usage we miss, while explicit `alt` text on public pages improves SEO and accessibility.

