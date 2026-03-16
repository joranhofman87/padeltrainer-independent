

## Hero Mock Screens Visual Update

### Changes to `src/components/home/HeroSection.tsx`

**Remove browser chrome** (lines 255-263 — the dots + URL bar). The mock container becomes a clean rounded card with just a subtle border and shadow.

**MockBooking (Easy Booking):**
- Replace the generic calendar icon badge with an actual **Google Calendar logo** (inline SVG with the 4-color icon)
- Keep the slot list as-is, it works well
- Update sync line: Google logo + "Synced with Google Calendar"

**MockRegistration (Open Registration):**
- Redesign to focus on the **value outcome** rather than a form
- Show a success/stats view: "52 registrations this week" with a mini bar chart or counter
- Below: "AI auto-planned into your calendar" with a visual showing slots being filled
- Small list of recent registrations (3 names with timestamps) to feel alive

**MockPayments (Automated Payments):**
- Keep the transaction table (it's good)
- Change Mollie footer from "Powered by Mollie" → "Automate payments by connecting Mollie" with the Mollie logo
- Keep the auto-invoice toggle

**MockProfile (Your Profile):**
- Redesign to emphasize **bookable open slots** as the main value
- Remove the star rating and location — focus on availability
- Show a grid of available time slots (6-8 slots) with "Open" badges
- Add a prominent "Book now" CTA
- Show a stat: "8 open slots this week" as a highlighted metric
- Keep trainer name + avatar placeholder

### Translation updates (all 5 languages)

Update keys:
- `mock_booking_sync` → keep as-is (already says "Synced with Google Calendar")
- `mock_reg_title` → "52 registrations this week" (value-focused)
- Add `mock_reg_ai` → "Auto-planned into your calendar with AI"
- `mock_payments_powered` → "Automate payments by connecting Mollie"
- `mock_profile_slots` → "{{count}} open slots this week"
- `mock_profile_cta` → "Book now"

### Files to modify
- `src/components/home/HeroSection.tsx`
- `src/i18n/locales/en/marketing.json`
- `src/i18n/locales/nl/marketing.json`
- `src/i18n/locales/es/marketing.json`
- `src/i18n/locales/de/marketing.json`
- `src/i18n/locales/fr/marketing.json`

