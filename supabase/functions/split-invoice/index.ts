import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const logStep = (step: string, details?: Record<string, unknown>) => {
  console.log(
    `[SPLIT-INVOICE] ${step}`,
    details ? JSON.stringify(details) : ""
  );
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const { invoiceId } = await req.json();
    if (!invoiceId) {
      return new Response(JSON.stringify({ error: "Missing invoiceId" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    logStep("Starting split", { invoiceId });

    // 1. Fetch the invoice
    const { data: invoice, error: invErr } = await supabase
      .from("invoices")
      .select("*")
      .eq("id", invoiceId)
      .single();

    if (invErr || !invoice) {
      return new Response(JSON.stringify({ error: "Invoice not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Must be active and unpaid
    if (invoice.status === "paid" || invoice.status === "cancelled") {
      return new Response(
        JSON.stringify({ error: `Cannot split a ${invoice.status} invoice` }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Already split? Skip (detect "(1/N)" in line items)
    const existingLineItems = (invoice.line_items as any[]) || [];
    const alreadySplit = existingLineItems.some((li: any) => /\(1\/\d+\)/.test(li.description || ""));
    if (alreadySplit) {
      logStep("Invoice already split, skipping", { invoiceId });
      return new Response(
        JSON.stringify({ success: true, alreadySplit: true, message: "Invoice is already split" }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const bookingIds: string[] = invoice.booking_ids || [];
    if (bookingIds.length === 0) {
      return new Response(
        JSON.stringify({ error: "Invoice has no booking_ids" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // 2. Find all slot IDs from the invoice's bookings
    const { data: invoiceBookings } = await supabase
      .from("bookings")
      .select("id, slot_id, player_id, guest_player_id")
      .in("id", bookingIds);

    if (!invoiceBookings || invoiceBookings.length === 0) {
      return new Response(
        JSON.stringify({ error: "No bookings found for invoice" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const slotIds = [...new Set(invoiceBookings.map((b) => b.slot_id))];

    // 3. Find ALL confirmed bookings on those slots (to discover other players)
    const { data: allBookings } = await supabase
      .from("bookings")
      .select("id, slot_id, player_id, guest_player_id, status")
      .in("slot_id", slotIds)
      .in("status", ["confirmed", "attended"]);

    if (!allBookings) {
      return new Response(
        JSON.stringify({ error: "Could not fetch related bookings" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // 4. Group bookings by player (player_id or guest_player_id)
    const playerBookings: Record<
      string,
      { bookingIds: string[]; isGuest: boolean }
    > = {};

    for (const b of allBookings) {
      const key = b.player_id || `guest:${b.guest_player_id}`;
      if (!playerBookings[key]) {
        playerBookings[key] = { bookingIds: [], isGuest: !b.player_id };
      }
      playerBookings[key].bookingIds.push(b.id);
    }

    const totalPlayers = Object.keys(playerBookings).length;
    logStep("Found players", { totalPlayers, players: Object.keys(playerBookings) });

    if (totalPlayers <= 1) {
      return new Response(
        JSON.stringify({
          error: "no_other_players",
          message: "Er zijn geen andere spelers om mee te splitsen",
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // 5. Update the existing invoice: divide line items by N
    const originalLineItems = invoice.line_items as any[];
    const vatRate = invoice.vat_rate || 21;
    const originalTotal = invoice.total as number;

    // Divide line items for display purposes
    const updatedLineItems = originalLineItems.map((item: any) => ({
      ...item,
      unit_price:
        Math.round((item.unit_price / totalPlayers) * 100) / 100,
      description: `${item.description} (1/${totalPlayers})`,
    }));

    // Use total-level division to avoid compounding rounding errors
    // N-1 players get floor(total/N), first player absorbs remainder
    const splitShare = Math.floor((originalTotal / totalPlayers) * 100) / 100;
    const remainder = Math.round((originalTotal - splitShare * totalPlayers) * 100) / 100;
    // The original invoice (first player) gets splitShare + remainder
    const firstPlayerTotal = Math.round((splitShare + remainder) * 100) / 100;

    logStep("Split calculation", { originalTotal, splitShare, remainder, firstPlayerTotal });

    // Recalculate VAT based on the corrected total
    const hasMultipleVatRates = updatedLineItems.some(
      (item: any) => (item.vat_rate ?? vatRate) !== vatRate
    );

    let newSubtotal: number;
    let newVatAmount: number;
    let newTotal: number = firstPlayerTotal;
    let newVatBreakdown: Record<number, { subtotal: number; vat: number }> = {};

    if (hasMultipleVatRates) {
      // For multi-rate, calculate proportional VAT based on corrected total
      const lineItemTotal = updatedLineItems.reduce(
        (sum: number, item: any) => sum + item.quantity * item.unit_price, 0
      );
      const adjustmentRatio = lineItemTotal > 0 ? firstPlayerTotal / lineItemTotal : 1;
      let totalSub = 0;
      let totalVat = 0;
      for (const item of updatedLineItems) {
        const lineTotal = item.quantity * item.unit_price * adjustmentRatio;
        const lineVatRate = item.vat_rate ?? vatRate;
        const lineSub = lineTotal / (1 + lineVatRate / 100);
        const lineVat = lineTotal - lineSub;
        totalSub += lineSub;
        totalVat += lineVat;
        if (!newVatBreakdown[lineVatRate]) {
          newVatBreakdown[lineVatRate] = { subtotal: 0, vat: 0 };
        }
        newVatBreakdown[lineVatRate].subtotal += lineSub;
        newVatBreakdown[lineVatRate].vat += lineVat;
      }
      newSubtotal = Math.round(totalSub * 100) / 100;
      newVatAmount = Math.round(totalVat * 100) / 100;
      for (const rate in newVatBreakdown) {
        newVatBreakdown[rate].subtotal = Math.round(newVatBreakdown[rate].subtotal * 100) / 100;
        newVatBreakdown[rate].vat = Math.round(newVatBreakdown[rate].vat * 100) / 100;
      }
    } else {
      newSubtotal = newTotal / (1 + vatRate / 100);
      newVatAmount = newTotal - newSubtotal;
    }

    const { error: updateErr } = await supabase
      .from("invoices")
      .update({
        line_items: updatedLineItems,
        subtotal: Math.round(newSubtotal * 100) / 100,
        vat_amount: Math.round(newVatAmount * 100) / 100,
        total: Math.round(newTotal * 100) / 100,
        ...(Object.keys(newVatBreakdown).length > 0
          ? { vat_breakdown: newVatBreakdown }
          : {}),
        pdf_url: null, // Force PDF regeneration
      })
      .eq("id", invoiceId);

    if (updateErr) {
      logStep("Failed to update existing invoice", {
        error: updateErr.message,
      });
      throw new Error(`Failed to update invoice: ${updateErr.message}`);
    }

    logStep("Updated existing invoice", { newTotal: Math.round(newTotal * 100) / 100 });

    // 6. Create invoices for other players
    // Identify the original player key
    const originalPlayerKey =
      invoice.player_id || `guest:${invoice.guest_player_id}`;
    const createdInvoices: string[] = [];

    for (const [playerKey, data] of Object.entries(playerBookings)) {
      if (playerKey === originalPlayerKey) continue;

      // Duplicate guard: check if an invoice already exists for this player with overlapping booking_ids
      const { data: existingInvoices } = await supabase
        .from("invoices")
        .select("id")
        .eq("trainer_id", invoice.trainer_id)
        .overlaps("booking_ids", data.bookingIds)
        .not("status", "eq", "cancelled");

      if (existingInvoices && existingInvoices.length > 0) {
        logStep("Skipping player - invoice already exists", {
          playerKey,
          existingInvoiceIds: existingInvoices.map((i: any) => i.id),
        });
        continue;
      }

      logStep("Creating invoice for player", {
        playerKey,
        bookingIds: data.bookingIds,
      });

      const { data: result, error: createErr } = await supabase.functions.invoke(
        "auto-create-invoice",
        {
          body: {
            bookingIds: data.bookingIds,
            asDraft: invoice.status === "draft",
            splitAmongPlayers: totalPlayers,
          },
        }
      );

      if (createErr) {
        logStep("Failed to create invoice for player", {
          playerKey,
          error: String(createErr),
        });
      } else {
        logStep("Created invoice for player", {
          playerKey,
          invoiceId: result?.invoiceId,
        });
        if (result?.invoiceId) createdInvoices.push(result.invoiceId);
      }
    }

    // 7. Try to update cycle split_payment setting if applicable
    const firstBookingSlot = invoiceBookings[0]?.slot_id;
    if (firstBookingSlot) {
      const { data: slotData } = await supabase
        .from("availability_slots")
        .select("cyclus_id")
        .eq("id", firstBookingSlot)
        .maybeSingle();

      if (slotData?.cyclus_id) {
        const { data: cycleData } = await supabase
          .from("cycles")
          .select("settings")
          .eq("id", slotData.cyclus_id)
          .maybeSingle();

        if (cycleData) {
          const settings = (cycleData.settings as any) || {};
          settings.split_payment = true;
          await supabase
            .from("cycles")
            .update({ settings })
            .eq("id", slotData.cyclus_id);
          logStep("Updated cycle split_payment", { cyclusId: slotData.cyclus_id });
        }
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        totalPlayers,
        updatedInvoiceId: invoiceId,
        createdInvoices,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logStep("ERROR", { message });
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
