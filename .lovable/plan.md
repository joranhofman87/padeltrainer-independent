

## Rebuild Homepage as Trainer-Focused Conversion Landing Page

### Build Error Fix

The `send-digest-emails` edge function uses `npm:resend@2.0.0` which fails. Fix by switching to `https://esm.sh/resend@2.0.0` (same fix pattern as `forward-invoice`).

### Overview

Replace the current player-focused homepage with a 13-section, trainer-conversion landing page following SPICED narrative and April Dunford positioning. The page will be fully internationalized (EN + NL).

### Navigation Changes

Update `MarketingLayout.tsx` nav links:
- Replace: Home, Pricing, About, Blog
- With: **How it works**, **Features**, **Pricing**, **FAQ** (anchor links to sections on the homepage)
- CTA button: "Start free trial" (links to trainer signup) or "Dashboard" when logged in

### Page Structure (13 sections in `Home.tsx`)

Each section gets its own component for maintainability:

| # | Section | Component | Key Elements |
|---|---------|-----------|-------------|
| 1 | Hero | `HeroSection` | H1 with "padel trainers", 3 pain bullets, dual CTA, trust microcopy, screenshot placeholder |
| 2 | Social Proof | `SocialProofStrip` | Logo placeholders, 2 testimonial cards, metric placeholders |
| 3 | Chaos/Pain | `ChaosPainSection` | Empathetic paragraph + competitive alternatives list |
| 4 | Impact | `ImpactSection` | 4-6 impact bullets + CTA |
| 5 | Solution Overview | `SolutionOverview` | Category statement + 4 value theme cards |
| 6 | How It Works | `HowItWorksSection` | 3 steps with icons |
| 7 | Built for Padel | `PadelRealitiesSection` | 6 pain/solution/outcome rows |
| 8 | Jobs to be Done | `JobsToBeDoneSection` | 7 first-person JTBD bullets |
| 9 | Critical Events | `CriticalEventsSection` | 5 trigger scenarios + CTA |
| 10 | Pricing | `PricingPreview` | 2 cards (Players free, Trainers from 9/mo) |
| 11 | FAQ | `FAQSection` | 9 FAQ items with accordion + FAQ schema |
| 12 | Final CTA | `FinalCTASection` | Closing headline + dual CTA |
| 13 | Featured | `HomeFeaturedSections` | Keep existing featured trainers/academies/locations |

### i18n Updates

Both `en/marketing.json` and `nl/marketing.json` will get a new `"homev2"` key with all section copy. The existing `"home"` key stays for reference. All copy provided in the brief will be used as-is for English; Dutch translations will be written to match.

### SEO

- H1: "Scheduling, bookings, and payments for padel trainers across Europe"
- Meta title: "Padel Trainer -- Scheduling, Bookings & Payments for Padel Trainers"
- Meta description: "Run your padel coaching business from one place. Online booking, secure payments, calendar sync, and fewer no-shows. Free trial, then from 9/month."
- FAQ structured data (JSON-LD FAQPage schema)
- Existing WebSite + Organization schemas kept

### Files to Create

| File | Purpose |
|------|---------|
| `src/components/home/HeroSection.tsx` | Hero with H1, bullets, CTAs, screenshot placeholder |
| `src/components/home/SocialProofStrip.tsx` | Logos, testimonials, metrics |
| `src/components/home/ChaosPainSection.tsx` | Competitive alternatives |
| `src/components/home/ImpactSection.tsx` | Impact bullets |
| `src/components/home/SolutionOverview.tsx` | Category + value cards |
| `src/components/home/HowItWorksSection.tsx` | 3-step PLG flow |
| `src/components/home/PadelRealitiesSection.tsx` | Pain/solution/outcome grid |
| `src/components/home/JobsToBeDoneSection.tsx` | JTBD bullets |
| `src/components/home/CriticalEventsSection.tsx` | Switch triggers |
| `src/components/home/PricingPreview.tsx` | 2-card pricing |
| `src/components/home/FAQSection.tsx` | Accordion FAQ + schema |
| `src/components/home/FinalCTASection.tsx` | Closing CTA |

### Files to Modify

| File | Change |
|------|--------|
| `supabase/functions/send-digest-emails/index.ts` | Fix `npm:resend` to `esm.sh` import |
| `src/pages/marketing/Home.tsx` | Replace current content with new section components |
| `src/components/marketing/MarketingLayout.tsx` | Update nav to anchor links (How it works, Features, Pricing, FAQ) + "Start free trial" CTA |
| `src/i18n/locales/en/marketing.json` | Add all new section copy under `homev2` |
| `src/i18n/locales/nl/marketing.json` | Add Dutch translations under `homev2` |

### Copy & CTA Summary

**Primary CTA**: "Start free trial" -> links to `/signup/trainer`
**Secondary CTA**: "Watch demo" / "See how it works" -> anchor or placeholder link
**Trust microcopy**: "Players are always free. Trainers start with a free trial, then from 9/month."

All exact copy from the brief will be used verbatim in the English translations. Dutch copy will be a professional translation.

