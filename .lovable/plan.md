

# Remove Email Help Text from Registration Form

## Change
Remove the helper text "We'll send you a confirmation and a link to set up your account." shown under the email field for guest users.

## File
**`src/components/cycles/CycleApplicationForm.tsx`** (lines 511–515)

Delete the conditional block:
```tsx
{isGuest && (
  <FormDescription className="text-xs">
    {t('application.form.yourEmailHelp', '...')}
  </FormDescription>
)}
```

Single-file, 5-line removal.

