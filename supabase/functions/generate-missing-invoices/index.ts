import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { corsHeaders, requireServiceRoleOrAdmin } from "../_shared/auth.ts";

const logStep = (step: string, details?: Record<string, unknown>) => {
  console.log(`[GENERATE-MISSING-INVOICES] ${step}`, details ? JSON.stringify(details) : "");
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // Ops/backfill tool: only an admin or service-role caller may generate
  // invoices for an academy. Previously this had no auth, so any holder of the
  // public anon key could mint invoices for an arbitrary academyId.
  const auth = await requireServiceRoleOrAdmin(req);
  if (auth instanceof Response) return auth;
  const supabase = auth.supabase;

  try {
    const { academyId } = await req.json();
    if (!academyId) {
      return new Response(JSON.stringify({ error: "academyId is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    logStep("Starting backfill", { academyId });

    // 1. Fetch all cycles for this academy
    const { data: cycles, error: cyclesError } = await supabase
      .from("cycles")
      .select("id, name, settings")
      .eq("owner_id", academyId)
      .eq("owner_type", "academy");

    if (cyclesError) throw cyclesError;
    if (!cycles || cycles.length === 0) {
      logStep("No cycles found");
      return new Response(JSON.stringify({ invoicesCreated: 0, skipped: 0, errors: [] }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    logStep("Found cycles", { count: cycles.length });

    let invoicesCreated = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (const cycle of cycles) {
      const settings = (cycle.settings as Record<string, unknown>) || {};
      const paymentTiming = (settings.payment_timing as string) || 
        ((settings.mark_as_paid as boolean) ? "manual" : "upfront");

      // Skip manual payment cycles
      if (paymentTiming === "manual") {
        logStep("Skipping manual cycle", { cycleId: cycle.id, name: cycle.name });
        continue;
      }

      // 2. Get all slots for this cycle
      const { data: slots } = await supabase
        .from("availability_slots")
        .select("id, split_payment")
        .eq("cyclus_id", cycle.id);

      if (!slots || slots.length === 0) continue;

      const slotIds = slots.map(s => s.id);
      const isSplitPayment = slots.some(s => s.split_payment === true);

      // 3. Get all confirmed bookings for these slots
      const { data: bookings } = await supabase
        .from("bookings")
        .select("id, player_id, guest_player_id, status, payment_status")
        .in("slot_id", slotIds)
        .eq("status", "confirmed");

      if (!bookings || bookings.length === 0) continue;

      // 4. Get all active invoices that cover these bookings
      const { data: existingInvoices } = await supabase
        .from("invoices")
        .select("id, booking_ids, status")
        .neq("status", "cancelled")
        .overlaps("booking_ids", bookings.map(b => b.id));

      const coveredBookingIds = new Set<string>();
      if (existingInvoices) {
        for (const inv of existingInvoices) {
          const ids = inv.booking_ids as string[] || [];
          ids.forEach(id => coveredBookingIds.add(id));
        }
      }

      // 5. Filter to uninvoiced bookings
      const uninvoiced = bookings.filter(b => !coveredBookingIds.has(b.id));
      if (uninvoiced.length === 0) {
        skipped += bookings.length;
        continue;
      }

      skipped += bookings.length - uninvoiced.length;

      // 6. Group by player
      const playerBookings = new Map<string, string[]>();
      for (const b of uninvoiced) {
        const key = b.player_id || b.guest_player_id || b.id;
        if (!playerBookings.has(key)) playerBookings.set(key, []);
        playerBookings.get(key)!.push(b.id);
      }

      // Count total unique players for split payment
      const allPlayerBookings = new Map<string, string[]>();
      for (const b of bookings) {
        const key = b.player_id || b.guest_player_id || b.id;
        if (!allPlayerBookings.has(key)) allPlayerBookings.set(key, []);
        allPlayerBookings.get(key)!.push(b.id);
      }
      const totalUniquePlayers = allPlayerBookings.size;

      // 7. Create invoices per player
      for (const [playerId, bookingIds] of playerBookings) {
        try {
          logStep("Creating invoice", { cycleId: cycle.id, playerId, bookingCount: bookingIds.length });

          const invoiceBody: Record<string, unknown> = { bookingIds };
          if (isSplitPayment && totalUniquePlayers > 1) {
            invoiceBody.splitAmongPlayers = totalUniquePlayers;
          }

          const { error: invokeError } = await supabase.functions.invoke("auto-create-invoice", {
            body: invoiceBody,
          });

          if (invokeError) {
            errors.push(`Cycle ${cycle.name}: player ${playerId}: ${invokeError.message}`);
          } else {
            invoicesCreated++;
          }
        } catch (err) {
          errors.push(`Cycle ${cycle.name}: player ${playerId}: ${String(err)}`);
        }
      }
    }

    logStep("Backfill complete", { invoicesCreated, skipped, errorCount: errors.length });

    return new Response(JSON.stringify({ invoicesCreated, skipped, errors }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[GENERATE-MISSING-INVOICES] Error:", error);
    return new Response(JSON.stringify({ error: String(error) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
