

# Fix CSV Export TypeError

## Problem
The `escCsv` helper in `exportIntakeRequestsToCsv` calls `.replace()` on its parameter assuming it's always a string. But some fields (like `lesson_type`) can be arrays or numbers, causing `TypeError: .replace is not a function`.

## Fix

**File: `src/lib/cycles.ts`**, line 1544

Change the `escCsv` function to coerce any value to a string first:

```ts
const escCsv = (val: unknown) => `"${String(val ?? '').replace(/"/g, '""')}"`;
```

Also fix `lesson_type` on line 1562 — it may be an array, so it should be joined like `preferred_days`:

```ts
Array.isArray(r.lesson_type) ? r.lesson_type.join('; ') : (r.lesson_type ?? ''),
```

Additionally, add `document.body.appendChild(a)` before `a.click()` and cleanup after, as some browsers require the anchor to be in the DOM for the download to trigger.

## Files Changed

| File | Change |
|------|--------|
| `src/lib/cycles.ts` | Fix `escCsv` to accept `unknown` and use `String()`, handle array `lesson_type`, fix anchor click download |

