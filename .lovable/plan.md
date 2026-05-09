
# Design system rollout — PadelTrainer.ai

Goal: replace the current "AI-generated" feel with the design system from the uploaded brief. Smoother, calmer, more intentional. Light-only, Inter-only, no decorative gradients.

We split the work into three phases so each one is reviewable on its own. After Phase 1 the whole app already feels different (colors, type, radii, shadows). Phase 2 polishes the homepage. Phase 3 sweeps app screens for the small details (pill buttons, eyebrows, card spacing).

---

## Phase 1 — Foundation (tokens, fonts, dark mode removal)

This phase touches only global config files. Every page in the app inherits the new look automatically.

**`src/index.css`**
- Replace `:root` HSL values with the spec palette mapped onto the existing semantic names (`--primary` = brand-500, `--accent` = navy-900, `--background` = white, `--secondary` = navy-50, `--muted` = surface-cream, `--border` = navy-900/10, `--ring` = brand-500). Keep variable names so shadcn components stay wired.
- Add new tokens: `--brand-50…900`, `--navy-50…950`, `--surface-cream`, `--surface-off`, `--accent-gold`.
- Add shadow tokens as CSS vars: `--shadow-soft`, `--shadow-lift`, `--shadow-cta`, `--shadow-mock`.
- Set `--radius: 0.75rem` (12px) globally — matches the "app surface" rule. Marketing-only components opt into 20px via `rounded-[20px]`.
- Delete the entire `.dark { … }` block.
- Body font stack → `'Inter', system-ui, sans-serif` with `font-feature-settings: 'cv11', 'ss01'` for tighter display kerning.
- Add `.font-display` utility (still Inter, weight 800, letter-spacing -0.02em, line-height 1.05) so existing components that reach for a display font get the spec treatment without loading a second family.
- Add reusable utilities: `.eyebrow`, `.pill-primary`, `.pill-ghost`, `.dot-grid` (the radial-gradient backdrop), `.section-cream`, `.section-off`.
- Respect `prefers-reduced-motion` for fade-in utilities.

**`tailwind.config.ts`**
- Extend `colors` with `brand` (50–900) and `navy` (50–950) scales reading from CSS vars.
- Extend `boxShadow` with `soft`, `lift`, `cta`, `mock`.
- Extend `borderRadius` with `pill: 9999px`.
- Extend `fontFamily.display` → same Inter stack (so `font-display` Tailwind class works).
- Keep `darkMode` config but it becomes a no-op once `.dark` block is gone.

**`index.html`**
- Add `<link rel="preconnect">` + a single Google Fonts call for Inter only: weights 400/500/600/700/800, `display=swap`. ~25KB vs ~70KB for Inter+Jakarta.
- Remove any `class="dark"` toggling from the html tag if present.

**`src/components/ThemeToggle.tsx`**
- Remove the toggle from headers (or stub component to render nothing) since dark mode is gone. Update places that import it.

**Acceptance check:** the app loads, primary buttons are coral pills, headings feel tighter, no dark-mode flicker, no layout regressions.

---

## Phase 2 — Marketing homepage restyle

Keep the current section components (`HeroSection`, `SocialProofStrip`, `PainStoriesSection`, `SolutionOverview`, `HowItWorksSection`, `JobsToBeDoneSection`, `PlayerBanner`, `PricingPreview`, `FAQSection`, `FinalCTASection`) — restyle each in place. Don't rewrite the section graph.

For each section:
- Wrap in `<section class="py-24 lg:py-32">`, alternate backgrounds white → cream → white → off-white per the spec.
- Add an eyebrow badge above every h2 (`bg-brand-50 text-brand-700`, uppercase, tracking-wide).
- Use `font-display` on h1/h2 with the spec sizes (h1 56–72, h2 40–48).
- Replace any current gradient backgrounds, glow blobs, or mesh circles with solid surfaces.
- Replace bespoke buttons with the pill primary / ghost classes from Phase 1.
- Cards: white surface, `rounded-[20px]`, `shadow-soft`, `p-7`, hover `shadow-lift` + `-translate-y-0.5`.

Hero specifics:
- Single h1, scramble effect on one keyword (lightweight — ~40 lines, no library).
- Dot-grid backdrop (`.dot-grid` utility) masked to soft ellipse. Replace any existing mesh/orbs.
- Mock UI window component (new `src/components/marketing/MockWindow.tsx`) reused by hero and journey sections — chrome dots + URL bar.
- Two CTAs: "Start your free trial →" + "See how it works".

Final CTA section:
- Solid `bg-navy-950` block, white text, single coral pill, no gradients.

Footer (`MarketingLayout`):
- 6-column grid, navy-950 surface, Logo tile + legal row (Privacy · Terms · GDPR · Status).

Copy:
- Don't blindly copy strings from `landing-page.html`. Keep current i18n keys, only adjust English/NL where the existing copy clearly clashes with the voice rules ("AI-powered", "leverage", etc.). User confirmed not all .html copy is accurate.
- Preserve all existing translation keys and add new ones where structure changes (e.g. eyebrows).

Screenshots:
- Audit existing image assets used in HowItWorks / Solution / JobsToBeDone. Where current screenshots show old UI chrome or feel off-brand, swap to the new MockWindow component rendering inline (faster + no asset bloat) or queue a screenshot refresh task. List the specific images needing replacement at the end of Phase 2.

Logo:
- New `src/components/Logo.tsx` variants: `tile` (square SVG from spec, textLength=44) and `pill` (horizontal chip). Replace usage across header / footer / favicon meta.

---

## Phase 3 — App surface sweep

Apply the "App-adjacent screens" rules (12px radius, `shadow-soft`, no mock chrome) across the in-product UI. The shadcn primitives already pick up the new tokens, so most of this is local cleanup, not rewrites.

Targets, in priority order:
1. **Sidebar / app shell** — restyle `AppSidebar`, header bar. Navy-900 sidebar background already matches spec; tighten spacing, swap accent to brand-500, drop any leftover gradient hover states.
2. **Trainer dashboard surfaces** — `TrainerCalendar`, `TrainerCycles`, `TrainerCyclus`, `TrainerAnalytics`. Card cleanups + pill buttons for primary actions only.
3. **Academy + Club mirrors** — same passes (parity rule).
4. **Player surfaces** — `PlayerBookings`, `PlayerSettings`, `BookingSuccess`.
5. **Cycle workflow pages** — `CycleFormPage`, `CycleRegistration`, `BrandedCycleRegistration`, `ProposalScheduleGrid` (light touch — keep the calendar grid behavior intact, just restyle slot cards).
6. **Auth + onboarding** — `Auth`, `Onboarding`, `TrainerOnboarding`, `AcademyOnboarding`, `ClubOnboarding`. Big visual win since these are entry surfaces.
7. **Admin** — last; admins tolerate ugly best.

Per-screen pattern:
- Section heading uses `font-display` weight 700, tracked-tight.
- Primary action becomes a coral pill (`Button variant="default"` already maps via tokens, but check sizing — height 12 / px 6).
- Cards use the existing `Card` component which now picks up new tokens; verify padding feels right (often `p-6` is fine).
- Replace any hardcoded color (`text-white`, `bg-slate-50`, `from-…/to-…`) with semantic tokens.
- Drop dark-mode-only classes (`dark:bg-…` etc.).

Audit step: ripgrep for `bg-gradient-`, `from-`, `to-`, `dark:`, hardcoded hex colors. Convert each hit to a semantic token or remove.

---

## Technical notes

- **Fonts: Inter only.** Plus Jakarta would add ~35KB and a second font-loading hop. Inter at weight 800 with `letter-spacing: -0.02em` is ~95% of the visual feel of Jakarta at hero sizes, with zero perf cost (we're already loading Inter implicitly via Tailwind defaults — making it explicit just adds the heavier weights).
- **Dark mode removal**: safe — nothing in the app depends on `useTheme` for logic. We strip `.dark` block from `index.css`, remove `darkMode` toggle UI, leave the Tailwind `darkMode: ["class"]` config in place to avoid touching `tailwind.config.ts` more than needed.
- **Existing memory rule "no hardcoded colors"** stays — Phase 3 audit enforces it.
- **Existing memory rule "theme-aware marketing design"** still applies: marketing components reference tokens, not hex.
- **Backwards compatibility**: shadcn components (`Button`, `Card`, `Input`, etc.) read from semantic tokens (`--primary`, `--background`, etc.) — they inherit the new look without per-component edits.
- **Performance budget**: target no regression on Lighthouse mobile. Inter-only keeps font payload lean. Dot-grid is pure CSS. Scramble effect is ~1KB inline JS, runs once on the hero only.
- **Mock-window component** lives in `src/components/marketing/`, never imported by `src/pages/club/*`, `src/pages/trainer/*`, etc. — enforces the marketing/app split.

## Out of scope (call out for follow-ups)

- Email template restyle (spec section 5E) — separate task.
- OG image regeneration (spec section 8) — separate task.
- Favicon swap to "P." fallback — separate task, needs designer export.
- New marketing copy translations beyond English/NL — translator pass.

## Deliverables per phase

- **Phase 1**: 1 PR, ~4 files, foundation only. Reviewer can immediately see the app re-skinned.
- **Phase 2**: ~12 files (homepage sections + MockWindow + Logo). Marketing homepage matches the brief.
- **Phase 3**: iterative, screen-by-screen. Will need its own task list once Phase 1+2 ship.

I'll start with Phase 1 once you approve.
