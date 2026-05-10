## Bug

Clicking a day cell or day header in the week table calls `setCurrentDate(day)` and switches to the Day tab, but `AcademyDayGrid` ignores the new date and keeps showing the day that was selected when the grid first mounted (defaults to today).

## Cause

In `src/components/academy/AcademyDayGrid.tsx` (line 442–447):

```ts
const todayKey = format(new Date(), 'yyyy-MM-dd');
const defaultDay = weekDays.find(d => d.dayKey === todayKey)?.dayKey || weekDays[0].dayKey;
const [selectedDayKey, setSelectedDayKey] = useState(defaultDay);
```

`selectedDayKey` is initialised once and never re-syncs when the parent's `currentDate` prop changes. So clicking "WOE 13" in the week view updates `currentDate` upstream, but the day grid still renders today's tab. The same applies to `TrainerDayGrid` if it uses the same pattern.

## Fix

In `AcademyDayGrid`:
- Add a `useEffect` that updates `selectedDayKey` to `format(currentDate, 'yyyy-MM-dd')` whenever `currentDate` changes (when the new key exists in `weekDays`).
- Keep the local `useState` so users can still switch days via the in-grid tab strip without round-tripping to the parent.

Check `src/components/trainer/TrainerDayGrid.tsx` (or equivalent) for the same pattern and apply the same effect.

## Out of scope

No changes to date arithmetic, timezone handling, or the week table itself. Just sync the day-grid's selected tab to the incoming `currentDate` prop.
