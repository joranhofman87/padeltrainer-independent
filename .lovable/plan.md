

## Make the Homepage Feel More Human

Two issues: (1) em-dashes everywhere signal AI-written copy, and (2) every section follows the same icon-in-colored-box + text pattern, creating visual monotony.

### 1. Kill the em-dashes across all 5 languages

Replace every `—` in the `homev2` section of `marketing.json` (en, nl, de, fr, es) with natural alternatives: periods, commas, "so", "and", or just split into two sentences. There are ~15 instances in EN alone. Examples:

| Before | After |
|--------|-------|
| `"You became a coach to be on court — not to be a scheduling assistant."` | `"You became a coach to be on court. Not to manage a calendar."` |
| `"Bookings, confirmations, reminders — it all happens automatically."` | `"Bookings, confirmations, reminders. All automatic."` |
| `"Built specifically for padel coaching — not repurposed from..."` | `"Built for padel coaching. Not repurposed from..."` |
| `"Calendar sync, payment collection, booking confirmations, reminders — all automatic."` | `"Calendar sync, payments, confirmations, reminders. Runs itself."` |
| `"Real problems padel trainers deal with — and how we handle them."` | `"Real problems trainers deal with. And how we solve them."` |
| `"Players book and pay online — done"` | `"Players book and pay online. Done."` |
| `"You're increasing volume — more sessions, more locations."` | `"You're growing. More sessions, more locations."` |
| `"Yes — through your personal booking page."` | `"Yes, through your personal booking page."` |
| `"Built for padel from day one — group sessions, court types..."` | `"Built for padel from day one. Group sessions, court types..."` |

Same treatment in NL, DE, FR, ES files.

### 2. Reduce icon repetition in components

The "icon in a colored rounded box" pattern is used in nearly every section. Changes:

**`SolutionOverview.tsx`** - Remove the icon boxes entirely. The mini-illustrations (MiniCalendarGrid, MiniChecklist, etc.) already communicate the concept. Drop the `icon` from the `values` array and remove the `h-10 w-10 rounded-lg bg-primary/10` wrapper. Just show the Visual + text.

**`PadelRealitiesSection.tsx`** - Remove the per-card icon boxes (`h-8 w-8 rounded-lg bg-destructive/10`). The before/after text pattern is already clear with the strikethrough + checkmark. Keep only the `CheckCircle2` on the "with" line. Remove the `cardConfig` icon mapping and the destructive icon wrapper.

**`JobsToBeDoneSection.tsx`** - Keep the icon (it differentiates the persona) but drop the mini-illustrations (MiniOrgChart, MiniSchedule, MiniClubCourts). They're too abstract to add meaning and just add more "AI pattern." The bullet lists already explain each persona well.

**`HowItWorksSection.tsx`** - Keep the mini-visuals (they're useful here). Remove the `icon` from the steps array since they're not rendered anyway. Keep as-is otherwise.

### 3. Vary the copy rhythm

Rewrite a few headlines/descriptions in EN to break the pattern of "short punchy fragment. Short punchy fragment." Mix in a longer sentence or a question:

- Solution headline: `"One tool for your sessions, payments, and schedule."` → `"Stop juggling five apps to run your coaching."`
- JTBD intro: `"Whether you're a solo trainer, running an academy, or managing court schedules at a club."` → `"Solo trainer, academy, or club. We built it to work for all three."`
- FAQ headline: `"Questions"` → `"Got questions?"`

Apply equivalent changes to NL, DE, FR, ES.

### Files to modify
- `src/i18n/locales/en/marketing.json` (copy rewrites + em-dash removal)
- `src/i18n/locales/nl/marketing.json` (same)
- `src/i18n/locales/de/marketing.json` (same)
- `src/i18n/locales/fr/marketing.json` (same)
- `src/i18n/locales/es/marketing.json` (same)
- `src/components/home/SolutionOverview.tsx` (remove icon boxes)
- `src/components/home/PadelRealitiesSection.tsx` (remove per-card icon boxes)
- `src/components/home/JobsToBeDoneSection.tsx` (remove mini-illustrations)

