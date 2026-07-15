import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { corsHeaders, requireServiceRoleOrAdmin } from "../_shared/auth.ts";
import { notifySlackEdgeError } from "../_shared/edge-slack.ts";
import {
  buildCommitmentInvoicePlan,
  COMMITMENT_SCAN_PAGE_SIZE,
  COMMITMENT_TIME_BUDGET_MS,
  isCycleDueForInvoicing,
  shouldStampCycleInvoiced,
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
 *  - invoices are created as DRAFTS (asDraft: true), so a human reviews and
 *    sends them — the cron never auto-charges.
 *  - idempotent: auto-create-invoice de-dupes on booking_ids.
 *
 * N is scoped per GROUP (players sharing a slot), so a cycle with multiple
 * independent day/time groups bills each group correctly. See
 * buildCommitmentInvoicePlan.
 *
 * N is the CYCLE-START headcount (the agreed split-by-headcount model): only
 * claims accepted before the cycle's start date are considered, so every run
 * derives the same divisor — a claim trickling in after the cycle started
 * cannot change what earlier-billed committers owe. Late claims are surfaced
 * in the report (lateClaims) for manual handling.
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
    // F04 continuation cursor: a self-reinvoke passes the last cycle id it processed so this pass
    // resumes at id > afterCycleId (keyset), guaranteeing forward progress across invocations.
    const afterCycleId = typeof body?.afterCycleId === "string" ? body.afterCycleId : null;
    const now = new Date();
    const nowDateStr = now.toISOString().slice(0, 10); // cycles.start_date is a DATE

    type Cycle = { id: string; name: string | null; start_date: string | null; status: string | null; settings: unknown };

    const report: Array<Record<string, unknown>> = [];
    let invoicesCreated = 0;
    // Per-batch billing failures. The fn returns HTTP 200 even when individual
    // committers fail to bill, so the daily-maintenance cron's alertCronFailure
    // (which only trips on a non-2xx response) never sees them. Accumulate and
    // raise ONE Slack alert at the end so a silent billing gap surfaces.
    const failedBatches: Array<{ cycleId: string; playerKey: string; error: string }> = [];

    // Process ONE cycle. Returns true when the cycle was actually evaluated (due) — only an
    // evaluated cycle with no failure this pass is stamped out of the scan by the caller.
    const processCycle = async (cycle: Cycle): Promise<boolean> => {
      if (!isCycleDueForInvoicing(cycle.start_date, now)) return false;

      // Upfront cycles are paid at accept (Mollie checkout when the player
      // says yes), so the deferred split-by-headcount drafting must not run.
      // They are still surfaced in the report: unpaid stragglers are the
      // academy's manual follow-up. Evaluated (→ stamped out of the scan; deferred
      // invoicing never applies to an upfront cycle).
      const settings = (cycle.settings ?? {}) as Record<string, unknown>;
      if (settings.rebook_payment_mode === "upfront") {
        report.push({
          cycleId: cycle.id,
          cycleName: cycle.name,
          committerCount: 0,
          batches: [],
          invoiced: 0,
          note: "upfront_mode_skipped",
        });
        return true;
      }

      // Slots in this cycle.
      const { data: slots } = await supabase
        .from("availability_slots")
        .select("id")
        .eq("cyclus_id", cycle.id);
      const slotIds = (slots || []).map((s: { id: string }) => s.id);
      if (slotIds.length === 0) return true;

      // Commitments = bookings linked to a 'claimed' priority claim on these slots.
      const { data: claims } = await supabase
        .from("slot_priority_claims")
        .select("booking_id, responded_at")
        .eq("status", "claimed")
        .not("booking_id", "is", null)
        .in("slot_id", slotIds);

      // Cycle-start snapshot (M-19): the divisor N must be the headcount when
      // the cycle started, identical on every run. Claims accepted AFTER the
      // start would inflate N for late-billed bookings while earlier batches
      // were billed at the smaller N, so they're excluded and reported instead.
      // responded_at is stamped by both claim writers (accept RPC + webhook);
      // a null can only be a legacy row, which predates any start date.
      const cycleStartMs = new Date(cycle.start_date as string).getTime();
      const startedClaims: Array<{ booking_id: string | null; responded_at: string | null }> = [];
      let lateClaims = 0;
      for (const claim of claims || []) {
        const respondedMs = claim.responded_at ? new Date(claim.responded_at).getTime() : NaN;
        if (Number.isFinite(respondedMs) && respondedMs > cycleStartMs) lateClaims += 1;
        else startedClaims.push(claim);
      }
      const bookingIds = startedClaims
        .map((c) => c.booking_id)
        .filter((id): id is string => !!id);
      if (bookingIds.length === 0) {
        if (lateClaims > 0) {
          report.push({ cycleId: cycle.id, cycleName: cycle.name, committerCount: 0, batches: [], invoiced: 0, lateClaims });
        }
        return true;
      }

      const { data: bookings } = await supabase
        .from("bookings")
        .select("id, slot_id, player_id, guest_player_id, payment_status, status")
        .in("id", bookingIds);

      const plan = buildCommitmentInvoicePlan((bookings || []) as CommitmentBooking[]);
      if (plan.committerCount === 0) return true;

      // Exclude bookings already on an active (non-cancelled) invoice, so a
      // retried/partially-failed run never re-bills the sessions an earlier
      // run already drafted (booking double-charged otherwise). The split
      // divisor stays the full group headcount from the plan; only the
      // not-yet-billed bookings are invoiced, each still split price/groupSize.
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
        lateClaims,
      };

      if (!dryRun) {
        for (const batch of pendingBatches) {
          try {
            // asDraft: a human reviews and sends — the cron never issues
            // "sent" invoices on its own (M-19, per the safety doc above).
            const res = await supabase.functions.invoke("auto-create-invoice", {
              body: { bookingIds: batch.newBookingIds, splitAmongPlayers: batch.splitAmongPlayers, asDraft: true },
            });
            if (res.error) {
              logStep("auto-create-invoice failed", { cycleId: cycle.id, playerKey: batch.playerKey, error: String(res.error) });
              failedBatches.push({ cycleId: cycle.id, playerKey: batch.playerKey, error: String(res.error) });
            } else {
              cycleReport.invoiced += 1;
              invoicesCreated += 1;
            }
          } catch (e) {
            logStep("auto-create-invoice threw", { cycleId: cycle.id, playerKey: batch.playerKey, error: String(e) });
            failedBatches.push({ cycleId: cycle.id, playerKey: batch.playerKey, error: String(e) });
          }
        }
      }

      report.push(cycleReport);
      return true;
    };

    // F04 KEYSET SCAN. The old query fetched every open/closed cycle with no order/limit — PostgREST
    // silently truncated it at 1000 rows (cycles past that never invoiced) and the visited prefix
    // blew the isolate wall-clock. Now: page by id ascending (id > cursor), skip cycles already
    // stamped commitment_invoiced_at, stop at the time budget, and hand the tail to a self-reinvoke.
    let cursor: string | null = afterCycleId;
    let budgetHit = false;
    const startedAt = Date.now();

    scan: while (true) {
      let q = supabase
        .from("cycles")
        .select("id, name, start_date, status, settings")
        .in("status", ["open", "closed"])
        .order("id", { ascending: true })
        .limit(COMMITMENT_SCAN_PAGE_SIZE);
      if (onlyCycleId) {
        // Operator override: process exactly this cycle, ignoring the stamp/cursor filters
        // (used to re-draft after fixing e.g. an incomplete invoice business profile).
        q = q.eq("id", onlyCycleId);
      } else {
        q = q.is("commitment_invoiced_at", null).lte("start_date", nowDateStr);
        if (cursor) q = q.gt("id", cursor);
      }
      const { data: page, error: pageErr } = await q;
      if (pageErr) throw pageErr;
      if (!page || page.length === 0) break;

      for (const cycle of page as Cycle[]) {
        // Check the budget BEFORE each cycle so we never blow past it mid-cycle; the continuation
        // resumes at the last fully-processed cycle. Skipped for a targeted single-cycle run.
        if (!onlyCycleId && Date.now() - startedAt > COMMITMENT_TIME_BUDGET_MS) { budgetHit = true; break scan; }
        const failedBefore = failedBatches.length;
        const evaluated = await processCycle(cycle);
        cursor = cycle.id; // advance monotonically — even a failed/not-due cycle, so the chain terminates
        if (evaluated && shouldStampCycleInvoiced({ dryRun, failedBatchCount: failedBatches.length - failedBefore })) {
          const { error: stampErr } = await supabase
            .from("cycles")
            .update({ commitment_invoiced_at: new Date().toISOString() })
            .eq("id", cycle.id);
          if (stampErr) logStep("stamp failed", { cycleId: cycle.id, error: stampErr.message });
        }
      }

      if (onlyCycleId || page.length < COMMITMENT_SCAN_PAGE_SIZE) break; // single-cycle mode, or last page
    }

    logStep("done", { dryRun, cyclesProcessed: report.length, invoicesCreated, failedBatches: failedBatches.length, budgetHit, cursor });

    // F04 CONTINUATION: the time budget cut the scan off with cycles still unvisited. Chain another
    // invocation of ourselves (service-role auth → no token-expiry bound) to drain the tail from the
    // cursor, mirroring send-campaign-emails. It terminates because the cursor strictly advances each
    // pass; the daily cron (fresh cursor=null, stamped cycles filtered out) is the backstop.
    let continued = false;
    if (budgetHit && cursor) {
      const supabaseUrl = Deno.env.get("SUPABASE_URL");
      const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
      if (supabaseUrl && serviceKey) {
        const resume = fetch(`${supabaseUrl}/functions/v1/generate-cycle-commitment-invoices`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            apikey: serviceKey,
            Authorization: `Bearer ${serviceKey}`,
          },
          body: JSON.stringify({ dryRun, afterCycleId: cursor }),
        })
          .then((r) => { if (!r.ok) throw new Error(`continuation returned ${r.status}`); })
          .catch(async (e) => {
            // The continuation could not be scheduled — the cycles after the cursor are unvisited
            // until the next daily run. Surface it (the audit's "alert when a run ends with
            // unvisited cycles"); the stamp filter means the daily run still resumes correctly.
            logStep("self-reinvoke failed", { error: String(e), afterCycleId: cursor });
            await notifySlackEdgeError(
              "generate-cycle-commitment-invoices",
              "commitment-invoicing scan hit its time budget but the continuation could not be scheduled — cycles after the cursor stay unvisited until the next daily run",
              { afterCycleId: cursor, invoicesCreated },
            );
          });
        const edgeRuntime = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
        if (edgeRuntime?.waitUntil) edgeRuntime.waitUntil(resume);
        else await resume;
        continued = true;
      }
    }

    // Some committers could not be billed this run — a silent money gap the
    // cron wrapper can't see (we still return 200). Raise one alert with the
    // failed batches so the academy/ops can re-run or invoice them manually.
    if (failedBatches.length > 0) {
      await notifySlackEdgeError(
        "generate-cycle-commitment-invoices",
        `${failedBatches.length} commitment invoice batch(es) failed to draft`,
        { failedBatches: failedBatches.slice(0, 20), invoicesCreated },
      );
    }

    return new Response(
      JSON.stringify({
        ok: true,
        dryRun,
        invoicesCreated,
        failedBatches: failedBatches.length,
        continued,
        nextCursor: budgetHit ? cursor : null,
        cycles: report,
      }),
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
