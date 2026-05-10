# Short share links for trainers and academies

Goal: every trainer and academy gets a short, clean URL like `padeltrainer.ai/<handle>` that resolves to their existing public profile. Auto-generated, unique, non-customizable for now, surfaced in-product so they can copy and share.

## How it works

- `trainer_profiles.slug` and `academy_profiles.slug` already exist and are unique within each table. We reuse those values as the handle and add a tiny layer that:
  1. Guarantees handles are unique **across both tables and not colliding with reserved top-level paths**.
  2. Resolves `/<handle>` to the right profile.
- The short URL is a public-facing alias. The canonical pages (`/trainer/:slug` and `/academies/:slug`) keep working unchanged, so existing SEO, share cards, and inbound links are not disturbed.

## 1. Reserved-word + cross-table uniqueness

- Add a database helper `generate_unique_public_handle(_owner_type text, _owner_id uuid, _name text)` that:
  - Slugifies the name (same rules as today).
  - Rejects empty/numeric-only inputs and a hard-coded reserved list: `app, api, pay, auth, signup, login, onboarding, admin, trainer, trainers, academy, academies, club, clubs, locations, location, book, register, claim, playground, learn, learning, topics, blog, padel, padel-strokes, padel-coaches, video-tips, gear, brand, partner, privacy, terms, founding-trainers, rating, sitemap, robots, llms`.
  - Checks both `trainer_profiles.slug` and `academy_profiles.slug` (excluding the current row) and appends `-2`, `-3`, … on collision.
- Replace today's `generate_unique_trainer_slug` calls and the equivalent academy slug logic so new trainer/academy slugs go through the new helper. Existing slugs stay as-is unless they collide with a reserved word; for those (rare) cases run a one-off backfill that renames them with a numeric suffix and writes the old slug into a `slug_redirects` table so old links keep working.
- Optional small `slug_redirects(old_slug text primary key, owner_type text, owner_id uuid)` table to support any future renames cleanly.

## 2. Public route `/<handle>`

- Add a new lazy page `ShortLinkResolver` mounted at the very end of the marketing route block in `src/components/DomainRouter.tsx`, after every existing static path:
  ```
  <Route path=":handle" element={<ShortLinkResolver />} />
  ```
- `ShortLinkResolver` does a single combined lookup: query `trainer_profiles_safe` by slug, then `academy_profiles` by slug, then the `slug_redirects` fallback. On hit, it `<Navigate replace>` to the canonical `/trainer/<slug>` or `/academies/<slug>` (preserving the language prefix via `localizePath`). On miss, it renders the existing `<NotFound />`.
- Because this route lives inside the `LanguageRouter` block, it naturally supports `/<lang>/<handle>` too.
- A small client-side reserved-word guard in the resolver short-circuits to `<NotFound />` so accidental typos like `/admin` never hit the database.

## 3. Crawler/SSR + sitemap

- `supabase/functions/render-page` currently renders meta for known patterns. Extend its router to recognise `/<handle>` and a few reserved-prefix exclusions; on match it resolves the handle exactly like the client and emits the same OG/meta tags as the canonical profile, plus a `<link rel="canonical">` pointing at `/trainer/<slug>` or `/academies/<slug>`. This keeps social previews working when someone pastes a short link into LinkedIn/WhatsApp.
- `supabase/functions/sitemap` keeps emitting only the canonical URLs. Short URLs are intentionally left out of the sitemap (they are 301-style aliases, and Google only needs the canonical).
- `public/llms.txt` is unaffected (also canonical only).
- No change to the Cloudflare worker beyond what render-page already handles, since the worker proxies bot traffic into render-page based on path.

## 4. In-product surfacing

Trainers and academies need to see and copy their short link. Add a reusable `ShareableProfileLink` component (input + copy button + small "Share" dropdown with `navigator.share`, X/LinkedIn/WhatsApp/email intents) and place it:

- **Trainer side**
  - Top of `EditProfile` (trainer view) under the avatar.
  - In the trainer dashboard "Share your profile" widget (replaces today's long URL display).
  - In the public-profile preview card on `TrainerGetStarted`.
- **Academy side**
  - Top of `AcademyProfile` (settings page).
  - On `AcademyDashboard` next to the existing "View public profile" button.

Copy text shows the host without scheme: `padeltrainer.ai/jan-de-vries`. Underlying value copied to clipboard is the full `https://padeltrainer.ai/jan-de-vries` (or the active custom/preview host) so it pastes correctly anywhere.

A small helper `getShortProfileUrl(slug)` centralises host detection so the short URL works on `padeltrainer.ai`, custom domains, and the preview environment.

## 5. Out of scope (explicitly)

- No user-editable handles. The slug stays read-only in the UI; if a rename is ever needed it is admin-only and handled through `slug_redirects`.
- No vanity-handle marketplace, no reservations, no profanity filter beyond the reserved-word list above.
- No analytics/click tracking on the short link in this iteration. PostHog already fires `trainer_profile_viewed` / `academy_profile_viewed` on the canonical page that the redirect lands on, which is enough to measure reach.

## Files touched

- DB migration: new `generate_unique_public_handle` function, `slug_redirects` table, backfill query, swap-in for trainer/academy slug triggers.
- `src/components/DomainRouter.tsx`: add `:handle` catch-all + lazy `ShortLinkResolver`.
- New `src/pages/ShortLinkResolver.tsx`.
- New `src/components/profile/ShareableProfileLink.tsx` + small `lib/shortUrl.ts` helper.
- `src/pages/EditProfile.tsx`, `src/pages/trainer/TrainerGetStarted.tsx` (or wherever the trainer dashboard share block lives), `src/pages/academy/AcademyProfile.tsx`, `src/pages/academy/AcademyDashboard.tsx`: mount the share component.
- `supabase/functions/render-page/index.ts`: handle `/<handle>` for crawlers with a canonical link tag.
- Translations: add keys for "Your share link", "Copy link", "Share on …".
