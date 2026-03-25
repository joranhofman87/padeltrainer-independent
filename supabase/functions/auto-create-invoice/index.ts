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
    const asDraft: boolean = body.asDraft === true;
    let splitAmongPlayers: number | null = body.splitAmongPlayers || null;

    if (bookingIds.length === 0) {
      logStep("No booking IDs provided");
      return new Response(JSON.stringify({ error: "No booking IDs" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    logStep("Processing bookings", { bookingIds, asDraft, splitAmongPlayers });

    // Fetch all bookings with details
    const { data: bookings, error: bookingsError } = await supabase
      .from("bookings")
      .select(`
        id,
        player_id,
        guest_player_id,
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
          extra_costs,
          split_payment,
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

    // Auto-detect split payment from slot if not explicitly passed
    if (!splitAmongPlayers && slot.split_payment === true) {
      const uniquePlayers = new Set(bookings.map((b) => b.player_id || b.guest_player_id).filter(Boolean));
      if (uniquePlayers.size > 1) {
        splitAmongPlayers = uniquePlayers.size;
        logStep("Auto-detected split payment from slot", { splitAmongPlayers });
      }
    }

    // Check if trainer belongs to an academy
    let academyProfileId: string | null = null;
    const { data: academyTrainer } = await supabase
      .from("academy_trainers")
      .select("academy_profile_id")
      .eq("trainer_profile_id", trainerId)
      .eq("status", "active")
      .maybeSingle();
    if (academyTrainer?.academy_profile_id) {
      academyProfileId = academyTrainer.academy_profile_id;
    }

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

    // If academy exists, try to use academy business info for invoicing
    let invoiceProfile: {
      business_name: string | null;
      business_address: string | null;
      kvk_number: string | null;
      btw_number: string | null;
      iban: string | null;
      bic: string | null;
      payment_terms_days: number | null;
      default_vat_rate: number | null;
      invoice_forward_emails: string[] | null;
      invoice_prefix: string | null;
      invoice_next_number: number | null;
    } = trainerProfile;
    let invoiceProfileTable = "trainer_profiles";
    let invoiceProfileId = trainerId;

    if (academyProfileId) {
      const { data: academyProfile } = await supabase
        .from("academy_profiles")
        .select("business_name, business_address, kvk_number, btw_number, iban, bic, payment_terms_days, default_vat_rate, invoice_forward_emails, invoice_prefix, invoice_next_number")
        .eq("id", academyProfileId)
        .single();

      if (academyProfile?.business_name && academyProfile?.kvk_number && academyProfile?.iban) {
        invoiceProfile = academyProfile;
        invoiceProfileTable = "academy_profiles";
        invoiceProfileId = academyProfileId;
        logStep("Using academy business info for invoice", { academyProfileId });
      }
    }

    // Check if business info is complete enough for invoicing
    if (!invoiceProfile.business_name || !invoiceProfile.kvk_number || !invoiceProfile.iban) {
      logStep("Business info incomplete, skipping invoice", {
        profileTable: invoiceProfileTable,
        profileId: invoiceProfileId,
        hasBusinessName: !!invoiceProfile.business_name,
        hasKvk: !!invoiceProfile.kvk_number,
        hasIban: !!invoiceProfile.iban,
      });
      return new Response(JSON.stringify({ skipped: true, reason: "incomplete_business_info" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Get player info — support both player_id and guest_player_id
    const playerId = bookings[0].player_id;
    const guestPlayerId = bookings[0].guest_player_id;
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
    } else if (guestPlayerId) {
      const { data: guestPlayer } = await supabase
        .from("guest_players")
        .select("full_name, email")
        .eq("id", guestPlayerId)
        .single();
      if (guestPlayer?.full_name) {
        playerName = guestPlayer.full_name;
      }
    }

    // Build line items from bookings
    const vatRate = invoiceProfile.default_vat_rate ?? 21;

    // Check if all bookings belong to the same cyclus — bundle them
    const firstSlot = bookings[0].availability_slots as any;
    const sharedCyclusId = firstSlot.cyclus_id;
    const allSameCyclus = sharedCyclusId && bookings.every((b) => (b.availability_slots as any).cyclus_id === sharedCyclusId);

    let lineItems: { description: string; quantity: number; unit_price: number; date?: string }[];

    if (allSameCyclus) {
      const cyclusName = firstSlot.cyclus_name || "Training cyclus";
      const pricePerSession = bookings[0].payment_amount || firstSlot.price_per_session || 0;

      lineItems = [{
        description: `${cyclusName} (${bookings.length} weken)`,
        quantity: bookings.length,
        unit_price: pricePerSession,
      }];
    } else {
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

    // Check for extra costs from cycle settings, fall back to slot extra_costs
    let extraCosts: any[] | null = null;

    if (sharedCyclusId) {
      const { data: cycleData } = await supabase
        .from("cycles")
        .select("settings")
        .eq("id", sharedCyclusId)
        .maybeSingle();

      extraCosts = (cycleData?.settings as any)?.extra_costs || null;
    }

    // Fallback: use extra_costs from the first slot if no cycle-level costs
    if (!extraCosts || !Array.isArray(extraCosts) || extraCosts.length === 0) {
      const slotExtraCosts = (bookings[0].availability_slots as any).extra_costs;
      if (slotExtraCosts && Array.isArray(slotExtraCosts)) {
        extraCosts = slotExtraCosts;
      }
    }

    if (extraCosts && Array.isArray(extraCosts)) {
      for (const ec of extraCosts) {
        if (ec.description && ec.price > 0) {
          const isOneTime = ec.type === 'one_time';
          lineItems.push({
            description: isOneTime ? ec.description : `${ec.description} (per sessie)`,
            quantity: isOneTime ? 1 : bookings.length,
            unit_price: ec.price,
            vat_rate: ec.vat_rate ?? vatRate,
          });
        }
      }
    }

    // Apply split payment: divide each line item's unit_price among players
    // Calculate unsplit total first, then use floor division for consistency
    let unsplitTotal: number | null = null;
    if (splitAmongPlayers && splitAmongPlayers > 1) {
      logStep("Applying split payment", { splitAmongPlayers });
      // Calculate the unsplit total before modifying line items
      unsplitTotal = lineItems.reduce((sum, item) => sum + item.quantity * item.unit_price, 0);
      for (const item of lineItems) {
        item.unit_price = Math.round((item.unit_price / splitAmongPlayers) * 100) / 100;
        item.description = `${item.description} (1/${splitAmongPlayers})`;
      }
    }

    // Determine if prices include VAT
    const slotPricesIncludeVat = (bookings[0].availability_slots as any).prices_include_vat ?? true;

    // Calculate per-line-item VAT for multi-rate support
    const hasMultipleVatRates = lineItems.some((item: any) => (item.vat_rate ?? vatRate) !== vatRate);

    let subtotal: number;
    let vatAmount: number;
    let totalInclusive: number;
    let vatBreakdown: Record<number, { subtotal: number; vat: number }> = {};

    if (hasMultipleVatRates) {
      // Per-line-item VAT calculation
      let totalSub = 0;
      let totalVat = 0;

      for (const item of lineItems) {
        const lineTotal = item.quantity * item.unit_price;
        const lineVatRate = (item as any).vat_rate ?? vatRate;
        let lineSub: number;
        let lineVat: number;

        if (slotPricesIncludeVat) {
          lineSub = lineTotal / (1 + lineVatRate / 100);
          lineVat = lineTotal - lineSub;
        } else {
          lineSub = lineTotal;
          lineVat = lineSub * (lineVatRate / 100);
        }

        totalSub += lineSub;
        totalVat += lineVat;

        if (!vatBreakdown[lineVatRate]) {
          vatBreakdown[lineVatRate] = { subtotal: 0, vat: 0 };
        }
        vatBreakdown[lineVatRate].subtotal += lineSub;
        vatBreakdown[lineVatRate].vat += lineVat;
      }

      subtotal = Math.round(totalSub * 100) / 100;
      vatAmount = Math.round(totalVat * 100) / 100;
      totalInclusive = slotPricesIncludeVat 
        ? lineItems.reduce((sum, item) => sum + item.quantity * item.unit_price, 0)
        : Math.round((subtotal + vatAmount) * 100) / 100;

      // Round breakdown values
      for (const rate in vatBreakdown) {
        vatBreakdown[rate].subtotal = Math.round(vatBreakdown[rate].subtotal * 100) / 100;
        vatBreakdown[rate].vat = Math.round(vatBreakdown[rate].vat * 100) / 100;
      }
    } else {
      // Single VAT rate (existing behavior)
      const lineItemTotal = lineItems.reduce((sum, item) => sum + item.quantity * item.unit_price, 0);
      if (slotPricesIncludeVat) {
        totalInclusive = lineItemTotal;
        subtotal = totalInclusive / (1 + vatRate / 100);
        vatAmount = totalInclusive - subtotal;
      } else {
        subtotal = lineItemTotal;
        vatAmount = subtotal * (vatRate / 100);
        totalInclusive = subtotal + vatAmount;
      }
    }

    // For split payments, use floor(unsplitTotal/N) to ensure all shares sum to original
    // The split-invoice function handles giving the remainder to the first player
    if (unsplitTotal !== null && splitAmongPlayers && splitAmongPlayers > 1 && !hasMultipleVatRates) {
      const splitShare = Math.floor((unsplitTotal / splitAmongPlayers) * 100) / 100;
      logStep("Correcting split total", { unsplitTotal, splitShare, calculatedTotal: totalInclusive });
      totalInclusive = splitShare;
      // Recalculate VAT from corrected total
      if (slotPricesIncludeVat) {
        subtotal = totalInclusive / (1 + vatRate / 100);
        vatAmount = totalInclusive - subtotal;
      } else {
        subtotal = totalInclusive / (1 + vatRate / 100);
        vatAmount = totalInclusive - subtotal;
      }
      subtotal = Math.round(subtotal * 100) / 100;
      vatAmount = Math.round(vatAmount * 100) / 100;
    }

    // Duplicate guard: check if an active invoice already exists for same trainer + recipient + bookings
    const recipientFilter = playerId
      ? { player_id: playerId }
      : guestPlayerId
        ? { guest_player_id: guestPlayerId }
        : null;

    if (recipientFilter) {
      const dupeQuery = supabase
        .from("invoices")
        .select("id, invoice_number")
        .eq("trainer_id", trainerId)
        .not("status", "eq", "cancelled")
        .contains("booking_ids", bookingIds);

      if (recipientFilter.player_id) {
        dupeQuery.eq("player_id", recipientFilter.player_id);
      } else if (recipientFilter.guest_player_id) {
        dupeQuery.eq("guest_player_id", recipientFilter.guest_player_id);
      }

      const { data: existingInvoices } = await dupeQuery;
      if (existingInvoices && existingInvoices.length > 0) {
        // Check for exact match (same booking set)
        const exactMatch = existingInvoices.find(() => true); // contains already checks subset
        if (exactMatch) {
          logStep("Duplicate invoice found, skipping creation", {
            existingId: exactMatch.id,
            existingNumber: exactMatch.invoice_number,
          });
          return new Response(
            JSON.stringify({ success: true, invoiceId: exactMatch.id, invoiceNumber: exactMatch.invoice_number, deduped: true }),
            { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
      }
    }

    // Generate invoice number using profile's custom prefix
    const prefix = invoiceProfile.invoice_prefix || "INV";
    const year = new Date().getFullYear();
    const { data: lastInvoice } = await supabase
      .from("invoices")
      .select("invoice_number")
      .eq("trainer_id", trainerId)
      .like("invoice_number", `${prefix}-${year}-%`)
      .order("invoice_number", { ascending: false })
      .limit(1)
      .maybeSingle();

    let sequence = invoiceProfile.invoice_next_number || 1;
    if (lastInvoice?.invoice_number) {
      const lastSeq = parseInt(lastInvoice.invoice_number.split("-")[2] || "0");
      if (lastSeq >= sequence) {
        sequence = lastSeq + 1;
      }
    }
    const invoiceNumber = `${prefix}-${year}-${sequence.toString().padStart(4, "0")}`;

    // Update next number on the profile table
    await supabase
      .from(invoiceProfileTable)
      .update({ invoice_next_number: sequence + 1 })
      .eq("id", invoiceProfileId);

    // Calculate due date
    const paymentTermsDays = invoiceProfile.payment_terms_days || 14;
    const invoiceDate = new Date();
    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + paymentTermsDays);

    // Check if bookings are already paid (e.g. Mollie)
    const allPaid = bookings.every((b) => b.payment_status === "paid");

    // Determine invoice status
    let invoiceStatus: string;
    if (allPaid) {
      invoiceStatus = "paid";
    } else if (asDraft) {
      invoiceStatus = "draft";
    } else {
      invoiceStatus = "sent";
    }

    // Insert invoice
    const { data: invoice, error: insertError } = await supabase
      .from("invoices")
      .insert({
        trainer_id: trainerId,
        academy_profile_id: academyProfileId,
        invoice_number: invoiceNumber,
        invoice_date: invoiceDate.toISOString().split("T")[0],
        due_date: dueDate.toISOString().split("T")[0],
        player_id: playerId,
        guest_player_id: guestPlayerId || null,
        player_name: playerName,
        player_business_name: playerBusinessName,
        player_address: playerAddress,
        player_btw_number: playerBtwNumber,
        line_items: lineItems,
        subtotal: Math.round(subtotal * 100) / 100,
        vat_rate: vatRate,
        vat_amount: Math.round(vatAmount * 100) / 100,
        total: Math.round(totalInclusive * 100) / 100,
        ...(Object.keys(vatBreakdown).length > 0 ? { vat_breakdown: vatBreakdown } : {}),
        prices_include_vat: slotPricesIncludeVat,
        status: invoiceStatus,
        booking_ids: bookingIds,
        ...(invoiceStatus === "sent" ? { sent_at: new Date().toISOString() } : {}),
        ...(allPaid ? { paid_at: new Date().toISOString(), sent_at: new Date().toISOString() } : {}),
      })
      .select()
      .single();

    if (insertError) {
      logStep("Failed to insert invoice", { error: insertError.message });
      throw new Error(`Failed to create invoice: ${insertError.message}`);
    }

    logStep("Invoice created", { invoiceId: invoice.id, invoiceNumber, status: invoiceStatus });

    // Generate PDF (skip for drafts to save resources — can be generated on demand)
    if (invoiceStatus !== "draft") {
      try {
        await supabase.functions.invoke("generate-invoice", {
          body: { invoiceId: invoice.id },
        });
        logStep("PDF generated");
      } catch (pdfErr) {
        logStep("PDF generation failed (non-fatal)", { error: String(pdfErr) });
      }
    }

    // Auto-forward invoice to configured bookkeeping emails
    const forwardEmails = invoiceProfile.invoice_forward_emails;
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
