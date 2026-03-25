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
    try {
      const body = await req.json();
      dryRun = body.dry_run === true;
      if (Array.isArray(body.invoice_ids)) invoiceIds = body.invoice_ids;
    } catch { /* no body */ }

    // Fetch unpaid invoices
    let query = supabaseAdmin
      .from("invoices")
      .select("id, invoice_number, line_items, subtotal, vat_amount, total, vat_rate, prices_include_vat, status")
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
      const lineItems: any[] = (inv.line_items as any[]) || [];
      if (lineItems.length === 0) {
        results.push({ invoice_number: inv.invoice_number, status: "skipped", reason: "no line items" });
        continue;
      }

      const pricesIncludeVat = inv.prices_include_vat ?? true;
      const defaultVatRate = (inv.vat_rate as number) || 21;

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
          // unit_price includes VAT → back-calculate
          lineSub = lineTotal / (1 + lineVatRate / 100);
          lineVat = lineTotal - lineSub;
        } else {
          // unit_price is excl VAT → add VAT on top
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
      const changed = Math.abs((oldTotal as number) - newTotal) > 0.01;

      const result: any = {
        invoice_number: inv.invoice_number,
        old: { subtotal: inv.subtotal, vat_amount: inv.vat_amount, total: inv.total },
        new: { subtotal: newSubtotal, vat_amount: newVatAmount, total: newTotal },
        vat_breakdown: vatBreakdown,
        prices_include_vat: pricesIncludeVat,
        changed,
      };

      if (!dryRun && changed) {
        const { error: updateErr } = await supabaseAdmin
          .from("invoices")
          .update({
            subtotal: newSubtotal,
            vat_amount: newVatAmount,
            total: newTotal,
            pdf_url: null,
            vat_breakdown: Object.keys(vatBreakdown).length > 1 ? vatBreakdown : null,
          })
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
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
