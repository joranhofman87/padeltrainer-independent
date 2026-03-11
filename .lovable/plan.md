

## Make 'Experience' Field Mandatory in Registration Form

### Changes

**1. `src/components/cycles/CycleApplicationForm.tsx`** (line 151)
- Change `notes: z.string().optional()` to `notes: z.string().min(1, t('application.form.experienceRequired'))` to make it mandatory
- Update the label on line 420 — the label already uses `t('application.form.notes')`, so we update the translations to remove "(optional)"

**2. Translation files** — update `application.form.notes`, `application.form.notesPlaceholder`, and add `application.form.experienceRequired` in all 5 locales:

| Locale | `notes` label | `notesPlaceholder` | `experienceRequired` |
|--------|--------------|---------------------|----------------------|
| EN | "Experience" | "How long have you played padel? Did you already have lessons before? Do you have a tennis background?" | "Please tell us about your experience" |
| NL | "Ervaring" | "Hoe lang speel je al padel? Heb je al eerder les gehad? Heb je een tennisachtergrond?" | "Vertel ons over je ervaring" |
| DE | "Erfahrung" | "Wie lange spielst du schon Padel? Hattest du bereits Unterricht? Hast du einen Tennis-Hintergrund?" | "Bitte erzähl uns von deiner Erfahrung" |
| ES | "Experiencia" | "¿Cuánto tiempo llevas jugando pádel? ¿Ya has tenido clases antes? ¿Tienes experiencia en tenis?" | "Por favor cuéntanos sobre tu experiencia" |
| FR | "Expérience" | "Depuis combien de temps jouez-vous au padel ? Avez-vous déjà pris des cours ? Avez-vous un passé tennistique ?" | "Veuillez nous parler de votre expérience" |

### Files to edit
- `src/components/cycles/CycleApplicationForm.tsx` — make `notes` required in zod schema
- `src/i18n/locales/en/cycles.json` — update label, placeholder, add validation message
- `src/i18n/locales/nl/cycles.json` — same
- `src/i18n/locales/de/cycles.json` — same
- `src/i18n/locales/es/cycles.json` — same
- `src/i18n/locales/fr/cycles.json` — same

