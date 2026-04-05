

# Fix: Slot Query Pagination + Invoice Split for Denise

## Two Issues

### 1. Search returns 0 results — Supabase 1000-row limit
The slots query fetches `availability_slots` with `.in('trainer_id', trainerIds)` but there are **1273 slots** total. Supabase caps at 1000 rows by default. Slots beyond 1000 (including many of Denise's trainer's slots) are silently dropped, so her bookings/player names never load.

**Fix**: Paginate the slots query in chunks (e.g. 500 per trainer, or use a loop fetching with `.range()`).

### 2. Invoice not split
INV-2026-0149 shows €949 (13 × €73) but the slots have **4 players each**. The previous data fix set the price correctly but did not run the split-invoice logic. Each of the 4 players should pay ~€237.25.

**Fix**: Run the split-invoice edge function for this invoice (and the other 45 that were fixed). Or apply a data migration that divides the totals.

## Changes

### `src/pages/academy/AcademyCyclusOverview.tsx` — Paginate slots query

Replace the single `.in('trainer_id', trainerIds)` query (lines 155-168) with a paginated approach:

```typescript
// Fetch slots in pages of 1000 to avoid Supabase row limit
let allSlots: any[] = [];
if (trainerIds.length > 0) {
  let page = 0;
  const pageSize = 1000;
  while (true) {
    const { data: slots } = await supabase
      .from('availability_slots')
      .select(/* same columns */)
      .in('trainer_id', trainerIds)
      .not('cyclus_id', 'is', null)
      .order('start_time', { ascending: true })
      .range(page * pageSize, (page + 1) * pageSize - 1);
    allSlots.push(...(slots || []));
    if (!slots || slots.length < pageSize) break;
    page++;
  }
}
```

### Data fix — Split the 46 repaired invoices

Run the `split-invoice` edge function for all invoices that were bulk-repaired with €73 pricing. This will:
- Find other players on the same slots
- Divide the total by the number of players
- Create split invoices for the other players

## File summary

| File | Change |
|------|--------|
| `src/pages/academy/AcademyCyclusOverview.tsx` | Paginate slots query to handle >1000 rows |
| Data fix (edge function calls) | Run split-invoice for the 46 repaired invoices that need splitting |

