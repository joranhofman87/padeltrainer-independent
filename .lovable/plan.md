

## CycleForm Improvements: Remove Description, Add Timeframe, Auto-fill Pricing

### Changes

**1. Remove the Description field**
Take out the rich text editor for description from the form. It's not needed per slot.

**2. Add Timeframe fields (e.g. 16:00 - 17:00)**
Add two time inputs (`start_time` and `end_time`) next to the start date and number of weeks. This tells the system what time of day the training takes place. These will be stored in the cycle settings.

**3. Auto-calculate pricing from trainer hourly rate**
When a trainer is selected (or for trainer-owned cycles, using their own rate), and the timeframe + number of weeks are filled in:
- **Price per session** = hourly_rate * (duration in hours). E.g. 1.5 hours at EUR 60/hr = EUR 90
- **Total price** = price per session * number of weeks

The prices will be pre-filled but remain editable so the trainer can adjust if needed.

### Technical Details

**File: `src/components/cycles/CycleForm.tsx`**
- Remove the `description` field from schema, defaults, reset, submit, and the UI block (lines 249-265)
- Add `start_time` (string, e.g. "16:00") and `end_time` (string, e.g. "17:00") to the Zod schema with defaults "09:00" and "10:00"
- Add two time `<Input type="time">` fields in a row below the start date / weeks row
- Store `start_time` and `end_time` in the cycle `settings` object on submit
- Extend the `trainers` prop type from `{ id: string; name: string }` to `{ id: string; name: string; hourly_rate?: number }`
- Add a `useEffect` that watches `assigned_trainer_id` (or uses own rate for trainer-owned cycles), `start_time`, `end_time`, and `number_of_weeks` -- when all are present, calculate and set `price_per_session` and `total_price` using `setValue`

**File: `src/pages/TrainerDashboard.tsx`**
- Fetch `hourly_rate` alongside `id` in the trainer profile query
- Pass it to `CycleForm` as a new `trainerHourlyRate` prop (since trainer-owned cycles don't use the trainers array)

**File: `src/pages/academy/AcademyCalendar.tsx`**
- Include `hourly_rate` when mapping trainers to the `CycleForm` trainers prop: `trainers.map(t => ({ id: t.id, name: t.name, hourly_rate: t.hourly_rate }))`

**File: `src/pages/TrainerCalendar.tsx`**
- Same as TrainerDashboard: fetch and pass `trainerHourlyRate`

**File: `src/pages/TrainerCycles.tsx`** and **`src/pages/academy/AcademyCycles.tsx`**
- Same pattern: pass hourly rate data to CycleForm

**Locale files** (`en/cycles.json`, `nl/cycles.json`)
- Add keys for `form.startTime` ("Start Time" / "Starttijd") and `form.endTime` ("End Time" / "Eindtijd")

### Pricing auto-fill logic (pseudo-code)
```
durationMinutes = differenceInMinutes(endTime, startTime)
durationHours = durationMinutes / 60
pricePerSession = trainerHourlyRate * durationHours
totalPrice = pricePerSession * numberOfWeeks
```

### What stays the same
- Database schema (description column remains, just won't be populated from this form)
- All other form fields (name, location, trainer, rating, lesson types, group sizes, etc.)
- Pricing fields remain editable after auto-fill
