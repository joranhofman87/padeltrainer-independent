

# Improve Location Search in Admin Panel

Enhance the location search functionality when connecting locations to academies so users can search by any part of the name or city, across all 1,700+ locations.

---

## Current Problem

The admin panel's `AcademyEditDialog` limits loaded locations to the first 500 for performance. While the search logic already filters by name and city, it can only search within this limited subset - locations outside the first 500 are invisible to the search.

---

## Solution: Server-Side Search

Replace the client-side search with server-side search that queries the full database when the user types a search term.

---

## Implementation

### 1. Add Server-Side Location Search Function

Create a new function in `src/lib/locations.ts` that searches locations directly in the database:

```text
searchLocations(query: string, limit: number)
  - Uses ilike for partial matching on name
  - Uses ilike for partial matching on city
  - Returns matching locations up to the limit
  - Handles empty query by returning first N locations
```

### 2. Update Admin Academy Edit Dialog

Modify `src/components/admin/AcademyEditDialog.tsx`:

| Change | Description |
|--------|-------------|
| Add debounced search | Prevent excessive API calls while typing |
| Load initial 100 locations | Show some options before user searches |
| Trigger server search on input | Call `searchLocations` when user types 2+ characters |
| Show loading state | Indicate when search is in progress |
| Remove 500-slice limit | Full search happens server-side |

### 3. Update LocationPicker Component

Apply the same pattern to `src/components/locations/LocationPicker.tsx` so all location pickers benefit:

- Add optional `serverSearch` mode prop
- When enabled, use debounced server-side search
- Fall back to existing client-side search for smaller datasets

---

## Files to Modify

| File | Changes |
|------|---------|
| `src/lib/locations.ts` | Add `searchLocations(query, limit)` function with ilike queries |
| `src/components/admin/AcademyEditDialog.tsx` | Implement debounced server-side location search |
| `src/components/locations/LocationPicker.tsx` | Add optional server-side search mode |

---

## Search Behavior

```text
User types: "amst"
  -> Server query: WHERE name ILIKE '%amst%' OR city ILIKE '%amst%'
  -> Returns: All locations in Amsterdam, plus "Sportcenter Amstelveen", etc.

User types: "sunset"
  -> Server query: WHERE name ILIKE '%sunset%' OR city ILIKE '%sunset%'  
  -> Returns: "Sunset Padel" in Alphen a/d Rijn
```

---

## Technical Details

- Debounce delay: 300ms to avoid excessive queries
- Minimum search length: 2 characters before triggering server search
- Initial load: 100 most relevant locations (alphabetically by city/name)
- Search results limit: 100 locations per search

