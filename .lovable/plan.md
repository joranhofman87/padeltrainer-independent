
# Update Quick Stats on Trainer Profile

## What changes
Replace the current "Students" and "Lessons Given" stats (which always show 0) with more useful information:

**Remove:**
- Students (always 0)
- Lessons Given (always 0)

**Add:**
- Hourly Rate (e.g. "EUR 75/hr" or "--" if not set)
- Experience (e.g. "12 years" or "--")
- Verified status (checkmark or dash)

**Keep:**
- Rating
- Preferred Player Levels

## Technical Details

### File: `src/pages/TrainerProfile.tsx` (lines 338-343)

Replace the `quickStats` array construction:

```tsx
const quickStats = [
  {
    icon: <Euro className="h-4 w-4" />,
    label: t('common:hourlyRate', 'Hourly Rate'),
    value: trainer?.hourly_rate ? `€${trainer.hourly_rate}` : '—',
  },
  {
    icon: <Calendar className="h-4 w-4" />,
    label: t('common:experience', 'Experience'),
    value: trainer?.experience_years
      ? `${trainer.experience_years} ${t('common:years', 'years')}`
      : '—',
  },
  {
    icon: <CheckCircle className="h-4 w-4" />,
    label: t('common:verified', 'Verified'),
    value: trainer?.is_verified
      ? t('common:yes', 'Yes')
      : t('common:no', 'No'),
  },
  {
    icon: <Star className="h-4 w-4" />,
    label: t('common:rating', 'Rating'),
    value: averageRating !== null ? `${averageRating} ★` : '—',
  },
];
```

Also add `Euro` and `CheckCircle` to the lucide-react imports (CheckCircle is already imported, Euro needs adding).

No database or translation changes needed -- all values are already fetched and translation keys for "Hourly Rate", "Experience", "Verified" already exist in the common namespace.
