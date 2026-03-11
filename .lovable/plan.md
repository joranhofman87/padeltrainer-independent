

## Add "Skipped" Filter Tab with Grouped Skip Reasons

### Current State
Skip reasons already exist in the database (`skip_reason` column on `intake_requests`) and are shown as small tooltip icons in the table's "Proposal" column. However, there's no dedicated filter to see all skipped registrations, and the reasons aren't grouped or summarized — you have to hover each row individually.

### Changes

#### 1. Add a "Skipped" status filter tab
In both `AcademyIntakeRequests.tsx` and `TrainerIntakeRequests.tsx`:
- Add a `skippedCount` computed from `requests.filter(r => r.status === 'new' && r.skip_reason)`.
- Add a new `TabsTrigger` for "skipped" after "new".
- Update the filter logic: when `statusFilter === 'skipped'`, filter to `r.status === 'new' && r.skip_reason`.

#### 2. Show grouped skip reason summary banner
When the "skipped" filter is active, render a summary section above the table that groups requests by `skip_reason` and shows counts:

```
┌──────────────────────────────────────────────────┐
│  ⚠ 8 registrations could not be matched          │
│                                                   │
│  No matching times ................ 4             │
│  All slots full ................... 2             │
│  Rating outside trainer range ..... 1             │
│  Level gap too large .............. 1             │
└──────────────────────────────────────────────────┘
```

This uses the existing `skipReasons.*.title` translations. Implemented as a simple `Alert` with a list, only visible when `statusFilter === 'skipped'`.

#### 3. Localization
Add to all 5 locale files:
- `intakeRequests.filters.skipped`: "Skipped" / "Overgeslagen" / etc.
- `intakeRequests.skippedSummary`: "{{count}} registrations could not be matched"

#### Files to edit
- `src/pages/academy/AcademyIntakeRequests.tsx` — add skipped filter + summary banner
- `src/pages/TrainerIntakeRequests.tsx` — same
- `src/i18n/locales/[en/nl/de/fr/es]/cycles.json` — add 2 keys each

No database or backend changes needed — all data already exists.

