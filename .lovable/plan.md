

# Hide "Trainer Preference" Toggle for Individual Trainers

## Problem
When a trainer creates a cycle, they see the "Allow trainer preference" toggle. This doesn't make sense because:
- There's only one trainer (themselves)
- Players can't choose between trainers when there's only one option

This option is only relevant when an **academy** creates a cycle, since academies have multiple trainers.

## Solution
Conditionally render the "show_preferred_trainer" field only when `ownerType === 'academy'`.

## Files to Change

| File | Change |
|------|--------|
| `src/components/cycles/CycleForm.tsx` | Wrap the `show_preferred_trainer` FormField in a condition that only renders for academy-owned cycles |

## Implementation Details

In `CycleForm.tsx`, wrap lines 318-337 with a condition:

```tsx
{ownerType === 'academy' && (
  <FormField
    control={form.control}
    name="show_preferred_trainer"
    render={({ field }) => (
      <FormItem className="flex flex-row items-center justify-between rounded-lg border p-3">
        <div className="space-y-0.5">
          <FormLabel>{t('form.showPreferredTrainer')}</FormLabel>
          <FormDescription className="text-xs">
            {t('form.showPreferredTrainerHelp')}
          </FormDescription>
        </div>
        <FormControl>
          <Switch
            checked={field.value}
            onCheckedChange={field.onChange}
          />
        </FormControl>
      </FormItem>
    )}
  />
)}
```

## Additional Consideration
For trainer-owned cycles, we should also default `show_preferred_trainer` to `false` (since it won't be shown and shouldn't be enabled). The current default is `true`, which would still be saved even though the toggle isn't visible.

Update the `defaultValues` to:
```tsx
show_preferred_trainer: cycle?.settings?.show_preferred_trainer ?? (ownerType === 'academy'),
```

This ensures:
- Academy cycles: Default to showing trainer preference (true)
- Trainer cycles: Default to not showing trainer preference (false)

## Result
| Owner Type | Trainer Preference Toggle |
|------------|---------------------------|
| `trainer`  | Hidden, defaults to false |
| `academy`  | Visible, defaults to true |
| `club`     | Hidden, defaults to false |

