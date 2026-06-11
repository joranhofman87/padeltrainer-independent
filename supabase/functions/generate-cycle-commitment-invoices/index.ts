import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { corsHeaders, requireServiceRoleOrAdmin } from "../_shared/auth.ts";
import {
  buildCommitmentInvoicePlan,
  isCycleDueForInvoicing,
  type CommitmentBooking,
} from "../_shared/cycle-commitment-invoicing.ts";

const logStep = (step: string, details?: Record<string, unknown>) => {
  console.log(`[GEN-CYCLE-COMMITMENT-INVOICES] ${step}`, details ? JSON.stringify(details) : "");
};

/**
 * Deferred, headcount-split invoicing for rebooked cycles.
 *
 * For each cycle that has started, finds the commitment bookings (created when
 * a player accepted their priority claim — confirmed + unpaid, linked to a
 * 'claimed' slot_priority_claim), groups them per committer, and invoices each
 * committer cycle_total / N via auto-create-invoice (splitAmongPlayers=N).
 *
 * Safe by construction:
 *  - admin/service-role only.
 *  - dryRun returns the plan (incl. per-group N) without creating invoices.
 *  - auto-create-invoice creates DRAFT invoices for unpaid bookings, so a
 *    human reviews and sends them — the cron never auto-charges.
 *  - idempotent: auto-create-invoice de-dupes on booking_ids.
 *
 * N is scoped per GROUP (players sharing a slot), so a cycle with multiple
 * independent day/time groups bills each group correctly. See
 * buildCommitmentInvoicePlan.
 */
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const auth = await requireServiceRoleOrAdmin(req);
  if (auth instanceof Response) return auth;
  const supabase = auth.supabase;

  try {
    const body = await req.json().catch(() => ({}));
    const dryRun = body?.dryRun === true;
    const onlyCycleId = typeof body?.cycleId === "string" ? body.cycleId : null;
    const now = new Date();

    let cyclesQuery = supabase
      .from("cycles")
      .select("id, name, start_date, status")
      .in("status", ["open", "closed"]);
    if (onlyCycleId) cyclesQuery = cyclesQuery.eq("id", onlyCycleId);

    const { data: cycles, error: cyclesError } = await cyclesQuery;
    if (cyclesError) throw cyclesError;

    const report: Array<Record<string, unknown>> = [];
    let invoicesCreated = 0;

    for (const cycle of cycles || []) {
      if (!isCycleDueForInvoicing(cycle.start_date, now)) continue;

      // Slots in this cycle.
      const { data: slots } = await supabase
        .from("availability_slots")
        .select("id")
        .eq("cyclus_id", cycle.id);
      const slotIds = (slots || []).map((s: { id: string }) => s.id);
      if (slotIds.length === 0) continue;

      // Commitments = bookings linked to a 'claimed' priority claim on these slots.
      const { data: claims } = await supabase
        .from("slot_priority_claims")
        .select("booking_id")
        .eq("status", "claimed")
        .not("booking_id", "is", null)
        .in("slot_id", slotIds);
      const bookingIds = (claims || [])
        .map((c: { booking_id: string | null }) => c.booking_id)
        .filter((id): id is string => !!id);
      if (bookingIds.length === 0) continue;

      const { data: bookings } = await supabase
        .from("bookings")
        .select("id, slot_id, player_id, guest_player_id, payment_status, status")
        .in("id", bookingIds);

      const plan = buildCommitmentInvoicePlan((bookings || []) as CommitmentBooking[]);
      if (plan.committerCount === 0) continue;

      // Exclude bookings already on an active (non-cancelled) invoice. The cron
      // re-derives each player's FULL claimed batch every run and claims arrive
      // across days, so batches grow — without this, a later run re-bills the
      // earlier sessions (booking double-charged on an auto-sent invoice). The
      // split divisor stays the full group headcount from the plan; only the
      // not-yet-billed bookings are sent, each still split price/groupSize.
      const { data: existingInvoices } = await supabase
        .from("invoices")
        .select("booking_ids")
        .not("status", "eq", "cancelled")
        .overlaps("booking_ids", bookingIds);
      const alreadyInvoiced = new Set<string>();
      for (const inv of existingInvoices || []) {
        for (const id of ((inv.booking_ids as string[] | null) || [])) {
          if (bookingIds.includes(id)) alreadyInvoiced.add(id);
        }
      }

      const pendingBatches = plan.batches
        .map((b) => ({ ...b, newBookingIds: b.bookingIds.filter((id) => !alreadyInvoiced.has(id)) }))
        .filter((b) => b.newBookingIds.length > 0);

      const cycleReport = {
        cycleId: cycle.id,
        cycleName: cycle.name,
        committerCount: plan.committerCount,
        batches: pendingBatches.map((b) => ({
          playerKey: b.playerKey,
          bookings: b.newBookingIds.length,
          splitAmongPlayers: b.splitAmongPlayers,
        })),
        invoiced: 0 as number,
      };

      if (!dryRun) {
        for (const batch of pendingBatches) {
          try {
            const res = await supabase.functions.invoke("auto-create-invoice", {
              body: { bookingIds: batch.newBookingIds, splitAmongPlayers: batch.splitAmongPlayers },
            });
            if (res.error) {
              logStep("auto-create-invoice failed", { cycleId: cycle.id, playerKey: batch.playerKey, error: String(res.error) });
            } else {
              cycleReport.invoiced += 1;
              invoicesCreated += 1;
            }
          } catch (e) {
            logStep("auto-create-invoice threw", { cycleId: cycle.id, playerKey: batch.playerKey, error: String(e) });
          }
        }
      }

      report.push(cycleReport);
    }

    logStep("done", { dryRun, cyclesProcessed: report.length, invoicesCreated });
    return new Response(
      JSON.stringify({ ok: true, dryRun, invoicesCreated, cycles: report }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logStep("ERROR", { message });
    return new Response(JSON.stringify({ ok: false, error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
