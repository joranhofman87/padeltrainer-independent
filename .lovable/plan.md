

# Fix Lesson Type Multi-Select in Registration Form

## Problem
When clicking on a lesson type checkbox in the registration form, an error occurs. The user also wants:
1. "Group (3+ players)" to be selected by default
2. Users should be able to select/deselect other options

## Root Cause
The current implementation has a problematic nested `FormField` structure where:
- An outer `FormField` wraps the entire lesson types section
- Each checkbox item also has its own `FormField` wrapper
- Both the `FormItem` onClick handler and the `Checkbox` onCheckedChange handler try to update the same field value, causing conflicts

Additionally, the `allowedLessonTypes` variable comes from `cycle.settings.lesson_types || LESSON_TYPES`, but needs to be properly typed.

## Solution
Simplify the checkbox implementation by:
1. Removing the nested `FormField` pattern - use a single `FormField` with direct checkbox controls
2. Ensuring proper type casting for `allowedLessonTypes` 
3. Setting `['group']` as the default value to pre-select "Group (3+ players)"
4. Adding event.stopPropagation() to prevent conflicting click handlers

## Code Changes

**File: `src/components/cycles/CycleApplicationForm.tsx`**

### Change 1: Fix the default value (line 135-137)
Change the default to always include 'group':
```tsx
lesson_types: ['group'] as typeof LESSON_TYPES[number][],
```

### Change 2: Fix the allowedLessonTypes typing (line 241)
Cast properly to ensure type safety:
```tsx
const allowedLessonTypes = (cycle.settings.lesson_types as typeof LESSON_TYPES[number][] | undefined) || [...LESSON_TYPES];
```

### Change 3: Simplify the checkbox group rendering (lines 344-390)
Replace the nested FormField pattern with a single FormField and properly structured checkboxes:

```tsx
<FormField
  control={form.control}
  name="lesson_types"
  render={({ field }) => (
    <FormItem>
      <FormLabel>{t('application.form.lessonType')}</FormLabel>
      <div className="grid grid-cols-2 gap-2">
        {allowedLessonTypes.map(type => {
          const isChecked = field.value?.includes(type) ?? false;
          return (
            <div
              key={type}
              className="flex items-center space-x-2 rounded-md border p-3 cursor-pointer hover:bg-accent/50 transition-colors"
              onClick={() => {
                const current = field.value || [];
                const updated = current.includes(type)
                  ? current.filter((v: string) => v !== type)
                  : [...current, type];
                field.onChange(updated);
              }}
            >
              <Checkbox
                id={`lesson-type-${type}`}
                checked={isChecked}
                onCheckedChange={(checked) => {
                  const current = field.value || [];
                  const updated = checked
                    ? [...current, type]
                    : current.filter((v: string) => v !== type);
                  field.onChange(updated);
                }}
                onClick={(e) => e.stopPropagation()}
              />
              <label 
                htmlFor={`lesson-type-${type}`}
                className="font-normal cursor-pointer flex-1 m-0 text-sm"
              >
                {t(`application.form.lessonTypes.${type}`)}
              </label>
            </div>
          );
        })}
      </div>
      <FormMessage />
    </FormItem>
  )}
/>
```

## Technical Details
- **Single FormField**: Only one FormField wrapper for the entire checkbox group, not nested ones
- **stopPropagation**: Prevents the checkbox click from also triggering the parent div click handler
- **Proper typing**: Cast `allowedLessonTypes` to the correct union type array
- **Default selection**: 'group' is pre-selected when the form loads
- **Native HTML label**: Using standard `<label>` instead of FormLabel inside the map to avoid form hook conflicts

## Impact
- Single file change to `src/components/cycles/CycleApplicationForm.tsx`
- Fixes the error when selecting lesson types
- "Group (3+ players)" will be selected by default
- Users can freely select and deselect any lesson type options

