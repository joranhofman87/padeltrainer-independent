

# Fix: Proposal Generation Failures

## Two Errors

### Error 1: URL Too Long for Bookings Query
The edge function fetches existing bookings using `.in("slot_id", slotIds)` (line 586). When the cycle generates many availability slots (the log shows 66+ slots created from wizard config), this produces a URL with hundreds of UUIDs that exceeds HTTP URL length limits, causing a network error.

**Fix**: Batch the bookings query. Split `slotIds` into chunks of ~200 and merge results.

```typescript
// Instead of one massive .in() call:
const BATCH_SIZE = 200;
const allBookings: any[] = [];
for (let i = 0; i < slotIds.length; i += BATCH_SIZE) {
  const batch = slotIds.slice(i, i + BATCH_SIZE);
  const { data, error } = await supabase
    .from("bookings")
    .select("slot_id")
    .in("slot_id", batch)
    .in("status", ["pending", "confirmed"]);
  if (error) throw error;
  if (data) allBookings.push(...data);
}
```

### Error 2: Empty Request Body
`req.json()` on line 339 fails with `SyntaxError: Unexpected end of JSON input` — this happens on duplicate/retried invocations where the body stream is already consumed or empty.

**Fix**: Wrap `req.json()` in a try/catch with a clear error message:

```typescript
let body: RequestBody;
try {
  body = await req.json();
} catch {
  return new Response(
    JSON.stringify({ error: "Invalid or empty request body" }),
    { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}
```

### File to change
- `supabase/functions/generate-proposals/index.ts` — batch bookings query + safe JSON parsing

