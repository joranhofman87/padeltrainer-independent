import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";

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

    // Verify user auth
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Verify JWT
    const token = authHeader.replace("Bearer ", "");
    const userClient = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY") || "");
    const { data: { user }, error: authError } = await userClient.auth.getUser(token);
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Invalid token" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const { campaignId, testMode, testEmail, subject: testSubject, bodyHtml: testBodyHtml, academyProfileId, trainerProfileId } = body;

    // Helper: verify caller owns the campaign owner (academy or trainer)
    async function verifyOwner(academyId: string | null, trainerId: string | null): Promise<boolean> {
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

    // Campaign-level gate: atomically flip to "sending" so a concurrent or
    // retried request bails out instead of re-sending. A campaign stuck in
    // "sending" is only taken over when stale — edge functions are hard-killed
    // well within 15 minutes, so by then the previous runner is dead.
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
      return new Response(JSON.stringify({ error: "Campaign is already being sent" }), {
        status: 409,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // A stale takeover can leave rows claimed by the dead runner in "sending";
    // release them so they are re-claimed below. Safe: the gate guarantees no
    // other live runner. (The single row in flight when the old runner died may
    // be re-sent — accepted over stranding it forever.)
    await supabase
      .from("email_campaign_recipients")
      .update({ status: "pending" })
      .eq("campaign_id", campaignId)
      .eq("status", "sending");

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

    const sendOne = async (recipient: { id: string; recipient_name: string | null; recipient_email: string }) => {
      const fullName = recipient.recipient_name || "there";
      const firstName = fullName.trim().split(/\s+/)[0] || "there";
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
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND_API_KEY}` },
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
            await supabase.from("email_campaign_recipients")
              .update({ status: "sent", sent_at: new Date().toISOString() }).eq("id", recipient.id);
            return;
          }
          if (res.status === 429 && attempt < 2) { await new Promise((r) => setTimeout(r, 800 * (attempt + 1))); continue; }
          const errBody = await res.text();
          failedCount++;
          processed.add(recipient.id);
          await supabase.from("email_campaign_recipients")
            .update({ status: "failed", error_message: errBody.slice(0, 500) }).eq("id", recipient.id);
          return;
        } catch (err) {
          if (attempt < 2) { await new Promise((r) => setTimeout(r, 800 * (attempt + 1))); continue; }
          failedCount++;
          processed.add(recipient.id);
          await supabase.from("email_campaign_recipients")
            .update({ status: "failed", error_message: (err instanceof Error ? err.message : "Unknown error").slice(0, 500) }).eq("id", recipient.id);
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
    await supabase.from("email_campaigns").update({
      status: remaining === 0 ? "sent" : "sending",
      sent_count: sentTotal,
      failed_count: failedTotal,
      ...(remaining === 0 ? { sent_at: new Date().toISOString() } : {}),
    }).eq("id", campaignId);

    return new Response(
      JSON.stringify({ success: true, sent: sentCount, failed: failedCount, remaining, complete: remaining === 0 }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Campaign send error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
