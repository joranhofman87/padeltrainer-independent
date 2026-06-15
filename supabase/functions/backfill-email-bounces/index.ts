// One-off backfill: seed email_address_state from Resend's historical email log so
// addresses that bounced BEFORE the webhook existed still flag their players.
//
// Resend has no date/status filter on GET /emails, so we page newest->older
// (cursor pagination), stop at the lookback boundary, and record every email whose
// last_event is a bounce/complaint via record_email_event (idempotent on a
// backfill:<id> key). Because state is address-keyed, a player only stays flagged
// while their CURRENT email is the bad one — changing it clears the warning.
//
// Admin-only: requires the service-role key as the bearer. Idempotent — safe to
// re-run. Invoke once, then it can be removed.
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const log = (s: string, d?: Record<string, unknown>) =>
  console.log(`[BACKFILL-EMAIL-BOUNCES] ${s}`, d ? JSON.stringify(d) : "");

serve(async (req) => {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const resendKey = Deno.env.get("RESEND_API_KEY");
  if (!supabaseUrl || !serviceKey || !resendKey) {
    return new Response("misconfigured", { status: 500 });
  }
  // admin-only: caller must present the one-off backfill token (set as a function
  // secret). Kept separate from the service-role key so it can be run without
  // exposing god-mode credentials, then the secret + function removed afterwards.
  const backfillToken = Deno.env.get("BACKFILL_TOKEN");
  if (!backfillToken || req.headers.get("Authorization") !== `Bearer ${backfillToken}`) {
    return new Response("unauthorized", { status: 401 });
  }

  // lookback window (default 2 months) — override with ?days=N
  const url = new URL(req.url);
  const days = Math.min(Math.max(Number(url.searchParams.get("days")) || 60, 1), 365);
  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const dryRun = url.searchParams.get("dry") === "1";

  const supabase = createClient(supabaseUrl, serviceKey);

  let after: string | undefined;
  let scanned = 0, inWindow = 0, seeded = 0, pages = 0;
  let newestFirst: boolean | null = null;
  const MAX_PAGES = 200; // ~20k emails — hard backstop
  const sample: { email: string; type: string; at: string }[] = [];

  try {
    while (pages < MAX_PAGES) {
      const qs = new URLSearchParams({ limit: "100" });
      if (after) qs.set("after", after);
      const res = await fetch(`https://api.resend.com/emails?${qs}`, {
        headers: { Authorization: `Bearer ${resendKey}` },
      });
      if (!res.ok) {
        const body = await res.text();
        log("resend_list_failed", { status: res.status, body: body.slice(0, 300) });
        return new Response(JSON.stringify({ error: "resend_list_failed", status: res.status, body: body.slice(0, 300) }), {
          status: 502, headers: { "Content-Type": "application/json" },
        });
      }
      const json = await res.json();
      const data: any[] = Array.isArray(json?.data) ? json.data : [];
      if (data.length === 0) break;
      pages++;

      if (newestFirst === null && data.length > 1) {
        newestFirst = Date.parse(data[0].created_at) >= Date.parse(data[data.length - 1].created_at);
      }

      for (const em of data) {
        scanned++;
        const at = Date.parse(em.created_at);
        if (!Number.isFinite(at) || at < cutoffMs) continue;
        inWindow++;
        const ev = String(em.last_event ?? "").toLowerCase();
        const isBounce = ev.includes("bounce");
        const isComplaint = ev.includes("complain");
        if (!isBounce && !isComplaint) continue;
        const to = Array.isArray(em.to) ? em.to[0] : em.to;
        if (!to) continue;
        if (sample.length < 25) sample.push({ email: to, type: isComplaint ? "complained" : "bounced", at: em.created_at });
        if (dryRun) { seeded++; continue; }
        const { error } = await supabase.rpc("record_email_event", {
          p_event_type: isComplaint ? "complained" : "bounced",
          p_recipient_email: to,
          p_resend_email_id: em.id,
          p_resend_event_id: `backfill:${em.id}`,
          p_bounce_type: isComplaint ? null : "hard",
          p_reason: "backfill from Resend history",
          p_occurred_at: em.created_at,
        });
        if (error) { log("record_failed", { id: em.id, error: error.message }); continue; }
        seeded++;
      }

      // newest-first list + this page already crossed the cutoff -> done
      if (newestFirst && Date.parse(data[data.length - 1].created_at) < cutoffMs) break;
      if (data.length < 100) break; // last page
      after = data[data.length - 1].id;
    }

    const capped = pages >= MAX_PAGES;
    log("done", { scanned, inWindow, seeded, pages, capped, days, dryRun });
    return new Response(JSON.stringify({ scanned, inWindow, seeded, pages, capped, days, dryRun, sample }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log("error", { msg });
    return new Response(JSON.stringify({ error: msg }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
});
