import { corsHeaders, requireUser } from "../_shared/auth.ts";
import { canManageInvoice } from "../_shared/invoice-access.ts";
import { notifySlackEdgeError } from "../_shared/edge-slack.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;
  const supabase = auth.supabase;

  try {
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

    // Authorization: only the invoice's trainer, an academy manager, an admin,
    // or a service-role caller may rewrite the derived booking/slot amounts.
    if (!(await canManageInvoice(supabase, auth, invoice))) {
      return new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
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

    // Update every booking's payment_amount in ONE statement (was a per-row loop
    // that swallowed individual failures and returned success even on a partial
    // write, so a timeout mid-loop left some bookings at the new price and the
    // rest stale — silently).
    const { data: updatedRows, error: updErr } = await supabase
      .from("bookings")
      .update({ payment_amount: perBookingPrice })
      .in("id", bookingIds)
      .select("id");

    if (updErr) {
      console.error("sync-invoice-to-bookings booking update failed:", updErr);
      // Real-time alert: this is the invoice-paid → bookings-not divergence the
      // daily invoice-health-check would only catch next morning.
      await notifySlackEdgeError("sync-invoice-to-bookings", `booking write-back failed: ${updErr.message}`, { bookingIds });
      return new Response(JSON.stringify({ error: "Internal server error" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const updated = updatedRows?.length ?? 0;

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
      JSON.stringify({ success: updated === bookingIds.length, updated, expected: bookingIds.length }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    // Log full detail server-side; never echo raw DB error text to callers.
    console.error("sync-invoice-to-bookings error:", err);
    await notifySlackEdgeError("sync-invoice-to-bookings", err instanceof Error ? err.message : String(err));
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
