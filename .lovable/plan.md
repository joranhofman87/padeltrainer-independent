## Goal

Add real, social-friendly short links for both academies and trainers, then surface them in the dashboard share cards instead of the long localized URLs.

- `padeltrainer.ai/a/{slug}` → academy public profile
- `padeltrainer.ai/t/{slug}` → trainer public profile

## Changes

### 1. New short-link routes in `DomainRouter.tsx`

Add two unlocalized routes mounted outside the `:lang` block so they work on bare `padeltrainer.ai/...`:

```
/a/:slug  →  <Navigate to={`/${lang}/academies/${slug}`} replace />
/t/:slug  →  <Navigate to={`/${lang}/trainer/${slug}`} replace />
```

Implemented as tiny `ShortLinkRedirect` components that read `:slug` and the current i18n language (fallback `nl`). The trainer profile route already accepts a slug in place of an id (`/trainer/:trainerId` resolves by slug), so no backend lookup is needed.

### 2. Helpers in `src/lib/domains.ts`

Add:
- `getAcademyShortUrl(slug)` → `${MARKETING_DOMAIN}/a/${slug}`
- `getTrainerShortUrl(slug)` → `${MARKETING_DOMAIN}/t/${slug}`

Plus matching unit tests in `domains.test.ts`.

### 3. `ShareableProfileLink` accepts a short URL

Update `src/components/profile/ShareableProfileLink.tsx`:
- New optional `shortUrl?: string` prop.
- When provided, the displayed / copied / shared value is `shortUrl`. Display still strips `https://` so the row stays compact.
- When omitted, current behaviour is unchanged (so anything else using the component keeps working).

### 4. Wire it up on the dashboards

- `src/pages/academy/AcademyDashboard.tsx`: pass `shortUrl={getAcademyShortUrl(handle)}` (keep `basePath="academies"` and `lang` as canonical fallback).
- `src/pages/TrainerDashboard.tsx`: pass `shortUrl={getTrainerShortUrl(trainerSlug)}`.

Result: both share cards now show `padeltrainer.ai/a/jan-de-vries` and `padeltrainer.ai/t/rene` respectively.

### 5. Bot/SSR + sitemap awareness

- The short paths should be ignored by the sitemap (they're redirects, not canonical pages) — no sitemap changes needed.
- Update the dynamic-rendering / Cloudflare worker config and `llms.txt` only if those files explicitly enumerate route prefixes that bots can hit. Verified during implementation; if `/a/` and `/t/` aren't whitelisted there, add them so crawlers follow the redirect cleanly.

## Out of scope

- Club / player short links.
- Custom analytics on short-link clicks.
- Database changes, slug changes, or new tables.
- SEO canonical changes — the short URL is a client-side `<Navigate replace>`, the user lands on the full localized page (same SEO surface as today).

## Notes

- `/a/` and `/t/` are short, unused, and don't collide with existing routes (`academies`, `app`, `auth`, `trainer`, `trainers`, etc.).
- Using single-letter prefixes keeps URLs compact for social bios and DMs, matching the homepage mock copy ("padeltrainer.ai/rene" style).
