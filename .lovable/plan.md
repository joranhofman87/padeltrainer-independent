
# Plan: CSV Bulk Import for Locations with Extended Fields

## Overview
Build a complete CSV import system for 8,000 padel clubs, including database schema updates to support the additional data fields present in your dataset.

---

## Database Schema Changes

The CSV contains valuable additional fields that aren't in the current `locations` table. These need to be added:

| New Column | Type | Purpose |
|------------|------|---------|
| `phone` | text | Contact phone number |
| `email` | text | Contact email |
| `facebook_url` | text | Facebook page URL |
| `instagram_url` | text | Instagram profile URL |
| `google_maps_url` | text | Direct Google Maps link |
| `google_rating` | numeric | Average Google rating (1-5) |
| `google_review_count` | integer | Number of Google reviews |
| `opening_hours` | text | Opening hours (raw text from Google) |

**Migration SQL:**
```sql
ALTER TABLE public.locations
ADD COLUMN IF NOT EXISTS phone text,
ADD COLUMN IF NOT EXISTS email text,
ADD COLUMN IF NOT EXISTS facebook_url text,
ADD COLUMN IF NOT EXISTS instagram_url text,
ADD COLUMN IF NOT EXISTS google_maps_url text,
ADD COLUMN IF NOT EXISTS google_rating numeric,
ADD COLUMN IF NOT EXISTS google_review_count integer,
ADD COLUMN IF NOT EXISTS opening_hours text;

-- Add index for performance on large dataset
CREATE INDEX IF NOT EXISTS idx_locations_city ON public.locations(city);
CREATE INDEX IF NOT EXISTS idx_locations_country ON public.locations(country);
```

---

## CSV Column Mapping

Your CSV has many columns. Here's how they'll map:

| CSV Column | Database Column | Notes |
|------------|-----------------|-------|
| Name | `name` | Required |
| City | `city` | Required |
| Country | `country` | Defaults to 'NL' |
| Street | `street_address` | |
| Zipcode | `postal_code` | |
| Website/website | `website_url` | |
| Latitude | `latitude` | Needs decimal normalization |
| Longitude | `longitude` | Needs decimal normalization |
| Phone | `phone` | NEW |
| Email | `email` | NEW |
| Facebook | `facebook_url` | NEW |
| Instagram | `instagram_url` | NEW |
| Google Maps URL | `google_maps_url` | NEW |
| Average Rating | `google_rating` | NEW |
| Review Count | `google_review_count` | NEW |
| Opening Hours | `opening_hours` | NEW |
| outdoor courts | `outdoor_courts` | |
| indoor courts | `indoor_courts` | |
| Description | `description` | |

---

## New Files

### 1. `src/components/admin/ImportLocationsDialog.tsx`
A 4-step wizard dialog following the `ImportPlayersDialog` pattern:

**Step 1 - Upload:**
- Drag-and-drop zone for CSV files
- Template download button
- Column requirements info

**Step 2 - Preview:**
- Scrollable table showing parsed data
- Validation status indicators (valid/invalid/duplicate)
- Error messages for each row
- Summary badges (valid count, invalid count, duplicate count)

**Step 3 - Importing:**
- Progress bar with percentage
- Batch inserts (100 records per batch for reliability)
- Count display updating in real-time

**Step 4 - Complete:**
- Success/failure summary
- Option to close or import more

**Key Features:**
- Flexible header detection (handles multiple column names)
- Auto-generate unique slugs using `name-city` format
- Duplicate detection (pre-flight slug check against database)
- Handle coordinate format issues (your data shows `40.348.709` format needs normalization to `40.348709`)
- Batch processing to prevent timeouts

### 2. Update `src/lib/locations.ts`
Add helper function:
```typescript
export async function checkExistingSlugs(slugs: string[]): Promise<Set<string>> {
  // Batch check for existing slugs to detect duplicates
}
```

### 3. Update `src/pages/admin/AdminLocations.tsx`
- Add "Import CSV" button next to "Add Location"
- Wire up the new dialog

### 4. Update `src/lib/locations.ts` Interface
Update the `Location` interface to include new fields:
```typescript
export interface Location {
  // existing fields...
  phone: string | null;
  email: string | null;
  facebook_url: string | null;
  instagram_url: string | null;
  google_maps_url: string | null;
  google_rating: number | null;
  google_review_count: number | null;
  opening_hours: string | null;
}
```

### 5. i18n Translation Keys
Add to `src/i18n/locales/en/admin.json` and `nl/admin.json`:
```json
{
  "locations": {
    "import": {
      "title": "Import Locations",
      "description": "Bulk import padel clubs from CSV file",
      "dropHere": "Drop CSV file here",
      "orClickToSelect": "or click to select",
      "selectFile": "Select File",
      "downloadTemplate": "Download Template",
      "needTemplate": "Need a template?",
      "templateDescription": "Download our CSV template with the correct column format",
      "validRows": "{{count}} valid",
      "invalidRows": "{{count}} invalid", 
      "duplicateRows": "{{count}} duplicates",
      "importing": "Importing locations...",
      "complete": "Import Complete",
      "importedCount": "{{count}} locations imported",
      "failedCount": "{{count}} failed",
      "skippedCount": "{{count}} skipped (duplicates)",
      "errors": {
        "nameMissing": "Name is required",
        "cityMissing": "City is required",
        "duplicateSlug": "Already exists"
      }
    }
  }
}
```

---

## Implementation Details

### Coordinate Normalization
Your CSV shows coordinates like `40.348.709` which needs to be converted to `40.348709`. The importer will:
```typescript
const normalizeCoordinate = (value: string): number | null => {
  // Handle formats like "40.348.709" -> 40.348709
  // Also handle comma decimals like "40,348709"
};
```

### Slug Generation
```typescript
const generateSlug = (name: string, city: string): string => {
  return `${name}-${city}`
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // Remove accents
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
};
```

### Batch Insert Strategy
- **Batch size:** 100 records
- **For 8,000 clubs:** ~80 batches = ~1-2 minutes total
- Progress updates after each batch

---

## UI Integration

The Admin Locations page header will have two buttons:
```
[Import CSV]  [Add Location]
```

---

## Performance Considerations

- **Indexes** on `slug`, `city`, and `country` for fast filtering
- **Batch inserts** of 100 records to avoid timeouts
- **Pre-flight duplicate check** to minimize database errors
- **Client-side parsing** to reduce server load

---

## Summary

| Task | Description |
|------|-------------|
| Database migration | Add 8 new columns to `locations` table |
| `ImportLocationsDialog` | New component with 4-step wizard |
| `locations.ts` updates | Add helper function and update interface |
| `AdminLocations.tsx` | Add import button and dialog integration |
| i18n translations | Add EN/NL keys for import UI |
