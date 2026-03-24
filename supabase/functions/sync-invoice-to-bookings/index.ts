import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceKey);

    const { invoiceId } = await req.json();
    if (!invoiceId) {
      return new Response(JSON.stringify({ error: "invoiceId required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fetch invoice
    const { data: invoice, error: invErr } = await supabase
      .from("invoices")
      .select("id, booking_ids, line_items, trainer_id, academy_profile_id")
      .eq("id", invoiceId)
      .single();

    if (invErr || !invoice) {
      return new Response(JSON.stringify({ error: "Invoice not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const bookingIds = invoice.booking_ids || [];
    const lineItems = invoice.line_items || [];

    if (bookingIds.length === 0) {
      return new Response(JSON.stringify({ message: "No bookings to sync" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Find the main session line item (first one, or the one with qty matching booking count)
    const sessionItem = lineItems.find(
      (li: any) => li.quantity === bookingIds.length
    ) || lineItems[0];

    if (!sessionItem) {
      return new Response(JSON.stringify({ message: "No line items" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const perBookingPrice = sessionItem.unit_price;

    // Update each booking's payment_amount
    let updated = 0;
    for (const bookingId of bookingIds) {
      const { error } = await supabase
        .from("bookings")
        .update({ payment_amount: perBookingPrice })
        .eq("id", bookingId);
      if (!error) updated++;
    }

    // Also update the slot's price_per_session if possible
    if (bookingIds.length > 0) {
      const { data: firstBooking } = await supabase
        .from("bookings")
        .select("slot_id")
        .eq("id", bookingIds[0])
        .single();

      if (firstBooking?.slot_id) {
        await supabase
          .from("availability_slots")
          .update({ price_per_session: perBookingPrice })
          .eq("id", firstBooking.slot_id);
      }
    }

    return new Response(
      JSON.stringify({ success: true, updated }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
