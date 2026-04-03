

# Timezone Setting for Academies & Trainers

## Problem
The edge function creates slots using `setHours()` in UTC. A trainer in Amsterdam (UTC+2) setting 18:00 gets slots stored as `18:00 UTC`, which displays as `20:00` locally — or conversely, slots appear at midnight when they shouldn't. There's no timezone setting anywhere in the system; `Europe/Amsterdam` is hardcoded only in the Google Calendar sync.

## Approach

### 1. Database: Add `timezone` column to both `trainer_profiles` and `academy_profiles`
- `ALTER TABLE trainer_profiles ADD COLUMN timezone text NOT NULL DEFAULT 'Europe/Amsterdam';`
- `ALTER TABLE academy_profiles ADD COLUMN timezone text NOT NULL DEFAULT 'Europe/Amsterdam';`
- Default to `Europe/Amsterdam` since this is a Dutch padel platform

### 2. Settings UI: Add timezone picker
- **Trainer Settings** (`TrainerSettings.tsx`): Add a timezone selector card (similar to the language card) with common European timezones + a full IANA list
- **Academy Settings** (`AcademySettings.tsx`): Same timezone picker for the academy level

Common options shown first: `Europe/Amsterdam`, `Europe/London`, `Europe/Madrid`, `Europe/Berlin`, `Europe/Paris`, `Europe/Rome`, `America/New_York`, etc. Full list available via search.

### 3. Generate Proposals: Use timezone for slot creation
- **`src/lib/cycles.ts`**: Pass `timezone` to the edge function (fetch from trainer/academy profile)
- **`src/components/cycles/GenerateProposalsWizard.tsx`**: Fetch and pass the timezone
- **`supabase/functions/generate-proposals/index.ts`**: Accept `timezone` param. Instead of `setHours(h, m)` (which is UTC), compute the UTC offset for the target timezone on that specific date (handles DST), then store `(localHour - offset)` as UTC. This way `18:00 Amsterdam` stores as `16:00 UTC` in summer, `17:00 UTC` in winter.

### 4. Display: Consistent timezone-aware formatting
- **`src/pages/ProposalOverviewPage.tsx`**: Update `formatTime()` and `formatDayLabel()` to accept and use the cycle's timezone via `toLocaleTimeString([], { timeZone })`. This ensures times display correctly regardless of the viewer's local timezone.
- Same approach for any other place that renders slot times from proposals.

### 5. Player-facing clarity
- On registration forms and booking confirmations, display the timezone label next to times (e.g. "18:00 CET" or "18:00 (Amsterdam time)")

## Technical Detail: UTC Offset Calculation in Edge Function

```typescript
// Get UTC offset for a timezone on a specific date
function getTimezoneOffsetMinutes(date: Date, tz: string): number {
  const utcStr = date.toLocaleString('en-US', { timeZone: 'UTC' });
  const tzStr = date.toLocaleString('en-US', { timeZone: tz });
  return (new Date(utcStr).getTime() - new Date(tzStr).getTime()) / 60000;
}

// When creating a slot at localHour:localMin in target timezone:
const offsetMin = getTimezoneOffsetMinutes(currentDate, timezone);
startDateTime.setUTCHours(localHour, localMin + offsetMin, 0, 0);
```

This handles DST automatically — the offset is calculated per-date.

## Files

| File | Change |
|------|--------|
| Migration | Add `timezone` column to `trainer_profiles` and `academy_profiles` |
| `src/pages/TrainerSettings.tsx` | Add timezone picker card |
| `src/pages/academy/AcademySettings.tsx` | Add timezone picker card |
| `src/lib/cycles.ts` | Fetch timezone from profile, pass to edge function |
| `src/components/cycles/GenerateProposalsWizard.tsx` | Include timezone in generation config |
| `supabase/functions/generate-proposals/index.ts` | Accept timezone, apply offset when creating slot times |
| `src/pages/ProposalOverviewPage.tsx` | Use timezone-aware formatting for slot display |

