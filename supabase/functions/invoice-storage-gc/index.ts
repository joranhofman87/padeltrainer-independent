// Theme B / B2 (audit R05+R23+R06): garbage collector for the private 'invoices' bucket.
//
// The bucket was append-only forever: nothing ever removed a render, draft renumbering orphaned
// the old objects (the storage key IS the invoice number), and academy-folder objects can't even
// be matched by the bucket's auth.uid()-keyed RLS — so lifecycle is a SERVICE-ROLE job by design.
//
// Contract (B1): an object is LIVE iff its key prefix matches some invoice's render_path.
// Unmatched objects become delete candidates only after a 90-day grace (owner decision), so a
// matching mistake surfaces in the report-only phase long before anything is destroyed.
//
// SAFETY LADDER:
//   * report-only by default — pass { apply: true } to actually delete (the daily cron starts
//     without it; flip after reviewing one clean report);
//   * 90-day grace on the object's updated_at;
//   * per-run deletion cap (200) — a bug costs at most one capped batch per day, visibly;
//   * freshness/parse doubt always classifies as KEEP (see _shared/invoice-storage-gc.ts);
//   * Slack summary whenever orphans are found or deleted, so the numbers are never silent.
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { corsHeaders, requireServiceRoleOrAdmin } from "../_shared/auth.ts";
import { notifySlackEdgeError } from "../_shared/edge-slack.ts";
import {
  classifyInvoiceRenderObjects,
  INVOICE_GC_GRACE_DAYS,
  planInvoiceGcDeletion,
  type StorageObjectRow,
} from "../_shared/invoice-storage-gc.ts";

const logStep = (step: string, details?: Record<string, unknown>) => {
  console.log(`[INVOICE-STORAGE-GC] ${step}`, details ? JSON.stringify(details) : "");
};

const PAGE_SIZE = 1000;
const TIME_BUDGET_MS = 110_000;

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const auth = await requireServiceRoleOrAdmin(req);
  if (auth instanceof Response) return auth;
  const supabase = auth.supabase;

  try {
    const body = await req.json().catch(() => ({}));
    const apply = body?.apply === true; // default: report-only
    const now = new Date();
    const startedAt = Date.now();

    // 1) The live set: every stamped render_path (keyset-paginated — no 1000-row truncation).
    const livePrefixes = new Set<string>();
    let rowCursor: string | null = null;
    while (true) {
      let q = supabase
        .from("invoices")
        .select("id, render_path")
        .not("render_path", "is", null)
        .order("id", { ascending: true })
        .limit(PAGE_SIZE);
      if (rowCursor) q = q.gt("id", rowCursor);
      const { data: rows, error: rowErr } = await q;
      if (rowErr) throw rowErr;
      if (!rows || rows.length === 0) break;
      for (const r of rows as Array<{ id: string; render_path: string | null }>) {
        if (r.render_path) livePrefixes.add(r.render_path);
        rowCursor = r.id;
      }
      if (rows.length < PAGE_SIZE) break;
    }

    // 2) Walk the bucket (keyset on name) and classify each page against the live set. The storage
    //    schema is not PostgREST-exposed, so the read goes through the SECURITY DEFINER RPC
    //    invoice_gc_list_objects (service-role-only, bucket-pinned, migration 20260826160000).
    let live = 0;
    let freshUnmatched = 0;
    const orphans: string[] = [];
    let objCursor: string | null = null;
    let budgetHit = false;
    while (true) {
      if (Date.now() - startedAt > TIME_BUDGET_MS) { budgetHit = true; break; }
      const { data: page, error: pageErr } = (await supabase.rpc("invoice_gc_list_objects", {
        _after: objCursor,
        _limit: PAGE_SIZE,
      })) as { data: StorageObjectRow[] | null; error: { message: string } | null };
      if (pageErr) throw new Error(pageErr.message);
      if (!page || page.length === 0) break;
      const cls = classifyInvoiceRenderObjects(page as StorageObjectRow[], livePrefixes, now);
      live += cls.live;
      freshUnmatched += cls.freshUnmatched;
      orphans.push(...cls.orphans);
      objCursor = (page as StorageObjectRow[])[page.length - 1].name;
      if (page.length < PAGE_SIZE) break;
    }

    // 3) Delete (apply mode only), capped per run, in remove()-sized chunks. The report-vs-apply
    //    gate + the per-run cap live in a pure helper so their safety behavior is unit-tested.
    const { toDelete, capped } = planInvoiceGcDeletion(orphans, apply);
    let deleted = 0;
    const deleteErrors: string[] = [];
    for (let i = 0; i < toDelete.length; i += 100) {
      const chunk = toDelete.slice(i, i + 100);
      const { error: rmErr } = await supabase.storage.from("invoices").remove(chunk);
      if (rmErr) {
        deleteErrors.push(rmErr.message);
        logStep("remove_failed", { error: rmErr.message, chunkStart: i });
        break; // don't hammer a failing storage API; the next daily run retries
      }
      deleted += chunk.length;
    }

    const report = {
      ok: true,
      mode: apply ? "apply" : "report-only",
      graceDays: INVOICE_GC_GRACE_DAYS,
      liveObjects: live,
      freshUnmatched,
      orphans: orphans.length,
      orphanSample: orphans.slice(0, 20),
      deleted,
      capped,
      budgetHit,
      deleteErrors,
    };
    logStep("done", report);

    // The numbers must never be silent: report-mode orphans are the review signal for flipping to
    // apply; apply-mode deletions/errors are the audit trail. Quiet runs (nothing to do) stay quiet.
    if (orphans.length > 0 || deleted > 0 || deleteErrors.length > 0) {
      await notifySlackEdgeError(
        "invoice-storage-gc",
        apply
          ? `invoice render GC: deleted ${deleted}/${orphans.length} orphaned objects${capped ? " (capped — remainder next run)" : ""}${deleteErrors.length ? " — WITH ERRORS" : ""}`
          : `invoice render GC (report-only): ${orphans.length} orphaned object(s) past the ${INVOICE_GC_GRACE_DAYS}d grace — review sample, then flip daily-maintenance to { apply: true }`,
        { ...report, orphanSample: report.orphanSample.slice(0, 10) },
      );
    }

    return new Response(JSON.stringify(report), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logStep("ERROR", { message });
    await notifySlackEdgeError("invoice-storage-gc", message);
    return new Response(JSON.stringify({ ok: false, error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
