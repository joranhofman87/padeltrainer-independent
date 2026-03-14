

# Plan: Add Google Maps URL Duplicate Detection Layer

## What changes

Add Google Maps URL as a second duplicate-detection check, slotting in between the GPS proximity check and the slug fallback. This applies both against existing database records and within the imported file itself.

## Detection priority (updated)

1. **GPS coordinates** — within 50m proximity
2. **Google Maps URL** — exact match (new)
3. **Slug** (name + city) — text fallback

## File: `src/components/admin/ImportLocationsDialog.tsx`

### Change 1: Fetch existing Google Maps URLs from database

Update the query on line ~335 to also select `google_maps_url`:
```sql
.select("id, name, city, slug, latitude, longitude, google_maps_url")
```

Build a lookup map of existing `google_maps_url → location name` for quick matching (excluding nulls/empty).

### Change 2: Database duplicate check — add Google Maps URL layer

After the coordinate proximity check (line ~373) and before the slug fallback (line ~374), add a new check: if the location was not already flagged as a duplicate by coordinates, check if its `google_maps_url` matches any existing location's URL. Only then fall through to slug matching.

The logic becomes:
- If coordinates exist → check proximity → if no match, check Google Maps URL → done
- If no coordinates → check Google Maps URL → if no match, check slug → done

### Change 3: Within-file duplicate check — add Google Maps URL layer

Same pattern for the within-file dedup loop (lines 383-420). Track seen Google Maps URLs in a `Map<string, string>` (url → name) alongside `seenCoords` and `seenSlugs`.

### Change 4: Translation key

Add `"googleMapsMatch"` error key to `src/i18n/locales/en/admin.json` under `locations.import.errors`:
```json
"googleMapsMatch": "Matches \"{{name}}\" (same Google Maps link)"
```

