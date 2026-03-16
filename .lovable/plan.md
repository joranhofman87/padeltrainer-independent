

## Add Player Sign-Up CTA to Pricing Preview

**What:** Add a "Sign up as player" button to the Players card in `PricingPreview.tsx`, matching the trainer card's CTA pattern but with a secondary/outline style.

**Changes:**

### `src/components/home/PricingPreview.tsx`
- Add a `Button` (outline variant) inside the Players card `CardContent`, linking to `/app/signup/player`
- Use existing translation key pattern — add a new key for the CTA label

### Translation files (en, nl, de, fr, es `marketing.json`)
- Add `homev2.pricing.players_cta` key:
  - EN: "Sign up for free"
  - NL: "Gratis aanmelden"
  - DE: "Kostenlos registrieren"
  - FR: "S'inscrire gratuitement"
  - ES: "Regístrate gratis"

