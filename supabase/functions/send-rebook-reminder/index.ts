// Academy manager sends an ad-hoc reminder email to SELECTED players of one rebook
// cycle (e.g. "please confirm your spot"). Constrained: a plain-text subject + body
// the academy types; we escape it and wrap it in the branded shell with a CTA to the
// player's claim link. Never free HTML.
//
// Security: the caller must MANAGE the cycle (verified via RLS on availability_slots
// under their JWT), and we only email players who actually hold a claim in THIS cycle
// (targets are re-validated against the cycle's claims — no arbitrary recipients).
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Resend } from "https://esm.sh/resend@2.0.0";
import { buildClaimUrl, resolveAppBase, resolveRecipient } from "../_shared/priority-claim-invite.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const APP_BASE = resolveAppBase(Deno.env.get("PUBLIC_APP_URL"));
const BRAND = "#f45d25";
const MAX_RECIPIENTS = 200;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...corsHeaders } });

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const resendKey = Deno.env.get("RESEND_API_KEY");
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ ok: false, error: "Authentication required" }, 401);
    if (!resendKey) return json({ ok: false, reason: "email_not_configured" }, 200);

    const supabase = createClient(supabaseUrl, serviceKey);
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !user) return json({ ok: false, error: "Unauthorized" }, 401);

    const { cycleId, targets, subject, message } = await req.json();
    const subj = typeof subject === "string" ? subject.trim().slice(0, 120) : "";
    const msg = typeof message === "string" ? message.trim().slice(0, 1000) : "";
    const targetList: Array<{ player_id: string | null; guest_player_id: string | null }> =
      Array.isArray(targets) ? targets : [];
    if (!cycleId || !subj || !msg || targetList.length === 0) {
      return json({ ok: false, error: "cycleId, subject, message and targets are required" }, 400);
    }
    const targetKeys = new Set(
      targetList.map((t) => t.player_id ?? (t.guest_player_id ? `g:${t.guest_player_id}` : "")).filter(Boolean),
    );

    // Authorize: the caller must MANAGE this cycle's academy. Do NOT infer ownership from
    // availability_slots — those are publicly readable (is_public=true), so an RLS-empty
    // check there would let any logged-in user email another academy's players. Verify the
    // academy_managers link explicitly (same gate as bulk-rebook-cycle).
    const { data: cycle } = await supabase
      .from("cycles").select("name, owner_id, owner_type").eq("id", cycleId).maybeSingle();
    if (!cycle || cycle.owner_type !== "academy" || !cycle.owner_id) return json({ ok: false, error: "Forbidden" }, 403);
    const { data: mgr } = await supabase
      .from("academy_managers").select("user_id")
      .eq("academy_profile_id", cycle.owner_id).eq("user_id", user.id).maybeSingle();
    if (!mgr) return json({ ok: false, error: "Forbidden" }, 403);

    const { data: slotRows } = await supabase.from("availability_slots").select("id").eq("cyclus_id", cycleId);
    const slotIds = (slotRows ?? []).map((s: { id: string }) => s.id);
    if (slotIds.length === 0) return json({ ok: true, sent: 0, skipped: 0, failed: 0 });

    const { data: acad } = await supabase.from("academy_profiles").select("name").eq("id", cycle.owner_id).maybeSingle();
    const academyName = acad?.name ?? "";

    // Resolve recipients from THIS cycle's claims, scoped to the requested targets, one per
    // player. Exclude declined/expired claims — a reminder must never re-ping someone who
    // already opted out (only pending and claimed players get one).
    const { data: claims } = await supabase
      .from("slot_priority_claims")
      .select("claim_token, player_id, guest_player_id, profiles:player_id(full_name, email), guest_players:guest_player_id(full_name, email)")
      .in("slot_id", slotIds)
      .in("status", ["pending", "claimed"]);
    type ClaimRow = {
      claim_token: string;
      player_id: string | null;
      guest_player_id: string | null;
      profiles: { full_name: string | null; email: string | null } | null;
      guest_players: { full_name: string | null; email: string | null } | null;
    };
    const byPlayer = new Map<string, ClaimRow>();
    for (const c of (claims ?? []) as ClaimRow[]) {
      const key = c.player_id ?? (c.guest_player_id ? `g:${c.guest_player_id}` : "");
      if (!key || !targetKeys.has(key) || byPlayer.has(key)) continue;
      byPlayer.set(key, c);
    }

    const recipients = [...byPlayer.values()].slice(0, MAX_RECIPIENTS);
    const resend = new Resend(resendKey);
    let sent = 0, skipped = 0, failed = 0;

    for (const c of recipients) {
      const email = resolveRecipient({
        isTest: false, callerEmail: null,
        playerEmail: c.profiles?.email, guestEmail: c.guest_players?.email,
      });
      if (!email) { skipped++; continue; }
      const name = c.profiles?.full_name || c.guest_players?.full_name || "";
      const cta = buildClaimUrl(APP_BASE, c.claim_token, false);
      const body = msg.split("\n").map((line) => `<p style="color:#374151;line-height:1.6;">${escapeHtml(line)}</p>`).join("");
      const html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          ${cycle?.name ? `<h2 style="color:${BRAND};">${escapeHtml(cycle.name)}</h2>` : ""}
          <p>Hi ${escapeHtml(name)},</p>
          ${body}
          <div style="text-align:center;margin:28px 0;">
            <a href="${cta}" style="display:inline-block;background:${BRAND};color:#fff;padding:14px 24px;border-radius:8px;text-decoration:none;font-weight:600;">Bekijk je uitnodiging</a>
          </div>
          <p style="color:#6b7280;font-size:13px;">Of open deze link: <a href="${cta}" style="color:${BRAND};">${cta}</a></p>
          <p style="color:#9ca3af;font-size:12px;">${escapeHtml(academyName)}</p>
        </div>`;
      const { error: sendErr } = await resend.emails.send({
        from: "PadelTrainer.ai <noreply@app.padeltrainer.ai>",
        to: [email],
        subject: subj,
        html,
      });
      if (sendErr) { console.error("send error", sendErr); failed++; continue; }
      sent++;
    }

    return json({ ok: true, sent, skipped, failed });
  } catch (e) {
    return json({ ok: false, error: "internal_error", message: String((e as Error)?.message ?? e) }, 500);
  }
});
