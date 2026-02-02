
# Fix Supabase 1000 Row Limit for Locations

## The Problem
Supabase has a default limit of 1,000 rows per query. Your database has **1,408 locations**, but the admin page and public locations page only show 1,000 because the queries don't override this limit.

---

## Solution
Use `.range()` to fetch locations in larger chunks, or increase the limit. Since you have ~1,400 locations and likely growing, I'll implement pagination-style fetching that retrieves all records.

---

## Changes Required

### File: `src/lib/locations.ts`

**Update `getAllLocations()` (lines 69-82):**

```typescript
// Fetch all locations (for admin) - handles >1000 rows
export async function getAllLocations(): Promise<Location[]> {
  const allLocations: Location[] = [];
  const pageSize = 1000;
  let from = 0;
  let hasMore = true;

  while (hasMore) {
    const { data, error } = await supabase
      .from('locations')
      .select('*')
      .order('city', { ascending: true })
      .order('name', { ascending: true })
      .range(from, from + pageSize - 1);

    if (error) {
      console.error('Error fetching all locations:', error);
      throw error;
    }

    if (data) {
      allLocations.push(...data);
      hasMore = data.length === pageSize;
      from += pageSize;
    } else {
      hasMore = false;
    }
  }

  return allLocations;
}
```

**Update `getActiveLocations()` (lines 52-66) with the same pattern:**

```typescript
// Fetch all active locations - handles >1000 rows
export async function getActiveLocations(): Promise<Location[]> {
  const allLocations: Location[] = [];
  const pageSize = 1000;
  let from = 0;
  let hasMore = true;

  while (hasMore) {
    const { data, error } = await supabase
      .from('locations')
      .select('*')
      .eq('is_active', true)
      .order('city', { ascending: true })
      .order('name', { ascending: true })
      .range(from, from + pageSize - 1);

    if (error) {
      console.error('Error fetching locations:', error);
      throw error;
    }

    if (data) {
      allLocations.push(...data);
      hasMore = data.length === pageSize;
      from += pageSize;
    } else {
      hasMore = false;
    }
  }

  return allLocations;
}
```

---

## Also Update These Helper Functions

**`getUniqueCities()` and `getUniqueCountries()`** - Same issue, they only fetch first 1000:

```typescript
// Get unique cities from locations - handles >1000 rows
export async function getUniqueCities(): Promise<string[]> {
  const allCities: string[] = [];
  const pageSize = 1000;
  let from = 0;
  let hasMore = true;

  while (hasMore) {
    const { data, error } = await supabase
      .from('locations')
      .select('city')
      .eq('is_active', true)
      .order('city')
      .range(from, from + pageSize - 1);

    if (error) {
      console.error('Error fetching cities:', error);
      throw error;
    }

    if (data) {
      allCities.push(...data.map(l => l.city));
      hasMore = data.length === pageSize;
      from += pageSize;
    } else {
      hasMore = false;
    }
  }

  return [...new Set(allCities)];
}
```

Apply same pattern to `getUniqueCountries()`.

---

## Summary

| Function | Current Limit | After Fix |
|----------|---------------|-----------|
| `getAllLocations()` | 1,000 | All (1,408+) |
| `getActiveLocations()` | 1,000 | All |
| `getUniqueCities()` | 1,000 | All |
| `getUniqueCountries()` | 1,000 | All |

The fix uses a simple loop with `.range()` to fetch in batches of 1,000 until all records are retrieved.
