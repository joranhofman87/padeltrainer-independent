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

    const { trainerId, academyId, pricesIncludeVat, newVatRate } = await req.json();

    // Support both trainer and academy modes
    const isAcademyMode = !!academyId;
    const entityId = academyId || trainerId;

    if (!entityId || (typeof pricesIncludeVat !== "boolean" && typeof newVatRate !== "number")) {
      return new Response(JSON.stringify({ error: "Missing entityId or update parameters" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Verify ownership
    if (isAcademyMode) {
      const { data: managers } = await supabase
        .from("academy_managers")
        .select("id")
        .eq("academy_profile_id", academyId)
        .eq("user_id", user.id)
        .limit(1);

      if (!managers || managers.length === 0) {
        return new Response(JSON.stringify({ error: "Forbidden" }), {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    } else {
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
    }

    let slotsUpdated = 0;

    // 1. Update future slots (only for trainer mode with pricesIncludeVat)
    if (!isAcademyMode && typeof pricesIncludeVat === "boolean") {
      const { data: updatedSlots, error: slotsError } = await supabase
        .from("availability_slots")
        .update({ prices_include_vat: pricesIncludeVat })
        .eq("trainer_id", trainerId)
        .gt("start_time", new Date().toISOString())
        .select("id");

      if (slotsError) {
        console.error("Error updating slots:", slotsError);
      }
      slotsUpdated = updatedSlots?.length || 0;
    }

    // 2. Recalculate unpaid invoices
    const invoiceFilter = isAcademyMode
      ? supabase.from("invoices").select("id, line_items, vat_rate, subtotal, vat_amount, total").eq("academy_profile_id", academyId).in("status", ["draft", "sent"])
      : supabase.from("invoices").select("id, line_items, vat_rate, subtotal, vat_amount, total").eq("trainer_id", trainerId).in("status", ["draft", "sent"]);

    const { data: invoices, error: invoicesError } = await invoiceFilter;

    if (invoicesError) {
      console.error("Error fetching invoices:", invoicesError);
    }

    let invoicesUpdated = 0;
    const invoiceIds: string[] = [];

    if (invoices && invoices.length > 0) {
      for (const invoice of invoices) {
        const lineItems = invoice.line_items as Array<{ quantity: number; unit_price: number }>;
        if (!lineItems || lineItems.length === 0) continue;

        const lineTotal = lineItems.reduce(
          (sum, item) => sum + item.quantity * item.unit_price, 0
        );

        // Use newVatRate if provided, otherwise keep existing rate
        const vatRate = typeof newVatRate === "number" ? newVatRate : (invoice.vat_rate || 21);
        const usePricesIncludeVat = typeof pricesIncludeVat === "boolean" ? pricesIncludeVat : true;

        let subtotal: number;
        let vatAmount: number;
        let total: number;

        if (usePricesIncludeVat) {
          total = Math.round(lineTotal * 100) / 100;
          subtotal = Math.round((lineTotal / (1 + vatRate / 100)) * 100) / 100;
          vatAmount = Math.round((total - subtotal) * 100) / 100;
        } else {
          subtotal = Math.round(lineTotal * 100) / 100;
          vatAmount = Math.round((subtotal * vatRate / 100) * 100) / 100;
          total = Math.round((subtotal + vatAmount) * 100) / 100;
        }

        const { error: updateError } = await supabase
          .from("invoices")
          .update({ subtotal, vat_amount: vatAmount, total, vat_rate: vatRate })
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
