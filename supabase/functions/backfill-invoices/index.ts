import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const logStep = (step: string, details?: Record<string, unknown>) => {
  console.log(`[BACKFILL-INVOICES] ${step}`, details ? JSON.stringify(details) : "");
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const { academyProfileId } = await req.json();
    if (!academyProfileId) {
      return new Response(JSON.stringify({ error: "academyProfileId required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    logStep("Starting backfill", { academyProfileId });

    // 1. Get all trainer IDs for this academy
    const { data: trainers, error: tErr } = await supabase
      .from("academy_trainers")
      .select("trainer_profile_id")
      .eq("academy_profile_id", academyProfileId)
      .eq("status", "active");

    if (tErr) throw tErr;
    const trainerIds = (trainers || []).map((t: any) => t.trainer_profile_id);
    logStep("Found trainers", { count: trainerIds.length });

    if (trainerIds.length === 0) {
      return new Response(JSON.stringify({ created: 0, message: "No trainers found" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 2. Get all confirmed bookings for these trainers that are unpaid
    const { data: bookings, error: bErr } = await supabase
      .from("bookings")
      .select("id, slot_id, player_id, guest_player_id, payment_status, paid_externally, status, availability_slots!inner(trainer_id, cyclus_id)")
      .in("availability_slots.trainer_id", trainerIds)
      .eq("status", "confirmed")
      .eq("payment_status", "pending")
      .neq("paid_externally", true);

    if (bErr) throw bErr;
    logStep("Found unpaid bookings", { count: (bookings || []).length });

    if (!bookings || bookings.length === 0) {
      return new Response(JSON.stringify({ created: 0, message: "No unpaid bookings found" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 3. Get existing invoices for this academy to find already-invoiced booking IDs
    const { data: existingInvoices } = await supabase
      .from("invoices")
      .select("line_items")
      .eq("academy_profile_id", academyProfileId);

    const invoicedBookingIds = new Set<string>();
    for (const inv of existingInvoices || []) {
      if (Array.isArray(inv.line_items)) {
        for (const item of inv.line_items) {
          if (item.booking_id) invoicedBookingIds.add(item.booking_id);
          if (Array.isArray(item.booking_ids)) {
            item.booking_ids.forEach((id: string) => invoicedBookingIds.add(id));
          }
        }
      }
    }
    logStep("Already invoiced bookings", { count: invoicedBookingIds.size });

    // 4. Filter out already-invoiced bookings
    const uninvoiced = bookings.filter((b: any) => !invoicedBookingIds.has(b.id));
    logStep("Uninvoiced bookings", { count: uninvoiced.length });

    if (uninvoiced.length === 0) {
      return new Response(JSON.stringify({ created: 0, message: "All bookings already invoiced" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 5. Group by (cyclus_id, player_id/guest_player_id)
    const groups: Record<string, string[]> = {};
    for (const b of uninvoiced) {
      const slot = (b as any).availability_slots;
      const cyclusId = slot?.cyclus_id || "no-cycle";
      const playerId = b.player_id || b.guest_player_id || "unknown";
      const key = `${cyclusId}__${playerId}`;
      if (!groups[key]) groups[key] = [];
      groups[key].push(b.id);
    }
    logStep("Grouped into invoice batches", { groupCount: Object.keys(groups).length });

    // 6. Call auto-create-invoice for each group
    let created = 0;
    let errors = 0;
    for (const [key, bookingIds] of Object.entries(groups)) {
      try {
        const resp = await fetch(`${supabaseUrl}/functions/v1/auto-create-invoice`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${supabaseServiceKey}`,
          },
          body: JSON.stringify({ bookingIds, asDraft: true }),
        });
        const result = await resp.json();
        if (resp.ok && result.invoiceId) {
          created++;
        } else {
          logStep("Failed to create invoice for group", { key, result });
          errors++;
        }
      } catch (e) {
        logStep("Error creating invoice for group", { key, error: String(e) });
        errors++;
      }
    }

    logStep("Backfill complete", { created, errors });

    return new Response(JSON.stringify({ created, errors, totalGroups: Object.keys(groups).length }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    logStep("Fatal error", { error: String(err) });
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
