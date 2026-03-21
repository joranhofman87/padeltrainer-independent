

# Split "Group" into "Group (3 players)" and "Group (4 players)"

## What Changes

Replace the single `group` lesson type with two separate types: `group3` and `group4`. This affects the registration form, the admin cycle creation form, the proposal scheduling, display logic, and the database constraint.

## 1. Database Migration

Update the check constraint on `intake_requests.lesson_type` to allow the new values:

```sql
ALTER TABLE public.intake_requests DROP CONSTRAINT IF EXISTS intake_requests_lesson_types_check;
ALTER TABLE public.intake_requests 
ADD CONSTRAINT intake_requests_lesson_types_check 
CHECK (lesson_type <@ ARRAY['private', 'duo', 'group', 'group3', 'group4', 'kids']::TEXT[]);
```

Keep `group` in the allowed list for backward compatibility with existing data. Also update the `waiting_list` table if it has a similar constraint.

## 2. Constants Update

**`src/components/cycles/CycleForm.tsx`** — Change `LESSON_TYPES`:
```ts
const LESSON_TYPES = ['private', 'duo', 'group3', 'group4', 'kids'] as const;
```

**`src/components/cycles/CycleApplicationForm.tsx`** — Change `STANDARD_LESSON_TYPES`:
```ts
const STANDARD_LESSON_TYPES = ['private', 'duo', 'group3', 'group4', 'kids'] as const;
```

**`src/lib/cycles.ts`** — Update `CycleSettings.lesson_types` type and `IntakeRequest.lesson_type` type to include `'group3' | 'group4'`.

**`src/components/cycles/AddIntakeRequestDialog.tsx`** — Update the inline `standardTypes` array.

**`src/lib/waitingList.ts`** — Update `LessonType` union.

**`src/components/waitingList/WaitingListForm.tsx`** — Update the inline array.

## 3. Default Value Updates

In `CycleForm.tsx`, update the default `lesson_types` from `['private', 'duo', 'group']` to `['private', 'duo', 'group3', 'group4']`.

## 4. i18n Updates (5 locales × 2 namespaces)

Add translation keys for the new types in `cycles.json` and `waitingList.json`:

| Key | EN | NL | ES | DE | FR |
|-----|----|----|----|----|-----|
| `group3` | Group (3 players) | Groep (3 spelers) | Grupo (3 jugadores) | Gruppe (3 Spieler) | Groupe (3 joueurs) |
| `group4` | Group (4 players) | Groep (4 spelers) | Grupo (4 jugadores) | Gruppe (4 Spieler) | Groupe (4 joueurs) |

Remove the old `group` key from cycles.json (keep in waitingList if needed for legacy).

## 5. Proposal Generator (Edge Function)

**`supabase/functions/generate-proposals/index.ts`** — No changes needed. The lesson_type is only used to check `!== 'private'` for rating spread logic, and slots use `max_group_size` from cycle settings. The new `group3`/`group4` values pass this check correctly.

## 6. Guest Intake Edge Function

**`supabase/functions/submit-guest-intake/index.ts`** — Update the fallback `standardAllowed` array to include `group3` and `group4` instead of `group`.

## 7. Display Logic (Backward Compatibility)

In all places that render lesson type labels via `t('lessonTypes.${type}')`, add fallback keys for the old `group` value so existing data still displays correctly. Add `group` translations as a legacy fallback in all locale files.

## 8. ProposalScheduleGrid

**`src/components/cycles/ProposalScheduleGrid.tsx`** — Already uses dynamic `t('lessonTypes.${lt}')`, so just the i18n keys handle it.

## Files to Modify
1. **Database migration** — Update check constraint
2. `src/components/cycles/CycleForm.tsx` — LESSON_TYPES constant + defaults
3. `src/components/cycles/CycleApplicationForm.tsx` — STANDARD_LESSON_TYPES constant
4. `src/components/cycles/AddIntakeRequestDialog.tsx` — standardTypes array
5. `src/lib/cycles.ts` — TypeScript types
6. `src/lib/waitingList.ts` — LessonType union
7. `src/components/waitingList/WaitingListForm.tsx` — Inline array
8. `supabase/functions/submit-guest-intake/index.ts` — standardAllowed fallback
9. **10 i18n files** — `{en,nl,es,de,fr}/cycles.json` and `{en,nl,es,de,fr}/waitingList.json`

