// Cron-invoked (service-role) AUTOMATED rebook reminder. Emails invitees who have NOT
// yet responded (claim still 'pending', did not decline) and whose PRIORITY window
// closes within the lead time — once each (reminded_at is the shared marker with the
// manual send-rebook-reminder path, so a manually-reminded player is never re-pinged).
// Detection + eligibility live in rebook_claims_needing_auto_reminder(); this fn only
// sends + stamps. Idempotent: reminded_at gate in the RPC + a post-send stamp.
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Resend } from "https://esm.sh/resend@2.0.0";
import { buildClaimUrl, resolveAppBase } from "../_shared/priority-claim-invite.ts";
import { notifySlackEdgeError } from "../_shared/edge-slack.ts";
import { hourInTimeZone, isWithinSendWindow, SEND_TIME_ZONE } from "../_shared/send-window.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const APP_BASE = resolveAppBase(Deno.env.get("PUBLIC_APP_URL"));
const FROM = "PadelTrainer.ai <noreply@app.padeltrainer.ai>";
const BRAND = "#f45d25";
const MAX_RECIPIENTS_PER_RUN = 500;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function reminderHtml(name: string, cycleName: string, academyName: string, cta: string): string {
  const safeName = escapeHtml(name || "");
  const safeCycle = escapeHtml(cycleName || "");
  return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      ${safeCycle ? `<h2 style="color:${BRAND};">${safeCycle}</h2>` : ""}
      <p>Hi ${safeName},</p>
      <p style="color:#374151;line-height:1.6;">Je hebt je plek${safeCycle ? ` in <strong>${safeCycle}</strong>` : ""} nog niet bevestigd. Je hebt hier als eerste recht op, maar je voorrang eindigt binnenkort — bevestig snel om je plek te behouden.</p>
      <div style="text-align:center;margin:28px 0;">
        <a href="${cta}" style="display:inline-block;background:${BRAND};color:#fff;padding:14px 24px;border-radius:8px;text-decoration:none;font-weight:600;">Bevestig je plek</a>
      </div>
      <p style="color:#6b7280;font-size:13px;">Of open deze link: <a href="${cta}" style="color:${BRAND};">${cta}</a></p>
      <p style="color:#9ca3af;font-size:12px;">${escapeHtml(academyName || "")}</p>
    </div>`;
}

async function sendWithRetry(
  resend: Resend,
  payload: { from: string; to: string[]; subject: string; html: string },
  maxAttempts = 4,
): Promise<{ error: unknown | null }> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const { error } = await resend.emails.send(payload);
    if (!error) return { error: null };
    lastError = error;
    const e = error as { statusCode?: number; name?: string };
    const isRateLimit = e?.statusCode === 429 || e?.name === "rate_limit_exceeded" ||
      (e?.statusCode == null && /\b429\b|rate.?limit/i.test(JSON.stringify(error ?? {})));
    if (!isRateLimit) return { error };
    if (attempt < maxAttempts - 1) await sleep(800 * (attempt + 1));
  }
  return { error: lastError };
}

interface ReminderRow {
  cycle_id: string;
  cycle_name: string | null;
  academy_name: string | null;
  player_id: string | null;
  guest_player_id: string | null;
  recipient_name: string | null;
  recipient_email: string;
  claim_token: string;
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const resendApiKey = Deno.env.get("RESEND_API_KEY");
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...corsHeaders } });

  // Service-role only (cron/internal — no user path).
  const token = (req.headers.get("Authorization") || "").replace("Bearer ", "");
  if (token !== serviceKey) return json({ error: "unauthorized" }, 401);
  if (!resendApiKey) return json({ error: "email_not_configured" }, 500);

  // Quiet hours: reminders only go out during the day (Amsterdam local time), never at
  // night — the cron may still tick outside daytime, so this is where we actually clamp.
  // `?force=1` bypasses it (service-role only) for a manual "send now" test.
  const force = new URL(req.url).searchParams.get("force") === "1";
  const now = new Date();
  if (!force && !isWithinSendWindow(now)) {
    return json({ ok: true, skipped: "outside_send_window", hour: hourInTimeZone(now, SEND_TIME_ZONE) });
  }

  const supabase = createClient(supabaseUrl, serviceKey);
  const resend = new Resend(resendApiKey);

  try {
    const { data, error } = await supabase.rpc("rebook_claims_needing_auto_reminder", { _lead_hours: 24 });
    if (error) throw error;
    const rows = ((data ?? []) as ReminderRow[]).slice(0, MAX_RECIPIENTS_PER_RUN);

    // Group by cycle so we stamp reminded_at once per cycle (mirrors send-rebook-reminder).
    const byCycle = new Map<string, { name: string; academy: string; recipients: ReminderRow[] }>();
    for (const r of rows) {
      let g = byCycle.get(r.cycle_id);
      if (!g) { g = { name: r.cycle_name ?? "", academy: r.academy_name ?? "", recipients: [] }; byCycle.set(r.cycle_id, g); }
      g.recipients.push(r);
    }

    let totalSent = 0;
    let totalFailed = 0;
    let cyclesProcessed = 0;

    for (const [cycleId, grp] of byCycle) {
      cyclesProcessed += 1;
      // The cycle's slots — bump_rebook_reminders stamps every claim of the emailed
      // players across these slots (their whole commitment), one email covering all.
      const { data: slotRows } = await supabase.from("availability_slots").select("id").eq("cyclus_id", cycleId);
      const slotIds = (slotRows ?? []).map((s: { id: string }) => s.id);

      const sentPlayerIds: string[] = [];
      const sentGuestIds: string[] = [];
      for (const rec of grp.recipients) {
        const cta = buildClaimUrl(APP_BASE, rec.claim_token, false);
        const subject = grp.name ? `Herinnering: bevestig je plek in ${grp.name}` : "Herinnering: bevestig je plek";
        const { error: sendErr } = await sendWithRetry(resend, {
          from: FROM,
          to: [rec.recipient_email],
          subject,
          html: reminderHtml(rec.recipient_name ?? "", grp.name, grp.academy, cta),
        });
        if (sendErr) { totalFailed += 1; continue; }
        totalSent += 1;
        if (rec.player_id) sentPlayerIds.push(rec.player_id);
        else if (rec.guest_player_id) sentGuestIds.push(rec.guest_player_id);
      }

      // Stamp reminded_at + bump reminder_count on the ones we actually emailed. Best-effort:
      // the emails already went out, so a stamp failure must not fail the run (a missed stamp
      // means they could be re-reminded next tick — annoying, not harmful).
      if (sentPlayerIds.length > 0 || sentGuestIds.length > 0) {
        const { error: stampErr } = await supabase.rpc("bump_rebook_reminders", {
          p_slot_ids: slotIds,
          p_player_ids: sentPlayerIds,
          p_guest_ids: sentGuestIds,
        });
        if (stampErr) {
          await notifySlackEdgeError("auto-rebook-reminder", "reminded_at stamp failed (players may be re-reminded)", {
            cycleId, sentPlayers: sentPlayerIds.length, sentGuests: sentGuestIds.length, error: String(stampErr?.message ?? stampErr),
          });
        }
      }
    }

    if (totalFailed > 0) {
      await notifySlackEdgeError("auto-rebook-reminder", `${totalFailed} auto-reminder email(s) failed`, { totalSent, totalFailed, cyclesProcessed });
    }

    return json({ ok: true, cyclesProcessed, sent: totalSent, failed: totalFailed });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await notifySlackEdgeError("auto-rebook-reminder", message);
    return json({ error: "internal_error", message }, 500);
  }
});
