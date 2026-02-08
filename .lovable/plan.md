
# Fix: Udenhout Location Not Found in LocationPicker

## Root Cause
The location "Tennis- en Padelvereniging Udenhout" has `country = 'Netherlands'` in the database, while the LocationPicker's country filter defaults to `'NL'`. This means all 345 locations stored with `country = 'Netherlands'` (plus 1 with `'Netherlands flag emoji'`) are invisible in the picker.

The country data across locations is highly inconsistent (e.g., `NL`, `Netherlands`, `Netherlands emoji`, `Belgium.`, city names used as countries, etc.).

## Solution
Two-pronged fix:

### 1. Database Migration: Normalize Country Codes
Run a migration to standardize all country values to ISO 2-letter codes. This fixes the data at the source:
- `Netherlands` / `Netherlands emoji` -> `NL`
- `Belgium` / `Belgium.` / `Maasmechelen` -> `BE`
- `Spain` / `Motril` / `Ripollet` -> `ES`
- `France` / `Gradignan` -> `FR`
- `United Kingdom` / `United Kingdom emoji` / `UK` -> `GB`
- `Germany` -> `DE`
- `United States` -> `US`
- `United Arab Emirates` / `Abu Dhabi` -> `AE`
- And similar for all other full-name entries

### 2. Update LocationPicker Country Map
Expand the `COUNTRIES` dictionary in `LocationPicker.tsx` to include labels for all ISO country codes present in the data (e.g., `ES: 'Espana'`, `BE: 'Belgie'`, `FR: 'France'`, etc.) so users can filter by any country.

## Files Changed
- **Database migration**: Normalize `locations.country` values to ISO codes
- **`src/components/locations/LocationPicker.tsx`**: Expand `COUNTRIES` map with all relevant country codes

## Impact
- Immediately fixes the Udenhout visibility issue
- Fixes 345+ other Dutch locations that were also hidden
- Prevents future recurrence by standardizing the data
- All location pickers across the app (academy, trainer, admin) benefit from this fix
