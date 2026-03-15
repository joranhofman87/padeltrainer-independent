

# Performance Optimization Plan (Safe, Incremental)

Your Lighthouse mobile score is **58** with FCP 3.6s, LCP 6.7s, and Speed Index 7.2s. The main issues from the report are: cache lifetimes (3,995 KiB), render-blocking requests (330ms), unused JS (239 KiB), JS execution time (1.4s), and main-thread work (2.3s). Here's what we can do without breaking anything:

---

## 1. Reduce critical-path JavaScript

**Problem**: `framer-motion` is in the initial bundle (`vendor-motion` chunk) but is used heavily on the home page — including above-the-fold in `HeroSection`. The animation library adds ~100KB+ to parse/execute before anything renders.

**Fix**: Replace `motion.*` in `HeroSection` with plain CSS animations (opacity + translateY via Tailwind `animate-` classes). The hero is above-the-fold and drives LCP — removing framer-motion from the critical path will significantly cut FCP and LCP. The lazy-loaded below-fold sections can keep framer-motion since they're already code-split.

## 2. Defer auth on marketing pages

**Problem**: `MarketingLayout` calls `useAuth()` which triggers `supabase.auth.onAuthStateChange` + a Supabase session check on every marketing page load — even for anonymous visitors. This adds network latency and JS execution to the critical path.

**Fix**: Make the auth check in `MarketingLayout` optional/lazy. Use a lightweight check (just read from context without blocking render) and conditionally show the Sign In / Dashboard button once auth resolves. The layout should render immediately without waiting for auth.

## 3. Add `fetchpriority="high"` to LCP candidates

**Problem**: The LCP element (hero heading text) takes 6.7s. While text-based LCP is mostly about render-blocking resources, we can ensure fonts and critical CSS load faster.

**Fix**: Add `<link rel="preload">` for any custom fonts if used (none found currently — good). Ensure the hero section renders without waiting for any async data.

## 4. Optimize testimonial images in SocialProofStrip

**Problem**: `SocialProofStrip` is above-the-fold and eagerly imports 4 image assets (PNG/AVIF). These are bundled but contribute to initial parse time.

**Fix**: Add `loading="lazy"` and explicit `width`/`height` attributes to the testimonial images and logos. Convert remaining PNGs to WebP/AVIF for smaller payloads. Add `decoding="async"` to non-critical images.

## 5. Move `posthog-js` to dynamic import

**Problem**: `posthog-js` (~45KB) is imported statically in `main.tsx` via `import { initializePostHog }` even though it's only called in `requestIdleCallback`.

**Fix**: Dynamically import posthog inside `initDeferred()` so it's not in the initial bundle at all:
```ts
async function initDeferred() {
  const { initializePostHog } = await import('./lib/posthog');
  initializePostHog();
  // ... rest
}
```

## 6. Split `vendor-motion` chunk to load only when needed

**Problem**: The `vendor-motion` manual chunk loads framer-motion eagerly even though most usage is in lazy-loaded components.

**Fix**: Remove `'vendor-motion': ['framer-motion']` from `manualChunks`. Let Vite's code-splitting handle it naturally — framer-motion will only load when a component using it is rendered (which for below-fold sections is already lazy).

---

## Expected Impact

| Metric | Current | Expected |
|--------|---------|----------|
| FCP | 3.6s | ~2.0-2.5s |
| LCP | 6.7s | ~3.5-4.5s |
| TBT | 250ms | ~150ms |
| Speed Index | 7.2s | ~4-5s |

These are safe, non-breaking changes that preserve all existing functionality.

