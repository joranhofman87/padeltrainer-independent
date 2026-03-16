

## Add Price Totals Summary Below Price Table

### What
Below the price table rows (after the "Add price row" button, before Cyclus Options), add a summary card showing the total price per column multiplied by the configured duration weeks. This gives trainers a quick view of what players will pay.

### Layout

The summary renders when there are price rows with prices > 0 and at least one duration option configured.

```text
┌─────────────────────────────────────────────────────┐
│  Price Overview                                      │
│                                                       │
│  ┌─── Per lesson ──────┐  ┌─── Kids (per lesson) ──┐│
│  │ Row1: €15            │  │ Row1: €10               ││
│  │ Row2: €20            │  │ Row2: €12               ││
│  └──────────────────────┘  └─────────────────────────┘│
│                                                       │
│  ┌─── 14 weeks ────────┐  ┌─── Kids 14 weeks ──────┐│
│  │ Row1: €210           │  │ Row1: €140              ││
│  │ Row2: €280           │  │ Row2: €168              ││
│  └──────────────────────┘  └─────────────────────────┘│
└─────────────────────────────────────────────────────┘
```

Visual grouping: use a subtle `bg-muted/50 rounded-lg p-4` container, with columns displayed in a responsive grid. "Per lesson" columns use normal weight, "X weeks" columns use a slightly different background shade or a left border accent to differentiate.

### Implementation

**`src/components/cycles/CycleForm.tsx`** (~line 1095, after the "Add price row" button):

- Add a computed summary section that:
  1. Shows only when `priceTable.length > 0` and rows have non-zero prices
  2. For each price column (default + extra columns), shows per-lesson prices
  3. For each `durationOptions` week value, multiplies per-lesson × weeks for each column
  4. Groups them in a flex/grid with cards: "Per lesson" group, then one group per duration week
  5. Each group is a small card with a header and list of `label: €price` rows

**Translations** — add keys `form.priceOverview`, `form.perLesson`, `form.weeksTotal` to EN and NL.

### Files to modify
- `src/components/cycles/CycleForm.tsx`
- `src/i18n/locales/en/cycles.json`
- `src/i18n/locales/nl/cycles.json`

