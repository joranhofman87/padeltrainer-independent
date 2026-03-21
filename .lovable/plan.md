

# Translate Registration Form Validation Error Messages

## Problem
The zod schema in `CycleApplicationForm.tsx` uses default (English) messages for `full_name` and `email` validators. When validation fails, users see raw English like "String must contain at least 2 character(s)" and "Invalid email" regardless of their language. There's also a hardcoded English fallback on the catch error toast (line 388).

## Changes

### 1. `src/components/cycles/CycleApplicationForm.tsx`
Add translated custom messages to the zod validators that currently lack them:

```ts
full_name: z.string().min(2, t('application.form.nameMin')),
email: z.string().email(t('application.form.emailInvalid')),
```

Also translate the catch error fallback on line 388:
```ts
toast.error(error.message || t('application.form.submitError'));
```

### 2. Add i18n keys to all 5 locale `cycles.json` files

Inside `application.form`:

| Key | EN | NL | ES | DE | FR |
|-----|----|----|----|----|-----|
| `nameMin` | Name must be at least 2 characters | Naam moet minimaal 2 tekens bevatten | El nombre debe tener al menos 2 caracteres | Name muss mindestens 2 Zeichen haben | Le nom doit contenir au moins 2 caractères |
| `emailInvalid` | Please enter a valid email address | Vul een geldig e-mailadres in | Introduce una dirección de correo válida | Bitte gib eine gültige E-Mail-Adresse ein | Veuillez entrer une adresse e-mail valide |
| `submitError` | Failed to submit application | Aanmelding kon niet worden verzonden | Error al enviar la solicitud | Bewerbung konnte nicht eingereicht werden | Échec de l'envoi de la candidature |

### Files
- `src/components/cycles/CycleApplicationForm.tsx` — 3 line changes
- `src/i18n/locales/{en,nl,es,de,fr}/cycles.json` — add 3 keys each

