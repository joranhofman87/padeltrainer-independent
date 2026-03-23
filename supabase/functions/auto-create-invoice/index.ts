import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const logStep = (step: string, details?: Record<string, unknown>) => {
  console.log(`[AUTO-CREATE-INVOICE] ${step}`, details ? JSON.stringify(details) : "");
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const body = await req.json();
    const bookingIds: string[] = body.bookingIds || (body.bookingId ? [body.bookingId] : []);

    if (bookingIds.length === 0) {
      logStep("No booking IDs provided");
      return new Response(JSON.stringify({ error: "No booking IDs" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    logStep("Processing bookings", { bookingIds });

    // Fetch all bookings with details
    const { data: bookings, error: bookingsError } = await supabase
      .from("bookings")
      .select(`
        id,
        player_id,
        slot_id,
        payment_amount,
        payment_status,
        availability_slots!inner(
          trainer_id,
          start_time,
          end_time,
          location_id,
          price_per_session,
          cyclus_id,
          cyclus_name,
          prices_include_vat,
          locations(name, city)
        )
      `)
      .in("id", bookingIds);

    if (bookingsError || !bookings || bookings.length === 0) {
      logStep("Failed to fetch bookings", { error: bookingsError?.message });
      return new Response(JSON.stringify({ error: "Bookings not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Get trainer ID from first booking
    const slot = bookings[0].availability_slots as any;
    const trainerId = slot.trainer_id;

    // Fetch trainer profile with business info
    const { data: trainerProfile, error: trainerError } = await supabase
      .from("trainer_profiles")
      .select("id, user_id, business_name, business_address, kvk_number, btw_number, iban, bic, payment_terms_days, default_vat_rate, invoice_forward_emails, invoice_prefix, invoice_next_number")
      .eq("id", trainerId)
      .single();

    if (trainerError || !trainerProfile) {
      logStep("Trainer profile not found", { trainerId });
      return new Response(JSON.stringify({ error: "Trainer not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Check if business info is complete enough for invoicing
    if (!trainerProfile.business_name || !trainerProfile.kvk_number || !trainerProfile.iban) {
      logStep("Trainer business info incomplete, skipping invoice", {
        trainerId,
        hasBusinessName: !!trainerProfile.business_name,
        hasKvk: !!trainerProfile.kvk_number,
        hasIban: !!trainerProfile.iban,
      });
      return new Response(JSON.stringify({ skipped: true, reason: "incomplete_business_info" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Get player info including default billing details
    const playerId = bookings[0].player_id;
    let playerName = "Unknown Player";
    let playerBusinessName: string | null = null;
    let playerAddress: string | null = null;
    let playerBtwNumber: string | null = null;
    if (playerId) {
      const { data: playerProfile } = await supabase
        .from("profiles")
        .select("full_name, billing_business_name, billing_address, billing_btw_number")
        .eq("id", playerId)
        .single();
      if (playerProfile?.full_name) {
        playerName = playerProfile.full_name;
      }
      playerBusinessName = playerProfile?.billing_business_name || null;
      playerAddress = playerProfile?.billing_address || null;
      playerBtwNumber = playerProfile?.billing_btw_number || null;
    }

    // Build line items from bookings
    const vatRate = trainerProfile.default_vat_rate ?? 21;

    // Check if all bookings belong to the same cyclus — bundle them
    const firstSlot = bookings[0].availability_slots as any;
    const sharedCyclusId = firstSlot.cyclus_id;
    const allSameCyclus = sharedCyclusId && bookings.every((b) => (b.availability_slots as any).cyclus_id === sharedCyclusId);

    let lineItems: { description: string; quantity: number; unit_price: number; date?: string }[];

    if (allSameCyclus) {
      // Bundle cyclus bookings into a single line item
      const cyclusName = firstSlot.cyclus_name || "Training cyclus";
      const pricePerSession = bookings[0].payment_amount || firstSlot.price_per_session || 0;

      lineItems = [{
        description: cyclusName,
        quantity: bookings.length,
        unit_price: pricePerSession,
      }];
    } else {
      // Individual line items per booking (original behavior)
      lineItems = bookings.map((b) => {
        const bSlot = b.availability_slots as any;
        const startTime = new Date(bSlot.start_time);
        const locationName = bSlot.locations?.name || "";
        const description = bSlot.cyclus_name
          ? `${bSlot.cyclus_name} - ${startTime.toLocaleDateString("nl-NL")} ${startTime.toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" })}${locationName ? ` (${locationName})` : ""}`
          : `Training sessie - ${startTime.toLocaleDateString("nl-NL")}`;

        const price = b.payment_amount || bSlot.price_per_session || 0;

        return {
          description,
          quantity: 1,
          unit_price: price,
          date: startTime.toISOString().split("T")[0],
        };
      });
    }

    // Check for extra costs from the cycle settings
    if (sharedCyclusId) {
      const { data: cycleData } = await supabase
        .from("cycles")
        .select("settings")
        .eq("id", sharedCyclusId)
        .maybeSingle();

      const extraCosts = (cycleData?.settings as any)?.extra_costs;
      if (extraCosts && Array.isArray(extraCosts)) {
        for (const ec of extraCosts) {
          if (ec.description && ec.price > 0) {
            const isOneTime = ec.type === 'one_time';
            lineItems.push({
              description: ec.description,
              quantity: isOneTime ? 1 : bookings.length,
              unit_price: ec.price,
            });
          }
        }
      }
    }

    // Determine if prices include VAT — check slot-level flag, fall back to true (legacy default)
    const slotPricesIncludeVat = (bookings[0].availability_slots as any).prices_include_vat ?? true;

    // Calculate totals based on VAT inclusion
    const lineItemTotal = lineItems.reduce((sum, item) => sum + item.quantity * item.unit_price, 0);
    let subtotal: number;
    let vatAmount: number;
    let totalInclusive: number;

    if (slotPricesIncludeVat) {
      // Prices already include VAT — back-calculate
      totalInclusive = lineItemTotal;
      subtotal = totalInclusive / (1 + vatRate / 100);
      vatAmount = totalInclusive - subtotal;
    } else {
      // Prices exclude VAT — add VAT on top
      subtotal = lineItemTotal;
      vatAmount = subtotal * (vatRate / 100);
      totalInclusive = subtotal + vatAmount;
    }

    // Generate invoice number using trainer's custom prefix
    const prefix = trainerProfile.invoice_prefix || "INV";
    const year = new Date().getFullYear();
    const { data: lastInvoice } = await supabase
      .from("invoices")
      .select("invoice_number")
      .eq("trainer_id", trainerId)
      .like("invoice_number", `${prefix}-${year}-%`)
      .order("invoice_number", { ascending: false })
      .limit(1)
      .maybeSingle();

    let sequence = trainerProfile.invoice_next_number || 1;
    if (lastInvoice?.invoice_number) {
      const lastSeq = parseInt(lastInvoice.invoice_number.split("-")[2] || "0");
      if (lastSeq >= sequence) {
        sequence = lastSeq + 1;
      }
    }
    const invoiceNumber = `${prefix}-${year}-${sequence.toString().padStart(4, "0")}`;

    // Update next number for trainer
    await supabase
      .from("trainer_profiles")
      .update({ invoice_next_number: sequence + 1 })
      .eq("id", trainerId);

    // Calculate due date
    const paymentTermsDays = trainerProfile.payment_terms_days || 14;
    const invoiceDate = new Date();
    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + paymentTermsDays);

    // Check if bookings are already paid (e.g. Mollie)
    const allPaid = bookings.every((b) => b.payment_status === "paid");

    // Insert invoice
    const { data: invoice, error: insertError } = await supabase
      .from("invoices")
      .insert({
        trainer_id: trainerId,
        invoice_number: invoiceNumber,
        invoice_date: invoiceDate.toISOString().split("T")[0],
        due_date: dueDate.toISOString().split("T")[0],
        player_id: playerId,
        player_name: playerName,
        player_business_name: playerBusinessName,
        player_address: playerAddress,
        player_btw_number: playerBtwNumber,
        line_items: lineItems,
        subtotal: Math.round(subtotal * 100) / 100,
        vat_rate: vatRate,
        vat_amount: Math.round(vatAmount * 100) / 100,
        total: Math.round(totalInclusive * 100) / 100,
        status: allPaid ? "paid" : "sent",
        booking_ids: bookingIds,
        sent_at: new Date().toISOString(),
        ...(allPaid ? { paid_at: new Date().toISOString() } : {}),
      })
      .select()
      .single();

    if (insertError) {
      logStep("Failed to insert invoice", { error: insertError.message });
      throw new Error(`Failed to create invoice: ${insertError.message}`);
    }

    logStep("Invoice created", { invoiceId: invoice.id, invoiceNumber });

    // Generate PDF
    try {
      await supabase.functions.invoke("generate-invoice", {
        body: { invoiceId: invoice.id },
      });
      logStep("PDF generated");
    } catch (pdfErr) {
      logStep("PDF generation failed (non-fatal)", { error: String(pdfErr) });
    }

    // Auto-forward invoice to configured bookkeeping emails
    const forwardEmails = (trainerProfile as any).invoice_forward_emails;
    if (allPaid && forwardEmails && forwardEmails.length > 0) {
      try {
        const forwardRes = await supabase.functions.invoke("forward-invoice", {
          body: { invoiceId: invoice.id },
          headers: { Authorization: `Bearer ${supabaseServiceKey}` },
        });
        logStep("Invoice forwarded", { emails: forwardEmails.length, result: forwardRes.data });
      } catch (fwdErr) {
        logStep("Invoice forwarding failed (non-fatal)", { error: String(fwdErr) });
      }
    }

    return new Response(JSON.stringify({ success: true, invoiceId: invoice.id, invoiceNumber }), {
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
