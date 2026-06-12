import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { requireUser, corsHeaders as sharedCors } from "../_shared/auth.ts";

const corsHeaders = sharedCors;

const logStep = (step: string, details?: Record<string, unknown>) => {
  console.log(
    `[SPLIT-INVOICE] ${step}`,
    details ? JSON.stringify(details) : ""
  );
};

type InvoiceLineItem = {
  description: string;
  quantity: number;
  unit_price: number;
  vat_rate?: number;
  [key: string]: unknown;
};

const toCents = (value: number): number => Math.round(value * 100);

const sumLineItemCents = (items: InvoiceLineItem[]): number =>
  items.reduce(
    (sum, item) => sum + toCents((item.quantity ?? 1) * (item.unit_price ?? 0)),
    0
  );

// Line items sum to the inclusive total when prices include VAT, otherwise to
// the subtotal (same invariant as auto-create-invoice / invoiceSync).
const lineItemTargetCents = (
  shareCents: number,
  defaultVatRate: number,
  pricesIncludeVat: boolean
): number =>
  pricesIncludeVat
    ? shareCents
    : Math.round(shareCents / (1 + defaultVatRate / 100));

// M-29: make Σ(quantity × unit_price) equal targetCents exactly. A 1-cent
// unit-price change moves a quantity-Q line by Q cents, so absorb the residual
// into a quantity-1 line; if none can take it, append an explicit rounding line.
const reconcileLineItemsToCents = (
  items: InvoiceLineItem[],
  targetCents: number
): InvoiceLineItem[] => {
  const residualCents = targetCents - sumLineItemCents(items);
  if (residualCents === 0) return items;
  const adjusted = items.map((item) => ({ ...item }));
  for (let i = adjusted.length - 1; i >= 0; i--) {
    const quantity = adjusted[i].quantity ?? 1;
    const newUnitCents = toCents(adjusted[i].unit_price ?? 0) + residualCents;
    if (quantity === 1 && newUnitCents > 0) {
      adjusted[i].unit_price = newUnitCents / 100;
      return adjusted;
    }
  }
  adjusted.push({ description: "Afronding", quantity: 1, unit_price: residualCents / 100 });
  return adjusted;
};

const hasMixedVatRates = (items: InvoiceLineItem[], defaultVatRate: number): boolean =>
  new Set(items.map((i) => i.vat_rate ?? defaultVatRate)).size > 1;

const grossCentsOf = (
  items: InvoiceLineItem[],
  defaultVatRate: number,
  pricesIncludeVat: boolean
): number =>
  items.reduce((sum, item) => {
    const lineCents = toCents((item.quantity ?? 1) * (item.unit_price ?? 0));
    if (pricesIncludeVat) return sum + lineCents;
    const rate = item.vat_rate ?? defaultVatRate;
    return sum + Math.round(lineCents * (1 + rate / 100));
  }, 0);

// Rate-aware reconciliation entry point. With EXCLUSIVE prices and MIXED VAT
// rates, a net target derived from the default rate misprices other-rate lines
// (review caught a 9% baanhuur line moved ~75ct). For that case reconcile in
// GROSS space and absorb any residual in a 0%-VAT rounding line, which adds
// exactly its amount to both subtotal and gross total.
const reconcileItemsToShare = (
  items: InvoiceLineItem[],
  shareCents: number,
  defaultVatRate: number,
  pricesIncludeVat: boolean
): InvoiceLineItem[] => {
  if (!pricesIncludeVat && hasMixedVatRates(items, defaultVatRate)) {
    const residualCents = shareCents - grossCentsOf(items, defaultVatRate, false);
    if (residualCents === 0) return items;
    return [
      ...items.map((item) => ({ ...item })),
      { description: "Afronding", quantity: 1, unit_price: residualCents / 100, vat_rate: 0 },
    ];
  }
  return reconcileLineItemsToCents(
    items,
    lineItemTargetCents(shareCents, defaultVatRate, pricesIncludeVat)
  );
};

// VAT derivation mirrors auto-create-invoice: totals are authoritative, the
// subtotal/VAT pair is derived from them and rounded per value.
const computeInvoiceAmounts = (
  lineItems: InvoiceLineItem[],
  totalCents: number,
  defaultVatRate: number,
  pricesIncludeVat: boolean
): {
  subtotal: number;
  vatAmount: number;
  total: number;
  vatBreakdown: Record<number, { subtotal: number; vat: number }>;
} => {
  const hasMultipleVatRates = lineItems.some(
    (item) => (item.vat_rate ?? defaultVatRate) !== defaultVatRate
  );
  const total = totalCents / 100;
  let subtotal: number;
  let vatAmount: number;
  const vatBreakdown: Record<number, { subtotal: number; vat: number }> = {};

  if (hasMultipleVatRates) {
    let totalSub = 0;
    let totalVat = 0;
    for (const item of lineItems) {
      const lineTotal = item.quantity * item.unit_price;
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
    subtotal = totalSub;
    vatAmount = totalVat;
    for (const rate in vatBreakdown) {
      vatBreakdown[rate].subtotal = Math.round(vatBreakdown[rate].subtotal * 100) / 100;
      vatBreakdown[rate].vat = Math.round(vatBreakdown[rate].vat * 100) / 100;
    }
  } else if (pricesIncludeVat) {
    subtotal = total / (1 + defaultVatRate / 100);
    vatAmount = total - subtotal;
  } else {
    // Exclusive prices: the line items sum to the subtotal.
    subtotal = lineItems.reduce((sum, item) => sum + item.quantity * item.unit_price, 0);
    vatAmount = total - subtotal;
  }

  return {
    subtotal: Math.round(subtotal * 100) / 100,
    vatAmount: Math.round(vatAmount * 100) / 100,
    total: Math.round(total * 100) / 100,
    vatBreakdown,
  };
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;
  const supabase = auth.supabase;

  try {

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

    // Authorization: caller must be admin, the invoice's trainer, or a manager
    // of the invoice's academy. Service-role calls bypass this check.
    if (!auth.isServiceRole) {
      const userId = auth.user.id;
      const [{ data: trainerProfile }, { data: adminRow }] = await Promise.all([
        supabase.from("trainer_profiles").select("id").eq("user_id", userId).maybeSingle(),
        supabase.from("user_roles").select("role").eq("user_id", userId).eq("role", "admin").maybeSingle(),
      ]);
      const isAdmin = !!adminRow;
      const isOwningTrainer = trainerProfile?.id && trainerProfile.id === invoice.trainer_id;
      let isAcademyManager = false;
      if (!isAdmin && !isOwningTrainer && invoice.academy_profile_id) {
        const { data: managed } = await supabase
          .from("academy_managers")
          .select("id")
          .eq("user_id", userId)
          .eq("academy_profile_id", invoice.academy_profile_id)
          .maybeSingle();
        isAcademyManager = !!managed;
      }
      if (!isAdmin && !isOwningTrainer && !isAcademyManager) {
        logStep("Forbidden: caller does not own invoice", { userId, invoiceId });
        return new Response(JSON.stringify({ error: "Forbidden" }), {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
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
    const existingLineItems = (invoice.line_items as InvoiceLineItem[]) || [];
    const alreadySplit = existingLineItems.some((li) => /\(1\/\d+\)/.test(li.description || ""));
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
      .select("id, slot_id, player_id, guest_player_id, status, payment_amount")
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
      { bookingIds: string[]; isGuest: boolean; hasPaymentAmount: boolean }
    > = {};

    for (const b of allBookings) {
      const key = b.player_id || `guest:${b.guest_player_id}`;
      if (!playerBookings[key]) {
        playerBookings[key] = { bookingIds: [], isGuest: !b.player_id, hasPaymentAmount: false };
      }
      playerBookings[key].bookingIds.push(b.id);
      // payment_amount is authoritative (Mollie); invoices built from it must
      // not be re-aligned to a computed share below.
      if ((b.payment_amount ?? 0) > 0) {
        playerBookings[key].hasPaymentAmount = true;
      }
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

    // 5. Update the existing invoice: divide line items by N.
    // M-29: work in integer cents — floor(total/N) per player and hand the
    // remainder cents out one per invoice (original first), so the N invoice
    // totals sum EXACTLY to the original total.
    const originalLineItems = existingLineItems;
    const vatRate = invoice.vat_rate || 21;
    const originalTotal = invoice.total as number;
    const invoicePricesIncludeVat = invoice.prices_include_vat ?? true;

    const totalCents = toCents(originalTotal);
    const baseCents = Math.floor(totalCents / totalPlayers);
    const remainderCents = totalCents - baseCents * totalPlayers;
    let shareIndex = 0;
    const nextShareCents = (): number => {
      const i = shareIndex++;
      return baseCents + (i < remainderCents ? 1 : 0);
    };

    // The original invoice (first player) takes the first share
    const firstPlayerShareCents = nextShareCents();

    // Divide unit prices for display, then reconcile so the line items sum
    // exactly to this invoice's share.
    const updatedLineItems = reconcileItemsToShare(
      originalLineItems.map((item) => ({
        ...item,
        unit_price: Math.round((item.unit_price / totalPlayers) * 100) / 100,
        description: `${item.description} (1/${totalPlayers})`,
      })),
      firstPlayerShareCents,
      vatRate,
      invoicePricesIncludeVat
    );

    const firstAmounts = computeInvoiceAmounts(
      updatedLineItems,
      firstPlayerShareCents,
      vatRate,
      invoicePricesIncludeVat
    );

    logStep("Split calculation", {
      originalTotal,
      totalPlayers,
      firstPlayerTotal: firstAmounts.total,
      remainderCents,
    });

    const { error: updateErr } = await supabase
      .from("invoices")
      .update({
        line_items: updatedLineItems,
        subtotal: firstAmounts.subtotal,
        vat_amount: firstAmounts.vatAmount,
        total: firstAmounts.total,
        ...(Object.keys(firstAmounts.vatBreakdown).length > 0
          ? { vat_breakdown: firstAmounts.vatBreakdown }
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

    logStep("Updated existing invoice", { newTotal: firstAmounts.total });

    // M-29: auto-create-invoice rounds each unit price to the cent, so a
    // created invoice can drift a few cents from the player's exact share.
    // Pull it back so the N invoice totals sum exactly to the original.
    const reconcileCreatedInvoice = async (
      createdInvoiceId: string,
      shareCents: number,
      playerKey: string
    ): Promise<void> => {
      const { data: created, error: fetchErr } = await supabase
        .from("invoices")
        .select("id, line_items, total, vat_rate, prices_include_vat, status")
        .eq("id", createdInvoiceId)
        .single();
      if (fetchErr || !created) {
        logStep("Could not fetch created invoice for cent reconciliation", {
          createdInvoiceId,
          error: fetchErr?.message,
        });
        return;
      }
      // Paid amounts are authoritative — never restate them.
      if (created.status === "paid") return;
      const createdItems = (created.line_items as InvoiceLineItem[]) || [];
      if (createdItems.length === 0) return;
      const driftCents = shareCents - toCents(created.total as number);
      if (driftCents === 0) return;
      // Per-unit rounding moves a line by at most quantity/2 cents (~×1.21 on
      // VAT-exclusive totals); a larger drift means the created invoice prices
      // genuinely differ from total/N — leave it alone.
      const totalQuantity = createdItems.reduce(
        (sum, item) => sum + (item.quantity ?? 1),
        0
      );
      const toleranceCents = Math.ceil(totalQuantity * 0.75) + 1;
      if (Math.abs(driftCents) > toleranceCents) {
        logStep("Created invoice differs beyond rounding drift, leaving as-is", {
          createdInvoiceId,
          driftCents,
          toleranceCents,
        });
        return;
      }
      const createdVatRate = (created.vat_rate as number) || 21;
      const createdIncludesVat = (created.prices_include_vat as boolean | null) ?? true;
      const reconciledItems = reconcileItemsToShare(
        createdItems,
        shareCents,
        createdVatRate,
        createdIncludesVat
      );
      const amounts = computeInvoiceAmounts(
        reconciledItems,
        shareCents,
        createdVatRate,
        createdIncludesVat
      );
      const { error: reconcileErr } = await supabase
        .from("invoices")
        .update({
          line_items: reconciledItems,
          subtotal: amounts.subtotal,
          vat_amount: amounts.vatAmount,
          total: amounts.total,
          ...(Object.keys(amounts.vatBreakdown).length > 0
            ? { vat_breakdown: amounts.vatBreakdown }
            : {}),
          pdf_url: null, // Regenerate with the corrected amounts
        })
        .eq("id", createdInvoiceId);
      if (reconcileErr) {
        logStep("Failed to reconcile created invoice to exact share", {
          createdInvoiceId,
          error: reconcileErr.message,
        });
      } else {
        logStep("Reconciled created invoice to exact share", {
          createdInvoiceId,
          playerKey,
          shareCents,
          driftCents,
        });
      }
    };

    // 6. Create invoices for other players
    // Identify the original player key
    const originalPlayerKey =
      invoice.player_id || `guest:${invoice.guest_player_id}`;
    const createdInvoices: string[] = [];

    for (const [playerKey, data] of Object.entries(playerBookings)) {
      if (playerKey === originalPlayerKey) continue;

      // Consume this player's cent share even when we end up skipping them,
      // so the share↔player mapping stays stable.
      const playerShareCents = nextShareCents();

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
          existingInvoiceIds: existingInvoices.map((i: { id: string }) => i.id),
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
        if (result?.invoiceId) {
          createdInvoices.push(result.invoiceId);
          // Deduped invoices pre-exist this split; payment_amount-priced
          // invoices mirror what Mollie actually charges. Both stay untouched.
          if (!result?.deduped && !data.hasPaymentAmount) {
            await reconcileCreatedInvoice(result.invoiceId, playerShareCents, playerKey);
          }
        }
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
          const settings = (cycleData.settings as Record<string, unknown>) || {};
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
