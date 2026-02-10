

## Revamp Pricing Page with Value-Focused Copy (SPICED Framework)

### What's changing

The pricing page (both marketing `/pricing` and in-app `/subscription`) will be updated to showcase the **value** of each feature rather than just listing feature names. Each feature will have a bold title and a descriptive subtitle explaining the benefit, similar to the reference screenshot.

### New Feature Copy

**Starter** -- "Everything you need to streamline your admin."
1. **Trainer profile** -- Showcase yourself to players
2. **Add to marketplace** -- Be found and receive new bookings
3. **Unlimited players** -- No limitation on the number of players
4. **Unlimited trainings** -- No limitations on the number of sessions
5. **Waiting list** -- Allow players to sign up to your waiting list
6. **Open registration** -- Open up a registration and have our system plan things for you
7. **EUR 1.00 per booking fee** -- Charge players right when they book a session, no need to chase money anymore

**Professional** -- "For serious trainers"
1. **Everything from Starter** -- All the features you need to streamline your admin processes
2. **Manual invoicing** -- Send invoices yourself, we can auto generate these for you
3. **EUR 0.75 per booking fee** -- Reduced fee for charging players when they book a session with you

**Academy** -- "For training academies"
1. **Add up to 15 trainers** -- Manage and add your team to streamline the bookings
2. **Add players to the marketplace** -- Add your branding to their profile and increase bookings for your team
3. **Add academy to the marketplace** -- Be marked as featured in the marketplace to receive more bookings
4. **EUR 0.50 per booking fee** -- Streamline your book keeping. Charge clients upfront and sync invoices to your book keeping software. Lowest fee per booking

### UI Changes

**Marketing Pricing Page (`src/pages/marketing/Pricing.tsx`)**
- Replace the current feature list (checkmark + single line) with a two-line format: **bold feature name** + smaller description text beneath it
- Remove the old `getFeatureList()` function with its included/excluded X marks
- Each feature item renders as: green checkmark, bold title, and a muted description below
- Keep the billing toggle, pricing cards layout, badges, and CTA buttons as-is
- The platform fee badge in the card header can be removed since the fee is now part of the feature list with its value description

**In-App Subscription Page (`src/pages/TrainerSubscription.tsx`)**
- Update the feature rendering to match the same two-line format (title + description)
- Features will come from translation keys rather than the database `features` array, to support the value descriptions

### Translation Structure

Replace the current per-feature string keys with structured objects containing `title` and `description`:

```json
"starter": {
  "description": "Everything you need to streamline your admin.",
  "features": {
    "profile": { "title": "Trainer profile", "description": "Showcase yourself to players" },
    "marketplace": { "title": "Add to marketplace", "description": "Be found & receive new bookings" },
    ...
  }
}
```

### Files to modify

- `src/pages/marketing/Pricing.tsx` -- rewrite trainer plan feature rendering with title+description format
- `src/pages/TrainerSubscription.tsx` -- update feature rendering to match
- `src/i18n/locales/en/marketing.json` -- replace feature strings with title/description objects, update plan descriptions
- `src/i18n/locales/nl/marketing.json` -- Dutch translations for the same structure

### What stays the same

- Player pricing section (free tier)
- Club pricing section
- FAQ section
- Billing toggle and pricing amounts
- Database-driven prices (monthly/yearly from `subscription_plans` table)
- Card layout, badges ("Most Popular", "Best Value"), and CTA buttons

