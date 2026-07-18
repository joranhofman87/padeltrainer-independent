import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { requireAdmin } from "../_shared/auth.ts";
import { restrictedCors } from "../_shared/cors.ts";
import { notifySlackEdgeError } from "../_shared/edge-slack.ts";
import { backfillGroupKey } from "../_shared/backfill-invoice-grouping.ts";

const logStep = (step: string, details?: Record<string, unknown>) => {
  console.log(`[BACKFILL-INVOICES] ${step}`, details ? JSON.stringify(details) : "");
};

serve(async (req) => {
  const corsHeaders = restrictedCors(req);
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const auth = await requireAdmin(req);
  if (auth instanceof Response) return auth;
  const supabase = auth.supabase;
  // Used below to invoke auto-create-invoice over HTTP. These were referenced but
  // never defined — the backfill loop threw ReferenceError the moment it reached the
  // first group (latent because this is a rarely-run admin utility).
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  try {

    const { academyProfileId } = await req.json();
    if (!academyProfileId) {
      return new Response(JSON.stringify({ error: "academyProfileId required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    logStep("Starting backfill", { academyProfileId });

    // 1. Get all trainer IDs for this academy
    const { data: trainers, error: tErr } = await supabase
      .from("academy_trainers")
      .select("trainer_profile_id")
      .eq("academy_profile_id", academyProfileId)
      .eq("status", "active");

    if (tErr) throw tErr;
    const trainerIds = (trainers || []).map((t: any) => t.trainer_profile_id);
    logStep("Found trainers", { count: trainerIds.length });

    if (trainerIds.length === 0) {
      return new Response(JSON.stringify({ created: 0, message: "No trainers found" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 2. Get all confirmed unpaid bookings for these trainers — SCOPED TO THIS
    // ACADEMY'S SLOTS. Without the academy_profile_id filter a trainer shared
    // between academies A and B would let an academy-A backfill invoice their
    // academy-B bookings (cross-tenant money leak).
    const { data: bookings, error: bErr } = await supabase
      .from("bookings")
      .select("id, slot_id, player_id, guest_player_id, payment_status, paid_externally, status, availability_slots!inner(trainer_id, academy_profile_id, cyclus_id)")
      .in("availability_slots.trainer_id", trainerIds)
      .eq("availability_slots.academy_profile_id", academyProfileId)
      .eq("status", "confirmed")
      .eq("payment_status", "pending")
      .neq("paid_externally", true);

    if (bErr) throw bErr;
    logStep("Found unpaid bookings", { count: (bookings || []).length });

    if (!bookings || bookings.length === 0) {
      return new Response(JSON.stringify({ created: 0, message: "No unpaid bookings found" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 3. Get existing invoices for this academy to find already-invoiced booking IDs
    const { data: existingInvoices } = await supabase
      .from("invoices")
      .select("line_items")
      .eq("academy_profile_id", academyProfileId);

    const invoicedBookingIds = new Set<string>();
    for (const inv of existingInvoices || []) {
      if (Array.isArray(inv.line_items)) {
        for (const item of inv.line_items) {
          if (item.booking_id) invoicedBookingIds.add(item.booking_id);
          if (Array.isArray(item.booking_ids)) {
            item.booking_ids.forEach((id: string) => invoicedBookingIds.add(id));
          }
        }
      }
    }
    logStep("Already invoiced bookings", { count: invoicedBookingIds.size });

    // 4. Filter out already-invoiced bookings
    const uninvoiced = bookings.filter((b: any) => !invoicedBookingIds.has(b.id));
    logStep("Uninvoiced bookings", { count: uninvoiced.length });

    if (uninvoiced.length === 0) {
      return new Response(JSON.stringify({ created: 0, message: "All bookings already invoiced" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 5. Group by (cyclus, invoice subject). The subject is GUEST-FIRST (FAM-02):
    // a parent-books-for-child dual-key booking bills the child guest, so distinct
    // children never collapse into one parent-keyed invoice. See backfillGroupKey.
    const groups: Record<string, string[]> = {};
    for (const b of uninvoiced) {
      const slot = (b as any).availability_slots;
      const key = backfillGroupKey(slot?.cyclus_id, b);
      if (!groups[key]) groups[key] = [];
      groups[key].push(b.id);
    }
    logStep("Grouped into invoice batches", { groupCount: Object.keys(groups).length });

    // 6. Call auto-create-invoice for each group, in bounded-concurrency chunks.
    // Groups are distinct (cyclus, player) keys so they never collide, and M-10's
    // next_invoice_sequence serializes invoice-number allocation — so chunked
    // parallelism is safe and keeps a large backfill from running serially into
    // the edge wall-clock limit.
    let created = 0;
    let errors = 0;
    const groupEntries = Object.entries(groups);
    const CHUNK = 5;
    for (let i = 0; i < groupEntries.length; i += CHUNK) {
      const chunk = groupEntries.slice(i, i + CHUNK);
      const results = await Promise.all(
        chunk.map(async ([key, bookingIds]) => {
          try {
            const resp = await fetch(`${supabaseUrl}/functions/v1/auto-create-invoice`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${supabaseServiceKey}`,
              },
              body: JSON.stringify({ bookingIds, asDraft: true }),
            });
            const result = await resp.json();
            if (resp.ok && result.invoiceId) return true;
            logStep("Failed to create invoice for group", { key, result });
            return false;
          } catch (e) {
            logStep("Error creating invoice for group", { key, error: String(e) });
            return false;
          }
        }),
      );
      for (const okResult of results) {
        if (okResult) created++;
        else errors++;
      }
    }

    logStep("Backfill complete", { created, errors });

    // Alert once on partial failure (some invoice groups never got created). IDs/counts only — no PII.
    if (errors > 0) {
      await notifySlackEdgeError(
        "backfill-invoices",
        `${errors} of ${Object.keys(groups).length} invoice groups failed to create`,
        { academyProfileId, created, errors, totalGroups: Object.keys(groups).length },
      );
    }

    return new Response(JSON.stringify({ created, errors, totalGroups: Object.keys(groups).length }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    logStep("Fatal error", { error: String(err) });
    // Alert on fatal failure of this bulk admin money fn (DB errors, parse, etc.).
    await notifySlackEdgeError("backfill-invoices", err instanceof Error ? err.message : String(err));
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
