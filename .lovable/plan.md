

# Use Academy/Trainer Name in Email Sign-Off

## Problem
Line 888 of `supabase/functions/send-email/index.ts` hardcodes the sign-off as:
```
Met sportieve groet, PadelTrainer.ai Team
```
It should show the academy or trainer name when available (via `data.ownerName`, which is already passed).

## Fix

**File**: `supabase/functions/send-email/index.ts` (line 888)

Replace:
```html
<p>${t.regards}<br><a href="https://padeltrainer.ai" style="...">PadelTrainer.ai</a> Team</p>
```

With:
```html
<p>${t.regards}<br>${data.ownerName || data.trainerName || 'PadelTrainer.ai Team'}</p>
```

When `ownerName` (academy name) or `trainerName` is available, it signs off with that name. Falls back to "PadelTrainer.ai Team" if neither is set.

| File | Change |
|------|--------|
| `supabase/functions/send-email/index.ts` | Line 888: use `data.ownerName` or `data.trainerName` instead of hardcoded "PadelTrainer.ai Team" |

