

# Update CSV Import to Support Your Data Format

## Overview
Your CSV is already **mostly compatible** with the current importer! Only one small change is needed: adding "Domain" as an alias for website_url.

---

## CSV Compatibility Analysis

| Your CSV Column | Database Field | Status |
|-----------------|----------------|--------|
| Name | name | ✅ Ready |
| Domain | website_url | ⚠️ **Need to add alias** |
| Street | street_address | ✅ Ready |
| Zipcode | postal_code | ✅ Ready |
| City | city | ✅ Ready |
| Country | country | ✅ Ready |
| Latitude | latitude | ✅ Ready |
| Longitude | longitude | ✅ Ready |
| Facebook | facebook_url | ✅ Ready |
| Instagram | instagram_url | ✅ Ready |
| outdoor courts | outdoor_courts | ✅ Ready |
| indoor courts | indoor_courts | ✅ Ready |
| Phone | phone | ✅ Ready |
| Review Count | google_review_count | ✅ Ready |
| Average Rating | google_rating | ✅ Ready |
| Email | email | ✅ Ready |
| Opening Hours | opening_hours | ✅ Ready |
| Google Maps URL | google_maps_url | ✅ Ready |

---

## Required Change

### File: `src/components/admin/ImportLocationsDialog.tsx`

Add "domain" as an alias for `website_url` in the HEADER_ALIASES mapping:

**Current (line 75):**
```typescript
website_url: ["website_url", "website", "url"],
```

**Updated:**
```typescript
website_url: ["website_url", "website", "url", "domain"],
```

---

## Data Quality Notes

### Coordinate Format
Your coordinates like `381.892.692` are already handled by the existing `normalizeCoordinate()` function which:
- Converts `381.892.692` → `38.1892692`
- Handles comma decimal separators (`44,895733` → `44.895733`)

### Duplicate Columns
Your CSV has `Zipcode`, `City`, `Country` appearing twice (columns 4-6 and 17-19). The importer uses the **first occurrence** of each column, which is correct.

### Rating Format
The rating `4,7` (comma decimal) is handled by the existing parser which converts to `4.7`.

---

## Summary

**Only 1 line needs to change** - adding "domain" to the website_url aliases. Your CSV is otherwise fully compatible with the existing importer, which already handles:
- All your column headers (except Domain)
- European number formats (comma decimals)
- Malformed coordinates
- Multiple email addresses
- Opening hours text

