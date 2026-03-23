import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const logStep = (step: string, details?: Record<string, unknown>) => {
  console.log(`[AUTO-INVOICE-CYCLES] ${step}`, details ? JSON.stringify(details) : "");
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    logStep("Starting auto-invoice-cycles check");

    // Find cycles with payment_timing = 'invoice_after_weeks' that are active
    const { data: cycles, error: cyclesError } = await supabase
      .from("cycles")
      .select("id, start_date, settings, owner_type, owner_id")
      .in("status", ["open", "closed"]);

    if (cyclesError) {
      logStep("Error fetching cycles", { error: cyclesError.message });
      throw cyclesError;
    }

    const now = new Date();
    let totalInvoiced = 0;

    for (const cycle of cycles || []) {
      const settings = cycle.settings as Record<string, unknown> | null;
      if (!settings || settings.payment_timing !== "invoice_after_weeks") continue;

      const delayWeeks = (settings.invoice_delay_weeks as number) || 2;
      const startDate = new Date(cycle.start_date);
      const invoiceAfterDate = new Date(startDate.getTime() + delayWeeks * 7 * 24 * 60 * 60 * 1000);

      // Check if the delay period has elapsed
      if (now < invoiceAfterDate) {
        logStep("Cycle not yet due for invoicing", { cycleId: cycle.id, invoiceAfterDate: invoiceAfterDate.toISOString() });
        continue;
      }

      logStep("Processing cycle for delayed invoicing", { cycleId: cycle.id, delayWeeks });

      // Find all confirmed bookings for slots in this cycle that haven't been invoiced yet
      // We check bookings where payment_status is still 'pending' and paid_externally is not true
      const { data: slots } = await supabase
        .from("availability_slots")
        .select("id")
        .eq("cyclus_id", cycle.id);

      if (!slots || slots.length === 0) {
        logStep("No slots found for cycle", { cycleId: cycle.id });
        continue;
      }

      const slotIds = slots.map((s) => s.id);

      const { data: bookings } = await supabase
        .from("bookings")
        .select("id, player_id, guest_player_id, slot_id, payment_status")
        .in("slot_id", slotIds)
        .eq("status", "confirmed")
        .eq("payment_status", "pending")
        .is("paid_externally", null);

      if (!bookings || bookings.length === 0) {
        logStep("No uninvoiced bookings for cycle", { cycleId: cycle.id });
        continue;
      }

      // Group bookings by player (player_id or guest_player_id)
      const playerBookings = new Map<string, string[]>();
      for (const b of bookings) {
        const key = b.player_id || b.guest_player_id;
        if (!key) continue;
        const existing = playerBookings.get(key) || [];
        existing.push(b.id);
        playerBookings.set(key, existing);
      }

      // Create invoices per player
      for (const [playerId, bookingIds] of playerBookings) {
        logStep("Creating invoice for player", { playerId, bookingIds, cycleId: cycle.id });

        try {
          const invoiceRes = await supabase.functions.invoke("auto-create-invoice", {
            body: { bookingIds },
          });

          if (invoiceRes.error) {
            logStep("Invoice creation failed for player", { playerId, error: String(invoiceRes.error) });
          } else {
            totalInvoiced += bookingIds.length;
            logStep("Invoice created successfully", { playerId, bookingsCount: bookingIds.length });
          }
        } catch (err) {
          logStep("Invoice creation error", { playerId, error: String(err) });
        }
      }
    }

    logStep("Completed", { totalInvoiced });

    return new Response(JSON.stringify({ success: true, totalInvoiced }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logStep("ERROR", { message });
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
