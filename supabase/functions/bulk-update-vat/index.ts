import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    // Authenticate caller
    const authHeader = req.headers.get("authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: { user }, error: authError } = await createClient(
      supabaseUrl,
      Deno.env.get("SUPABASE_ANON_KEY")!
    ).auth.getUser(authHeader.replace("Bearer ", ""));

    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { trainerId, pricesIncludeVat } = await req.json();

    if (!trainerId || typeof pricesIncludeVat !== "boolean") {
      return new Response(JSON.stringify({ error: "Missing trainerId or pricesIncludeVat" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Verify the caller owns this trainer profile
    const { data: trainerProfile } = await supabase
      .from("trainer_profiles")
      .select("id, user_id")
      .eq("id", trainerId)
      .single();

    if (!trainerProfile || trainerProfile.user_id !== user.id) {
      return new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 1. Update all future slots
    const { data: updatedSlots, error: slotsError } = await supabase
      .from("availability_slots")
      .update({ prices_include_vat: pricesIncludeVat })
      .eq("trainer_id", trainerId)
      .gt("start_time", new Date().toISOString())
      .select("id");

    if (slotsError) {
      console.error("Error updating slots:", slotsError);
    }

    const slotsUpdated = updatedSlots?.length || 0;

    // 2. Recalculate unpaid invoices
    const { data: invoices, error: invoicesError } = await supabase
      .from("invoices")
      .select("id, line_items, vat_rate, subtotal, vat_amount, total")
      .eq("trainer_id", trainerId)
      .in("status", ["draft", "sent"]);

    if (invoicesError) {
      console.error("Error fetching invoices:", invoicesError);
    }

    let invoicesUpdated = 0;
    const invoiceIds: string[] = [];

    if (invoices && invoices.length > 0) {
      for (const invoice of invoices) {
        const lineItems = invoice.line_items as Array<{ quantity: number; unit_price: number }>;
        if (!lineItems || lineItems.length === 0) continue;

        // Sum of line item totals (quantity * unit_price)
        const lineTotal = lineItems.reduce(
          (sum, item) => sum + item.quantity * item.unit_price, 0
        );

        const vatRate = invoice.vat_rate || 21;
        let subtotal: number;
        let vatAmount: number;
        let total: number;

        if (pricesIncludeVat) {
          // Prices include VAT: line total IS the total, back-calculate
          total = Math.round(lineTotal * 100) / 100;
          subtotal = Math.round((lineTotal / (1 + vatRate / 100)) * 100) / 100;
          vatAmount = Math.round((total - subtotal) * 100) / 100;
        } else {
          // Prices exclude VAT: line total is subtotal, add VAT on top
          subtotal = Math.round(lineTotal * 100) / 100;
          vatAmount = Math.round((subtotal * vatRate / 100) * 100) / 100;
          total = Math.round((subtotal + vatAmount) * 100) / 100;
        }

        const { error: updateError } = await supabase
          .from("invoices")
          .update({ subtotal, vat_amount: vatAmount, total })
          .eq("id", invoice.id);

        if (!updateError) {
          invoicesUpdated++;
          invoiceIds.push(invoice.id);
        } else {
          console.error(`Error updating invoice ${invoice.id}:`, updateError);
        }
      }

      // 3. Regenerate PDFs for updated invoices
      for (const invoiceId of invoiceIds) {
        try {
          await fetch(`${supabaseUrl}/functions/v1/generate-invoice`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${serviceRoleKey}`,
            },
            body: JSON.stringify({ invoiceId }),
          });
        } catch (err) {
          console.error(`Error regenerating invoice ${invoiceId}:`, err);
        }
      }
    }

    return new Response(
      JSON.stringify({ slotsUpdated, invoicesUpdated }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("Unexpected error:", err);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
