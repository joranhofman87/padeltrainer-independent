

## Make Summary Card Multi-Selection Aware & Informative

### Problem
The "Jouw keuze" summary card only shows the first selected lesson type's price. When a player selects multiple types (e.g., Private + Group) or multiple durations, only one is shown. The card also looks too much like a checkout — it should be informative ("this is indicative pricing") not transactional.

### Changes

**`src/components/cycles/CycleApplicationForm.tsx`** (lines 869-977):

Replace the single-type price logic with a loop over all `watchedLessonTypes`:

1. For each selected lesson type, find its matching price table row (by index in `orderedTypes`)
2. Show a row per type: type label + per-lesson price + total (if weeks known)
3. If multiple durations are selected, show rows per duration as well
4. Change the card styling: remove `bg-primary/5 border-primary/20`, use a softer `bg-muted/30 border-muted` look
5. Replace `Calculator` icon + bold total with an `Info` icon
6. Add a small italic note: "Indicative pricing — final price confirmed after registration" (translated)
7. Remove the large bold total row — instead show per-line totals inline

**Layout sketch:**
```text
┌─ ℹ️ Price indication ─────────────────────┐
│                                             │
│  Private lesson    €25/les    14w: €350     │
│  Group lesson      €15/les    14w: €210     │
│                                             │
│  Duration: 60 min                           │
│                                             │
│  ⁱ Indicative — confirmed after enrollment  │
└─────────────────────────────────────────────┘
```

**Translation keys** (EN + NL):
- `application.summary.indicativeNote` — "Indicative pricing, confirmed after registration" / "Indicatieve prijzen, bevestigd na inschrijving"
- `application.summary.priceIndication` — "Price indication" / "Prijsindicatie"

### Files to modify
- `src/components/cycles/CycleApplicationForm.tsx`
- `src/i18n/locales/en/cycles.json`
- `src/i18n/locales/nl/cycles.json`

