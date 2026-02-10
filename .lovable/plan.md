

## Improve City Page Layout and Add Dynamic FAQs

### Layout Fixes

The SEO content section currently uses `prose` classes which render as raw unstyled text (as visible in the screenshot). We'll wrap the SEO content in a proper Card component to match the rest of the page's visual style, making it look cleaner and more consistent.

### Additional Dynamic FAQs

Add these new FAQ questions that dynamically reference city data:

1. **"What padel clubs are in {city}?"** -- Lists the clubs by name with links, or says "check back soon" if none
2. **"Are there padel academies in {city}?"** -- Fetches academies linked to locations in this city via the `academy_locations` table and lists them
3. **"What level of player can take padel lessons in {city}?"** -- Generic but useful SEO content about all levels being welcome
4. **"How do I book a padel lesson in {city}?"** -- Explains the booking flow through the platform

All FAQs will also be included in the FAQPage JSON-LD structured data for SEO.

### Data Changes

To support the academy FAQ, we'll fetch academies linked to the city's locations using the existing `academy_locations` table (joined with `academy_profiles_public`). This query runs alongside the existing data fetches in `fetchData()`.

### Technical Details

**File: `src/pages/TrainersCity.tsx`**

1. **Add academy fetch** in `fetchData()`: Query `academy_locations` joined with `academy_profiles_public` for the city's location IDs. Store in new state `academies`.

2. **Expand `faqQuestions` array** with 3-4 new dynamic entries using the `locations`, `academies`, and `trainers` data.

3. **Fix SEO content layout**: Replace the raw `prose` section with a styled Card component so the "About Padel Training" section matches the page design.

4. **Update `faqStructuredData`** -- already dynamically built from `faqQuestions`, so adding more entries automatically updates the schema.

