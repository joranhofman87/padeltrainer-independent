# Performance cleanup (items 16–18)

## #16 — Stop shipping 108 MB of sitemaps in the repo

**Current state:**
- `public/sitemaps/` = 108 MB across 11 XML files (cities-1: 20MB, cities-2: 20MB, cities-3: 12MB, locations-1..6: ~57MB, content: 2.1MB, etc.)
- `public/sitemap.xml` (index) hardcodes paths like `/sitemaps/sitemap-locations-1.xml`
- `public/llms-full.txt` = 2.1 MB
- `.github/workflows/sitemap.yml` runs weekly, curls `supabase/functions/sitemap`, and **commits the output back into `public/sitemaps/`**
- The `sitemap` edge function already exists and serves all variants (`?type=index|static|content|locations-N|cities-N`)

So the generator is already there; we're just needlessly persisting + bundling its output.

**Fix:**
1. **Cloudflare proxy rule** (per `mem://infrastructure/cloudflare-configuration`): route `padeltrainer.com/sitemap.xml` and `padeltrainer.com/sitemaps/*` to the edge function (`/functions/v1/sitemap?type=...`), with the worker mapping path → `?type=` param. Set CDN cache headers on the edge function response (`Cache-Control: public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800`).
2. **Edge function update**: ensure `sitemap/index.ts` emits the cache headers above, and that the `?type=index` response uses absolute URLs pointing at the same `/sitemaps/...` paths so crawlers don't see edge-function URLs.
3. **Delete from repo**: remove `public/sitemaps/` and `public/sitemap.xml` entirely; add `public/sitemaps/` to `.gitignore` as a safety net.
4. **Replace the weekly workflow**: `.github/workflows/sitemap.yml` no longer commits files. Either delete it, or repurpose it as a smoke-test that curls each `?type=...` variant and fails if any returns non-200 / empty XML — much smaller change set, no commits.
5. **`llms-full.txt`** (2.1 MB): same treatment. The content is already programmatically generatable. Add a `llms` edge function (or a `?type=llms-full` branch on the sitemap function), proxy `/llms-full.txt` to it, delete the file. Keep the small `/llms.txt` index in the repo since it's tiny and human-readable.

**Net effect:** dist/ shrinks by ~110 MB. Each deploy ships less, browser cache & CDN handle freshness, sitemaps stay current without weekly commits.

## #17 — Lazy loading + WebP for images

**Current state:**
- 10 `<img>` tags in `src/`. Only **2** have `loading="lazy"` (`PressKit.tsx`, `AcademyProfile.tsx`).
- 6 missing it: `VideoTipPage.tsx` (×2), `TrainerProfile.tsx`, `TrainerCalendar.tsx`, `AdminBlogEditor.tsx`, `InvoiceSettingsCardBase.tsx`, `DataProcessingDialog.tsx`. Two more (`ChallengeCard.tsx` logo, blog cover preview) are above-the-fold or always-visible — leave eager.
- OG images: `og-image.png` (21K), `og-trainers.png` (74K), `og-locations.png` (103K). PNG is wasteful; WebP gets ~70% smaller.

**Fix:**
1. Add `loading="lazy" decoding="async"` to the 6 below-the-fold imgs listed above. Skip the 2 logo/cover-preview cases.
2. Convert `og-image.png`, `og-trainers.png`, `og-locations.png` to WebP via `cwebp -q 85`. **Keep the `.png` originals** because Facebook/LinkedIn historically had patchy WebP support for OG cards — but ship `.webp` versions and update `<meta property="og:image">` only after verifying renderers (Twitter validator, FB sharing debugger). Safer interim: just re-encode the PNGs with `pngquant --quality=70-85` for an immediate ~50% drop with zero compatibility risk. Recommend this as the default.
3. Audit `<meta property="og:image">` references across `index.html` and any per-page meta components; no path changes if we keep PNGs.

## #18 — `forcedTheme="light"` + unused `next-themes`

**Current state:**
- `src/App.tsx`: `<ThemeProvider attribute="class" defaultTheme="light" forcedTheme="light" enableSystem={false}>`
- `next-themes` is still imported by `src/components/Logo.tsx` and `src/components/ui/sonner.tsx` (both call `useTheme()`).
- Project memory commits to "Theme-aware design tokens" (light theme only, marketing pages explicitly light).

**Decision needed (low-friction options):**
- **Option A (recommended): Remove `next-themes`.** Drop the dependency, drop `<ThemeProvider>`, hardcode `theme="light"` in `Logo.tsx` and `sonner.tsx` (or pick the light variants directly). Bundle shrinks slightly, dead code removed.
- **Option B: Keep dark-mode capability for later.** Drop `forcedTheme="light"`, leave `defaultTheme="light"`, but leave `enableSystem={false}` so behavior stays identical today. No visible change, lib stays useful for future dark mode.

I'll go with **Option A** unless you want to preserve the option for dark mode later — there's no current consumer benefiting from `next-themes` being installed.

## Order of execution

1. #18 — smallest change, isolated.
2. #17 — `loading="lazy"` edits + `pngquant` re-encode of OG images.
3. #16 — split into two PRs in spirit (but one turn here):
   a. Edge function: emit cache headers, verify `?type=...` variants return correct URLs.
   b. Cloudflare worker: add `/sitemap.xml` and `/sitemaps/*` routing rule (and `/llms-full.txt`).
   c. Delete `public/sitemaps/`, `public/sitemap.xml`, `public/llms-full.txt`; gitignore the dir; rewrite or delete the weekly workflow.

## Out of scope

- Switching OG images to `.webp` and updating meta tags (compatibility risk; needs validator runs).
- Implementing dark mode UI (only mentioned as the alternative to removal).
- Image optimization for user-uploaded content (different problem; lives in storage / on-the-fly transforms).

## Open question for you

For #18, do you want **A) remove `next-themes` entirely** or **B) keep it for future dark mode**? I'll default to A unless you say otherwise.
