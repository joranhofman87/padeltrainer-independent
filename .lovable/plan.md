

## Price Summary Calculator at Bottom of Application Form

### What it does
A summary card shown above the consent checkbox that dynamically calculates and displays what the player is signing up for based on their selections: lesson type, duration (weeks), and lesson duration (minutes). It looks up the per-session price from the cycle's `price_table` (matching by label/lesson type) and multiplies by the selected number of weeks.

### Layout

```text
┌─────────────────────────────────────┐
│ 📋 Your Selection Summary           │
│                                     │
│  Lesson type:    Duo (2 players)    │
│  Duration:       10 weeks           │
│  Lesson length:  60 min             │
│                                     │
│  Price per lesson:       €25.00     │
│  Total (10 × €25.00):   €250.00    │
└─────────────────────────────────────┘
```

Only shows when the player has selected at least a lesson type. Price lines only appear when a matching `price_table` entry exists. If no price data is available, just show the selections without pricing.

### Changes

**`src/components/cycles/CycleApplicationForm.tsx`**
- Add a summary `Card` between the Availability card and the consent checkbox (before line 852).
- Reads from form state: `lesson_types` (first selected), `preferred_duration_minutes`, and `selectedDurationWeeks`.
- Looks up price from `cycle.price_table` by matching the lesson type label, or falls back to `cycle.price_per_session`.
- Calculates total: `price × selectedDurationWeeks`.
- Uses `formatPrice` from `src/lib/pricing.ts`.
- Only renders when not an event and at least one selection is made.

**`src/i18n/locales/en/cycles.json`** and **`src/i18n/locales/nl/cycles.json`**
- Add keys under `application.summary`: `title`, `lessonType`, `duration`, `lessonLength`, `pricePerLesson`, `total`, `weeksCount`.

### Files to modify
- `src/components/cycles/CycleApplicationForm.tsx`
- `src/i18n/locales/en/cycles.json`
- `src/i18n/locales/nl/cycles.json`

