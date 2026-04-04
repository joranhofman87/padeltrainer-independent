

# Remove "the Netherlands" from sharing/OG metadata — go global

## Source of the problem
The text in your screenshot ("Find & Book Padel Trainers in the Netherlands") comes from the **render-page edge function** (`supabase/functions/render-page/index.ts`). This is the SSR function that serves OG meta tags to social media crawlers. The i18n translations used in the actual React app are already location-neutral.

Additionally, `public/llms.txt` and `public/manifest.json` contain Netherlands-specific copy.

## Changes

| File | What changes |
|------|-------------|
| `supabase/functions/render-page/index.ts` | Replace all "in the Netherlands" / "in Nederland" references in homepage, trainers, locations, and about page meta with location-neutral copy |
| `public/llms.txt` | Update description from "Netherlands" to global focus |
| `public/manifest.json` | Update description to remove "in the Netherlands" |

### Specific copy changes in render-page:

**Homepage (line 60-64):**
- EN title: "PadelTrainer.ai - Find & Book Padel Trainers" → "PadelTrainer.ai - Scheduling, Bookings & Payments for Padel Trainers"
- EN desc: "Discover certified padel trainers at locations across the Netherlands..." → "Run your padel coaching business from one place. Online booking, secure payments, and calendar sync."
- NL title: "PadelTrainer.ai - Vind & Boek Padel Trainers in Nederland" → "PadelTrainer.ai - Planning, Boekingen & Betalingen voor Padel Trainers"
- NL desc: remove "door heel Nederland"

**Trainers page (line 97-101):**
- "Browse all certified padel trainers in the Netherlands" → "Browse all certified padel trainers. Filter by location, level, and specialization."

**Locations page (line 133-138):**
- "Browse all padel clubs and locations in the Netherlands" → "Browse all padel clubs and locations. Find courts near you."

**About page (line 269):**
- "the leading platform for finding and booking padel trainers in the Netherlands" → "the leading platform for padel trainers and academies"

This aligns the sharing metadata with the already-global i18n SEO copy.

