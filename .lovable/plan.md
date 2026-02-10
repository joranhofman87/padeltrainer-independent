

## Remove Trainer Payment Distribution Text from Academy Earnings Page

### Problem

On the Academy Earnings page (`/earnings`), there is an unwanted Dutch text: "Je kunt vervolgens inkomsten verdelen onder je trainers op basis van de afgesproken verdeling." This needs to be removed.

### Changes

**`src/pages/academy/AcademyEarnings.tsx`**

- Remove the second paragraph (`trainerPaymentsInfo2`) from the Trainer Payment Info card at the bottom of the page (around line 228)

**`src/i18n/locales/nl/academy.json`**

- Remove the `earnings.trainerPaymentsInfo2` key

**`src/i18n/locales/en/academy.json`**

- Remove the `earnings.trainerPaymentsInfo2` key for consistency

### Files to modify
- `src/pages/academy/AcademyEarnings.tsx` (remove one `<p>` element)
- `src/i18n/locales/nl/academy.json` (remove 1 key)
- `src/i18n/locales/en/academy.json` (remove 1 key)

