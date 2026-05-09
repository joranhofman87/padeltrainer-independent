## What's done so far

- Hero section restyled with new visual language (Plus Jakarta Sans display, brand pills, mock window, floating chips).
- Social proof marquee, navy announcement bar, How It Works with 3 mock visuals, Solution Overview, Pain Stories, Jobs To Be Done, Pricing, FAQ, Final CTA, Player Banner — all aligned to the new tokens (`card-chip`, `pill-primary`, `eyebrow`, `font-display`, navy/brand palette).
- Mobile pass on hero + sections (tighter padding, responsive headline scale, calendar mock horizontal scroll).
- Tokens live in `src/index.css` + `tailwind.config.ts` (brand 50-700, navy 50-950, surface tokens, shadows, mock-window, dot-grid).

## What's missing

1. No public **Branding page** exists yet (`/brand`).
2. No **single source-of-truth design doc** in the repo (only tokens scattered in `index.css`).
3. A handful of secondary public surfaces still use the old visual style and were not in the previous passes.

## Plan

### 1. Create a public Branding page (`/brand`, `/nl/brand`)

`src/pages/marketing/Brand.tsx` rendered inside `MarketingLayout`, sections:

- **Hero**: logo lockup, tagline, one-line positioning ("Modern booking + payments for padel coaches").
- **Logo**: PadelTrainer.ai wordmark on light + dark backgrounds, clear space + min-size rules, do/don't examples.
- **Color system**: swatches for Brand (50/100/200/300/500/600/700), Navy (50/100/500/900/950), semantic tokens (background, foreground, primary, muted, success). Each shows token name + HSL value.
- **Typography**: Plus Jakarta Sans (display 600/700/800) and Inter (body 400/500/600). Live samples at H1–H4 + body sizes.
- **Components**: live previews of `pill-primary`, `pill-ghost`, `card-chip`, eyebrow, mock-window, slot row, announcement bar.
- **Iconography & imagery**: lucide-react usage, stroke-width 1.75, brand-50 tinted tile pattern.
- **Voice & tone**: short copy guidelines, NL/EN sentence-case rule, "no em-dashes" rule, global positioning (no country names).
- **Downloads**: links to logo SVG/PNG (place in `/public/brand/`).

Wire-up:
- Add route to `src/App.tsx` + `DomainRouter`.
- Add to `src/lib/sitemap.ts` (or equivalent) and `public/llms.txt`.
- SEO meta: `<title>Brand | PadelTrainer.ai</title>`, canonical, OG image.

### 2. Add a maintained design doc: `docs/DESIGN_SYSTEM.md`

Mirrors what's on `/brand` but for engineers / AI agents. Sections:

- Token table (CSS var name → HSL → tailwind class → usage).
- Typography stack and weight map.
- Component primitives (`pill-primary`, `card-chip`, `mock-window`, `eyebrow`, `dot-grid`, `shimmer-bar`, `marquee-track`, `no-scrollbar`).
- Spacing scale + responsive section pattern (`py-16 md:py-24 lg:py-32`).
- Heading scale pattern (`text-3xl sm:text-4xl md:text-5xl font-display font-extrabold tracking-[-0.02em]`).
- Rules: no hardcoded colors, no em-dashes, no location names, mobile-first.
- Last-updated date + ownership note ("Update this file whenever tokens or primitives change").

Also update `mem://style/theme-aware-marketing-design` memory to point at `docs/DESIGN_SYSTEM.md` so future AI sessions read it.

### 3. Final homepage polish pass

- Verify `SocialProofStrip` headline `text-4xl md:text-5xl` follows the new mobile rule (`text-3xl sm:text-4xl md:text-5xl`).
- Audit `MarketingLayout` (footer + nav) for any leftover old-style buttons or colors.
- Check `/pricing` page (referenced from hero) — currently uses old tokens; bring it in line with the new card-chip + pill style.
- Check `/about`, `/founding-trainers` heroes — apply eyebrow + display heading pattern only if they still use old typography.

### 4. Footer link

Add "Brand" link in `MarketingLayout` footer under "Company" so the new page is discoverable.

## Out of scope

- App-internal screens (post-login dashboard) — branding lives on marketing surfaces for now.
- New logo asset creation; will reuse existing wordmark unless a new SVG is provided.
- Dark mode of the marketing site (still light-first).

## Open question

Do you want the `/brand` page to be **public-facing marketing** (press / partners can link to it) or **internal-only** (link unlisted, no nav entry)? Default in this plan: public, linked from footer.
