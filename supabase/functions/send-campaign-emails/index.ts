import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { isServiceRoleRequest } from "../_shared/service-role-auth.ts";
import { notifySlackEdgeError } from "../_shared/edge-slack.ts";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    if (!RESEND_API_KEY) throw new Error("RESEND_API_KEY not configured");
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error("Supabase config missing");

    // Verify auth
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Two trusted callers use the service-role key instead of a user JWT: the daily sweep
    // cron (api/cron/daily-maintenance.ts) and our OWN resume chain (the self-reinvoke at the
    // end of the campaign path). isServiceRoleRequest byte-matches the injected key or validates
    // a service_role JWT carried in apikey+Authorization — exactly how api/_lib/cron.ts calls us.
    // These skip user-JWT validation + ownership (ownership was enforced when the campaign's
    // first, user-initiated invocation ran). Everyone else must present a valid user token.
    const isServiceRole = isServiceRoleRequest(req);
    let user: { id: string } | null = null;
    if (!isServiceRole) {
      const token = authHeader.replace("Bearer ", "");
      const userClient = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY") || "");
      const { data: { user: authUser }, error: authError } = await userClient.auth.getUser(token);
      if (authError || !authUser) {
        return new Response(JSON.stringify({ error: "Invalid token" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      user = authUser;
    }

    const body = await req.json();
    const { campaignId, testMode, testEmail, subject: testSubject, bodyHtml: testBodyHtml, academyProfileId, trainerProfileId } = body;
    // A self-reinvoke (see end of the campaign path) sets this so the continuation skips
    // the concurrency gate + stale-reset — it IS the trusted continuation of the prior run,
    // which already pushed its unsent tail back to "pending". Auth + ownership still run, and
    // the atomic pending->sending claim still prevents any double-send, so this is safe.
    const isResume = body.isResume === true;
    // An owner clicked "retry failed recipients": re-queue this campaign's failed rows
    // (still under the attempt cap) before the normal claim+send below.
    const retryFailed = body.retryFailed === true;

    // Helper: verify caller owns the campaign owner (academy or trainer).
    async function verifyOwner(academyId: string | null, trainerId: string | null): Promise<boolean> {
      if (isServiceRole || !user) return isServiceRole; // trusted internal caller — no per-user check
      if (academyId) {
        const { data: isManager } = await supabase.rpc("is_academy_manager", {
          _user_id: user.id,
          _academy_profile_id: academyId,
        });
        return !!isManager;
      }
      if (trainerId) {
        const { data: tp } = await supabase
          .from("trainer_profiles")
          .select("user_id")
          .eq("id", trainerId)
          .maybeSingle();
        return tp?.user_id === user.id;
      }
      return false;
    }

    // === SWEEP MODE (daily backstop) ===
    // The service-role cron calls us with {sweep:true} to recover any campaign whose resume
    // chain never completed — e.g. its first (user-initiated) invocation was hard-killed before
    // it could schedule a continuation. Find campaigns stuck in 'sending' past the stale window
    // that still have queued recipients, and re-trigger each as a normal send. The takeover gate
    // recovers any rows stranded in 'sending', the per-recipient Idempotency-Key prevents
    // re-emailing anyone already sent, and that invocation's (now service-role) self-reinvoke
    // chain drains it to completion. Service-role only — a user must never sweep across tenants.
    if (body.sweep === true) {
      if (!isServiceRole) {
        return new Response(JSON.stringify({ error: "Not authorized" }), {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const SWEEP_STALE_MS = 15 * 60 * 1000;
      // Bound the daily backstop's fan-out: under a mass-stranding event (e.g. a Resend
      // outage across many concurrent blasts) we must NOT fire an unbounded number of
      // concurrent campaign drives in one tick. Take the oldest-stuck N; the rest are
      // picked up on the next daily run (each kick is idempotent + self-healing).
      const SWEEP_MAX = 25;
      const cutoff = new Date(Date.now() - SWEEP_STALE_MS).toISOString();
      const { data: stuck } = await supabase
        .from("email_campaigns")
        .select("id")
        .eq("status", "sending")
        .lt("updated_at", cutoff)
        .order("updated_at", { ascending: true })
        .limit(SWEEP_MAX);
      // Probe recipient counts in parallel; keep only campaigns that still have queued work.
      const withQueued = (await Promise.all((stuck ?? []).map(async (c) => {
        const { count } = await supabase
          .from("email_campaign_recipients")
          .select("*", { count: "exact", head: true })
          .eq("campaign_id", c.id)
          .in("status", ["pending", "sending"]);
        return (count ?? 0) > 0 ? c.id : null;
      }))).filter((id): id is string => id !== null);
      const kicks = withQueued.map((id) =>
        fetch(`${SUPABASE_URL}/functions/v1/send-campaign-emails`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            apikey: SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          },
          body: JSON.stringify({ campaignId: id }),
        }).catch((e) => console.error("sweep kick failed for", id, e)),
      );
      const edgeRuntime = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
      if (edgeRuntime?.waitUntil) edgeRuntime.waitUntil(Promise.allSettled(kicks));
      else await Promise.allSettled(kicks);
      return new Response(JSON.stringify({ success: true, swept: withQueued.length, campaigns: withQueued }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // === TEST MODE ===
    if (testMode && testEmail && testSubject && testBodyHtml) {
      const ok = await verifyOwner(academyProfileId || null, trainerProfileId || null);
      if (!ok) {
        return new Response(JSON.stringify({ error: "Not authorized" }), {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const personalizeVars = (s: string, full: string) => {
        const first = (full || "there").trim().split(/\s+/)[0] || "there";
        return s
          .replace(/\{\{first_name\}\}/gi, first)
          .replace(/\{\{name\}\}/gi, full || "there");
      };
      const personalizedHtml = personalizeVars(testBodyHtml, "Test User");
      const personalizedSubject = personalizeVars(testSubject, "Test User");

      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${RESEND_API_KEY}`,
        },
        body: JSON.stringify({
          from: "PadelTrainer.ai <noreply@app.padeltrainer.ai>",
          to: [testEmail],
          subject: `[TEST] ${personalizedSubject}`,
          html: personalizedHtml,
        }),
      });

      if (!res.ok) {
        const errBody = await res.text();
        return new Response(JSON.stringify({ error: errBody }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      return new Response(
        JSON.stringify({ success: true, test: true }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // === NORMAL CAMPAIGN MODE ===
    if (!campaignId) {
      return new Response(JSON.stringify({ error: "campaignId required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fetch campaign
    const { data: campaign, error: campErr } = await supabase
      .from("email_campaigns")
      .select("*")
      .eq("id", campaignId)
      .single();

    if (campErr || !campaign) {
      return new Response(JSON.stringify({ error: "Campaign not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Verify user owns the campaign (academy manager or trainer owner)
    const ok = await verifyOwner(campaign.academy_profile_id || null, campaign.trainer_profile_id || null);
    if (!ok) {
      return new Response(JSON.stringify({ error: "Not authorized" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // RETRY FAILED: re-queue this campaign's failed recipients that still have attempt budget
    // back to 'pending' so the gate + claim + send below picks them up. Rows at the cap (e.g. a
    // hard bounce / invalid address) stay 'failed'. The per-recipient Idempotency-Key keeps a row
    // that actually delivered from being re-emailed — but only within Resend's ~24h dedupe window;
    // a row wrongly marked 'failed' (e.g. a network timeout AFTER Resend accepted it) that an owner
    // retries more than a day later could get a duplicate. Owner-gated by the verifyOwner above.
    const MAX_ATTEMPTS = 3;
    let retryRequeuedCount = 0;
    if (retryFailed && !isResume) {
      const { data: requeued, error: requeueErr } = await supabase
        .from("email_campaign_recipients")
        .update({ status: "pending" })
        .eq("campaign_id", campaignId)
        .eq("status", "failed")
        .lt("attempt_count", MAX_ATTEMPTS)
        .select("id");
      // Surface a real DB error (e.g. the migration hasn't been applied yet) instead of silently
      // reporting "nothing to retry".
      if (requeueErr) throw requeueErr;
      retryRequeuedCount = requeued?.length ?? 0;
      if (retryRequeuedCount === 0) {
        // Nothing retryable (no failures, or all at the attempt cap). Return a clean 200 so the
        // client shows "nothing to retry" rather than treating a 400/409 as an error.
        return new Response(
          JSON.stringify({ success: true, retried: 0, sent: 0, failed: 0, remaining: 0, complete: true }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
    }

    // Campaign-level gate: atomically flip to "sending" so a concurrent or
    // retried request bails out instead of re-sending. A campaign stuck in
    // "sending" is only taken over when stale — edge functions are hard-killed
    // well within 15 minutes, so by then the previous runner is dead.
    // Skipped for a self-reinvoke continuation (isResume), which is the same
    // trusted run picking up where its time budget cut it off.
    if (!isResume) {
      const SENDING_STALE_MS = 15 * 60 * 1000;
      const staleCutoff = new Date(Date.now() - SENDING_STALE_MS).toISOString();
      const { data: gateRows, error: gateErr } = await supabase
        .from("email_campaigns")
        .update({ status: "sending", updated_at: new Date().toISOString() })
        .eq("id", campaignId)
        .or(`status.neq.sending,updated_at.lt."${staleCutoff}"`)
        .select("id");

      if (gateErr) throw gateErr;
      if (!gateRows || gateRows.length === 0) {
        // A retry that lands while a live run owns the campaign already re-queued the failed rows
        // above; that live run (or the daily sweep) will send them. Report success, not an error.
        if (retryRequeuedCount > 0) {
          return new Response(
            JSON.stringify({ success: true, retried: retryRequeuedCount, queued: true, complete: false }),
            { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({ error: "Campaign is already being sent" }), {
          status: 409,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // A stale takeover can leave rows claimed by the dead runner in "sending";
      // release them so they are re-claimed below. Safe: the gate guarantees no
      // other live runner. Up to CONCURRENCY rows may have been mid-flight to Resend
      // when the old runner died — the per-recipient Idempotency-Key below makes any
      // such re-send a no-op at Resend, so nobody is double-emailed.
      await supabase
        .from("email_campaign_recipients")
        .update({ status: "pending" })
        .eq("campaign_id", campaignId)
        .eq("status", "sending");
    }

    // Atomic claim: only rows this UPDATE moves pending -> sending belong to
    // this run; a concurrent caller claims zero rows and cannot double-send.
    const { data: recipients, error: recErr } = await supabase
      .from("email_campaign_recipients")
      .update({ status: "sending" })
      .eq("campaign_id", campaignId)
      .eq("status", "pending")
      .select();

    if (recErr) {
      // Release the gate before surfacing the error.
      await supabase
        .from("email_campaigns")
        .update({ status: campaign.status })
        .eq("id", campaignId);
      throw recErr;
    }
    if (!recipients || recipients.length === 0) {
      // Release the gate. A stale "sending" with nothing left to claim means
      // the previous run already finished sending everything.
      await supabase
        .from("email_campaigns")
        .update({ status: campaign.status === "sending" ? "sent" : campaign.status })
        .eq("id", campaignId);
      return new Response(JSON.stringify({ error: "No recipients to send to" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let sentCount = 0;
    let failedCount = 0;
    let budgetHit = false;
    const processed = new Set<string>();

    // Edge functions are hard-killed at the wall-clock limit. The old code claimed
    // every recipient and sent serially (200ms each ≈ 5/s), so a campaign over a few
    // hundred recipients was killed mid-loop — stranding rows in "sending" and (worse)
    // never tripping the unconditional status:"sent" below. Now: send in small
    // concurrent chunks (429-aware), stop before the budget, return any unsent rows to
    // "pending" so a re-run resumes them, and mark the campaign "sent" ONLY when none
    // remain — so the operator is never told it finished while recipients are queued.
    const TIME_BUDGET_MS = 110_000;
    const CONCURRENCY = 4;
    const startedAt = Date.now();

    const sendOne = async (recipient: { id: string; recipient_name: string | null; recipient_email: string; attempt_count: number | null }) => {
      const fullName = recipient.recipient_name || "there";
      const firstName = fullName.trim().split(/\s+/)[0] || "there";
      // This invocation is one (cross-invocation) attempt; record it so a later "retry failed"
      // only re-queues rows still under the cap and a hard bounce can't be retried forever.
      const nextAttemptCount = (recipient.attempt_count ?? 0) + 1;
      const personalizedHtml = campaign.body_html
        .replace(/\{\{first_name\}\}/gi, firstName)
        .replace(/\{\{name\}\}/gi, fullName);
      const personalizedSubject = campaign.subject
        .replace(/\{\{first_name\}\}/gi, firstName)
        .replace(/\{\{name\}\}/gi, fullName);

      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${RESEND_API_KEY}`,
              // One recipient row = one intended email. Keying on its stable id makes a
              // re-send (stale takeover, or our own resume chain) a no-op at Resend within
              // its 24h dedupe window, so a crash mid-flight can never double-email anyone.
              "Idempotency-Key": `campaign-recipient-${recipient.id}`,
            },
            body: JSON.stringify({
              from: "PadelTrainer.ai <noreply@app.padeltrainer.ai>",
              to: [recipient.recipient_email],
              subject: personalizedSubject,
              html: personalizedHtml,
            }),
          });
          if (res.ok) {
            sentCount++;
            processed.add(recipient.id);
            const { error: wErr } = await supabase.from("email_campaign_recipients")
              .update({ status: "sent", sent_at: new Date().toISOString(), attempt_count: nextAttemptCount }).eq("id", recipient.id);
            // If this write fails (e.g. the attempt_count migration hasn't been applied yet) the
            // row stays 'sending' and would otherwise be invisible — log it instead of swallowing.
            if (wErr) console.error("recipient status write failed (sent)", recipient.id, wErr.message);
            return;
          }
          if (res.status === 429 && attempt < 2) { await new Promise((r) => setTimeout(r, 800 * (attempt + 1))); continue; }
          const errBody = await res.text();
          failedCount++;
          processed.add(recipient.id);
          const { error: wErr } = await supabase.from("email_campaign_recipients")
            .update({ status: "failed", error_message: errBody.slice(0, 500), attempt_count: nextAttemptCount }).eq("id", recipient.id);
          if (wErr) console.error("recipient status write failed (failed)", recipient.id, wErr.message);
          return;
        } catch (err) {
          if (attempt < 2) { await new Promise((r) => setTimeout(r, 800 * (attempt + 1))); continue; }
          failedCount++;
          processed.add(recipient.id);
          const { error: wErr } = await supabase.from("email_campaign_recipients")
            .update({ status: "failed", error_message: (err instanceof Error ? err.message : "Unknown error").slice(0, 500), attempt_count: nextAttemptCount }).eq("id", recipient.id);
          if (wErr) console.error("recipient status write failed (catch)", recipient.id, wErr.message);
          return;
        }
      }
    };

    for (let i = 0; i < recipients.length; i += CONCURRENCY) {
      if (Date.now() - startedAt > TIME_BUDGET_MS) { budgetHit = true; break; }
      await Promise.all(recipients.slice(i, i + CONCURRENCY).map(sendOne));
    }

    // Release any claimed-but-unsent rows back to "pending" so they are never stranded
    // in "sending" — a re-run (or the stale-takeover above) picks them up.
    if (budgetHit) {
      const unprocessed = recipients.filter((r) => !processed.has(r.id)).map((r) => r.id);
      for (let i = 0; i < unprocessed.length; i += 500) {
        await supabase.from("email_campaign_recipients").update({ status: "pending" }).in("id", unprocessed.slice(i, i + 500));
      }
    }

    // Recompute cumulative totals + whether ANY work remains (pending or sending).
    const countRecipients = async (status: string | string[]): Promise<number> => {
      let q = supabase.from("email_campaign_recipients").select("*", { count: "exact", head: true }).eq("campaign_id", campaignId);
      q = Array.isArray(status) ? q.in("status", status) : q.eq("status", status);
      const { count } = await q;
      return count ?? 0;
    };
    const [sentTotal, failedTotal, remaining] = await Promise.all([
      countRecipients("sent"),
      countRecipients("failed"),
      countRecipients(["pending", "sending"]),
    ]);

    // Only call the campaign "sent" when nothing is left; otherwise keep it "sending".
    // Refresh updated_at so the stale-takeover clock tracks real activity, not the
    // start of the very first invocation.
    await supabase.from("email_campaigns").update({
      status: remaining === 0 ? "sent" : "sending",
      sent_count: sentTotal,
      failed_count: failedTotal,
      updated_at: new Date().toISOString(),
      // Stamp sent_at only on the FIRST completion — a later "retry failed" run must not
      // overwrite the campaign's original send date in the history list.
      ...(remaining === 0 ? { sent_at: campaign.sent_at ?? new Date().toISOString() } : {}),
    }).eq("id", campaignId);

    // RESUMPTION: if the time budget cut us off with recipients still queued, nothing
    // else re-invokes this function — so we chain another invocation of ourselves to drain
    // the tail. We authenticate the continuation with the SERVICE-ROLE key (not the caller's
    // user JWT), so the chain has no token-expiry bound and self-drains a campaign of any size
    // fully autonomously. isResume skips the concurrency gate (trusted continuation); waitUntil
    // keeps the fetch alive after we respond. The chain terminates because every pass turns ≥1
    // full chunk of recipients into sent/failed, monotonically shrinking `remaining`. Idempotency
    // keys make it double-send-safe. (The daily sweep is only a backstop for a first invocation
    // that died before it could schedule even one continuation.)
    let continued = false;
    if (budgetHit && remaining > 0) {
      const resume = fetch(`${SUPABASE_URL}/functions/v1/send-campaign-emails`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
        body: JSON.stringify({ campaignId, isResume: true }),
      }).then((r) => { if (!r.ok) console.error("campaign self-reinvoke returned", r.status); })
        .catch((e) => console.error("campaign self-reinvoke failed:", e));
      const edgeRuntime = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
      if (edgeRuntime?.waitUntil) {
        edgeRuntime.waitUntil(resume);
      } else {
        await resume;
      }
      continued = true;
    }

    return new Response(
      JSON.stringify({ success: true, sent: sentCount, failed: failedCount, remaining, complete: remaining === 0, continued }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Campaign send error:", error);
    // A crash in the campaign sender (DB error, Resend outage, requeue failure)
    // was previously visible only in the function logs — alert ops so a stalled
    // campaign send is noticed. notifySlackEdgeError never throws.
    await notifySlackEdgeError(
      "send-campaign-emails",
      error instanceof Error ? error.message : String(error),
    );
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
