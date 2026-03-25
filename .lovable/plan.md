

# Fix Registration Confirmation Email

## Issues
1. **Deadline date off by one day** — `new Date('2026-03-30')` is parsed as UTC midnight, which when formatted in `nl-NL` locale becomes March 29 (previous day in CET). Fix: append `T12:00:00` to date-only strings before parsing to avoid timezone shift.

2. **Lesson types shown as raw English keys** — Values like `group3`, `private`, `duo` are displayed without translation. Need a localized label map.

## Changes

### `supabase/functions/send-email/index.ts`

**Fix 1 — Date formatting (line ~788-793):**
Update `formatDate` to detect date-only strings (YYYY-MM-DD) and append `T12:00:00` before parsing:
```typescript
const formatDate = (dateStr?: string) => {
  if (!dateStr) return null;
  try {
    const safe = dateStr.length === 10 ? `${dateStr}T12:00:00` : dateStr;
    const d = new Date(safe);
    return d.toLocaleDateString(...);
  } catch { return dateStr; }
};
```

**Fix 2 — Translate lesson type labels (line ~820):**
Add a per-language lesson type label map to the translations object:
```typescript
lessonTypeLabels: {
  private: 'Privé (1:1)',
  duo: 'Duo (2 spelers)',
  group: 'Groep (3 of 4 spelers)',
  group3: 'Groep (3 spelers)',
  group4: 'Groep (4 spelers)',
  kids: 'Kindertraining',
}
```
Then on line 820, map the raw lesson type keys through the label map before joining:
```typescript
const translatedTypes = data.lessonTypes.map(lt => t.lessonTypeLabels[lt] || lt);
summaryRows.push(`...${translatedTypes.join(', ')}`);
```

Add the same labels for en, es, de, fr (matching the `cycles.json` translations).

### Redeploy
Deploy `send-email` edge function after changes.

## Files
- `supabase/functions/send-email/index.ts` — Fix date timezone shift + translate lesson types

