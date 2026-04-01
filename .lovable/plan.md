

# Homepage Adjustments — 9 Changes

## 1. Hero subheadline — shorter, no brand name
Update `homev2.hero.subheadline` in all 5 locale files.
- **NL**: "Boekingen, betalingen, annuleringen en je agenda op de automatische piloot. Zodat jij op de baan staat, niet op je telefoon."
- **EN**: "Bookings, payments, cancellations, and your schedule on autopilot. So you're on the court, not on your phone."
- **DE/ES/FR**: Equivalent translations.

## 2. Feature section — show all 4 cards
The `SolutionOverview` component already renders 4 cards (`player`, `filled`, `noshows`, `admin`). The translations for all 4 exist. This is likely a viewport/scroll issue — the 2x2 grid requires scrolling. No code change needed if all 4 are in the `values` array (they are). Will verify after deployment.

## 3. Player section — compact single row
Update `PlayerBanner.tsx`:
- Change grid from `grid-cols-2 sm:grid-cols-3 lg:grid-cols-6` to a single horizontal row
- Remove description text (`descKey`) — show only icon + title
- Reduce card padding and make cards smaller/more compact
- Result: a slim, single-line strip instead of a full-screen section

## 4. Pain stories — verify all 3 render
The `PainStoriesSection` already has all 3 items (`whatsapp`, `cancellation`, `payments`) and translations exist for all 3. This should already work — likely a viewport issue where user didn't scroll far enough. No code change needed.

## 5. How It Works — fix faded steps 2 & 3
The `HowItWorksSection` uses `whileInView` animations with `initial={{ opacity: 0 }}`. If the viewport intersection observer doesn't trigger properly, steps stay at opacity 0. Fix: add `amount: 0.1` to the viewport config to trigger earlier, or set a fallback so items become visible even without intersection.

## 6. Final CTA — tighten copy
Update `homev2.finalCta.headline` and `homev2.dualCta.headline`:
- **NL**: "Klaar om te stoppen met admin tussen je lessen?"
- **EN**: "Ready to stop doing admin between your lessons?"
- Other locales: equivalent.

## 7. Testimonial — René quote refinement
Update `homev2.socialProof.testimonial2`:
- **NL**: "Spelers boeken nu zelf. Geen betalingen meer najagen."
- **EN**: "Players book themselves now. No more chasing payments."
- Other locales: equivalent.

## 8. Nav bar — no change needed
Already confirmed correct.

## 9. Footer — "Jorans academy" placeholder
This is database content (academy `description` field), not in code. The `HomeFeaturedSections` component renders `academy.description` directly from the database. Fix: update the academy description in the database, OR add a code guard that hides descriptions shorter than ~10 chars or containing "great academy". Recommend updating the database record directly.

## Files Changed

| File | Change |
|------|--------|
| `src/i18n/locales/nl/marketing.json` | Update subheadline, finalCta headline, testimonial2 |
| `src/i18n/locales/en/marketing.json` | Same |
| `src/i18n/locales/de/marketing.json` | Same |
| `src/i18n/locales/es/marketing.json` | Same |
| `src/i18n/locales/fr/marketing.json` | Same |
| `src/components/home/PlayerBanner.tsx` | Compact single-row layout, remove descriptions |
| `src/components/home/HowItWorksSection.tsx` | Fix viewport animation trigger for steps 2 & 3 |

