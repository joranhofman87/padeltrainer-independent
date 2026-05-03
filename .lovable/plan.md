## Goal

Fix the duplicate invoice for Martijn (26000207 / 26000208 created 155ms apart) and prevent it from happening again.

---

## Root cause

The `finalize-proposals` flow was triggered twice in parallel (likely a double-click on "Approve & Book" in `ProposalOverviewPage`). Each call ran `auto-create-invoice` for Martijn's bookings. The dedup check in `auto-create-invoice` (lines 410-439) is a check-then-insert pattern - both parallel runs read "no existing invoice", then both inserted. Result: two identical invoices with sequential numbers.

---

## Step 1 - Data cleanup (immediate)

Cancel the later duplicate so Martijn isn't billed twice:

```sql
UPDATE invoices
SET status = 'cancelled'
WHERE id = 'b3f5498a-7710-4eda-85f4-df6ab84c240b';  -- 26000208
```

Keep `26000207` as the active invoice.

---

## Step 2 - Database-level guard (prevents recurrence at the source)

Add a partial unique index on `invoices` so two non-cancelled invoices for the same recipient + trainer + booking set cannot coexist. Because `booking_ids` is a uuid[], we use an MD5 hash of the sorted array as the index key.

Migration:

```sql
-- Helper: stable hash of the booking_ids array (order-independent)
CREATE OR REPLACE FUNCTION public.invoice_booking_set_key(_ids uuid[])
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT md5(array_to_string(
    (SELECT array_agg(x ORDER BY x) FROM unnest(_ids) AS x),
    ','
  ))
$$;

-- Two partial unique indexes (one per recipient column),
-- only enforced for active (non-cancelled) invoices with bookings.
CREATE UNIQUE INDEX uniq_invoice_active_player_bookings
  ON public.invoices (
    trainer_id,
    player_id,
    public.invoice_booking_set_key(booking_ids)
  )
  WHERE status <> 'cancelled'
    AND player_id IS NOT NULL
    AND array_length(booking_ids, 1) > 0;

CREATE UNIQUE INDEX uniq_invoice_active_guest_bookings
  ON public.invoices (
    trainer_id,
    guest_player_id,
    public.invoice_booking_set_key(booking_ids)
  )
  WHERE status <> 'cancelled'
    AND guest_player_id IS NOT NULL
    AND array_length(booking_ids, 1) > 0;
```

If a duplicate insert is attempted, Postgres rejects it with a unique-violation error - even under perfect race conditions.

---

## Step 3 - Edge function: handle the new constraint gracefully

Update `supabase/functions/auto-create-invoice/index.ts`:

- Wrap the existing duplicate-guard + insert so that on Postgres error code `23505` (unique violation) we re-query the existing invoice and return the same `{ success: true, deduped: true }` response the dedup branch already returns. This keeps the caller (`finalize-proposals`) happy and avoids a noisy error.

```ts
if (insertError) {
  if ((insertError as any).code === '23505') {
    // Race lost - fetch the winning invoice and return it
    const { data: winner } = await supabase
      .from('invoices')
      .select('id, invoice_number')
      .eq('trainer_id', trainerId)
      .contains('booking_ids', bookingIds)
      .not('status', 'eq', 'cancelled')
      .maybeSingle();
    if (winner) {
      return new Response(
        JSON.stringify({ success: true, invoiceId: winner.id, invoiceNumber: winner.invoice_number, deduped: true }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
  }
  throw new Error(`Failed to create invoice: ${insertError.message}`);
}
```

Also, if the insert is rejected we must NOT have advanced `invoice_next_number`. Move the `invoice_next_number` increment to AFTER a successful insert (currently lines 472-476 run before insert).

---

## Step 4 - Frontend double-click guard

In `src/pages/ProposalOverviewPage.tsx` `handleApproveAndBook` (line 327): React state is async, so two clicks in the same tick both see `pageStatus === 'idle'`. Add a synchronous `useRef` lock:

```ts
const finalizingRef = useRef(false);

const handleApproveAndBook = async () => {
  if (!cycleId || finalizingRef.current) return;
  finalizingRef.current = true;
  setPageStatus('booking');
  try {
    // ... existing logic
  } finally {
    finalizingRef.current = false;
  }
};
```

Also disable the button when `pageStatus === 'booking'` (verify the button already does this; if not, add `disabled={pageStatus === 'booking'}`).

---

## Files touched

- New migration: unique index + helper function
- `supabase/functions/auto-create-invoice/index.ts` - 23505 fallback + reorder seq increment
- `src/pages/ProposalOverviewPage.tsx` - useRef guard + disabled button
- One-off SQL update to cancel invoice `26000208`

## Out of scope

- No UI changes for admins to manually merge duplicates - the constraint should make that unnecessary.
- The same race could in theory hit `BookLesson` / `AddSlotDialog` callers too, but those are single-user flows and the new DB constraint protects them automatically.
