import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Verify caller is admin
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const token = authHeader.replace("Bearer ", "");
    const { data: { user } } = await supabaseAdmin.auth.getUser(token);
    if (!user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const { data: roleData } = await supabaseAdmin
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id)
      .eq("role", "admin")
      .maybeSingle();
    if (!roleData) {
      return new Response(JSON.stringify({ error: "Admin only" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Parse optional body
    let dryRun = false;
    let invoiceIds: string[] | null = null;
    let rebuildFromBookings = false;
    try {
      const body = await req.json();
      dryRun = body.dry_run === true;
      rebuildFromBookings = body.rebuild_from_bookings === true;
      if (Array.isArray(body.invoice_ids)) invoiceIds = body.invoice_ids;
    } catch { /* no body */ }

    // Fetch unpaid invoices
    let query = supabaseAdmin
      .from("invoices")
      .select("id, invoice_number, line_items, subtotal, vat_amount, total, vat_rate, prices_include_vat, status, booking_ids")
      .in("status", ["draft", "sent", "pending"]);

    if (invoiceIds && invoiceIds.length > 0) {
      query = query.in("id", invoiceIds);
    }

    const { data: invoices, error: fetchErr } = await query;
    if (fetchErr) throw fetchErr;
    if (!invoices || invoices.length === 0) {
      return new Response(
        JSON.stringify({ success: true, message: "No unpaid invoices found", updated: 0 }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const results: any[] = [];

    for (const inv of invoices) {
      let lineItems: any[] = (inv.line_items as any[]) || [];
      const pricesIncludeVat = inv.prices_include_vat ?? true;
      const defaultVatRate = (inv.vat_rate as number) || 21;
      const bookingIds = (inv.booking_ids as string[]) || [];

      // If rebuild_from_bookings is true and invoice has booking_ids,
      // rebuild line items from current booking/slot data
      if (rebuildFromBookings && bookingIds.length > 0) {
        const { data: bookings } = await supabaseAdmin
          .from("bookings")
          .select(`
            id, payment_amount,
            availability_slots!inner(price_per_session, cyclus_id, cyclus_name, start_time, locations(name))
          `)
          .in("id", bookingIds);

        if (bookings && bookings.length > 0) {
          const resolvePrice = (b: any): number => {
            const bSlot = b.availability_slots as any;
            return b.payment_amount || bSlot.price_per_session || 0;
          };
          // payment_amount is the authoritative per-player charge — never
          // re-divide it. Only the slot-price fallback is the full session price
          // a split must divide. (Previously divided UNCONDITIONALLY → one run
          // halved every split invoice.)
          const bookingHasExplicitAmount = (b: { payment_amount?: number | null }): boolean =>
            b.payment_amount != null && Number(b.payment_amount) > 0;
          const allHaveExplicitAmount = bookings.every(bookingHasExplicitAmount);

          // Detect split count from existing line items
          let splitCount = 1;
          for (const item of lineItems) {
            const match = item.description?.match(/\(1\/(\d+)\)/);
            if (match) { splitCount = parseInt(match[1], 10); break; }
          }

          const firstSlot = bookings[0].availability_slots as any;
          const sharedCyclusId = firstSlot.cyclus_id;
          const allSameCyclus = sharedCyclusId && bookings.every((b: any) => (b.availability_slots as any).cyclus_id === sharedCyclusId);

          if (allSameCyclus) {
            const cyclusName = firstSlot.cyclus_name || "Training cyclus";
            const prices = bookings.map(resolvePrice);
            const nonZeroPrices = prices.filter((p: number) => p > 0);
            const allSamePrice = nonZeroPrices.length > 0 && nonZeroPrices.every((p: number) => p === nonZeroPrices[0]);

            if (allSamePrice) {
              let price = nonZeroPrices[0];
              if (splitCount > 1 && !allHaveExplicitAmount) price = Math.round((price / splitCount) * 100) / 100;
              const desc = splitCount > 1
                ? `${cyclusName} (${bookings.length} weken) (1/${splitCount})`
                : `${cyclusName} (${bookings.length} weken)`;
              lineItems = [{ description: desc, quantity: bookings.length, unit_price: price }];
            } else {
              lineItems = bookings.map((b: any) => {
                const bSlot = b.availability_slots as any;
                const startTime = new Date(bSlot.start_time);
                const locationName = bSlot.locations?.name || "";
                let price = resolvePrice(b);
                if (splitCount > 1 && !bookingHasExplicitAmount(b)) price = Math.round((price / splitCount) * 100) / 100;
                const desc = splitCount > 1
                  ? `${cyclusName} - ${startTime.toLocaleDateString("nl-NL")}${locationName ? ` (${locationName})` : ""} (1/${splitCount})`
                  : `${cyclusName} - ${startTime.toLocaleDateString("nl-NL")}${locationName ? ` (${locationName})` : ""}`;
                return { description: desc, quantity: 1, unit_price: price, date: startTime.toISOString().split("T")[0] };
              });
            }
          } else {
            lineItems = bookings.map((b: any) => {
              const bSlot = b.availability_slots as any;
              const startTime = new Date(bSlot.start_time);
              const locationName = bSlot.locations?.name || "";
              let price = resolvePrice(b);
              if (splitCount > 1 && !bookingHasExplicitAmount(b)) price = Math.round((price / splitCount) * 100) / 100;
              const desc = bSlot.cyclus_name
                ? `${bSlot.cyclus_name} - ${startTime.toLocaleDateString("nl-NL")}${locationName ? ` (${locationName})` : ""}`
                : `Training sessie - ${startTime.toLocaleDateString("nl-NL")}`;
              return { description: desc, quantity: 1, unit_price: price, date: startTime.toISOString().split("T")[0] };
            });
          }

          // Re-add extra costs from cycle settings
          if (sharedCyclusId) {
            const { data: cycleData } = await supabaseAdmin
              .from("cycles")
              .select("settings")
              .eq("id", sharedCyclusId)
              .maybeSingle();
            const extraCosts = (cycleData?.settings as any)?.extra_costs;
            if (extraCosts && Array.isArray(extraCosts)) {
              for (const ec of extraCosts) {
                if (ec.description && ec.price > 0) {
                  const isOneTime = ec.type === "one_time";
                  let ecPrice = ec.price;
                  if (splitCount > 1) ecPrice = Math.round((ecPrice / splitCount) * 100) / 100;
                  lineItems.push({
                    description: isOneTime ? ec.description : `${ec.description} (per sessie)`,
                    quantity: isOneTime ? 1 : bookings.length,
                    unit_price: ecPrice,
                    vat_rate: ec.vat_rate ?? defaultVatRate,
                  });
                }
              }
            }
          }
        }
      }

      if (lineItems.length === 0) {
        results.push({ invoice_number: inv.invoice_number, status: "skipped", reason: "no line items" });
        continue;
      }

      // Recalculate from line items
      let totalSub = 0;
      let totalVat = 0;
      const vatBreakdown: Record<number, { subtotal: number; vat: number }> = {};

      for (const item of lineItems) {
        const qty = item.quantity ?? 1;
        const unitPrice = item.unit_price ?? 0;
        const lineTotal = qty * unitPrice;
        const lineVatRate = item.vat_rate ?? defaultVatRate;

        let lineSub: number;
        let lineVat: number;

        if (pricesIncludeVat) {
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

      // Round
      const newSubtotal = Math.round(totalSub * 100) / 100;
      const newVatAmount = Math.round(totalVat * 100) / 100;
      const newTotal = pricesIncludeVat
        ? Math.round(lineItems.reduce((s, i) => s + (i.quantity ?? 1) * (i.unit_price ?? 0), 0) * 100) / 100
        : Math.round((newSubtotal + newVatAmount) * 100) / 100;

      // Round breakdown
      for (const rate in vatBreakdown) {
        vatBreakdown[rate].subtotal = Math.round(vatBreakdown[rate].subtotal * 100) / 100;
        vatBreakdown[rate].vat = Math.round(vatBreakdown[rate].vat * 100) / 100;
      }

      const oldTotal = inv.total;
      const changed = Math.abs((oldTotal as number) - newTotal) > 0.01 || rebuildFromBookings;

      const result: any = {
        invoice_number: inv.invoice_number,
        old: { subtotal: inv.subtotal, vat_amount: inv.vat_amount, total: inv.total },
        new: { subtotal: newSubtotal, vat_amount: newVatAmount, total: newTotal },
        vat_breakdown: vatBreakdown,
        prices_include_vat: pricesIncludeVat,
        changed,
      };

      if (!dryRun && changed) {
        const updatePayload: any = {
          subtotal: newSubtotal,
          vat_amount: newVatAmount,
          total: newTotal,
          pdf_url: null,
          vat_breakdown: Object.keys(vatBreakdown).length > 1 ? vatBreakdown : null,
        };
        // If we rebuilt line items, also update them on the invoice
        if (rebuildFromBookings) {
          updatePayload.line_items = lineItems;
        }

        const { error: updateErr } = await supabaseAdmin
          .from("invoices")
          .update(updatePayload)
          .eq("id", inv.id);

        result.updated = !updateErr;
        if (updateErr) result.error = updateErr.message;
      } else {
        result.updated = false;
      }

      results.push(result);
    }

    const updatedCount = results.filter((r) => r.updated).length;
    const changedCount = results.filter((r) => r.changed).length;

    return new Response(
      JSON.stringify({
        success: true,
        dry_run: dryRun,
        total_invoices: invoices.length,
        changed: changedCount,
        updated: updatedCount,
        results,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    // Raw DB error text (column/constraint names) stays in logs only.
    console.error("Error in recalculate-invoices:", err);
    return new Response(
      JSON.stringify({ error: "Failed to recalculate invoices" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
