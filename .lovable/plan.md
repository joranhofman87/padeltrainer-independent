

# Fix Trainer Names & Add Location Filter to Invoices

## Problem
1. **Trainer names show "Trainer"** — the filter fetches `business_name` from `trainer_profiles`, which is often empty. Need to fall back to `profiles.full_name` via `trainer_profiles.user_id`.
2. **No location filter** — invoices don't have a `location_id` column. Need to derive location from `booking_ids` → `bookings` → `availability_slots` → `location_id`, and add a filter dropdown.

## Changes

### 1. Fix trainer names in filter (`AcademyInvoices.tsx`)

The current query only fetches `trainer_profiles.business_name`. Since there's no FK from `trainer_profiles.user_id` to `profiles`, we need a two-step fetch:
- Fetch `academy_trainers` with `trainer_profiles(id, business_name, user_id)`
- Fetch `profiles` for all those `user_id`s to get `full_name`
- Use `business_name || full_name || "Trainer"` as display name

### 2. Add location filter (`AcademyInvoices.tsx`)

**Fetch academy locations:**
```typescript
const { data: locations } = useQuery({
  queryKey: ["academy-locations-filter", activeAcademy?.id],
  queryFn: async () => {
    const { data } = await supabase
      .from("academy_locations")
      .select("location_id, locations(id, name)")
      .eq("academy_profile_id", activeAcademy.id)
      .eq("is_active", true);
    return data;
  },
});
```

**Resolve invoice → location mapping:**
- When invoices load, collect all `booking_ids` from all invoices
- Batch-fetch bookings with their `slot_id`, then batch-fetch slots with `location_id`
- Build a map: `invoiceId → locationId`
- Use this map to filter invoices when a location is selected

**Add location filter dropdown** next to the trainer filter.

### 3. State & filtering

Add `locationFilter` state (default `"all"`). Chain the filter after trainer filter:
```
trainerFiltered → locationFiltered → tab filtered → search filtered
```

## Files Changed

| File | Change |
|------|--------|
| `src/pages/academy/AcademyInvoices.tsx` | Fix trainer name resolution (two-step query with profiles fallback); add location filter dropdown; resolve invoice-to-location via booking_ids→bookings→slots; filter by location |

