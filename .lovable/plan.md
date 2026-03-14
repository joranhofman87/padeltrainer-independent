

# Improve Form Validation UX — Show Specific Field Errors

## Problem
The current validation error summary near the submit button only shows a generic "Please fill in all required fields" message. Users don't know *which* fields are missing or invalid, especially on a long form where errors may be off-screen.

## Solution

Two changes in `src/components/cycles/CycleApplicationForm.tsx`:

### 1. Replace generic message with a specific error list
Show each invalid field by its human-readable label (translated) so users know exactly what to fix:

```tsx
{Object.keys(form.formState.errors).length > 0 && (
  <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive space-y-1">
    <p className="font-medium">Please fix the following:</p>
    <ul className="list-disc pl-4 space-y-0.5">
      {form.formState.errors.birth_date && <li>Date of birth</li>}
      {form.formState.errors.notes && <li>Experience</li>}
      {form.formState.errors.lesson_types && <li>Lesson type</li>}
      {form.formState.errors.availability && <li>Availability</li>}
      {form.formState.errors.consent && <li>Consent</li>}
      {/* etc. for each field */}
    </ul>
  </div>
)}
```

Each label will use the existing translation keys (e.g., `t('application.form.birthDate')`) so it works in all languages.

### 2. Auto-scroll to first error on submit
Configure react-hook-form's `onSubmit` to scroll the first invalid field into view when validation fails:

```tsx
const form = useForm<FormValues>({
  resolver: zodResolver(formSchema),
  defaultValues: { ... },
});

// On the <form> element:
<form onSubmit={form.handleSubmit(onSubmit, () => {
  // Scroll to first error field
  const firstErrorKey = Object.keys(form.formState.errors)[0];
  const el = document.querySelector(`[name="${firstErrorKey}"]`) 
    || document.getElementById(`${firstErrorKey}-form-item`);
  el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
})}>
```

### Files to change
- `src/components/cycles/CycleApplicationForm.tsx` — error summary + scroll-to-error
- `src/i18n/locales/en/cycles.json` and `es/cycles.json` — add `validationSummary` key and field-specific labels if missing

