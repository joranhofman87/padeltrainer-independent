

# Make Phone Field Mandatory on Registration Form

## What changes

One line in `src/components/cycles/CycleApplicationForm.tsx` — change the phone validation from optional to required.

### Change

**Line 154** — replace:
```typescript
phone: z.string().optional(),
```
with:
```typescript
phone: phoneSchemaRequired,
```

Import `phoneSchemaRequired` from `@/lib/validation` (already exists — validates Dutch phone format and requires non-empty input).

This gives you both "required" enforcement and proper Dutch phone number format validation, with the existing translated error messages (`validation.phoneRequired`, `validation.phoneInvalid`).

## File summary

| File | Change |
|------|--------|
| `src/components/cycles/CycleApplicationForm.tsx` | Import `phoneSchemaRequired`, use it for phone field validation |

