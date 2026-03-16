

## Add Duration (Weeks) to Cyclus Options

Currently the form has a single `number_of_weeks` field for the entire cycle. The user wants each cyclus option (package) to have its own duration, so players can choose e.g. "5 lessons / 5 weeks", "10 lessons / 10 weeks", "15 lessons / 15 weeks".

### Changes

#### 1. `src/lib/cycles.ts` — Add `number_of_weeks` to `CyclusOption`
```ts
export interface CyclusOption {
  label: string;
  number_of_sessions: number;
  number_of_weeks: number;       // NEW
  price_per_session: number;
  total_price: number;
}
```

#### 2. `src/components/cycles/CycleForm.tsx` — Update cyclus options builder
- Add a "Weeks" column to the cyclus options row grid (change from 5 to 6 columns).
- Each option row gets a `number_of_weeks` input field.
- When cyclus options exist, hide the single `number_of_weeks` field (since duration is per-option now).
- When computing `end_date` on submit, use the **max** `number_of_weeks` across all options as the cycle's end date.
- Initialize new options with `number_of_weeks: 0`.

#### 3. `src/components/cycles/CycleDetailDisplay.tsx` — Show weeks in price table
- Add a "Weeks" or "Duration" column to the cyclus options table so players see the duration per package.

#### 4. `src/components/cycles/CycleApplicationForm.tsx` — Show weeks in package selector
- Display the number of weeks alongside sessions/price in the radio card so players know the duration of each option.

#### 5. `src/i18n/locales/nl/cycles.json` — Add translations
- Add keys: `detail.weeks` ("Weken"), `form.numberOfWeeksColumn` ("Weken"), `application.form.weeks` ("weken").

### Files to modify
- `src/lib/cycles.ts`
- `src/components/cycles/CycleForm.tsx`
- `src/components/cycles/CycleDetailDisplay.tsx`
- `src/components/cycles/CycleApplicationForm.tsx`
- `src/i18n/locales/nl/cycles.json`

