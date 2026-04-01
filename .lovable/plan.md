

# Homepage Performance Optimization

## Current State (What's Already Good)
- Below-fold sections are already lazy-loaded via `React.lazy()` + `Suspense`
- Third-party scripts (PostHog, Reditus) already load deferred via `requestIdleCallback`
- Vite already handles code-splitting, tree-shaking, content-hashed filenames, and CSS purging
- Tailwind v3 purges unused CSS automatically
- `loading="lazy"` already on testimonial images
- Hero section uses no external images (pure JSX/SVG mockups) so LCP is text-based and fast
- Viewport meta tag already present in `index.html`
- No framer-motion on any active homepage component (old unused components still import it but aren't loaded)

## Changes Needed

### 1. Hero animation delays LCP — remove `animate-fade-in` with `animationDelay`
**`HeroSection.tsx`**: The hero text wrapper has `animate-fade-in` and the mockup has a 200ms `animationDelay` with `animationFillMode: 'backwards'` (which means it starts invisible). This delays LCP.
- Remove `animate-fade-in` from the hero text `div`
- Remove `animate-fade-in`, `animationDelay`, and `animationFillMode` from the product mockup wrapper
- Both should render instantly at full opacity

### 2. Testimonial images — add explicit dimensions to prevent CLS
**`SocialProofStrip.tsx`**: Avatar images inside `AvatarImage` lack `width`/`height` attributes. The logo images already have `width={80} height={28}`.
- Add `width={56} height={56}` to the `AvatarImage` elements (matching the `h-14 w-14` avatar container)

### 3. Preconnect to Google Fonts (if used) or confirm no external fonts
No `@font-face` or font preloads exist. The app appears to use system fonts via Tailwind defaults. No action needed — this is already optimal (no font requests to block rendering).

### 4. Sponsor banner images — add dimensions and lazy loading
**`BannerAd.tsx`**: The `<img>` already has `loading="lazy"` and `decoding="async"` but lacks `width`/`height` attributes, which causes CLS.
- Add `width` and `height` attributes to the banner image (use a standard aspect ratio like `width={728} height={90}` for leaderboard banners, with CSS override for responsive)

### 5. Dead homepage components — verify they're not in the bundle
Files like `ChaosPainSection.tsx`, `PadelRealitiesSection.tsx`, `CriticalEventsSection.tsx`, `ImpactSection.tsx`, `WhyPadelTrainerSection.tsx`, `DualCTABanner.tsx` import `framer-motion` but are NOT imported in `Home.tsx`. Vite tree-shakes them out. However, they add noise — optionally delete them to keep the codebase clean and prevent accidental future imports pulling in framer-motion.

### 6. DNS prefetch for Sanity CDN
Already present in `index.html`: `<link rel="preconnect" href="https://cdn.sanity.io" />`. Good.

### 7. Add `fetchpriority="high"` to hero LCP element
The hero's LCP element is the `<h1>` text (no image). No further action needed — text renders from the initial HTML/CSS without waiting for additional resources.

### 8. Compression and cache headers
These are handled at the infrastructure level (Cloudflare Worker proxy). Cloudflare automatically applies Brotli/gzip and Vite's content-hashed filenames enable long-term caching. No code changes needed.

## Summary of Actual Code Changes

| File | Change |
|------|--------|
| `src/components/home/HeroSection.tsx` | Remove `animate-fade-in` and `animationDelay` from hero elements to eliminate LCP delay |
| `src/components/home/SocialProofStrip.tsx` | Add `width={56} height={56}` to avatar images for CLS prevention |
| `src/components/sponsors/BannerAd.tsx` | Add `width` and `height` attributes to banner `<img>` |
| Delete 6 unused files | `ChaosPainSection.tsx`, `PadelRealitiesSection.tsx`, `CriticalEventsSection.tsx`, `ImpactSection.tsx`, `WhyPadelTrainerSection.tsx`, `DualCTABanner.tsx` — dead code importing framer-motion |

## What's NOT Needed (Already Handled)
- **Code splitting**: Already done via `React.lazy()`
- **CSS purging**: Tailwind v3 does this automatically
- **Font optimization**: No external fonts loaded
- **Third-party script deferral**: Already deferred
- **Image lazy loading**: Already on below-fold images
- **Compression/caching**: Cloudflare handles this
- **Viewport meta**: Already present
- **Tree-shaking**: Vite handles this

This is a focused, low-risk optimization — the homepage is already well-structured. The main win is removing the hero animation delay that artificially pushes LCP later.

