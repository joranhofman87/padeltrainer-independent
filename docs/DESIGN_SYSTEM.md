# PadelTrainer.ai — Design System

> **Source of truth** for visual design across marketing surfaces. Update this file whenever a token or primitive changes. The public mirror lives at `/brand`.

Last updated: 2026-05-09

## Principles

1. **Modern, calm, confident.** Padel-shaped (not generic SaaS).
2. **Mobile-first.** Every section ships at 360px before desktop.
3. **Tokens > literals.** Never hardcode color values in components — always use semantic CSS vars or tailwind classes that map to them.
4. **No em-dashes** in product copy. Use a regular hyphen with spaces.
5. **Globally positioned.** Avoid country/region names in marketing copy and metadata.

## Color tokens

All colors are HSL, defined in `src/index.css` and exposed through `tailwind.config.ts`.

### Brand (orange)
| Token | HSL | Tailwind | Usage |
|---|---|---|---|
| `--brand-50` | `24 100% 96%` | `bg-brand-50` | Icon tile backgrounds, soft chips |
| `--brand-200` | `28 100% 83%` | `bg-brand-200` | Heatmap mid-tone |
| `--brand-300` | `27 100% 72%` | `bg-brand-300` | Dashed slot borders |
| `--brand-500` | `21 95% 53%` | `bg-brand-500` | **Primary** CTA, dot accents |
| `--brand-600` | `22 92% 47%` | `text-brand-600` | Eyebrow text, link accents |
| `--brand-700` | `22 88% 40%` | `text-brand-700` | Pill text on `brand-50` |

### Navy (text + surfaces)
| Token | HSL | Tailwind | Usage |
|---|---|---|---|
| `--navy-50` | `220 41% 96%` | `bg-navy-50` | Card body background |
| `--navy-100` | `220 27% 90%` | `border-navy-100` | Subtle borders |
| `--navy-700` | `218 38% 38%` | `text-navy-700` | Body copy |
| `--navy-900` | `218 67% 24%` | `text-navy-900` | Headings, foreground |
| `--navy-950` | `220 70% 14%` | `bg-navy-950` | Final CTA dark backdrop |

### Surfaces
| Token | Tailwind | Notes |
|---|---|---|
| `--surface-cream` | `section-cream` | Section alt background |
| `--surface-off` | `section-off` / `bg-offwhite` | Soft off-white |
| `--background` | `bg-background` | Page default (white) |

### Semantic
`--primary` → `brand-500`, `--foreground` → `navy-900`, `--ring` → `brand-500`, `--success` → green.

## Typography

- **Display**: Plus Jakarta Sans (600 / 700 / 800) → `font-display`. Used for h1–h3, hero numerals.
- **Body**: Inter (400 / 500 / 600) → default sans. Used everywhere else.
- Tracking: headings `tracking-[-0.02em]`. Leading: `leading-[1.05]` for hero, `leading-tight` for h2/h3.

### Section heading scale (responsive)
```
text-3xl sm:text-4xl md:text-5xl font-display font-extrabold tracking-[-0.02em] leading-tight text-navy-900
```

### Hero h1
```
text-[34px] sm:text-5xl lg:text-7xl font-display font-extrabold leading-[1.05] tracking-[-0.02em]
```

### Eyebrow
Use the `.eyebrow` class — uppercase pill, `bg-brand-50 text-brand-700`.

## Spacing

- Marketing sections: `py-16 md:py-24 lg:py-32`.
- Container: `max-w-7xl mx-auto px-4 md:px-6`.
- Card grids: `gap-6` desktop, drop to `gap-4` if cards stack on mobile.

## Component primitives (defined in `src/index.css`)

| Class | Purpose |
|---|---|
| `.pill-primary` | Main CTA — full pill, `bg-brand-500 text-white`, h-12, `shadow-cta`. |
| `.pill-ghost` | Secondary CTA — white pill with navy border. |
| `.eyebrow` | Uppercase brand chip used above headings. |
| `.card-chip` | Soft white card with `shadow-soft` and `rounded-2xl`. Default container for everything from FAQ to mocks. |
| `.mock-window` | Browser-style window: rounded 20px, `shadow-mock`, used to wrap product previews. Pair with `.mock-bar` + `.mock-dot`. |
| `.shimmer-bar` | Navy announcement bar at top of page. |
| `.dot-grid` | Subtle radial dot backdrop, masked to ellipse. |
| `.marquee-track` | Infinite horizontal scrolling logo strip. |
| `.no-scrollbar` | Hide scrollbar on overflow containers. |
| `.section-cream` / `.section-off` | Alternating section backgrounds. |

## Iconography

- `lucide-react` only. Default stroke 1.75.
- Icon tile: `w-12 h-12 rounded-xl bg-brand-50 text-brand-600 flex items-center justify-center`.

## Voice & tone

- Sentence case in NL. Title case in EN headings.
- Concrete > abstract. Lead with outcome, not feature ("Get paid before the lesson", not "Payment processing").
- Avoid em-dashes (—); use ` - ` instead.
- Avoid country/region names (no "the Netherlands"). Use "Europe" or omit.

## Patterns to avoid

- Custom hex colors in components — must go through `index.css` tokens.
- `staleTime: Infinity` on TanStack queries (breaks invalidation refetch).
- Modals for complex flows — use full-page routes instead.
- Inline `<style>` blocks; extend `index.css` `@layer components` instead.

## Where things live

- Tokens: `src/index.css` (`:root` block) + `tailwind.config.ts` (`theme.extend.colors`).
- Component primitives: `src/index.css` (`@layer components`).
- Marketing layout shell: `src/components/marketing/MarketingLayout.tsx`.
- Public brand page: `src/pages/marketing/Brand.tsx` → `/brand`.
